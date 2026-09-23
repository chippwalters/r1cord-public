package com.chippwalters.r1cord.sync

import android.content.Context
import android.net.Uri
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

class UploadCoordinator(
    context: Context,
    private val library: RecordingLibrary,
    private val client: OffloadClient,
) {
    private val context = context.applicationContext
    private val resolver = this.context.contentResolver

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
            var overall = 0L
            files.forEachIndexed { index, file ->
                coroutineContext.ensureActive()
                var received = client.received(created.jobId, file.name).coerceIn(0L, file.size)
                overall = files.take(index).sumOf { it.size } + received
                report(recordingId, index, files.size, overall, totalBytes, onProgress)
                while (received < file.size) {
                    coroutineContext.ensureActive()
                    val chunk = minOf(OffloadClient.MAX_CHUNK, file.size - received)
                    val sent = try {
                        client.putChunk(created.jobId, file.name, received, {
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
            onProgress(UploadProgress(recordingId, files.size.coerceAtLeast(1), files.size.coerceAtLeast(1), totalBytes, totalBytes, "Finishing…"))
            val committed = client.commit(created.jobId)
            val url = committed.webdavUrl ?: created.webdavUrl
            library.updateJob(bundle.id, created.jobId, "processing", url, System.currentTimeMillis())
            return SendResult(bundle.id, url)
        } catch (error: Throwable) {
            if (!coroutineContext.isActive) throw error
            if (!createdJob) library.updateJobStatus(recordingId, "local", null)
            throw error
        }
    }

    private fun hashed(name: String, uri: Uri): HashedFile {
        val digest = MessageDigest.getInstance("SHA-256")
        var size = 0L
        (resolver.openInputStream(uri) ?: throw OffloadException("Cannot read $name.")).use { input ->
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
        val input = resolver.openInputStream(uri) ?: throw OffloadException("Cannot open file for upload.")
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
}
