package com.chippwalters.r1cord.ui

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AddAPhoto
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CloudUpload
import androidx.compose.material.icons.filled.DeleteOutline
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.Forward10
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.OpenInNew
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Replay10
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import com.chippwalters.r1cord.R
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.chippwalters.r1cord.camera.CameraScreen
import com.chippwalters.r1cord.model.AppUiState
import com.chippwalters.r1cord.model.CaptureStatus
import com.chippwalters.r1cord.model.PhotoItem
import com.chippwalters.r1cord.model.RecordingItem
import com.chippwalters.r1cord.model.Screen
import com.chippwalters.r1cord.model.SendResultUi
import com.chippwalters.r1cord.model.UploadUiState
import com.chippwalters.r1cord.sync.OffloadSettings
import com.chippwalters.r1cord.sync.deviceBadge
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.roundToInt

private val Wordmark = buildAnnotatedString {
    append("R")
    withStyle(SpanStyle(color = Orange)) { append("1") }
    append("CORD")
}
private val Shape = RoundedCornerShape(18.dp)

@Composable
fun R1cordUi(model: R1cordViewModel, onSettings: () -> Unit) {
    val state by model.state.collectAsStateWithLifecycle()
    MaterialTheme(colorScheme = RecorderColors, typography = RecorderTypography) {
        Surface(modifier = Modifier.fillMaxSize(), color = Ink) {
            when (state.screen) {
                Screen.HOME -> HomeScreen(state, model, onSettings)
                Screen.RECORDING -> RecordingScreen(state, model)
                Screen.LIBRARY -> LibraryScreen(state, model)
                Screen.DETAIL -> DetailScreen(state, model)
                Screen.CAMERA -> CameraHost(state, model)
            }
            state.message?.let { message ->
                AlertDialog(
                    onDismissRequest = model::dismissMessage,
                    title = { Text("R1CORD") },
                    text = { Text(message) },
                    confirmButton = {
                        TextButton(onClick = model::dismissMessage, modifier = control("Dismiss message")) {
                            Text("OK")
                        }
                    },
                )
            }
            state.sendSheetFor?.let { id ->
                val item = state.recordings.firstOrNull { it.id == id }
                if (item == null) model.closeSendSheet()
                else SendSheet(item, model)
            }
            state.upload?.let { upload -> UploadProgressDialog(upload, model::cancelUpload) }
            state.sendResult?.let { result -> SendResultDialog(result, model) }
        }
    }
}

@Composable
private fun HomeScreen(state: AppUiState, model: R1cordViewModel, onSettings: () -> Unit) {
    var volumeOpen by remember { mutableStateOf(false) }
    Column(
        modifier = Modifier.fillMaxSize().padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Icon(painterResource(R.drawable.ic_wave_mark), null, tint = Orange, modifier = Modifier.size(40.dp))
            Spacer(Modifier.width(10.dp))
            Column(modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
                Text(Wordmark, fontFamily = RecorderDisplayFace, fontSize = 26.sp, lineHeight = 32.sp,
                    fontWeight = FontWeight.SemiBold, letterSpacing = (-0.65).sp)
                Text("CAPTURE WHAT MATTERS", color = Muted, fontFamily = RecorderLabelFace,
                    fontSize = 15.sp, lineHeight = 20.sp, letterSpacing = 0.2.sp, maxLines = 1)
            }
            BatteryStatus(state.batteryPercent, state.isCharging)
        }
        Button(
            onClick = model::startStop,
            enabled = !state.capture.isBusy(),
            modifier = control(if (state.isCapturing) "Stop recording" else "Start recording")
                .fillMaxWidth().weight(1f).heightIn(min = 92.dp),
            shape = Shape,
            colors = ButtonDefaults.buttonColors(containerColor = Orange, contentColor = White),
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(if (state.isCapturing) Icons.Default.Stop else Icons.Default.Mic, null, Modifier.size(48.dp))
                Text(if (state.isCapturing) "STOP RECORDING" else "START RECORDING",
                    fontFamily = RecorderLabelFace, fontSize = 30.sp, lineHeight = 36.sp,
                    letterSpacing = 2.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
            }
        }
        StorageCard(state.storageSeconds)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            ActionButton(
                label = "LIBRARY", description = "Open recording library",
                icon = Icons.Default.FolderOpen, onClick = model::openLibrary,
                modifier = Modifier.weight(1f),
            )
            ActionButton(
                label = "VOLUME", description = "Adjust playback volume",
                icon = Icons.Default.VolumeUp, onClick = { volumeOpen = true },
                modifier = Modifier.weight(1f),
            )
            IconButton(onClick = onSettings, modifier = Modifier.size(48.dp)) {
                Icon(Icons.Default.Settings, contentDescription = "Recorder settings", tint = White)
            }
        }
        LocalStatus()
    }
    if (volumeOpen) {
        AlertDialog(
            onDismissRequest = { volumeOpen = false },
            title = { Text("Playback volume") },
            text = { VolumeControl(state.volume, state.volumeMax, model::setVolume) },
            confirmButton = { TextButton(onClick = { volumeOpen = false }, modifier = control("Close volume")) { Text("Done") } },
        )
    }
}

