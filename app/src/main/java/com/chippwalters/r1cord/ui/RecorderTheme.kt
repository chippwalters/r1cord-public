package com.chippwalters.r1cord.ui

import androidx.compose.material3.darkColorScheme
import androidx.compose.ui.graphics.Color

// BRAND.md Part2: exact Toolmaker-Noir colors, shared by every native screen/dialog.
internal val Orange = Color(0xFFFE4023)
internal val Teal = Color(0xFF3FBBA9)
internal val Ink = Color(0xFF0E1013)
internal val Panel = Color(0xFF1B1F25)
internal val Recessed = Color(0xFF0C0E11)
internal val Compact = Color(0xFF171B20)
internal val Muted = Color(0xFFA7ADB6)
internal val White = Color(0xFFF3F4F5)
internal val Border = Color(0xFF2B3037)
internal val InnerBorder = Color(0xFF23282E)
internal val RecorderColors = darkColorScheme(
    primary = Orange, onPrimary = Ink, primaryContainer = Orange.copy(alpha = 0.14f), onPrimaryContainer = White,
    secondary = Teal, onSecondary = Ink, secondaryContainer = Teal.copy(alpha = 0.12f), onSecondaryContainer = Teal,
    tertiary = Teal, onTertiary = Ink, tertiaryContainer = Teal.copy(alpha = 0.12f), onTertiaryContainer = White,
    background = Ink, onBackground = White, surface = Panel, onSurface = White,
    surfaceVariant = Recessed, onSurfaceVariant = Muted, surfaceTint = Color.Transparent,
    surfaceContainerLowest = Recessed, surfaceContainerLow = Compact, surfaceContainer = Panel,
    surfaceContainerHigh = InnerBorder, surfaceContainerHighest = Border,
    outline = Border, outlineVariant = InnerBorder, scrim = Ink,
    error = Orange, onError = Ink, errorContainer = Orange.copy(alpha = 0.14f), onErrorContainer = White,
    inverseSurface = White, inverseOnSurface = Ink, inversePrimary = Orange,
)
