# R1CORD

**This repository is the source code.** If you just want to install R1CORD, you do not need
anything here — go to **https://www.widgetgadget.com/cw1/R1CORD/** and download it.

> **Beta.** The app (0.3.3) and the desktop companion, R1CORD Desktop (0.4.0), are beta releases.
> R1CORD Desktop runs on Windows today; macOS and Linux versions are coming.

---

A voice recorder for the [Rabbit R1](https://www.rabbit.tech/), plus an optional desktop
companion that pulls recordings off the device over USB and transcribes them locally.

The R1 is a nice piece of hardware with a microphone, a screen and a battery. Running Android,
it makes a good pocket recorder: press Start, talk, press Stop. No account, no cloud, no
subscription — recordings are ordinary files on the device, and the transcription runs on your
own PC.

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
| `R1CORD-<version>.apk` | The app, signed and ready to install |
| `R1CORD-Desktop-<version>-win-x64.zip` | R1CORD Desktop, the desktop companion (Windows) |
| `SHA256SUMS.txt` | Checksums, so you can verify what you downloaded |

Building from source instead gives you an APK signed with **your** key, which Android treats as a
different app: you cannot update a downloaded install with it, or the reverse.

## Documentation

The same two manuals, in Markdown:

- **[User guide](docs/user-guide.md)** — install, record, photos, getting recordings onto a
  computer, the desktop companion, troubleshooting.
- **[Installing Android on a Rabbit R1](docs/Installing-Android-on-R1.md)** — the prerequisite.

## What is here

```text
app/            Android recorder (Kotlin, Jetpack Compose, minSdk 33)
desktop/        R1CORD Desktop, the companion (Electron, Node 24, Fastify, whisper.cpp)
docs/           User guide and the Android installation guide
build.ps1       Builds the signed APK, the R1CORD Desktop zip and checksums
```

## Building the app

Needs JDK 17 and the Android SDK (compileSdk 36). Point Gradle at your SDK by creating
`local.properties` in the repo root (it is gitignored):

```properties
sdk.dir=C\:/Users/you/AppData/Local/Android/Sdk
```

Then, from the repo root:

```powershell
.\gradlew.bat assembleDebug          # debug build, installs over adb immediately
.\gradlew.bat assembleRelease        # release build - needs signing, see below
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

`build.ps1` does the whole release pipeline — signed APK, R1CORD Desktop zip, `SHA256SUMS.txt` —
into `dist\release\`.

## Building / running R1CORD Desktop

Needs Node.js 24 (npm) on Windows x64. From `desktop\`:

```powershell
npm ci
npm start              # runs the app from source
npm test               # unit and HTTP tests (no GPU, device or network needed)
```

Packaging (`npm run make`, or `build.ps1 -ServerOnly` from the repo root) also needs the audio
decoder, which is not in git: take `bin\ffmpeg.exe` from
[ffmpeg-8.0.1-essentials_build.zip](https://github.com/GyanD/codexffmpeg/releases/download/8.0.1/ffmpeg-8.0.1-essentials_build.zip)
and put it in `desktop\binaries\win32\`. The build checks its SHA-256 and refuses any other file;
`desktop\binaries\win32\NOTICE.txt` gives its licence (GPL v3, run unmodified as a separate
program). The zip lands in `desktop\out\make\zip\win32\x64\`.

The app keeps its settings in `%LOCALAPPDATA%\R1CORD\config.toml` and its recordings under
`%LOCALAPPDATA%\R1CORD\data` unless you change them. Plug the R1 in (USB debugging on) and click
**Adopt** on the Devices page. Details, settings and the Wi-Fi alternative are in the
[user guide](docs/user-guide.md#using-the-desktop-companion).

App tests: `.\gradlew.bat :app:testDebugUnitTest` (100 tests on the JVM, Robolectric).

## Design notes

- **Nothing leaves the device unless you ask.** No cloud account, no analytics, no background
  uploads. The app never turns the radio on or off.
- **Honest state.** A recording interrupted by a crash or a flat battery is kept and marked
  INTERRUPTED rather than presented as complete. Copying to a PC never claims to have succeeded
  when it has not, and never deletes anything from the device.
- **The companion only reads.** It pulls files from an adopted device; it never writes to or
  deletes from the R1.
- Transcription is [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (through
  `@fugood/whisper.node`) running locally, on the graphics card through Vulkan when it can and on
  the CPU otherwise. Optional AI reviews (summary, outline, cleaned-up text) need a
  coding-assistant CLI signed in on the PC; publishing them as web pages needs only a folder your
  web host serves. Both are off unless configured.

## Status and license

Built and used on one device. It works; it has not been through wide device testing, and the
Android installation procedure carries the risks its own guide describes. Issues and pull
requests are welcome.

No license has been chosen yet, so all rights are reserved for now — read it, build it for
yourself, but ask before redistributing. A license will be added.
