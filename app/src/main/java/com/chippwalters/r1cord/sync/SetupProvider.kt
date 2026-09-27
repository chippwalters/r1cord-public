package com.chippwalters.r1cord.sync

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Log
import com.chippwalters.r1cord.BuildConfig
import com.chippwalters.r1cord.R1cordApplication
import com.chippwalters.r1cord.device.MaintenanceGate
import com.chippwalters.r1cord.model.CaptureStatus
import java.io.FileNotFoundException
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URI
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlin.concurrent.thread
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject

/**
 * USB setup surface for R1CORD Desktop, reached only through `adb shell content …`
 * (authority `com.chippwalters.r1cord.setup`, guarded by DUMP in the manifest). Every entry point
 * additionally requires the root or shell UID. Results are Bundles with `ok` and a single-line
 * `json`. The pairing token arrives on a pipe via `content write`, is held in memory for five
 * minutes, used once, and is never returned or logged.
 */
class SetupProvider : ContentProvider() {
    override fun onCreate(): Boolean = true

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
        enforceCaller()
        val context = requireNotNull(context).applicationContext
        val result = try {
            when (method) {
                "STATUS" -> status(context)
                "BEGIN_MAINTENANCE" -> beginMaintenance(arg)
                "END_MAINTENANCE" -> {
                    MaintenanceGate.endMaintenance()
                    SetupResult(true, json())
                }
                "PROVISION" -> provision(context, arg, extras)
                "PROBE" -> probe(arg, extras)
                "NONCE" -> nonce(context, arg)
                else -> failure("unknown_method", "Unknown setup method.")
            }
        } catch (error: Exception) {
            failure("internal", error.javaClass.simpleName)
        }
        Log.i(TAG, "$method ${if (result.ok) "ok" else "refused"}")
        return Bundle().apply {
            putBoolean("ok", result.ok)
            putString("json", result.json)
        }
    }

    /** `content write --uri content://com.chippwalters.r1cord.setup/token/<nonce>`: the token on stdin. */
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        enforceCaller()
        val segments = uri.pathSegments
        if (segments.size != 2 || segments[0] != "token" || !isSetupNonce(segments[1])) {
            throw FileNotFoundException("Unsupported setup path.")
        }
        if (!mode.startsWith("w") || 'r' in mode) throw FileNotFoundException("Setup tokens are write-only.")
        val nonce = segments[1]
        val (readSide, writeSide) = ParcelFileDescriptor.createReliablePipe()
        thread(name = "r1cord-token-stage", isDaemon = true) { receiveToken(nonce, readSide) }
        // Binder closes this process's copy after sending it, so the reader sees EOF when the caller closes.
        return writeSide
    }

    override fun getType(uri: Uri): String? {
        enforceCaller()
        return null
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? {
        enforceCaller()
        throw UnsupportedOperationException("Setup provider has no rows.")
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? {
        enforceCaller()
        throw UnsupportedOperationException("Setup provider has no rows.")
    }

    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int {
        enforceCaller()
        throw UnsupportedOperationException("Setup provider has no rows.")
    }

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int {
        enforceCaller()
        throw UnsupportedOperationException("Setup provider has no rows.")
    }

    private fun enforceCaller() {
        val uid = Binder.getCallingUid()
        if (!isSetupCaller(uid)) throw SecurityException("R1CORD setup is available to adb shell only.")
    }

    private fun receiveToken(nonce: String, readSide: ParcelFileDescriptor) {
        val buffer = ByteArray(MAX_TOKEN_BYTES + 1)
        var length = 0
        try {
            ParcelFileDescriptor.AutoCloseInputStream(readSide).use { input ->
                while (length < buffer.size) {
                    val n = input.read(buffer, length, buffer.size - length)
                    if (n < 0) break
                    length += n
                }
                // A writer that died or closed with an error leaves a truncated token: reject it.
                readSide.checkError()
            }
            val token = if (length <= MAX_TOKEN_BYTES) parseStagedToken(buffer.copyOf(length)) else null
            val staged = token != null && stagedTokens.stage(nonce, token)
            Log.i(TAG, "token ${if (staged) "staged" else "rejected"}")
        } catch (error: IOException) {
            Log.w(TAG, "token rejected: ${error.javaClass.simpleName}")
        } finally {
            buffer.fill(0)
        }
    }

    private fun status(context: Context): SetupResult {
        val gate = MaintenanceGate.snapshot()
        fun active(work: MaintenanceGate.Work) = (gate.active[work] ?: 0) > 0
        val gateCapture = active(MaintenanceGate.Work.CAPTURE)
        val recorderCapture = runCatching {
            (context as R1cordApplication).recorder.state.value.status != CaptureStatus.IDLE
        }.getOrNull()
        val capture: Any = when {
            gateCapture || recorderCapture == true -> true
            recorderCapture == null -> UNKNOWN
            else -> false
        }
        val busy: Any = when {
            gate.busy || capture == true -> true
            capture == UNKNOWN -> UNKNOWN
            else -> false
        }
        val paired: Any = runCatching { OffloadSettings.isPaired(context) }.getOrDefault(UNKNOWN)
        val serverUrlSet: Any = runCatching { OffloadSettings.serverUrl(context).isNotBlank() }.getOrDefault(UNKNOWN)
        val vpn = runCatching { if (netCaps(context).any { it.vpnTransport && it.internet }) "up" else "down" }
            .getOrDefault(UNKNOWN)
        return SetupResult(
            true,
            json(
                "versionName" to BuildConfig.VERSION_NAME,
                "versionCode" to BuildConfig.VERSION_CODE,
                "paired" to paired,
                "serverUrlSet" to serverUrlSet,
                "busy" to busy,
                "capture" to capture,
                "upload" to active(MaintenanceGate.Work.UPLOAD),
                "libraryWrite" to active(MaintenanceGate.Work.LIBRARY_WRITE),
                "maintenance" to gate.maintenance,
                "vpn" to vpn,
                "helper" to helperState(context),
            ),
        )
    }

    private fun beginMaintenance(arg: String?): SetupResult {
        val reason = arg?.filter { it >= ' ' }?.trim()?.take(80)?.ifEmpty { null } ?: "Desktop maintenance"
        if (MaintenanceGate.beginMaintenance(reason)) return SetupResult(true, json())
        return SetupResult(false, json("error" to "busy", "reason" to (MaintenanceGate.busyReason() ?: "Busy.")))
    }

    private fun provision(context: Context, arg: String?, extras: Bundle?): SetupResult {
        val nonce = arg?.takeIf(::isSetupNonce) ?: return failure("bad_nonce", "Nonce must be 32 lowercase hex characters.")
        val url = validateServerUrl(extras?.getString("serverUrl"))
            ?: return failure("bad_url", "Server URL must be https://host with no credentials, path, query or fragment.")
        val name = cleanServerName(extras?.getString("serverName"))
        MaintenanceGate.busyReason()?.let { return failure("busy", it) }
        val token = stagedTokens.consume(nonce) ?: return failure("no_token", "No staged token for this nonce, or it expired.")
        return try {
            OffloadSettings.provision(context, url, name, token)
            SetupResult(true, json("paired" to true))
        } catch (error: Exception) {
            failure("write_failed", error.message ?: "Could not save the pairing.")
        }
    }

    private fun probe(arg: String?, extras: Bundle?): SetupResult {
        val address = parseProbeHost(arg) ?: return failure("bad_host", "Host must be a Tailscale address (100.64.0.0/10 or fd7a:115c:a1e0::/48).")
        val ports = parseProbePorts(extras?.getString("ports")) ?: return failure("bad_ports", "Give one or two ports between 1 and 65535.")
        val results = JSONObject()
        probePorts(address, ports).forEach { (port, outcome) -> results.put(port.toString(), outcome) }
        return SetupResult(true, JSONObject().put("v", 1).put("results", results).toString())
    }

    private fun nonce(context: Context, arg: String?): SetupResult {
        val nonce = arg?.takeIf(::isSetupNonce) ?: return failure("bad_nonce", "Nonce must be 32 lowercase hex characters.")
        val client = (context as? R1cordApplication)?.offloadClient ?: return failure("not_ready", "App is still starting.")
        return try {
            val (status, route) = runBlocking { withTimeout(NONCE_TIMEOUT_MS) { client.setupNonceOnRoute(nonce) } }
            SetupResult(true, json("status" to status, "route" to route.name.lowercase()))
        } catch (error: TimeoutCancellationException) {
            failure("timeout", "The desktop did not answer within 15 seconds.")
        } catch (error: OffloadException) {
            failure(error.code ?: "unreachable", error.message ?: "Desktop server is not reachable.")
        }
    }

    private fun helperState(context: Context): String = try {
        val info = context.packageManager.getPackageInfo(
            HELPER_PACKAGE,
            PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong()),
        )
        helperStatus(info.signingInfo?.apkContentsSigners?.map { it.toByteArray() }.orEmpty())
    } catch (e: PackageManager.NameNotFoundException) {
        helperStatus(null)
    } catch (e: Exception) {
        UNKNOWN
    }

    private fun failure(error: String, message: String) = SetupResult(false, json("error" to error, "message" to message))

    private fun json(vararg fields: Pair<String, Any>): String {
        val json = JSONObject().put("v", 1)
        fields.forEach { (key, value) -> json.put(key, value) }
        return json.toString()
    }

    companion object {
        private const val TAG = "R1CORD/Setup"
        private const val UNKNOWN = "unknown"
        private const val NONCE_TIMEOUT_MS = 15_000L
        private val stagedTokens = StagedTokens(clock = { SystemClock.elapsedRealtime() })
    }
}

