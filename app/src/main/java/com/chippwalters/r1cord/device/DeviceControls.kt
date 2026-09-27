package com.chippwalters.r1cord.device

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.IBinder
import android.util.Log
import com.chippwalters.r1cord.controls.IDeviceControls
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Client for the platform-signed R1CORD controls helper (power off, Wi-Fi radio). The helper is
 * only bound after its signer matches the pinned platform certificate, and every Binder call runs
 * off the main thread with a timeout. Nothing here reports success the helper did not return.
 */
class DeviceControls(context: Context) {
    enum class Status { ABSENT, UNTRUSTED, CONNECTING, READY, DENIED }
    enum class Result { ACCEPTED, REFUSED, DENIED, ERROR, UNAVAILABLE }
    internal enum class Trust { ABSENT, UNTRUSTED, TRUSTED }
    internal enum class Bind { NONE, BIND, REBIND }

    private val context = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val _status = MutableStateFlow(Status.ABSENT)
    val status: StateFlow<Status> = _status.asStateFlow()

    @Volatile private var service: IDeviceControls? = null
    private var bound = false
    /** Bound but unusable with nothing in flight (handshake unanswered, helper disconnected); [connect] rebinds. */
    @Volatile private var stalled = false

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            // Re-check: the helper could have been replaced between the pre-bind check and now.
            val trust = helperTrust()
            if (trust != Trust.TRUSTED) {
                unbind()
                _status.value = if (trust == Trust.ABSENT) Status.ABSENT else Status.UNTRUSTED
                return
            }
            val svc = IDeviceControls.Stub.asInterface(binder)
            service = svc
            stalled = false
            _status.value = Status.CONNECTING
            scope.launch { handshake(svc) }
        }

        override fun onServiceDisconnected(name: ComponentName) {
            // Android rebinds when the helper process restarts; if it never does, connect() rebinds.
            service = null
            stalled = true
            _status.value = Status.CONNECTING
        }

        override fun onBindingDied(name: ComponentName) {
            // The helper was updated or killed for good; this binding is dead, so start a fresh one
            // (connect() re-checks the pinned signer first).
            unbind()
            connect()
        }

        override fun onNullBinding(name: ComponentName) {
            unbind()
            _status.value = Status.ABSENT
        }
    }

    /**
     * Main thread. Idempotent while READY or a bind is in flight; re-evaluates a missing/untrusted
     * helper (it may have been installed since) and rebinds a DENIED or stalled one.
     */
    fun connect() {
        when (bindAction(bound, _status.value, stalled)) {
            Bind.NONE -> return
            Bind.REBIND -> unbind()
            Bind.BIND -> Unit
        }
        when (helperTrust()) {
            Trust.ABSENT -> { _status.value = Status.ABSENT; return }
            Trust.UNTRUSTED -> { _status.value = Status.UNTRUSTED; return }
            Trust.TRUSTED -> Unit
        }
        stalled = false
        _status.value = Status.CONNECTING
        val intent = Intent(ACTION_BIND).setPackage(HELPER_PACKAGE)
        bound = try {
            context.bindService(intent, connection, Context.BIND_AUTO_CREATE)
        } catch (e: SecurityException) {
            Log.w(TAG, "bind refused", e)
            false
        }
        if (!bound) {
            runCatching { context.unbindService(connection) }
            _status.value = Status.ABSENT
        }
    }

    /** Main thread. Unbinds and stops pending calls; the instance is not reusable afterwards. */
    fun close() {
        unbind()
        _status.value = Status.ABSENT
        scope.cancel()
    }

    /** WifiManager.WIFI_STATE_* read by the helper, or null when the helper cannot answer. */
    suspend fun wifiState(): Int? {
        val svc = readyService() ?: return null
        return call(svc) { it.wifiState }?.takeIf { it >= 0 }
    }

    suspend fun setWifi(enabled: Boolean): Result {
        val svc = readyService() ?: return Result.UNAVAILABLE
        return result(call(svc) { it.setWifiEnabled(enabled) })
    }

    suspend fun shutdown(): Result {
        val svc = readyService() ?: return Result.UNAVAILABLE
        return result(call(svc) { it.requestShutdown() })
    }

    private fun result(code: Int?): Result {
        val result = resultForCode(code)
        if (result == Result.DENIED) _status.value = Status.DENIED
        return result
    }

    /** Asks [svc] for its API version. No answer (timeout, dead binder) stays CONNECTING and retryable. */
    private suspend fun handshake(svc: IDeviceControls) {
        val version = call(svc) { it.apiVersion() }
        if (service !== svc) return
        val next = statusForApiVersion(version)
        if (version == null) Log.w(TAG, "helper handshake unanswered; will retry")
        stalled = next == Status.CONNECTING
        _status.value = next
    }

    /** Waits briefly while a bind is in flight; null unless the helper is READY. */
    private suspend fun readyService(): IDeviceControls? {
        val svc = service
        // An unanswered handshake is retried here too: the activity may stay resumed for days.
        if (svc != null && stalled && _status.value == Status.CONNECTING) {
            handshake(svc)
            return if (_status.value == Status.READY) service else null
        }
        val settled = withTimeoutOrNull(CONNECT_WAIT_MS) { status.first { it != Status.CONNECTING } }
        return if (settled == Status.READY) service else null
    }

    /** Binder call on the IO pool; a hung helper costs [CALL_TIMEOUT_MS], never the main thread. */
    private suspend fun <T> call(svc: IDeviceControls, block: (IDeviceControls) -> T): T? {
        val pending = scope.async { block(svc) }
        return try {
            withTimeoutOrNull(CALL_TIMEOUT_MS) { pending.await() }.also { if (it == null) pending.cancel() }
        } catch (e: CancellationException) {
            pending.cancel()
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "helper call failed", e)
            null
        }
    }

    private fun unbind() {
        service = null
        stalled = false
        if (bound) {
            bound = false
            runCatching { context.unbindService(connection) }
        }
    }

    private fun helperTrust(): Trust = try {
        val info = context.packageManager.getPackageInfo(HELPER_PACKAGE,
            PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong()))
        trustOf(info.signingInfo?.apkContentsSigners?.map { certSha256Hex(it.toByteArray()) })
    } catch (e: PackageManager.NameNotFoundException) {
        Trust.ABSENT
    } catch (e: Exception) {
        Log.w(TAG, "helper signer unreadable", e)
        Trust.UNTRUSTED
    }

    companion object {
        const val HELPER_PACKAGE = "com.chippwalters.r1cord.controls"
        const val ACTION_BIND = "com.chippwalters.r1cord.controls.BIND"
        /** DER SHA-256 of the AOSP android13 platform certificate the helper must be signed with. */
        const val HELPER_CERT_SHA256 = "c8a2e9bccf597c2fb6dc66bee293fc13f2fc47ec77bc6b2b0d52c11f51192ab8"
        const val API_VERSION = 1
        private const val TAG = "R1CORD/DeviceControls"
        private const val CALL_TIMEOUT_MS = 4_000L
        private const val CONNECT_WAIT_MS = 3_000L

        /** Lowercase, zero-padded hex SHA-256 of a DER certificate. */
        fun certSha256Hex(der: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(der).joinToString("") { "%02x".format(it) }

        /** IDeviceControls result code → [Result]; null means the call timed out or failed. */
        fun resultForCode(code: Int?): Result = when (code) {
            0 -> Result.ACCEPTED
            1 -> Result.REFUSED
            2 -> Result.DENIED
            else -> Result.ERROR
        }

        /**
         * Handshake answer → [Status]. null (timeout, RemoteException, dead binder) is transient and
         * stays CONNECTING; the helper's caller-rejected code (2) or any other version is DENIED.
         */
        internal fun statusForApiVersion(version: Int?): Status = when (version) {
            null -> Status.CONNECTING
            API_VERSION -> Status.READY
            else -> Status.DENIED
        }

        /**
         * What [connect] does: bind when unbound; rebind a bound helper that DENIED us or is stalled
         * (unanswered handshake, disconnected); leave a READY or in-flight bind alone.
         */
        internal fun bindAction(bound: Boolean, status: Status, stalled: Boolean): Bind = when {
            !bound -> Bind.BIND
            status == Status.READY -> Bind.NONE
            stalled || status == Status.DENIED -> Bind.REBIND
            else -> Bind.NONE
        }

        /** Exactly one current signer, equal to [pin]. null digests = no signing info readable. */
        internal fun trustOf(signerDigests: List<String>?, pin: String = HELPER_CERT_SHA256): Trust = when {
            signerDigests == null -> Trust.UNTRUSTED
            signerDigests.size == 1 && signerDigests[0].equals(pin, ignoreCase = true) -> Trust.TRUSTED
            else -> Trust.UNTRUSTED
        }
    }
}
