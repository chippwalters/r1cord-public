package com.chippwalters.r1cord.sync

import com.chippwalters.r1cord.model.PublishedPage
import java.io.ByteArrayInputStream
import java.net.InetAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import okhttp3.Dns
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * The offload protocol as the client sees it, against a MockWebServer on loopback. The
 * constructor seams replace OffloadSettings (EncryptedSharedPreferences) and the network
 * snapshot / USB probe so no Android keystore or radio is involved.
 */
class OffloadClientTest {
    private lateinit var server: MockWebServer
    private val base: String get() = server.url("/").toString().trimEnd('/')

    /** Scripted network, read on every request so a test can change it mid-upload. */
    private var net = ONLINE
    private var usbUp = true
    /** Scripted configured-server probe; every probed URL is recorded. */
    private var serverUp = true
    private val probedServers = mutableListOf<String>()

    private val job = JobRequest(
        recordingId = "rec-1",
        createdAt = 1758400000000L,
        title = "Site visit",
        reviews = listOf("summary", "organized"),
        publish = false,
        files = listOf(FileEntry("audio.m4a", 100L, "aa11"), FileEntry("photo-1.jpg", 10L, "bb22")),
    )

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun client(
        url: String = base,
        token: String? = "tok-1",
        usbUrl: String = "http://127.0.0.1:8765",
        serverUrl: () -> String = { url },
    ) = OffloadClient(
        serverUrl = serverUrl,
        token = { token },
        routes = SnapshotRoutes(net = { net }, usb = { usbUp }, configured = { probedServers += it; serverUp }),
        usbUrl = usbUrl,
        dns = tailnetOnLoopback,
    )

    /** Resolves every `*.ts.net` name to the MockWebServer's address, so tailnet URLs run offline. */
    private val tailnetOnLoopback = object : Dns {
        override fun lookup(hostname: String): List<InetAddress> =
            Dns.SYSTEM.lookup(if (hostname.endsWith(".ts.net")) server.hostName else hostname)
    }

    private fun withUsbServer(block: (usb: MockWebServer, usbUrl: String) -> Unit) {
        val usb = MockWebServer()
        usb.start()
        try {
            block(usb, usb.url("/").toString().trimEnd('/'))
        } finally {
            usb.shutdown()
        }
    }

    private fun ok(body: String) =
        MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody(body)

    private fun error(status: Int, body: String) =
        MockResponse().setResponseCode(status).setBody(body)

    // ---- pair ----

    @Test
    fun pairSendsTrimmedCodeWithoutAuthAndStoresToken() {
        server.enqueue(ok("""{"token":"t-64-hex","serverName":"Studio PC"}"""))
        val result = runBlocking { client().pair(" 123456 ") }
        assertEquals("t-64-hex", result.token)
        assertEquals("Studio PC", result.serverName)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/v1/pair", request.path)
        assertNull(request.getHeader("Authorization"))
        assertEquals("123456", JSONObject(request.body.readUtf8()).getString("code"))
    }

    @Test
    fun pairWithoutTokenInResponseFails() {
        server.enqueue(ok("""{"serverName":"Studio PC"}"""))
        val error = assertFailsWith<OffloadException> { runBlocking { client().pair("123456") } }
        assertEquals("Pairing response was missing a token.", error.message)
    }

    @Test
    fun pairSurfacesServerErrorCodeAndMessage() {
        server.enqueue(error(400, """{"error":"invalid_code","message":"That code is unknown, used, or expired."}"""))
        val failure = assertFailsWith<OffloadException> { runBlocking { client().pair("123456") } }
        assertEquals("invalid_code", failure.code)
        assertEquals("That code is unknown, used, or expired.", failure.message)
    }

    // ---- createJob ----

