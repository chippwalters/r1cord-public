# r1cord-server

Desktop offload server for the R1CORD recorder. It receives recordings from the Rabbit R1, transcribes them with faster-whisper, has a coding-agent CLI write the AI reviews chosen for each recording (Summary, Outline, Cleaned up & organized — any combination, or none), and renders a Transcript page plus one page per review as themed static HTML, which it publishes into a WebDAV folder. The server renders the pages itself; publishing needs no other app.

Two ways a recording gets in, one pipeline:

| Mode | Who drives | How |
|---|---|---|
| **USB** | the server | Plug an adopted R1 in with USB debugging on. The watcher pulls every finished recording under `Download/R1CORD/` over `adb`, then runs the configured `usb_auto_action` (`archive`, `transcribe`, `review`, `publish`). Per-recording actions live on the **Devices** page. |
| **Internet** | the device | Tap **Send** on the R1; upload over the Cloudflare tunnel or LAN with resumable `PUT`s; badge on **Refresh**. The HTTP contract is documented in `SPEC.md`. |

While an adopted device is plugged in the watcher also runs `adb reverse tcp:8765 tcp:<listen_port>`, so the R1's Send / Refresh work over the cable when Wi-Fi is off (the client falls back to `http://127.0.0.1:8765` when it has no validated network).

Device detection is push-based: one `adb track-devices -l` connection tells the server when anything is plugged or unplugged, so an idle server costs nothing. Only while an adopted device is connected does it list `Download/R1CORD/` every `usb_poll_s` seconds to catch a recording that finishes on the cable.

The server binds `127.0.0.1` only. Without a tunnel nothing off this PC can reach it; a resident server is not exposed.

## Install (customers)

Windows 10/11. Unzip (or clone) this folder anywhere, then double-click **`install.bat`**. It:

1. finds Python 3.12+ (`py -3.12`, `py -3.13`, or `python`) — or offers to download the official python.org installer for the current user;
2. creates `.venv` and installs the server with CPU transcription (`install.bat --gpu` adds the NVIDIA CUDA runtime, ~2 GB);
3. finds `adb` (PATH, the Android SDK) or downloads Google's platform-tools into `tools\`;
4. writes the first-run config to `%LOCALAPPDATA%\R1CORD\config.toml` (recordings go to `%LOCALAPPDATA%\R1CORD\data`);
5. adds a Start-menu shortcut **R1CORD Server** and starts the server (`--no-start` to skip).

Nothing is installed system-wide except Python (only if you said yes) and the shortcut. `uninstall.bat` removes the venv, `tools\`, the shortcut and any scheduled task; it keeps your config and recordings.

Then on the R1: **Developer options → USB debugging on**, plug in, accept *Allow USB debugging*. In the admin page: **Devices → Adopt**. Recordings are pulled and transcribed from then on. `transcribe` is the default action; `review` (the default AI reviews) needs a writer CLI logged in on the PC, `publish` also copies the pages into `webdav_folder` (a local folder by default; point it at your WebDAV mount) — both optional, both set on the Settings page. The **System** page shows whether each of those is ready.

The first transcription downloads the Whisper model (`large-v3-turbo`, ~1.6 GB) — the job log says so. On a CPU-only PC choose a smaller `asr_model` (`small`, `medium`) in Settings if it is too slow.

## Run

**Start-menu → R1CORD Server**, or double-click `start-server.bat`: starts the server hidden if it is not already running, waits for it to answer, opens `http://127.0.0.1:<port>/admin`. Set `R1CORD_NO_BROWSER=1` to start without opening a page.

While the server is running, plugging in an adopted device opens the admin dashboard in the default browser. A device that was already connected when the server started does not open one (`start-server.bat` already has), and neither does adopting a device that is already on the cable.

By hand: `.venv\Scripts\python.exe -m r1cord_server` (flags: `--config PATH`, `--port N`, `--no-tray`; env `R1CORD_SERVER_CONFIG` also selects the TOML).

### Notification-area (systray) icon

While the server runs on Windows it shows the R1CORD logomark in the notification area. Hover for a one-line status (device, current job); left-click opens the dashboard; right-click for the menu:

| Item | Does |
|---|---|
| *R1CORD Server* / device line / job line | Status only: `Rabbit R1 connected`, `No device connected`, `USB mode off`; `Idle`, `3 queued`, `Transcribing: <title>` |
| **Open dashboard** (also a left-click on the icon) | `/admin` in the default browser |
| **Devices**, **Settings** | Those admin pages |
| **USB mode** | On/off switch, same as the button on the Devices page; saved to `config.toml` |
| **Email finished jobs** | On/off switch for `email_enabled`; greyed out until `email_to` is set |
| **Open recordings folder** / **Open logs folder** | `<datastore>\inbox` / `<datastore>\logs` in Explorer |
| **Quit R1CORD Server** | Stops the server. In `run_mode = always` it starts again at the next logon; otherwise use `start-server.bat` |

When a job finishes the icon shows a Windows notification with the recording title: *Transcript ready* (no AI reviews), *<Review> ready* (one review, e.g. *Summary ready*), *AI reviews ready* (several) or *Job failed*. Windows 11 puts new tray icons in the hidden-icons overflow (`^`); to keep it on the taskbar, drag it out of the overflow or turn it on under **Settings → Personalization → Taskbar → Other system tray icons** (listed as *Python* / *pythonw*, because the server runs under `pythonw.exe`). `--no-tray` or `R1CORD_NO_TRAY=1` starts the server without the icon.

**Login:** none when you open the admin page on this PC. The HTTP Basic password (`admin` / `admin_password`, shown on the Settings page) is only asked for when the page is reached through a tunnel or proxy (`CF-Connecting-IP` / `X-Forwarded-For` present).

Default listen address is `127.0.0.1:8765`. Do not bind `0.0.0.0` unless you set `listen_host` on purpose.

### Lifecycle: `run_mode`

| `run_mode` | How it runs | Who |
|---|---|---|
| `plug` (default) | No autostart. Plug the device in, double-click `start-server.bat` (opens the admin page). The server exits itself after `idle_exit_min` minutes with no adopted device connected, no admin activity and an idle queue. | USB-only users |
| `always` | `install-task.ps1 -Mode always` registers a per-user Task Scheduler at-logon task (15 s delay, restart on failure, `pythonw`, no window). Stays resident. | Wi-Fi / tunnel users |

`install-task.ps1` with no `-Mode` reads `run_mode` from `config.toml`; in `plug` mode it removes any at-logon task. `uninstall-task.ps1` removes the task. Headless runs write uvicorn's console output to `<datastore>\logs\console.log`.

Why not "start on plug"? Windows logs no on-by-default event when an already-installed device is re-plugged (Kernel-PnP 400/410 fire only on driver configuration); the only no-process trigger is a permanent WMI subscription, which needs admin and is a known persistence technique. A resident server idles at ~55 MB and ~0 CPU, so `always` is the cheaper honest answer if you want zero clicks.

```
powershell -ExecutionPolicy Bypass -File install-task.ps1 -Mode always
```

## Paths

| What | Where |
|---|---|
| Config | `%LOCALAPPDATA%\R1CORD\config.toml` (or `R1CORD_SERVER_CONFIG` / `--config`) |
| Data (`datastore`) | `%LOCALAPPDATA%\R1CORD\data` by default; point it at a big drive in the TOML |
| Headless console output | `<datastore>\logs\console.log` |
| Server log | `<datastore>\logs\server.log` |

## USB mode

1. USB debugging on the R1 is on and this PC is authorized (it already is on the provisioned R1).
2. Plug the device in. The **Devices** page lists it as *Connected, not adopted*. Nothing is pulled until you click **Adopt**.
3. From then on the tracker sees the device arrive; while it is connected the watcher lists `usb_device_root` every `usb_poll_s` (default 3 s) with one `find … -exec stat` call, pulls new or changed files into `inbox/<recordingId>/`, and — for a recording seen for the first time in `SAVED` state with no existing job — queues a job per `usb_auto_action`. Folders still being recorded (`metadata.json` status `RECORDING`/`PAUSED`, or no `metadata.json` yet) are skipped until Stop.
4. A recording that already reached the server over Wi-Fi is recognized by name and size; nothing is transferred twice and no second job is created. Files that change later (a photo added on the device) are pulled and the row shows *changed since job*; **Re-process** is manual.
5. The server never deletes anything on the device.

Flags on the Devices page: *audio differs from inbox* (device audio hash ≠ inbox audio; the inbox copy is kept), *pull failed*, *could not queue*, *interrupted — archive only* (`audio.interrupted.m4a` is archived but not processed).

Turn USB mode off (Devices page button, tray menu, or `usb_enabled`) before any mtkclient / fastboot work so the watcher is not talking to the transport.

## Pairing

