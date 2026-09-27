package com.chippwalters.r1cord.controls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CallerCheckTest {
    private val pin = CallerCheck.R1CORD_CERT_SHA256
    private val otherCert = "0000000000000000000000000000000000000000000000000000000000000001"

    private fun lookup(vararg digests: String): (String) -> List<String>? = { digests.toList() }

    @Test fun allowsR1cordSignedWithPinnedCert() {
        assertTrue(CallerCheck.isAllowed(arrayOf("com.chippwalters.r1cord"), lookup(pin)))
    }

    @Test fun pinComparisonIgnoresHexCase() {
        assertTrue(CallerCheck.isAllowed(arrayOf("com.chippwalters.r1cord"), lookup(pin.uppercase())))
    }

    @Test fun rejectsOtherPackageEvenWithPinnedCert() {
        assertFalse(CallerCheck.isAllowed(arrayOf("com.example.other"), lookup(pin)))
        assertFalse(CallerCheck.isAllowed(arrayOf("com.chippwalters.r1cord.debug"), lookup(pin)))
    }

    @Test fun rejectsSharedUidListingSeveralPackages() {
        assertFalse(CallerCheck.isAllowed(arrayOf("com.chippwalters.r1cord", "com.example.other"), lookup(pin)))
        assertFalse(CallerCheck.isAllowed(arrayOf("com.example.other", "com.chippwalters.r1cord"), lookup(pin)))
    }

    @Test fun rejectsUnknownUid() {
        assertFalse(CallerCheck.isAllowed(null, lookup(pin)))
        assertFalse(CallerCheck.isAllowed(emptyArray(), lookup(pin)))
    }

    @Test fun rejectsWrongCertificate() {
        assertFalse(CallerCheck.isAllowed(arrayOf("com.chippwalters.r1cord"), lookup(otherCert)))
    }

    @Test fun rejectsMultipleSignersEvenWhenOneMatches() {
        assertFalse(CallerCheck.isAllowed(arrayOf("com.chippwalters.r1cord"), lookup(pin, otherCert)))
    }

    @Test fun rejectsUnreadableOrMissingSigner() {
        assertFalse(CallerCheck.isAllowed(arrayOf("com.chippwalters.r1cord"), signerDigests = { null }))
        assertFalse(CallerCheck.isAllowed(arrayOf("com.chippwalters.r1cord"), lookup()))
        assertFalse(CallerCheck.isAllowed(arrayOf("com.chippwalters.r1cord"),
            signerDigests = { throw IllegalStateException("gone") }))
    }

    @Test fun onlyLooksUpTheExpectedPackage() {
        val asked = mutableListOf<String>()
        CallerCheck.isAllowed(arrayOf("com.chippwalters.r1cord"), signerDigests = { pkg -> asked += pkg; listOf(pin) })
        CallerCheck.isAllowed(arrayOf("com.example.other"), signerDigests = { pkg -> asked += pkg; listOf(pin) })
        assertEquals(listOf("com.chippwalters.r1cord"), asked)
    }

    @Test fun sha256HexIsLowercaseAndZeroPadded() {
        // FIPS 180-2 test vector; the digest contains 0x01 and bytes >= 0x80.
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            CallerCheck.sha256Hex("abc".toByteArray()))
    }
}
