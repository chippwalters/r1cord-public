package com.chippwalters.r1cord.sync

import android.net.Uri
import com.chippwalters.r1cord.storage.OffloadBundle
import java.io.ByteArrayInputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * UploadCoordinator end-to-end against a real OffloadClient and an in-memory fake of the
 * desktop server, with a fake recording store. maxChunk is overridden to 8 bytes so chunk
 * boundaries are visible without 64 MiB fixtures.
 */
@RunWith(RobolectricTestRunner::class)
class UploadCoordinatorTest {
    private val audioUri = Uri.parse("mem://rec-1/audio.m4a")
    private val photoUri = Uri.parse("mem://rec-1/photo-1.jpg")
    private val audio = "abcdefghijklmnopqrst".toByteArray(Charsets.US_ASCII) // 20 bytes
    private val photo = "ABCDE".toByteArray(Charsets.US_ASCII) // 5 bytes

    private lateinit var server: MockWebServer
    private lateinit var fake: FakeOffloadServer
    private lateinit var library: FakeLibrary
    private val bundle = OffloadBundle(
        id = "rec-1",
        title = "Site visit",
        createdAt = 1758400000000L,
        audioName = "audio.m4a",
        audioUri = audioUri,
        photos = listOf("photo-1.jpg" to photoUri),
        metadataJson = """{"id":"rec-1"}""",
    )