    @Test
    fun createJobPostsJobAndMetadataAndParsesCreatedJob() {
        server.enqueue(ok("""{"jobId":"job-1","recordingId":"rec-1","status":"uploading","webdavUrl":"https://ex/summary.html"}"""))
        val created = runBlocking { client().createJob(job, """{"id":"rec-1","title":"Site visit"}""") }
        assertEquals("job-1", created.jobId)
        assertEquals("rec-1", created.recordingId)
        assertEquals("uploading", created.status)
        assertEquals("https://ex/summary.html", created.webdavUrl)
        assertFalse(created.resumed)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/v1/jobs", request.path)
        assertEquals("Bearer tok-1", request.getHeader("Authorization"))
        val sent = JSONObject(request.body.readUtf8())
        val sentJob = sent.getJSONObject("job")
        assertEquals("rec-1", sentJob.getString("recordingId"))
        assertEquals(1758400000000L, sentJob.getLong("createdAt"))
        assertEquals(listOf("summary", "organized"), sentJob.getJSONArray("reviews").let { a -> List(a.length()) { a.getString(it) } })
        assertTrue("older servers must still summarize", sentJob.getBoolean("summarize"))
        assertFalse("summaryStyle is deprecated and never sent", sentJob.has("summaryStyle"))
        val files = sentJob.getJSONArray("files")
        assertEquals(2, files.length())
        assertEquals("audio.m4a", files.getJSONObject(0).getString("name"))
        assertEquals(100L, files.getJSONObject(0).getLong("size"))
        assertEquals("aa11", files.getJSONObject(0).getString("sha256"))
        assertEquals("rec-1", sent.getJSONObject("metadata").getString("id"))
    }

    @Test
    fun createJobWithNoReviewsTellsOlderServersNotToSummarize() {
        server.enqueue(ok("""{"jobId":"job-1"}"""))
        runBlocking { client().createJob(job.copy(reviews = emptyList()), """{"id":"rec-1"}""") }
        val sentJob = JSONObject(server.takeRequest().body.readUtf8()).getJSONObject("job")
        assertEquals(0, sentJob.getJSONArray("reviews").length())
        assertFalse(sentJob.getBoolean("summarize"))
    }

    @Test
    fun createJobActiveConflictResumesTheServerJob() {
        server.enqueue(error(409, """{"error":"job_active","jobId":"job-9"}"""))
        val created = runBlocking { client().createJob(job, "{}") }
        assertEquals("job-9", created.jobId)
        assertTrue(created.resumed)
    }

    @Test
    fun createJobOtherConflictThrows() {
        server.enqueue(error(409, """{"error":"audio_mismatch","message":"Stored audio differs for this recording."}"""))
        val failure = assertFailsWith<OffloadException> { runBlocking { client().createJob(job, "{}") } }
        assertEquals("audio_mismatch", failure.code)
        assertEquals("Stored audio differs for this recording.", failure.message)
    }

    @Test
    fun createJobUnauthorizedKeepsUnpairedMessage() {
        server.enqueue(error(401, """{"error":"unauthorized","message":"token revoked"}"""))
        val failure = assertFailsWith<OffloadException> { runBlocking { client().createJob(job, "{}") } }
        assertEquals("Not paired or token revoked. Pair again in Settings.", failure.message)
        assertEquals("unauthorized", failure.code)
    }

    @Test
    fun createJobValidationMessageIsSurfaced() {
        server.enqueue(error(422, """{"error":"invalid_files","message":"Exactly one audio file is required."}"""))
        val failure = assertFailsWith<OffloadException> { runBlocking { client().createJob(job, "{}") } }
        assertEquals("invalid_files", failure.code)
        assertEquals("Exactly one audio file is required.", failure.message)
    }

    @Test
    fun cloudflare530WithTextBodyBecomesServerUnreachable() {
        server.enqueue(
            MockResponse().setResponseCode(530)
                .setHeader("Content-Type", "text/plain")
                .setBody("error code: 1033")
        )
        val failure = assertFailsWith<OffloadException> { runBlocking { client().createJob(job, "{}") } }
        assertEquals("server_unreachable", failure.code)
        assertEquals(
            "Desktop server is not reachable (HTTP 530). Check that the server and its tunnel are running.",
            failure.message,
        )
    }

