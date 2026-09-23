package com.chippwalters.r1cord.storage

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Environment
import android.os.StatFs
import android.provider.MediaStore
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.chippwalters.r1cord.model.RecordingItem
import java.io.File
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.shadows.ShadowMediaMetadataRetriever
import org.robolectric.shadows.ShadowStatFs
import org.robolectric.shadows.util.DataSource

/**
 * RecordingLibrary operations that run under Robolectric: Room rows, MediaStore files,
 * metadata.json publication, deletion (row, files, folder) and crash recovery.
 */
@RunWith(RobolectricTestRunner::class)
class RecordingLibraryTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private val collection: Uri get() = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    private lateinit var library: RecordingLibrary

    @Before fun fakePlentyOfFreeSpace() {
        // Both roots the library stats must report a nearly-empty card; blocks are generous.
        ShadowStatFs.registerStats(Environment.getExternalStorageDirectory().absolutePath, 1_000_000, 1_000_000, 1_000_000)
        ShadowStatFs.registerStats(context.filesDir.absolutePath, 1_000_000, 1_000_000, 1_000_000)
        library = RecordingLibrary(context)
    }

    @After fun dropRegisteredStats() {
        ShadowStatFs.unregisterStats(Environment.getExternalStorageDirectory().absolutePath)
        ShadowStatFs.unregisterStats(context.filesDir.absolutePath)
    }

    /** Polls the items StateFlow until [predicate] holds; Room emits on background threads. */
    private fun awaitItems(timeoutMs: Long = 5_000, predicate: (List<RecordingItem>) -> Boolean): List<RecordingItem> {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val items = library.items.value
            if (predicate(items)) return items
            Thread.sleep(20)
        }
        throw AssertionError("condition not reached; items were: ${library.items.value}")
    }

    private fun recording(id: String): RecordingItem = awaitItems { list -> list.any { it.id == id } }.first { it.id == id }

    private fun tearDown(vararg ids: String) = runBlocking {
        ids.forEach { id ->
            runCatching { library.finish(id, 0, emptyList(), "test teardown") }
            library.deleteRecording(id)
        }
        awaitItems { list -> ids.none { id -> list.any { it.id == id } } }
    }

    /** Every media file the fake provider holds for one recording folder. */
    private fun mediaFiles(id: String): Map<String, Uri> {
        val files = mutableMapOf<String, Uri>()
        // Robolectric lays files out with the host separator, so filter paths in Kotlin.
        val folder = setOf("R1CORD/$id/", "R1CORD${File.separator}$id${File.separator}")
        context.contentResolver.query(collection, arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, "_data"),
            null, null, null)?.use { cursor ->
            val nameColumn = cursor.getColumnIndex(MediaStore.MediaColumns.DISPLAY_NAME)
            val idColumn = cursor.getColumnIndex(MediaStore.MediaColumns._ID)
            val pathColumn = cursor.getColumnIndex("_data")
            while (cursor.moveToNext()) {
                val path = cursor.getString(pathColumn) ?: ""
                if (folder.any { path.contains(it) }) {
                    files[cursor.getString(nameColumn)] = Uri.parse("$collection/${cursor.getLong(idColumn)}")
                }
            }
        }
        return files
    }

    private fun readMetadata(id: String): JSONObject {
        val entry = mediaFiles(id).entries.firstOrNull { it.key.contains("metadata.json") }
        assertNotNull("metadata.json must be published for $id", entry)
        val text = context.contentResolver.openInputStream(entry!!.value)!!.use { it.readBytes().toString(Charsets.UTF_8) }
        return JSONObject(text)
    }

    @Test
    fun beginInsertsARowWithAGeneratedIdAndAnAudioFile() = runBlocking<Unit> {
        val target = library.begin(wav = false)
        assertTrue(target.id, target.id.matches(Regex("^\\d{8}-\\d{6}-[0-9a-f]{8}$")))

        val item = awaitItems { list -> list.any { it.id == target.id } }.first { it.id == target.id }
        assertEquals("STARTING", item.status)
        assertTrue("an audio file must exist for the session", mediaFiles(target.id).keys.any { it.contains("audio") })
        assertTrue(item.waveform.isEmpty())
        tearDown(target.id)
    }

    @Test
    fun captureStatusAndCheckpointUpdateTheStoredRow() = runBlocking<Unit> {
        val target = library.begin(wav = false)
        library.captureStatus(target.id, "RECORDING")
        library.checkpoint(target.id, 61_234, listOf(0.25f, 0.75f))

        // Wait for the emission that carries both writes; the status write alone can be seen first.
        val item = awaitItems { list -> list.any { it.id == target.id && it.status == "RECORDING" && it.durationMs == 61_234L } }
            .first { it.id == target.id }
        assertEquals(61_234L, item.durationMs)
        assertEquals(listOf(0.25f, 0.75f), item.waveform)

        library.captureStatus(target.id, "PAUSED")
        assertEquals("PAUSED", awaitItems { list -> list.any { it.id == target.id && it.status == "PAUSED" } }.first { it.id == target.id }.status)
        tearDown(target.id)
    }

    @Test
    fun finishWithoutPlayableAudioMarksInterruptedAndStillWritesMetadata() = runBlocking<Unit> {
        val target = library.begin(wav = false)
        val saved = library.finish(target.id, 5_000, listOf(0.5f), null)
        assertFalse("nothing playable was captured", saved)

        val item = awaitItems { list -> list.any { it.id == target.id && it.status == "INTERRUPTED" } }.first { it.id == target.id }
        assertEquals(5_000L, item.durationMs)

        val metadata = readMetadata(target.id)
        assertEquals(target.id, metadata.getString("id"))
        assertEquals("INTERRUPTED", metadata.getString("status"))
        assertEquals("audio.interrupted.m4a", metadata.getString("audio"))
        assertEquals("aac-lc", metadata.getString("format"))
        assertEquals(96_000, metadata.getInt("bitrate"))
        assertTrue("the finalization problem must be recorded", !metadata.isNull("error"))
        tearDown(target.id)
    }

    @Test
    fun finishWithADurationMarksSavedAndPublishesWavMetadata() = runBlocking<Unit> {
        val target = library.begin(wav = true)
        ShadowMediaMetadataRetriever.addMetadata(
            DataSource.toDataSource(context, target.uri),
            MediaMetadataRetriever.METADATA_KEY_DURATION,
            "5432",
        )
        val saved = library.finish(target.id, 5_432, emptyList(), null)
        assertTrue(saved)

        val item = awaitItems { list -> list.any { it.id == target.id && it.status == "SAVED" } }.first { it.id == target.id }
        assertEquals("the container's own duration wins", 5_432L, item.durationMs)

        val metadata = readMetadata(target.id)
        assertEquals("SAVED", metadata.getString("status"))
        assertEquals("audio.wav", metadata.getString("audio"))
        assertEquals("wav-pcm16", metadata.getString("format"))
        assertEquals(768_000, metadata.getInt("bitrate"))
        assertEquals(48_000, metadata.getInt("sampleRate"))
        assertEquals(1, metadata.getInt("channels"))
        assertTrue("a saved recording carries no error", metadata.isNull("error"))
        tearDown(target.id)
    }

    @Test
    fun deleteRecordingRemovesTheRowAndItsEmptyFolder() = runBlocking<Unit> {
        val target = library.begin(wav = false)
        library.finish(target.id, 100, emptyList(), "teardown")

        @Suppress("DEPRECATION")
        val folder = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "R1CORD/${target.id}")
        folder.mkdirs()
        assertTrue(folder.isDirectory)

        library.deleteRecording(target.id)
        awaitItems { list -> list.none { it.id == target.id } }
        assertFalse("an empty R1CORD/<id> folder must not linger", folder.exists())
    }

    @Test
    fun deleteRecordingNeverRemovesAFolderThatStillHoldsFiles() = runBlocking<Unit> {
        val target = library.begin(wav = false)
        library.finish(target.id, 100, emptyList(), "teardown")

        @Suppress("DEPRECATION")
        val folder = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "R1CORD/${target.id}")
        folder.mkdirs()
        File(folder, "user-copied.txt").writeText("the user's own file")

        library.deleteRecording(target.id)
        awaitItems { list -> list.none { it.id == target.id } }
        assertTrue("a folder with user files is never deleted", folder.exists())
        folder.delete()
    }

    @Test
    fun deleteRecordingRefusesWhileTheSessionIsActive() = runBlocking<Unit> {
        val target = library.begin(wav = false)
        try {
            library.deleteRecording(target.id)
            fail("deleting an active recording must be refused")
        } catch (expected: IllegalStateException) {
            assertEquals("Stop recording before deleting it.", expected.message)
        }
        // The row survived the refused delete.
        awaitItems { list -> list.any { it.id == target.id } }
        tearDown(target.id)
    }

    @Test
    fun constructionRecoversUnfinishedRowsAsInterrupted() = runBlocking<Unit> {
        // Seed the database file the library is about to open, as a crash would have left it.
        val seed = Room.databaseBuilder(context, RecordingDatabase::class.java, "r1cord.db")
            .allowMainThreadQueries().build()
        seed.recordings().insert(
            RecordingRow("recover-1", "Interrupted session", 1L, 2_000L, "", "", "RECORDING", "[0.5]")
        )
        seed.close()

        val recovered = RecordingLibrary(context)
        try {
            val deadline = System.currentTimeMillis() + 5_000
            var item: RecordingItem? = null
            while (System.currentTimeMillis() < deadline) {
                item = recovered.items.value.firstOrNull { it.id == "recover-1" && it.status == "INTERRUPTED" }
                if (item != null) break
                Thread.sleep(20)
            }
            assertNotNull("a RECOVERING-era row must not stay RECORDING", item)
            assertEquals(2_000L, item!!.durationMs)
        } finally {
            recovered.finish("recover-1", 0, emptyList(), "test teardown")
            recovered.deleteRecording("recover-1")
        }
    }

    @Test
    fun remainingSecondsSubtractsTheReserveFromStatFsBytes() {
        val available = minOf(
            StatFs(Environment.getExternalStorageDirectory().absolutePath).availableBytes,
            StatFs(context.filesDir.absolutePath).availableBytes,
        )
        assertEquals((available - RecordingLibrary.RESERVE_BYTES) / 13_000L, library.remainingSeconds(13_000L))

        ShadowStatFs.registerStats(Environment.getExternalStorageDirectory().absolutePath, 1, 1, 1)
        ShadowStatFs.registerStats(context.filesDir.absolutePath, 1, 1, 1)
        assertEquals("a card with less than the reserve records nothing", 0L, library.remainingSeconds(13_000L))
    }
}
