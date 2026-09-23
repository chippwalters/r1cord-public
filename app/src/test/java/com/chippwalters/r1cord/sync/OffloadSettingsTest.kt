package com.chippwalters.r1cord.sync

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Plain-preference behavior of OffloadSettings. The token lives in
 * EncryptedSharedPreferences, which Robolectric cannot back (no AndroidKeyStore), so token
 * paths are covered through the OffloadClient seams instead.
 */
@RunWith(RobolectricTestRunner::class)
class OffloadSettingsTest {
    private val context = ApplicationProvider.getApplicationContext<Application>()

    @Test
    fun serverUrlIsStoredTrimmed() {
        assertEquals("", OffloadSettings.serverUrl(context))
        OffloadSettings.setServerUrl(context, "  https://r1cord.example.com/  ")
        assertEquals("https://r1cord.example.com/", OffloadSettings.serverUrl(context))
    }

    @Test
    fun unknownStyleFallsBackToNotesAndValidStylesAreKept() {
        assertEquals("notes", OffloadSettings.defaultStyle(context))
        OffloadSettings.setDefaultStyle(context, "minutes")
        assertEquals("minutes", OffloadSettings.defaultStyle(context))
        OffloadSettings.setDefaultStyle(context, "poem")
        assertEquals("notes", OffloadSettings.defaultStyle(context))
    }

    @Test
    fun corruptStoredStyleFallsBackToNotes() {
        context.getSharedPreferences("app_preferences", android.content.Context.MODE_PRIVATE)
            .edit().putString("offload_default_style", "gibberish").commit()
        assertEquals("notes", OffloadSettings.defaultStyle(context))
    }
}