internal data class SetupResult(val ok: Boolean, val json: String)

internal const val HELPER_PACKAGE = "com.chippwalters.r1cord.controls"
internal const val HELPER_CERT_SHA256 = "c8a2e9bccf597c2fb6dc66bee293fc13f2fc47ec77bc6b2b0d52c11f51192ab8"
internal const val MAX_TOKEN_BYTES = 256
private const val ROOT_UID = 0
private const val SHELL_UID = 2000
private val NONCE = Regex("^[0-9a-f]{32}$")
private val TOKEN = Regex("^[0-9a-f]{64}$")

internal fun isSetupCaller(uid: Int): Boolean = uid == ROOT_UID || uid == SHELL_UID

internal fun isSetupNonce(value: String): Boolean = NONCE.matches(value)

/** The staged token: at most [MAX_TOKEN_BYTES] of UTF-8, 64 lowercase hex once surrounding whitespace is trimmed. */
internal fun parseStagedToken(bytes: ByteArray): String? {
    if (bytes.size > MAX_TOKEN_BYTES) return null
    return bytes.toString(Charsets.UTF_8).trim().takeIf { TOKEN.matches(it) }
}

/**
 * Normalized `https://host[:port]` when [url] is https with a host and nothing else (no
 * credentials, query, fragment, or path other than `/`); null otherwise.
 */