    @Test
    fun json500KeepsTheServerMachineCode() {
        server.enqueue(error(500, """{"error":"internal","message":"Writer queue exploded."}"""))
        val failure = assertFailsWith<OffloadException> { runBlocking { client().createJob(job, "{}") } }
        assertEquals("internal", failure.code)
        assertEquals("Writer queue exploded.", failure.message)
    }

    // ---- received ----

    @Test
    fun receivedReportsServerByteCount() {
        server.enqueue(ok("""{"received":4096}"""))
        val bytes = runBlocking { client().received("job-1", "audio.m4a") }
        assertEquals(4096L, bytes)
        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/v1/jobs/job-1/files/audio.m4a/received", request.path)
        assertEquals("Bearer tok-1", request.getHeader("Authorization"))
    }

    @Test
    fun receivedUnknownFileSurfacesServerError() {
        server.enqueue(error(404, """{"error":"file_not_in_manifest","message":"audio.mp3 is not in the job manifest."}"""))
        val failure = assertFailsWith<OffloadException> { runBlocking { client().received("job-1", "audio.mp3") } }
        assertEquals("file_not_in_manifest", failure.code)
        assertEquals("audio.mp3 is not in the job manifest.", failure.message)
    }

    // ---- putChunk ----

    @Test
    fun putChunkStreamsExactBytesWithOffsetQueryAndLength() {
        server.enqueue(ok("""{"received":7}"""))
        val bytes = "abcdefgh".toByteArray(Charsets.US_ASCII)
        // The source stream must already start at the offset (the coordinator pre-skips);
        // the client streams exactly [length] bytes from it and reports the offset verbatim.
        val sent = runBlocking { client().putChunk("job-1", "audio.m4a", 3, { ByteArrayInputStream(bytes, 3, 4) }, 4) }
        assertEquals(7L, sent)
        val request = server.takeRequest()
        assertEquals("PUT", request.method)
        assertEquals("/v1/jobs/job-1/files/audio.m4a?offset=3", request.path)
        assertEquals("4", request.getHeader("Content-Length"))
        assertEquals("application/octet-stream", request.getHeader("Content-Type"))
        assertEquals("defg", request.body.readUtf8())
    }

    @Test
    fun putChunkOffsetMismatchCarriesServerReceivedCount() {
        server.enqueue(error(409, """{"error":"offset_mismatch","received":512}"""))
        val failure = assertFailsWith<OffloadException> {
            runBlocking { client().putChunk("job-1", "audio.m4a", 0, { ByteArrayInputStream(ByteArray(1)) }, 1) }
        }
        assertEquals("offset_mismatch", failure.code)
        assertEquals(512L, failure.received)
    }

    @Test
    fun putChunkRejectsSizesOutsideTheCloudflareCapLocally() {
        val source = { ByteArrayInputStream(ByteArray(1)) }
        assertFailsWith<IllegalStateException> {
            runBlocking { client().putChunk("job-1", "audio.m4a", 0, source, OffloadClient.MAX_CHUNK + 1) }
        }
        assertFailsWith<IllegalStateException> {
            runBlocking { client().putChunk("job-1", "audio.m4a", 0, source, 0) }
        }
        assertEquals(0, server.requestCount)
    }

    // ---- commit ----

    @Test
    fun commitParsesQueuedJob() {
        server.enqueue(ok("""{"jobId":"job-1","status":"queued","webdavUrl":"https://ex/s.html"}"""))
        val committed = runBlocking { client().commit("job-1") }
        assertEquals("job-1", committed.jobId)
        assertEquals("queued", committed.status)
        assertEquals("https://ex/s.html", committed.webdavUrl)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/v1/jobs/job-1/commit", request.path)
        assertEquals("Bearer tok-1", request.getHeader("Authorization"))
    }

    @Test
    fun commitIncompleteSurfacesErrorCode() {
        server.enqueue(error(409, """{"error":"incomplete","files":[{"name":"audio.m4a","received":8,"size":100}]}"""))
        val failure = assertFailsWith<OffloadException> { runBlocking { client().commit("job-1") } }
        assertEquals("incomplete", failure.code)
    }

