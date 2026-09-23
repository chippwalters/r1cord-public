[brand-header]

# Installing Android on a Rabbit R1

**Read this before you install R1CORD.** R1CORD is an ordinary Android app, so your R1 has to be
running Android first — stock rabbitOS will not run it. This is the prerequisite: how to replace
rabbitOS with AOSP 13, written after doing it the hard way on Windows 11 x64 in September 2026.

It is a standalone guide. If you want Android on your R1 for some entirely different reason, it
works just as well for that.

Everything below is either an observed result from that session's notes or is explicitly labelled
unverified. The device-specific findings come from one R1 on one Windows host; nothing here is
quoted from a vendor specification. Every link in this document points at a public upstream source.

If you only read one section, read [4. The four USB modes](#4-the-four-usb-modes) and
[8. Where it actually goes wrong](#8-where-it-actually-goes-wrong). Those are where the days went.

## Start here if you have an AI agent

**Got Claude, Codex, Grok, or any other capable LLM? You can skip most of this document.**
Jump to [11.1 Guided install](#111-guided-install), copy that prompt into your agent, and it will
walk you through the flash one step at a time — it already carries every device-specific gotcha
this guide took days to find. If something is already broken, use
[11.2 Triage](#112-triage-when-something-has-already-gone-wrong) instead.

**Two things to do before you paste it:**

1. **Go to [rabbithole](https://hole.rabbit.tech/) and change your account settings first.** No
   agent can do this for you — it happens on Rabbit's website, not on the device, and it is two
   separate actions: **settings → developer → "void warranty and enable developer mode"** (needs
   your IMEI, and permanently voids the warranty), then **settings → developer → device
   modification → unlock** with the R1 powered on and online. Full click-path in
   [6. The procedure](#6-the-procedure), Step 0. Skip this and you will get as far as
   `fastboot flashing unlock` and stop.
2. **Skim [1. What you get, and what it costs](#1-what-you-get-and-what-it-costs).** The wipe, the
   voided warranty, and "never relock the bootloader" are your decisions to make, not the agent's.

Everything in sections 1–10 is the human-readable version of what that prompt knows. Read it if
you want to understand what you're doing, or if you'd rather not hand a flashing session to a
language model.

---

## 1. What you get, and what it costs

**Result:** the R1 boots AOSP 13 (API 33, `gsi_r1`, userdebug/test-keys) on top of the stock
Android 12 vendor/VNDK 31 base. It is an ordinary Android device with GMS: you can sideload APKs,
use ADB, set a default Home app. R1CORD then installs like any other APK (`adb install`), and you
can set it as the default Home app so the R1 boots straight into it. The APK comes from wherever
you got this guide.

**Cost, non-negotiable:**

- **All user data is erased.** Unlocking the bootloader wipes userdata by design.
- **Verified boot is off** on the installed slot. The bootloader stays unlocked.
- **You will see an orange "bootloader unlocked" warning** for about five seconds on every boot.
- **Google will nag** that the device isn't certified until you register it at
  <https://www.google.com/android/uncertified>.
- **Your warranty is permanently void — before you flash anything.** The sanctioned route starts
  with a button in rabbithole labelled *"void warranty and enable developer mode"*, and Rabbit
  states support will not help you unlock, flash, or return to stock. See step 0. A successful
  `fastboot getvar warranty` query tells you nothing legally useful and does not prove no storage
  was written.
- **Do not `fastboot flashing lock` afterwards.** Relocking a device whose verification metadata is
  disabled can leave it unable to boot. This is the single most dangerous command in the whole
  toolchain.

**The device is a 480×640 panel at roughly 278 real ppi.** That matters later — see step 8 of the
procedure. It is not a phone, and things that look fine on a phone (including Android's own Settings
screens) can be unusable here.

---

## 2. Hardware and downloads

| Item | Notes |
|---|---|
| A [rabbithole](https://hole.rabbit.tech/) account + your R1's IMEI | Required for step 0 — Rabbit's developer-mode request and the device-modification unlock. IMEI is on the R1 under Settings → About. |
| Windows 11 x64 PC, administrator | Linux also works via `r1.sh`; this guide is the Windows path, which is the one with all the driver problems. amd64 only — not ARM. |
| A USB-C **data** cable | A charge-only cable produces exactly the "device never enumerates" symptom you will waste an hour on. |
| [r1_escape](https://github.com/RabbitHoleEscapeR1/r1_escape) | Unlock scripts, `mtkbootcmd.py`, `vbmeta.img`. |
| `system.img` (AOSP 13 GSI with GMS) | Linked from the r1_escape README; ~3.2 GB uncompressed. |
| [mtkclient](https://github.com/bkerler/mtkclient) | Partition backup and FRP read/write over the MediaTek preloader. **Expect to patch it** — see §8. |
| Google [platform-tools](https://developer.android.com/studio/releases/platform-tools) | `adb.exe`, `fastboot.exe`. This project used 37.0.1. |
| MediaTek Preloader USB VCOM drivers (**signed**) | Get them from an OEM source, e.g. the [Teracube package](https://downloads.myteracube.com/Drivers/MediaTek_Preloader_USB_VCOM_Drivers_Setup_Signed.zip) or [Hovatek](https://www.hovatek.com/forum/thread-16640.html). Unsigned packages from random sites will fight Windows driver signing. |
| [Google USB Driver](https://developer.android.com/studio/run/win-usb) | Required separately for **fastbootd** (`18D1:4EE0`). The MediaTek driver does not cover it. |
| [UsbDk](https://github.com/daynix/UsbDk) 1.0.22 | mtkclient's USB backend on Windows. Remove it when you're finished. |
| Python 3.12 + `pyserial` | Use a venv. This project used 3.12.10 in a local `mtk-venv`. |
| Stock firmware ZIP (optional, recommended) | [rabbit-hmi-oss/firmware](https://github.com/rabbit-hmi-oss/firmware) — v0.8.293. Your escape hatch. Read §9 before trusting it. |

---

## 3. Before you touch the device: back it up

Two things are irreplaceable on a MediaTek device: the device-unique calibration partitions
(`nvdata`, `nvram`, `nvcfg`, `protect1`, `protect2`, `proinfo` — IMEI, Wi-Fi/BT MACs, sensor cal)
and your own ability to prove what the device looked like before you started.

```powershell
# Preloader mode, device powered OFF, then plugged in
python mtk.py rl my_r1_backup --skip super,userdata --serialport
```

In this project that produced **45 partitions, 916,668,416 bytes**. Verify flag names against
`python mtk.py --help` for your checkout; they drift between forks.

Three rules that came out of doing this:

1. **`--skip super,userdata`** — `super` is ~2 GB of the thing you are about to replace and
   `userdata` is about to be erased. Skipping them is what makes the backup finish this century.
2. **The backup is not a restore image.** 45 partitions minus `super` minus `userdata` cannot boot a
   device. It is insurance for the *device-unique* data, not a system image.
3. **Keep originals immutable.** Hash everything (`partitions.sha256`) and never write modified
   files back into the same folder. `mtk wl <dir>` flashes *everything in that directory*; if a
   modified FRP file or a pre-unlock `seccfg` is sitting in there, a blind restore will write it.

**GPT caveat observed here:** the dumped `gpt.bin` omitted the final 512 bytes of the partition-entry
array. Zero-filling exactly those bytes matched the stored entry-array CRC, which suggests a dump-length
quirk rather than corruption — but do not flash a GPT dump you have not verified, and do not describe
it as a complete captured disk layout.

---

## 4. The four USB modes

This is the mental model that makes the rest of the process tractable. **The R1 presents four
different USB personalities, each needing a different Windows driver.** A driver that works in one
mode proves nothing about the next. Most "it hung", "it says waiting for device", "it's bricked"
reports are actually "you are in a different mode than you think".

| Mode | USB ID | How you get there | What it's for | Driver |
|---|---|---|---|---|
| **MediaTek preloader** | `0E8D:2000` | Power off, plug in. Window is short. | mtkclient: partition read/write, FRP. `mtkbootcmd.py` sends `FASTBOOT`. | MediaTek Preloader USB VCOM (serial port) |
| **Bootloader fastboot** | `0E8D:201C` | Preloader `FASTBOOT` command | Unlock queries, `flashing unlock`, writing `vbmeta_a`, erasing userdata/metadata | MediaTek / generic Android bootloader |
| **Userspace fastbootd** | `18D1:4EE0` | `fastboot reboot fastboot` | Resizing and writing **logical** partitions (`system_a`) | **Google USB Driver** — separate manual match |
| **Booted Android (ADB)** | composition has included `0E8D:2303` | Normal boot with USB debugging on | Installing apps, `adb shell`, screenshots | Google USB Driver / WinUSB |

Two hard-won corollaries:

- **A USB PID alone does not prove a function is bound.** On this device the live gadget reported
  PID 2303 and `sys.usb.config=adb`, while the actual function symlinks still pointed at HID
  keyboard / HID mouse / WebUSB and no ADB function existed. Properties lie; check what enumerates.
- **`0E8D:20FF` with zero-byte HID endpoints and Windows Code 10 is not a brick.** Rabbit's own RC
  identified it as **HID for KPOC** — an off-mode charging configuration. Do not respond to it with
  a pinhole reset, a relock, or a blind partition restore.

---

## 5. Prepare the Windows host

This is the step that is missing from every guide and is where this project lost the most time.

### 5.1 Memory Integrity (HVCI) vs. the MediaTek serial driver

**Proven on this host:** with Memory Integrity on, Windows logged **Code Integrity event 3111** for
MediaTek's `usb2ser.sys` and **Kernel-PnP event 219** for `wdm_usb`. The preloader serial port never
came up. The MediaTek VCOM driver is not HVCI-compatible.

The workaround is to turn Memory Integrity off (Windows Security → Device security → Core isolation),
restart, do the flashing, then turn it back on and restart again.

Treat that as a real, temporary security downgrade:

- Note that you did it, in writing.
- Turn it back on the moment you're done, and **verify the runtime state after the restart** —
  "configured on" is not "active". This repo's own cleanup log says
  `Memory Integrity configured ON. Restart required to activate.` and the restart had not happened.
- Never leave it off because it was convenient.

### 5.2 Python execution aliases

Windows ships stub `python.exe` / `python3.exe` aliases that open the Store. Search **"Manage app
execution aliases"** and disable both, or every `python mtk.py` call silently does nothing useful.

### 5.3 Driver binding

Install the signed MediaTek Preloader VCOM package and UsbDk, then install the Google USB Driver
separately — its INF carries the explicit `18D1:4EE0` match that fastbootd needs. On this host, the
Google package landed as `oem111.inf` and the MediaTek one as `oem106.inf`. **Those numbers are
local to one machine.** Rediscover yours with `pnputil /enum-drivers` before removing anything.

When something stalls, open `devmgmt.msc` and look at what appeared. If the script says "plug in
USB", you want a *Preloader USB VCOM* device; if it says "waiting for device", you want a *fastboot*
device. Manually point the driver at the right package (Update driver → Browse → Let me pick) rather
than waiting for Windows Update to guess.

### 5.4 One transport owner at a time

mtkclient, `mtkbootcmd.py`, `fastboot`, an ADB server and a "helpful" watcher script will all grab
the same port. Run exactly one. Kill leftover `adb.exe` / Python processes between phases. If you
have an emulator or a second Android device attached, **specify the serial explicitly** on every
ADB/fastboot command — a stray emulator absorbing a `fastboot -w` is a genuinely bad day.

---

## 6. The procedure

The upstream [`r1.ps1`](https://github.com/RabbitHoleEscapeR1/r1_escape/blob/main/r1.ps1) script
automates roughly this sequence. It is worth reading even if you run the steps by hand, which is
what this project ended up doing — the script's final flash sequence did not survive contact with
this unit (see §8).

### Step 0 — Ask Rabbit for permission, on their website, first

**Do this before you touch a cable.** It is two separate actions in
[rabbithole](https://hole.rabbit.tech/), documented in Rabbit's own
[developer-mode article](https://www.rabbit.tech/support/article/unlock-bootloader-rabbit-r1).

**0a — Enable developer mode** (you need your IMEI; it's on the R1 under Settings → About):

1. Log in to <https://hole.rabbit.tech/>
2. **settings** on the top menu bar
3. **developer** in the left-hand menu
4. Under *enable developer mode*, type the acknowledgement exactly as shown on the page:
   *"I acknowledge that the warranty on my rabbit r1 is permanently void once it is put in
   developer mode."*
5. Enter your device IMEI
6. Click **void warranty and enable developer mode**

**That button permanently voids the warranty, by Rabbit's own wording, before any flashing
happens.** Rabbit support will not help you with unlocking, flashing, or getting back to stock.
That is stated plainly in their article and it is the real price of admission.

**0b — Grant the unlock, with the device online:**

1. Power the R1 on and connect it to Wi-Fi — this step talks to the device
2. In rabbithole → **settings** → *developer* section, find **device modification** and click
   **unlock**

### Step 0c — Confirm the permission actually reached the device

Once you can get the device into bootloader fastboot (step 1), check it:

```powershell
fastboot getvar unlock_ability     # 1 = the device will accept `flashing unlock`
```

**In this session, the portal route did not produce a nonzero local unlock permission.** The cause
of that discrepancy is unknown — it may be a timing, account, or firmware-version issue rather than
anything you did wrong. If yours reads 1, skip to step 1 and unlock normally. Do the portal steps
regardless: they are the sanctioned route, and `r1_escape` assumes you have already burned the
warranty.

If it reads 0, the method that worked here was writing the FRP permission byte over the preloader:

```powershell
python mtk.py r frp frp.bin --serialport     # read
# set the final byte (offset 1048575) of the 1,048,576-byte file from 0x00 to 0x01
python mtk.py w frp frp.bin --serialport     # write back
python mtk.py r frp frp-readback.bin --serialport   # read again and compare ALL bytes
```

Keep `frp-original.bin` untouched, somewhere the write path cannot reach. Verify the readback byte
for byte, not just the last byte — this project recorded the full 1,048,576-byte comparison in
`frp-write-verification.json` and that record is the only reason the later steps could be trusted.

### Step 1 — Enter fastboot through the preloader

```powershell
python mtkbootcmd.py FASTBOOT
# then power the R1 off and plug it in
```

The helper polls COM ports for `VID:PID=0E8D:2000`, waits for the device to say `READY`, and replies
`FASTBOOT`.

**Start the listener before you plug in.** There is a widely repeated claim of a fixed ~14-second
preloader window; this project's polling timestamps never actually measured the handshake
availability, so treat the window as "short and unmeasured" rather than a number you can count on.

To power the device off: **Settings → Device → Power off** on stock rabbitOS. A generic 10-second
button hold did **not** work here, and there is no documented reset pinhole. Do not improvise
physical reset actions.

### Step 2 — Unlock, in bootloader mode (`0E8D:201C`)

```powershell
fastboot devices
fastboot flashing unlock      # confirm on the device; this wipes userdata
```

### Step 3 — Disable verification for the slot you're installing, in bootloader mode

```powershell
fastboot --disable-verity --disable-verification flash vbmeta_a vbmeta.img
```

**Stay in bootloader mode for this.** On this unit, userspace fastbootd *rejected* `vbmeta_a`.

### Step 4 — Wipe, in bootloader mode

```powershell
fastboot erase userdata
fastboot erase metadata
```

**`fastboot -w` did not perform the intended wipe on this device.** Erase the partitions explicitly
and confirm the command actually returned OK.

### Step 5 — Flash the system image, in fastbootd (`18D1:4EE0`)

```powershell
fastboot reboot fastboot
fastboot getvar is-userspace          # must print: is-userspace: yes
fastboot flash system_a system.img
```

`system` is a **logical** partition inside `super`, which is why this has to happen in fastbootd and
why the host needs the Google USB Driver bound here specifically. If the flash fails for space,
resize the logical partition (`fastboot delete-logical-partition` / `resize-logical-partition`)
before retrying — this project's run needed the resize/write path in fastbootd, not a plain write.

Do not flash boot or vendor. The stock ones were retained here and the GSI booted on top of them.

### Step 6 — Boot

```powershell
fastboot reboot
```

First boot is slow — allow several minutes. The orange unlocked-bootloader warning for ~5 seconds is
normal. If the screen appears stuck on that warning indefinitely, see §8.

### Step 7 — Android setup

Setup completes **fully offline, with no Google account and no PIN**. `device_provisioned` and
`user_setup_complete` both reach 1 through the ordinary wizard. Don't let anyone tell you a Google
account is required to reach Developer options — Android's developer-availability checks concern
admin-user status, debugging restrictions, developer mode and completed setup, not account sign-in.

### Step 8 — Fix the density before you try to use Settings

**This is the single most confusing symptom of the whole project, and it is a layout bug, not a
restriction.**

At the 240 dpi override, the Developer options page shows a title, a switch, and *nothing else* — the
collapsing header plus the switch consume the entire usable viewport of a 480×640 panel. It looks
exactly like a locked-down or crippled Settings build. It isn't.

```powershell
adb shell wm density 200
```

At 200 dpi the options list scrolls, the Debugging section is reachable, and USB/Wireless debugging
are visible and toggleable. **200 dpi is the verified working value on this hardware.**

A corollary worth internalising: `sp` units are physically tiny here. At ~278 real ppi, 14 sp is
about 1.6 mm. Any app you build for this device needs its own type scale.

Then, for an appliance-style setup:

```powershell
adb shell locksettings set-disabled true    # no swipe lock
# select your app as default Home in Settings, or via the app's own settings
```

### Step 9 — Put the host back

```powershell
pnputil /enum-drivers                     # find YOUR oem*.inf numbers
pnputil /delete-driver oemNNN.inf /uninstall
# uninstall UsbDk
# re-enable Memory Integrity, restart, and VERIFY it is running
```

Keep the Google USB Driver — you want ADB for day-to-day work. **Normal app development needs only
ADB.** Never downgrade host security again just to install an APK.

---

## 7. Verify what you actually have

Do not claim success from a screen that looks right.

```powershell
adb devices -l                                   # confirm the intended serial
adb shell getprop ro.build.version.release       # 13
adb shell getprop ro.product.system.name         # gsi_r1
adb shell wm density                             # Override density: 200
adb shell settings get global development_settings_enabled
adb shell dumpsys activity activities | findstr mLockTaskModeState   # NONE
```

Then reboot once, reconnect, and check that ADB comes back **without** injecting any unlock or launch
command. A running shell you kept alive across the reboot is not proof of anything.

---

## 8. Where it actually goes wrong

| Symptom | Real cause | Fix |
|---|---|---|
| Preloader COM port never appears; Windows logs CI 3111 / Kernel-PnP 219 | Memory Integrity (HVCI) blocks MediaTek `usb2ser.sys` | Temporarily disable Memory Integrity, restart; re-enable and verify afterwards |
| `python mtk.py …` does nothing | Windows Store `python.exe` execution aliases | Disable both aliases in "Manage app execution aliases" |
| mtkclient crashes on DA2 upload with an `EP_OUT` / `SerialClass` **AttributeError** | Upstream assumes a USB endpoint object; the serial transport has none | Patch `Library/DA/xflash/xflash_lib.py` `send_data` to use the endpoint packet size when present, else 64-byte writes. Also remove the unused `EP_IN.wMaxPacketSize` read in the partition-read path, and guard `EP_IN` in `Library/mtk_preloader.py` `send_auth` with a 0x400 fallback. These exact patches are in this repo's `mtkclient/` checkout. |
| Script stalls at "Plug in USB" | Wrong/unbound driver for the current mode | `devmgmt.msc` → bind *Preloader USB VCOM* manually |
| Script stalls at "Waiting for device" | Wrong/unbound driver for fastboot **or fastbootd** | Bind the fastboot driver; for `18D1:4EE0` install the Google USB Driver |
| `fastboot flashing unlock` refused, or `getvar unlock_ability` returns 0 | Rabbit's portal grant never reached the device — observed here even after the portal steps | Re-check both rabbithole actions; if it stays 0, write the FRP permission byte (step 0c) |
| `fastboot flash vbmeta_a` fails | You are in fastbootd; it rejected `vbmeta_a` on this unit | Do vbmeta and erases from **bootloader** mode |
| `fastboot -w` "succeeds" but nothing was wiped | Observed on this unit | `fastboot erase userdata` + `erase metadata` explicitly |
| `fastboot flash system_a` fails on size | `system` is logical inside `super` | Resize/delete the logical partition in fastbootd first |
| Device shows `0E8D:20FF`, zero-byte HID endpoints, Code 10 | HID for KPOC — off-mode charging | Not a brick. Don't reset, relock or restore. |
| Orange unlocked-bootloader warning appears to hang forever | Observed here after ADB was lost | Unplug USB (screen goes black), then do a normal ~5 s battery-powered power-on. Booted fine; no restoration needed. |
| ADB disappears after touching USB modes | Stock vendor init forces `sys.usb.config=cua` (HID + WebUSB) whenever `sys.usb.state=none`, and stale function links survive the switch | **Do not run `svc usb setFunctions mtp`** or similar unguarded switches. If you must experiment, keep an independently verified transport and a tested timed rollback. |
| Developer options page shows only a switch | 240 dpi viewport, not a restriction | `wm density 200` |
| Settings search missing | Unresolved on this GSI; AOSP also gates it on provisioning + the SettingsIntelligence package | Not needed; don't treat it as evidence of lockdown |
| `mtk wl` restore is glacially slow | Known upstream issue | See [mtkclient#271](https://github.com/bkerler/mtkclient/issues/271#issuecomment-2272411904) |
| Dark screen / charging animation | Diagnoses nothing | Read actual USB/tool state; say "I don't know" rather than guessing brick vs. battery |

---

## 9. Getting back to stock

This project wrote a PowerShell restore script implementing the tested order:

```
boot → both slots  →  6× vbmeta (verification disabled)  →  fastbootd  →  super.img  →  erase userdata  →  reboot
```

It SHA-256-verifies five images before touching the device and never writes `nvdata` / `nvram` /
`persist`, so IMEI, MACs and sensor calibration survive.

Read these caveats before you rely on it:

- **It has not been used for a successful full hardware restore.** Only the dry run and file
  validation were exercised in this project.
- **v0.8.293 is older than the rabbitOS 2.3.1 that was on the device.** Downgrade compatibility and
  any subsequent OTA path are unproven.
- `-DryRun` still prints "Stock firmware restored." That string is not evidence.
- It calls bare `fastboot` / `python` from PATH, selects no explicit serial, and asks for no erase
  confirmation. Fix those before a real run.
- It leaves the bootloader unlocked and verity off — **deliberately**. Do not relock.

Your 45-partition mtkclient backup is *not* a substitute for this; it cannot rebuild `super`.

---

## 10. Still unverified here

Honest gaps, so nobody cites this document as proof of something it didn't test:

- **MTP file transfer to Windows Explorer.** Blocked by the vendor CUA/USB composition conflict above.
  Public MediaStore files and successful `adb pull`s are not an MTP test.
- **Physical button mapping.** Key layouts written to `/data/system/devices/keylayout/` worked for
  injected key events but were never verified for physical presses, and a factory reset invalidates
  them — `/data` is not firmware.
- **A true battery-powered cold start** (as opposed to `adb reboot`).
- **Full stock restoration**, per §9.
- **Whether the upstream mtkclient patches in §8 apply to other chipsets or every command path.**
  They were proven on one device, on the read/write paths actually exercised.

---

## 11. Prompt for an AI coding agent

If you have Claude Code, Codex CLI, or Grok, paste one of these. They're written to keep the agent
honest about device state and to stop it inventing recovery steps — which, in this project, was a
real failure mode: one model confidently asserted a Device Owner/persistent-HOME diagnosis for what
turned out to be a 240 dpi viewport, and kept proposing reboots.

### 11.1 Guided install

````text
You are helping me install AOSP Android 13 (GSI) on a Rabbit R1 (MediaTek MT6765) from a
Windows 11 x64 host. I have physical access to the device and I run every command myself.

YOUR ROLE
Walk me through one step at a time. After each step, tell me exactly what output or on-screen
state proves it worked, and wait for me to paste the real result before continuing. Never assume
a step succeeded.

GROUND TRUTH YOU MUST USE
The R1 presents four distinct USB personalities, each needing a different Windows driver. A
driver working in one mode proves nothing about the next:
  - MediaTek preloader      0E8D:2000   mtkclient / mtkbootcmd.py     MediaTek Preloader USB VCOM
  - Bootloader fastboot     0E8D:201C   unlock, vbmeta, erases        MediaTek/generic fastboot
  - Userspace fastbootd     18D1:4EE0   logical partitions (system_a) Google USB Driver (explicit match)
  - Booted Android (ADB)    e.g. 0E8D:2303  app install, shell        Google USB Driver / WinUSB

Device-specific facts already established on this exact hardware — do not contradict them
without new evidence from me:
  - Memory Integrity (HVCI) blocks MediaTek usb2ser.sys. Proven: Code Integrity event 3111 and
    Kernel-PnP event 219. It must be temporarily off for preloader work, and turned back on and
    re-verified afterwards.
  - Userspace fastbootd REJECTS vbmeta_a. Do vbmeta writes and erases from bootloader mode.
  - `fastboot -w` did NOT wipe. Use explicit `erase userdata` and `erase metadata`.
  - `system` is a logical partition inside `super`; flash it as system_a from fastbootd, resizing
    the logical partition if needed.
  - The sanctioned prerequisite is on Rabbit's website, not the device: rabbithole > settings >
    developer > acknowledge the warning + enter IMEI > "void warranty and enable developer mode",
    then (device powered on and online) settings > developer > device modification > unlock. That
    button permanently voids the warranty and Rabbit support will not help afterwards.
  - Confirm the grant actually reached the device with `fastboot getvar unlock_ability` (1 = it
    will accept `flashing unlock`). Here the portal route did NOT produce a nonzero value, and the
    fallback that worked was setting the final byte (offset 1048575) of the 1 MiB frp partition
    from 0x00 to 0x01 via mtkclient, then verifying the full readback.
  - The device's panel is 480x640 at ~278 ppi. At a 240 dpi override, Android's Developer options
    page shows only a title and a switch — this is a viewport layout failure, NOT a restriction,
    NOT a missing Google account, NOT device management. `adb shell wm density 200` fixes it.
  - USB PID and sys.usb.config properties can both lie about which USB functions are actually
    bound. Check what enumerates, not what a property says.
  - 0E8D:20FF with zero-byte HID endpoints and Windows Code 10 is "HID for KPOC" off-mode
    charging. It is not a brick.
  - To power the device off, use its Settings > Device > Power off. A 10-second button hold does
    not work and there is no documented reset pinhole.

HARD RULES
  1. Never tell me to run `fastboot flashing lock`. Verification is disabled; relocking can make
     the device unbootable.
  2. Back up partitions before anything destructive:
     `python mtk.py rl <dir> --skip super,userdata --serialport`. Keep originals immutable and
     never point a bulk `mtk wl` restore at a folder containing modified or readback files.
  3. Before any command that erases or writes, state plainly what it destroys and wait for my
     explicit go-ahead.
  4. Exactly one process may own the USB transport at a time. Have me kill stray adb/python
     processes between phases, and always target the device by explicit serial.
  5. Never suggest I disable host security beyond the single, temporary, documented Memory
     Integrity toggle — and remind me to re-enable and verify it at the end.
  6. If a symptom is ambiguous, say "I don't know" and tell me which specific reading would
     disambiguate it. Do not diagnose a brick, a battery failure, or a management policy from a
     dark screen, a charging animation, or a missing menu item.
  7. Do not propose a reboot or a factory reset as a generic fix. Both destroy evidence.
  8. Distinguish "the command returned OK" from "the device is in the state I wanted". Ask me to
     verify the second.

START BY ASKING ME
  - Whether I have already done BOTH rabbithole steps (developer mode enabled, and device
    modification unlocked) — and if not, tell me to do those first and explain that the first one
    permanently voids my warranty.
  - What mode the device is in right now (what Device Manager shows, and the USB VID:PID).
  - What `fastboot getvar unlock_ability` returns, if I can reach bootloader mode.
  - Whether I have a verified partition backup yet.
  - Whether Memory Integrity is currently on or off, and whether the PC has restarted since I
    changed it.
Then give me step 1 only.
````

### 11.2 Triage, when something has already gone wrong

````text
I am part-way through installing AOSP Android 13 on a Rabbit R1 (MediaTek MT6765) from Windows 11
and something is wrong. Help me diagnose before changing anything.

FIRST, establish state. Ask me for, and wait for, these readings:
  - Device Manager: exactly what device appears, and its USB VID:PID.
  - `fastboot devices` and `fastboot getvar is-userspace` output, if anything is listed.
  - `adb devices -l` output.
  - What is on the R1's screen right now.
  - The last command I ran and its complete output.
  - Whether Memory Integrity is on, and whether the PC restarted since I last changed it.

THEN map the state to a mode before proposing anything:
  0E8D:2000 preloader | 0E8D:201C bootloader fastboot | 18D1:4EE0 fastbootd | booted Android ADB
  0E8D:20FF with zero-byte HID endpoints and Code 10 = HID for KPOC off-mode charging. NOT a brick.

KNOWN CAUSES, prefer these over speculation:
  - No preloader COM port, with Code Integrity event 3111 / Kernel-PnP 219 in the event log:
    Memory Integrity blocking MediaTek usb2ser.sys.
  - mtkclient AttributeError on EP_OUT / SerialClass during DA2 upload: upstream assumes a USB
    endpoint object that the serial transport lacks. Patch send_data in
    Library/DA/xflash/xflash_lib.py to use the endpoint packet size when present, else 64-byte
    writes; guard EP_IN in Library/mtk_preloader.py send_auth with a 0x400 fallback.
  - "Waiting for device" at the system-image step: fastbootd (18D1:4EE0) needs the Google USB
    Driver specifically.
  - `flashing unlock` refused / unlock_ability 0: the rabbithole device-modification grant did not
    reach the device. Observed here. Fallback is the frp permission byte at offset 1048575.
  - vbmeta_a write rejected: you are in fastbootd; use bootloader mode.
  - Wipe appeared to do nothing: `fastboot -w` is unreliable here; erase userdata and metadata
    explicitly.
  - ADB vanished after a USB mode change: stock vendor init forces sys.usb.config=cua (HID +
    WebUSB) whenever sys.usb.state=none, and stale function links survive the switch. Properties
    will still claim adb.
  - Developer options page shows only a switch: 240 dpi viewport on a 480x640 panel. Not a
    restriction. `adb shell wm density 200`.
  - Orange unlocked-bootloader warning seemingly stuck forever: unplug USB, then do a normal
    battery-powered power-on.
  - Python commands doing nothing: Windows Store python.exe execution aliases.

RULES
  - Propose the least destructive diagnostic first. Never lead with a reboot, a factory reset, a
    relock, or a blind partition restore — all four destroy evidence or the device.
  - NEVER suggest `fastboot flashing lock`.
  - Never suggest flashing a partition backup folder in bulk; it may contain modified files.
  - If the evidence does not identify a cause, say so and name the one reading that would.
  - Tell me explicitly when a proposed action is irreversible.
````

### 11.3 What to hand the agent alongside the prompt

- The exact model and firmware version you started from (this project started on rabbitOS 2.3.1).
- Your Windows build and whether Memory Integrity is on.
- The output of `pnputil /enum-drivers` filtered to your MediaTek/Google packages.
- Which mtkclient checkout you're using, and whether you've applied the serial patches in §8 — this
  is the detail agents most often guess wrong about, because upstream's README assumes USB.

**Never paste your device serial, IMEI, FRP dumps, `hwparam.json`, or raw mtkclient logs into a
cloud model.** They contain device-unique identifiers. Redact, or describe them.

---

## 12. Honesty clause

This document describes what worked once, on one unit, on one Windows host, in September 2026. The
MediaTek tooling is a moving target; the vendor firmware is a moving target; your unit may have a
different bootloader state. Treat every command here as something to understand before you run it,
not something to paste.

The one instruction with no exceptions: **do not relock the bootloader.**
