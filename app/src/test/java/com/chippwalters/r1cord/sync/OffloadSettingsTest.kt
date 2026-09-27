package com.chippwalters.r1cord.sync

import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Preference behavior of OffloadSettings. The token lives in EncryptedSharedPreferences,
 * which Robolectric cannot back (no AndroidKeyStore), so a plain SharedPreferences stands in.
 */
@RunWith(RobolectricTestRunner::class)
class OffloadSettingsTest {
    private val context = ApplicationProvider.getApplicationContext<Application>()

    @Before
    fun useInMemorySecurePrefs() {
        OffloadSettings.securePrefs = context.getSharedPreferences("offload_secure_test", Context.MODE_PRIVATE)
    }

    @After
    fun restoreSecurePrefs() {
        OffloadSettings.securePrefs = null
    }

    @Test
    fun provisionPublishesPairingWithTheNewServerNameAndClearTokenUnpairs() {
        val pairing = OffloadSettings.pairing(context)
        assertEquals(PairingSnapshot(paired = false, serverName = ""), pairing.value)

        // SetupProvider provisions on a binder thread, not the thread observing the state.
        val binder = Thread { OffloadSettings.provision(context, "https://studio.example.ts.net", "Studio PC", "t-64-hex") }
        binder.start()
        binder.join()
        assertEquals(PairingSnapshot(paired = true, serverName = "Studio PC"), pairing.value)

        OffloadSettings.clearToken(context)
        assertEquals(false, pairing.value.paired)
    }

    @Test
    fun setTokenAloneMarksThePairingPaired() {
        val pairing = OffloadSettings.pairing(context)
        assertEquals(false, pairing.value.paired)
        OffloadSettings.setToken(context, "t-64-hex")
        assertEquals(PairingSnapshot(paired = true, serverName = ""), pairing.value)
    }

    @Test
    fun pairingReflectsPreviouslyStoredValues() {
        OffloadSettings.setServerName(context, "Laptop")
        context.getSharedPreferences("offload_secure_test", Context.MODE_PRIVATE).edit().putString("token", "t").commit()
        assertEquals(PairingSnapshot(paired = true, serverName = "Laptop"), OffloadSettings.pairing(context).value)
    }

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
