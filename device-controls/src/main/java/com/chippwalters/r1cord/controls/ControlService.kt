package com.chippwalters.r1cord.controls

import android.app.Service
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.Binder
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The only entry point of R1CORD controls. Every method first proves the caller is the
 * CHIPPWALTERS-signed R1CORD app, then acts with this platform-signed app's own identity.
 * No exception crosses Binder: failures become result codes.
 */
class ControlService : Service() {
    private val shutdownRequested = AtomicBoolean(false)

    private val binder = object : IDeviceControls.Stub() {
        override fun apiVersion(): Int = guarded(rejected = CALLER_REJECTED, error = ERROR) { API_VERSION }

        // A rejected caller reads "unreadable" (-1), never a WIFI_STATE_* value such as 2 (ENABLING).
        override fun getWifiState(): Int = guarded(rejected = WIFI_STATE_UNREADABLE, error = WIFI_STATE_UNREADABLE) {
            wifiManager().wifiState
        }

        override fun setWifiEnabled(enabled: Boolean): Int = guarded(rejected = CALLER_REJECTED, error = ERROR) {
            @Suppress("DEPRECATION")
            val accepted = wifiManager().setWifiEnabled(enabled)
            Log.i(TAG, "setWifiEnabled($enabled) accepted=$accepted")
            if (accepted) ACCEPTED else REFUSED
        }

        override fun requestShutdown(): Int = guarded(rejected = CALLER_REJECTED, error = ERROR) {
            if (shutdownRequested.compareAndSet(false, true)) {
                Thread({ shutDown() }, "R1CORD-shutdown").start()
            } else {
                Log.i(TAG, "shutdown already requested")
            }
            ACCEPTED
        }
    }

    override fun onBind(intent: Intent?): IBinder = binder

    private fun wifiManager(): WifiManager = getSystemService(WifiManager::class.java)
        ?: error("WifiManager unavailable")

    /** Caller check with the caller's identity, then the action with ours. */
    private fun guarded(rejected: Int, error: Int, action: () -> Int): Int {
        val uid = Binder.getCallingUid()
        val allowed = try {
            CallerCheck.isAllowed(packageManager.getPackagesForUid(uid), { CallerCheck.signerDigests(packageManager, it) })
        } catch (e: Exception) {
            Log.w(TAG, "caller check failed for uid $uid", e)
            false
        }
        if (!allowed) {
            Log.w(TAG, "rejected caller uid $uid")
            return rejected
        }
        val identity = Binder.clearCallingIdentity()
        return try {
            action()
        } catch (e: Exception) {
            Log.e(TAG, "control call failed", e)
            error
        } finally {
            Binder.restoreCallingIdentity(identity)
        }
    }

    /** Runs off the Binder thread after requestShutdown has already returned ACCEPTED. */
    private fun shutDown() {
        try {
            val power = getSystemService(PowerManager::class.java) ?: error("PowerManager unavailable")
            val shutdown = PowerManager::class.java.getMethod("shutdown",
                Boolean::class.javaPrimitiveType, String::class.java, Boolean::class.javaPrimitiveType)
            Log.i(TAG, "shutdown via PowerManager.shutdown")
            shutdown.invoke(power, false, "userrequested", false)
            return
        } catch (e: Throwable) {
            Log.w(TAG, "PowerManager.shutdown failed; falling back to ShutdownActivity", e)
        }
        try {
            Log.i(TAG, "shutdown via ShutdownActivity")
            startActivity(Intent("com.android.internal.intent.action.REQUEST_SHUTDOWN")
                .setClassName("android", "com.android.internal.app.ShutdownActivity")
                .putExtra("android.intent.extra.KEY_CONFIRM", false)
                .putExtra("android.intent.extra.USER_REQUESTED_SHUTDOWN", true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Throwable) {
            Log.e(TAG, "ShutdownActivity failed; the R1 stays on", e)
            shutdownRequested.set(false)
        }
    }

    companion object {
        const val TAG = "R1CORD/Controls"
        const val API_VERSION = 1
        const val ACCEPTED = 0
        const val REFUSED = 1
        const val CALLER_REJECTED = 2
        const val ERROR = 3
        const val WIFI_STATE_UNREADABLE = -1
    }
}
