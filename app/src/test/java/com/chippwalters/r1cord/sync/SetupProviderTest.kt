package com.chippwalters.r1cord.sync

import java.net.InetAddress
import java.net.ServerSocket
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The setup provider's pure rules: who may call, what URLs/tokens/nonces/probes it accepts. */
class SetupProviderTest {
    private val nonce = "0123456789abcdef0123456789abcdef"
    private val token = "a".repeat(32) + "0123456789abcdef0123456789abcdef"

    @Test
    fun onlyRootAndShellMayCall() {
        assertTrue(isSetupCaller(0))
        assertTrue(isSetupCaller(2000))
        assertFalse("system server is not adb", isSetupCaller(1000))
        assertFalse("apps are refused", isSetupCaller(10123))
    }

    // ---- server URL ----

    @Test
    fun httpsHostUrlsAreAcceptedAndNormalized() {
        assertEquals("https://desktop.example.ts.net", validateServerUrl("https://Desktop.Example.ts.net"))
        assertEquals("https://desktop.example.ts.net", validateServerUrl(" https://desktop.example.ts.net/ "))
        assertEquals("https://desktop.example.ts.net:8443", validateServerUrl("https://desktop.example.ts.net:8443"))
    }

    @Test
    fun anythingBeyondSchemeAndHostIsRefused() {
        listOf(
            null,
            "",
            "http://desktop.example.ts.net",
            "desktop.example.ts.net",
            "https://",
            "https:///v1",
            "https://user:pass@desktop.example.ts.net",
            "https://@desktop.example.ts.net",
            "https://desktop.example.ts.net/v1",
            "https://desktop.example.ts.net//",
            "https://desktop.example.ts.net?x=1",
            "https://desktop.example.ts.net?",
            "https://desktop.example.ts.net#frag",
            "https://desktop.example.ts.net:",
            "https://desktop.example.ts.net:0",
            "https://desk top.example.ts.net",
            "https://desktop.example\n.ts.net",
            "https://desktop.example.ts.net\u0000",
        ).forEach { url -> assertNull("must refuse $url", validateServerUrl(url)) }
    }

    @Test
    fun serverNamesLoseControlCharactersAndAreCapped() {
        assertEquals("Studio PC", cleanServerName(" Studio\u0000 PC\n"))
        assertEquals("", cleanServerName(null))
        assertEquals(100, cleanServerName("x".repeat(500)).length)
    }

    // ---- nonce and token formats ----

    @Test
    fun noncesAreExactly32LowercaseHex() {
        assertTrue(isSetupNonce(nonce))
        assertFalse(isSetupNonce(nonce.uppercase()))
        assertFalse(isSetupNonce(nonce.dropLast(1)))
        assertFalse(isSetupNonce(nonce + "0"))
        assertFalse(isSetupNonce("0123456789abcdef0123456789abcdeg"))
    }

    @Test
    fun stagedTokensAreTrimmed64LowercaseHexWithinTheByteCap() {
        assertEquals(token, parseStagedToken(token.toByteArray()))
        assertEquals(token, parseStagedToken("  $token\r\n".toByteArray()))
        assertNull(parseStagedToken(token.uppercase().toByteArray()))
        assertNull(parseStagedToken(token.dropLast(1).toByteArray()))
        assertNull(parseStagedToken("$token\n$token".toByteArray()))
        assertNull(parseStagedToken(ByteArray(0)))
        assertNull("over the cap even if it trims to a token", parseStagedToken((" ".repeat(200) + token).toByteArray()))
    }

    // ---- staged token store ----

    @Test
    fun aStagedTokenIsReturnedOnce() {
        val store = StagedTokens(clock = { 0L })
        assertTrue(store.stage(nonce, token))
        assertEquals(token, store.consume(nonce))
        assertNull("one use", store.consume(nonce))
    }

    @Test
    fun aStagedTokenExpiresAfterFiveMinutes() {
        var now = 10_000L
        val store = StagedTokens(clock = { now })
        store.stage(nonce, token)
        now += 5 * 60_000L - 1
        assertEquals(token, store.consume(nonce))

        store.stage(nonce, token)
        now += 5 * 60_000L
        assertNull(store.consume(nonce))
    }

