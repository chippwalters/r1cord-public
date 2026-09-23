package com.chippwalters.r1cord.sync

import android.util.Log
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.shadows.ShadowLog

/**
 * The client logging rule: one WARN line per failed request carrying method, path, status and
 * machine code — and never the bearer token. Run under Robolectric so Log is captured.
 */
@RunWith(RobolectricTestRunner::class)
class OffloadClientLoggingTest {
    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        ShadowLog.clear()
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun client(url: String = server.url("/").toString().trimEnd('/')) = OffloadClient(
        serverUrl = { url },
        token = { "secret-token" },
        hasValidatedNetwork = { true },
    )

    private val job = JobRequest(
        recordingId = "rec-1",
        createdAt = 1L,
        title = "T",
        summarize = true,
        publish = false,
        summaryStyle = "notes",
        files = listOf(FileEntry("audio.m4a", 1L, "aa")),
    )

    private fun warnings(): List<ShadowLog.LogItem> =
        ShadowLog.getLogsForTag("R1CORD/Sync").filter { it.type == Log.WARN }

    @Test
    fun a530ThroughTheTunnelLogsOneLineWithStatusAndMachineCodeAndNoToken() {
        server.enqueue(
            MockResponse().setResponseCode(530)
                .setHeader("Content-Type", "text/plain")
                .setBody("error code: 1033")
        )
        val failure = assertFailsWith<OffloadException> { runBlocking { client().createJob(job, "{}") } }
        assertEquals("server_unreachable", failure.code)

        val lines = warnings()
        assertEquals("expected exactly one WARN line for the failed request: $lines", 1, lines.size)
        val line = lines[0].msg
        assertTrue("line must carry the method: $line", line.contains("POST"))
        assertTrue("line must carry the path: $line", line.contains("/v1/jobs"))
        assertTrue("line must carry the status: $line", line.contains("530"))
        assertTrue("line must carry the machine code: $line", line.contains("server_unreachable"))
        assertTrue(
            "no log line may contain the bearer token",
            ShadowLog.getLogs().none { it.msg.contains("secret-token") },
        )
    }

    @Test
    fun aConnectionFailureLogsOneLineWithTheMachineCode() {
        val failure = assertFailsWith<OffloadException> {
            runBlocking { client(url = "http://127.0.0.1:1").commit("job-1") }
        }
        assertEquals("server_unreachable", failure.code)

        val lines = warnings()
        assertEquals("expected exactly one WARN line for the failed request: $lines", 1, lines.size)
        val line = lines[0].msg
        assertTrue("line must carry the method: $line", line.contains("POST"))
        assertTrue("line must carry the path: $line", line.contains("/v1/jobs/job-1/commit"))
        assertTrue("line must carry the machine code: $line", line.contains("server_unreachable"))
    }

    @Test
    fun anErrorResponseWithAJsonBodyLogsTheServerMachineCode() {
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":"audio_mismatch","message":"differs"}"""))
        assertFailsWith<OffloadException> { runBlocking { client().createJob(job, "{}") } }

        val line = warnings().single().msg
        assertTrue("line must carry the server machine code: $line", line.contains("audio_mismatch"))
        assertTrue("line must carry the status: $line", line.contains("409"))
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
