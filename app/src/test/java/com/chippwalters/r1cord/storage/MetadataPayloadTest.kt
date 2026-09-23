package com.chippwalters.r1cord.storage

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** metadata.json content, recording id/title generation, and audio-name rules. */
class MetadataPayloadTest {
    private fun row(status: String = "SAVED", error: String? = null, waveform: String = "[0.5,1.0]") =
        RecordingRow(
            id = "20260923-141530-1a2b3c4d",
            title = "Sep 23, 14:15",
            createdAt = 1_750_000_000_000L,
            durationMs = 61_234L,
            audioUri = "content://media/external_primary/downloads/7",
            metadataUri = "",
            status = status,
            waveform = waveform,
            error = error,
        )

    @Test
    fun savedAacRecordingDescribesItsFormatAndAudioFile() {
        val payload = buildMetadataPayload(row(), photos = emptyList(), extension = "m4a")
        assertEquals(1, payload.getInt("schemaVersion"))
        assertEquals("20260923-141530-1a2b3c4d", payload.getString("id"))
        assertEquals("Sep 23, 14:15", payload.getString("title"))
        assertEquals(1_750_000_000_000L, payload.getLong("createdAt"))
        assertEquals(61_234L, payload.getLong("durationMs"))
        assertEquals("SAVED", payload.getString("status"))
        assertEquals("audio.m4a", payload.getString("audio"))
        assertEquals("aac-lc", payload.getString("format"))
        assertEquals(48_000, payload.getInt("sampleRate"))
        assertEquals(1, payload.getInt("channels"))
        assertEquals(96_000, payload.getInt("bitrate"))
        assertEquals(0.5, payload.getJSONArray("waveform").getDouble(0), 1e-9)
        assertEquals(1.0, payload.getJSONArray("waveform").getDouble(1), 1e-9)
        assertEquals(0, payload.getJSONArray("photos").length())
        assertTrue("no error must serialize as JSON null", payload.isNull("error"))
    }

    @Test
    fun savedWavRecordingSwitchesFormatBitrateAndAudioName() {
        val payload = buildMetadataPayload(row(), photos = emptyList(), extension = "wav")
        assertEquals("audio.wav", payload.getString("audio"))
        assertEquals("wav-pcm16", payload.getString("format"))
        assertEquals(768_000, payload.getInt("bitrate"))
    }

    @Test
    fun audioFileNameTracksTheRecordingLifecycleStatus() {
        assertEquals("audio.m4a", audioFileFor("SAVED", "m4a"))
        assertEquals("audio.partial.m4a", audioFileFor("STARTING", "m4a"))
        assertEquals("audio.partial.wav", audioFileFor("RECORDING", "wav"))
        assertEquals("audio.partial.wav", audioFileFor("PAUSED", "wav"))
        for (interrupted in listOf("FINALIZING", "INTERRUPTED", "MISSING", "DELETING", "anything-else")) {
            assertEquals("audio.interrupted.m4a", audioFileFor(interrupted, "m4a"))
        }
        // The status passed while finishing overrides what the row still says.
        val finishing = buildMetadataPayload(row(status = "FINALIZING"), emptyList(), "m4a", status = "SAVED")
        assertEquals("SAVED", finishing.getString("status"))
        assertEquals("audio.m4a", finishing.getString("audio"))
    }

    @Test
    fun photosListNamesFilesByTheirOwnStatus() {
        val photos = listOf(
            PhotoRow("p1", "20260923-141530-1a2b3c4d", "content://x/1", 11L, status = "SAVED"),
            PhotoRow("p2", "20260923-141530-1a2b3c4d", "content://x/2", 22L, status = "INTERRUPTED"),
        )
        val list = buildMetadataPayload(row(), photos, "m4a").getJSONArray("photos")
        assertEquals(2, list.length())
        val saved = list.getJSONObject(0)
        assertEquals("p1", saved.getString("id"))
        assertEquals(11L, saved.getLong("createdAt"))
        assertEquals("SAVED", saved.getString("status"))
        assertEquals("photo-p1.jpg", saved.getString("file"))
        assertEquals("photo-p2.interrupted.jpg", list.getJSONObject(1).getString("file"))
    }

    @Test
    fun errorFieldPrefersTheExplicitErrorThenTheStoredOne() {
        val explicit = buildMetadataPayload(row(error = "stored"), emptyList(), "m4a", error = "explicit")
        assertEquals("explicit", explicit.getString("error"))
        val stored = buildMetadataPayload(row(error = "stored"), emptyList(), "m4a")
        assertEquals("stored", stored.getString("error"))
    }

    @Test
    fun recordingIdsAreTimestampPrefixedWithEightHexCharacters() {
        val at = 1_750_000_000_000L
        val id = newRecordingId(at)
        assertTrue(id, id.matches(Regex("^\\d{8}-\\d{6}-[0-9a-f]{8}$")))
        val prefix = id.substringBeforeLast("-")
        // The prefix is the local wall clock of the same second, no matter the time zone.
        val parsed = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).parse(prefix)!!
        assertEquals(at / 1000L, parsed.time / 1000L)
        val other = newRecordingId(at)
        assertNotEquals("ids generated in the same second must still differ", id, other)
        assertTrue(other.matches(Regex("^$prefix-[0-9a-f]{8}$")))
    }

    @Test
    fun recordingTitlesAreShortHumanReadableDates() {
        val title = recordingTitle(1_750_000_000_000L)
        assertTrue(title, title.matches(Regex("^[A-Za-z]{3} \\d{1,2}, \\d{2}:\\d{2}$")))
    }

    @Test
    fun audioExtensionComesFromTheDisplayNameAndDefaultsToAac() {
        assertEquals("wav", audioExtensionFor("audio.wav"))
        assertEquals("wav", audioExtensionFor("AUDIO.WAV"))
        assertEquals("wav", audioExtensionFor("audio.partial.wav"))
        assertEquals("m4a", audioExtensionFor("audio.m4a"))
        assertEquals("m4a", audioExtensionFor("metadata.json"))
        assertEquals("m4a", audioExtensionFor(null))
    }

    @Test
    fun waveformDataIsCarriedThroughVerbatim() {
        val payload = buildMetadataPayload(row(waveform = "[0.25,0.75,1.0]"), emptyList(), "wav")
        val waveform = payload.getJSONArray("waveform")
        assertEquals(JSONArray("[0.25,0.75,1.0]").toString(), waveform.toString())
        assertNull("no JSON object leaks as an error string", payload.optJSONObject("error"))
    }
}
