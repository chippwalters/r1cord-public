# r1cord-server

Desktop offload server for the R1CORD recorder. It receives recordings from the Rabbit R1, transcribes them with faster-whisper, writes a Markdown summary with a coding-agent CLI, and publishes that file through MD DOCS into a WebDAV folder.

Two ways a recording gets in, one pipeline:

| Mode | Who drives | How |
|---|---|---|
| **USB** | the server | Plug an adopted R1 in with USB debugging on. The watcher pulls every finished recording under `Download/R1CORD/` over `adb`, then runs the configured `usb_auto_action` (`archive`, `transcribe`, `summarize`, `publish`). Per-recording actions live on the **Devices** page. |
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

Then on the R1: **Developer options → USB debugging on**, plug in, accept *Allow USB debugging*. In the admin page: **Devices → Adopt**. Recordings are pulled and transcribed from then on. `transcribe` is the default action; `summarize` needs a writer CLI logged in on the PC, `publish` needs the MD DOCS app — both optional, both set on the Config page.

The first transcription downloads the Whisper model (`large-v3-turbo`, ~1.6 GB) — the job log says so. On a CPU-only PC choose a smaller `asr_model` (`small`, `medium`) in Config if it is too slow.

## Run

**Start-menu → R1CORD Server**, or double-click `start-server.bat`: starts the server hidden if it is not already running, waits for it to answer, opens `http://127.0.0.1:<port>/admin`. Set `R1CORD_NO_BROWSER=1` to start without opening a page.

By hand: `.venv\Scripts\python.exe -m r1cord_server` (flags: `--config PATH`, `--port N`; env `R1CORD_SERVER_CONFIG` also selects the TOML).

**Login:** none when you open the admin page on this PC. The HTTP Basic password (`admin` / `admin_password`, shown on the Config page) is only asked for when the page is reached through a tunnel or proxy (`CF-Connecting-IP` / `X-Forwarded-For` present).

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
2. Plug the device in. The dashboard's **USB mode** block and the **Devices** page list it as *connected, not adopted*. Nothing is pulled until you click **Adopt**.
3. From then on the tracker sees the device arrive; while it is connected the watcher lists `usb_device_root` every `usb_poll_s` (default 3 s) with one `find … -exec stat` call, pulls new or changed files into `inbox/<recordingId>/`, and — for a recording seen for the first time in `SAVED` state with no existing job — queues a job per `usb_auto_action`. Folders still being recorded (`metadata.json` status `RECORDING`/`PAUSED`, or no `metadata.json` yet) are skipped until Stop.
4. A recording that already reached the server over Wi-Fi is recognized by name and size; nothing is transferred twice and no second job is created. Files that change later (a photo added on the device) are pulled and the row shows *changed since job*; **Re-process** is manual.
5. The server never deletes anything on the device.

Flags on the Devices page: *audio differs from inbox* (device audio hash ≠ inbox audio; the inbox copy is kept), *pull failed*, *could not queue*, *interrupted — archive only* (`audio.interrupted.m4a` is archived but not processed).

Turn USB mode off (dashboard button or `usb_enabled`) before any mtkclient / fastboot work so the watcher is not talking to the transport.

## Pairing

1. In `/admin`, click **Generate pairing code**.
2. On the R1, enter the six-digit code (single-use, 10 minutes).
3. The device stores a bearer token. Every `/v1` route except `POST /v1/pair` requires `Authorization: Bearer <token>`.
4. Revoke a token from the dashboard if the device is lost.

## Config keys

Stored in `%LOCALAPPDATA%\R1CORD\config.toml`. The admin form edits every field except `datastore`. Host/port changes take effect on restart.

| key | default |
|---|---|
| `server_name` | `R1CORD` |
| `listen_host` | `127.0.0.1` |
| `listen_port` | `8765` |
| `datastore` | `%LOCALAPPDATA%\R1CORD\data` |
| `webdav_folder` | `%LOCALAPPDATA%\R1CORD\publish` (publish needs MD DOCS) |
| `public_url_base` | empty |
| `theme` | `Toolmaker-Noir` |
| `default_writer` | `claude_code` (`codex`, `grok_build`, `none`) |
| `default_summary_style` | `notes` |
| `writer_timeout_s` | `900` |
| `claude_cmd` / `codex_cmd` / `grok_cmd` | `claude` / `codex` / `grok` |
| `asr_model` | `large-v3-turbo` |
| `asr_device` | `auto` |
| `asr_language` | empty (auto-detect) |
| `pair_code_ttl_s` | `600` |
| `usb_enabled` | `true` |
| `adb_cmd` | `adb` (any Google platform-tools copy; `install.bat` downloads one if needed) |
| `usb_poll_s` | `3` |
| `usb_auto_action` | `transcribe` (`archive`, `summarize`, `publish`) |
| `usb_device_root` | `/sdcard/Download/R1CORD` |
| `run_mode` | `plug` (`always`) |
| `idle_exit_min` | `10` — plug mode only |

Adopted device serials live in `index.sqlite` (`devices` table), not in the TOML; use the Devices page.

## Folder layout

```
%LOCALAPPDATA%\R1CORD\config.toml
<datastore>\index.sqlite
<datastore>\inbox\<recordingId>\     job.json, metadata.json, audio.*, photo-*.jpg
<datastore>\work\<recordingId>\<jobId>\
<datastore>\outbox\<recordingId>\    transcript.*, summary.md, result.json, job.log
<datastore>\logs\server.log
```

## Retries

From the job page or the API:

- **Retry writer** — needs a transcript. Queues the job with ASR skipped. You can pick `claude_code`, `codex`, or `grok_build`. The previous `summary.md` is kept as `summary.<jobId>.md`.
- **Retry publish** — needs `summary.md`. Re-runs only the MD DOCS step. A failed publish does not delete the summary.

A failed ASR / writer / publish step sets `status=error` with `error` naming the step. Earlier outputs stay on disk.
