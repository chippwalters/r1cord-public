package com.chippwalters.r1cord.recording

import android.content.Context

/**
 * Durable recorder preferences. Shares the existing "app_preferences" store used by
 * MainActivity for first-run media volume, so there is one preference file for the app.
 */
object RecorderSettings {
    private const val PREFS = "app_preferences"
    private const val KEY_NOISE_CANCELLATION = "noise_cancellation"
    private const val KEY_VOICE_ACTIVATED_PAUSING = "voice_activated_pausing"
    private const val KEY_VAD_SENSITIVITY = "vad_sensitivity"
    private const val KEY_WAV_OUTPUT = "wav_output"

    /** Measured AAC cost: 96 kbps plus MPEG-4 container overhead. */
    private const val AAC_BYTES_PER_SECOND = 13_000L
    /** 48 000 samples/s x 2 bytes, mono. The 44-byte header is noise at this scale. */
    private const val WAV_BYTES_PER_SECOND = 96_000L

    /** Sensitivity preset: quiet voices are kept, at the cost of tripping on noise. */
    const val SENSITIVITY_HIGH = 0
    /** Sensitivity preset: the default balance for hand-held dictation. */
    const val SENSITIVITY_BALANCED = 1
    /** Sensitivity preset: only clearly-above-the-room speech opens the gate. */
    const val SENSITIVITY_NOISE_REJECTING = 2

    /** Optional microphone noise suppression during capture. Default off: opt-in, HAL-dependent. */
    fun noiseCancellation(context: Context): Boolean =
        prefs(context).getBoolean(KEY_NOISE_CANCELLATION, false)

    fun setNoiseCancellation(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_NOISE_CANCELLATION, enabled).apply()
    }

    /**
     * Voice-activated pausing (VOX): silence is skipped instead of recorded. Default off.
     * Snapshotted by the engine when a session starts, so toggling mid-recording is ignored.
     */
    fun voiceActivatedPausing(context: Context): Boolean =
        prefs(context).getBoolean(KEY_VOICE_ACTIVATED_PAUSING, false)

    fun setVoiceActivatedPausing(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_VOICE_ACTIVATED_PAUSING, enabled).apply()
    }

    /**
     * Store uncompressed 48 kHz mono PCM16 WAV instead of AAC. Default off: WAV is about
     * 7.4x larger (96 000 B/s against roughly 13 000 B/s). Snapshotted at session start
     * like the VOX toggle, so the format cannot change mid-recording.
     */
    fun wavOutput(context: Context): Boolean =
        prefs(context).getBoolean(KEY_WAV_OUTPUT, false)

    fun setWavOutput(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_WAV_OUTPUT, enabled).apply()
    }

    /** Bytes per second each format writes; drives the Home remaining-time estimate. */
    fun bytesPerSecond(wav: Boolean): Long = if (wav) WAV_BYTES_PER_SECOND else AAC_BYTES_PER_SECOND

    /** Gate sensitivity, one of SENSITIVITY_HIGH / SENSITIVITY_BALANCED / SENSITIVITY_NOISE_REJECTING. */
    fun vadSensitivity(context: Context): Int =
        prefs(context).getInt(KEY_VAD_SENSITIVITY, SENSITIVITY_BALANCED)
            .coerceIn(SENSITIVITY_HIGH, SENSITIVITY_NOISE_REJECTING)

    fun setVadSensitivity(context: Context, level: Int) {
        prefs(context).edit()
            .putInt(KEY_VAD_SENSITIVITY, level.coerceIn(SENSITIVITY_HIGH, SENSITIVITY_NOISE_REJECTING))
            .apply()
    }

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
