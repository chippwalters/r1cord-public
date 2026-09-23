package com.chippwalters.r1cord.recording

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.media.AudioRecordingConfiguration
import android.media.MediaRecorder
import android.media.audiofx.NoiseSuppressor
import android.os.ParcelFileDescriptor
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.content.ContextCompat
import com.chippwalters.r1cord.model.CaptureState
import com.chippwalters.r1cord.model.CaptureStatus
import com.chippwalters.r1cord.storage.RecordingLibrary
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

class RecorderEngine(context: Context, private val library: RecordingLibrary) {
    private val context = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mutableState = MutableStateFlow(CaptureState())
    val state: StateFlow<CaptureState> = mutableState.asStateFlow()
    private val commands = Mutex()
    private var recorder: MediaRecorder? = null
    // Non-null only while a PCM session is running (voice-activated pausing, WAV output, or
    // both); the MediaRecorder path is unchanged and keeps `recorder`. Exactly one is active.
    private var pcm: PcmCaptureSession? = null
    // Whether the active PCM session is gating on speech, so an empty result can be explained.
    private var pcmGated = false
    private var descriptor: ParcelFileDescriptor? = null
    private var noiseSuppressor: NoiseSuppressor? = null
    private var ticker: Job? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var accumulatedMs = 0L
    private var segmentStarted = 0L
    private var lastCheckpoint = 0L
    private val envelope = ArrayList<Float>(2048)
    private var bucketSamples = 1
    private var bucketCount = 0
    private var bucketPeak = 0f
    internal var onIdle: (() -> Unit)? = null

