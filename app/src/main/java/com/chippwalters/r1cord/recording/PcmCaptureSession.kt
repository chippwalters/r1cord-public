package com.chippwalters.r1cord.recording

import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRecordingConfiguration
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.media.audiofx.NoiseSuppressor
import android.os.Process
import java.io.FileDescriptor
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import kotlin.math.log10
import kotlin.math.sqrt

/**
 * Raw-PCM capture path: AudioRecord (48 kHz mono PCM16) -> optional energy VAD gate ->
 * either a MediaCodec AAC-LC encoder plus MediaMuxer (MP4), or a direct RIFF/WAVE writer,
 * writing into the MediaStore pending file descriptor owned by [RecorderEngine].
 *
 * MediaRecorder can auto-pause but never auto-resume (it yields no data while paused), so
 * voice-activated pausing needs raw frames. Silence is simply never queued to the encoder,
 * and every presentation timestamp is derived from the committed sample count, so the
 * output is one contiguous file whose duration equals the audio actually kept.
 *
 * Threading: everything except [start], [stop], [setUserPaused] and [sample] runs on the
 * single capture thread. Cross-thread fields are volatile; the meter accumulator is behind
 * a short lock. The file descriptor is borrowed, never closed here.
 */
internal class PcmCaptureSession(
    private val output: FileDescriptor,
    private val audioSource: Int,
    private val noiseCancellation: Boolean,
    sensitivity: Int,
    /** False when this path was chosen only for WAV output: every frame is committed. */
    private val voiceActivated: Boolean = true,
    /** Write uncompressed PCM16 WAV instead of running the AAC encoder and MP4 muxer. */
    private val wav: Boolean = false,
) {
    /** One 100 ms window of meter/progress data, consumed and reset by the engine ticker. */
    data class Sample(
        val level: Float,
        val committedPeak: Float,
        val committedFrames: Int,
        val gated: Boolean,
        val committedMs: Long,
    )

    /** Result of a finished session: committed audio length and the first fatal problem, if any. */
    data class Outcome(val committedMs: Long, val failure: String?)

    private val gate = VoiceGate(sensitivity)
    private val frame = ByteArray(FRAME_BYTES)
    // Native-order view over `frame`: endianness-correct sample reads with no per-frame allocation.
    private val frameSamples = ByteBuffer.wrap(frame).order(ByteOrder.nativeOrder()).asShortBuffer()
    private val preRoll = Array(PRE_ROLL_FRAMES) { ByteArray(FRAME_BYTES) }
    private var preRollHead = 0
    private var preRollCount = 0
    private val bufferInfo = MediaCodec.BufferInfo()

    private var record: AudioRecord? = null
    private var codec: MediaCodec? = null
    private var muxer: MediaMuxer? = null
    private var wavWriter: WavWriter? = null
    private var suppressor: NoiseSuppressor? = null
    private var silenceWatch: AudioManager.AudioRecordingCallback? = null
    private var trackIndex = -1
    private var muxerStarted = false
    private var muxerStopped = false
    private var worker: Thread? = null
    private val finished = CountDownLatch(1)

    @Volatile private var stopRequested = false
    @Volatile private var userPaused = false
    @Volatile private var committedSamples = 0L
    @Volatile private var gatedNow = false
    @Volatile var failure: String? = null
        private set

    private val meterLock = Any()
    private var pendingLevel = 0f
    private var pendingCommittedPeak = 0f
    private var pendingCommittedFrames = 0

    /** Audio committed so far, in milliseconds. Derived from samples, so it excludes skipped silence. */
    val committedMs: Long get() = committedSamples * 1_000L / SAMPLE_RATE

    /**
     * Opens the microphone, encoder and muxer and starts the capture thread. Throws if any
     * stage fails, having already released whatever was opened. RECORD_AUDIO is verified by
     * the ViewModel before the service is started, which lint cannot see from here.
     */
    @android.annotation.SuppressLint("MissingPermission")
    fun start() {
        try {
            val minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            check(minBuffer > 0) { "Microphone does not support 48 kHz mono capture." }
            val audioRecord = AudioRecord.Builder()
                .setAudioSource(audioSource)
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(SAMPLE_RATE)
                        .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                        .build()
                )
                .setBufferSizeInBytes(maxOf(minBuffer * 4, FRAME_BYTES * 25))
                .build()
            record = audioRecord
            check(audioRecord.state == AudioRecord.STATE_INITIALIZED) { "Microphone could not be opened." }
            if (noiseCancellation && NoiseSuppressor.isAvailable()) {
                suppressor = runCatching { NoiseSuppressor.create(audioRecord.audioSessionId)?.apply { enabled = true } }.getOrNull()
            }
            val sessionId = audioRecord.audioSessionId
            val watch = object : AudioManager.AudioRecordingCallback() {
                override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
                    if (configs.any { it.clientAudioSessionId == sessionId && it.isClientSilenced }) {
                        reportFailure("Microphone is in use by another app or microphone access was disabled.")
                    }
                }
            }
            silenceWatch = watch
            audioRecord.registerAudioRecordingCallback(Executor { it.run() }, watch)

            if (wav) {
                // No encoder and no muxer: committed frames go straight out as PCM16.
                wavWriter = WavWriter(output).apply { open() }
            } else {
                val encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
                codec = encoder
                encoder.configure(
                    MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, SAMPLE_RATE, 1).apply {
                        setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                        setInteger(MediaFormat.KEY_BIT_RATE, BIT_RATE)
                        setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, MAX_INPUT_SIZE)
                    },
                    null, null, MediaCodec.CONFIGURE_FLAG_ENCODE,
                )
                encoder.start()

                muxer = MediaMuxer(output, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            }

            audioRecord.startRecording()
            check(audioRecord.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "Microphone could not be started; it may be in use by another app." }

            val thread = Thread({ loop() }, "r1cord-pcm")
            worker = thread
            thread.start()
        } catch (error: Throwable) {
            release()
            throw error
        }
    }

    /** A manual pause is authoritative: nothing is committed and speech cannot resume it. */
    fun setUserPaused(paused: Boolean) { userPaused = paused }

    /** Consumes the meter/progress window accumulated since the previous call. */
    fun sample(): Sample {
        var level = 0f
        var committedPeak = 0f
        var committedFrames = 0
        synchronized(meterLock) {
            level = pendingLevel
            committedPeak = pendingCommittedPeak
            committedFrames = pendingCommittedFrames
            pendingLevel = 0f
            pendingCommittedPeak = 0f
            pendingCommittedFrames = 0
        }
        return Sample(level, committedPeak, committedFrames, gatedNow && !userPaused, committedMs)
    }

    /**
     * Stops capture, flushes the encoder and finalizes the container. Safe to call once;
     * later calls return the same outcome.
     */
    fun stop(): Outcome {
        stopRequested = true
        val thread = worker
        if (thread == null) {
            release()
        } else {
            worker = null
            if (!finished.await(STOP_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                // The capture thread owns every codec handle; releasing it from here would race.
                // Report the truncation truthfully and let its `finally` clean up when it returns.
                if (failure == null) failure = "Audio encoder did not stop in time; the end of the recording may be missing."
                runCatching { thread.interrupt() }
            }
        }
        return Outcome(committedMs, failure)
    }

    private fun reportFailure(message: String) {
        if (failure == null) failure = message
    }

    private fun loop() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        try {
            capture()
        } catch (error: Throwable) {
            reportFailure(error.message ?: error.javaClass.simpleName)
        } finally {
            try { finalizeOutput() } catch (error: Throwable) { reportFailure("Audio could not be finalized: ${error.message}") }
            release()
            finished.countDown()
        }
    }

    private fun capture() {
        val audioRecord = record ?: return
        while (!stopRequested) {
            var filled = 0
            while (filled < FRAME_BYTES) {
                if (stopRequested) return
                val read = audioRecord.read(frame, filled, FRAME_BYTES - filled)
                when {
                    read > 0 -> filled += read
                    read == 0 -> Thread.sleep(2)
                    read == AudioRecord.ERROR_DEAD_OBJECT -> error("Microphone session was lost.")
                    read == AudioRecord.ERROR_INVALID_OPERATION -> error("Microphone stopped delivering audio.")
                    else -> error("Microphone read failed ($read).")
                }
            }
            processFrame()
        }
    }

    private fun processFrame() {
        var peakRaw = 0
        var energy = 0.0
        for (index in 0 until FRAME_SAMPLES) {
            val value = frameSamples.get(index).toInt()
            val magnitude = if (value < 0) -value else value
            if (magnitude > peakRaw) peakRaw = magnitude
            energy += (value * value).toDouble()
        }
        val peak = (peakRaw / 32768f).coerceIn(0f, 1f)
        val rms = sqrt(energy / FRAME_SAMPLES)
        val db = if (rms < 1.0) SILENT_DB else (20.0 * log10(rms / 32768.0)).toFloat()

        val decision = when {
            userPaused -> {
                // Keep the gate primed so the first frame after a manual resume is kept.
                gate.prime()
                Decision.DISCARD
            }
            // WAV-only sessions run this path for its raw frames, not for gating.
            !voiceActivated -> Decision.COMMIT
            else -> gate.evaluate(db)
        }
        var committed = false
        when (decision) {
            Decision.COMMIT_WITH_PRE_ROLL -> { flushPreRoll(); queue(frame, FRAME_BYTES); committed = true }
            Decision.COMMIT -> { preRollHead = 0; preRollCount = 0; queue(frame, FRAME_BYTES); committed = true }
            Decision.HOLD -> pushPreRoll()
            Decision.DISCARD -> { preRollHead = 0; preRollCount = 0 }
        }
        drainEncoder(false)
        gatedNow = voiceActivated && gate.isGated
        synchronized(meterLock) {
            if (peak > pendingLevel) pendingLevel = peak
            if (committed) {
                pendingCommittedFrames++
                if (peak > pendingCommittedPeak) pendingCommittedPeak = peak
            }
        }
    }

    private fun pushPreRoll() {
        if (preRollCount < PRE_ROLL_FRAMES) {
            System.arraycopy(frame, 0, preRoll[(preRollHead + preRollCount) % PRE_ROLL_FRAMES], 0, FRAME_BYTES)
            preRollCount++
        } else {
            System.arraycopy(frame, 0, preRoll[preRollHead], 0, FRAME_BYTES)
            preRollHead = (preRollHead + 1) % PRE_ROLL_FRAMES
        }
    }

    /**
     * Commits the buffered lead-in so a word onset is never clipped. The ring only ever holds
     * frames that were skipped, so flushing can neither duplicate nor reorder committed audio.
     */
    private fun flushPreRoll() {
        var index = 0
        while (index < preRollCount) {
            queue(preRoll[(preRollHead + index) % PRE_ROLL_FRAMES], FRAME_BYTES)
            index++
        }
        preRollHead = 0
        preRollCount = 0
    }

    private fun queue(data: ByteArray, length: Int) {
        val pcm = wavWriter
        if (pcm != null) {
            // RIFF stores its data size in 32 bits, so the container cannot exceed 4 GiB
            // (about 12.4 hours here). Stop truthfully rather than write a corrupt header.
            check(committedSamples * 2 + length <= WAV_MAX_DATA_BYTES) {
                "WAV recording reached the 4 GiB file limit."
            }
            pcm.write(data, length)
            committedSamples += (length / 2).toLong()
            return
        }
        val encoder = codec ?: return
        var offset = 0
        var stalls = 0
        while (offset < length) {
            val index = encoder.dequeueInputBuffer(INPUT_TIMEOUT_US)
            if (index < 0) {
                drainEncoder(false)
                if (++stalls > MAX_STALLS) error("Audio encoder stopped accepting input.")
                continue
            }
            val buffer = encoder.getInputBuffer(index)
            if (buffer == null) {
                encoder.queueInputBuffer(index, 0, 0, presentationTimeUs(), 0)
                if (++stalls > MAX_STALLS) error("Audio encoder stopped accepting input.")
                continue
            }
            stalls = 0
            buffer.clear()
            val chunk = minOf(buffer.remaining(), length - offset)
            buffer.put(data, offset, chunk)
            encoder.queueInputBuffer(index, 0, chunk, presentationTimeUs(), 0)
            committedSamples += (chunk / 2).toLong()
            offset += chunk
        }
    }

    /** Timeline position of the next committed sample: skipped silence never advances it. */
    private fun presentationTimeUs(): Long = committedSamples * 1_000_000L / SAMPLE_RATE

    private fun drainEncoder(endOfStream: Boolean) {
        val encoder = codec ?: return
        val sink = muxer ?: return
        val deadline = System.nanoTime() + DRAIN_TIMEOUT_NS
        while (true) {
            val index = encoder.dequeueOutputBuffer(bufferInfo, if (endOfStream) OUTPUT_TIMEOUT_US else 0L)
            if (index == MediaCodec.INFO_TRY_AGAIN_LATER) {
                if (!endOfStream) return
                if (System.nanoTime() > deadline) error("Audio encoder did not finish flushing.")
                continue
            }
            if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                if (!muxerStarted) {
                    trackIndex = sink.addTrack(encoder.outputFormat)
                    sink.start()
                    muxerStarted = true
                }
                continue
            }
            if (index < 0) continue
            val payload = encoder.getOutputBuffer(index)
            if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) bufferInfo.size = 0
            if (bufferInfo.size > 0 && payload != null && muxerStarted) {
                payload.position(bufferInfo.offset)
                payload.limit(bufferInfo.offset + bufferInfo.size)
                sink.writeSampleData(trackIndex, payload, bufferInfo)
            }
            encoder.releaseOutputBuffer(index, false)
            if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
        }
    }

    /** Finalizes whichever sink is active: patch the RIFF sizes, or drain the AAC encoder. */
    private fun finalizeOutput() {
        val pcm = wavWriter
        if (pcm != null) pcm.finish(committedSamples * 2) else flushEncoder()
    }

    /**
     * Signals end-of-stream and drains the remaining AAC frames. With nothing committed the
     * muxer is deliberately never started, so no zero-length track is published.
     */
    private fun flushEncoder() {
        val encoder = codec ?: return
        if (muxer == null || committedSamples == 0L) return
        var stalls = 0
        while (true) {
            val index = encoder.dequeueInputBuffer(INPUT_TIMEOUT_US)
            if (index >= 0) {
                encoder.queueInputBuffer(index, 0, 0, presentationTimeUs(), MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                break
            }
            drainEncoder(false)
            if (++stalls > MAX_STALLS) return
        }
        drainEncoder(true)
    }

    /** Releases every handle exactly once. The borrowed file descriptor is left to the engine. */
    private fun release() {
        val audioRecord = record
        val encoder = codec
        val sink = muxer
        val effect = suppressor
        val watch = silenceWatch
        record = null
        codec = null
        muxer = null
        suppressor = null
        silenceWatch = null
        runCatching { wavWriter?.flush() }
        wavWriter = null
        if (audioRecord != null) {
            if (watch != null) runCatching { audioRecord.unregisterAudioRecordingCallback(watch) }
            runCatching { if (audioRecord.state == AudioRecord.STATE_INITIALIZED) audioRecord.stop() }
        }
        runCatching { effect?.release() }
        runCatching { audioRecord?.release() }
        runCatching { encoder?.stop() }
        runCatching { encoder?.release() }
        if (sink != null) {
            if (muxerStarted && !muxerStopped) {
                muxerStopped = true
                runCatching { sink.stop() }.onFailure { reportFailure("Audio container could not be finalized: ${it.message}") }
            }
            runCatching { sink.release() }
        }
    }
}

