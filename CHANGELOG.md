# Changelog

Versions are the app's `versionName`; the desktop companion carries its own version (since 0.4.0
in `desktop/package.json`), as does the device-controls helper R1CORD controls (since 0.4.0, in
`device-controls/build.gradle.kts`); each is noted where it changed.

## 0.4.0 (beta) — Wi-Fi switch, direct power off, rename, thumbnails, new Send panel (R1CORD controls 1.0.0)

- **Wi-Fi switch in Settings.** A live **Wi-Fi** on/off switch, plus a **Wi-Fi networks** button
  that opens Android's Wi-Fi panel for choosing a network. The switch works through the new
  helper (below); without it, Wi-Fi networks still works.
- **Power off turns the R1 off.** One confirmation, then the R1 shuts down directly through the
  helper. Without the helper it falls back to Android's power menu, as before. Power off and
  Wi-Fi off are refused while a recording or an upload is running. Software cannot turn a
  fully-off R1 on: use the power button.
- **R1CORD controls 1.0.0**, a small second APK with no screen of its own
  (`com.chippwalters.r1cord.controls`, source in `device-controls/`). It is signed with the
  public AOSP platform test key, which the R1's Android image uses — so it works only on such an
  image — and it answers only R1CORD signed with the CHIPPWALTERS key.
- **Rename a recording** with the pencil on its Detail screen, or **RENAME** in the Send panel.
  The title is saved on the R1 and in the recording's `metadata.json`; file and folder names never
  change. Recordings already sent keep their old title on the desktop; new sends use the new one.
- **Thumbnails.** A recording's first photo appears beside its title in the Library, while
  recording, on Detail and in the Send panel.
- **Send panel redesigned** to fit the R1's screen: the title with Rename, the three review
  choices in one row, the Publish switch, and CANCEL / SEND always visible.
- R1CORD Desktop 0.5.0 or later installs it, the helper and Tailscale over USB (Setup → Set up R1).
- An update signed with a different key is refused by Android; do not uninstall to get past it
  (that erases the list of recordings and the pairing) — stop and compare the signer.
- Tested on the device: Power off through the helper shut the R1 down in an orderly way, and the
  power button then started it from cold straight into R1CORD — still paired, every recording
  intact. Tested over Tailscale on a real tailnet: after Set up R1, Send from a phone hotspot and
  Refresh with the USB cable unplugged both went over Tailscale.

## R1CORD Desktop 0.5.0 (beta) — Tailscale remote access, USB setup, updates

- **The R1 can no longer reach the admin.** A separate listener, `api_port` (default 8766),
  serves only the `/v1` API; the USB cable and Tailscale both go there, and the admin pages are
  not registered on it.
