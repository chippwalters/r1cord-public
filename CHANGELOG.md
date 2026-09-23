# Changelog

Versions are the app's `versionName`; the desktop companion carries its own version in
`server/pyproject.toml` and is noted where it changed.

## 0.3.1 — signed release build, USB mode (companion 0.2.0)

- **Desktop companion, USB mode.** Plug an adopted device in and every finished recording is
  pulled over `adb` and transcribed locally — nothing to press on the device. Device detection is
  push-based (`adb track-devices`), so an idle companion polls nothing. Recordings still being
  written are skipped until Stop; a recording already transferred is never processed twice; the
  companion never writes to or deletes from the device.
- **Companion installer.** `install.bat` sets up Python, the virtualenv, and Google
  platform-tools if `adb` is absent, then writes a first-run config under `%LOCALAPPDATA%\R1CORD`.
  Transcription is CPU by default; `--gpu` adds the CUDA runtime. `run_mode` chooses between
  starting it by hand (it exits when idle) and a resident at-logon task.
- **Cable route for the app.** With no validated network the app talks to `127.0.0.1:8765`, which
  the companion reverse-forwards while the device is plugged in, so pairing, Send and Refresh all
  work over USB with Wi-Fi off. The app never turns the radio on or off.
- **Signed release build.** Release builds are signed from Gradle properties outside the repo and
  run R8 plus resource shrinking: about 6.8 MB against 75 MB for a debug build. `build.ps1`
  produces the APK, the companion zip and SHA-256 checksums in one step.
- Admin page needs no login when opened on the machine itself; HTTP Basic applies only to requests
  arriving through a proxy or tunnel.
- Fixed: a transcribe-only job reported a published URL that did not exist, so the device showed an
  "Open summary" button leading to a 404.

## 0.3.0 — desktop offload over the network

- Pair the device with a companion once (server URL plus a six-digit code), then **Send** a
  recording or **Send all** from the library. Uploads are resumable and survive an interrupted
  connection.
- Job status badges (`SENDING`, `PROCESSING`, `DONE`, `ERROR`) on library rows and the recording
  view, updated when you press Refresh — there is no background polling.
- Recording database migrated to store the job id, status and result URL per recording.

## 0.2.5 — WAV capture

- **Use WAV** records uncompressed 48 kHz mono PCM16 instead of AAC, about 7.4× larger. The
  remaining-time estimate follows the chosen format. WAV recordings stop honestly at RIFF's 4 GiB
  limit rather than writing a corrupt header.
- Deleting a recording now removes its folder instead of leaving an empty one behind.

## 0.2.3 — noise cancelling and voice pausing

- **Noise cancelling** attaches the platform noise suppressor to the capture session (opt-in,
  device-dependent).
- **Voice pausing** gates recording on voice activity with Quiet/Normal/Noisy sensitivity: silence
  is left out of the file rather than recorded as zeros, and speech resumes capture automatically.
  A deliberate pause is never overridden by speech, and a session that captured no speech fails
  honestly instead of saving an empty file.
- The running version is shown at the bottom of the settings dialog.

## 0.2.0 — ordinary Android home app

- Removed the earlier managed-kiosk design: R1CORD is now a normal default home app with no device
  administrator, no lock task and no maintenance PIN. **Power off** opens the system power menu
  through an accessibility service that does nothing else.

## 0.1.x — first working recorder

- Record, pause, resume, stop, with elapsed time that excludes paused time and a live input meter.
- Library and playback with a waveform, seek and ±10-second skips.
- Photos attached to a recording, captured without interrupting audio.
- Recordings published as ordinary files under `Download/R1CORD/<recording id>/` — audio, JPEGs and
  `metadata.json` — with interrupted sessions marked rather than presented as complete.
- Storage-aware: refuses to start when nearly full and protects the space needed to finalize an
  active recording. Nothing is ever auto-deleted.
