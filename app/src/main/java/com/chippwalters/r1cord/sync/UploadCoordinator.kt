package com.chippwalters.r1cord.sync

import android.content.Context
import android.net.Uri
import com.chippwalters.r1cord.storage.OffloadBundle
import com.chippwalters.r1cord.storage.RecordingLibrary
import java.io.InputStream
import java.security.MessageDigest
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlin.coroutines.coroutineContext

data class UploadProgress(
    val recordingId: String,
    val fileIndex: Int,
    val fileCount: Int,
    val bytesSent: Long,
    val bytesTotal: Long,
    val phase: String,
)

data class SendResult(val recordingId: String, val webdavUrl: String?)

/** The recording-store operations the upload flow needs, so tests can substitute a fake. */
internal interface LibraryOps {
    suspend fun exportBundle(id: String): OffloadBundle
    suspend fun updateJob(id: String, jobId: String?, status: String, url: String?, sentAt: Long?)
    suspend fun updateJobStatus(id: String, status: String, url: String?)
}

private class RecordingLibraryOps(private val library: RecordingLibrary) : LibraryOps {
    override suspend fun exportBundle(id: String): OffloadBundle = library.exportBundle(id)
    override suspend fun updateJob(id: String, jobId: String?, status: String, url: String?, sentAt: Long?) =
        library.updateJob(id, jobId, status, url, sentAt)
    override suspend fun updateJobStatus(id: String, status: String, url: String?) =
        library.updateJobStatus(id, status, url)
}