@Composable
private fun RecordingScreen(state: AppUiState, model: R1cordViewModel) {
    val capture = state.capture
    val item = state.recordings.firstOrNull { it.id == capture.recordingId }
    Column(
        Modifier.fillMaxSize().padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Header(if (capture.status == CaptureStatus.RECORDING) "RECORDING" else captureLabel(capture.status), state.batteryPercent, state.isCharging)
        Column(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            ElapsedTimer(capture.elapsedMs)
            Text(
                if (capture.status == CaptureStatus.AUTO_LISTENING) "SILENCE SKIPPED"
                else item?.title?.uppercase(Locale.getDefault()) ?: "Preparing recording…",
                color = if (capture.status == CaptureStatus.AUTO_LISTENING) Teal else Muted,
                fontFamily = RecorderLabelFace, fontSize = 18.sp, letterSpacing = 0.5.sp,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        MonoMeter(if (capture.status == CaptureStatus.RECORDING || capture.status == CaptureStatus.AUTO_LISTENING) capture.level else 0f)
        StorageCard(state.storageSeconds, compact = true)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ActionButton(
                if (capture.status == CaptureStatus.PAUSED) "RESUME" else "PAUSE",
                if (capture.status == CaptureStatus.PAUSED) "Resume recording" else "Pause recording",
                if (capture.status == CaptureStatus.PAUSED) Icons.Default.PlayArrow else Icons.Default.Pause,
                model::pauseResume, Modifier.weight(1f), enabled = !capture.isBusy() && state.isCapturing,
                stacked = true,
            )
            ActionButton("STOP", "Stop recording", Icons.Default.Stop, model::startStop,
                Modifier.weight(1f), primary = true, enabled = !capture.isBusy() && state.isCapturing, stacked = true)
            ActionButton("PHOTO", "Open camera", Icons.Default.CameraAlt, model::openCamera,
                Modifier.weight(1f), enabled = !capture.isBusy() && capture.recordingId != null, stacked = true)
        }
    }
}

@Composable
private fun LibraryScreen(state: AppUiState, model: R1cordViewModel) {
    val hasLocal = state.recordings.any { it.status == "SAVED" && deviceBadge(it.jobStatus) == "local" }
    val sendEnabled = state.paired && hasLocal && !state.isCapturing && state.upload == null
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Header("LIBRARY", state.batteryPercent, state.isCharging)
        Text("${state.recordings.size} ${if (state.recordings.size == 1) "recording" else "recordings"} · local files", color = Muted, fontSize = 18.sp)
        if (state.recordings.isEmpty()) {
            Column(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(Icons.Default.Mic, null, Modifier.size(56.dp), tint = Orange)
                Text("Nothing recorded yet", fontSize = 26.sp, modifier = Modifier.padding(top = 12.dp))
                Text("Start a recording from Home.", color = Muted)
            }
        } else {
            LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(state.recordings, key = { it.id }) { recording ->
                    Surface(
                        shape = Shape, color = Panel,
                        modifier = control("Open recording ${recording.title}")
                            .fillMaxWidth().clickable { model.openRecording(recording.id) },
                    ) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                            Text(recording.title.uppercase(Locale.getDefault()), fontFamily = RecorderLabelFace,
                                fontSize = 20.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.5.sp,
                                maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically) {
                                Text("${timerLabel(recording.durationMs)} · ${recording.photos.size} ${if (recording.photos.size == 1) "photo" else "photos"}",
                                    color = Muted, fontFamily = RecorderLabelFace, fontSize = 17.sp,
                                    modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                                // A sent recording's job state is the more useful status; local ones keep Saved.
                                if (deviceBadge(recording.jobStatus) != "local") JobBadge(recording.jobStatus)
                                else SavedStatus(recording.status)
                            }
                        }
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ActionButton("REFRESH", "Refresh send status", Icons.Default.Refresh, model::refreshStatuses,
                Modifier.weight(1f), enabled = state.paired && !state.refreshing && state.upload == null)
            ActionButton("SEND ALL", "Send all local recordings", Icons.Default.CloudUpload, model::sendAll,
                Modifier.weight(1f), enabled = sendEnabled)
        }
        ActionButton("BACK HOME", "Back home", Icons.Default.Home, model::home,
            Modifier.fillMaxWidth(), primary = true)
        LocalStatus()
    }
}

@Composable
private fun DetailScreen(state: AppUiState, model: R1cordViewModel) {
    val item = state.selected
    if (item == null) {
        Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.Center) {
            Text("Recording is no longer available.")
            ActionButton("DONE", "Done", Icons.Default.Check, model::back, Modifier.fillMaxWidth(), primary = true)
        }
        return
    }
    var confirmDelete by remember(item.id) { mutableStateOf(false) }
    var galleryPhotoId by remember(item.id) { mutableStateOf<String?>(null) }
    var deletePhotoId by remember(item.id) { mutableStateOf<String?>(null) }
    val playback = state.playback
    val duration = if (playback.recordingId == item.id && playback.durationMs > 0) playback.durationMs else item.durationMs
    val position = if (playback.recordingId == item.id) playback.positionMs.coerceIn(0, duration.coerceAtLeast(0)) else 0L
    val playing = playback.recordingId == item.id && playback.isPlaying
    var dragging by remember(item.id) { mutableStateOf<Float?>(null) }
    val canPlay = item.audioUri.isNotBlank() && duration > 0 && !state.isCapturing
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Header("RECORDING DETAIL", state.batteryPercent, state.isCharging)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(item.title.uppercase(Locale.getDefault()), fontFamily = RecorderDisplayFace,
                fontSize = 30.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(dateLabel(item.createdAt), color = Muted, fontFamily = RecorderLabelFace, fontSize = 17.sp)
                SavedStatus(item.status)
            }
            Surface(shape = Shape, color = Panel) {
                Column(Modifier.fillMaxWidth().padding(12.dp)) {
                    Waveform(item.waveform, if (duration > 0) (dragging ?: position.toFloat()) / duration else 0f)
                    Slider(
                        value = (dragging ?: position.toFloat()).coerceIn(0f, duration.coerceAtLeast(1).toFloat()),
                        onValueChange = { dragging = it },
                        onValueChangeFinished = {
                            dragging?.let { model.seek(it.toLong()) }
                            dragging = null
                        },
                        valueRange = 0f..duration.coerceAtLeast(1).toFloat(),
                        enabled = canPlay,
                        modifier = control("Playback position").fillMaxWidth(),
                    )
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(timerLabel(dragging?.toLong() ?: position), color = Teal, fontFamily = RecorderLabelFace, fontSize = 17.sp)
                        Text(timerLabel(duration), color = Muted, fontFamily = RecorderLabelFace, fontSize = 17.sp)
                    }
                    Spacer(Modifier.height(8.dp))
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        ActionButton("−10", "Skip back 10 seconds", Icons.Default.Replay10,
                            { model.skip(-10_000) }, Modifier.weight(1f), enabled = canPlay)
                        ActionButton(if (playing) "PAUSE" else "PLAY", if (playing) "Pause playback" else "Play recording",
                            if (playing) Icons.Default.Pause else Icons.Default.PlayArrow,
                            model::playPause, Modifier.weight(1.3f), primary = true, enabled = canPlay)
                        ActionButton("+10", "Skip forward 10 seconds", Icons.Default.Forward10,
                            { model.skip(10_000) }, Modifier.weight(1f), enabled = canPlay)
                    }
                }
            }
            VolumeControl(state.volume, state.volumeMax, model::setVolume)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween) {
                Text("ATTACHED PHOTOS · ${item.photos.size}", color = Muted, fontFamily = RecorderLabelFace,
                    fontSize = 17.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.5.sp)
            }
            if (item.photos.isEmpty()) {
                Text("No photos attached.", color = Muted, fontSize = 17.sp)
            } else {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    itemsIndexed(item.photos, key = { _, photo -> photo.id }) { index, photo ->
                        Box(Modifier.size(96.dp).clip(RoundedCornerShape(12.dp))
                            .clickable { galleryPhotoId = photo.id }
                            .semantics { contentDescription = "Open photo ${index + 1}" }) {
                            LocalPhoto(photo, 240, Modifier.fillMaxSize(), ContentScale.Crop)
                        }
                    }
                }
                Text("Tap a photo to enlarge or delete it.", color = Muted, fontSize = 17.sp)
            }
            ActionButton("ADD PHOTO", "Add photo to recording", Icons.Default.AddAPhoto,
                model::openCamera, Modifier.fillMaxWidth(), enabled = !state.capture.isBusy())
            Text("Files: Download/R1CORD/${item.id}",
                color = Muted, fontSize = 17.sp)
            if (deviceBadge(item.jobStatus) != "local") {
                JobBadge(item.jobStatus)
            }
            if (!item.webdavUrl.isNullOrBlank()) {
                ActionButton("OPEN SUMMARY", "Open published summary", Icons.Default.OpenInNew,
                    { model.openUrl(item.webdavUrl) }, Modifier.fillMaxWidth())
            }
            if (deviceBadge(item.jobStatus) != "local") {
                TextButton(
                    onClick = model::refreshStatuses,
                    enabled = state.paired && !state.refreshing && state.upload == null,
                    modifier = control("Refresh send status").fillMaxWidth(),
                ) { Text(if (state.refreshing) "REFRESHING…" else "REFRESH") }
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ActionButton("SEND", "Send recording to desktop", Icons.Default.CloudUpload,
                { model.openSendSheet(item.id) }, Modifier.weight(1f), stacked = true,
                enabled = !state.isCapturing && item.status == "SAVED" && state.upload == null)
            ActionButton("DELETE", "Delete recording", Icons.Default.DeleteOutline, { confirmDelete = true },
                Modifier.weight(1f), stacked = true, enabled = !state.isCapturing)
            ActionButton("DONE", "Done", Icons.Default.Check, model::back, Modifier.weight(1f), primary = true, stacked = true)
        }
    }
    if (confirmDelete) {
        DeleteDialog(
            title = "Delete this recording?",
            message = "Deletes this recording and all ${item.photos.size} attached photos from this device. Manual USB copies cannot be verified. Make sure you have copied anything you need. Files already copied to a computer are not deleted.",
            onCancel = { confirmDelete = false },
            onConfirm = { confirmDelete = false; model.deleteRecording(item.id) },
            description = "Confirm delete recording",
        )
    }
    galleryPhotoId?.let { id ->
        val index = item.photos.indexOfFirst { it.id == id }
        if (index >= 0) {
            PhotoGallery(
                photos = item.photos, index = index,
                batteryPercent = state.batteryPercent, isCharging = state.isCharging,
                onSelect = { galleryPhotoId = it }, onClose = { galleryPhotoId = null },
                onDelete = { deletePhotoId = id },
            )
        }
    }
    deletePhotoId?.let { id ->
        DeleteDialog(
            title = "Delete this photo?",
            message = "Deletes this photo from this device only. The audio is kept. Manual USB copies cannot be verified; files already copied to a computer are not deleted.",
            onCancel = { deletePhotoId = null },
            onConfirm = {
                deletePhotoId = null
                galleryPhotoId = null
                model.deletePhoto(item.id, id)
            },
            description = "Confirm delete photo",
        )
    }
}

