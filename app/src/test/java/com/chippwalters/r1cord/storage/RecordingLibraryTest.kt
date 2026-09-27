package com.chippwalters.r1cord.storage

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Environment
import android.os.StatFs
import android.provider.MediaStore
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.chippwalters.r1cord.device.MaintenanceGate
import com.chippwalters.r1cord.model.RecordingItem
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.flow.first
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
import org.robolectric.shadows.ShadowContentResolver
import org.robolectric.shadows.ShadowMediaMetadataRetriever
import org.robolectric.shadows.ShadowStatFs
import org.robolectric.shadows.util.DataSource

/**
 * RecordingLibrary operations that run under Robolectric: Room rows, MediaStore files,
 * metadata.json publication, renaming, deletion (row, files, folder), crash recovery and
 * the maintenance gate.
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
    private fun awaitItems(
        timeoutMs: Long = 5_000,
        source: RecordingLibrary = library,
        predicate: (List<RecordingItem>) -> Boolean,
    ): List<RecordingItem> {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val items = source.items.value
            if (predicate(items)) return items
            Thread.sleep(20)
        }
        throw AssertionError("condition not reached; items were: ${source.items.value}")
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

    private fun insertMediaFile(id: String, name: String, mime: String): Uri =
        context.contentResolver.insert(collection, ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/R1CORD/$id/")
        })!!

    /**
     * A SAVED recording left by an earlier session, with its audio and [photoIds] in
     * MediaStore, and a library opened over it. The returned library's startup recovery
     * publishes the recording's metadata.json before its first operation returns.
     */
    private fun seededLibrary(id: String, title: String, photoIds: List<String> = emptyList()): RecordingLibrary = runBlocking {
        // Let the default library finish its own recovery first, so only the new one writes metadata.
        library.updateJobStatus("no-such-recording", "local", null, emptyList())
        val audio = insertMediaFile(id, "audio.m4a", "audio/mp4")
        val seed = Room.databaseBuilder(context, RecordingDatabase::class.java, "r1cord.db")
            .allowMainThreadQueries().build()
        try {
            seed.recordings().insert(RecordingRow(id, title, 1_000L, 2_000L, audio.toString(), "", "SAVED", "[0.5]"))
            photoIds.forEachIndexed { index, photoId ->
                val uri = insertMediaFile(id, "photo-$photoId.jpg", "image/jpeg")
                seed.recordings().insertPhoto(PhotoRow(photoId, id, uri.toString(), 10L + index, "SAVED"))
            }
        } finally {
            seed.close()
        }
        RecordingLibrary(context)
    }

    private suspend fun expectRefused(message: String, block: suspend () -> Unit) {
        try {
            block()
            fail("expected refusal: $message")
        } catch (expected: IllegalStateException) {
            assertEquals(message, expected.message)
        }
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
    fun recordingStartsAfterStartupRecoveryFailedWhileTheVolumeWasNotAttached() = runBlocking<Unit> {
        // Recovery only touches MediaStore for existing rows, as on a device with a library.
        val seed = Room.databaseBuilder(context, RecordingDatabase::class.java, "r1cord.db")
            .allowMainThreadQueries().build()
        seed.recordings().insert(RecordingRow("boot-1", "Earlier session", 1L, 2_000L, "", "", "SAVED", "[]"))
        seed.close()

        // At boot the process can start before MediaProvider attaches the primary volume.
        val media = context.contentResolver.acquireContentProviderClient(MediaStore.AUTHORITY)!!
            .use { it.localContentProvider!! }
        val unattached = VolumeNotAttachedProvider()
        ShadowContentResolver.registerProviderInternal(MediaStore.AUTHORITY, unattached)
        val booted = try {
            RecordingLibrary(context).also {
                val deadline = System.currentTimeMillis() + 5_000
                while (unattached.refused.get() == 0 && System.currentTimeMillis() < deadline) Thread.sleep(20)
                assertTrue("startup recovery must have hit the unattached volume", unattached.refused.get() > 0)
            }
        } finally {
            ShadowContentResolver.registerProviderInternal(MediaStore.AUTHORITY, media)
        }

        // The volume is attached now; the boot-time failure must not be replayed forever.
        val target = booted.begin(wav = false)
        try {
            assertTrue("an audio file must exist for the session", mediaFiles(target.id).keys.any { it.contains("audio") })
        } finally {
            booted.finish(target.id, 0, emptyList(), "test teardown")
            booted.deleteRecording(target.id)
            booted.deleteRecording("boot-1")
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

    @Test
    fun renameUpdatesTheRowAndMetadataTitleButNoIdFileNameOrUri() = runBlocking<Unit> {
        val lib = seededLibrary("rename-1", "Sep 23, 14:15", listOf("p1", "p2"))
        try {
            val before = lib.exportBundle("rename-1")
            assertEquals("Sep 23, 14:15", before.title)
            val filesBefore = mediaFiles("rename-1")

            assertEquals(RenameResult.Saved, lib.renameRecording("rename-1", "  Kitchen remodel notes "))

            val after = lib.exportBundle("rename-1")
            assertEquals("Kitchen remodel notes", after.title)
            assertEquals("Kitchen remodel notes", JSONObject(after.metadataJson).getString("title"))
            assertEquals(before.id, after.id)
            assertEquals(before.audioName, after.audioName)
            assertEquals(before.audioUri, after.audioUri)
            assertEquals(before.photos, after.photos)
            assertEquals("metadata is rewritten in place; no file is added, renamed or moved", filesBefore, mediaFiles("rename-1"))

            val metadata = readMetadata("rename-1")
            assertEquals("rename-1", metadata.getString("id"))
            assertEquals("Kitchen remodel notes", metadata.getString("title"))
            assertEquals("audio.m4a", metadata.getString("audio"))
            val photos = metadata.getJSONArray("photos")
            assertEquals(listOf("photo-p1.jpg", "photo-p2.jpg"), List(photos.length()) { photos.getJSONObject(it).getString("file") })

            val item = awaitItems(source = lib) { list -> list.any { it.id == "rename-1" && it.title == "Kitchen remodel notes" } }
                .first { it.id == "rename-1" }
            assertEquals(listOf("p1", "p2"), item.photos.map { it.id })
        } finally {
            lib.deleteRecording("rename-1")
        }
    }

    @Test
    fun renameAcceptsExactly120CharactersAndRejectsInvalidTitlesWithoutChangingTheRow() = runBlocking<Unit> {
        val lib = seededLibrary("rename-2", "Original")
        try {
            lib.exportBundle("rename-2")
            for (invalid in listOf("x".repeat(121), "   ", "Two\nlines")) {
                try {
                    lib.renameRecording("rename-2", invalid)
                    fail("\"$invalid\" must be rejected")
                } catch (_: IllegalArgumentException) {
                }
            }
            assertEquals("Original", lib.exportBundle("rename-2").title)

            val longest = "t".repeat(120)
            assertEquals(RenameResult.Saved, lib.renameRecording("rename-2", longest))
            assertEquals(longest, lib.exportBundle("rename-2").title)
            assertEquals(longest, readMetadata("rename-2").getString("title"))
        } finally {
            lib.deleteRecording("rename-2")
        }
    }

    @Test
    fun renameRefusesAnActiveRecordingAndAMissingOne() = runBlocking<Unit> {
        val target = library.begin(wav = false)
        expectRefused("Stop recording before renaming it.") { library.renameRecording(target.id, "Live") }
        expectRefused("Recording no longer exists.") { library.renameRecording("no-such-recording", "Gone") }
        assertTrue("a live recording must not get metadata early", mediaFiles(target.id).keys.none { it.contains("metadata") })
        tearDown(target.id)
    }

    @Test
    fun failedMetadataRewriteKeepsTheTitleAndTheNextExportRepairsMetadata() = runBlocking<Unit> {
        val lib = seededLibrary("rename-3", "Before")
        try {
            lib.exportBundle("rename-3")
            val media = context.contentResolver.acquireContentProviderClient(MediaStore.AUTHORITY)!!
                .use { it.localContentProvider!! }
            ShadowContentResolver.registerProviderInternal(MediaStore.AUTHORITY, RefusingUpdatesProvider(media))
            val result = try {
                lib.renameRecording("rename-3", "After")
            } finally {
                ShadowContentResolver.registerProviderInternal(MediaStore.AUTHORITY, media)
            }
            assertTrue("expected a partial save, got $result", result is RenameResult.SavedMetadataFailed)
            assertEquals("the stale file still carries the old title", "Before", readMetadata("rename-3").getString("title"))
            awaitItems(source = lib) { list -> list.any { it.id == "rename-3" && it.title == "After" } }

            val bundle = lib.exportBundle("rename-3")
            assertEquals("After", bundle.title)
            assertEquals("the export sends repaired metadata", "After", JSONObject(bundle.metadataJson).getString("title"))
            assertEquals("After", readMetadata("rename-3").getString("title"))
        } finally {
            lib.deleteRecording("rename-3")
        }
    }

    @Test
    fun photosAreOrderedEarliestFirstWithTheIdBreakingTies() = runBlocking<Unit> {
        val db = Room.inMemoryDatabaseBuilder(context, RecordingDatabase::class.java).allowMainThreadQueries().build()
        try {
            val dao = db.recordings()
            dao.insert(RecordingRow("order-1", "Order", 1L))
            // Inserted out of order so neither insertion order nor rowid can explain the result.
            dao.insertPhoto(PhotoRow("c", "order-1", "", 20L, "SAVED"))
            dao.insertPhoto(PhotoRow("b", "order-1", "", 10L, "SAVED"))
            dao.insertPhoto(PhotoRow("a", "order-1", "", 20L, "SAVED"))
            dao.insertPhoto(PhotoRow("z", "order-1", "", 5L, "SAVED"))
            assertEquals(listOf("z", "b", "a", "c"), dao.photos("order-1").map { it.id })
            assertEquals(listOf("z", "b", "a", "c"), dao.observePhotos().first().map { it.id })

            dao.deletePhoto("z")
            assertEquals("the next earliest photo becomes first", "b", dao.photos("order-1").first().id)
        } finally {
            db.close()
        }
    }

    @Test
    fun libraryWritesAreRefusedDuringMaintenanceAndReleaseTheGateAfterwards() = runBlocking<Unit> {
        val lib = seededLibrary("maint-1", "Before", listOf("p1"))
        try {
            lib.exportBundle("maint-1")
            assertTrue(MaintenanceGate.beginMaintenance("test update"))
            try {
                val refused = RecordingLibrary.MAINTENANCE_MESSAGE
                expectRefused(refused) { lib.renameRecording("maint-1", "After") }
                expectRefused(refused) { lib.deletePhoto("maint-1", "p1") }
                expectRefused(refused) { lib.deleteRecording("maint-1") }
                expectRefused(refused) { lib.addPhoto("maint-1", File(context.cacheDir, "never-read.jpg")) }
            } finally {
                MaintenanceGate.endMaintenance()
            }
            val untouched = lib.exportBundle("maint-1")
            assertEquals("Before", untouched.title)
            assertEquals(listOf("photo-p1.jpg"), untouched.photos.map { it.first })

            assertEquals(RenameResult.Saved, lib.renameRecording("maint-1", "After"))
            lib.deletePhoto("maint-1", "p1")
            assertTrue(lib.exportBundle("maint-1").photos.isEmpty())
            assertFalse("every library write released the gate", MaintenanceGate.isBusy())
        } finally {
            lib.deleteRecording("maint-1")
        }
    }

    /** MediaProvider's answer while the primary volume is not attached yet. */
    private class VolumeNotAttachedProvider : ContentProvider() {
        val refused = AtomicInteger()
        private fun refuse(): Nothing {
            refused.incrementAndGet()
            throw IllegalArgumentException("Volume external_primary not found")
        }
        override fun onCreate() = true
        override fun getType(uri: Uri): String? = null
        override fun query(uri: Uri, projection: Array<String>?, selection: String?, selectionArgs: Array<String>?, sortOrder: String?): Cursor = refuse()
        override fun insert(uri: Uri, values: ContentValues?): Uri = refuse()
        override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<String>?): Int = refuse()
        override fun delete(uri: Uri, selection: String?, selectionArgs: Array<String>?): Int = refuse()
    }

    /** MediaStore that refuses every update, as when a file vanishes from under a rewrite. */
    private class RefusingUpdatesProvider(private val media: ContentProvider) : ContentProvider() {
        override fun onCreate() = true
        override fun getType(uri: Uri): String? = media.getType(uri)
        override fun query(uri: Uri, projection: Array<String>?, selection: String?, selectionArgs: Array<String>?, sortOrder: String?): Cursor? =
            media.query(uri, projection, selection, selectionArgs, sortOrder)
        override fun query(uri: Uri, projection: Array<String>?, queryArgs: Bundle?, cancellationSignal: CancellationSignal?): Cursor? =
            media.query(uri, projection, queryArgs, cancellationSignal)
        override fun insert(uri: Uri, values: ContentValues?): Uri? = media.insert(uri, values)
        override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<String>?): Int = 0
        override fun update(uri: Uri, values: ContentValues?, extras: Bundle?): Int = 0
        override fun delete(uri: Uri, selection: String?, selectionArgs: Array<String>?): Int = media.delete(uri, selection, selectionArgs)
    }
}
