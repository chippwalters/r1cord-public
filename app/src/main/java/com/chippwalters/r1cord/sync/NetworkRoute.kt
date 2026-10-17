package com.chippwalters.r1cord.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * What the R1 can reach right now. [vpnUp]: a VPN network offering INTERNET that has a real
 * (non-VPN) network underneath it — an always-on VPN left over with Wi-Fi off carries nothing.
 * [nonVpnValidatedInternet]: a non-VPN network with validated internet; a validated VPN is
 * never proof of it.
 */
data class NetSnapshot(val vpnUp: Boolean, val nonVpnValidatedInternet: Boolean)

enum class Route { CONFIGURED, USB }

sealed interface RouteDecision {
    data class Use(val route: Route) : RouteDecision
    data class Unavailable(val message: String) : RouteDecision
}

const val TAILSCALE_OFF =
    "Tailscale is off on this R1. Turn Wi-Fi on, or plug into the desktop with USB mode on."

/**
 * Picks the server for the next request. A blank URL means USB-only use. A `*.ts.net` server is
 * only reachable through the Tailscale VPN, and a VPN being up says nothing about the PC: when
 * the USB `adb reverse` loopback answers, the tailnet server is used only if it actually accepts
 * a connection ([configuredReachable]), so a PC whose Tailscale/Serve is down falls back to USB.
 * With no USB the configured server is used unprobed, so a failure names its host. Any other URL
 * needs validated internet or a VPN, then falls back to USB.
 */
fun chooseRoute(
    url: String,
    net: NetSnapshot,
    usbReachable: () -> Boolean,
    configuredReachable: () -> Boolean,
): RouteDecision {
    if (url.isBlank()) return RouteDecision.Use(Route.USB)
    if (isTailnetUrl(url)) {
        return when {
            !net.vpnUp -> if (usbReachable()) RouteDecision.Use(Route.USB) else RouteDecision.Unavailable(TAILSCALE_OFF)
            !usbReachable() || configuredReachable() -> RouteDecision.Use(Route.CONFIGURED)
            else -> RouteDecision.Use(Route.USB)
        }
    }
    if (configuredAvailable(url, net)) return RouteDecision.Use(Route.CONFIGURED)
    if (usbReachable()) return RouteDecision.Use(Route.USB)
    return RouteDecision.Unavailable(OffloadClient.NO_ROUTE)
}

/** Whether [route], pinned earlier for an upload, can still carry requests to the same server. */
fun routeAvailable(route: Route, url: String, net: NetSnapshot, usbReachable: () -> Boolean): Boolean = when (route) {
    Route.USB -> usbReachable()
    Route.CONFIGURED -> url.isNotBlank() && configuredAvailable(url, net)
}

private fun configuredAvailable(url: String, net: NetSnapshot): Boolean =
    if (isTailnetUrl(url)) net.vpnUp else net.nonVpnValidatedInternet || net.vpnUp

/** True when [url]'s host is a Tailscale MagicDNS name (`*.ts.net`). */
fun isTailnetUrl(url: String): Boolean {
    val host = url.trim().toHttpUrlOrNull()?.host ?: return false
    return host.lowercase().trimEnd('.').endsWith(".ts.net")
}

/** Capabilities of one network, reduced to what routing needs. */
internal data class NetCaps(
    val vpnTransport: Boolean,
    val notVpn: Boolean,
    val internet: Boolean,
    val validated: Boolean,
)

internal fun snapshotOf(networks: List<NetCaps>): NetSnapshot {
    val underlying = networks.any { it.notVpn && !it.vpnTransport && it.internet }
    return NetSnapshot(
        vpnUp = underlying && networks.any { it.vpnTransport && it.internet },
        nonVpnValidatedInternet = networks.any { it.notVpn && !it.vpnTransport && it.internet && it.validated },
    )
}

/** Reads every network the app can see; the active network alone hides Wi-Fi under a VPN. */
fun netSnapshot(context: Context): NetSnapshot = snapshotOf(netCaps(context))

@Suppress("DEPRECATION")
internal fun netCaps(context: Context): List<NetCaps> {
    val manager = context.applicationContext.getSystemService(ConnectivityManager::class.java)
        ?: return emptyList()
    return manager.allNetworks.mapNotNull { network ->
        manager.getNetworkCapabilities(network)?.let { c ->
            NetCaps(
                vpnTransport = c.hasTransport(NetworkCapabilities.TRANSPORT_VPN),
                notVpn = c.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN),
                internet = c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
                validated = c.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
            )
        }
    }
}

internal const val USB_HOST = "127.0.0.1"
/** Device-side port the desktop reverse-forwards (`adb reverse tcp:8765 tcp:<api_port>`). */
internal const val USB_PORT = 8765
private const val USB_PROBE_MS = 300L

private val usbProbeThread = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "r1cord-usb-probe").apply { isDaemon = true }
}

/**
 * True when a TCP connect to the `adb reverse` loopback succeeds within 300 ms. The connect runs
 * on a background thread, so this is safe (if briefly blocking) from any caller.
 */
fun usbReachable(): Boolean {
    val attempt = usbProbeThread.submit<Boolean> {
        Socket().use { socket ->
            runCatching { socket.connect(InetSocketAddress(USB_HOST, USB_PORT), USB_PROBE_MS.toInt()); true }
                .getOrDefault(false)
        }
    }
    return runCatching { attempt.get(USB_PROBE_MS + 200, TimeUnit.MILLISECONDS) }
        .getOrElse { attempt.cancel(true); false }
}

private const val SERVER_PROBE_MS = 1500L

/** Pooled so a DNS lookup stuck past the deadline never queues the next probe behind it. */
private val serverProbeThreads = Executors.newCachedThreadPool { runnable ->
    Thread(runnable, "r1cord-server-probe").apply { isDaemon = true }
}

/**
 * True when a TCP connect to [url]'s host and port (443 for https, 80 for http unless given)
 * succeeds within ~1.5 s, DNS lookup included; an unresolvable host or invalid URL is
 * unreachable. The connect runs on a background thread, so this is safe from any caller.
 */
fun configuredReachable(url: String): Boolean {
    val target = url.trim().toHttpUrlOrNull() ?: return false
    val attempt = serverProbeThreads.submit<Boolean> {
        Socket().use { socket ->
            runCatching { socket.connect(InetSocketAddress(target.host, target.port), SERVER_PROBE_MS.toInt()); true }
                .getOrDefault(false)
        }
    }
    return runCatching { attempt.get(SERVER_PROBE_MS, TimeUnit.MILLISECONDS) }
        .getOrElse { attempt.cancel(true); false }
}

/** Route decisions for [OffloadClient]; a seam so tests can script the network. */
internal interface RouteSource {
    fun choose(url: String): RouteDecision
    fun isAvailable(route: Route, url: String): Boolean
}

internal class SnapshotRoutes(
    private val net: () -> NetSnapshot,
    private val usb: () -> Boolean,
    private val configured: (url: String) -> Boolean = ::configuredReachable,
) : RouteSource {
    override fun choose(url: String): RouteDecision =
        chooseRoute(url, net(), usbReachable = usb, configuredReachable = { configured(url) })
    override fun isAvailable(route: Route, url: String): Boolean = routeAvailable(route, url, net(), usb)
}

internal fun deviceRoutes(context: Context): RouteSource =
    SnapshotRoutes(net = { netSnapshot(context.applicationContext) }, usb = ::usbReachable)