@Composable
private fun CameraHost(state: AppUiState, model: R1cordViewModel) {
    val id = state.capture.recordingId.takeIf { state.isCapturing } ?: state.selectedId
    if (id == null) {
        Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.Center) {
            Text("Select or start a recording to attach photos.")
            ActionButton("BACK", "Back from camera", Icons.Default.Check, model::back, Modifier.fillMaxWidth())
        }
        return
    }
    val item = state.recordings.firstOrNull { it.id == id }
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            CameraScreen(
                recordingId = id, recordingActive = state.isCapturing,
                elapsedMs = if (state.isCapturing) state.capture.elapsedMs else item?.durationMs ?: 0L,
                photoCount = item?.photos?.size ?: 0,
                batteryPercent = state.batteryPercent, isCharging = state.isCharging,
                onPhoto = model::photoCaptured, onBack = model::back, onError = model::showError,
            )
        }
        ActionButton(
            label = if (state.isCapturing) "${captureLabel(state.capture.status)} · STOP" else "START RECORDING",
            description = if (state.isCapturing) "Stop recording" else "Start recording",
            icon = if (state.isCapturing) Icons.Default.Stop else Icons.Default.Mic,
            onClick = model::startStop, modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
            primary = true, enabled = !state.capture.isBusy(),
        )
    }
}

