package com.chippwalters.r1cord.storage

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.chippwalters.r1cord.model.PublishedPage
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Migrations without schema JSONs: hand-written v1 (pre-job) and v2 (pre-pages) SQLite
 * databases are opened through Room, which must run the registered migrations, keep every
 * row, and expose the new columns.
 */
@RunWith(RobolectricTestRunner::class)
class RecordingDatabaseMigrationTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()

    private fun createV1Database(name: String) {
        context.getDatabasePath(name).parentFile?.mkdirs()
        val db = SQLiteDatabase.openOrCreateDatabase(context.getDatabasePath(name), null)
        db.execSQL(
            "CREATE TABLE recordings (" +
                "`id` TEXT NOT NULL PRIMARY KEY, `title` TEXT NOT NULL, `createdAt` INTEGER NOT NULL, " +
                "`durationMs` INTEGER NOT NULL, `audioUri` TEXT NOT NULL, `metadataUri` TEXT NOT NULL, " +
                "`status` TEXT NOT NULL, `waveform` TEXT NOT NULL, `error` TEXT)"
        )
        db.execSQL(
            "CREATE TABLE photos (" +
                "`id` TEXT NOT NULL PRIMARY KEY, `recordingId` TEXT NOT NULL, `uri` TEXT NOT NULL, " +
                "`createdAt` INTEGER NOT NULL, `status` TEXT NOT NULL, " +
                "FOREIGN KEY(`recordingId`) REFERENCES recordings(`id`) ON UPDATE NO ACTION ON DELETE CASCADE )"
        )
        db.execSQL("CREATE INDEX index_photos_recordingId ON photos (`recordingId`)")
        db.execSQL(
            "INSERT INTO recordings VALUES('r1','Morning notes',1750000000000,61234," +
                "'content://media/external_primary/downloads/7','content://media/external_primary/downloads/8'," +
                "'SAVED','[0.5,1.0]',NULL)"
        )
        db.execSQL(
            "INSERT INTO recordings VALUES('r2','Broken session',1750000100000,0," +
                "'content://media/external_primary/downloads/10','','INTERRUPTED','[]','encoder died')"
        )
        db.execSQL(
            "INSERT INTO photos VALUES('p1','r1','content://media/external_primary/downloads/9',1750000001000,'SAVED')"
        )
        db.version = 1
        db.close()
    }

    /** v2 = v1 plus the job columns MIGRATION_1_2 adds; r1 was sent to a server before AI reviews. */
    private fun createV2Database(name: String) {
        createV1Database(name)
        val db = SQLiteDatabase.openDatabase(context.getDatabasePath(name).path, null, SQLiteDatabase.OPEN_READWRITE)
        db.execSQL("ALTER TABLE recordings ADD COLUMN jobId TEXT")
        db.execSQL("ALTER TABLE recordings ADD COLUMN jobStatus TEXT NOT NULL DEFAULT 'local'")
        db.execSQL("ALTER TABLE recordings ADD COLUMN webdavUrl TEXT")
        db.execSQL("ALTER TABLE recordings ADD COLUMN sentAt INTEGER")
        db.execSQL(
            "UPDATE recordings SET jobId = 'job-1', jobStatus = 'done', " +
                "webdavUrl = 'https://ex/2026/09/r1/summary.html', sentAt = 1750000200000 WHERE id = 'r1'"
        )
        db.version = 2
        db.close()
    }

    @Test
    fun migrationPreservesRowsAndFillsTheNewJobColumns() = runBlocking {
        createV1Database("migration-test.db")
        val db = Room.databaseBuilder(context, RecordingDatabase::class.java, "migration-test.db")
            .addMigrations(MIGRATION_1_2, MIGRATION_2_3)
            .allowMainThreadQueries()
            .build()
        try {
            val dao = db.recordings()
            val saved = dao.recording("r1")
            assertNotNull(saved)
            saved!!
            assertEquals("Morning notes", saved.title)
            assertEquals(1_750_000_000_000L, saved.createdAt)
            assertEquals(61_234L, saved.durationMs)
            assertEquals("content://media/external_primary/downloads/7", saved.audioUri)
            assertEquals("content://media/external_primary/downloads/8", saved.metadataUri)
            assertEquals("SAVED", saved.status)
            assertEquals("[0.5,1.0]", saved.waveform)
            assertNull(saved.error)
            assertEquals("v1 rows start with no job", null, saved.jobId)
            assertEquals("local", saved.jobStatus)
            assertNull(saved.webdavUrl)
            assertNull(saved.sentAt)
            assertEquals("[]", saved.pages)

            val interrupted = dao.recording("r2")
            assertNotNull(interrupted)
            assertEquals("encoder died", interrupted!!.error)

            assertEquals(listOf("p1"), dao.photos("r1").map { it.id })
            assertEquals("SAVED", dao.photos("r1").first().status)

            dao.updateJob("r1", "job-9", "queued", "https://example/x", "[]", 123L)
            val updated = dao.recording("r1")!!
            assertEquals("job-9", updated.jobId)
            assertEquals("queued", updated.jobStatus)
            assertEquals("https://example/x", updated.webdavUrl)
            assertEquals(123L, updated.sentAt)
        } finally {
            db.close()
        }
    }

    @Test
    fun migrationFromV2KeepsASentRecordingsLinkAsItsSummaryPage() = runBlocking {
        createV2Database("migration-v2-test.db")
        val db = Room.databaseBuilder(context, RecordingDatabase::class.java, "migration-v2-test.db")
            .addMigrations(MIGRATION_1_2, MIGRATION_2_3)
            .allowMainThreadQueries()
            .build()
        try {
            val dao = db.recordings()
            val sent = dao.recording("r1")!!
            assertEquals("job-1", sent.jobId)
            assertEquals("done", sent.jobStatus)
            assertEquals("https://ex/2026/09/r1/summary.html", sent.webdavUrl)
            assertEquals(1_750_000_200_000L, sent.sentAt)
            assertEquals(
                listOf(PublishedPage("summary", "https://ex/2026/09/r1/summary.html")),
                decodePages(sent.pages),
            )
            assertEquals("never-sent rows have no pages", emptyList<PublishedPage>(), decodePages(dao.recording("r2")!!.pages))
            assertEquals(listOf("p1"), dao.photos("r1").map { it.id })

            val pages = listOf(
                PublishedPage("transcript", "https://ex/t.html"),
                PublishedPage("outline", "https://ex/o.html"),
            )
            dao.updateJobStatus("r1", "done", "https://ex/t.html", encodePages(pages))
            assertEquals(pages, decodePages(dao.recording("r1")!!.pages))
        } finally {
            db.close()
        }
    }

    @Test
    fun openingV1WithoutTheRegisteredMigrationFailsLoudly() {
        createV1Database("no-migration-test.db")
        val db = Room.databaseBuilder(context, RecordingDatabase::class.java, "no-migration-test.db")
            .allowMainThreadQueries()
            .build()
        try {
            runBlocking { db.recordings().recording("r1") }
            fail("Room must refuse to open a v1 database without the migration")
        } catch (expected: IllegalStateException) {
            assertTrue(expected.message!!, expected.message!!.contains("migration", ignoreCase = true))
        } finally {
            db.close()
        }
    }
}