class UploadCoordinator internal constructor(
    private val library: LibraryOps,
    private val client: OffloadClient,
    private val maxChunk: Long = OffloadClient.MAX_CHUNK,
    private val openStream: (Uri) -> InputStream?,
) {
    constructor(context: Context, library: RecordingLibrary, client: OffloadClient) : this(
        library = RecordingLibraryOps(library),
        client = client,
        openStream = { uri -> context.applicationContext.contentResolver.openInputStream(uri) },
    )

    init {
        require(maxChunk in 1..OffloadClient.MAX_CHUNK) { "Upload chunk size must be between 1 byte and 64 MiB." }
    }

    suspend fun send(
        recordingId: String,
        title: String,
        summarize: Boolean,
        publish: Boolean,
        style: String,
        onProgress: (UploadProgress) -> Unit,
    ): SendResult {
        val trimmed = title.trim()
        require(trimmed.isNotEmpty()) { "Title is required." }
        val bundle = library.exportBundle(recordingId)
        var createdJob = bundle.jobId != null
        try {
            val files = buildList {
                add(hashed(bundle.audioName, bundle.audioUri))
                bundle.photos.forEach { (name, uri) -> add(hashed(name, uri)) }
            }
            val totalBytes = files.sumOf { it.size }
            onProgress(UploadProgress(recordingId, 1, files.size.coerceAtLeast(1), 0, totalBytes, "Starting…"))
            val created = client.createJob(
                JobRequest(
                    recordingId = bundle.id,
                    createdAt = bundle.createdAt,
                    title = trimmed.take(120),
                    summarize = summarize,
                    publish = publish,
                    summaryStyle = style,
                    files = files.map { FileEntry(it.name, it.size, it.sha256) },
                ),
                bundle.metadataJson,
            )
            createdJob = true
            library.updateJob(bundle.id, created.jobId, "sending", created.webdavUrl, null)
            // A 422 hash_mismatch at commit means the server deleted the corrupt partials, so the
            // files it names must be streamed again from offset 0 before the next commit attempt.
            var restart: Set<String>? = null
            var committed: JobCreated? = null
            var attempt = 0
            while (committed == null) {
                check(++attempt <= MAX_COMMIT_ATTEMPTS) { "Upload kept failing server verification." }
                uploadFiles(created.jobId, recordingId, files, restart, totalBytes, onProgress)
                onProgress(UploadProgress(recordingId, files.size.coerceAtLeast(1), files.size.coerceAtLeast(1), totalBytes, totalBytes, "Finishing…"))
                try {
                    committed = client.commit(created.jobId)
                } catch (error: OffloadException) {
                    if (error.code == "hash_mismatch" && attempt < MAX_COMMIT_ATTEMPTS) {
                        restart = error.files?.toSet()?.takeIf { it.isNotEmpty() }
                            ?: files.map { it.name }.toSet()
                    } else {
                        throw error
                    }
                }
            }
            val url = committed?.webdavUrl ?: created.webdavUrl
            library.updateJob(bundle.id, created.jobId, "processing", url, System.currentTimeMillis())
            return SendResult(bundle.id, url)
        } catch (error: Throwable) {
            if (!coroutineContext.isActive) throw error
            if (!createdJob) library.updateJobStatus(recordingId, "local", null)
            throw error
        }
    }

    private suspend fun uploadFiles(
        jobId: String,
        recordingId: String,
        files: List<HashedFile>,
        restart: Set<String>?,
        totalBytes: Long,
        onProgress: (UploadProgress) -> Unit,
    ) {
        var overall = 0L
        files.forEachIndexed { index, file ->
            coroutineContext.ensureActive()
            var received = if (restart != null && file.name in restart) {
                0L
            } else {
                client.received(jobId, file.name).coerceIn(0L, file.size)
            }
            overall = files.take(index).sumOf { it.size } + received
            report(recordingId, index, files.size, overall, totalBytes, onProgress)
            while (received < file.size) {
                coroutineContext.ensureActive()
                val chunk = minOf(maxChunk, file.size - received)
                val sent = try {
                    client.putChunk(jobId, file.name, received, {
                        openAt(file.uri, received)
                    }, chunk)
                } catch (error: OffloadException) {
                    if (error.code == "offset_mismatch" && error.received != null) {
                        received = error.received.coerceIn(0L, file.size)
                        overall = files.take(index).sumOf { it.size } + received
                        report(recordingId, index, files.size, overall, totalBytes, onProgress)
                        continue
                    }
                    throw error
                }
                received = sent.coerceIn(received, file.size)
                overall = files.take(index).sumOf { it.size } + received
                report(recordingId, index, files.size, overall, totalBytes, onProgress)
            }
            overall = files.take(index + 1).sumOf { it.size }
        }
    }

    private fun hashed(name: String, uri: Uri): HashedFile {
        val digest = MessageDigest.getInstance("SHA-256")
        var size = 0L
        (openStream(uri) ?: throw OffloadException("Cannot read $name.")).use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                digest.update(buffer, 0, n)
                size += n
            }
        }
        check(size > 0) { "$name is empty." }
        val sha = digest.digest().joinToString("") { byte -> "%02x".format(byte) }
        return HashedFile(name, uri, size, sha)
    }

    private fun openAt(uri: Uri, offset: Long): InputStream {
        val input = openStream(uri) ?: throw OffloadException("Cannot open file for upload.")
        var remaining = offset
        val buffer = ByteArray(64 * 1024)
        while (remaining > 0) {
            val skipped = input.skip(remaining)
            if (skipped > 0) {
                remaining -= skipped
                continue
            }
            val n = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
            if (n < 0) {
                input.close()
                throw OffloadException("File is shorter than the resume offset.")
            }
            remaining -= n
        }
        return input
    }

    private fun report(
        recordingId: String,
        index: Int,
        count: Int,
        sent: Long,
        total: Long,
        onProgress: (UploadProgress) -> Unit,
    ) {
        onProgress(
            UploadProgress(
                recordingId = recordingId,
                fileIndex = index + 1,
                fileCount = count,
                bytesSent = sent,
                bytesTotal = total,
                phase = "Sending file ${index + 1} of $count",
            )
        )
    }

    private data class HashedFile(val name: String, val uri: Uri, val size: Long, val sha256: String)

    private companion object {
        /** Initial commit plus one re-try after the server rejects a file's hash. */
        const val MAX_COMMIT_ATTEMPTS = 2
    }
}
