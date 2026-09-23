package com.chippwalters.r1cord.recording

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import com.chippwalters.r1cord.MainActivity
import com.chippwalters.r1cord.R1cordApplication

class RecordingService : Service() {
    private val engine: RecorderEngine get() = (application as R1cordApplication).recorder
    private var sessionActive = false

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Microphone recording", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Keeps your recording running while the screen is dim or the camera is open."
            setSound(null, null)
            enableVibration(false)
            setShowBadge(false)
        })
        engine.onIdle = {
            sessionActive = false
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action
        if (action == null || action !in setOf(START, PAUSE, RESUME, STOP)) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        if (action == START) {
            sessionActive = true
            try { startForeground(NOTIFICATION, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE) }
            catch (error: Exception) {
                engine.serviceFailed("Microphone foreground service was denied: ${error.message}")
                stopSelf(startId)
                return START_NOT_STICKY
            }
        }
        engine.handle(action)
        return START_NOT_STICKY
    }

    private fun notification(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, RecordingService::class.java).setAction(STOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("R1CORD recording")
            .setContentText("Microphone session active. Tap to return; Stop saves your audio.")
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .build()
    }

    override fun onDestroy() {
        if (sessionActive) engine.serviceDestroyed() else engine.onIdle = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        internal const val START = "com.chippwalters.r1cord.START"
        internal const val PAUSE = "com.chippwalters.r1cord.PAUSE"
        internal const val RESUME = "com.chippwalters.r1cord.RESUME"
        internal const val STOP = "com.chippwalters.r1cord.STOP"
        private const val CHANNEL = "r1cord_recording"
        private const val NOTIFICATION = 1001
    }
}
