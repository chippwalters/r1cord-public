package com.chippwalters.r1cord.sync

import android.content.Context
import android.util.Log
import com.chippwalters.r1cord.model.PublishedPage
import com.chippwalters.r1cord.model.resolvePages
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Dns
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okio.BufferedSink
import org.json.JSONArray
import org.json.JSONObject

class OffloadException(
    message: String,
    val code: String? = null,
    val jobId: String? = null,
    val received: Long? = null,
    val files: List<String>? = null,
) : Exception(message)
data class PairResult(val token: String, val serverName: String)

data class FileEntry(val name: String, val size: Long, val sha256: String)

data class JobRequest(
    val schemaVersion: Int = 1,
    val recordingId: String,
    val createdAt: Long,
    val title: String,
    /** AI reviews to write, in canonical order; empty = transcript only. */
    val reviews: List<String>,
    val publish: Boolean,
    val files: List<FileEntry>,
)

data class JobCreated(
    val jobId: String,
    val recordingId: String? = null,
    val status: String? = null,
    val webdavUrl: String? = null,
    val pages: List<PublishedPage> = emptyList(),
    val resumed: Boolean = false,
)

data class RecordingStatus(
    val recordingId: String,
    val jobId: String?,
    val status: String,
    val webdavUrl: String?,
    val pages: List<PublishedPage>,
    val updatedAt: String?,
)