    @Test
    fun malformedStagingIsRefusedAndOtherNoncesDoNotMatch() {
        val store = StagedTokens(clock = { 0L })
        assertFalse(store.stage("short", token))
        assertFalse(store.stage(nonce, "not-a-token"))
        assertTrue(store.stage(nonce, token))
        assertNull(store.consume("ffffffffffffffffffffffffffffffff"))
        assertEquals(token, store.consume(nonce))
    }

    @Test
    fun theStoreKeepsOnlyTheNewestEntriesWhenFull() {
        val store = StagedTokens(clock = { 0L }, capacity = 2)
        val nonces = listOf("1", "2", "3").map { it.repeat(32) }
        nonces.forEach { store.stage(it, token) }
        assertNull(store.consume(nonces[0]))
        assertEquals(token, store.consume(nonces[1]))
        assertEquals(token, store.consume(nonces[2]))
    }

    // ---- probe targets ----

    @Test
    fun probeHostsMustBeTailscaleCgnatOrUlaLiterals() {
        assertNotNull(parseProbeHost("100.64.0.0"))
        assertNotNull(parseProbeHost("100.101.102.103"))
        assertNotNull(parseProbeHost("100.127.255.255"))
        assertNotNull(parseProbeHost("fd7a:115c:a1e0::1"))
        assertNotNull(parseProbeHost("[fd7a:115c:a1e0:ab12:4843:cd96:6258:b240]"))
        assertEquals(InetAddress.getByAddress(byteArrayOf(100, 101, 102, 103)), parseProbeHost("100.101.102.103"))
    }

    @Test
    fun anythingElseIsRefusedWithoutResolvingNames() {
        listOf(
            null,
            "",
            "100.63.255.255",
            "100.128.0.0",
            "10.0.0.1",
            "127.0.0.1",
            "100.064.0.1",
            "100.64.0",
            "100.64.0.1.5",
            "100.64.0.256",
            "fd7a:115c:a1e1::1",
            "fd7a:115c::1",
            "::1",
            "fd7a:115c:a1e0::1::2",
            "fd7a:115c:a1e0:0:0:0:0:0:1",
            "fd7a:115c:a1e0::1%wlan0",
            "desktop.example.ts.net",
            "localhost",
        ).forEach { host -> assertNull("must refuse $host", parseProbeHost(host)) }
    }

    @Test
    fun probePortsAreOneOrTwoValidPorts() {
        assertEquals(listOf(443), parseProbePorts("443"))
        assertEquals(listOf(443, 41641), parseProbePorts("443, 41641"))
        assertEquals(listOf(443), parseProbePorts("443,443"))
        assertEquals(listOf(1, 65535), parseProbePorts("1,65535"))
        listOf(null, "", "0", "65536", "443,80,22", "443,", "-1", "80a", "99999999999").forEach { spec ->
            assertNull("must refuse $spec", parseProbePorts(spec))
        }
    }

    @Test
    fun probeReportsOpenAndClosedPorts() {
        val loopback = InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))
        val closedPort = ServerSocket(0, 1, loopback).use { it.localPort }
        ServerSocket(0, 1, loopback).use { listener ->
            val results = probePorts(loopback, listOf(listener.localPort, closedPort), totalMs = 8_000L)
            assertEquals(listOf(listener.localPort, closedPort), results.keys.toList())
            assertEquals("open", results[listener.localPort])
            assertEquals("closed", results[closedPort])
        }
    }

    // ---- helper app trust ----

    @Test
    fun helperIsAbsentWhenNotInstalledAndUntrustedWithAnyOtherSigner() {
        assertEquals("absent", helperStatus(null))
        assertEquals("untrusted", helperStatus(emptyList()))
        assertEquals("untrusted", helperStatus(listOf(byteArrayOf(1, 2, 3))))
        assertEquals("untrusted", helperStatus(listOf(byteArrayOf(1), byteArrayOf(2))))
    }
}
