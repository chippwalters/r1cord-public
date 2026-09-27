# R1CORD

**This repository is the source code.** If you just want to install R1CORD, you do not need
anything here — go to **https://www.widgetgadget.com/cw1/R1CORD/** and download it.

> **Beta.** The app (0.4.0), its device-controls helper *R1CORD controls* (1.0.0) and the desktop
> companion, R1CORD Desktop (0.5.0), are beta releases. R1CORD Desktop runs on Windows today;
> macOS and Linux versions are coming.

---

A voice recorder for the [Rabbit R1](https://www.rabbit.tech/), plus an optional desktop
companion that pulls recordings off the device over USB and transcribes them locally.

The R1 is a nice piece of hardware with a microphone, a screen and a battery. Running Android,
it makes a good pocket recorder: press Start, talk, press Stop. No account, no cloud, no
subscription — recordings are ordinary files on the device, and the transcription runs on your
own PC. The R1 stays a single-purpose device: it boots straight into R1CORD, with no login.

> **The R1 must be running Android.** R1CORD is an ordinary Android app; stock rabbitOS will not
> run it. Replacing rabbitOS is a separate one-time job with real risk —
> [docs/Installing-Android-on-R1.md](docs/Installing-Android-on-R1.md) is the full procedure.

## Downloads

- Product page: **https://chippwalters.com/r1cord.html**
- Files: **https://www.widgetgadget.com/cw1/R1CORD/**

That folder is everything a user needs:

| File | |
|---|---|
| `user-guide.html` | Start here — install, record, and the desktop companion |
| `Installing-Android-on-R1.html` | The prerequisite: getting Android onto the R1 |
| `R1CORD-Desktop-<version>-win-x64.zip` | R1CORD Desktop, the desktop companion (Windows) |
| `SHA256SUMS.txt` | Checksums, so you can verify what you downloaded |
| `auto-update-files/` | The Android apps, kept by version (below) |

The R1 apps live in
**[auto-update-files/](https://www.widgetgadget.com/cw1/R1CORD/auto-update-files/)**. Every
published version stays there, and R1CORD Desktop installs from it:

| File | |
|---|---|
| `R1CORD-<version>.apk` | The app, signed and ready to install |
| `R1CORD-controls-<version>.apk` | R1CORD controls, the helper behind the Wi-Fi switch and Power off |
| `tailscale-android-universal-<version>.apk` | The official Tailscale app, mirrored unchanged, for USB setup |
| `SHA256SUMS.txt` | Checksums of the files in this folder |
| `manifest.json` + `manifest.json.sig` | Signed list of the current release, read by R1CORD Desktop |

Each APK carries exactly one signing certificate. Check it with
`apksigner verify --print-certs <file>.apk` (Android SDK build-tools); the
`Signer #1 certificate SHA-256 digest` line must read:

| App | Package | Signer certificate SHA-256 |
|---|---|---|
| R1CORD | `com.chippwalters.r1cord` | `4e92be8e9853f7473f5fe9ed85fde56e2a8dac1280f279b2800861cd5265b7dc` |
| R1CORD controls | `com.chippwalters.r1cord.controls` | `c8a2e9bccf597c2fb6dc66bee293fc13f2fc47ec77bc6b2b0d52c11f51192ab8` |
| Tailscale | `com.tailscale.ipn` | `5cdb295551bfe1a087fed6acda07141c6c929fa7c29bd273a7092813acc434bf` |

R1CORD controls is signed with the **public AOSP platform test key** — the key the R1's Android
image (AOSP 13, userdebug/test-keys) is signed with. That is what lets it switch Wi-Fi and turn the
R1 off, and it is also why it works only on that kind of image. Because that key is public, its
certificate proves compatibility, not who built the file: the Ed25519 signature on
`manifest.json` is what R1CORD Desktop trusts for publisher authenticity, and it re-checks every
APK's certificate against the values above.

Building from source instead gives you an APK signed with **your** key, which Android treats as a
different app: you cannot update a downloaded install with it, or the reverse. If Android refuses
an update with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, **stop** — do not uninstall R1CORD to get
past it; that erases its list of recordings and its pairing. Compare the installed app's signer
with the table above and open an issue.

## Documentation

The same two manuals, in Markdown:

- **[User guide](docs/user-guide.md)** — install, record, photos, getting recordings onto a
  computer, the desktop companion, troubleshooting.
- **[Installing Android on a Rabbit R1](docs/Installing-Android-on-R1.md)** — the prerequisite.

## What is here

```text
app/              Android recorder (Kotlin, Jetpack Compose, minSdk 33)
device-controls/  R1CORD controls: the platform-signed helper for Wi-Fi and power off (no UI)
desktop/          R1CORD Desktop, the companion (Electron, Node 24, Fastify, whisper.cpp)
docs/             User guide and the Android installation guide
scripts/          Release-channel tools: signed manifest, checksums, Tailscale APK mirror
build.ps1         Builds the signed APK, the helper, the R1CORD Desktop zip and checksums
```

## Building the app

Needs JDK 17 and the Android SDK (compileSdk 36). Point Gradle at your SDK by creating
`local.properties` in the repo root (it is gitignored):

```properties
sdk.dir=C\:/Users/you/AppData/Local/Android/Sdk
```

Then, from the repo root:

```powershell
.\gradlew.bat :app:assembleDebug        # debug build, installs over adb immediately
.\gradlew.bat :app:assembleRelease      # release build - needs signing, see below
adb install app\build\outputs\apk\debug\app-debug.apk
```

A release build is signed from four Gradle properties, which you put in
`%USERPROFILE%\.gradle\gradle.properties` (never in the repo):

```properties
R1CORD_STORE_FILE=C:/path/to/your-release.jks
R1CORD_STORE_PASSWORD=...
R1CORD_KEY_ALIAS=...
R1CORD_KEY_PASSWORD=...
```

Create a keystore once with `keytool -genkeypair -keystore your-release.jks -alias r1cord
-keyalg RSA -keysize 4096 -validity 10950`. Without these properties the release build is
unsigned and will not install — that is deliberate. Release builds run R8 and resource shrinking
(~6.8 MB against ~75 MB debug); keep rules are in `app/proguard-rules.pro`, and shrinking can only
break things at runtime, so smoke-test a release build on a device before shipping it.

The app works without the helper: the Wi-Fi switch is then unavailable (the **Wi-Fi networks**
button still opens Android's Wi-Fi panel) and **Power off** falls back to Android's own power
menu.

### Building the helper (R1CORD controls)

`device-controls\` is a separate, UI-less APK. It exposes only Wi-Fi state, Wi-Fi on/off and power
off, and answers only R1CORD itself: every call checks that the caller is package
`com.chippwalters.r1cord` signed with the R1CORD certificate above. It has to be signed with the
**AOSP platform test key** — the public `platform.pk8` and `platform.x509.pem` from
[`build/target/product/security`](https://android.googlesource.com/platform/build/+/refs/heads/android13-release/target/product/security/)
in the AOSP source (android13-release). It works only on an Android image signed with those same
test keys, such as the R1's AOSP 13 userdebug/test-keys image; anywhere else Android refuses its
privileges. Keep the key files outside the repo (`*.pk8` and `*.pem` are gitignored).

Its Gradle release build is deliberately unsigned; `build.ps1` builds it, aligns it and signs it
when you pass the key files, then refuses the result unless its signer SHA-256 is
`c8a2e9bccf597c2fb6dc66bee293fc13f2fc47ec77bc6b2b0d52c11f51192ab8`:

```powershell
.\build.ps1 -AppOnly -PlatformKey C:\keys\platform.pk8 -PlatformCert C:\keys\platform.x509.pem
```

Without `-PlatformKey` / `-PlatformCert` the script says it is skipping the helper and builds the
rest. Helper tests: `.\gradlew.bat :device-controls:testDebugUnitTest`.

`build.ps1` does the whole release pipeline — signed APK, the helper (when given the platform
key), R1CORD Desktop zip, `SHA256SUMS.txt` — into `dist\release\`.

## Building / running R1CORD Desktop

Needs Node.js 24 (npm) on Windows x64. From `desktop\`:

```powershell
npm ci
npm start              # runs the app from source
npm test               # unit and HTTP tests (no GPU, device or network needed)
```

Packaging (`npm run make`, or `build.ps1 -ServerOnly` from the repo root) needs two things that
are not in git:

- **The audio decoder.** Take `bin\ffmpeg.exe` from
  [ffmpeg-8.0.1-essentials_build.zip](https://github.com/GyanD/codexffmpeg/releases/download/8.0.1/ffmpeg-8.0.1-essentials_build.zip)
  and put it in `desktop\binaries\win32\`. The build checks its SHA-256 and refuses any other file;
  `desktop\binaries\win32\NOTICE.txt` gives its licence (GPL v3, run unmodified as a separate
  program).
- **The R1 apps it bundles** for offline USB setup. Download `R1CORD-<version>.apk` and
  `R1CORD-controls-<version>.apk` from
  [auto-update-files/](https://www.widgetgadget.com/cw1/R1CORD/auto-update-files/) and put them in
  `desktop\resources\apk\` (gitignored). The build verifies each APK's signature against the
  certificates in the Downloads table, so an R1CORD signed with your own key is refused; a helper
  you built with the platform key passes.

The zip lands in `desktop\out\make\zip\win32\x64\`.

The app keeps its settings in `%LOCALAPPDATA%\R1CORD\config.toml` and its recordings under
`%LOCALAPPDATA%\R1CORD\data` unless you change them. Plug the R1 in (USB debugging on) and click
**Adopt** on the Devices page. Details, settings and the Wi-Fi alternative are in the
[user guide](docs/user-guide.md#using-the-desktop-companion).

The window shows *Starting R1CORD…* until the dashboard is ready. The admin pages answer on
`listen_port` (8765). The R1 never reaches them: over the USB cable and through Tailscale it talks
to a separate listener, `api_port` (default 8766), that serves only the `/v1` recording API. Two
pages, **Setup** and **Updates**, handle the rest:

- **Setup** is one numbered checklist, each step marked Done, Needs you or Blocked: install
  Tailscale on this PC (only after you agree), sign it in, share `/v1` on your tailnet with
  Tailscale Serve (nothing is published to the internet; the first time, Tailscale asks you to
  approve Serve through a link) and verify it, replace the tailnet policy with the one shown (it
  lets the R1 reach only this PC's HTTPS port and keeps the default SSH rule), tag this PC
  `tag:r1cord-server`, create an auth key with Tags on → `tag:r1cord`, and **Set up R1**.
- **Set up R1** works over USB: installs R1CORD, R1CORD controls and Tailscale on the R1, signs
  the R1 in to Tailscale with the one-off tagged auth key (the desktop types it in), gives it the
  server URL and a device key, proves which tailnet device is this R1, and checks its isolation,
  showing each step live in a window. It asks before downloading any app from the release server
  (only when one is missing on the PC) and for your confirmation that the tailnet policy was
  replaced, not just added to. It reports **Ready** only when every check passes; with no third
  device on the tailnet the isolation check is *inconclusive* and it says so. If the key had no
  tag, setup stops and tells you to tag the R1 `tag:r1cord` in the admin console and run it
  again with the key box blank.
- **Updates** checks the signed manifest for new releases only if you turn it on, and chooses
  whether R1 app updates are off, offered, or installed.

Tailscale is now the recommended way to send from away from home, in place of a public tunnel to
the PC; a LAN address or your own tunnel still works as the Server URL, and USB works with Wi-Fi
off. Pairing codes lock after five wrong tries until a new code is made.

Everything R1CORD needs from Tailscale (tags, grants/policy, auth keys, Serve) works on its free
Personal plan. A tailnet made with a personal account (Gmail, Apple, personal GitHub) starts on
that plan; one made with a work or custom-domain address counts as business use, is owned by
whoever controls the domain, and starts a 14-day paid-plan trial — switch it with **Billing →
Choose a plan → Personal** in the admin console (there is no separate opt-out button). The
Personal plan is for non-commercial use only — see [Tailscale pricing](https://tailscale.com/pricing).

App tests: `.\gradlew.bat :app:testDebugUnitTest` (JVM, Robolectric).

## Design notes

- **Nothing leaves the device unless you ask.** No cloud account, no analytics, no background
  uploads. Wi-Fi changes only when you use the Wi-Fi switch in Settings, and neither Wi-Fi off nor
  Power off is allowed while a recording or an upload is running.
- **Honest state.** A recording interrupted by a crash or a flat battery is kept and marked
  INTERRUPTED rather than presented as complete. Copying to a PC never claims to have succeeded
  when it has not, and never deletes anything from the device.
- **Renaming changes only the title.** It is saved on the R1 and in the recording's
  `metadata.json`; file and folder names never change. A recording already sent keeps its old
  title on the desktop; the next send uses the new one.
- **The companion only reads recordings.** It pulls files from an adopted device; it never
  writes to or deletes from the R1's recordings. The only thing it installs or configures on the
  R1 is what you start from **Set up R1** or allow on **Updates**.
- **Admin stays on the PC.** The R1 reaches only the `/v1` API listener, never the admin pages,
  whether over USB or Tailscale. Update checks are off until you turn them on.
- **Software cannot turn a fully-off R1 on.** Power off shuts it down; the power button starts it.
  R1CORD is an ordinary Home app — no Device Owner, lock task or kiosk mode, which would not add
  power off or power on anyway.
- Transcription is [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (through
  `@fugood/whisper.node`) running locally, on the graphics card through Vulkan when it can and on
  the CPU otherwise. Optional AI reviews (summary, outline, cleaned-up text) need a
  coding-assistant CLI signed in on the PC; publishing them as web pages needs only a folder your
  web host serves. Both are off unless configured.

## Status and license

Built and used on one device. It works; it has not been through wide device testing, and the
Android installation procedure carries the risks its own guide describes. Power off through the
helper has been tested on the device, and so has switching it back on from cold with the power
button afterwards: it started straight into R1CORD, still paired, with every recording intact.
Tailscale has been tested end to end on a real tailnet: the R1 set up over USB, then sent from a
phone hotspot and refreshed with the cable unplugged. Issues and pull requests are welcome.

No license has been chosen yet, so all rights are reserved for now — read it, build it for
yourself, but ask before redistributing. A license will be added.
