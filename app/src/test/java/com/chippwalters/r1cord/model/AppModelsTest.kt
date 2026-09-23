package com.chippwalters.r1cord.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Derived UI-model state: what counts as "capturing" and which recording is selected. */
class AppModelsTest {
    @Test
    fun everyNonIdleCaptureStateCountsAsCapturing() {
        assertFalse(AppUiState(capture = CaptureState(status = CaptureStatus.IDLE)).isCapturing)
        for (busy in listOf(CaptureStatus.STARTING, CaptureStatus.RECORDING, CaptureStatus.AUTO_LISTENING, CaptureStatus.PAUSED, CaptureStatus.STOPPING)) {
            assertTrue("$busy must keep navigation and playback locked out",
                AppUiState(capture = CaptureState(status = busy)).isCapturing)
        }
    }

    @Test
    fun selectedReturnsTheRecordingMatchingTheSelectedId() {
        val first = RecordingItem("a", "First", 1L)
        val second = RecordingItem("b", "Second", 2L)
        val state = AppUiState(recordings = listOf(first, second), selectedId = "b")
        assertEquals(second, state.selected)
        assertNull(AppUiState(recordings = listOf(first), selectedId = "missing").selected)
        assertNull("no selection yields no detail", AppUiState(recordings = listOf(first)).selected)
    }
}
