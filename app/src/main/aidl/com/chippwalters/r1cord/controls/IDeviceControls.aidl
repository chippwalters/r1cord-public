package com.chippwalters.r1cord.controls;

// Binder contract between R1CORD and R1CORD controls. app/ and device-controls/ keep
// byte-identical copies of this file under src/main/aidl/com/chippwalters/r1cord/controls/.
interface IDeviceControls {
    int apiVersion();              // 1
    int getWifiState();            // WifiManager.WIFI_STATE_* value, or -1 when unreadable
    int setWifiEnabled(boolean enabled); // 0 accepted, 1 refused by platform, 2 caller rejected, 3 error
    int requestShutdown();         // 0 accepted, 2 caller rejected, 3 error
}
