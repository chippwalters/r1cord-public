package com.chippwalters.r1cord.ui

import com.chippwalters.r1cord.device.MaintenanceGate
import com.chippwalters.r1cord.storage.RecordingLibrary
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Uploads (Send and Send all) run under the maintenance gate via withUploadGate. */
@RunWith(RobolectricTestRunner::class)
class UploadGateTest {
    @Before @After fun clearGate() { MaintenanceGate.reset() }

    @Test
    fun uploadIsRefusedPolitelyDuringMaintenanceWithoutRunning() = runBlocking<Unit> {
        assertTrue(MaintenanceGate.beginMaintenance("installing an update"))
        var ran = false
        try {
            withUploadGate { ran = true }
            fail("an upload must not start during maintenance")
        } catch (expected: IllegalStateException) {
            assertEquals(RecordingLibrary.MAINTENANCE_MESSAGE, expected.message)
        }
        assertFalse(ran)
        MaintenanceGate.endMaintenance()
        assertFalse("a refused upload holds nothing", MaintenanceGate.isBusy())
    }

    @Test
    fun maintenanceWaitsForARunningUploadAndCanBeginOnceItIsCancelled() = runBlocking<Unit> {
        val started = CompletableDeferred<Unit>()
        val upload = launch(Dispatchers.Default) {
            withUploadGate {
                started.complete(Unit)
                awaitCancellation()
            }
        }
        started.await()
        assertTrue(MaintenanceGate.isBusy())
        assertFalse("maintenance must not start mid-upload", MaintenanceGate.beginMaintenance("installing an update"))

        upload.cancelAndJoin()
        assertFalse(MaintenanceGate.isBusy())
        assertTrue(MaintenanceGate.beginMaintenance("installing an update"))
    }

    @Test
    fun aFailedUploadReleasesTheGate() = runBlocking<Unit> {
        try {
            withUploadGate { throw IOException("Server unreachable.") }
            fail("the failure must propagate")
        } catch (expected: IOException) {
            assertEquals("Server unreachable.", expected.message)
        }
        assertFalse(MaintenanceGate.isBusy())
        assertTrue(MaintenanceGate.beginMaintenance("installing an update"))
    }
}