/**
 * Minimal RIFF/WAVE writer for 48 kHz mono PCM16, streaming into the MediaStore pending
 * descriptor the engine owns. The header is written up front with placeholder sizes and
 * patched at [finish], which needs a seekable descriptor — the engine opens it "rw".
 *
 * AudioRecord delivers native-order samples and every supported device here is
 * little-endian, which is also RIFF's byte order, so frames are written verbatim.
 *
 * The descriptor is borrowed: this never closes it, matching the muxer path.
 */
private class WavWriter(descriptor: FileDescriptor) {
    private val stream = FileOutputStream(descriptor)
    private val channel = stream.channel

    fun open() {
        runCatching { channel.truncate(0L) }
        channel.position(0L)
        writeHeader(0L)
        channel.position(WAV_HEADER_BYTES.toLong())
    }

    fun write(data: ByteArray, length: Int) = stream.write(data, 0, length)

    /** Rewrites the two length fields now that the audio size is known, then flushes. */
    fun finish(dataBytes: Long) {
        stream.flush()
        writeHeader(dataBytes)
    }

    fun flush() = stream.flush()

    private fun writeHeader(dataBytes: Long) {
        val header = ByteBuffer.allocate(WAV_HEADER_BYTES).order(ByteOrder.LITTLE_ENDIAN)
        val byteRate = SAMPLE_RATE * 2
        header.put("RIFF".toByteArray(Charsets.US_ASCII))
        header.putInt((WAV_HEADER_BYTES - 8 + dataBytes).toInt())
        header.put("WAVE".toByteArray(Charsets.US_ASCII))
        header.put("fmt ".toByteArray(Charsets.US_ASCII))
        header.putInt(16)                 // PCM chunk size
        header.putShort(1)                // format: PCM
        header.putShort(1)                // channels: mono
        header.putInt(SAMPLE_RATE)
        header.putInt(byteRate)
        header.putShort(2)                // block align: one 16-bit mono sample
        header.putShort(16)               // bits per sample
        header.put("data".toByteArray(Charsets.US_ASCII))
        header.putInt(dataBytes.toInt())
        header.flip()
        // Absolute write: leaves the append position of `stream` untouched.
        while (header.hasRemaining()) channel.write(header, (WAV_HEADER_BYTES - header.remaining()).toLong())
    }
}

