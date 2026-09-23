package com.chippwalters.r1cord.storage

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.Insert
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "recordings")
internal data class RecordingRow(
    @PrimaryKey val id: String,
    val title: String,
    val createdAt: Long,
    val durationMs: Long = 0,
    val audioUri: String = "",
    val metadataUri: String = "",
    val status: String = "STARTING",
    val waveform: String = "[]",
    val error: String? = null,
    val jobId: String? = null,
    val jobStatus: String = "local",
    val webdavUrl: String? = null,
    val sentAt: Long? = null,
)

@Entity(
    tableName = "photos",
    foreignKeys = [ForeignKey(entity = RecordingRow::class, parentColumns = ["id"], childColumns = ["recordingId"], onDelete = ForeignKey.CASCADE)],
    indices = [Index("recordingId")],
)
internal data class PhotoRow(
    @PrimaryKey val id: String,
    val recordingId: String,
    val uri: String,
    val createdAt: Long,
    val status: String = "WRITING",
)

@Dao
internal interface RecordingDao {
    @Query("SELECT * FROM recordings ORDER BY createdAt DESC") fun observeRecordings(): Flow<List<RecordingRow>>
    @Query("SELECT * FROM photos ORDER BY createdAt") fun observePhotos(): Flow<List<PhotoRow>>
    @Query("SELECT * FROM recordings") suspend fun recordings(): List<RecordingRow>
    @Query("SELECT * FROM recordings WHERE id = :id") suspend fun recording(id: String): RecordingRow?
    @Query("SELECT * FROM photos WHERE recordingId = :id ORDER BY createdAt") suspend fun photos(id: String): List<PhotoRow>
    @Insert suspend fun insert(row: RecordingRow)
    @Insert suspend fun insertPhoto(row: PhotoRow)
    @Query("UPDATE recordings SET audioUri = :uri WHERE id = :id") suspend fun audio(id: String, uri: String)
    @Query("UPDATE recordings SET metadataUri = :uri WHERE id = :id") suspend fun metadata(id: String, uri: String)
    @Query("UPDATE recordings SET status = :status, error = :error WHERE id = :id") suspend fun status(id: String, status: String, error: String? = null)
    @Query("UPDATE recordings SET durationMs = :duration, waveform = :waveform WHERE id = :id") suspend fun progress(id: String, duration: Long, waveform: String)
    @Query("UPDATE photos SET uri = :uri WHERE id = :id") suspend fun photoUri(id: String, uri: String)
    @Query("UPDATE photos SET status = :status WHERE id = :id") suspend fun photoStatus(id: String, status: String)
    @Query("DELETE FROM recordings WHERE id = :id") suspend fun delete(id: String)
    @Query("DELETE FROM photos WHERE id = :id") suspend fun deletePhoto(id: String)
    @Query("UPDATE recordings SET jobId = :jobId, jobStatus = :jobStatus, webdavUrl = :webdavUrl, sentAt = :sentAt WHERE id = :id")
    suspend fun updateJob(id: String, jobId: String?, jobStatus: String, webdavUrl: String?, sentAt: Long?)
    @Query("UPDATE recordings SET jobStatus = :jobStatus, webdavUrl = :webdavUrl WHERE id = :id")
    suspend fun updateJobStatus(id: String, jobStatus: String, webdavUrl: String?)
}

internal val MIGRATION_1_2 = object : Migration(1, 2) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE recordings ADD COLUMN jobId TEXT")
        db.execSQL("ALTER TABLE recordings ADD COLUMN jobStatus TEXT NOT NULL DEFAULT 'local'")
        db.execSQL("ALTER TABLE recordings ADD COLUMN webdavUrl TEXT")
        db.execSQL("ALTER TABLE recordings ADD COLUMN sentAt INTEGER")
    }
}

@Database(entities = [RecordingRow::class, PhotoRow::class], version = 2, exportSchema = false)
internal abstract class RecordingDatabase : RoomDatabase() {
    abstract fun recordings(): RecordingDao
}