    fun start() {
        if (state.value.status != CaptureStatus.IDLE) return
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            mutableState.value = CaptureState(error = "Microphone permission is required to record.")
            return
        }
        mutableState.value = CaptureState(status = CaptureStatus.STARTING)
        send(RecordingService.START, foreground = true)
    }
    fun pause() { if (state.value.status == CaptureStatus.RECORDING || state.value.status == CaptureStatus.AUTO_LISTENING) send(RecordingService.PAUSE) }
    fun resume() { if (state.value.status == CaptureStatus.PAUSED) send(RecordingService.RESUME) }
    fun stop() { if (state.value.status != CaptureStatus.IDLE) send(RecordingService.STOP) }
    fun clearError() { mutableState.value = state.value.copy(error = null) }

    private fun send(action: String, foreground: Boolean = false) {
        try {
            val intent = Intent(context, RecordingService::class.java).setAction(action)
            if (foreground) ContextCompat.startForegroundService(context, intent) else context.startService(intent)
        } catch (error: Exception) {
            if (foreground) mutableState.value = CaptureState(error = "Could not start microphone service: ${error.message}")
            else scope.launch { commands.withLock { finish("Recorder service command failed: ${error.message}") } }
        }
    }

    internal fun handle(action: String) {
        scope.launch {
            commands.withLock {
                try {
                    when (action) {
                        RecordingService.START -> if (recorder == null && pcm == null && state.value.status == CaptureStatus.STARTING) begin()
                        RecordingService.PAUSE -> if (state.value.status == CaptureStatus.RECORDING || state.value.status == CaptureStatus.AUTO_LISTENING) pauseCapture()
                        RecordingService.RESUME -> if (state.value.status == CaptureStatus.PAUSED) resumeCapture()
                        RecordingService.STOP -> if (state.value.status != CaptureStatus.IDLE) finish()
                    }
                } catch (error: Exception) { finish("Recording failed: ${error.message ?: error.javaClass.simpleName}") }
                if (state.value.status == CaptureStatus.IDLE) onIdle?.invoke()
            }
        }
    }

    internal fun serviceFailed(message: String, source: MediaRecorder? = null) {
        scope.launch {
            commands.withLock {
                if (state.value.status == CaptureStatus.IDLE || (source != null && source !== recorder)) return@withLock
                finish(message)
                onIdle?.invoke()
            }
        }
    }

    internal fun serviceDestroyed() {
        onIdle = null
        if (state.value.status != CaptureStatus.IDLE) {
            scope.launch { commands.withLock { finish("Recording service was interrupted.") } }
        }
    }

    private suspend fun begin() {
        accumulatedMs = 0
        envelope.clear()
        bucketCount = 0
        bucketPeak = 0f
        check(ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) { "Microphone permission was denied." }
        check(library.hasRecordingSpace()) { "Storage is full. At least 64 MiB must remain free." }
        val wav = RecorderSettings.wavOutput(context)
        val target = library.begin(wav)
        mutableState.value = state.value.copy(recordingId = target.id)
        descriptor = withContext(Dispatchers.IO) {
            context.contentResolver.openFileDescriptor(target.uri, "rw") ?: error("Cannot open audio output.")
        }
        envelope.clear()
        bucketSamples = 1
        bucketCount = 0
        bucketPeak = 0f
        accumulatedMs = 0
        lastCheckpoint = 0
        val noiseCancel = RecorderSettings.noiseCancellation(context)
        // Snapshot the voice-activated preferences here: the capture mode and the gate
        // sensitivity are fixed for the whole session, so toggling mid-recording is ignored.
        val voiceActivated = RecorderSettings.voiceActivatedPausing(context)
        val source = if (noiseCancel && !NoiseSuppressor.isAvailable()) MediaRecorder.AudioSource.VOICE_COMMUNICATION else MediaRecorder.AudioSource.MIC
        if (voiceActivated || wav) {
            // MediaRecorder can neither auto-resume (it yields no data while paused) nor emit
            // WAV, so both options run the app-owned PCM path. Plain AAC keeps MediaRecorder.
            val session = PcmCaptureSession(
                output = descriptor!!.fileDescriptor,
                audioSource = source,
                noiseCancellation = noiseCancel,
                sensitivity = RecorderSettings.vadSensitivity(context),
                voiceActivated = voiceActivated,
                wav = wav,
            )
            withContext(Dispatchers.IO) { session.start() }
            pcmGated = voiceActivated
            pcm = session
        } else {
            val mediaRecorder = MediaRecorder(context)
            recorder = mediaRecorder
            mediaRecorder.setOnErrorListener { _, what, extra -> serviceFailed("Microphone/encoder error ($what/$extra). Audio may be interrupted.", mediaRecorder) }
            mediaRecorder.setOnInfoListener { _, what, _ ->
                if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED) serviceFailed("Recording reached the safe storage limit.", mediaRecorder)
            }
            mediaRecorder.registerAudioRecordingCallback(context.mainExecutor, object : AudioManager.AudioRecordingCallback() {
                override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
                    if (configs.any { it.isClientSilenced }) serviceFailed("Microphone is in use by another app or microphone access was disabled.", mediaRecorder)
                    if (noiseCancel) attachNoiseSuppressor()
                }
            })
            withContext(Dispatchers.IO) {
                mediaRecorder.setAudioSource(source)
                mediaRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                mediaRecorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                mediaRecorder.setAudioChannels(1)
                mediaRecorder.setAudioSamplingRate(48000)
                mediaRecorder.setAudioEncodingBitRate(96000)
                mediaRecorder.setOutputFile(descriptor!!.fileDescriptor)
                mediaRecorder.prepare()
                mediaRecorder.start()
                if (noiseCancel) attachNoiseSuppressor()
            }
        }
        segmentStarted = SystemClock.elapsedRealtime()
        wakeLock = (context.getSystemService(Context.POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "r1cord:recording").apply { acquire() }
        library.captureStatus(target.id, "RECORDING")
        mutableState.value = state.value.copy(status = CaptureStatus.RECORDING)
        ticker = scope.launch {
            while (true) {
                delay(100)
                commands.withLock {
                    try {
                        val current = state.value
                        val session = pcm
                        if (session != null) {
                            val problem = session.failure
                            if (problem != null) {
                                finish(problem)
                                onIdle?.invoke()
                                return@launch
                            }
                            val sample = session.sample()
                            if (current.status == CaptureStatus.RECORDING || current.status == CaptureStatus.AUTO_LISTENING) {
                                // Envelope and clock advance with committed audio only; the meter
                                // keeps showing the live level so a gated session looks alive.
                                if (sample.committedFrames > 0) appendPeak(sample.committedPeak)
                                accumulatedMs = sample.committedMs
                                mutableState.value = current.copy(
                                    status = if (sample.gated) CaptureStatus.AUTO_LISTENING else CaptureStatus.RECORDING,
                                    elapsedMs = accumulatedMs,
                                    level = sample.level,
                                )
                            }
                        } else if (current.status == CaptureStatus.RECORDING) {
                            val peak = ((recorder?.maxAmplitude ?: 0) / 32767f).coerceIn(0f, 1f)
                            appendPeak(peak)
                            mutableState.value = current.copy(elapsedMs = elapsed(), level = peak)
                        }
                        if (!library.hasRecordingSpace()) {
                            finish("Recording stopped before storage ran out; reserve space was preserved.", salvage = true)
                            onIdle?.invoke()
                            return@launch
                        }
                        if (SystemClock.elapsedRealtime() - lastCheckpoint >= 5000) {
                            current.recordingId?.let { library.checkpoint(it, elapsed(), waveform()) }
                            lastCheckpoint = SystemClock.elapsedRealtime()
                        }
                    } catch (error: Exception) {
                        finish("Recording interrupted: ${error.message}")
                        onIdle?.invoke()
                        return@launch
                    }
                }
            }
        }
    }

    private suspend fun pauseCapture() {
        val session = pcm
        if (session != null) {
            session.setUserPaused(true)
            session.sample()
            accumulatedMs = session.committedMs
        } else {
            withContext(Dispatchers.IO) { recorder!!.pause() }
            accumulatedMs += SystemClock.elapsedRealtime() - segmentStarted
        }
        mutableState.value = state.value.copy(status = CaptureStatus.PAUSED, elapsedMs = accumulatedMs, level = 0f)
        library.captureStatus(state.value.recordingId!!, "PAUSED")
        library.checkpoint(state.value.recordingId!!, accumulatedMs, waveform())
    }

    private suspend fun resumeCapture() {
        check(library.hasRecordingSpace()) { "Not enough free storage to resume." }
        val session = pcm
        if (session != null) session.setUserPaused(false)
        else withContext(Dispatchers.IO) { recorder!!.resume() }
        segmentStarted = SystemClock.elapsedRealtime()
        mutableState.value = state.value.copy(status = CaptureStatus.RECORDING)
        library.captureStatus(state.value.recordingId!!, "RECORDING")
    }

    /**
     * Best-effort microphone noise suppression on the active capture session (opt-in).
     * MediaRecorder exposes no getAudioSessionId(); the session id is read from the active
     * recording configuration once capture is running. HAL/vendor dependent, so this is a
     * silent best-effort: if the effect is unavailable the recording proceeds unfiltered.
     * When the standalone effect is unavailable, begin() instead selects the
     * VOICE_COMMUNICATION source so the platform pre-processor can suppress noise.
     */
    private fun attachNoiseSuppressor() {
        if (noiseSuppressor != null || !NoiseSuppressor.isAvailable()) return
        val sessionId = recorder?.activeRecordingConfiguration?.clientAudioSessionId ?: return
        noiseSuppressor = runCatching { NoiseSuppressor.create(sessionId)?.apply { enabled = true } }.getOrNull()
    }

    // The PCM path counts committed audio only (silence skipped by the gate is genuinely
    // absent from the file), so its clock is the sample count the ticker last read.
    private fun elapsed(): Long = if (pcm != null) accumulatedMs
        else accumulatedMs + if (state.value.status == CaptureStatus.RECORDING) SystemClock.elapsedRealtime() - segmentStarted else 0L

    private suspend fun finish(reason: String? = null, salvage: Boolean = false) {
        val before = state.value
        val id = before.recordingId
        var duration = elapsed()
        mutableState.value = before.copy(status = CaptureStatus.STOPPING, level = 0f)
        // A ticker may be the caller: detach it, then cancel after finalization, not during a suspend write.
        val oldTicker = ticker
        ticker = null
        var failure = if (salvage) null else reason
        val activeRecorder = recorder
        val activeSession = pcm
        recorder = null
        pcm = null
        withContext(Dispatchers.IO) {
            try {
                if (activeSession != null) {
                    val outcome = activeSession.stop()
                    duration = outcome.committedMs
                    failure = failure ?: outcome.failure
                    // A gated session that never heard speech has nothing to publish: report it
                    // through the existing failure path instead of saving a zero-length file.
                    if (outcome.committedMs <= 0L) failure = failure ?: if (pcmGated)
                        "No speech was captured, so there is no audio to save."
                    else "No audio was captured, so there is nothing to save."
                } else {
                    activeRecorder?.stop()
                }
                descriptor?.fileDescriptor?.sync()
            } catch (error: Exception) { failure = failure ?: "Audio could not be finalized: ${error.message}" }
            finally {
                runCatching { noiseSuppressor?.release() }
                noiseSuppressor = null
                runCatching { activeRecorder?.reset() }
                runCatching { activeRecorder?.release() }
                runCatching { descriptor?.close() }
                descriptor = null
            }
        }
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        var saved = false
        if (id != null) {
            try { saved = library.finish(id, duration, waveform(), failure) }
            catch (error: Exception) { failure = failure ?: "Could not save recording metadata: ${error.message}" }
        }
        mutableState.value = CaptureState(elapsedMs = duration, error = reason ?: failure ?: if (id != null && !saved) "Audio was interrupted or could not be published. Check the library." else null, lastCompletedId = if (saved) id else null)
        oldTicker?.cancel()
    }

    private fun appendPeak(peak: Float) {
        bucketPeak = maxOf(bucketPeak, peak)
        bucketCount++
        if (bucketCount >= bucketSamples) {
            envelope.add(bucketPeak)
            bucketPeak = 0f
            bucketCount = 0
            if (envelope.size >= 2048) {
                for (index in 0 until 1024) envelope[index] = maxOf(envelope[index * 2], envelope[index * 2 + 1])
                envelope.subList(1024, envelope.size).clear()
                bucketSamples *= 2
            }
        }
    }

    private fun waveform(): List<Float> = if (bucketCount > 0) envelope + bucketPeak else envelope.toList()
}
