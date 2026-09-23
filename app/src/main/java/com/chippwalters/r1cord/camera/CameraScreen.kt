package com.chippwalters.r1cord.camera

import android.Manifest
import android.content.pm.PackageManager
import android.util.Size
import android.view.Surface
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.chippwalters.r1cord.ui.BatteryStatus
import com.chippwalters.r1cord.ui.Ink
import com.chippwalters.r1cord.ui.White
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Observer
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.io.File
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asExecutor

/** Preview and still capture only: the audio recorder keeps sole ownership of the microphone. */
@Composable
fun CameraScreen(
    recordingId: String,
    recordingActive: Boolean,
    elapsedMs: Long,
    photoCount: Int,
    batteryPercent: Int,
    isCharging: Boolean,
    onPhoto: (String, File) -> Unit,
    onBack: () -> Unit,
    onError: (String) -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val photoCallback by rememberUpdatedState(onPhoto)
    val errorCallback by rememberUpdatedState(onError)
    val mainExecutor = remember(context) { ContextCompat.getMainExecutor(context) }
    val ioExecutor = remember { Dispatchers.IO.asExecutor() }
    val previewView = remember(context) {
        PreviewView(context).apply {
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            scaleType = PreviewView.ScaleType.FIT_CENTER
        }
    }
    val imageCapture = remember(recordingId) {
        ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
            .setJpegQuality(90)
            .setResolutionSelector(
                ResolutionSelector.Builder().setResolutionStrategy(
                    ResolutionStrategy(Size(1920, 1440), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER)
                ).build()
            )
            .build()
    }
    var ready by remember(recordingId) { mutableStateOf(false) }
    var capturing by remember(recordingId) { mutableStateOf(false) }
    var cameraError by remember(recordingId) { mutableStateOf<String?>(null) }
    val hasPermission = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
    val alive = remember(recordingId, lifecycleOwner, hasPermission, previewView, imageCapture) { AtomicBoolean(false) }

    DisposableEffect(recordingId, lifecycleOwner, hasPermission, previewView, imageCapture) {
        alive.set(true)
        ready = false
        capturing = false
        var provider: ProcessCameraProvider? = null
        var preview: Preview? = null
        var cameraState: androidx.lifecycle.LiveData<CameraState>? = null
        var stateObserver: Observer<CameraState>? = null
        if (!hasPermission) {
            cameraError = "Camera permission is required. Grant Camera permission in Android Settings, then reopen Camera."
            errorCallback(cameraError!!)
        } else {
            val providerFuture = ProcessCameraProvider.getInstance(context)
            providerFuture.addListener({
                if (alive.get()) {
                    try {
                        val cameraProvider = providerFuture.get()
                        provider = cameraProvider
                        val selector = when {
                            cameraProvider.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA) -> CameraSelector.DEFAULT_BACK_CAMERA
                            cameraProvider.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA) -> CameraSelector.DEFAULT_FRONT_CAMERA
                            else -> {
                                val available = cameraProvider.availableCameraInfos.firstOrNull()
                                    ?: error("Android exposes no supported CameraX camera.")
                                CameraSelector.Builder().addCameraFilter { cameras -> cameras.filter { it == available } }.build()
                            }
                        }
                        val rotation = previewView.display?.rotation ?: Surface.ROTATION_0
                        imageCapture.targetRotation = rotation
                        val cameraPreview = Preview.Builder().setTargetRotation(rotation).build().also {
                            it.setSurfaceProvider(previewView.surfaceProvider)
                        }
                        preview = cameraPreview
                        val camera = cameraProvider.bindToLifecycle(lifecycleOwner, selector, cameraPreview, imageCapture)
                        val observer = Observer<CameraState> { state ->
                            if (alive.get()) {
                                ready = state.type == CameraState.Type.OPEN && state.error == null
                                val failure = state.error
                                if (failure != null) {
                                    val message = "Camera unavailable (Android camera error ${failure.code}). Close Camera and try again."
                                    if (cameraError != message) {
                                        cameraError = message
                                        errorCallback(message)
                                    }
                                } else if (ready) {
                                    cameraError = null
                                }
                            }
                        }
                        cameraState = camera.cameraInfo.cameraState
                        stateObserver = observer
                        camera.cameraInfo.cameraState.observe(lifecycleOwner, observer)
                    } catch (error: Exception) {
                        ready = false
                        cameraError = "Cannot open camera: ${error.cause?.message ?: error.message ?: "unknown camera error"}"
                        errorCallback(cameraError!!)
                    }
                }
            }, mainExecutor)
        }
        onDispose {
            alive.set(false)
            ready = false
            stateObserver?.let { cameraState?.removeObserver(it) }
            preview?.let { provider?.unbind(it, imageCapture) }
        }
    }

    fun capturePhoto() {
        if (!ready || capturing) return
        capturing = true
        val captureRecordingId = recordingId
        val capturePhotoCallback = photoCallback
        val captureErrorCallback = errorCallback
        val rotation = previewView.display?.rotation ?: Surface.ROTATION_0
        ioExecutor.execute {
            val file = try {
                File.createTempFile("r1cord-photo-", ".jpg", context.cacheDir)
            } catch (error: Exception) {
                mainExecutor.execute {
                    if (alive.get()) capturing = false
                    captureErrorCallback("Cannot create photo: ${error.message ?: "storage unavailable"}")
                }
                return@execute
            }
            mainExecutor.execute {
                if (!alive.get()) {
                    ioExecutor.execute { file.delete() }
                    captureErrorCallback("Photo was not saved: Camera closed before capture started.")
                } else {
                    try {
                        imageCapture.targetRotation = rotation
                        imageCapture.takePicture(ImageCapture.OutputFileOptions.Builder(file).build(), ioExecutor,
                            object : ImageCapture.OnImageSavedCallback {
                                override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                                    mainExecutor.execute {
                                        if (alive.get()) capturing = false
                                        // Saving may finish after unbind; the initiating recording owns this JPEG.
                                        capturePhotoCallback(captureRecordingId, file)
                                    }
                                }

                                override fun onError(exception: ImageCaptureException) {
                                    file.delete()
                                    mainExecutor.execute {
                                        if (alive.get()) capturing = false
                                        captureErrorCallback("Photo was not saved: ${exception.message ?: "camera capture failed"}")
                                    }
                                }
                            })
                    } catch (error: Exception) {
                        capturing = false
                        ioExecutor.execute { file.delete() }
                        captureErrorCallback("Cannot take photo: ${error.message ?: "camera unavailable"}")
                    }
                }
            }
        }
    }

    Column(Modifier.fillMaxSize().background(Ink)) {
        Row(
            // Keep the battery below Android's mandatory camera privacy indicator.
            Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 24.dp, bottom = 6.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column {
                Text(if (recordingActive) "SESSION ACTIVE" else "RECORDING STOPPED", color = White, style = MaterialTheme.typography.labelMedium)
                Text(cameraTime(elapsedMs), color = White, style = MaterialTheme.typography.titleLarge)
            }
            Column(horizontalAlignment = Alignment.End) {
                BatteryStatus(batteryPercent, isCharging)
                Text("$photoCount ${if (photoCount == 1) "PHOTO" else "PHOTOS"}", color = White, style = MaterialTheme.typography.labelMedium)
            }
        }
        Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
            AndroidView(factory = { previewView }, modifier = Modifier.fillMaxSize())
            if (!ready) {
                Text(
                    cameraError ?: "Opening camera…",
                    color = White,
                    modifier = Modifier.background(Ink.copy(alpha = 0.8f)).padding(12.dp),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            TextButton(onClick = onBack, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
                Text("Back", color = White)
            }
            Button(onClick = ::capturePhoto, enabled = ready && !capturing, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
                Text(if (capturing) "Saving…" else "Photo")
            }
        }
    }
}

private fun cameraTime(elapsedMs: Long): String {
    val seconds = elapsedMs.coerceAtLeast(0L) / 1000L
    return if (seconds >= 3600L) String.format(Locale.ROOT, "%d:%02d:%02d", seconds / 3600L, seconds / 60L % 60L, seconds % 60L)
    else String.format(Locale.ROOT, "%02d:%02d", seconds / 60L, seconds % 60L)
}