class OffloadClient internal constructor(
    private val serverUrl: () -> String,
    private val token: () -> String?,
    private val routes: RouteSource,
    private val usbUrl: String = USB_URL,
    /** Host lookup for requests; tests map a `*.ts.net` name to a loopback server. */
    dns: Dns = Dns.SYSTEM,
) {
    constructor(context: Context) : this(
        serverUrl = { OffloadSettings.serverUrl(context.applicationContext) },
        token = { OffloadSettings.token(context.applicationContext) },
        routes = deviceRoutes(context.applicationContext),
    )

    private val http = OkHttpClient.Builder()
        .dns(dns)
        .connectTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .retryOnConnectionFailure(false)
        .build()

    /** Route and configured server a job was created on; its later requests never switch servers. */
    private data class Pinned(val route: Route, val configured: String)
    private val pinned = ConcurrentHashMap<String, Pinned>()

    /**
     * True when the next new request would go over the USB cable (`adb reverse` loopback): no
     * configured URL, the configured server's path (Tailscale VPN for `*.ts.net`, internet
     * otherwise) is down, or a `*.ts.net` server refuses a connection, while the reverse answers.
     * May probe the loopback (~300 ms) and a tailnet server (~1.5 s); call off the main thread.
     */
    fun usingUsb(): Boolean = routes.choose(configuredUrl()) == RouteDecision.Use(Route.USB)

    suspend fun pair(code: String): PairResult = withContext(Dispatchers.IO) {
        val body = JSONObject().put("code", code.trim()).toString()
        val req = request("POST", listOf("v1", "pair"), jsonBody(body), authenticated = false)
        val response = execute(req)
        response.use { result ->
            val text = result.body?.string().orEmpty()
            if (result.code == 200) {
                val json = parseObject(text)
                val token = json.optString("token").takeIf { it.isNotBlank() }
                    ?: throw OffloadException("Pairing response was missing a token.")
                PairResult(token, json.optString("serverName"))
            } else {
                throw errorOf(result.code, text, "Pairing failed.").logged(req, result.code)
            }
        }
    }

    suspend fun createJob(job: JobRequest, metadataJson: String): JobCreated = withContext(Dispatchers.IO) {
        val payload = JSONObject()
            .put("job", jobJson(job))
            .put("metadata", JSONObject(metadataJson))
            .toString()
        // A new attempt always re-decides the route; the job is then pinned to it.
        val target = resolve(jobId = null)
        val req = request("POST", listOf("v1", "jobs"), jsonBody(payload), target = target)
        val response = execute(req)
        val created = response.use { result ->
            val text = result.body?.string().orEmpty()
            when (result.code) {
                200, 202 -> parseJobCreated(text, resumed = false)
                409 -> {
                    val error = errorOf(result.code, text, "Job conflict.")
                    if (error.code == "job_active" && !error.jobId.isNullOrBlank()) {
                        Log.i(TAG, "POST ${req.url.encodedPath} job_active; resuming job ${error.jobId}")
                        JobCreated(jobId = error.jobId, resumed = true)
                    } else {
                        throw error.logged(req, result.code)
                    }
                }
                else -> throw errorOf(result.code, text, "Could not create the upload job.").logged(req, result.code)
            }
        }
        pin(created.jobId, target)
        created
    }

    // GET with a JSON body, not HEAD on the file path: Cloudflare rewrites HEAD to GET for
    // paths ending in cacheable extensions such as .jpg (observed 2026-09-21).
    suspend fun received(jobId: String, name: String): Long = withContext(Dispatchers.IO) {
        val req = request("GET", listOf("v1", "jobs", jobId, "files", name, "received"), jobId = jobId)
        val response = execute(req)
        response.use { result ->
            val text = result.body?.string().orEmpty()
            when (result.code) {
                200 -> parseObject(text).optLong("received", 0L).coerceAtLeast(0)
                else -> throw errorOf(result.code, text, "Could not check uploaded bytes for $name.").logged(req, result.code)
            }
        }
    }

    suspend fun putChunk(
        jobId: String,
        name: String,
        offset: Long,
        source: () -> InputStream,
        length: Long,
    ): Long = withContext(Dispatchers.IO) {
        check(length in 1..MAX_CHUNK) { "Upload chunk must be between 1 byte and 64 MiB." }
        val body = object : RequestBody() {
            override fun contentType() = OCTET
            override fun contentLength() = length
            override fun isOneShot() = true
            override fun writeTo(sink: BufferedSink) {
                source().use { input ->
                    val buffer = ByteArray(64 * 1024)
                    var left = length
                    while (left > 0) {
                        val n = input.read(buffer, 0, minOf(buffer.size.toLong(), left).toInt())
                        if (n < 0) throw IOException("File ended after ${length - left} of $length bytes.")
                        sink.write(buffer, 0, n)
                        left -= n
                    }
                }
            }
        }
        val req = request(
            "PUT",
            listOf("v1", "jobs", jobId, "files", name),
            body,
            query = listOf("offset" to offset.toString()),
            jobId = jobId,
        )
        val response = execute(req)
        response.use { result ->
            val text = result.body?.string().orEmpty()
            when (result.code) {
                200 -> parseObject(text).optLong("received", offset + length)
                else -> throw errorOf(result.code, text, "Upload of $name failed.").logged(req, result.code)
            }
        }
    }

    suspend fun commit(jobId: String): JobCreated = withContext(Dispatchers.IO) {
        val req = request("POST", listOf("v1", "jobs", jobId, "commit"), EMPTY, jobId = jobId)
        val response = execute(req)
        response.use { result ->
            val text = result.body?.string().orEmpty()
            if (result.code == 200) parseJobCreated(text, resumed = false).also { pinned.remove(jobId) }
            else throw errorOf(result.code, text, "Commit failed.").logged(req, result.code)
        }
    }

    suspend fun recordings(): List<RecordingStatus> = withContext(Dispatchers.IO) {
        val req = request("GET", listOf("v1", "recordings"))
        val response = execute(req)
        response.use { result ->
            val text = result.body?.string().orEmpty()
            if (result.code != 200) throw errorOf(result.code, text, "Could not refresh send status.").logged(req, result.code)
            val array = JSONArray(text)
            List(array.length()) { index ->
                val item = array.getJSONObject(index)
                val webdavUrl = item.optUrl("webdavUrl")
                RecordingStatus(
                    recordingId = item.getString("recordingId"),
                    jobId = item.optString("jobId").takeIf { it.isNotBlank() && it != "null" },
                    status = item.optString("status"),
                    webdavUrl = webdavUrl,
                    pages = resolvePages(parsePages(item), webdavUrl),
                    updatedAt = item.optString("updatedAt").takeIf { it.isNotBlank() && it != "null" },
                )
            }
        }
    }

    /**
     * Proves to the desktop which tailnet peer this R1 is: `GET /v1/setup/nonce/<nonce>` with the
     * bearer token over the currently chosen route. Returns the HTTP status (204 = recognised).
     */
    suspend fun setupNonce(nonce: String): Int = setupNonceOnRoute(nonce).first

    /** [setupNonce] plus the route it travelled, so the setup provider can report it. */
    internal suspend fun setupNonceOnRoute(nonce: String): Pair<Int, Route> = withContext(Dispatchers.IO) {
        val target = resolve(jobId = null)
        val req = request("GET", listOf("v1", "setup", "nonce", nonce), target = target)
        execute(req).use { result -> result.code to target.route }
    }

    private fun jobJson(job: JobRequest): JSONObject {
        val files = JSONArray()
        job.files.forEach { file ->
            files.put(JSONObject().put("name", file.name).put("size", file.size).put("sha256", file.sha256))
        }
        return JSONObject()
            .put("schemaVersion", job.schemaVersion)
            .put("recordingId", job.recordingId)
            .put("createdAt", job.createdAt)
            .put("title", job.title)
            .put("reviews", JSONArray(job.reviews))
            // Servers before AI reviews ignore `reviews`; `summarize` keeps them summarizing.
            .put("summarize", job.reviews.isNotEmpty())
            .put("publish", job.publish)
            .put("files", files)
    }

    private fun parseJobCreated(text: String, resumed: Boolean): JobCreated {
        val json = parseObject(text)
        val jobId = json.optString("jobId").takeIf { it.isNotBlank() }
            ?: throw OffloadException("Server did not return a job id.")
        val webdavUrl = json.optUrl("webdavUrl")
        return JobCreated(
            jobId = jobId,
            recordingId = json.optString("recordingId").takeIf { it.isNotBlank() },
            status = json.optString("status").takeIf { it.isNotBlank() },
            webdavUrl = webdavUrl,
            pages = resolvePages(parsePages(json), webdavUrl),
            resumed = resumed,
        )
    }

    private fun JSONObject.optUrl(name: String): String? = optString(name).takeIf { it.isNotBlank() && it != "null" }

    /** The `pages` array of a job or recording; null when the server sends none (before AI reviews). */
    private fun parsePages(json: JSONObject): List<PublishedPage>? {
        val array = json.optJSONArray("pages") ?: return null
        return List(array.length()) { array.optJSONObject(it) }.mapNotNull { page ->
            val kind = page?.optString("kind").orEmpty()
            val url = page?.optUrl("url") ?: return@mapNotNull null
            PublishedPage(kind, url)
        }
    }

    private fun request(
        method: String,
        segments: List<String>,
        body: RequestBody? = null,
        authenticated: Boolean = true,
        query: List<Pair<String, String>> = emptyList(),
        jobId: String? = null,
        target: Pinned = resolve(jobId),
    ): Request {
        val url = endpoint(target, segments, query)
        val builder = Request.Builder().url(url)
        when (method) {
            "GET" -> builder.get()
            "HEAD" -> builder.head()
            "POST" -> builder.post(body ?: EMPTY)
            "PUT" -> builder.put(requireNotNull(body) { "PUT requires a body." })
            else -> error("Unsupported method $method")
        }
        if (authenticated) {
            val bearer = token()
                ?: throw OffloadException(UNPAIRED)
            builder.header("Authorization", "Bearer $bearer")
        }
        return builder.build()
    }

    private fun configuredUrl(): String = serverUrl().trim().trimEnd('/')

    /**
     * The route for a request. Requests of a job created on a route stay on that route and
     * server; when it has gone away they fail instead of silently switching servers mid-upload.
     */
    private fun resolve(jobId: String?): Pinned {
        val configured = configuredUrl()
        val pin = jobId?.let { pinned[it] }
        if (pin != null) {
            if (pin.configured != configured) {
                throw OffloadException("Server settings changed during this upload. Send again.", code = ROUTE_CHANGED)
            }
            if (!routes.isAvailable(pin.route, configured)) {
                val message = when (pin.route) {
                    Route.USB -> "The USB connection to the desktop was lost during this upload. Plug back in and Send again to resume."
                    Route.CONFIGURED -> "The network connection to the desktop was lost during this upload. Send again to resume."
                }
                throw OffloadException(message, code = ROUTE_CHANGED)
            }
            return pin
        }
        return when (val decision = routes.choose(configured)) {
            is RouteDecision.Use -> Pinned(decision.route, configured)
            is RouteDecision.Unavailable -> throw OffloadException(decision.message)
        }
    }

    private fun pin(jobId: String, target: Pinned) {
        if (pinned.size >= MAX_PINNED) pinned.clear()
        pinned[jobId] = target
    }

    private fun endpoint(target: Pinned, segments: List<String>, query: List<Pair<String, String>>): HttpUrl {
        val base = when (target.route) {
            Route.USB -> usbUrl
            Route.CONFIGURED -> target.configured.ifEmpty { throw OffloadException("Set the server URL in Settings.") }
        }
        val builder = base.toHttpUrlOrNull()?.newBuilder()
            ?: throw OffloadException("Server URL is not valid. Check it in Settings.")
        segments.forEach { builder.addPathSegment(it) }
        query.forEach { (name, value) -> builder.addQueryParameter(name, value) }
        return builder.build()
    }

    /** True when [url] points at the `adb reverse` loopback base, not the configured server. */
    private fun isUsbBase(url: HttpUrl): Boolean {
        val base = usbUrl.toHttpUrlOrNull() ?: return false
        return url.host == base.host && url.port == base.port
    }

    private suspend fun execute(request: Request): Response = suspendCancellableCoroutine { cont ->
        val call = http.newCall(request)
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (!cont.isActive) return
                val url = call.request().url
                val failure = when {
                    call.isCanceled() -> OffloadException("Upload cancelled.")
                    isUsbBase(url) -> OffloadException(NO_ROUTE)
                    else -> OffloadException(
                        "Desktop server is not reachable at ${url.host}. Check that R1CORD Desktop is running, " +
                            "and that Tailscale is on for this R1 and the PC.",
                        code = SERVER_UNREACHABLE,
                    )
                }
                Log.w(TAG, "${call.request().method} ${url.encodedPath} failed: ${e.javaClass.simpleName} ${failure.code ?: "no_code"}")
                cont.resumeWithException(failure)
            }
            override fun onResponse(call: Call, response: Response) {
                if (cont.isActive) cont.resume(response) { _, _, _ -> response.close() }
                else response.close()
            }
        })
    }

    private fun errorOf(code: Int, body: String, fallback: String): OffloadException {
        if (code == 401) return OffloadException(UNPAIRED, code = "unauthorized")
        val json = runCatching { JSONObject(body) }.getOrNull()
        val machine = json?.optString("error")?.takeIf { it.isNotBlank() }
        // A 5xx/52x/530 whose body is not the server's JSON error shape is an intermediary
        // answering (e.g. Cloudflare's text/plain "error code: 1033"), not the server itself.
        if (code >= 500 && machine == null) {
            return OffloadException(
                "Desktop server is not reachable (HTTP $code). Check that the server and its tunnel are running.",
                code = SERVER_UNREACHABLE,
            )
        }
        val message = json?.optString("message")?.takeIf { it.isNotBlank() } ?: machine ?: fallback
        val jobId = json?.optString("jobId")?.takeIf { it.isNotBlank() }
        val received = if (json?.has("received") == true && !json.isNull("received")) json.optLong("received") else null
        val files = json?.optJSONArray("files")?.let { array ->
            List(array.length()) { index -> array.optString(index) }.filter { FILE_NAME.matches(it) }
        }
        return OffloadException(message, code = machine, jobId = jobId, received = received, files = files)
    }

    /** One debug log line per failed request: method, path, status, machine code — never the token. */
    private fun OffloadException.logged(request: Request, status: Int): OffloadException {
        Log.w(TAG, "${request.method} ${request.url.encodedPath} failed: HTTP $status ${code ?: "no_code"}")
        return this
    }

    private fun parseObject(text: String): JSONObject =
        runCatching { JSONObject(text) }.getOrElse { throw OffloadException("Server returned invalid JSON.") }

    private fun jsonBody(json: String): RequestBody = json.toByteArray(Charsets.UTF_8).let { bytes ->
        object : RequestBody() {
            override fun contentType() = JSON
            override fun contentLength() = bytes.size.toLong()
            override fun writeTo(sink: BufferedSink) { sink.write(bytes) }
        }
    }

    companion object {
        const val MAX_CHUNK = 64L * 1024 * 1024
        const val SERVER_UNREACHABLE = "server_unreachable"
        /** A job's pinned route or server went away mid-upload; a new Send re-decides the route. */
        const val ROUTE_CHANGED = "route_changed"
        private const val USB_URL = "http://$USB_HOST:$USB_PORT"
        private const val MAX_PINNED = 64
        private const val UNPAIRED = "Not paired or token revoked. Pair again in Settings."
        const val NO_ROUTE = "No internet. Turn Wi-Fi on, or plug into the desktop with USB mode on."
        private const val TAG = "R1CORD/Sync"
        private val FILE_NAME = Regex("^[A-Za-z0-9._-]+$")
        private val JSON = "application/json; charset=utf-8".toMediaType()
        private val OCTET = "application/octet-stream".toMediaType()
        private val EMPTY: RequestBody = object : RequestBody() {
            override fun contentType() = null
            override fun contentLength() = 0L
            override fun writeTo(sink: BufferedSink) {}
        }
    }
}

/** Maps a server job status (or an already-mapped device badge) onto the five device badges. */
fun deviceBadge(serverStatus: String?): String = when (serverStatus?.lowercase()) {
    null, "", "local" -> "local"
    "uploading", "sending" -> "sending"
    "queued", "transcribing", "transcribed", "writing", "written", "publishing", "processing" -> "processing"
    "published", "complete", "done" -> "done"
    "error" -> "error"
    else -> "processing"
}