internal fun validateServerUrl(url: String?): String? {
    val text = url?.trim()?.takeIf { it.isNotEmpty() && it.none { c -> c.isWhitespace() || c.isISOControl() } } ?: return null
    val uri = runCatching { URI(text) }.getOrNull() ?: return null
    if (!uri.scheme.equals("https", ignoreCase = true) || uri.isOpaque) return null
    val host = uri.host?.takeIf { it.isNotEmpty() } ?: return null
    if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) return null
    if (uri.rawPath.orEmpty() !in setOf("", "/")) return null
    if (uri.port != -1 && uri.port !in 1..65535) return null
    // `https://host:` parses with no port but leaves the colon in the authority.
    if (uri.rawAuthority != host && uri.rawAuthority != "$host:${uri.port}") return null
    return "https://${host.lowercase()}" + if (uri.port != -1) ":${uri.port}" else ""
}

internal fun cleanServerName(name: String?): String =
    name.orEmpty().filter { !it.isISOControl() }.trim().take(100)

/**
 * A literal Tailscale address: IPv4 in 100.64.0.0/10 or IPv6 in fd7a:115c:a1e0::/48. Never
 * resolves names, so a hostname can't make the probe reach anything else.
 */
internal fun parseProbeHost(host: String?): InetAddress? {
    val text = host?.trim()?.removeSurrounding("[", "]") ?: return null
    parseIpv4(text)?.let { bytes ->
        val first = bytes[0].toInt() and 0xff
        val second = bytes[1].toInt() and 0xff
        return if (first == 100 && second in 64..127) InetAddress.getByAddress(bytes) else null
    }
    val v6 = parseIpv6(text) ?: return null
    return if (v6.copyOf(6).contentEquals(TAILSCALE_V6_PREFIX)) InetAddress.getByAddress(v6) else null
}

private val TAILSCALE_V6_PREFIX = byteArrayOf(0xfd.toByte(), 0x7a, 0x11, 0x5c, 0xa1.toByte(), 0xe0.toByte())

private fun parseIpv4(text: String): ByteArray? {
    val parts = text.split('.')
    if (parts.size != 4) return null
    val bytes = ByteArray(4)
    parts.forEachIndexed { index, part ->
        if (part.isEmpty() || part.length > 3 || part.any { !it.isDigit() }) return null
        if (part.length > 1 && part[0] == '0') return null
        val value = part.toInt()
        if (value > 255) return null
        bytes[index] = value.toByte()
    }
    return bytes
}

