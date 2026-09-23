package com.chippwalters.r1cord.sync

import org.junit.Assert.assertEquals
import org.junit.Test

class DeviceBadgeTest {
    @Test
    fun everyServerStatusMapsOntoOneOfTheFiveBadges() {
        assertEquals("local", deviceBadge(null))
        assertEquals("local", deviceBadge(""))
        assertEquals("sending", deviceBadge("uploading"))
        for (status in listOf("queued", "transcribing", "transcribed", "writing", "written", "publishing")) {
            assertEquals(status, "processing", deviceBadge(status))
        }
        assertEquals("done", deviceBadge("published"))
        assertEquals("done", deviceBadge("COMPLETE"))
        assertEquals("error", deviceBadge("error"))
        // A status this client does not know yet is still in flight, never "done".
        assertEquals("processing", deviceBadge("retrying"))
    }
}