private enum class Decision {
    /** Keep this frame. */
    COMMIT,

    /** Keep the buffered lead-in, then this frame. */
    COMMIT_WITH_PRE_ROLL,

    /** Skip, but remember the frame as possible lead-in. */
    HOLD,

    /** Skip and forget: the user paused. */
    DISCARD,
}

private enum class Phase {
    /** Speech: frames are committed. */
    ACTIVE,

    /** Post-roll spent, hangover not expired: a single loud frame resumes immediately. */
    ARMED,

    /** Silence skipped; re-entry needs confirmed speech. */
    GATED,
}

/**
 * Energy VAD: per-frame RMS in dBFS against an adaptive noise floor, with hysteresis,
 * confirmation voting, a hangover and a minimum active hold. Pure Kotlin by design - the
 * recorder ships no native code - and allocation-free once constructed.
 */
private class VoiceGate(sensitivity: Int) {
    private val level = sensitivity.coerceIn(0, START_OFFSET_DB.size - 1)
    private var noiseFloorDb = INITIAL_NOISE_FLOOR_DB
    private val recent = BooleanArray(CONFIRM_WINDOW)
    private var recentIndex = 0
    private var positives = 0
    private var phase = Phase.ACTIVE
    private var silenceMs = 0
    private var activeHoldMs = MIN_ACTIVE_HOLD_MS

