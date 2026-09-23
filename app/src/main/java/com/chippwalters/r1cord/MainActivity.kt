package com.chippwalters.r1cord

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.view.KeyEvent
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import com.chippwalters.r1cord.device.PowerMenuService
import com.chippwalters.r1cord.recording.RecorderSettings
import com.chippwalters.r1cord.model.Screen
import com.chippwalters.r1cord.sync.OffloadSettings
import com.chippwalters.r1cord.ui.BatteryStatus
import com.chippwalters.r1cord.ui.R1cordUi
import com.chippwalters.r1cord.ui.R1cordViewModel
import com.chippwalters.r1cord.ui.RecorderColors
import com.chippwalters.r1cord.ui.RecorderTypography
import com.chippwalters.r1cord.ui.ReviewToggles
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private lateinit var model: R1cordViewModel
    private val handler = Handler(Looper.getMainLooper())
    private var settingsOpen by mutableStateOf(false)
    private var lastSidePress = 0L
    private var wasRecording = false
    private val dim = Runnable {
        if (::model.isInitialized && model.state.value.isCapturing && model.state.value.screen != Screen.CAMERA && !settingsOpen) {
            window.attributes = window.attributes.apply { screenBrightness = 0.07f }
        }
    }
    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        if (result[Manifest.permission.RECORD_AUDIO] == false) model.showError("Microphone permission denied. Recording is unavailable until permission is granted.")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        model = ViewModelProvider(this)[R1cordViewModel::class.java]
        volumeControlStream = AudioManager.STREAM_MUSIC
        val firstRun = getSharedPreferences("app_preferences", MODE_PRIVATE)
        if (!firstRun.getBoolean("volume_initialized", false)) {
            model.setVolume(1)
            firstRun.edit().putBoolean("volume_initialized", true).apply()
        }
        hideSystemBars()
        setContent {
            R1cordUi(model = model, onSettings = {
                if (model.state.value.isCapturing) model.showError("Stop recording before opening settings.")
                else {
                    (application as R1cordApplication).playback.stop()
                    settingsOpen = true
                }
            })
            BackHandler(enabled = !settingsOpen) { model.back() }
            if (settingsOpen) RecorderSettingsDialog()
        }
        lifecycleScope.launch {
            model.state.collect { state ->
                if (state.isCapturing != wasRecording) {
                    wasRecording = state.isCapturing
                    if (wasRecording) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    brighten()
                }
            }
        }
        val needed = arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA, Manifest.permission.POST_NOTIFICATIONS)
            .filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (needed.isNotEmpty()) permissions.launch(needed.toTypedArray())
        if (savedInstanceState == null) openPageFrom(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openPageFrom(intent)
    }

    /** The "Sent" notification lands here with the published page URL to show in the in-app viewer. */
    private fun openPageFrom(intent: Intent?) {
        val url = intent?.getStringExtra(EXTRA_PAGE_URL)?.takeIf { it.isNotBlank() } ?: return
        intent.removeExtra(EXTRA_PAGE_URL)
        settingsOpen = false
        model.openPage(url)
    }

    override fun onResume() {
        super.onResume()
        hideSystemBars()
        brighten()
    }
    override fun onPause() { handler.removeCallbacks(dim); super.onPause() }
    override fun onDestroy() { handler.removeCallbacksAndMessages(null); super.onDestroy() }
    override fun onUserInteraction() { super.onUserInteraction(); brighten() }

    private fun brighten() {
        window.attributes = window.attributes.apply { screenBrightness = 0.65f }
        handler.removeCallbacks(dim)
        handler.postDelayed(dim, 30_000L)
    }
    private fun hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (isRecorderKey(keyCode)) {
            if (event.repeatCount == 0 && !settingsOpen) {
                val now = SystemClock.elapsedRealtime()
                if (now - lastSidePress >= 350L) { lastSidePress = now; brighten(); model.startStop() }
            }
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean =
        if (isRecorderKey(keyCode)) true else super.onKeyUp(keyCode, event)

    private fun isRecorderKey(keyCode: Int) = keyCode == KeyEvent.KEYCODE_F1 ||
        keyCode == KeyEvent.KEYCODE_HEADSETHOOK || keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE

    @Composable private fun RecorderSettingsDialog() {
        var error by remember { mutableStateOf<String?>(null) }
        var confirmPowerOff by remember { mutableStateOf(false) }
        val batteryUi by model.state.collectAsState()
        fun openSystemPage(action: String) {
            runCatching { startActivity(Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                .onFailure { error = it.message ?: "Android could not open this settings page." }
        }
        MaterialTheme(colorScheme = RecorderColors, typography = RecorderTypography) {
            AlertDialog(
                onDismissRequest = { settingsOpen = false },
                title = {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                            BatteryStatus(batteryUi.batteryPercent, batteryUi.isCharging)
                        }
                        Text("Settings", style = MaterialTheme.typography.titleLarge)
                    }
                },
                text = {
                    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        var noiseCancel by remember { mutableStateOf(RecorderSettings.noiseCancellation(this@MainActivity)) }
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text("Noise cancelling", style = MaterialTheme.typography.titleMedium,
                                modifier = Modifier.weight(1f))
                            Switch(checked = noiseCancel, onCheckedChange = {
                                noiseCancel = it
                                RecorderSettings.setNoiseCancellation(this@MainActivity, it)
                            })
                        }
                        var vox by remember { mutableStateOf(RecorderSettings.voiceActivatedPausing(this@MainActivity)) }
                        var sens by remember { mutableStateOf(RecorderSettings.vadSensitivity(this@MainActivity)) }
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text("Voice pausing", style = MaterialTheme.typography.titleMedium,
                                modifier = Modifier.weight(1f))
                            Switch(checked = vox, onCheckedChange = {
                                vox = it
                                RecorderSettings.setVoiceActivatedPausing(this@MainActivity, it)
                            })
                        }
                        if (vox) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            listOf("Quiet", "Normal", "Noisy").forEachIndexed { index, label ->
                                Button(
                                    onClick = {
                                        sens = index
                                        RecorderSettings.setVadSensitivity(this@MainActivity, index)
                                    },
                                    modifier = Modifier.weight(1f),
                                    contentPadding = PaddingValues(horizontal = 4.dp, vertical = 8.dp),
                                    colors = ButtonDefaults.buttonColors(
                                        containerColor = if (sens == index) MaterialTheme.colorScheme.primary
                                        else MaterialTheme.colorScheme.surfaceContainer,
                                        contentColor = if (sens == index) MaterialTheme.colorScheme.onPrimary
                                        else MaterialTheme.colorScheme.onSurface),
                                ) { Text(label, style = MaterialTheme.typography.titleSmall, maxLines = 1) }
                            }
                        }
                        var wav by remember { mutableStateOf(RecorderSettings.wavOutput(this@MainActivity)) }
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text("Use WAV", style = MaterialTheme.typography.titleMedium)
                                Text("Larger files (7.4x)", style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            Switch(checked = wav, onCheckedChange = {
                                wav = it
                                RecorderSettings.setWavOutput(this@MainActivity, it)
                            })
                        }
                        Text("Desktop server", style = MaterialTheme.typography.titleMedium)
                        var serverUrl by remember { mutableStateOf(OffloadSettings.serverUrl(this@MainActivity)) }
                        OutlinedTextField(
                            value = serverUrl,
                            onValueChange = {
                                serverUrl = it
                                OffloadSettings.setServerUrl(this@MainActivity, it)
                            },
                            label = { Text("Server URL") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                            modifier = Modifier.fillMaxWidth(),
                        )
                        if (batteryUi.paired) {
                            Text(
                                "Paired with ${batteryUi.serverName.ifBlank { "desktop server" }}",
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            Button(
                                onClick = { model.unpair() },
                                modifier = Modifier.fillMaxWidth(),
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = MaterialTheme.colorScheme.surfaceContainer,
                                    contentColor = MaterialTheme.colorScheme.onSurface,
                                ),
                            ) { Text("Unpair") }
                        } else {
                            var pairCode by remember { mutableStateOf("") }
                            val pairing = batteryUi.pairing
                            OutlinedTextField(
                                value = pairCode,
                                onValueChange = { pairCode = it.filter { ch -> ch.isDigit() }.take(6) },
                                label = { Text("6-digit code") },
                                singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                                modifier = Modifier.fillMaxWidth(),
                            )
                            Button(
                                onClick = { model.pair(pairCode) },
                                enabled = pairCode.length == 6 && serverUrl.trim().isNotEmpty() && pairing?.busy != true,
                                modifier = Modifier.fillMaxWidth(),
                            ) { Text(if (pairing?.busy == true) "Pairing…" else "Pair") }
                            pairing?.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                            pairing?.serverName?.let { Text("Paired with $it", style = MaterialTheme.typography.bodyMedium) }
                        }
                        var reviews by remember { mutableStateOf(OffloadSettings.defaultReviews(this@MainActivity)) }
                        var publish by remember { mutableStateOf(OffloadSettings.defaultPublish(this@MainActivity)) }
                        Text("Default AI reviews", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        ReviewToggles(reviews, longLabels = true) {
                            reviews = it
                            OffloadSettings.setDefaultReviews(this@MainActivity, it)
                        }
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text("Publish", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                            Switch(checked = publish, onCheckedChange = {
                                publish = it
                                OffloadSettings.setDefaultPublish(this@MainActivity, it)
                            })
                        }
                        Button(onClick = { openSystemPage(Settings.ACTION_HOME_SETTINGS) }, modifier = Modifier.fillMaxWidth()) { Text("Home app") }
                        Button(onClick = {
                            error = null
                            if (model.state.value.isCapturing) error = "Stop recording first."
                            else confirmPowerOff = true
                        }, modifier = Modifier.fillMaxWidth(),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = MaterialTheme.colorScheme.surfaceContainer,
                                contentColor = MaterialTheme.colorScheme.onSurface)) { Text("Power off") }
                        Text("R1CORD ${BuildConfig.VERSION_NAME}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (error != null) Text(error!!, color = MaterialTheme.colorScheme.error)
                    }
                },
                confirmButton = { TextButton(onClick = { settingsOpen = false }) { Text("Done") } },
            )
            if (confirmPowerOff) AlertDialog(
                onDismissRequest = { confirmPowerOff = false },
                title = { Text("Power off?") },
                text = {
                    Text(
                        if (PowerMenuService.isEnabled(this@MainActivity)) "The Android power menu opens next."
                        else "Enable R1CORD power menu in Accessibility first.",
                    )
                },
                confirmButton = {
                    Button(onClick = {
                        confirmPowerOff = false
                        if (PowerMenuService.showPowerMenu()) settingsOpen = false
                        else {
                            error = "Power menu blocked. Enable R1CORD in Accessibility."
                            openSystemPage(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                        }
                    }) { Text(if (PowerMenuService.isEnabled(this@MainActivity)) "Open power menu" else "Open Accessibility") }
                },
                dismissButton = { TextButton(onClick = { confirmPowerOff = false }) { Text("Cancel") } },
            )
        }
    }

    companion object {
        const val EXTRA_PAGE_URL = "com.chippwalters.r1cord.extra.PAGE_URL"
    }
}
