package com.chippwalters.r1cord.device

import android.os.SystemClock
import java.util.Timer
import java.util.TimerTask
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * App-wide gate between device work (capture, uploads, library writes) and maintenance
 * (Desktop installing an update, shutting down). Maintenance is entered only when no work is
 * active, and no new work starts until it ends or expires, so an install can never kill a
 * recording or an upload mid-flight. Process singleton; every method is synchronized.
 */
object MaintenanceGate {
    enum class Work { CAPTURE, UPLOAD, LIBRARY_WRITE }

    data class GateState(
        val maintenance: Boolean = false,
        val maintenanceReason: String? = null,
        val active: Map<Work, Int> = emptyMap(),
    ) {
        val busy: Boolean get() = active.values.any { it > 0 }
    }

    private val mutableState = MutableStateFlow(GateState())
    val state: StateFlow<GateState> = mutableState.asStateFlow()

    /** Monotonic milliseconds including deep sleep; tests replace it to drive expiry. */
    @Volatile internal var clock: () -> Long = { SystemClock.elapsedRealtime() }

    private var deadline = 0L
    private val expiryTimer by lazy { Timer("r1cord-maintenance", true) }

    /** false (and nothing recorded) while maintenance is active. */
    @Synchronized
    fun tryBegin(work: Work): Boolean {
        expireIfDue()
        val current = mutableState.value
        if (current.maintenance) return false
        mutableState.value = current.copy(active = current.active + (work to (current.active[work] ?: 0) + 1))
        return true
    }

    /** Balanced with a successful [tryBegin]; never below zero. */
    @Synchronized
    fun end(work: Work) {
        val current = mutableState.value
        val count = current.active[work] ?: return
        val active = if (count <= 1) current.active - work else current.active + (work to count - 1)
        mutableState.value = current.copy(active = active)
    }

    /** Atomically: returns false if any work is active; otherwise enters maintenance, auto-expiring after [timeoutMs]. */
    @Synchronized
    fun beginMaintenance(reason: String, timeoutMs: Long = 10 * 60_000L): Boolean {
        require(timeoutMs > 0) { "Maintenance timeout must be positive." }
        expireIfDue()
        val current = mutableState.value
        if (current.busy) return false
        deadline = clock() + timeoutMs
        mutableState.value = current.copy(maintenance = true, maintenanceReason = reason)
        // Expiry is also checked on every call; the timer only keeps observers of [state] current.
        runCatching {
            expiryTimer.schedule(object : TimerTask() {
                override fun run() = synchronized(this@MaintenanceGate) { expireIfDue() }
            }, timeoutMs)
        }
        return true
    }

    @Synchronized
    fun endMaintenance() {
        deadline = 0L
        val current = mutableState.value
        if (current.maintenance) mutableState.value = current.copy(maintenance = false, maintenanceReason = null)
    }

    @Synchronized
    fun isBusy(): Boolean = mutableState.value.busy

    /** Human text such as "Recording in progress." or "Upload in progress."; null when idle. */
    @Synchronized
    fun busyReason(): String? {
        val active = mutableState.value.active
        fun running(work: Work) = (active[work] ?: 0) > 0
        return when {
            running(Work.CAPTURE) -> "Recording in progress."
            running(Work.UPLOAD) -> "Upload in progress."
            running(Work.LIBRARY_WRITE) -> "Saving files."
            else -> null
        }
    }

    /** Current state with any due expiry applied first. */
    @Synchronized
    fun snapshot(): GateState {
        expireIfDue()
        return mutableState.value
    }

    /** Clears all counts and maintenance; tests only. */
    @Synchronized
    internal fun reset() {
        deadline = 0L
        mutableState.value = GateState()
    }

    // Caller holds the monitor.
    private fun expireIfDue() {
        val current = mutableState.value
        if (current.maintenance && clock() >= deadline) {
            deadline = 0L
            mutableState.value = current.copy(maintenance = false, maintenanceReason = null)
        }
    }
}
