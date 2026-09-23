package com.chippwalters.r1cord.ui

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.chippwalters.r1cord.R

// Bundled typefaces: no network/font-provider dependency on the recorder.
val RecorderDisplayFace = FontFamily(
    Font(R.font.space_grotesk_regular, FontWeight.Normal),
    Font(R.font.space_grotesk_semibold, FontWeight.SemiBold),
    Font(R.font.space_grotesk_bold, FontWeight.Bold),
)
val RecorderLabelFace = FontFamily(
    Font(R.font.ibm_plex_mono_regular, FontWeight.Normal),
    Font(R.font.ibm_plex_mono_semibold, FontWeight.SemiBold),
)
val RecorderBodyFace = FontFamily(
    Font(R.font.hanken_grotesk_regular, FontWeight.Normal),
    Font(R.font.hanken_grotesk_semibold, FontWeight.SemiBold),
    Font(R.font.hanken_grotesk_bold, FontWeight.Bold),
)

// Sizing rationale (do not "tidy" these down again):
// The R1 panel is 480x640 px across ~2.88in => ~278 real ppi, but Android runs a 200dpi
// override (1dp = 1.25px). Text therefore renders 200/278 = 0.72x smaller than its sp
// value implies on a normal-density phone: a 14sp label is only ~1.6mm tall here.
// Sizes below are derived from the UI/ concept renders (1086x1448; 2.828 concept px per
// sp) for display/action text, with a hard ~16sp floor for secondary labels because the
// concepts' 11-13sp labels are physically unreadable on this panel.
val RecorderTypography = Typography(
    displayLarge = TextStyle(fontFamily = RecorderDisplayFace, fontWeight = FontWeight.Bold,
        fontSize = 64.sp, lineHeight = 72.sp, fontFeatureSettings = "tnum"),
    displayMedium = TextStyle(fontFamily = RecorderDisplayFace, fontWeight = FontWeight.Bold,
        fontSize = 50.sp, lineHeight = 58.sp, fontFeatureSettings = "tnum"),
    displaySmall = TextStyle(fontFamily = RecorderDisplayFace, fontWeight = FontWeight.Bold,
        fontSize = 40.sp, lineHeight = 47.sp, fontFeatureSettings = "tnum"),
    headlineLarge = TextStyle(fontFamily = RecorderDisplayFace, fontWeight = FontWeight.SemiBold,
        fontSize = 34.sp, lineHeight = 41.sp),
    headlineMedium = TextStyle(fontFamily = RecorderDisplayFace, fontWeight = FontWeight.SemiBold,
        fontSize = 30.sp, lineHeight = 37.sp),
    headlineSmall = TextStyle(fontFamily = RecorderDisplayFace, fontWeight = FontWeight.SemiBold,
        fontSize = 26.sp, lineHeight = 32.sp),
    titleLarge = TextStyle(fontFamily = RecorderDisplayFace, fontWeight = FontWeight.SemiBold,
        fontSize = 26.sp, lineHeight = 32.sp),
    titleMedium = TextStyle(fontFamily = RecorderDisplayFace, fontWeight = FontWeight.SemiBold,
        fontSize = 21.sp, lineHeight = 27.sp),
    titleSmall = TextStyle(fontFamily = RecorderDisplayFace, fontWeight = FontWeight.SemiBold,
        fontSize = 19.sp, lineHeight = 25.sp),
    bodyLarge = TextStyle(fontFamily = RecorderBodyFace, fontSize = 20.sp, lineHeight = 27.sp),
    bodyMedium = TextStyle(fontFamily = RecorderBodyFace, fontSize = 18.sp, lineHeight = 24.sp),
    bodySmall = TextStyle(fontFamily = RecorderLabelFace, fontSize = 16.sp, lineHeight = 22.sp),
    labelLarge = TextStyle(fontFamily = RecorderBodyFace, fontWeight = FontWeight.SemiBold,
        fontSize = 20.sp, lineHeight = 26.sp, letterSpacing = 1.sp),
    labelMedium = TextStyle(fontFamily = RecorderLabelFace, fontWeight = FontWeight.SemiBold,
        fontSize = 18.sp, lineHeight = 24.sp, letterSpacing = 1.sp),
    labelSmall = TextStyle(fontFamily = RecorderLabelFace, fontWeight = FontWeight.SemiBold,
        fontSize = 16.sp, lineHeight = 22.sp, letterSpacing = 0.5.sp),
)