1. In `/admin/devices`, under **Wi-Fi pairing**, click **Generate pairing code**.
2. On the R1, enter the six-digit code (single-use, 10 minutes).
3. The device stores a bearer token. Every `/v1` route except `POST /v1/pair` requires `Authorization: Bearer <token>`.
4. Revoke a device's key on the same panel if the device is lost.

## The dashboard

`/admin` answers "is it working, and where are my recordings": four tiles (**Device**, **Now**, **Queue**, **System**) and the **Recordings** list. Everything else has its own page: pairing and USB on **Devices**, dependency checks and version on **System**, config on **Settings**. The page reloads itself only while a job is running or queued or a pull is in progress.

**Recordings** has one row per recording (its latest job; "N runs" when it was re-processed): title, **Length**, audio size, status, writer, updated time (local), and five buttons. Under the title are the recording's page links in the order Transcript, Summary, Outline, Organized, each followed by an **.md** link to its Markdown: a plain link opens the published page; a link tagged *local* is not published and opens the same pages as built on this PC (`/admin/site/<recordingId>/<kind>.html`). **Play** plays the audio in the page itself (a second press pauses; Length counts up while it plays), so it needs no media player and works through a tunnel too. **Download** saves it through the browser. **Folder** opens Explorer with the file selected (`<datastore>\inbox\<recordingId>\`) and brings that window in front of the browser; Windows keeps windows opened by a background process behind the one you clicked, so `desktop.reveal_in_explorer` raises it (or flashes its taskbar button if Windows still refuses). Folder acts on this PC's desktop, so it appears, and works, only when the admin page is opened on this PC; through a tunnel or proxy the route answers `403`. **Add review** (+) writes one more AI review — or rewrites one that exists — from the existing transcript as a new job with the default writer; the job publishes when the recording's latest job did. It is greyed out while a job is running or queued and before there is a transcript.

**Delete** (after a confirm) removes the recording from this PC: inbox, outbox, work folder, its published pages under `webdav_folder`, and its job history. It is refused while the recording has a queued or running job. The R1's copy is never touched, and USB mode will not pull that recording again; sending it from the R1 or importing it brings it back.

## Email

With `email_enabled` on, every job that finishes (`complete`) is emailed to `email_to`: subject = recording title, body = the recording's best AI review (Summary, else Cleaned up & organized, else Outline; the transcript when there is none), then a link to every published page and the job page link. It is sent through the Google Workspace CLI (`gws`) from the Gmail account it is signed in with (`gws auth login`); the server calls the native `gws.exe` behind the npm shim so long messages are not cut by `cmd.exe`. A failed send is written to the job log and never changes the job's status. **Email review** on a job page sends (or resends) it by hand.

## AI reviews

| Review | File | Published page |
|---|---|---|
| Transcript (no AI; the server builds it from `transcript.txt`) | `transcript.md` | `transcript.html` |
| Summary | `summary.md` | `summary.html` |
| Outline | `outline.md` | `outline.html` |
| Cleaned up & organized | `organized.md` | `organized.html` |

The R1 chooses the reviews on each Send; USB mode, **Import folder** and `review` / `publish` actions use `default_reviews`. Each review runs the writer on its own; one that fails is logged and the others still run and publish, and the job ends in `error` naming the failed review. With publish on, all of a recording's pages go into its one publish folder, so pages added later sit beside the earlier ones and `summary.html` links from before stay valid.

Each review's prompt is editable on **Settings → AI reviews**; an edit is saved as `%LOCALAPPDATA%\R1CORD\prompts\<kind>.md` (beside `config.toml`) and **Restore default** deletes it. The server always wraps the prompt in a fixed part (which file to write, the title heading, photos, the recording's date and length, never invent facts), so an edit cannot break the published page.

## Pages and themes

After every job the server builds the recording's pages on this PC, published or not: `<kind>.html` beside its `<kind>.md` source for the transcript and every review, the theme's stylesheet, the photos the pages show, and a `.r1cord-site.json` manifest, in `<datastore>\outbox\<recordingId>\site\`. That build is the *local* view on the dashboard. Publishing copies the same build into the recording's folder under `webdav_folder` (`<YYYY>\<MM>\<YYYYMMDD-HHMM>-<slug>\`), so the local and public pages cannot differ.

Every page has navigation to the recording's other pages and a **Download .md** link. Raw HTML in the Markdown is shown as text. Links are kept only to `http(s)` / `mailto` addresses, `#anchors` and the recording's own pages; an image is shown only when it is one of the recording's own photos (anything else becomes its caption in italics).