    @Before
    fun setUp() {
        fake = FakeOffloadServer()
        server = MockWebServer()
        server.dispatcher = fake
        server.start()
        library = FakeLibrary(bundle)
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun coordinator(
        libraryOps: LibraryOps = library,
        maxChunk: Long = 8L,
        streams: Map<Uri, ByteArray> = mapOf(audioUri to audio, photoUri to photo),
    ) = UploadCoordinator(
        library = libraryOps,
        client = OffloadClient(
            serverUrl = { server.url("/").toString().trimEnd('/') },
            token = { "tok-1" },
            hasValidatedNetwork = { true },
        ),
        maxChunk = maxChunk,
        openStream = { uri -> streams[uri]?.let { ByteArrayInputStream(it) } },
    )

    // ---- full send ----

    @Test
    fun sendsEveryFileInMaxChunkSizedPiecesAndEndsOnProcessing() {
        val progress = mutableListOf<UploadProgress>()
        val result = runBlocking {
            coordinator().send("rec-1", "Site visit", true, false, "notes") { progress += it }
        }

        val audioPuts = fake.puts.filter { it.name == "audio.m4a" }
        assertEquals(listOf(0L, 8L, 16L), audioPuts.map { it.offset })
        assertEquals(listOf(8, 8, 4), audioPuts.map { it.bytes.size })
        assertEquals("abcdefgh", String(audioPuts[0].bytes, Charsets.US_ASCII))
        assertEquals("ijklmnop", String(audioPuts[1].bytes, Charsets.US_ASCII))
        assertEquals("qrst", String(audioPuts[2].bytes, Charsets.US_ASCII))
        val photoPuts = fake.puts.filter { it.name == "photo-1.jpg" }
        assertEquals(listOf(0L), photoPuts.map { it.offset })
        assertEquals("ABCDE", String(photoPuts.single().bytes, Charsets.US_ASCII))

        assertEquals(1, fake.commitCount)
        assertEquals(mapOf("audio.m4a" to 20L, "photo-1.jpg" to 5L), fake.manifest)
        assertEquals("https://ex/commit/summary.html", result.webdavUrl)

        // Badge transitions the coordinator reports to the library: sending -> processing.
        assertEquals(listOf("sending", "processing"), library.jobUpdates.map { it.second })
        assertEquals(
            listOf("https://ex/create/summary.html", "https://ex/commit/summary.html"),
            library.jobUpdates.map { it.third },
        )
        assertTrue(library.statusUpdates.isEmpty())

        val last = progress.last()
        assertEquals(2, last.fileCount)
        assertEquals(25L, last.bytesSent)
        assertEquals(25L, last.bytesTotal)
        assertTrue("per-chunk progress expected", progress.any { it.fileIndex == 1 && it.bytesSent == 8L })
    }

    @Test
    fun resumesFromTheServerReportedReceivedBytes() {
        fake.initialReceived["audio.m4a"] = 12L
        runBlocking { coordinator().send("rec-1", "Site visit", true, false, "notes") { } }

        val audioPuts = fake.puts.filter { it.name == "audio.m4a" }
        assertEquals(listOf(12L), audioPuts.map { it.offset })
        assertEquals("mnopqrst", String(audioPuts.single().bytes, Charsets.US_ASCII))
        assertEquals(listOf(0L), fake.puts.filter { it.name == "photo-1.jpg" }.map { it.offset })
    }

    @Test
    fun adoptsTheServerCountAfterOffsetMismatch() {
        fake.mismatchOnce = "audio.m4a" to 12L
        runBlocking { coordinator().send("rec-1", "Site visit", true, false, "notes") { } }

        val audioPuts = fake.puts.filter { it.name == "audio.m4a" }
        assertEquals(listOf(0L, 12L), audioPuts.map { it.offset })
        assertEquals("mnopqrst", String(audioPuts.last().bytes, Charsets.US_ASCII))
        assertEquals(1, fake.commitCount)
    }

    @Test
    fun hashMismatchReuploadsOnlyTheNamedFilesFromZero() {
        fake.commitScript += FakeOffloadServer.CommitResult(
            status = 422,
            body = """{"error":"hash_mismatch","files":["audio.m4a"]}""",
            deleteFiles = listOf("audio.m4a"),
        )
        val result = runBlocking { coordinator().send("rec-1", "Site visit", true, false, "notes") { } }

        val audioPuts = fake.puts.filter { it.name == "audio.m4a" }
        assertEquals(6, audioPuts.size)
        assertEquals(listOf(0L, 8L, 16L, 0L, 8L, 16L), audioPuts.map { it.offset })
        assertEquals(listOf(0L), fake.puts.filter { it.name == "photo-1.jpg" }.map { it.offset })
        assertEquals(2, fake.commitCount)
        assertEquals("https://ex/commit/summary.html", result.webdavUrl)
        assertEquals(listOf("sending", "processing"), library.jobUpdates.map { it.second })
    }

    @Test
    fun repeatedHashMismatchSurfacesInsteadOfLoopingForever() {
        fake.commitScript += FakeOffloadServer.CommitResult(
            status = 422,
            body = """{"error":"hash_mismatch","files":["audio.m4a"]}""",
            deleteFiles = listOf("audio.m4a"),
        )
        fake.commitScript += FakeOffloadServer.CommitResult(
            status = 422,
            body = """{"error":"hash_mismatch","files":["audio.m4a"]}""",
            deleteFiles = listOf("audio.m4a"),
        )
        val failure = assertFailsWith<OffloadException> {
            runBlocking { coordinator().send("rec-1", "Site visit", true, false, "notes") { } }
        }
        assertEquals("hash_mismatch", failure.code)
        assertEquals(2, fake.commitCount)
    }

    // ---- failure paths ----

    @Test
    fun failureBeforeJobCreationResetsTheRecordingToLocal() {
        fake.failCreateJobWith = 500 to """{"error":"internal","message":"Writer queue exploded."}"""
        val failure = assertFailsWith<OffloadException> {
            runBlocking { coordinator().send("rec-1", "Site visit", true, false, "notes") { } }
        }
        assertEquals("internal", failure.code)
        assertEquals(listOf("local" to null), library.statusUpdates)
        assertTrue(library.jobUpdates.isEmpty())
        assertTrue(fake.puts.isEmpty())
        assertEquals(0, fake.commitCount)
    }

    @Test
    fun incompleteCommitSurfacesWithoutResettingToStorage() {
        fake.commitScript += FakeOffloadServer.CommitResult(
            status = 409,
            body = """{"error":"incomplete","files":[{"name":"audio.m4a","received":8,"size":20}]}""",
        )
        val failure = assertFailsWith<OffloadException> {
            runBlocking { coordinator().send("rec-1", "Site visit", true, false, "notes") { } }
        }
        assertEquals("incomplete", failure.code)
        // The job exists on the server, so the recording stays on "sending", not "local".
        assertEquals(listOf("sending"), library.jobUpdates.map { it.second })
        assertTrue(library.statusUpdates.isEmpty())
    }

    @Test
    fun blankTitleIsRejectedBeforeAnyWork() {
        assertFailsWith<IllegalArgumentException> {
            runBlocking { coordinator().send("rec-1", "   ", true, false, "notes") { } }
        }
        assertEquals(0, server.requestCount)
        assertTrue(library.statusUpdates.isEmpty())
    }

    // ---- cancellation ----

    @Test
    fun cancellingMidUploadPropagatesAndKeepsTheJobState() {
        val putStarted = CountDownLatch(1)
        val release = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.method == "PUT") {
                    putStarted.countDown()
                    release.await(5, TimeUnit.SECONDS)
                    return MockResponse().setResponseCode(200).setBody("""{"received":8}""")
                }
                return fake.dispatch(request)
            }
        }
        val outcome = CompletableDeferred<Throwable?>()
        val thrown = runBlocking {
            val job = launch(Dispatchers.IO) {
                try {
                    coordinator().send("rec-1", "Site visit", true, false, "notes") { }
                    outcome.complete(null)
                } catch (error: Throwable) {
                    outcome.complete(error)
                }
            }
            assertTrue(putStarted.await(5, TimeUnit.SECONDS))
            job.cancelAndJoin()
            outcome.await()
        }
        release.countDown()
        assertTrue("expected CancellationException, got $thrown", thrown is CancellationException)
        assertEquals(0, fake.commitCount)
        assertEquals(listOf("sending"), library.jobUpdates.map { it.second })
        assertTrue(library.statusUpdates.isEmpty())
    }

    // ---- fakes ----

    /** Minimal in-memory model of the desktop server's /v1 upload routes. */
    private class FakeOffloadServer : Dispatcher() {
        val manifest = LinkedHashMap<String, Long>()
        val receivedBytes = LinkedHashMap<String, Long>()
        val puts = mutableListOf<Put>()
        val commitScript = mutableListOf<CommitResult>()
        val initialReceived = mutableMapOf<String, Long>()
        var mismatchOnce: Pair<String, Long>? = null
        var failCreateJobWith: Pair<Int, String>? = null
        var commitCount = 0
        private var jobs = 0

        data class Put(val name: String, val offset: Long, val bytes: ByteArray)
        data class CommitResult(val status: Int, val body: String, val deleteFiles: List<String> = emptyList())

        override fun dispatch(request: RecordedRequest): MockResponse {
            val url = request.requestUrl ?: return respond(400, """{"error":"bad_url"}""")
            val path = url.encodedPath
            val body = request.body.readByteArray()
            failCreateJobWith?.let { (status, text) ->
                if (request.method == "POST" && path == "/v1/jobs") return respond(status, text)
            }
            return when {
                request.method == "POST" && path == "/v1/jobs" -> {
                    val files = JSONObject(String(body, Charsets.UTF_8)).getJSONObject("job").getJSONArray("files")
                    for (index in 0 until files.length()) {
                        val file = files.getJSONObject(index)
                        val name = file.getString("name")
                        manifest[name] = file.getLong("size")
                        receivedBytes[name] = initialReceived[name] ?: 0L
                    }
                    jobs += 1
                    respond(202, """{"jobId":"job-$jobs","recordingId":"rec-1","status":"uploading","webdavUrl":"https://ex/create/summary.html"}""")
                }
                request.method == "GET" && path.endsWith("/received") ->
                    respond(200, """{"received":${receivedBytes[path.split("/")[5]] ?: 0L}}""")
                request.method == "PUT" -> {
                    val name = path.split("/")[5]
                    val offset = url.queryParameter("offset")!!.toLong()
                    puts += Put(name, offset, body)
                    mismatchOnce?.let { (forcedName, forcedReceived) ->
                        if (name == forcedName) {
                            mismatchOnce = null
                            receivedBytes[name] = forcedReceived
                            return respond(409, """{"error":"offset_mismatch","received":$forcedReceived}""")
                        }
                    }
                    val current = receivedBytes[name] ?: 0L
                    if (offset != current) {
                        respond(409, """{"error":"offset_mismatch","received":$current}""")
                    } else {
                        receivedBytes[name] = current + body.size
                        respond(200, """{"received":${current + body.size}}""")
                    }
                }
                request.method == "POST" && path.endsWith("/commit") -> {
                    commitCount += 1
                    val scripted = commitScript.removeFirstOrNull()
                    if (scripted != null) {
                        scripted.deleteFiles.forEach { receivedBytes[it] = 0L }
                        return respond(scripted.status, scripted.body)
                    }
                    respond(200, """{"jobId":"job-1","status":"queued","webdavUrl":"https://ex/commit/summary.html"}""")
                }
                else -> respond(404, """{"error":"not_found","message":"$path"}""")
            }
        }

        private fun respond(status: Int, body: String) =
            MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(body)
    }

    private class FakeLibrary(private val bundle: OffloadBundle) : LibraryOps {
        val jobUpdates = mutableListOf<Triple<String?, String, String?>>()
        val statusUpdates = mutableListOf<Pair<String, String?>>()

        override suspend fun exportBundle(id: String): OffloadBundle {
            assertEquals(bundle.id, id)
            return bundle
        }

        override suspend fun updateJob(id: String, jobId: String?, status: String, url: String?, sentAt: Long?) {
            jobUpdates += Triple(jobId, status, url)
        }

        override suspend fun updateJobStatus(id: String, status: String, url: String?) {
            statusUpdates += status to url
        }
    }
}

/** JUnit4 ships no kotlin.test assertFailsWith; a local reified stand-in keeps call sites terse. */
private inline fun <reified T : Throwable> assertFailsWith(block: () -> Unit): T {
    try {
        block()
    } catch (error: Throwable) {
        if (error is T) return error
        throw error
    }
    fail("Expected ${T::class.simpleName} but the block completed normally.")
    error("unreachable")
}