@Composable
private fun Header(title: String, battery: Int, isCharging: Boolean) {
    Row(Modifier.fillMaxWidth().heightIn(min = 40.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, fontFamily = RecorderDisplayFace, fontSize = 22.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp,
            modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        BatteryStatus(battery, isCharging)
    }
}


@Composable
private fun LocalStatus() {
    Text("LOCAL RECORDINGS", color = Teal, fontFamily = RecorderLabelFace, fontSize = 16.sp, letterSpacing = 1.sp,
        textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
}

@Composable
private fun StorageCard(seconds: Long, compact: Boolean = false) {
    Surface(shape = Shape, color = Panel, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = if (compact) 10.dp else 14.dp)) {
            Text("REMAINING TIME", color = Muted, fontFamily = RecorderLabelFace, fontWeight = FontWeight.SemiBold,
                fontSize = 16.sp, lineHeight = 22.sp, letterSpacing = 1.sp)
            Text(storageLabel(seconds), fontSize = if (compact) 40.sp else 50.sp,
                lineHeight = if (compact) 46.sp else 58.sp,
                fontFamily = RecorderDisplayFace, fontWeight = FontWeight.Bold, color = White)
            if (!compact) Text("ON DEVICE STORAGE", color = Muted, fontFamily = RecorderLabelFace,
                fontSize = 15.sp, lineHeight = 20.sp, letterSpacing = 0.5.sp)
        }
    }
}