private fun parseIpv6(text: String): ByteArray? {
    if (text.isEmpty() || text.any { it != ':' && Character.digit(it, 16) < 0 }) return null
    val halves = text.split("::")
    if (halves.size > 2) return null
    fun groups(part: String): List<Int>? {
        if (part.isEmpty()) return emptyList()
        return part.split(':').map { group ->
            if (group.isEmpty() || group.length > 4) return null
            group.toInt(16)
        }
    }
    val head = groups(halves[0]) ?: return null
    val tail = if (halves.size == 2) groups(halves[1]) ?: return null else emptyList()
    val words = if (halves.size == 2) {
        if (head.size + tail.size > 7) return null
        head + List(8 - head.size - tail.size) { 0 } + tail
    } else {
        if (head.size != 8) return null
        head
    }
    val bytes = ByteArray(16)
    words.forEachIndexed { index, word ->
        bytes[index * 2] = (word shr 8).toByte()
        bytes[index * 2 + 1] = word.toByte()
    }
    return bytes
}

/** One or two distinct ports, comma separated, each 1..65535; null when anything else. */
internal fun parseProbePorts(spec: String?): List<Int>? {
    val parts = spec?.split(',')?.map { it.trim() } ?: return null
    if (parts.isEmpty() || parts.size > 2) return null
    val ports = parts.map { part ->
        if (part.isEmpty() || part.length > 5 || part.any { !it.isDigit() }) return null
        part.toInt().takeIf { it in 1..65535 } ?: return null
    }
    return ports.distinct()
}

/**
 * TCP-connects to each port in parallel within [totalMs] overall: "open" when accepted,
 * "closed" when refused or unroutable, "timeout" when nothing answered in time.
 */
internal fun probePorts(address: InetAddress, ports: List<Int>, totalMs: Long = 3_000L): Map<Int, String> {
    if (ports.isEmpty()) return emptyMap()
    val pool = Executors.newFixedThreadPool(ports.size) { runnable ->
        Thread(runnable, "r1cord-setup-probe").apply { isDaemon = true }
    }
    try {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(totalMs)
        val attempts = ports.associateWith { port ->
            pool.submit<String> {
                Socket().use { socket ->
                    try {
                        socket.connect(InetSocketAddress(address, port), totalMs.toInt())
                        "open"
                    } catch (e: SocketTimeoutException) {
                        "timeout"
                    } catch (e: IOException) {
                        "closed"
                    }
                }
            }
        }
        return attempts.mapValues { (_, attempt) ->
            try {
                attempt.get((deadline - System.nanoTime()).coerceAtLeast(0L), TimeUnit.NANOSECONDS)
            } catch (e: TimeoutException) {
                attempt.cancel(true)
                "timeout"
            } catch (e: Exception) {
                "closed"
            }
        }
    } finally {
        pool.shutdownNow()
    }
}

/** "ready" for exactly one signer matching the helper pin, "untrusted" for any other signer set, "absent" when [signers] is null (not installed). */
internal fun helperStatus(signers: List<ByteArray>?): String {
    if (signers == null) return "absent"
    val digest = signers.singleOrNull()?.let { cert ->
        MessageDigest.getInstance("SHA-256").digest(cert).joinToString("") { "%02x".format(it) }
    }
    return if (digest == HELPER_CERT_SHA256) "ready" else "untrusted"
}

/** Tokens staged by `content write`, keyed by nonce: in memory only, five-minute expiry, one use. */
internal class StagedTokens(
    private val clock: () -> Long,
    private val ttlMs: Long = 5 * 60_000L,
    private val capacity: Int = 8,
) {
    private data class Entry(val token: String, val stagedAt: Long)
    private val byNonce = LinkedHashMap<String, Entry>()

    /** Stages [token] for [nonce]; false when either is malformed. Restaging a nonce replaces it. */
    @Synchronized
    fun stage(nonce: String, token: String): Boolean {
        if (!isSetupNonce(nonce) || !TOKEN.matches(token)) return false
        purge()
        byNonce.remove(nonce)
        while (byNonce.size >= capacity) byNonce.remove(byNonce.keys.first())
        byNonce[nonce] = Entry(token, clock())
        return true
    }

    /** The token for [nonce] if staged within the last five minutes; removes it either way. */
    @Synchronized
    fun consume(nonce: String): String? {
        purge()
        return byNonce.remove(nonce)?.token
    }

    private fun purge() {
        val now = clock()
        byNonce.entries.removeAll { now - it.value.stagedAt >= ttlMs }
    }
}