    @Test
    fun commitHashMismatchCarriesOffendingFileNames() {
        server.enqueue(error(422, """{"error":"hash_mismatch","files":["audio.m4a"]}"""))
        val failure = assertFailsWith<OffloadException> { runBlocking { client().commit("job-1") } }
        assertEquals("hash_mismatch", failure.code)
        assertEquals(listOf("audio.m4a"), failure.files)
    }

    // ---- recordings ----

    @Test
    fun recordingsTreatsNullAndBlankOptionalFieldsAsMissing() {
        server.enqueue(
            ok(
                """[{"recordingId":"r1","jobId":"null","status":"complete","webdavUrl":"null","updatedAt":"2026-09-20T20:10:00Z"},""" +
                    """{"recordingId":"r2","jobId":"","status":"","webdavUrl":""},""" +
                    """{"recordingId":"r3","jobId":"j3","status":"error","webdavUrl":"https://ex/s.html","updatedAt":null}]"""
            )
        )
        val list = runBlocking { client().recordings() }
        assertEquals(listOf("r1", "r2", "r3"), list.map { it.recordingId })
        assertNull(list[0].jobId)
        assertNull(list[0].webdavUrl)
        assertEquals("complete", list[0].status)
        assertEquals("2026-09-20T20:10:00Z", list[0].updatedAt)
        assertNull(list[1].jobId)
        assertEquals("", list[1].status)
        assertNull(list[1].webdavUrl)
        assertEquals("j3", list[2].jobId)
        assertEquals("https://ex/s.html", list[2].webdavUrl)
        assertNull(list[2].updatedAt)
    }

    @Test
    fun recordingsParsesPagesInCanonicalOrderAndDropsUnusable() {
        server.enqueue(
            ok(
                """[{"recordingId":"r1","status":"complete","webdavUrl":"https://ex/r1/summary.html","pages":[""" +
                    """{"kind":"outline","url":"https://ex/r1/outline.html"},""" +
                    """{"kind":"transcript","url":"https://ex/r1/transcript.html"},""" +
                    """{"kind":"poem","url":"https://ex/r1/poem.html"},""" +
                    """{"kind":"summary","url":null},""" +
                    """{"kind":"organized","url":"https://ex/r1/organized.html"}]},""" +
                    """{"recordingId":"r2","status":"processing","webdavUrl":"https://ex/r2/summary.html","pages":[]}]"""
            )
        )
        val list = runBlocking { client().recordings() }
        assertEquals(
            listOf(
                PublishedPage("transcript", "https://ex/r1/transcript.html"),
                PublishedPage("outline", "https://ex/r1/outline.html"),
                PublishedPage("organized", "https://ex/r1/organized.html"),
            ),
            list[0].pages,
        )
        assertEquals("an empty pages array means nothing is published yet", emptyList<PublishedPage>(), list[1].pages)
    }

    @Test
    fun recordingsFromAnOlderServerTreatWebdavUrlAsTheSummaryPage() {
        server.enqueue(
            ok(
                """[{"recordingId":"r1","status":"complete","webdavUrl":"https://ex/r1/summary.html"},""" +
                    """{"recordingId":"r2","status":"complete","webdavUrl":"https://ex/r2/index.html"},""" +
                    """{"recordingId":"r3","status":"processing","webdavUrl":null}]"""
            )
        )
        val list = runBlocking { client().recordings() }
        assertEquals(listOf(PublishedPage("summary", "https://ex/r1/summary.html")), list[0].pages)
        assertEquals(listOf(PublishedPage("summary", "https://ex/r2/index.html")), list[1].pages)
        assertEquals(emptyList<PublishedPage>(), list[2].pages)
    }

    @Test
    fun jobResultWithoutPagesKeepsThePredictedLinkUnderItsOwnKind() {
        server.enqueue(ok("""{"jobId":"job-1","status":"queued","webdavUrl":"https://ex/r1/transcript.html"}"""))
        val committed = runBlocking { client().commit("job-1") }
        assertEquals(listOf(PublishedPage("transcript", "https://ex/r1/transcript.html")), committed.pages)
    }

