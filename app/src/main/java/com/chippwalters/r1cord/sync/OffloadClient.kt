package com.chippwalters.r1cord.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
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
) : Exception(message)

data class PairResult(val token: String, val serverName: String)

data class FileEntry(val name: String, val size: Long, val sha256: String)

data class JobRequest(
    val schemaVersion: Int = 1,
    val recordingId: String,
    val createdAt: Long,
    val title: String,
    val summarize: Boolean,
    val publish: Boolean,
    val summaryStyle: String,
    val files: List<FileEntry>,
)

data class JobCreated(
    val jobId: String,
    val recordingId: String? = null,
    val status: String? = null,
    val webdavUrl: String? = null,
    val resumed: Boolean = false,
)

data class RecordingStatus(
    val recordingId: String,
    val jobId: String?,
    val status: String,
    val webdavUrl: String?,
    val updatedAt: String?,
)

class OffloadClient(context: Context) {
    private val context = context.applicationContext
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .retryOnConnectionFailure(false)
        .build()

    /**
     * True when the next request would go over the USB cable (`adb reverse` loopback) because
     * no validated internet network is up. The desktop server sets the reverse up for adopted
     * devices while they are plugged in; the R1 never touches the radio.
     */
    fun usingUsb(): Boolean = !hasValidatedNetwork()

    suspend fun pair(code: String): PairResult = withContext(Dispatchers.IO) {
        val body = JSONObject().put("code", code.trim()).toString()
        val response = execute(request("POST", listOf("v1", "pair"), jsonBody(body), authenticated = false))
        response.use { result ->
            val text = result.body?.string().orEmpty()
            if (result.code == 200) {
                val json = parseObject(text)
                val token = json.optString("token").takeIf { it.isNotBlank() }
                    ?: throw OffloadException("Pairing response was missing a token.")
                PairResult(token, json.optString("serverName"))
            } else {
                throw errorOf(result.code, text, "Pairing failed.")
            }
        }
    }

    suspend fun createJob(job: JobRequest, metadataJson: String): JobCreated = withContext(Dispatchers.IO) {
        val payload = JSONObject()
            .put("job", jobJson(job))
            .put("metadata", JSONObject(metadataJson))
            .toString()
        val response = execute(request("POST", listOf("v1", "jobs"), jsonBody(payload)))
        response.use { result ->
            val text = result.body?.string().orEmpty()
            when (result.code) {
                200, 202 -> parseJobCreated(text, resumed = false)
                409 -> {
                    val error = errorOf(result.code, text, "Job conflict.")
                    if (error.code == "job_active" && !error.jobId.isNullOrBlank()) {
                        JobCreated(jobId = error.jobId, resumed = true)
                    } else {
                        throw error
                    }
                }
                else -> throw errorOf(result.code, text, "Could not create the upload job.")
            }
        }
    }