@Composable
private fun VolumeControl(volume: Int, maximum: Int, onChange: (Int) -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        Text("MEDIA VOLUME  ${volume.coerceIn(0, maximum.coerceAtLeast(0))} / ${maximum.coerceAtLeast(0)}",
            color = Muted, fontFamily = RecorderLabelFace, fontSize = 17.sp, letterSpacing = 0.5.sp)
        Slider(
            value = volume.coerceIn(0, maximum.coerceAtLeast(0)).toFloat(),
            onValueChange = { onChange(it.roundToInt()) },
            valueRange = 0f..maximum.coerceAtLeast(1).toFloat(),
            steps = (maximum - 1).coerceAtLeast(0), enabled = maximum > 0,
            modifier = control("Media volume").fillMaxWidth(),
        )
    }
}

@Composable
private fun ElapsedTimer(ms: Long) {
    val label = remember(ms / 1_000) { timerLabel(ms) }
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val fontSize = (maxWidth.value / ((label.length - 2) * 0.62f + 0.6f)).coerceAtMost(80f)
        Text(label, style = MaterialTheme.typography.displayLarge, fontSize = fontSize.sp, lineHeight = (fontSize * 1.12f).sp,
            maxLines = 1, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth()
                .semantics { contentDescription = "Elapsed $label" })
    }
}

@Composable
private fun MonoMeter(level: Float) {
    val amplitude = if (level.isFinite()) level.coerceIn(0f, 1f) else 0f
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Text("MONO INPUT", color = Muted, fontFamily = RecorderLabelFace, fontSize = 17.sp, letterSpacing = 1.sp)
        Canvas(Modifier.fillMaxWidth().height(20.dp)
            .semantics { contentDescription = "Microphone level ${(amplitude * 100).roundToInt()} percent" }) {
            val count = 28
            val gap = 3.dp.toPx()
            val width = (size.width - (count - 1) * gap) / count
            repeat(count) { index ->
                val active = amplitude > index.toFloat() / count
                drawRoundRect(
                    color = if (active) Orange else Border,
                    topLeft = Offset(index * (width + gap), 0f),
                    size = androidx.compose.ui.geometry.Size(width, size.height),
                    cornerRadius = androidx.compose.ui.geometry.CornerRadius(2.dp.toPx()),
                )
            }
        }
    }
}

