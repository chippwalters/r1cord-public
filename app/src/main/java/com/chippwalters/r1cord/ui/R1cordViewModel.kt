package com.chippwalters.r1cord.ui

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioManager
import android.net.Uri
import android.os.BatteryManager
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.chippwalters.r1cord.R1cordApplication
import com.chippwalters.r1cord.device.MaintenanceGate
import com.chippwalters.r1cord.model.*
import com.chippwalters.r1cord.recording.RecorderSettings
import com.chippwalters.r1cord.storage.RecordingLibrary
import com.chippwalters.r1cord.storage.RenameResult
import com.chippwalters.r1cord.storage.validateTitle
import com.chippwalters.r1cord.sync.OffloadSettings
import com.chippwalters.r1cord.sync.SendResult
import com.chippwalters.r1cord.sync.deviceBadge
import java.io.File
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChangedBy
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class R1cordViewModel(application: Application) : AndroidViewModel(application) {
    private val graph = application as R1cordApplication
    private val audio = application.getSystemService(AudioManager::class.java)
    // Pairing can change outside this ViewModel (USB provisioning through SetupProvider).
    private val pairing = OffloadSettings.pairing(application)
    private val mutableState = MutableStateFlow(
        AppUiState(
            paired = pairing.value.paired,
            serverName = pairing.value.serverName,
        )
    )
    val state = mutableState.asStateFlow()
    private var detailReturn = Screen.HOME
    private var viewerReturn = Screen.HOME
    private var seenCompletedId: String? = null
    private var uploadJob: Job? = null

    init {
        viewModelScope.launch { graph.library.items.collect { items -> mutableState.update { it.copy(recordings = items) } } }
        viewModelScope.launch {
            pairing.collect { snapshot -> mutableState.update { it.copy(paired = snapshot.paired, serverName = snapshot.serverName) } }
        }
        viewModelScope.launch {
            graph.playback.state.collect { player ->
                mutableState.update { previous ->
                    previous.copy(playback = player, message = if (player.error != null && player.error != previous.playback.error) player.error else previous.message)
                }
            }
        }
        viewModelScope.launch {
            state.map { current ->
                current.selected?.takeIf { current.screen == Screen.DETAIL && !current.isCapturing &&
                    (it.status == "SAVED" || it.status == "INTERRUPTED") }
            }.distinctUntilChangedBy { it?.let { item -> Triple(item.id, item.audioUri, item.status) } }
                .collect { item ->
                    if (item != null && item.audioUri.isNotBlank()) {
                        runCatching { graph.playback.prepare(item) }.onFailure { showError(it.message ?: "Unable to load recording") }
                    }
                }
        }
        viewModelScope.launch {
            graph.recorder.state.collect { capture ->
                mutableState.update { previous ->
                    var next = previous.copy(capture = capture)
                    if (capture.recordingId != null && previous.screen == Screen.RECORDING) next = next.copy(selectedId = capture.recordingId)
                    if (capture.lastCompletedId != null && capture.lastCompletedId != seenCompletedId) {
                        seenCompletedId = capture.lastCompletedId
                        detailReturn = Screen.HOME
                        next = next.copy(screen = Screen.DETAIL, selectedId = capture.lastCompletedId)
                    }
                    // A start that fails, or a session that ends without a saved file, leaves
                    // the recorder IDLE; the recording screen has no usable control then.
                    if (capture.status == CaptureStatus.IDLE && next.screen == Screen.RECORDING) next = next.copy(screen = Screen.HOME)
                    if (capture.error != null && capture.error != previous.capture.error) next = next.copy(message = capture.error)
                    next
                }
            }
        }
        viewModelScope.launch {
            while (true) {
                val intent = application.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
                val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, 100)?.coerceAtLeast(1) ?: 100
                val battery = ((intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, 0) ?: 0) * 100 / scale).coerceIn(0, 100)
                val charging = (intent?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0 &&
                    intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) == BatteryManager.BATTERY_STATUS_CHARGING
                // The estimate must track the format the next recording will actually use:
                // WAV is roughly 7.4x the byte rate of AAC.
                val rate = RecorderSettings.bytesPerSecond(RecorderSettings.wavOutput(application))
                val seconds = withContext(Dispatchers.IO) { graph.library.remainingSeconds(rate) }
                mutableState.update { it.copy(storageSeconds = seconds, batteryPercent = battery, isCharging = charging,
                    volume = audio.getStreamVolume(AudioManager.STREAM_MUSIC), volumeMax = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)) }
                delay(2000)
            }
        }
    }

    fun startStop() {
        if (state.value.upload != null) return
        val capture = state.value.capture
        when (capture.status) {
            CaptureStatus.IDLE -> {
                if (!hasPermission(Manifest.permission.RECORD_AUDIO)) { showError("Microphone permission is required. Allow it in Android Settings through maintenance."); return }
                if (state.value.storageSeconds <= 0) { showError("Storage is full. Copy your recordings to the computer, verify them, then delete local files."); return }
                graph.playback.stop()
                mutableState.update { it.copy(screen = Screen.RECORDING, selectedId = null, message = null) }
                runCatching { graph.recorder.start() }.onFailure { showError(it.message ?: "Could not start recording") }
            }
            CaptureStatus.RECORDING, CaptureStatus.AUTO_LISTENING, CaptureStatus.PAUSED -> graph.recorder.stop()
            CaptureStatus.STARTING, CaptureStatus.STOPPING -> Unit
        }
    }

    fun pauseResume() {
        when (state.value.capture.status) {
            CaptureStatus.RECORDING, CaptureStatus.AUTO_LISTENING -> graph.recorder.pause()
            CaptureStatus.PAUSED -> graph.recorder.resume()
            else -> Unit
        }
    }
    fun openLibrary() { mutableState.update { it.copy(screen = Screen.LIBRARY) } }
    fun home() {
        graph.playback.stop()
        mutableState.update { it.copy(screen = if (it.isCapturing) Screen.RECORDING else Screen.HOME) }
    }
    fun openRecording(id: String) {
        graph.playback.stop()
        detailReturn = Screen.LIBRARY
        mutableState.update { it.copy(screen = Screen.DETAIL, selectedId = id) }
    }
    fun openCamera() {
        if (!hasPermission(Manifest.permission.CAMERA)) { showError("Camera permission is required. Audio can still be recorded."); return }
        val current = state.value
        val id = if (current.isCapturing) current.capture.recordingId else current.selectedId
        if (id == null) { showError("Select or start a recording first."); return }
        graph.playback.stop()
        mutableState.update { it.copy(screen = Screen.CAMERA, selectedId = id) }
    }
    fun back() {
        when (state.value.screen) {
            Screen.CAMERA -> mutableState.update { it.copy(screen = if (it.isCapturing) Screen.RECORDING else Screen.DETAIL) }
            Screen.DETAIL -> { graph.playback.stop(); mutableState.update { it.copy(screen = if (it.isCapturing) Screen.RECORDING else detailReturn) } }
            Screen.LIBRARY -> home()
            Screen.RECORDING -> if (state.value.isCapturing) showError("Stop the recording before leaving this screen.") else home()
            Screen.VIEWER -> mutableState.update { it.copy(screen = if (it.isCapturing) Screen.RECORDING else viewerReturn, viewerUrl = null) }
            Screen.HOME -> Unit
        }
    }
    fun playPause() {
        val current = state.value
        if (current.isCapturing) { showError("Stop recording before playback."); return }
        val item = current.selected ?: return
        if (current.playback.recordingId == item.id && current.playback.isPlaying) graph.playback.pause()
        else runCatching { graph.playback.play(item) }.onFailure { showError(it.message ?: "Unable to play audio") }
    }
    fun seek(ms: Long) { graph.playback.seekTo(ms) }
    fun skip(deltaMs: Long) { seek((state.value.playback.positionMs + deltaMs).coerceAtLeast(0)) }
    fun setVolume(value: Int) {
        val level = value.coerceIn(0, audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC))
        audio.setStreamVolume(AudioManager.STREAM_MUSIC, level, 0)
        mutableState.update { it.copy(volume = level) }
    }
    fun deleteRecording(id: String) {
        if (state.value.capture.recordingId == id && state.value.isCapturing) { showError("Stop recording before deleting it."); return }
        if (state.value.playback.recordingId == id) graph.playback.stop()
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { graph.library.deleteRecording(id) } }
                .onSuccess { mutableState.update { it.copy(screen = Screen.LIBRARY, selectedId = null) } }
                .onFailure { showError(it.message ?: "Could not delete recording") }
        }
    }
    fun deletePhoto(recordingId: String, photoId: String) {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { graph.library.deletePhoto(recordingId, photoId) } }
                .onFailure { showError(it.message ?: "Could not delete photo") }
        }
    }
    fun photoCaptured(recordingId: String, file: File) {
        viewModelScope.launch {
            try { withContext(Dispatchers.IO) { graph.library.addPhoto(recordingId, file) } }
            catch (e: Exception) { showError(e.message ?: "Photo could not be saved. Recording continues.") }
            finally { withContext(Dispatchers.IO) { file.delete() } }
        }
    }
    fun showError(message: String) { mutableState.update { it.copy(message = message) } }
    fun dismissMessage() { graph.recorder.clearError(); mutableState.update { it.copy(message = null) } }

    fun openSendSheet(id: String) {
        if (state.value.isCapturing) { showError("Stop recording before sending."); return }
        if (state.value.upload != null) return
        if (!OffloadSettings.isPaired(getApplication())) {
            showError("Pair with the desktop server in Settings first.")
            return
        }
        val item = state.value.recordings.firstOrNull { it.id == id }
        if (item == null || item.status != "SAVED") {
            showError("Only saved recordings can be sent.")
            return
        }
        mutableState.update { it.copy(sendSheetFor = id) }
    }

    fun closeSendSheet() { mutableState.update { it.copy(sendSheetFor = null) } }

    /** Opens the Rename dialog. The Send panel, if open, stays open underneath it. */
    fun openRename(id: String) {
        val current = state.value
        if (current.isCapturing && current.capture.recordingId == id) { showError("Stop recording before renaming it."); return }
        if (current.recordings.none { it.id == id }) { showError("Recording no longer exists."); return }
        mutableState.update { it.copy(rename = RenameUiState(id)) }
    }

    fun closeRename() { mutableState.update { it.copy(rename = null) } }

    /**
     * Saves [title] as the recording's durable title (Room, then metadata.json). Validation
     * and storage failures keep the dialog open with the error; a saved title whose metadata
     * rewrite failed closes it with a message, since the next send repairs the metadata.
     */
    fun renameRecording(id: String, title: String) {
        val current = state.value
        if (current.rename?.busy == true) return
        if (current.isCapturing && current.capture.recordingId == id) { renameFailed(id, "Stop recording before renaming it."); return }
        val clean = try { validateTitle(title) } catch (e: IllegalArgumentException) {
            renameFailed(id, e.message ?: "Enter a valid title.")
            return
        }
        mutableState.update { it.copy(rename = RenameUiState(id, busy = true)) }
        viewModelScope.launch {
            val result = try {
                withContext(Dispatchers.IO) { graph.library.renameRecording(id, clean) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                renameFailed(id, e.message ?: "Could not rename recording.")
                return@launch
            }
            mutableState.update { previous ->
                val rename = previous.rename?.takeIf { it.recordingId != id }
                when (result) {
                    RenameResult.Saved -> previous.copy(rename = rename)
                    is RenameResult.SavedMetadataFailed -> previous.copy(
                        rename = rename,
                        message = "Title saved; metadata update failed. It will be repaired before the next send.",
                    )
                }
            }
        }
    }

    /** Shows [message] in the open Rename dialog for [id], or as a message if it was closed. */
    private fun renameFailed(id: String, message: String) {
        mutableState.update {
            if (it.rename?.recordingId == id) it.copy(rename = RenameUiState(id, busy = false, error = message))
            else it.copy(message = message)
        }
    }

    /** Sends a recording under its durable title (see UploadCoordinator.send). */
    fun send(id: String, reviews: Collection<String>, publish: Boolean) {
        if (state.value.isCapturing) { showError("Stop recording before sending."); return }
        if (state.value.upload != null) return
        if (MaintenanceGate.snapshot().maintenance) { showError(RecordingLibrary.MAINTENANCE_MESSAGE); return }
        closeSendSheet()
        startUpload {
            val result = graph.uploadCoordinator.send(id, reviews, publish) { progress ->
                mutableState.update {
                    it.copy(
                        upload = UploadUiState(
                            recordingId = progress.recordingId,
                            fileIndex = progress.fileIndex,
                            fileCount = progress.fileCount,
                            bytesSent = progress.bytesSent,
                            bytesTotal = progress.bytesTotal,
                            phase = progress.phase,
                        )
                    )
                }
            }
            mutableState.update { it.copy(sendResult = SendResultUi(result.recordingId, result.pages.primaryPage()?.url)) }
            notifySent(result)
        }
    }

    fun sendAll() {
        if (state.value.isCapturing) { showError("Stop recording before sending."); return }
        if (state.value.upload != null) return
        if (MaintenanceGate.snapshot().maintenance) { showError(RecordingLibrary.MAINTENANCE_MESSAGE); return }
        if (!OffloadSettings.isPaired(getApplication())) {
            showError("Pair with the desktop server in Settings first.")
            return
        }
        val items = state.value.recordings.filter { it.status == "SAVED" && deviceBadge(it.jobStatus) == "local" }
        if (items.isEmpty()) { showError("Nothing to send."); return }
        val app = getApplication<Application>()
        val reviews = OffloadSettings.defaultReviews(app)
        val publish = OffloadSettings.defaultPublish(app)
        startUpload {
            var last: SendResult? = null
            items.forEachIndexed { index, item ->
                val result = graph.uploadCoordinator.send(item.id, reviews, publish) { progress ->
                    val prefix = "${index + 1} of ${items.size}"
                    mutableState.update {
                        it.copy(
                            upload = UploadUiState(
                                recordingId = progress.recordingId,
                                fileIndex = progress.fileIndex,
                                fileCount = progress.fileCount,
                                bytesSent = progress.bytesSent,
                                bytesTotal = progress.bytesTotal,
                                phase = "$prefix · ${progress.phase}",
                            )
                        )
                    }
                }
                notifySent(result)
                last = result
            }
            last?.let { result ->
                mutableState.update { it.copy(sendResult = SendResultUi(result.recordingId, result.pages.primaryPage()?.url)) }
            }
        }
    }

    fun cancelUpload() {
        uploadJob?.cancel()
        uploadJob = null
    }

    fun dismissSendResult() { mutableState.update { it.copy(sendResult = null) } }

    fun refreshStatuses() {
        if (state.value.upload != null) return
        if (!OffloadSettings.isPaired(getApplication())) {
            showError("Pair with the desktop server in Settings first.")
            return
        }
        viewModelScope.launch {
            mutableState.update { it.copy(refreshing = true) }
            try {
                val statuses = withContext(Dispatchers.IO) { graph.offloadClient.recordings() }
                withContext(Dispatchers.IO) {
                    statuses.forEach { status ->
                        graph.library.updateJobStatus(status.recordingId, deviceBadge(status.status), status.webdavUrl, status.pages)
                    }
                }
            } catch (e: Exception) {
                showError(e.message ?: "Could not refresh send status.")
            } finally {
                mutableState.update { it.copy(refreshing = false) }
            }
        }
    }

    fun pair(code: String) {
        val trimmed = code.filter { it.isDigit() }
        if (trimmed.length != 6) {
            mutableState.update { it.copy(pairing = PairingUiState(busy = false, error = "Enter the 6-digit pairing code.")) }
            return
        }
        mutableState.update { it.copy(pairing = PairingUiState(busy = true, error = null)) }
        viewModelScope.launch {
            try {
                val result = withContext(Dispatchers.IO) { graph.offloadClient.pair(trimmed) }
                val app = getApplication<Application>()
                OffloadSettings.setToken(app, result.token)
                OffloadSettings.setServerName(app, result.serverName)
                mutableState.update { it.copy(pairing = PairingUiState(busy = false, serverName = result.serverName)) }
            } catch (e: Exception) {
                mutableState.update { it.copy(pairing = PairingUiState(busy = false, error = e.message ?: "Pairing failed.")) }
            }
        }
    }

    fun unpair() {
        val app = getApplication<Application>()
        OffloadSettings.clearToken(app)
        OffloadSettings.setServerName(app, "")
        mutableState.update { it.copy(pairing = null) }
    }

    /** Shows a published page in the in-app viewer; the device's browser is not used. */
    fun openPage(url: String) {
        val scheme = Uri.parse(url).scheme?.lowercase(Locale.ROOT)
        if (scheme != "https" && scheme != "http") { showError("Not a web link: $url"); return }
        graph.playback.stop()
        val current = state.value
        if (current.screen != Screen.VIEWER) viewerReturn = current.screen
        mutableState.update { it.copy(screen = Screen.VIEWER, viewerUrl = url, sendResult = null) }
    }

    /** Uploads hold the maintenance gate for their whole run, so updates and shutdown wait for them. */
    private fun startUpload(block: suspend () -> Unit) {
        uploadJob?.cancel()
        uploadJob = viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { withUploadGate { block() } }
            } catch (_: CancellationException) {
                // Job stays on the row so the next Send resumes.
            } catch (e: Exception) {
                showError(e.message ?: "Could not send recording.")
            } finally {
                mutableState.update { it.copy(upload = null) }
            }
        }
    }

    private fun notifySent(result: SendResult) {
        val app = getApplication<Application>()
        runCatching {
            val manager = app.getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(
                NotificationChannel(OFFLOAD_CHANNEL, "Desktop offload", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "Shown when a recording has been sent to the desktop server."
                }
            )
            val url = result.pages.primaryPage()?.url
            val text = if (url != null) "Sent. Your pages will appear at the link in a few minutes."
                else "Sent to the desktop server."
            val intent = Intent(app, com.chippwalters.r1cord.MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            if (url != null) intent.putExtra(com.chippwalters.r1cord.MainActivity.EXTRA_PAGE_URL, url)
            val pending = PendingIntent.getActivity(
                app,
                result.recordingId.hashCode(),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            manager.notify(
                OFFLOAD_NOTIFICATION_BASE + result.recordingId.hashCode(),
                Notification.Builder(app, OFFLOAD_CHANNEL)
                    .setSmallIcon(android.R.drawable.stat_sys_upload_done)
                    .setContentTitle("R1CORD")
                    .setContentText(text)
                    .setStyle(Notification.BigTextStyle().bigText(text))
                    .setContentIntent(pending)
                    .setAutoCancel(true)
                    .build(),
            )
        }
    }

    private fun hasPermission(permission: String) = ContextCompat.checkSelfPermission(getApplication(), permission) == PackageManager.PERMISSION_GRANTED

    companion object {
        private const val OFFLOAD_CHANNEL = "offload"
        private const val OFFLOAD_NOTIFICATION_BASE = 2000
    }
}

/**
 * Runs [block] as upload work under the maintenance gate: refused with a readable
 * IllegalStateException while maintenance is active, and always released afterwards,
 * including on failure and cancellation.
 */
internal suspend fun <T> withUploadGate(block: suspend () -> T): T {
    check(MaintenanceGate.tryBegin(MaintenanceGate.Work.UPLOAD)) { RecordingLibrary.MAINTENANCE_MESSAGE }
    try {
        return block()
    } finally {
        MaintenanceGate.end(MaintenanceGate.Work.UPLOAD)
    }
}
