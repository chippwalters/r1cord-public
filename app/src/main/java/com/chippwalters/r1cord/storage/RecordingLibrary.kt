package com.chippwalters.r1cord.storage

import android.content.ContentValues
import android.content.Context
import android.database.ContentObserver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.StatFs
import android.provider.MediaStore
import androidx.room.Room
import com.chippwalters.r1cord.model.PhotoItem
import com.chippwalters.r1cord.model.PublishedPage
import com.chippwalters.r1cord.model.RecordingItem
import java.io.File
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

class RecordingLibrary(context: Context) {
    private val context = context.applicationContext
    private val resolver = context.contentResolver
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val db = Room.databaseBuilder(this.context, RecordingDatabase::class.java, "r1cord.db")
        .addMigrations(MIGRATION_1_2, MIGRATION_2_3)
        .build()
    private val dao = db.recordings()
    private val lock = Mutex()
    private val active = mutableSetOf<String>()
    private val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    private val ready = scope.async { lock.withLock { recover() } }
    val items: StateFlow<List<RecordingItem>> = combine(dao.observeRecordings(), dao.observePhotos()) { rows, photos ->
        rows.map { row ->
            RecordingItem(
                id = row.id,
                title = row.title,
                createdAt = row.createdAt,
                durationMs = row.durationMs,
                audioUri = row.audioUri,
                status = row.status,
                photos = photos.filter { it.recordingId == row.id && it.status == "SAVED" }
                    .map { PhotoItem(it.id, it.uri, it.createdAt) },
                waveform = decodeWaveform(row.waveform),
                jobId = row.jobId,
                jobStatus = row.jobStatus,
                pages = decodePages(row.pages),
            )
        }
    }.stateIn(scope, SharingStarted.Eagerly, emptyList())

