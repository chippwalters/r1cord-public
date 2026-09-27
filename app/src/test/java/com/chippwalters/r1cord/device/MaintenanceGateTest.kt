package com.chippwalters.r1cord.device

import com.chippwalters.r1cord.device.MaintenanceGate.Work
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class MaintenanceGateTest {
    private var now = 1_000L

    @Before
    fun setUp() {
        MaintenanceGate.reset()
        MaintenanceGate.clock = { now }
    }

    @After
    fun tearDown() {
        MaintenanceGate.reset()
    }

    @Test
    fun overlappingWorkIsCountedAndOnlyIdleAfterEveryEnd() {
        assertTrue(MaintenanceGate.tryBegin(Work.UPLOAD))
        assertTrue(MaintenanceGate.tryBegin(Work.UPLOAD))
        assertEquals(2, MaintenanceGate.state.value.active[Work.UPLOAD])

        MaintenanceGate.end(Work.UPLOAD)
        assertTrue("one upload is still running", MaintenanceGate.isBusy())
        MaintenanceGate.end(Work.UPLOAD)
        assertFalse(MaintenanceGate.isBusy())
        assertNull(MaintenanceGate.busyReason())
    }

    @Test
    fun anUnbalancedEndNeverGoesBelowZero() {
        MaintenanceGate.end(Work.CAPTURE)
        assertTrue(MaintenanceGate.tryBegin(Work.CAPTURE))
        assertTrue("the stray end must not have absorbed this capture", MaintenanceGate.isBusy())
        MaintenanceGate.end(Work.CAPTURE)
        MaintenanceGate.end(Work.CAPTURE)
        assertFalse(MaintenanceGate.isBusy())
        assertTrue(MaintenanceGate.beginMaintenance("install"))
    }

    @Test
    fun busyReasonNamesTheMostDisruptiveWork() {
        MaintenanceGate.tryBegin(Work.LIBRARY_WRITE)
        assertEquals("Saving files.", MaintenanceGate.busyReason())
        MaintenanceGate.tryBegin(Work.UPLOAD)
        assertEquals("Upload in progress.", MaintenanceGate.busyReason())
        MaintenanceGate.tryBegin(Work.CAPTURE)
        assertEquals("Recording in progress.", MaintenanceGate.busyReason())
    }

    @Test
    fun maintenanceIsRefusedWhileAnyWorkIsActive() {
        MaintenanceGate.tryBegin(Work.CAPTURE)
        assertFalse(MaintenanceGate.beginMaintenance("install"))
        assertFalse(MaintenanceGate.state.value.maintenance)

        MaintenanceGate.end(Work.CAPTURE)
        assertTrue(MaintenanceGate.beginMaintenance("install"))
        val state = MaintenanceGate.state.value
        assertTrue(state.maintenance)
        assertEquals("install", state.maintenanceReason)
    }

    @Test
    fun workIsRefusedAndNotRecordedDuringMaintenance() {
        assertTrue(MaintenanceGate.beginMaintenance("install"))
        assertFalse(MaintenanceGate.tryBegin(Work.CAPTURE))
        assertFalse(MaintenanceGate.tryBegin(Work.UPLOAD))
        assertTrue(MaintenanceGate.state.value.active.isEmpty())
        assertFalse(MaintenanceGate.isBusy())

        MaintenanceGate.endMaintenance()
        assertFalse(MaintenanceGate.state.value.maintenance)
        assertTrue(MaintenanceGate.tryBegin(Work.CAPTURE))
    }

    @Test
    fun maintenanceExpiresAtItsTimeout() {
        assertTrue(MaintenanceGate.beginMaintenance("install", timeoutMs = 60_000L))
        now += 59_999L
        assertFalse(MaintenanceGate.tryBegin(Work.UPLOAD))
        assertTrue(MaintenanceGate.snapshot().maintenance)

        now += 1L
        assertFalse("expired maintenance must not block anything", MaintenanceGate.snapshot().maintenance)
        assertTrue(MaintenanceGate.tryBegin(Work.UPLOAD))
        assertNull(MaintenanceGate.state.value.maintenanceReason)
    }

    @Test
    fun beginningAgainRenewsTheExpiry() {
        assertTrue(MaintenanceGate.beginMaintenance("install", timeoutMs = 1_000L))
        now += 900L
        assertTrue(MaintenanceGate.beginMaintenance("second install", timeoutMs = 1_000L))
        now += 900L
        assertFalse(MaintenanceGate.tryBegin(Work.CAPTURE))
        assertEquals("second install", MaintenanceGate.state.value.maintenanceReason)
    }
}