    /** True only while silence is actually being skipped (drives CaptureStatus.AUTO_LISTENING). */
    val isGated: Boolean get() = phase == Phase.GATED

    /** Forces the committing state, used so a manual resume records from the first frame. */
    fun prime() {
        phase = Phase.ACTIVE
        silenceMs = 0
        activeHoldMs = MIN_ACTIVE_HOLD_MS
        clearVotes()
    }

    fun evaluate(db: Float): Decision {
        val startDb = maxOf(noiseFloorDb + START_OFFSET_DB[level], START_FLOOR_DB[level])
        val continueDb = maxOf(noiseFloorDb + CONTINUE_OFFSET_DB[level], CONTINUE_FLOOR_DB[level])
        return when (phase) {
            Phase.ACTIVE -> {
                if (activeHoldMs > 0) activeHoldMs -= FRAME_MS
                if (db > continueDb || activeHoldMs > 0) {
                    silenceMs = 0
                    Decision.COMMIT
                } else {
                    silenceMs += FRAME_MS
                    if (silenceMs <= POST_ROLL_MS) {
                        Decision.COMMIT
                    } else {
                        phase = Phase.ARMED
                        Decision.HOLD
                    }
                }
            }
            Phase.ARMED -> {
                silenceMs += FRAME_MS
                when {
                    db > continueDb -> { resume(); Decision.COMMIT_WITH_PRE_ROLL }
                    silenceMs >= HANG_MS -> { phase = Phase.GATED; clearVotes(); Decision.HOLD }
                    else -> Decision.HOLD
                }
            }
            Phase.GATED -> {
                val positive = db > startDb
                vote(positive)
                // The floor only tracks frames the gate rejected, and never while speech is live.
                if (!positive) adapt(db)
                if (positives >= CONFIRM_POSITIVES) {
                    resume()
                    Decision.COMMIT_WITH_PRE_ROLL
                } else {
                    Decision.HOLD
                }
            }
        }
    }

