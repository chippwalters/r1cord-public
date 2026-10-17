package com.chippwalters.r1cord.sync

import java.net.InetAddress
import java.net.ServerSocket
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkRouteTest {
    private val tailnet = "https://desktop.example.ts.net"
    private val custom = "https://r1cord.example.com"

    private fun net(vpnUp: Boolean, internet: Boolean) = NetSnapshot(vpnUp = vpnUp, nonVpnValidatedInternet = internet)
    private val configured = RouteDecision.Use(Route.CONFIGURED)
    private val usb = RouteDecision.Use(Route.USB)

    private fun choose(url: String, net: NetSnapshot, usbUp: Boolean, serverUp: Boolean = true) =
        chooseRoute(url, net, usbReachable = { usbUp }, configuredReachable = { serverUp })

    @Test
    fun blankUrlAlwaysUsesUsb() {
        var probed = false
        val decision = chooseRoute(
            "  ",
            net(vpnUp = true, internet = true),
            usbReachable = { probed = true; false },
            configuredReachable = { probed = true; false },
        )
        assertEquals(usb, decision)
        assertFalse("a USB-only R1 needs no probe to pick USB", probed)
    }

    @Test
    fun tailnetUrlNeedsTheVpnNotJustInternet() {
        assertEquals(configured, choose(tailnet, net(vpnUp = true, internet = false), usbUp = false))
        assertEquals(usb, choose(tailnet, net(vpnUp = false, internet = true), usbUp = true))
        assertEquals(
            RouteDecision.Unavailable(TAILSCALE_OFF),
            choose(tailnet, net(vpnUp = false, internet = true), usbUp = false),
        )
    }

    @Test
    fun tailnetWithVpnUpButDesktopDownFallsBackToUsb() {
        assertEquals(usb, choose(tailnet, net(vpnUp = true, internet = true), usbUp = true, serverUp = false))
    }

    @Test
    fun tailnetWithVpnUpPrefersAReachableDesktopOverUsb() {
        assertEquals(configured, choose(tailnet, net(vpnUp = true, internet = true), usbUp = true, serverUp = true))
    }

    @Test
    fun tailnetWithDesktopDownAndNoUsbStillUsesTheConfiguredServerSoTheErrorNamesIt() {
        assertEquals(configured, choose(tailnet, net(vpnUp = true, internet = true), usbUp = false, serverUp = false))
    }

    @Test
    fun tailnetServerIsProbedOnlyWhenUsbCouldTakeOver() {
        var serverProbes = 0
        val vpn = net(vpnUp = true, internet = true)
        chooseRoute(tailnet, vpn, usbReachable = { false }, configuredReachable = { serverProbes++; true })
        chooseRoute(tailnet, net(vpnUp = false, internet = true), usbReachable = { true }, configuredReachable = { serverProbes++; true })
        assertEquals("no USB, or no VPN: nothing to compare, no probe", 0, serverProbes)
        chooseRoute(tailnet, vpn, usbReachable = { true }, configuredReachable = { serverProbes++; true })
        assertEquals(1, serverProbes)
    }

    @Test
    fun tailnetHostMatchIsCaseInsensitiveAndNotFooledByLookalikes() {
        assertTrue(isTailnetUrl("https://Desktop.Example.TS.NET/"))
        assertFalse(isTailnetUrl("https://ts.net.example.com"))
        assertFalse(isTailnetUrl("https://examplets.net"))
        assertFalse(isTailnetUrl("not a url"))
    }

    @Test
    fun customUrlUsesInternetOrVpnThenUsbThenNoRoute() {
        assertEquals(configured, choose(custom, net(vpnUp = false, internet = true), usbUp = true))
        assertEquals(configured, choose(custom, net(vpnUp = true, internet = false), usbUp = true))
        assertEquals(usb, choose(custom, net(vpnUp = false, internet = false), usbUp = true))
        assertEquals(
            RouteDecision.Unavailable(OffloadClient.NO_ROUTE),
            choose(custom, net(vpnUp = false, internet = false), usbUp = false),
        )
    }

    @Test
    fun customUrlNeverProbesTheServerAndSkipsUsbWhenOnline() {
        var usbProbes = 0
        var serverProbes = 0
        val decision = chooseRoute(
            custom,
            net(vpnUp = false, internet = true),
            usbReachable = { usbProbes++; true },
            configuredReachable = { serverProbes++; false },
        )
        assertEquals(configured, decision)
        assertEquals(0, usbProbes)
        assertEquals(0, serverProbes)
        chooseRoute(custom, net(vpnUp = false, internet = false), usbReachable = { true }, configuredReachable = { serverProbes++; false })
        assertEquals(0, serverProbes)
    }

    @Test
    fun routeAvailabilityChecksOnlyThePinnedRoute() {
        assertTrue(routeAvailable(Route.USB, custom, net(vpnUp = false, internet = false)) { true })
        assertFalse(routeAvailable(Route.USB, custom, net(vpnUp = true, internet = true)) { false })
        assertTrue(routeAvailable(Route.CONFIGURED, tailnet, net(vpnUp = true, internet = false)) { false })
        assertFalse(routeAvailable(Route.CONFIGURED, tailnet, net(vpnUp = false, internet = true)) { true })
        assertFalse(routeAvailable(Route.CONFIGURED, "", net(vpnUp = true, internet = true)) { true })
    }

    // ---- configured server probe ----

    @Test
    fun configuredServerProbeConnectsToTheUrlsHostAndPort() {
        ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { listener ->
            assertTrue(configuredReachable("http://127.0.0.1:${listener.localPort}/"))
        }
    }

    @Test
    fun configuredServerProbeReportsARefusedPortAsUnreachable() {
        val closedPort = ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { it.localPort }
        assertFalse(configuredReachable("http://127.0.0.1:$closedPort"))
    }

    @Test
    fun configuredServerProbeTreatsBadUrlsAndUnresolvableHostsAsUnreachable() {
        assertFalse(configuredReachable("not a url"))
        assertFalse(configuredReachable("https://r1cord-desktop.invalid"))
    }

    // ---- snapshots from network capabilities ----

    private val wifiValidated = NetCaps(vpnTransport = false, notVpn = true, internet = true, validated = true)
    private val wifiUnvalidated = wifiValidated.copy(validated = false)
    private val vpnValidated = NetCaps(vpnTransport = true, notVpn = false, internet = true, validated = true)

    @Test
    fun aValidatedVpnAloneIsNotProofOfInternet() {
        val snapshot = snapshotOf(listOf(vpnValidated, wifiUnvalidated))
        assertFalse(snapshot.nonVpnValidatedInternet)
        assertTrue(snapshot.vpnUp)
    }

    @Test
    fun anAlwaysOnVpnWithWifiOffIsNotUpSoSendGoesOverUsb() {
        val snapshot = snapshotOf(listOf(vpnValidated))
        assertEquals(NetSnapshot(vpnUp = false, nonVpnValidatedInternet = false), snapshot)
        assertEquals(usb, choose(custom, snapshot, usbUp = true))
        assertEquals(usb, choose(tailnet, snapshot, usbUp = true))
    }

    @Test
    fun aVpnWithoutInternetIsNotUp() {
        val snapshot = snapshotOf(listOf(vpnValidated.copy(internet = false), wifiValidated))
        assertFalse(snapshot.vpnUp)
        assertTrue(snapshot.nonVpnValidatedInternet)
    }

    @Test
    fun validatedWifiUnderAVpnCountsForBoth() {
        assertEquals(
            NetSnapshot(vpnUp = true, nonVpnValidatedInternet = true),
            snapshotOf(listOf(vpnValidated, wifiValidated)),
        )
        assertEquals(NetSnapshot(vpnUp = false, nonVpnValidatedInternet = false), snapshotOf(emptyList()))
    }
}
