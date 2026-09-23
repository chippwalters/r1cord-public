package com.chippwalters.r1cord.storage

import com.chippwalters.r1cord.recording.RecorderSettings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Remaining-time math: for the same free space the Home estimate must show roughly
 * 2360 h of AAC against 320 h of WAV, the 64 MiB reserve is always subtracted, and the
 * estimate never goes negative or divides by zero.
 */
class RecordingLibraryMathTest {
    /** About 110 GB free, the sort of card these estimates were quoted on. */
    private val freeBytes = 110_595_827_712L
    private val reserve = RecordingLibrary.RESERVE_BYTES

    @Test
    fun aacEstimateIsAbout2360HoursFor110GbFree() {
        val seconds = recordableSeconds(freeBytes, RecorderSettings.bytesPerSecond(wav = false))
        assertTrue("AAC estimate was ${seconds / 3600.0} h", seconds in 2_359L * 3_600..2_362L * 3_600)
    }

    @Test
    fun wavEstimateIsAbout320HoursForTheSameSpace() {
        val seconds = recordableSeconds(freeBytes, RecorderSettings.bytesPerSecond(wav = true))
        assertTrue("WAV estimate was ${seconds / 3600.0} h", seconds in 318L * 3_600..321L * 3_600)
    }

    @Test
    fun wavEstimateShrinksProportionallyToItsHigherByteRate() {
        val aac = recordableSeconds(freeBytes, RecorderSettings.bytesPerSecond(wav = false))
        val wav = recordableSeconds(freeBytes, RecorderSettings.bytesPerSecond(wav = true))
        val ratio = aac.toDouble() / wav.toDouble()
        assertEquals(96_000.0 / 13_000.0, ratio, 0.01)
    }

    @Test
    fun the64MibReserveIsSubtractedBeforeEstimating() {
        assertEquals(2L, recordableSeconds(reserve + 13_000L * 2 + 5, 13_000L))
        assertEquals(1L, recordableSeconds(reserve + 13_000L, 13_000L))
        assertEquals("a nearly-full card records nothing", 0L, recordableSeconds(reserve + 12_999L, 13_000L))
        assertEquals(0L, recordableSeconds(reserve, 13_000L))
        assertEquals(0L, recordableSeconds(0L, 13_000L))
        assertEquals("negative free space clamps to zero", 0L, recordableSeconds(-1L, 13_000L))
    }

    @Test
    fun aDegenerateByteRateIsTreatedAsOneBytePerSecond() {
        assertEquals(freeBytes - reserve, recordableSeconds(freeBytes, 0L))
        assertEquals(freeBytes - reserve, recordableSeconds(freeBytes, -3L))
    }
}