    private fun resume() {
        phase = Phase.ACTIVE
        silenceMs = 0
        activeHoldMs = MIN_ACTIVE_HOLD_MS
        clearVotes()
    }

    private fun adapt(db: Float) {
        val alpha = if (db < noiseFloorDb) NOISE_FALL_ALPHA else NOISE_RISE_ALPHA
        noiseFloorDb = (noiseFloorDb + (db - noiseFloorDb) * alpha).coerceIn(NOISE_FLOOR_MIN_DB, NOISE_FLOOR_MAX_DB)
    }

    private fun vote(positive: Boolean) {
        if (recent[recentIndex]) positives--
        recent[recentIndex] = positive
        if (positive) positives++
        recentIndex = (recentIndex + 1) % CONFIRM_WINDOW
    }

    private fun clearVotes() {
        recent.fill(false)
        recentIndex = 0
        positives = 0
    }
}

// --- Capture format -------------------------------------------------------------------
private const val SAMPLE_RATE = 48_000
private const val FRAME_MS = 20
private const val FRAME_SAMPLES = SAMPLE_RATE / 1_000 * FRAME_MS
private const val FRAME_BYTES = FRAME_SAMPLES * 2
private const val BIT_RATE = 96_000
private const val MAX_INPUT_SIZE = 16_384
private const val WAV_HEADER_BYTES = 44
/** RIFF's 32-bit data size, minus the header: about 12.4 hours of 48 kHz mono PCM16. */
private const val WAV_MAX_DATA_BYTES = 0xFFFF_FFFFL - WAV_HEADER_BYTES
private const val SILENT_DB = -96f