    // GET with a JSON body, not HEAD on the file path: Cloudflare rewrites HEAD to GET for
    // paths ending in cacheable extensions such as .jpg (observed 2026-09-21).
    suspend fun received(jobId: String, name: String): Long = withContext(Dispatchers.IO) {
        val response = execute(request("GET", listOf("v1", "jobs", jobId, "files", name, "received")))
        response.use { result ->
            val text = result.body?.string().orEmpty()
            when (result.code) {
                200 -> parseObject(text).optLong("received", 0L).coerceAtLeast(0)
                else -> throw errorOf(result.code, text, "Could not check uploaded bytes for $name.")
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
        val response = execute(
            request(
                "PUT",
                listOf("v1", "jobs", jobId, "files", name),
                body,
                query = listOf("offset" to offset.toString()),
            )
        )
        response.use { result ->
            val text = result.body?.string().orEmpty()
            when (result.code) {
                200 -> parseObject(text).optLong("received", offset + length)
                else -> throw errorOf(result.code, text, "Upload of $name failed.")
            }
        }
    }

    suspend fun commit(jobId: String): JobCreated = withContext(Dispatchers.IO) {
        val response = execute(request("POST", listOf("v1", "jobs", jobId, "commit"), EMPTY))
        response.use { result ->
            val text = result.body?.string().orEmpty()
            if (result.code == 200) parseJobCreated(text, resumed = false)
            else throw errorOf(result.code, text, "Commit failed.")
        }
    }

    suspend fun recordings(): List<RecordingStatus> = withContext(Dispatchers.IO) {
        val response = execute(request("GET", listOf("v1", "recordings")))
        response.use { result ->
            val text = result.body?.string().orEmpty()
            if (result.code != 200) throw errorOf(result.code, text, "Could not refresh send status.")
            val array = JSONArray(text)
            List(array.length()) { index ->
                val item = array.getJSONObject(index)
                RecordingStatus(
                    recordingId = item.getString("recordingId"),
                    jobId = item.optString("jobId").takeIf { it.isNotBlank() && it != "null" },
                    status = item.optString("status"),
                    webdavUrl = item.optString("webdavUrl").takeIf { it.isNotBlank() && it != "null" },
                    updatedAt = item.optString("updatedAt").takeIf { it.isNotBlank() && it != "null" },
                )
            }
        }
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
            .put("summarize", job.summarize)
            .put("publish", job.publish)
            .put("summaryStyle", job.summaryStyle)
            .put("files", files)
    }

    private fun parseJobCreated(text: String, resumed: Boolean): JobCreated {
        val json = parseObject(text)
        val jobId = json.optString("jobId").takeIf { it.isNotBlank() }
            ?: throw OffloadException("Server did not return a job id.")
        return JobCreated(
            jobId = jobId,
            recordingId = json.optString("recordingId").takeIf { it.isNotBlank() },
            status = json.optString("status").takeIf { it.isNotBlank() },
            webdavUrl = json.optString("webdavUrl").takeIf { it.isNotBlank() && it != "null" },
            resumed = resumed,
        )
    }

    private fun request(
        method: String,
        segments: List<String>,
        body: RequestBody? = null,
        authenticated: Boolean = true,
        query: List<Pair<String, String>> = emptyList(),
    ): Request {
        val url = endpoint(segments, query)
        val builder = Request.Builder().url(url)
        when (method) {
            "GET" -> builder.get()
            "HEAD" -> builder.head()
            "POST" -> builder.post(body ?: EMPTY)
            "PUT" -> builder.put(requireNotNull(body) { "PUT requires a body." })
            else -> error("Unsupported method $method")
        }
        if (authenticated) {
            val token = OffloadSettings.token(context)
                ?: throw OffloadException(UNPAIRED)
            builder.header("Authorization", "Bearer $token")
        }
        return builder.build()
    }

    private fun endpoint(segments: List<String>, query: List<Pair<String, String>>): HttpUrl {
        val base = if (hasValidatedNetwork()) {
            val configured = OffloadSettings.serverUrl(context).trim().trimEnd('/')
            if (configured.isEmpty()) throw OffloadException("Set the server URL in Settings.")
            configured
        } else {
            USB_URL
        }
        val builder = base.toHttpUrlOrNull()?.newBuilder()
            ?: throw OffloadException("Server URL is not valid. Check it in Settings.")
        segments.forEach { builder.addPathSegment(it) }
        query.forEach { (name, value) -> builder.addQueryParameter(name, value) }
        return builder.build()
    }

    private fun hasValidatedNetwork(): Boolean {
        val manager = context.getSystemService(ConnectivityManager::class.java)
        val caps = manager.activeNetwork?.let { manager.getNetworkCapabilities(it) } ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    private suspend fun execute(request: Request): Response = suspendCancellableCoroutine { cont ->
        val call = http.newCall(request)
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (!cont.isActive) return
                val failure = when {
                    call.isCanceled() -> OffloadException("Upload cancelled.")
                    call.request().url.host == USB_HOST -> OffloadException(NO_ROUTE)
                    else -> e
                }
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
        val message = json?.optString("message")?.takeIf { it.isNotBlank() } ?: machine ?: fallback
        val jobId = json?.optString("jobId")?.takeIf { it.isNotBlank() }
        val received = if (json?.has("received") == true && !json.isNull("received")) json.optLong("received") else null
        return OffloadException(message, code = machine, jobId = jobId, received = received)
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
        /** Device-side port the desktop server reverse-forwards (`adb reverse tcp:8765 tcp:<listen_port>`). */
        private const val USB_HOST = "127.0.0.1"
        private const val USB_URL = "http://$USB_HOST:8765"
        private const val UNPAIRED = "Not paired or token revoked. Pair again in Settings."
        const val NO_ROUTE = "No internet. Turn Wi-Fi on, or plug into the desktop with USB mode on."
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
