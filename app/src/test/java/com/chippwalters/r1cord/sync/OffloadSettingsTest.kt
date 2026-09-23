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
    fun defaultReviewsStartWithSummaryAndAreStoredInCanonicalOrderWithoutUnknownKinds() {
        assertEquals(listOf("summary"), OffloadSettings.defaultReviews(context))
        OffloadSettings.setDefaultReviews(context, listOf("organized", "poem", "outline"))
        assertEquals(listOf("outline", "organized"), OffloadSettings.defaultReviews(context))
        OffloadSettings.setDefaultReviews(context, emptyList())
        assertEquals(emptyList<String>(), OffloadSettings.defaultReviews(context))
    }

    @Test
    fun summarizeTurnedOffBeforeAiReviewsSeedsNoReviews() {
        context.getSharedPreferences("app_preferences", android.content.Context.MODE_PRIVATE)
            .edit().putBoolean("offload_default_summarize", false).commit()
        assertEquals(emptyList<String>(), OffloadSettings.defaultReviews(context))
    }
}