// --- VAD timing (tunable) ------------------------------------------------------------
/** Lead-in kept while gated and prepended on resume, so word onsets survive. */
private const val PRE_ROLL_MS = 300
private const val PRE_ROLL_FRAMES = PRE_ROLL_MS / FRAME_MS
/** Silence still committed after speech ends, so trailing consonants survive. */
private const val POST_ROLL_MS = 200
/** Continuous silence before the gate fully closes and AUTO_LISTENING is reported. */
private const val HANG_MS = 2_000
/** Committing is held this long after every resume, to stop the gate chattering. */
private const val MIN_ACTIVE_HOLD_MS = 500
private const val CONFIRM_WINDOW = 5
private const val CONFIRM_POSITIVES = 3

// --- VAD thresholds by sensitivity: 0 = high, 1 = balanced, 2 = noise-rejecting -------
// Starting calibration values, not measured R1 microphone thresholds: tune here.
private val START_OFFSET_DB = floatArrayOf(6f, 10f, 14f)
private val START_FLOOR_DB = floatArrayOf(-50f, -45f, -38f)
private val CONTINUE_OFFSET_DB = floatArrayOf(3f, 6f, 10f)
private val CONTINUE_FLOOR_DB = floatArrayOf(-54f, -50f, -44f)
private const val INITIAL_NOISE_FLOOR_DB = -60f
private const val NOISE_FLOOR_MIN_DB = -90f
private const val NOISE_FLOOR_MAX_DB = -25f
private const val NOISE_RISE_ALPHA = 0.02f
private const val NOISE_FALL_ALPHA = 0.10f

// --- Codec plumbing -------------------------------------------------------------------
private const val INPUT_TIMEOUT_US = 10_000L
private const val OUTPUT_TIMEOUT_US = 10_000L
private const val MAX_STALLS = 200
private const val DRAIN_TIMEOUT_NS = 3_000_000_000L
private const val STOP_TIMEOUT_MS = 5_000L
