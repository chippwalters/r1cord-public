package com.chippwalters.r1cord.ui

import java.util.Locale
import java.util.TimeZone
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Elapsed-time, remaining-storage, date and byte-size labels shown across the app. */
@RunWith(RobolectricTestRunner::class)
class UiFormattersTest {
    private val originalLocale = Locale.getDefault()
    private val originalZone = TimeZone.getDefault()

    @Before fun pinLocaleAndZone() {
        Locale.setDefault(Locale.US)
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
    }

    @After fun restoreLocaleAndZone() {
        Locale.setDefault(originalLocale)
        TimeZone.setDefault(originalZone)
    }

    @Test
    fun timerLabelFormatsZeroToOneDayAsHoursMinutesSeconds() {
        assertEquals("00:00:00", timerLabel(0))
        assertEquals("00:00:59", timerLabel(59_999))
        assertEquals("00:01:00", timerLabel(60_000))
        assertEquals("00:59:59", timerLabel(3_599_999))
        assertEquals("01:00:00", timerLabel(3_600_000))
        assertEquals("23:59:59", timerLabel(86_399_999))
        assertEquals("recordings past a day keep counting hours", "25:03:00", timerLabel(90_180_000))
    }

    @Test
    fun timerLabelNeverShowsNegativeTime() {
        assertEquals("00:00:00", timerLabel(-1))
        assertEquals("00:00:00", timerLabel(-90_000))
    }

    @Test
    fun storageLabelShowsSecondsOnlyUnderAMinute() {
        assertEquals("0s", storageLabel(0))
        assertEquals("59s", storageLabel(59))
        assertEquals("negative estimates read as zero", "0s", storageLabel(-10))
    }

    @Test
    fun storageLabelShowsHoursAndMinutesFromOneMinuteUp() {
        assertEquals("0h 1m", storageLabel(60))
        assertEquals("1h 0m", storageLabel(3_600))
        assertEquals("1h 59m", storageLabel(7_140))
        assertEquals("the quoted AAC estimate for ~110 GB free", "2360h 0m", storageLabel(2_360 * 3_600))
        assertEquals("the quoted WAV estimate for the same space", "320h 0m", storageLabel(320 * 3_600))
    }

    @Test
    fun dateLabelRendersMonthDayAndTwelveHourTime() {
        assertEquals("Jun 15 · 3:06 PM", dateLabel(1_750_000_000_000L))
    }

    @Test
    fun formatBytesPicksBytesKbOrMbAtTheBinaryBoundaries() {
        assertEquals("0 B", formatBytes(0))
        assertEquals("512 B", formatBytes(512))
        assertEquals("1023 B", formatBytes(1023))
        assertEquals("1.0 KB", formatBytes(1024))
        assertEquals("1.5 KB", formatBytes(1536))
        assertEquals("1024 KB stays in KB", "1024.0 KB", formatBytes(1024 * 1024 - 1))
        assertEquals("1.0 MB", formatBytes(1024 * 1024))
        assertEquals("1.5 MB", formatBytes(1_572_864))
        assertEquals("negative sizes read as zero", "0 B", formatBytes(-5))
    }
}