@Composable
private fun Waveform(envelope: List<Float>, progress: Float) {
    if (envelope.isEmpty()) {
        Box(Modifier.fillMaxWidth().height(60.dp), contentAlignment = Alignment.Center) {
            Text("Waveform unavailable", color = Muted, fontSize = 16.sp)
        }
        return
    }
    val peaks = remember(envelope) {
        val count = minOf(envelope.size, 80)
        FloatArray(count) { bar ->
            val from = bar * envelope.size / count
            val end = ((bar + 1) * envelope.size / count).coerceAtLeast(from + 1)
            var peak = 0f
            for (index in from until end) {
                val sample = envelope[index]
                if (sample.isFinite()) peak = maxOf(peak, sample.coerceIn(0f, 1f))
            }
            peak
        }
    }
    Canvas(Modifier.fillMaxWidth().height(60.dp).semantics { contentDescription = "Recorded audio waveform" }) {
        val bars = peaks.size
        val spacing = size.width / bars
        repeat(bars) { bar ->
            val x = (bar + 0.5f) * spacing
            val half = peaks[bar] * size.height * 0.45f
            drawLine(
                color = if (bar.toFloat() / bars < progress) Orange else Muted.copy(alpha = 0.5f),
                start = Offset(x, size.height / 2 - half), end = Offset(x, size.height / 2 + half),
                strokeWidth = 2.dp.toPx(), cap = StrokeCap.Round,
            )
        }
        val playhead = progress.coerceIn(0f, 1f) * size.width
        drawLine(Teal, Offset(playhead, 0f), Offset(playhead, size.height), strokeWidth = 1.dp.toPx())
    }
}

@Composable
internal fun JobBadge(status: String) {
    val badge = deviceBadge(status)
    if (badge == "local") return
    val color = when (badge) {
        "done", "processing" -> Teal
        else -> Orange
    }
    Text(badge.uppercase(Locale.ROOT), fontSize = 16.sp, color = color, fontWeight = FontWeight.SemiBold)
}

@Composable
private fun SendSheet(item: RecordingItem, model: R1cordViewModel) {
    val context = LocalContext.current
    var title by remember(item.id) { mutableStateOf(item.title) }
    var summarize by remember(item.id) { mutableStateOf(OffloadSettings.defaultSummarize(context)) }
    var publish by remember(item.id) { mutableStateOf(OffloadSettings.defaultPublish(context)) }
    var style by remember(item.id) { mutableStateOf(OffloadSettings.defaultStyle(context)) }
    AlertDialog(
        onDismissRequest = model::closeSendSheet,
        title = { Text("Send recording") },
        text = {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(
                    value = title,
                    onValueChange = { if (it.length <= 120) title = it },
                    label = { Text("Title") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("Summarize", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                    Switch(checked = summarize, onCheckedChange = { summarize = it })
                }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("Publish", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                    Switch(checked = publish, onCheckedChange = { publish = it })
                }
                StylePicker(style) { style = it }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { model.send(item.id, title, summarize, publish, style) },
                enabled = title.trim().isNotEmpty(),
                modifier = control("Send recording"),
            ) { Text("SEND") }
        },
        dismissButton = {
            TextButton(onClick = model::closeSendSheet, modifier = control("Cancel send")) { Text("CANCEL") }
        },
    )
}

@Composable
internal fun StylePicker(selected: String, onSelect: (String) -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        listOf("notes" to "Notes", "minutes" to "Minutes", "article" to "Article").forEach { (value, label) ->
            Button(
                onClick = { onSelect(value) },
                modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 4.dp, vertical = 8.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (selected == value) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.surfaceContainer,
                    contentColor = if (selected == value) MaterialTheme.colorScheme.onPrimary
                    else MaterialTheme.colorScheme.onSurface,
                ),
            ) { Text(label, style = MaterialTheme.typography.titleSmall, maxLines = 1) }
        }
    }
}

