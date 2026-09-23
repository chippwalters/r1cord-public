package com.chippwalters.r1cord.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/** Battery meter formatting rules extracted from the BatteryStatus composable. */
class BatteryFormatTest {
    @Test
    fun percentageClampsToTheMeterRange() {
        assertEquals(0, batteryLevel(-5))
        assertEquals(0, batteryLevel(0))
        assertEquals(62, batteryLevel(62))
        assertEquals(100, batteryLevel(100))
        assertEquals(100, batteryLevel(150))
    }

    @Test
    fun lowBatteryWinsOverCharging() {
        assertEquals(BatteryTone.LOW, batteryTone(0, isCharging = false))
        assertEquals(BatteryTone.LOW, batteryTone(15, isCharging = true))
        assertEquals(BatteryTone.CHARGING, batteryTone(16, isCharging = true))
        assertEquals(BatteryTone.NORMAL, batteryTone(16, isCharging = false))
        assertEquals(BatteryTone.CHARGING, batteryTone(100, isCharging = true))
        assertEquals(BatteryTone.NORMAL, batteryTone(100, isCharging = false))
    }

    @Test
    fun accessibilityDescriptionNamesLevelAndChargeState() {
        assertEquals("Battery 62 percent, not charging", batteryDescription(62, isCharging = false))
        assertEquals("Battery 62 percent, charging", batteryDescription(62, isCharging = true))
        assertEquals("Battery 0 percent, not charging", batteryDescription(0, isCharging = false))
        assertEquals("Battery 100 percent, charging", batteryDescription(100, isCharging = true))
    }
}