    private val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) {
            scope.launch {
                runCatching {
                    ready.await()
                    delay(300)
                    lock.withLock { reconcileMissing() }
                }.onFailure { android.util.Log.w("R1CORD", "Could not reconcile externally changed media", it) }
            }
        }
    }

    init { resolver.registerContentObserver(collection, true, observer) }

    /** Recordable seconds left, at the byte rate of the format the next session will use. */
    fun remainingSeconds(bytesPerSecond: Long): Long = recordableSeconds(availableBytes(), bytesPerSecond)

    internal fun hasRecordingSpace(): Boolean = availableBytes() > RESERVE_BYTES + STOP_MARGIN_BYTES

    internal suspend fun begin(wav: Boolean): RecordingTarget = withContext(Dispatchers.IO) {
        ready.await()
        lock.withLock {
            check(hasRecordingSpace()) { "Storage is full. Keep at least 64 MiB free before recording." }
            val now = System.currentTimeMillis()
            val id = newRecordingId(now)
            val row = RecordingRow(id, recordingTitle(now), now)
            dao.insert(row)
            active.add(id)
            try {
                val extension = if (wav) WAV_EXTENSION else AAC_EXTENSION
                val uri = insertMedia(id, "audio.partial.$extension", if (wav) WAV_MIME else AAC_MIME)
                try { dao.audio(id, uri.toString()) } catch (error: Exception) { resolver.delete(uri, null, null); throw error }
                RecordingTarget(id, uri)
            } catch (error: Exception) {
                active.remove(id)
                dao.status(id, "INTERRUPTED", error.message)
                throw error
            }
        }
    }

    internal suspend fun captureStatus(id: String, status: String) = withContext(Dispatchers.IO) {
        ready.await()
        lock.withLock { dao.status(id, status) }
    }

    internal suspend fun checkpoint(id: String, duration: Long, waveform: List<Float>) = withContext(Dispatchers.IO) {
        ready.await()
        lock.withLock { dao.progress(id, duration, JSONArray(waveform).toString()) }
    }

    internal suspend fun finish(id: String, duration: Long, waveform: List<Float>, failure: String? = null): Boolean = withContext(Dispatchers.IO) {
        ready.await()
        lock.withLock {
            var audioUri = ""
            try {
                dao.progress(id, duration, JSONArray(waveform).toString())
                val row = dao.recording(id) ?: return@withLock false
                audioUri = row.audioUri
                var problem = failure
                if (problem == null) {
                    dao.status(id, "FINALIZING")
                    try {
                        val retriever = MediaMetadataRetriever()
                        try {
                            retriever.setDataSource(context, Uri.parse(row.audioUri))
                            val actual = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0
                            check(actual > 0) { "No playable audio was captured." }
                            dao.progress(id, actual, JSONArray(waveform).toString())
                        } finally { retriever.release() }
                    } catch (error: Exception) { problem = error.message ?: "Audio could not be finalized." }
                }
                val status = if (problem == null) "SAVED" else "INTERRUPTED"
                publish(Uri.parse(row.audioUri), audioName(row.audioUri, problem == null))
                // Metadata is published before committing SAVED. A crash in between recovers as INTERRUPTED.
                writeMetadata(id, status, problem)
                dao.status(id, status, problem)
                problem == null
            } catch (error: Exception) {
                dao.status(id, "INTERRUPTED", error.message ?: "Publication failed.")
                if (audioUri.isNotEmpty()) runCatching { publish(Uri.parse(audioUri), audioName(audioUri, false)) }
                runCatching { writeMetadata(id, "INTERRUPTED", error.message) }
                false
            } finally { active.remove(id) }
        }
    }

    suspend fun addPhoto(recordingId: String, jpeg: File) = withContext(Dispatchers.IO) {
        ready.await()
        lock.withLock {
            val row = requireNotNull(dao.recording(recordingId)) { "Recording no longer exists." }
            check(row.status != "DELETING") { "Recording is being deleted." }
            // Camera writes may overlap recording: reserve 16 MiB beyond the audio stop threshold.
            check(availableBytes() > RESERVE_BYTES + PHOTO_MARGIN_BYTES) { "Not enough space for a photo; audio remains protected." }
            val bitmap = decodePhoto(jpeg)
            val id = UUID.randomUUID().toString()
            var uri: Uri? = null
            try {
                dao.insertPhoto(PhotoRow(id, recordingId, "", System.currentTimeMillis()))
                val outputUri = insertMedia(recordingId, "photo-$id.partial.jpg", "image/jpeg")
                uri = outputUri
                dao.photoUri(id, outputUri.toString())
                val descriptor = resolver.openFileDescriptor(outputUri, "w") ?: error("Cannot open photo output.")
                android.os.ParcelFileDescriptor.AutoCloseOutputStream(descriptor).use { output ->
                    check(bitmap.compress(Bitmap.CompressFormat.JPEG, 90, output)) { "JPEG encoding failed." }
                    output.flush()
                    output.fd.sync()
                }
                check(availableBytes() > RESERVE_BYTES + STOP_MARGIN_BYTES) { "Photo stopped to protect audio storage." }
                publish(outputUri, "photo-$id.jpg")
                dao.photoStatus(id, "SAVED")
                writeMetadata(recordingId)
            } catch (error: Exception) {
                dao.photoStatus(id, "INTERRUPTED")
                uri?.let { runCatching { publish(it, "photo-$id.interrupted.jpg") } }
                runCatching { writeMetadata(recordingId) }
                throw error
            } finally { bitmap.recycle() }
        }
    }

    suspend fun deleteRecording(id: String) = withContext(Dispatchers.IO) {
        ready.await()
        lock.withLock {
            check(id !in active) { "Stop recording before deleting it." }
            val row = dao.recording(id) ?: return@withLock
            dao.status(id, "DELETING")
            deleteFiles(row)
        }
    }

    suspend fun exportBundle(id: String): OffloadBundle = withContext(Dispatchers.IO) {
        ready.await()
        lock.withLock {
            val row = dao.recording(id) ?: error("Recording no longer exists.")
            check(row.status == "SAVED") { "Only saved recordings can be sent." }
            check(row.audioUri.isNotEmpty()) { "This recording has no audio file." }
            val photos = dao.photos(id).filter { it.status == "SAVED" && it.uri.isNotEmpty() }
                .map { "photo-${it.id}.jpg" to Uri.parse(it.uri) }
            val metadataJson = resolver.openInputStream(Uri.parse(row.metadataUri.takeIf { it.isNotEmpty() } ?: error("metadata.json is missing.")))
                ?.use { it.readBytes().toString(Charsets.UTF_8) }
                ?: error("metadata.json is missing.")
            OffloadBundle(
                id = row.id,
                title = row.title,
                createdAt = row.createdAt,
                audioName = "audio.${audioExtension(row.audioUri)}",
                audioUri = Uri.parse(row.audioUri),
                photos = photos,
                metadataJson = metadataJson,
                jobId = row.jobId,
            )
        }
    }

    suspend fun updateJob(id: String, jobId: String?, status: String, url: String?, pages: List<PublishedPage>, sentAt: Long?) = withContext(Dispatchers.IO) {
        ready.await()
        lock.withLock { dao.updateJob(id, jobId, status, url, encodePages(pages), sentAt) }
    }

    suspend fun updateJobStatus(id: String, status: String, url: String?, pages: List<PublishedPage>) = withContext(Dispatchers.IO) {
        ready.await()
        lock.withLock { dao.updateJobStatus(id, status, url, encodePages(pages)) }
    }

    suspend fun deletePhoto(recordingId: String, photoId: String) = withContext(Dispatchers.IO) {
        ready.await()
        lock.withLock {
            val photo = dao.photos(recordingId).firstOrNull { it.id == photoId } ?: return@withLock
            dao.photoStatus(photoId, "DELETING")
            deleteUri(photo.uri)
            dao.deletePhoto(photoId)
            writeMetadata(recordingId)
        }
    }

    private suspend fun recover() {
        for (original in dao.recordings()) {
            recoverLinks(original)
            val row = dao.recording(original.id) ?: continue
            if (row.status == "DELETING") {
                runCatching { deleteFiles(row) }
                continue
            }
            if (row.status in setOf("STARTING", "RECORDING", "PAUSED", "FINALIZING")) {
                dao.status(row.id, "INTERRUPTED", "Recording was interrupted before it could finish.")
                if (row.audioUri.isNotEmpty()) runCatching { publish(Uri.parse(row.audioUri), audioName(row.audioUri, false)) }
                runCatching { writeMetadata(row.id, "INTERRUPTED", "Recording was interrupted before it could finish.") }
            }
            if (row.status == "INTERRUPTED" && row.audioUri.isNotEmpty()) {
                runCatching { publish(Uri.parse(row.audioUri), audioName(row.audioUri, false)) }
            }
            for (photo in dao.photos(row.id)) {
                if (photo.status == "DELETING") {
                    runCatching { deleteUri(photo.uri); dao.deletePhoto(photo.id) }
                } else if (photo.status == "WRITING" || photo.status == "INTERRUPTED") {
                    dao.photoStatus(photo.id, "INTERRUPTED")
                    if (photo.uri.isNotEmpty()) runCatching { publish(Uri.parse(photo.uri), "photo-${photo.id}.interrupted.jpg") }
                }
            }
            // Rebuild metadata after any mid-write crash and after interrupted photo recovery.
            runCatching { writeMetadata(row.id) }
        }
        reconcileMissing()
    }

    private suspend fun recoverLinks(row: RecordingRow) {
        val files = mutableMapOf<String, String>()
        resolver.query(collection, arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME),
            "${MediaStore.MediaColumns.RELATIVE_PATH} = ? AND ${MediaStore.MediaColumns.OWNER_PACKAGE_NAME} = ?",
            arrayOf("${Environment.DIRECTORY_DOWNLOADS}/R1CORD/${row.id}/", context.packageName), null)?.use { cursor ->
            while (cursor.moveToNext()) files[cursor.getString(1)] = android.content.ContentUris.withAppendedId(collection, cursor.getLong(0)).toString()
        }
        // A process can die between a MediaStore insert and the corresponding Room update.
        if (row.audioUri.isEmpty()) {
            val audio = files.entries.firstOrNull { it.key.startsWith("audio.") && !it.key.endsWith(".json") }?.value
            if (audio != null) dao.audio(row.id, audio)
        }
        if (row.metadataUri.isEmpty()) files["metadata.json"]?.let { dao.metadata(row.id, it) }
        for (photo in dao.photos(row.id)) {
            if (photo.uri.isEmpty()) {
                val uri = files["photo-${photo.id}.partial.jpg"] ?: files["photo-${photo.id}.jpg"] ?: files["photo-${photo.id}.interrupted.jpg"]
                if (uri != null) dao.photoUri(photo.id, uri)
            }
        }
    }

    private suspend fun reconcileMissing() {
        for (row in dao.recordings()) {
            if (row.id in active || row.status == "DELETING") continue
            var changed = false
            if (row.audioUri.isNotEmpty() && !exists(row.audioUri) && row.status != "MISSING") {
                dao.status(row.id, "MISSING", "Audio was removed outside R1CORD.")
                changed = true
            }
            for (photo in dao.photos(row.id)) {
                if (photo.status == "SAVED" && !exists(photo.uri)) { dao.photoStatus(photo.id, "MISSING"); changed = true }
            }
            if (changed) runCatching { writeMetadata(row.id) }
        }
    }

    private suspend fun deleteFiles(row: RecordingRow) {
        for (photo in dao.photos(row.id)) deleteUri(photo.uri)
        deleteUri(row.audioUri)
        deleteUri(row.metadataUri)
        dao.delete(row.id)
        removeFolder(row.id)
    }

    // Deleting the MediaStore entries empties `Download/R1CORD/<id>/` but leaves the folder,
    // which would accumulate in the directory the user browses when copying to a PC. Best
    // effort only: the platform may refuse the rmdir, and a stale empty folder is not a
    // failed deletion. Never remove a folder that still holds files.
    private fun removeFolder(id: String) {
        runCatching {
            @Suppress("DEPRECATION")
            val downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
            val folder = File(downloads, "R1CORD/$id")
            if (folder.isDirectory && folder.list()?.isEmpty() == true) folder.delete()
        }
    }

    private suspend fun writeMetadata(id: String, status: String? = null, error: String? = null) {
        val row = dao.recording(id) ?: return
        val payload = buildMetadataPayload(row, dao.photos(id), audioExtension(row.audioUri), status, error)
        val bytes = payload.toString(2).toByteArray(Charsets.UTF_8)
        // Reuse the journaled URI so Android never silently creates metadata (1).json.
        val uri = if (row.metadataUri.isNotEmpty() && exists(row.metadataUri)) Uri.parse(row.metadataUri) else {
            val created = insertMedia(id, "metadata.json", "application/json")
            try { dao.metadata(id, created.toString()) } catch (failure: Exception) { resolver.delete(created, null, null); throw failure }
            created
        }
        // Hide a previously published file before truncating it. Failed writes stay pending for recovery.
        check(resolver.update(uri, ContentValues().apply {
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }, null, null) > 0) { "Metadata file was removed before updating; no metadata was written." }
        try {
            val descriptor = resolver.openFileDescriptor(uri, "rwt") ?: throw IOException("Cannot open metadata output.")
            android.os.ParcelFileDescriptor.AutoCloseOutputStream(descriptor).use { output ->
                output.write(bytes)
                output.flush()
                output.fd.sync()
            }
            publish(uri, "metadata.json")
        } catch (failure: Exception) {
            throw IOException("Metadata update did not complete; metadata may be incomplete and remains pending recovery.", failure)
        }
    }

    private fun insertMedia(id: String, name: String, mime: String): Uri = resolver.insert(collection, ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, name)
        put(MediaStore.MediaColumns.MIME_TYPE, mime)
        put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/R1CORD/$id/")
        put(MediaStore.MediaColumns.IS_PENDING, 1)
    }) ?: throw IOException("Could not create public media file.")

    private fun publish(uri: Uri, name: String) {
        check(resolver.update(uri, ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.IS_PENDING, 0)
        }, null, null) > 0) { "Media file was removed before publication." }
    }

    /**
     * The audio container a recording was created with, read back from its own MediaStore
     * display name. Keeping the name authoritative avoids a Room column and a migration,
     * and keeps recovery correct for files written before the format was selectable.
     */
    private fun audioExtension(uri: String): String {
        if (uri.isEmpty()) return AAC_EXTENSION
        val name = runCatching {
            resolver.query(Uri.parse(uri), arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)
                ?.use { if (it.moveToFirst()) it.getString(0) else null }
        }.getOrNull()
        return audioExtensionFor(name)
    }

    /** Published name for a recording's audio, preserving the container it was recorded in. */
    private fun audioName(uri: String, complete: Boolean): String =
        if (complete) "audio.${audioExtension(uri)}" else "audio.interrupted.${audioExtension(uri)}"

    private fun deleteUri(uri: String) { if (uri.isNotEmpty()) resolver.delete(Uri.parse(uri), null, null) }
    private fun exists(uri: String): Boolean = try {
        resolver.query(Uri.parse(uri), arrayOf(MediaStore.MediaColumns._ID), null, null, null)?.use { it.moveToFirst() } ?: false
    } catch (_: java.io.FileNotFoundException) { false } catch (_: SecurityException) { false }

    private fun availableBytes(): Long = try {
        minOf(StatFs(Environment.getExternalStorageDirectory().absolutePath).availableBytes, StatFs(context.filesDir.absolutePath).availableBytes)
    } catch (_: Exception) { 0 }

    private fun decodePhoto(file: File): Bitmap {
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, options)
        check(options.outWidth > 0 && options.outHeight > 0) { "Camera did not produce a readable JPEG." }
        options.inSampleSize = 1
        while (maxOf(options.outWidth, options.outHeight) / options.inSampleSize > 3840) options.inSampleSize *= 2
        options.inJustDecodeBounds = false
        val decoded = BitmapFactory.decodeFile(file.absolutePath, options) ?: error("JPEG decoding failed.")
        val matrix = Matrix()
        when (ExifInterface(file.absolutePath).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.setScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.setRotate(90f); matrix.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
            ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.setRotate(-90f); matrix.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(270f)
        }
        val ratio = minOf(1f, 1920f / maxOf(decoded.width, decoded.height))
        matrix.postScale(ratio, ratio)
        return try {
            Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true).also { if (it !== decoded) decoded.recycle() }
        } catch (error: Throwable) { decoded.recycle(); throw error }
    }

    private fun decodeWaveform(value: String): List<Float> {
        val array = JSONArray(value)
        return List(array.length()) { array.optDouble(it, 0.0).toFloat().coerceIn(0f, 1f) }
    }

    internal data class RecordingTarget(val id: String, val uri: Uri)
    companion object {
        const val RESERVE_BYTES = 64L * 1024 * 1024
        private const val STOP_MARGIN_BYTES = 2L * 1024 * 1024
        private const val PHOTO_MARGIN_BYTES = 16L * 1024 * 1024
        internal const val AAC_EXTENSION = "m4a"
        internal const val WAV_EXTENSION = "wav"
        private const val AAC_MIME = "audio/mp4"
        private const val WAV_MIME = "audio/x-wav"
        internal const val AAC_BIT_RATE = 96_000
        internal const val WAV_BIT_RATE = 768_000
    }
}