@Composable
private fun UploadProgressDialog(upload: UploadUiState, onCancel: () -> Unit) {
    val ratio = if (upload.bytesTotal > 0) (upload.bytesSent.toFloat() / upload.bytesTotal).coerceIn(0f, 1f) else 0f
    Dialog(
        onDismissRequest = {},
        properties = DialogProperties(dismissOnBackPress = false, dismissOnClickOutside = false, usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Ink) {
            Column(
                Modifier.fillMaxSize().padding(24.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("SENDING", fontFamily = RecorderDisplayFace, fontSize = 22.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp)
                Text(upload.phase, fontFamily = RecorderBodyFace, fontSize = 20.sp, textAlign = TextAlign.Center)
                LinearProgressIndicator(
                    progress = { ratio },
                    modifier = Modifier.fillMaxWidth().height(8.dp),
                    color = Orange,
                    trackColor = Border,
                )
                Text(
                    "${formatBytes(upload.bytesSent)} / ${formatBytes(upload.bytesTotal)}",
                    color = Muted, fontFamily = RecorderLabelFace, fontSize = 17.sp,
                )
                ActionButton("CANCEL", "Cancel upload", Icons.Default.Stop, onCancel, Modifier.fillMaxWidth())
            }
        }
    }
}

@Composable
private fun SendResultDialog(result: SendResultUi, model: R1cordViewModel) {
    AlertDialog(
        onDismissRequest = model::dismissSendResult,
        title = { Text("Sent") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Sent. Your summary will appear at the link in a few minutes.")
                if (!result.webdavUrl.isNullOrBlank()) {
                    SelectionContainer {
                        Text(result.webdavUrl, color = Teal, fontFamily = RecorderLabelFace, fontSize = 16.sp)
                    }
                }
            }
        },
        confirmButton = {
            if (!result.webdavUrl.isNullOrBlank()) {
                TextButton(
                    onClick = { model.openUrl(result.webdavUrl) },
                    modifier = control("Open summary"),
                ) { Text("OPEN") }
            }
        },
        dismissButton = {
            TextButton(onClick = model::dismissSendResult, modifier = control("Dismiss send result")) { Text("DONE") }
        },
    )
}

@Composable
private fun SavedStatus(status: String) {
    val label = when (status.uppercase(Locale.ROOT)) {
        "SAVED", "COMPLETED" -> "Saved"
        "INTERRUPTED" -> "Interrupted"
        "RECORDING" -> "Recording"
        "PAUSED" -> "Paused"
        else -> status.lowercase(Locale.ROOT).replaceFirstChar { it.uppercase() }
    }
    Text(label, fontSize = 16.sp, color = if (label == "Saved") Teal else Orange,
        fontWeight = FontWeight.SemiBold)
}

@Composable
private fun ActionButton(
    label: String,
    description: String,
    icon: ImageVector,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    primary: Boolean = false,
    enabled: Boolean = true,
    stacked: Boolean = false,
) {
    Button(
        onClick = onClick, enabled = enabled,
        modifier = modifier.then(control(description)).heightIn(min = if (stacked) 86.dp else 56.dp),
        shape = RoundedCornerShape(14.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp, vertical = 8.dp),
        colors = ButtonDefaults.buttonColors(containerColor = if (primary) Orange else Panel,
            contentColor = if (primary) Ink else White),
    ) {
        if (stacked) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(icon, null, Modifier.size(32.dp))
                Text(label, fontFamily = RecorderBodyFace, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.8.sp, maxLines = 1)
            }
        } else {
            Icon(icon, null, Modifier.size(24.dp))
            Spacer(Modifier.width(6.dp))
            Text(label, fontFamily = RecorderBodyFace, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.8.sp, maxLines = 1)
        }
    }
}

@Composable
private fun DeleteDialog(title: String, message: String, description: String, onCancel: () -> Unit, onConfirm: () -> Unit) {
    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text(title) }, text = { Text(message) },
        confirmButton = {
            TextButton(onClick = onConfirm, modifier = control(description)) { Text("DELETE", color = Orange) }
        },
        dismissButton = {
            TextButton(onClick = onCancel, modifier = control("Cancel deletion")) { Text("CANCEL") }
        },
    )
}

@Composable
private fun PhotoGallery(photos: List<PhotoItem>, index: Int, batteryPercent: Int, isCharging: Boolean, onSelect: (String) -> Unit, onClose: () -> Unit, onDelete: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = Ink) {
            Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Header("PHOTO ${index + 1} / ${photos.size}", batteryPercent, isCharging)
                LocalPhoto(photos[index], 1280, Modifier.weight(1f).fillMaxWidth(), ContentScale.Fit)
                Text(dateLabel(photos[index].createdAt), color = Muted, fontSize = 16.sp)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { onSelect(photos[index - 1].id) }, enabled = index > 0,
                        modifier = control("Previous photo").weight(1f)) { Text("PREVIOUS") }
                    TextButton(onClick = { onSelect(photos[index + 1].id) }, enabled = index < photos.lastIndex,
                        modifier = control("Next photo").weight(1f)) { Text("NEXT") }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ActionButton("DELETE", "Delete photo", Icons.Default.DeleteOutline, onDelete, Modifier.weight(1f))
                    ActionButton("DONE", "Close photo gallery", Icons.Default.Check, onClose, Modifier.weight(1f), primary = true)
                }
            }
        }
    }
}

