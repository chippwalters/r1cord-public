# R1CORD

A voice recorder for the [Rabbit R1](https://www.rabbit.tech/), plus an optional desktop
companion that pulls recordings off the device over USB and transcribes them locally.

The R1 is a nice piece of hardware with a microphone, a screen and a battery. Running Android,
it makes a good pocket recorder: press Start, talk, press Stop. No account, no cloud, no
subscription — recordings are ordinary files on the device, and the transcription runs on your
own PC.

> **The R1 must be running Android.** R1CORD is an ordinary Android app; stock rabbitOS will not
> run it. Replacing rabbitOS is a separate one-time job with real risk —
> [docs/Installing-Android-on-R1.md](docs/Installing-Android-on-R1.md) is the full procedure.

## Documentation and downloads

- **[User guide](docs/user-guide.md)** — install, record, photos, getting recordings onto a
  computer, the desktop companion, troubleshooting.
- **[Installing Android on a Rabbit R1](docs/Installing-Android-on-R1.md)** — the prerequisite.
- Prebuilt, signed downloads (APK, companion zip, checksums) are linked from
  [chippwalters.com](https://chippwalters.com). Building from source here gives you an APK signed
  with **your** key, which Android treats as a different app — you cannot update a store-signed
  install with it, and vice versa.

## What is here

```text
app/            Android recorder (Kotlin, Jetpack Compose, minSdk 33)
server/         Desktop companion (Python 3.12, FastAPI, faster-whisper)
docs/           User guide and the Android installation guide
build.ps1       Builds the signed APK, the companion zip and checksums
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

`build.ps1` does the whole release pipeline — signed APK, companion zip, `SHA256SUMS.txt` — into
`dist\release\`.

## Building / running the companion

```powershell
cd server
.\install.bat          # finds or installs Python 3.12, creates .venv, fetches adb if needed
```

Then plug the R1 in (USB debugging on) and click **Adopt** on the admin page's Devices tab.
Details, settings and the Wi-Fi alternative are in the
[user guide](docs/user-guide.md#using-the-desktop-companion); the server's own
[README](server/README.md) covers configuration and internals.

Tests: `server\.venv\Scripts\python.exe -m pytest -q` (35 tests, no GPU or device needed).

## Design notes

- **Nothing leaves the device unless you ask.** No cloud account, no analytics, no background
  uploads. The app never turns the radio on or off.
- **Honest state.** A recording interrupted by a crash or a flat battery is kept and marked
  INTERRUPTED rather than presented as complete. Copying to a PC never claims to have succeeded
  when it has not, and never deletes anything from the device.
- **The companion only reads.** It pulls files from an adopted device; it never writes to or
  deletes from the R1.
- Transcription is [faster-whisper](https://github.com/SYSTRAN/faster-whisper) running locally,
  CPU by default and CUDA if you have it. Optional summaries and page publishing exist but need
  extra tools and are off unless configured.

## Status and license

Built and used on one device. It works; it has not been through wide device testing, and the
Android installation procedure carries the risks its own guide describes. Issues and pull
requests are welcome.

No license has been chosen yet, so all rights are reserved for now — read it, build it for
yourself, but ask before redistributing. A license will be added.