    // ---- route selection and URL validation ----

    @Test
    fun validatedNetworkSendsToConfiguredUrlAndFallbackSendsToUsbBase() = withUsbServer { usb, usbUrl ->
        server.enqueue(ok("""{"received":0}"""))
        usb.enqueue(ok("""{"received":0}"""))
        val wifi = client(usbUrl = usbUrl)
        assertFalse(wifi.usingUsb())
        runBlocking { wifi.received("job-1", "audio.m4a") }
        assertEquals("/v1/jobs/job-1/files/audio.m4a/received", server.takeRequest().path)

        net = OFFLINE
        val cable = client(url = "https://r1cord.example.com", usbUrl = usbUrl)
        assertTrue(cable.usingUsb())
        runBlocking { cable.received("job-1", "audio.m4a") }
        assertEquals("/v1/jobs/job-1/files/audio.m4a/received", usb.takeRequest().path)
    }

    @Test
    fun blankServerUrlMeansUsbOnlyEvenWithInternet() = withUsbServer { usb, usbUrl ->
        usb.enqueue(ok("""{"received":5}"""))
        val cable = client(url = "", usbUrl = usbUrl)
        assertTrue(cable.usingUsb())
        assertEquals(5L, runBlocking { cable.received("job-1", "audio.m4a") })
        assertEquals(1, usb.requestCount)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun tailnetUrlWithVpnDownAndNoUsbExplainsTailscaleIsOff() {
        net = NetSnapshot(vpnUp = false, nonVpnValidatedInternet = true)
        usbUp = false
        val failure = assertFailsWith<OffloadException> {
            runBlocking { client(url = "https://desktop.example.ts.net").createJob(job, "{}") }
        }
        assertEquals(TAILSCALE_OFF, failure.message)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun customUrlWithNoNetworkAndNoUsbKeepsNoRouteMessage() {
        net = OFFLINE
        usbUp = false
        val failure = assertFailsWith<OffloadException> {
            runBlocking { client().recordings() }
        }
        assertEquals(OffloadClient.NO_ROUTE, failure.message)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun invalidServerUrlFailsBeforeAnyRequest() {
        val failure = assertFailsWith<OffloadException> {
            runBlocking { client(url = "not a url").received("job-1", "audio.m4a") }
        }
        assertEquals("Server URL is not valid. Check it in Settings.", failure.message)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun missingTokenFailsAsUnpairedWithoutSending() {
        val failure = assertFailsWith<OffloadException> {
            runBlocking { client(token = null).createJob(job, "{}") }
        }
        assertEquals("Not paired or token revoked. Pair again in Settings.", failure.message)
        assertEquals(0, server.requestCount)
    }

    // ---- route pinning per job ----

    @Test
    fun aJobCreatedOverUsbStaysOnUsbWhenWifiComesBack() = withUsbServer { usb, usbUrl ->
        net = OFFLINE
        usb.enqueue(ok("""{"jobId":"job-1"}"""))
        usb.enqueue(ok("""{"received":0}"""))
        usb.enqueue(ok("""{"jobId":"job-1","status":"queued"}"""))
        val client = client(usbUrl = usbUrl)
        runBlocking { client.createJob(job, "{}") }

        net = ONLINE
        runBlocking {
            client.received("job-1", "audio.m4a")
            client.commit("job-1")
        }
        assertEquals(3, usb.requestCount)
        assertEquals("the configured server must not see a job it never created", 0, server.requestCount)
    }

    @Test
    fun aResumedJobIsPinnedToTheRouteThatAnsweredJobActive() = withUsbServer { usb, usbUrl ->
        net = OFFLINE
        usb.enqueue(error(409, """{"error":"job_active","jobId":"job-9"}"""))
        usb.enqueue(ok("""{"received":3}"""))
        val client = client(usbUrl = usbUrl)
        assertEquals("job-9", runBlocking { client.createJob(job, "{}") }.jobId)
        net = ONLINE
        assertEquals(3L, runBlocking { client.received("job-9", "audio.m4a") })
        assertEquals(0, server.requestCount)
    }

    @Test
    fun losingThePinnedRouteFailsInsteadOfSwitchingServers() = withUsbServer { usb, usbUrl ->
        server.enqueue(ok("""{"jobId":"job-1"}"""))
        val client = client(usbUrl = usbUrl)
        runBlocking { client.createJob(job, "{}") }

        net = OFFLINE // Wi-Fi dropped; the USB reverse is up, but it is not the job's route
        val failure = assertFailsWith<OffloadException> {
            runBlocking { client.putChunk("job-1", "audio.m4a", 0, { ByteArrayInputStream(ByteArray(1)) }, 1) }
        }
        assertEquals(OffloadClient.ROUTE_CHANGED, failure.code)
        assertEquals("The network connection to the desktop was lost during this upload. Send again to resume.", failure.message)
        assertEquals(0, usb.requestCount)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun losingThePinnedUsbCableFailsWithAUsbMessage() = withUsbServer { usb, usbUrl ->
        net = OFFLINE
        usb.enqueue(ok("""{"jobId":"job-1"}"""))
        val client = client(usbUrl = usbUrl)
        runBlocking { client.createJob(job, "{}") }

        usbUp = false
        net = ONLINE
        val failure = assertFailsWith<OffloadException> { runBlocking { client.commit("job-1") } }
        assertEquals(OffloadClient.ROUTE_CHANGED, failure.code)
        assertTrue(failure.message!!.startsWith("The USB connection to the desktop was lost"))
        assertEquals(0, server.requestCount)
    }

    @Test
    fun changingTheServerUrlMidJobFailsAndANewAttemptRedecides() {
        var configured = base
        server.enqueue(ok("""{"jobId":"job-1"}"""))
        server.enqueue(ok("""{"received":0}"""))
        server.enqueue(ok("""{"jobId":"job-1"}"""))
        server.enqueue(ok("""{"received":0}"""))
        val client = client(serverUrl = { configured })
        runBlocking { client.createJob(job, "{}") }

        configured = "$base/" // a trailing slash is the same server
        runBlocking { client.received("job-1", "audio.m4a") }

        configured = "$base/moved"
        val failure = assertFailsWith<OffloadException> { runBlocking { client.received("job-1", "audio.m4a") } }
        assertEquals(OffloadClient.ROUTE_CHANGED, failure.code)
        assertEquals("Server settings changed during this upload. Send again.", failure.message)
        assertEquals(2, server.requestCount)

        runBlocking {
            client.createJob(job, "{}")
            client.received("job-1", "audio.m4a")
        }
        server.takeRequest()
        server.takeRequest()
        assertEquals("/moved/v1/jobs", server.takeRequest().path)
        assertEquals("/moved/v1/jobs/job-1/files/audio.m4a/received", server.takeRequest().path)
    }

    // ---- setup nonce ----

    @Test
    fun setupNonceGetsTheNoncePathWithTheBearerAndReturnsTheStatus() {
        server.enqueue(MockResponse().setResponseCode(204))
        server.enqueue(MockResponse().setResponseCode(404))
        val nonce = "0123456789abcdef0123456789abcdef"
        assertEquals(204, runBlocking { client().setupNonce(nonce) })
        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/v1/setup/nonce/$nonce", request.path)
        assertEquals("Bearer tok-1", request.getHeader("Authorization"))
        assertEquals(404, runBlocking { client().setupNonce(nonce) })
    }

    // ---- connection failures ----

    @Test
    fun connectionFailureOnUsbBaseKeepsNoRouteMessage() {
        net = OFFLINE
        val failure = assertFailsWith<OffloadException> {
            runBlocking { client(usbUrl = "http://127.0.0.1:1").received("job-1", "audio.m4a") }
        }
        assertEquals(OffloadClient.NO_ROUTE, failure.message)
        assertNull(failure.code)
    }

    @Test
    fun connectionFailureOnConfiguredUrlNamesTheHost() {
        val failure = assertFailsWith<OffloadException> {
            runBlocking { client(url = "http://127.0.0.1:1").received("job-1", "audio.m4a") }
        }
        assertEquals("server_unreachable", failure.code)
        assertEquals(
            "Desktop server is not reachable at 127.0.0.1. Check that R1CORD Desktop is running, " +
                "and that Tailscale is on for this R1 and the PC.",
            failure.message,
        )
    }

    @Test
    fun tailnetDesktopDownWithoutUsbStillNamesTheTailnetHost() {
        net = VPN_UP
        usbUp = false
        serverUp = false
        val failure = assertFailsWith<OffloadException> {
            runBlocking { client(url = "http://desktop.example.ts.net:1").createJob(job, "{}") }
        }
        assertEquals(OffloadClient.SERVER_UNREACHABLE, failure.code)
        assertEquals(
            "Desktop server is not reachable at desktop.example.ts.net. Check that R1CORD Desktop is running, " +
                "and that Tailscale is on for this R1 and the PC.",
            failure.message,
        )
        assertTrue("with no USB to fall back to, the desktop is not probed first", probedServers.isEmpty())
    }

    // ---- tailnet server vs. USB fallback ----

    @Test
    fun tailnetUpButDesktopDownWithUsbPresentSendsTheJobOverUsbAndKeepsItThere() = withUsbServer { usb, usbUrl ->
        net = VPN_UP
        serverUp = false
        val tailnet = "http://desktop.example.ts.net:${server.port}"
        usb.enqueue(ok("""{"jobId":"job-1"}"""))
        usb.enqueue(ok("""{"received":0}"""))
        usb.enqueue(ok("""{"jobId":"job-1","status":"queued"}"""))
        val client = client(url = tailnet, usbUrl = usbUrl)
        assertEquals("job-1", runBlocking { client.createJob(job, "{}") }.jobId)

        serverUp = true // the PC's Tailscale comes back mid-upload; the job stays on USB
        runBlocking {
            client.received("job-1", "audio.m4a")
            client.commit("job-1")
        }
        assertEquals(3, usb.requestCount)
        assertEquals(0, server.requestCount)
        assertEquals("only the new job's route decision probes the desktop", listOf(tailnet), probedServers)
    }

    @Test
    fun tailnetDesktopReachableWithUsbPresentSendsTheJobOverTheTailnetAndKeepsItThere() = withUsbServer { usb, usbUrl ->
        net = VPN_UP
        serverUp = true
        server.enqueue(ok("""{"jobId":"job-1"}"""))
        server.enqueue(ok("""{"received":0}"""))
        val client = client(url = "http://desktop.example.ts.net:${server.port}", usbUrl = usbUrl)
        assertFalse(client.usingUsb())
        runBlocking { client.createJob(job, "{}") }

        serverUp = false // a later probe would pick USB, but the job is pinned to the tailnet
        runBlocking { client.received("job-1", "audio.m4a") }
        assertEquals(2, server.requestCount)
        assertEquals(0, usb.requestCount)
        assertTrue(client.usingUsb())
    }

    // ---- cancellation ----

    @Test
    fun cancellingTheCoroutineAbortsTheRequestWithCancellation() {
        val requestStarted = CountDownLatch(1)
        val release = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requestStarted.countDown()
                release.await(5, TimeUnit.SECONDS)
                return ok("""{"jobId":"late"}""")
            }
        }
        runBlocking {
            val deferred = async(Dispatchers.IO) { client().createJob(job, "{}") }
            assertTrue(requestStarted.await(5, TimeUnit.SECONDS))
            deferred.cancelAndJoin()
            assertTrue(deferred.isCancelled)
            assertFailsWith<CancellationException> { deferred.await() }
        }
        release.countDown()
    }

    private companion object {
        val ONLINE = NetSnapshot(vpnUp = false, nonVpnValidatedInternet = true)
        val OFFLINE = NetSnapshot(vpnUp = false, nonVpnValidatedInternet = false)
        val VPN_UP = NetSnapshot(vpnUp = true, nonVpnValidatedInternet = true)
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