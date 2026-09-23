package com.chippwalters.r1cord.recording

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Recorder defaults, persistence and clamping in the shared app_preferences store. */
@RunWith(RobolectricTestRunner::class)
class RecorderSettingsTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()

    @Test
    fun freshInstallSeesEveryOptionalFeatureOffAndBalancedSensitivity() {
        assertFalse(RecorderSettings.noiseCancellation(context))
        assertFalse(RecorderSettings.voiceActivatedPausing(context))
        assertFalse(RecorderSettings.wavOutput(context))
        assertEquals(RecorderSettings.SENSITIVITY_BALANCED, RecorderSettings.vadSensitivity(context))
    }

    @Test
    fun togglesPersistThroughTheSharedPreferencesStore() {
        RecorderSettings.setNoiseCancellation(context, true)
        RecorderSettings.setVoiceActivatedPausing(context, true)
        RecorderSettings.setWavOutput(context, true)
        RecorderSettings.setVadSensitivity(context, RecorderSettings.SENSITIVITY_HIGH)

        assertTrue(RecorderSettings.noiseCancellation(context))
        assertTrue(RecorderSettings.voiceActivatedPausing(context))
        assertTrue(RecorderSettings.wavOutput(context))
        assertEquals(RecorderSettings.SENSITIVITY_HIGH, RecorderSettings.vadSensitivity(context))

        RecorderSettings.setWavOutput(context, false)
        assertFalse(RecorderSettings.wavOutput(context))
    }

    @Test
    fun sensitivityIsClampedToThePresetRangeOnWriteAndRead() {
        RecorderSettings.setVadSensitivity(context, -5)
        assertEquals(RecorderSettings.SENSITIVITY_HIGH, RecorderSettings.vadSensitivity(context))
        RecorderSettings.setVadSensitivity(context, 99)
        assertEquals(RecorderSettings.SENSITIVITY_NOISE_REJECTING, RecorderSettings.vadSensitivity(context))

        // Even a value corrupted straight into the store must never escape the preset range.
        context.getSharedPreferences("app_preferences", Context.MODE_PRIVATE).edit()
            .putInt("vad_sensitivity", 42).commit()
        assertEquals(RecorderSettings.SENSITIVITY_NOISE_REJECTING, RecorderSettings.vadSensitivity(context))
    }

    @Test
    fun wavCostsAboutSevenTimesTheBytesPerSecondOfAac() {
        assertEquals(13_000L, RecorderSettings.bytesPerSecond(wav = false))
        assertEquals(96_000L, RecorderSettings.bytesPerSecond(wav = true))
    }
}