- **Setup page**, one numbered checklist with each step marked Done, Needs you or Blocked:
  install Tailscale on this PC (with your consent), sign it in, share `/v1` on your tailnet with
  Tailscale Serve (no Funnel; the first time, Tailscale asks you to approve Serve through a link
  the page shows) and verify it, replace the tailnet policy with the one shown (**Copy**; it keeps
  a new tailnet's default SSH rule and Funnel setting), tag this PC `tag:r1cord-server`, create an
  auth key with Tags on → `tag:r1cord` (Pre-approved appears only if device approval is on), and
  **Set up R1** over USB: installs R1CORD, R1CORD controls and Tailscale, grants their
  permissions, signs the R1 in to Tailscale with that key (the desktop types it in), provisions
  the server URL and a device key, proves which tailnet device is this R1, and checks its
  isolation. The run shows its steps live in a window, with Close once it ends. It asks before
  downloading apps from the release server (only when one is missing on the PC; otherwise it
  lists the versions it has) and for confirmation that the tailnet policy was replaced.
  **Ready** only when every check passes; with no third device on the tailnet, isolation is
  *inconclusive*. An R1 that joins without its tag is caught, with the fix: tag it
  `tag:r1cord` in the admin console and run setup again with the key box blank. An R1CORD older
  than 0.4.0 is simply updated, without a separate confirmation.
- **Start screen.** The window shows *Starting R1CORD…* while it starts, and the reason with
  **Retry** if it cannot, instead of an empty window.
- **Updates page.** Update checks are off until you turn them on; R1 app updates can be off,
  offered (ask) or installed; **Check now**. Releases come from a signed `manifest.json`, and every
  APK's signer is checked against built-in pins.
- **Pairing codes lock after five wrong tries** until a new code is made.
- **Tailscale replaces the Cloudflare tunnel as the recommended remote route.** A LAN address or
  your own tunnel still works as the Server URL; USB still works with Wi-Fi off.
- Packaging bundles the published R1CORD and helper APKs for offline USB setup (see README).
- Tested end to end on a real tailnet (Tailscale 1.102.4): Set up R1 completed every step, then
  the R1 sent from a phone hotspot and refreshed with the cable unplugged, both over Tailscale.
  Isolation was *inconclusive* only because that tailnet had no third device to test against.
- On a work or custom-domain Tailscale account, the tailnet starts a 14-day trial; move it to the
  free Personal plan with Billing → Choose a plan → Personal (there is no separate opt-out button).

## 0.3.4 (beta) — recording works again after a restart

- **Fixed: "Recording failed: Volume external_primary not found" after the R1 restarts.** Android
  can start R1CORD a moment before the device's storage is ready. The app's startup check then
  failed and kept failing — nothing could be recorded, deleted or sent until the app was
  restarted. The check is now retried until storage is ready.
- **A failed start returns to the home screen** with the error, instead of leaving the recording
  screen with every button disabled.
- The guides now say how to stop Google Play Services' repeating *This device isn't Play Protect
  certified* notification (it is not from R1CORD).

## R1CORD Desktop 0.4.0 (beta) — the companion becomes a Windows app

- **R1CORD Desktop replaces the Python companion.** One portable zip: unzip, run
  `R1CORD Desktop.exe`. No installer and no Python. It has its own window and taskbar icon, and
  keeps the same local address and API, so the R1 app needs no update. Settings, recordings,
  transcripts, pages and paired R1s from 0.3.x are used as they are.
- **Speech recognition is whisper.cpp**, on the graphics card through Vulkan (NVIDIA, AMD, Intel)
  or else the processor. Its model (about 870 MB) downloads once, from the System page or with
  the first recording. The audio decoder ships inside the app.
- **One-click `adb`:** if Google's Android tool is missing, the Devices page downloads it from
  Google (signature checked).
- **Start by itself** from the taskbar icon's Start menu: when the R1 is plugged in, or at login.
- **The dashboard is off through a tunnel by default**; Settings → Allow admin through the
  tunnel turns it back on, with the admin password. The R1 can still send through a tunnel.
- Still beta; Windows only for now, with macOS and Linux to follow.

## Companion 0.3.4 (beta) — security fix and restart recovery

- **Security:** web pages open in your browser can no longer reach the companion's admin page
  (DNS rebinding and cross-site form posts are refused). Update if you run 0.3.3.
- A job that was running when the companion stopped is picked up again at the next start instead
  of staying stuck.
- Still beta; the new cross-platform companion (Windows, macOS, Linux) is on its way.

## 0.3.3 (beta) — AI reviews, Transcript pages, server-rendered pages with themes (companion 0.3.3)

This is a **beta** release of both the app and the desktop companion. A new cross-platform
architecture for the companion (Windows, macOS and Linux) is coming soon.

- **Three AI reviews, in any combination:** Summary, Outline, and Cleaned up & organized (the
  whole recording without filler, grouped under headings). Chosen per send on the R1, with
  defaults in Settings; the Notes / Minutes / Article styles are replaced.
- **Transcript page.** With Publish on, the transcript is published too, beside one page per
  review. The R1's recording screen shows a button for each page, opening in the in-app viewer.
- **Companion dashboard:** page links under each recording (unpublished ones open a local
  preview), and **Add review** to write another review from the stored transcript without
  re-uploading.
- **Editable prompts:** Settings → AI reviews has each review's prompt with Restore default.
- One failed review no longer stops the others.
- **The companion makes the web pages itself** — the MD DOCS app is no longer needed to publish.
  Every page links the recording's other pages and offers its Markdown as a download. Choose the
  look from twelve themes (the same set as MD DOCS) under Settings → Pages, with a preview;
  **Republish all pages** re-makes pages already published.

## Companion 0.3.2 — Play in the page; Folder opens in front

- **Play** now plays a recording right in the admin page (press again to pause; Length counts up),
  instead of handing it to whatever app Windows has set for `.m4a`, which opened behind the
  browser. It works through a tunnel too.
- **Folder** brings its File Explorer window in front of the browser. Windows had been keeping it
  behind.

## Companion 0.3.1 — redesigned admin pages; recording length and delete

- **A calmer dashboard.** Four status tiles (device, current job, queue, system) above one
  **Recordings** list. Wi-Fi pairing and paired-device keys moved to the Devices page; dependency
  checks moved to a new **System** page that marks each one OK, needs attention, or not in use.
  Config is now called **Settings**.
- **Recordings** show one row per recording with its **Length**, size, status and writer, and
  Play, Download, Folder and **Delete** buttons. Delete asks first, removes the recording and its
  published page from the PC only, and USB mode will not copy it back; the device keeps its copy.
- The admin pages follow the CHIPPWALTERS brand, with bundled fonts and the R1CORD logo.

## 0.3.2 — summaries open in the app; companion tray icon and email (companion 0.3.0)

- **Summaries open inside R1CORD.** Open summary, the "Sent" dialog's Open and the Sent
  notification show the published page in a full-screen in-app viewer (close, title, reload; Back
  walks page history; an error screen with Retry). The app no longer hands the link to the
  device browser, which on some Android builds closes itself seconds after opening.
- **Clearer send errors.** When the Server URL answers but the companion behind it is down (for
  example a tunnel with no origin), the app says the desktop server is not reachable and shows the
  HTTP status, instead of a generic "could not create the upload job".
- **Companion tray icon.** While running on Windows the companion shows the R1CORD logomark in the
  notification area: status on hover, click for the admin page, a right-click menu with the admin
  pages, USB mode and email switches, the data and log folders, and Quit. A Windows notification
  appears when a job finishes or fails.
- **Admin page opens when the device is plugged in** (adopted devices only; not on server start).
- **Recent jobs**: each recording shows its audio size with Play (default media player),
  Download and Folder buttons. Play and Folder work only on the PC itself, never through a proxy
  or tunnel.
- **Email on completion** (optional): each finished job's summary or transcript is emailed
  through a signed-in Google Workspace CLI (`gws`), with the published page link; a job page can
  resend it.
- Unit tests for the Android client (JVM + Robolectric) and a much larger companion test suite.

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