// --- Pure helpers, extracted so their contracts can be tested without a device ---------

/**
 * Recording id: UTC-independent local timestamp plus 8 random hex chars, e.g.
 * "20260923-141530-1a2b3c4d". The timestamp prefix sorts naturally in the library
 * and the suffix keeps ids unique when several are created in the same second.
 */
internal fun newRecordingId(at: Long): String =
    SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date(at)) + "-" + UUID.randomUUID().toString().take(8)

/** Library title shown to the user: short local date and time, e.g. "Sep 23, 14:15". */
internal fun recordingTitle(at: Long): String =
    SimpleDateFormat("MMM d, HH:mm", Locale.getDefault()).format(Date(at))

/**
 * The container implied by a recording's MediaStore display name: WAV only when the
 * name ends in ".wav" (case-insensitive); everything else, including a missing name,
 * is the historical AAC/M4A default.
 */
internal fun audioExtensionFor(displayName: String?): String =
    if (displayName != null && displayName.endsWith(".${RecordingLibrary.WAV_EXTENSION}", ignoreCase = true))
        RecordingLibrary.WAV_EXTENSION else RecordingLibrary.AAC_EXTENSION

/** Audio file name recorded in metadata.json for a recording in [state]. */
internal fun audioFileFor(state: String, extension: String): String = when {
    state == "SAVED" -> "audio.$extension"
    state in setOf("RECORDING", "PAUSED", "STARTING") -> "audio.partial.$extension"
    else -> "audio.interrupted.$extension"
}