**Settings → Pages** picks the theme: one of the 12 themes vendored from MD DOCS, with a live preview of a sample recording. A new theme applies to pages built from then on; pages already published keep theirs until you republish them. **Preview republish** is a dry run: per published recording, the pages it would write and the leftover `<kind>.css` / `<kind>_images\` files of the old publisher it would remove. **Republish all pages** (behind a confirm) then rebuilds each recording from the Markdown on this PC, deploys it into its folder and removes only those leftovers; progress and results are on `/admin/republish`. A recording with a running job, no Markdown on this PC, or a folder outside `webdav_folder` is skipped.

A deploy writes the stylesheets and photos first, then the `.md` sources, then the pages (`summary.html` last), then the manifest; files that did not change since the last deploy are skipped. It removes only files the folder's previous manifest listed; anything else in a recording's folder is never touched.

## Config keys

Stored in `%LOCALAPPDATA%\R1CORD\config.toml`. The admin form edits every field except `datastore`. Host/port changes take effect on restart.

| key | default |
|---|---|
| `server_name` | `R1CORD` |
| `listen_host` | `127.0.0.1` |
| `listen_port` | `8765` |
| `datastore` | `%LOCALAPPDATA%\R1CORD\data` |
| `webdav_folder` | `%LOCALAPPDATA%\R1CORD\publish` (point it at the WebDAV mount) |
| `public_url_base` | empty |
| `theme` | `toolmaker-noir` (a theme id, chosen on **Settings → Pages**; an older config's theme name is read as its id) |
| `default_writer` | `claude_code` (`codex`, `grok_build`, `none`) |
| `default_reviews` | `["summary"]` (any of `summary`, `outline`, `organized`; `[]` = transcript only) |
| `writer_timeout_s` | `900` |
| `claude_cmd` / `codex_cmd` / `grok_cmd` | `claude` / `codex` / `grok` |
| `asr_model` | `large-v3-turbo` |
| `asr_device` | `auto` |
| `asr_language` | empty (auto-detect) |
| `pair_code_ttl_s` | `600` |
| `usb_enabled` | `true` |
| `adb_cmd` | `adb` (any Google platform-tools copy; `install.bat` downloads one if needed) |
| `usb_poll_s` | `3` |
| `usb_auto_action` | `transcribe` (`archive`, `review`, `publish`; a config that still says `summarize` reads as `review`) |
| `usb_device_root` | `/sdcard/Download/R1CORD` |
| `run_mode` | `plug` (`always`) |
| `idle_exit_min` | `10` — plug mode only |
| `email_enabled` | `false` |
| `email_to` | empty (nothing is sent until set) |
| `gws_cmd` | `gws` |

Adopted device serials live in `index.sqlite` (`devices` table), not in the TOML; use the Devices page. A `default_summary_style` left in an older config is ignored.

## Folder layout

```
%LOCALAPPDATA%\R1CORD\config.toml
%LOCALAPPDATA%\R1CORD\prompts\<kind>.md   edited AI review prompts (only when changed)
<datastore>\index.sqlite
<datastore>\inbox\<recordingId>\     job.json, metadata.json, audio.*, photo-*.jpg
<datastore>\work\<recordingId>\<jobId>\<kind>\
<datastore>\outbox\<recordingId>\    transcript.*, transcript.md, <kind>.md, <kind>.<jobId>.md, photos\, site\, result.json, job.log
<datastore>\cache\theme-preview\<theme>\   sample recording built for the Settings theme preview
<datastore>\logs\server.log
<webdav_folder>\<YYYY>\<MM>\<YYYYMMDD-HHMM>-<slug>\   <kind>.html, <kind>.md, assets\, photos\, .r1cord-site.json
```

## Retries

From the job page or the API:

- **Rewrite reviews** (job page, *Retry* card) — needs a transcript. Queues the job with ASR skipped. You can pick `claude_code`, `codex`, or `grok_build`, and which reviews to write (the job's own by default, at least one). A review that is rewritten keeps its previous version as `<kind>.<jobId>.md`.
- **Republish pages** (job page, *Retry* card) — needs a transcript or any review. No AI runs. Rebuilds the pages from every page whose Markdown exists, in the current theme, and deploys them. A failed publish does not delete the Markdown.

To add a review the recording never had, use **Add review** (+) on the dashboard.

A failed ASR / writer / publish step sets `status=error` with `error` naming the step. Earlier outputs stay on disk.