@Composable
private fun LocalPhoto(photo: PhotoItem, target: Int, modifier: Modifier, scale: ContentScale) {
    val resolver = LocalContext.current.contentResolver
    val loaded by produceState<Result<Bitmap>?>(null, photo.uri, target) {
        value = null
        value = withContext(Dispatchers.IO) { runCatching { loadPhoto(resolver, photo.uri, target) } }
    }
    val bitmap = loaded?.getOrNull()
    Box(modifier.background(Panel), contentAlignment = Alignment.Center) {
        if (bitmap != null) {
            val image = remember(bitmap) { bitmap.asImageBitmap() }
            Image(image, contentDescription = "Attached photo", modifier = Modifier.fillMaxSize(), contentScale = scale)
        } else {
            Text(if (loaded == null) "Loading…" else "Photo unavailable", color = Muted,
                fontSize = 16.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(8.dp))
        }
    }
}

private fun loadPhoto(resolver: ContentResolver, value: String, target: Int): Bitmap {
    val uri = Uri.parse(value)
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    val boundsStream = resolver.openInputStream(uri) ?: error("Photo cannot be opened")
    boundsStream.use { BitmapFactory.decodeStream(it, null, bounds) }
    require(bounds.outWidth > 0 && bounds.outHeight > 0) { "Invalid photo" }
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= target) sample *= 2
    val options = BitmapFactory.Options().apply { inSampleSize = sample }
    val bitmap = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
        ?: error("Photo cannot be decoded")
    val orientation = resolver.openInputStream(uri)?.use {
        ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
    } ?: ExifInterface.ORIENTATION_NORMAL
    val matrix = Matrix()
    when (orientation) {
        ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
        ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
        ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.setScale(1f, -1f)
        ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.setRotate(90f); matrix.postScale(-1f, 1f) }
        ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
        ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.setRotate(270f); matrix.postScale(-1f, 1f) }
        ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(270f)
    }
    if (matrix.isIdentity) return bitmap
    return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true).also {
        if (it !== bitmap) bitmap.recycle()
    }
}

private fun control(description: String): Modifier = Modifier.heightIn(min = 48.dp)
    .semantics { contentDescription = description }

private fun com.chippwalters.r1cord.model.CaptureState.isBusy(): Boolean =
    status == CaptureStatus.STARTING || status == CaptureStatus.STOPPING

private fun captureLabel(status: CaptureStatus): String = when (status) {
    CaptureStatus.IDLE -> "READY"
    CaptureStatus.STARTING -> "STARTING…"
    CaptureStatus.RECORDING -> "REC"
    CaptureStatus.AUTO_LISTENING -> "LISTENING"
    CaptureStatus.PAUSED -> "PAUSED"
    CaptureStatus.STOPPING -> "SAVING…"
}

private fun timerLabel(ms: Long): String {
    val seconds = ms.coerceAtLeast(0) / 1_000
    return String.format(Locale.ROOT, "%02d:%02d:%02d", seconds / 3_600, seconds / 60 % 60, seconds % 60)
}

private fun storageLabel(seconds: Long): String {
    val safe = seconds.coerceAtLeast(0)
    return if (safe < 60) "${safe}s" else "${safe / 3_600}h ${safe / 60 % 60}m"
}

private fun dateLabel(timestamp: Long): String =
    SimpleDateFormat("MMM d · h:mm a", Locale.getDefault()).format(Date(timestamp))

private fun formatBytes(bytes: Long): String {
    val value = bytes.coerceAtLeast(0)
    return when {
        value < 1024 -> "$value B"
        value < 1024 * 1024 -> String.format(Locale.ROOT, "%.1f KB", value / 1024.0)
        else -> String.format(Locale.ROOT, "%.1f MB", value / (1024.0 * 1024.0))
    }
}