/**
 * The metadata.json payload for a recording. [status] and [error] override the row when
 * finishing/recovery wants to describe an outcome that is not yet the stored status.
 */
internal fun buildMetadataPayload(
    row: RecordingRow,
    photos: List<PhotoRow>,
    extension: String,
    status: String? = null,
    error: String? = null,
): JSONObject {
    val photoList = JSONArray()
    photos.forEach { photo ->
        photoList.put(JSONObject().put("id", photo.id).put("createdAt", photo.createdAt).put("status", photo.status)
            .put("file", if (photo.status == "SAVED") "photo-${photo.id}.jpg" else "photo-${photo.id}.interrupted.jpg"))
    }
    val state = status ?: row.status
    val wav = extension == RecordingLibrary.WAV_EXTENSION
    return JSONObject().put("schemaVersion", 1).put("id", row.id).put("title", row.title)
        .put("createdAt", row.createdAt).put("durationMs", row.durationMs).put("status", state)
        .put("audio", audioFileFor(state, extension))
        .put("format", if (wav) "wav-pcm16" else "aac-lc")
        .put("sampleRate", 48000).put("channels", 1)
        .put("bitrate", if (wav) RecordingLibrary.WAV_BIT_RATE else RecordingLibrary.AAC_BIT_RATE)
        .put("waveform", JSONArray(row.waveform)).put("photos", photoList)
        .put("error", error ?: row.error ?: JSONObject.NULL)
}

/**
 * Recordable seconds for [availableBytes] of free storage at [bytesPerSecond]: the
 * 64 MiB reserve is always subtracted and never yields a negative estimate.
 */
internal fun recordableSeconds(availableBytes: Long, bytesPerSecond: Long): Long =
    ((availableBytes - RecordingLibrary.RESERVE_BYTES).coerceAtLeast(0) / bytesPerSecond.coerceAtLeast(1))

data class OffloadBundle(
    val id: String,
    val title: String,
    val createdAt: Long,
    val audioName: String,
    val audioUri: Uri,
    val photos: List<Pair<String, Uri>>,
    val metadataJson: String,
    val jobId: String? = null,
)
