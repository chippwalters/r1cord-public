package com.chippwalters.r1cord.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Meter fill color choice, extracted so the rule is testable without rendering. */
internal enum class BatteryTone { LOW, CHARGING, NORMAL }

/** Battery percentage clamped to the meter's 0..100 range. */
internal fun batteryLevel(percent: Int): Int = percent.coerceIn(0, 100)

/** Low battery always wins over charging; otherwise charging shows teal and idle white. */
internal fun batteryTone(level: Int, isCharging: Boolean): BatteryTone =
    if (level <= 15) BatteryTone.LOW else if (isCharging) BatteryTone.CHARGING else BatteryTone.NORMAL

/** Accessibility text spoken for the meter, e.g. "Battery 62 percent, charging". */
internal fun batteryDescription(level: Int, isCharging: Boolean): String =
    "Battery $level percent" + if (isCharging) ", charging" else ", not charging"

@Composable
fun BatteryStatus(percent: Int, isCharging: Boolean) {
    val level = batteryLevel(percent)
    val tone = batteryTone(level, isCharging)
    val fill = when (tone) {
        BatteryTone.LOW -> Orange
        BatteryTone.CHARGING -> Teal
        BatteryTone.NORMAL -> White
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        modifier = Modifier.semantics(mergeDescendants = true) {
            contentDescription = batteryDescription(level, isCharging)
        },
    ) {
        if (isCharging) Icon(Icons.Default.Bolt, null, Modifier.size(20.dp), tint = Teal)
        Text("$level%", fontFamily = RecorderLabelFace, fontSize = 17.sp, lineHeight = 21.sp, color = White)
        Canvas(Modifier.size(width = 32.dp, height = 17.dp)) {
            val stroke = 1.4.dp.toPx()
            val terminalWidth = 2.5.dp.toPx()
            val bodyWidth = size.width - terminalWidth - stroke
            drawRoundRect(White, topLeft = Offset(stroke / 2, stroke / 2),
                size = Size(bodyWidth, size.height - stroke), cornerRadius = CornerRadius(1.8.dp.toPx()),
                style = Stroke(stroke))
            drawRect(White, topLeft = Offset(bodyWidth + stroke, size.height * 0.3f),
                size = Size(terminalWidth, size.height * 0.4f))
            val inset = 3.dp.toPx()
            if (level > 0) drawRect(fill, topLeft = Offset(inset, inset),
                size = Size((bodyWidth - inset * 2) * level / 100f, size.height - inset * 2))
        }
    }
}
