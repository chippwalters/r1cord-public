package com.chippwalters.r1cord.device

import com.chippwalters.r1cord.device.DeviceControls.Bind
import com.chippwalters.r1cord.device.DeviceControls.Result
import com.chippwalters.r1cord.device.DeviceControls.Status
import com.chippwalters.r1cord.device.DeviceControls.Trust
import org.junit.Assert.assertEquals
import org.junit.Test

/** Pure rules of the device-controls client: helper result codes, handshake and signer pinning. */
class DeviceControlsTest {
    private val pin = DeviceControls.HELPER_CERT_SHA256
    private val otherCert = "0000000000000000000000000000000000000000000000000000000000000001"

    @Test
    fun resultCodesFollowTheAidlContract() {
        assertEquals(Result.ACCEPTED, DeviceControls.resultForCode(0))
        assertEquals(Result.REFUSED, DeviceControls.resultForCode(1))
        assertEquals(Result.DENIED, DeviceControls.resultForCode(2))
        assertEquals(Result.ERROR, DeviceControls.resultForCode(3))
    }

    @Test
    fun unknownOrMissingCodesAreErrorsNeverSuccess() {
        assertEquals(Result.ERROR, DeviceControls.resultForCode(null))
        assertEquals(Result.ERROR, DeviceControls.resultForCode(-1))
        assertEquals(Result.ERROR, DeviceControls.resultForCode(4))
    }

    @Test
    fun onlyTheMatchingApiVersionIsReady() {
        assertEquals(Status.READY, DeviceControls.statusForApiVersion(1))
        assertEquals(Status.DENIED, DeviceControls.statusForApiVersion(2)) // caller rejected
        assertEquals(Status.DENIED, DeviceControls.statusForApiVersion(3))
        assertEquals(Status.DENIED, DeviceControls.statusForApiVersion(0))
    }

    @Test
    fun unansweredHandshakeIsRetryableNotDenied() {
        // Timeout, RemoteException or a dead binder must not lock the helper out.
        assertEquals(Status.CONNECTING, DeviceControls.statusForApiVersion(null))
    }

    @Test
    fun connectBindsWhenUnboundWhateverTheLastStatus() {
        for (status in Status.values()) {
            assertEquals(Bind.BIND, DeviceControls.bindAction(bound = false, status = status, stalled = false))
            assertEquals(Bind.BIND, DeviceControls.bindAction(bound = false, status = status, stalled = true))
        }
    }

    @Test
    fun connectRebindsABoundHelperThatDeniedUsOrStalled() {
        assertEquals(Bind.REBIND, DeviceControls.bindAction(bound = true, status = Status.DENIED, stalled = false))
        // Handshake unanswered, or the helper disconnected and Android has not rebound it.
        assertEquals(Bind.REBIND, DeviceControls.bindAction(bound = true, status = Status.CONNECTING, stalled = true))
    }

    @Test
    fun connectLeavesAReadyOrInFlightBindAlone() {
        assertEquals(Bind.NONE, DeviceControls.bindAction(bound = true, status = Status.READY, stalled = false))
        assertEquals(Bind.NONE, DeviceControls.bindAction(bound = true, status = Status.CONNECTING, stalled = false))
    }

    @Test
    fun certDigestIsLowercaseZeroPaddedSha256() {
        // FIPS 180-2 vectors; "abc" contains 0x01 and bytes >= 0x80.
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            DeviceControls.certSha256Hex("abc".toByteArray()))
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            DeviceControls.certSha256Hex(ByteArray(0)))
    }

    @Test
    fun helperIsTrustedOnlyWithOnePinnedSigner() {
        assertEquals(Trust.TRUSTED, DeviceControls.trustOf(listOf(pin)))
        assertEquals(Trust.TRUSTED, DeviceControls.trustOf(listOf(pin.uppercase())))
        assertEquals(Trust.UNTRUSTED, DeviceControls.trustOf(listOf(otherCert)))
        assertEquals(Trust.UNTRUSTED, DeviceControls.trustOf(listOf(pin, otherCert)))
        assertEquals(Trust.UNTRUSTED, DeviceControls.trustOf(emptyList()))
        assertEquals(Trust.UNTRUSTED, DeviceControls.trustOf(null))
    }
}
