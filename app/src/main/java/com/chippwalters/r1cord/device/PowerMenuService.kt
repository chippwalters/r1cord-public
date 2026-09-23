package com.chippwalters.r1cord.device

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.provider.Settings
import android.text.TextUtils
import android.view.accessibility.AccessibilityEvent

/**
 * Opens Android's own power menu so the recorder can offer Power off without
 * privileged shutdown permissions or device-owner enrollment. Android only
 * grants [GLOBAL_ACTION_POWER_DIALOG] to a service the user enables, so this
 * stays inert until then and handles no accessibility events.
 */
class PowerMenuService : AccessibilityService() {
    override fun onServiceConnected() {
        super.onServiceConnected()
        connected = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit

    override fun onInterrupt() = Unit

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        if (connected === this) connected = null
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        if (connected === this) connected = null
        super.onDestroy()
    }

    companion object {
        @Volatile private var connected: PowerMenuService? = null

        /** True once Android reports this service enabled for the current user. */
        fun isEnabled(context: Context): Boolean {
            val component = "${context.packageName}/${PowerMenuService::class.java.name}"
            val enabled = Settings.Secure.getString(context.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
            val splitter = TextUtils.SimpleStringSplitter(':')
            splitter.setString(enabled)
            return splitter.any { it.equals(component, ignoreCase = true) }
        }

        /**
         * Shows the system power menu. Returns false when Android has not bound
         * the service yet, so the caller can send the user to enable it instead
         * of reporting a power off that never happened.
         */
        fun showPowerMenu(): Boolean {
            val service = connected ?: return false
            return service.performGlobalAction(GLOBAL_ACTION_POWER_DIALOG)
        }
    }
}
