// The local admin UI: recordings, devices, settings, system and job pages, plus the JSON the
// desktop shell polls. Port of r1cord_server/admin.py. Every route runs requireAdmin first (the
// Host/Origin checks, then local-direct, else 403 when admin_remote is off, else HTTP Basic);
// forms and JSON bodies are read only after that, so an unauthenticated caller never learns more
// than 401/403.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isLocalDirect, requireAdminHook } = require('../auth');
const {
  PAGE_KINDS,
  PAGE_LABELS,
  PAGE_SHORT_LABELS,
  REVIEW_KINDS,
  RUN_MODES,
  USB_ACTIONS,
  saveConfig,
  withUpdates,
} = require('../config');
const desktop = require('../desktop');
const { ValueError } = require('../errors');
const { HttpError } = require('../http-error');
const { logHandled, requestPath } = require('../log');
const { MailError, gwsExecutable } = require('../mailer');
const naming = require('../naming');
const { pathString } = require('../paths');
const render = require('../render');
const { errorText, isFile, pyInt, pyStrRepr, pyStrip, pyTruthy, readText } = require('../pipeline/compat');
const instructions = require('../pipeline/instructions');
const publish = require('../pipeline/publish');
const { AUDIO_NAMES, StoreError } = require('../store');
const tray = require('../status');
const { serverVersion, systemChecks } = require('./checks');
const {
  elapsed,
  formatDuration,
  humanSize,
  localTime,
  pyQuote,
  redirectLocation,
  statusView,
} = require('./format');
const { sendFile } = require('./send-file');
const { isAbort } = require('../platform-tools');
const views = require('./views');

// Statuses of a job still being worked on (the dashboard's Now tile skips queued ones).
const PROCESSING = new Set(['queued', 'transcribing', 'transcribed', 'writing', 'written', 'publishing']);
const FORM_BODY_LIMIT = 1024 * 1024;

// The pages carry their own CSP meta tag (with their theme's font hosts); this header is the outer
// bound, and the one thing a meta tag cannot say: only the admin itself may frame them.
const SITE_HEADERS = {
  'content-security-policy':
    "default-src 'none'; img-src 'self' data:; style-src 'self' https:; font-src 'self' https: data:; " +
    "script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  'x-content-type-options': 'nosniff',
};
const SITE_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

const SAMPLE_TITLE = 'Site visit, north lot';
const SAMPLE_PAGES = {
  transcript: `# Site visit, north lot

*2026-09-20 16:15 · 4:12*

Okay, we're at the north lot. The gate on the east side is sticking again, it needs new hinges.

The drainage by the loading dock looks better since the regrade, but there's still standing water after rain.
`,
  summary: `# Site visit, north lot

A walk around the north lot to check the east gate and the drainage after last month's regrade.
The gate needs new hinges; the drainage is better but not fixed.

## Key points

- The **east gate** sticks and needs new hinges.
- Drainage by the loading dock improved after the regrade.
- Standing water still collects after heavy rain.

## Action items

- [ ] Order two heavy-duty hinges for the east gate.
- [ ] Ask the contractor about a second drain near the dock.
- [x] Photograph the dock after the next storm.

| Area | Status | Next step |
| --- | --- | --- |
| East gate | Sticking | New hinges |
| Loading dock | Better | Second drain |

> "It's better, but it's not done."
`,
  outline: `# Site visit, north lot

- East gate
    - Sticks when opened
    - Needs new hinges
- Drainage
    - Better since the regrade
    - Standing water after rain
`,
  organized: `# Site visit, north lot

## East gate

The gate on the east side is sticking again. It needs new hinges.

## Drainage

The drainage by the loading dock is better since the regrade, but water still stands there after rain.
`,
};

// --- paths ---------------------------------------------------------------------------------------

// Python's Path.resolve(): symlinks and junctions resolved as far as the path exists.
function resolvePath(target) {
  const absolute = path.resolve(String(target));
  try {
    return fs.realpathSync.native(absolute);
  } catch (_error) {
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(resolvePath(parent), path.basename(absolute));
  }
}

// Path equality: case-insensitive on Windows.
function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// `root in target.parents`: target strictly below root.
function strictlyInside(root, target) {
  let dir = path.dirname(target);
  for (;;) {
    if (samePath(dir, root)) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** The recording's audio in the inbox, or null. Rejects ids that would leave the inbox. */
function audioFile(config, recordingId) {
  const inbox = resolvePath(path.join(String(config.datastore), 'inbox'));
  const folder = resolvePath(path.resolve(inbox, recordingId));
  if (!samePath(path.dirname(folder), inbox)) return null;
  for (const name of [...AUDIO_NAMES].sort()) {
    const file = path.join(folder, name);
    if (isFile(file)) return file;
  }
  return null;
}

/** The recording's outbox folder (not created), or null for an id that would leave outbox/. */
function outboxFolder(config, recordingId) {
  const root = resolvePath(path.join(String(config.datastore), 'outbox'));
  const folder = resolvePath(path.resolve(root, recordingId));
  return samePath(path.dirname(folder), root) ? folder : null;
}

function sourceKinds(outbox) {
  return outbox !== null ? publish.sourceKinds(outbox) : [];
}

// Every file under an outbox folder in Python's sorted(rglob) order, as posix-relative parts.
function outboxEntries(outbox) {
  const entries = [];
  const walk = (dir, parts) => {
    let names;
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_error) {
      return;
    }
    for (const entry of names) {
      const rel = [...parts, entry.name];
      entries.push(rel);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
    }
  };
  walk(outbox, []);
  const key = (parts) => (process.platform === 'win32' ? parts.map((part) => part.toLowerCase()) : parts);
  entries.sort((a, b) => {
    const left = key(a);
    const right = key(b);
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
    }
    return left.length - right.length;
  });
  return entries;
}

// --- page helpers --------------------------------------------------------------------------------

/**
 * Transcript / Summary / Outline / Organized for a recording, each with its Markdown: the published
 * `<kind>.html` / `<kind>.md` when they are in its publish folder, else the site built on this PC.
 */
function pageLinks(config, job) {
  const published = naming.publishedFiles(config, job.publishFolder);
  const local = sourceKinds(outboxFolder(config, job.recordingId));
  const site = `/admin/site/${pyQuote(job.recordingId, '')}/`;
  const links = [];
  for (const kind of PAGE_KINDS) {
    const page = Object.hasOwn(published, `${kind}.html`) ? published[`${kind}.html`] : null;
    if (page === null && !local.includes(kind)) continue;
    const md = Object.hasOwn(published, `${kind}.md`) ? published[`${kind}.md`] : null;
    links.push({
      kind,
      label: PAGE_SHORT_LABELS[kind],
      url: page !== null ? page : `${site}${kind}.html`,
      local: page === null,
      mdUrl: md !== null ? md : local.includes(kind) ? `${site}${kind}.md` : null,
      mdLocal: md === null,
    });
  }
  return links;
}

/** The Add review menu: each kind labelled Write, or Rewrite when it already exists. */
function reviewChoices(config, recordingId) {
  const existing = sourceKinds(outboxFolder(config, recordingId));
  return REVIEW_KINDS.map((kind) => ({
    kind,
    label: PAGE_LABELS[kind],
    verb: existing.includes(kind) ? 'Rewrite' : 'Write',
  }));
}

/** Length from the device's metadata.json, else from the transcript; '' when neither says. */
function recordingDuration(config, recordingId) {
  const root = String(config.datastore);
  for (const file of [
    path.join(root, 'inbox', recordingId, 'metadata.json'),
    path.join(root, 'outbox', recordingId, 'transcript.json'),
  ]) {
    let ms;
    try {
      const data = JSON.parse(readText(file));
      if (data === null || typeof data !== 'object' || Array.isArray(data)) continue;
      const value = Object.hasOwn(data, 'durationMs') ? data.durationMs : null;
      ms = pyInt(pyTruthy(value) ? value : 0);
    } catch (_error) {
      continue;
    }
    if (ms > 0) return formatDuration(ms);
  }
  return '';
}

function runningJob(store) {
  for (const rec of store.recentJobs(50)) {
    if (PROCESSING.has(rec.status) && rec.status !== 'queued') {
      const lines = store.readLog(rec.jobId, 1);
      return { job: rec, elapsed: elapsed(rec.updatedAt), lastLog: lines.length ? lines[lines.length - 1] : '' };
    }
  }
  return null;
}

/** Save config.toml and swap the live config into every component that holds one. */
function applyConfig(state, newConfig) {
  const previousMode = state.config.run_mode;
  saveConfig(newConfig, state.configPath);
  state.config = newConfig;
  state.store.config = newConfig;
  state.worker.config = newConfig;
  if (newConfig.run_mode !== previousMode) {
    const host = state.host;
    if (host && typeof host.runModeChanged === 'function') host.runModeChanged(newConfig.run_mode);
  }
}

function checks(state) {
  return systemChecks(state.config, { store: state.store, modelDownload: state.modelDownload, configDir: state.configDir });
}

// Python's OSError: a Node system error (ENOENT, EACCES, ...).
function isOsError(error) {
  return Boolean(error) && typeof error.code === 'string' && /^E[A-Z0-9]+$/.test(error.code);
}

// Look for the queued job now instead of at the worker's next poll.
function wake(state) {
  if (state.worker && typeof state.worker.wake === 'function') state.worker.wake();
}

// --- request and response helpers ----------------------------------------------------------------

function decodedPath(request) {
  const raw = requestPath(request);
  try {
    return decodeURIComponent(raw);
  } catch (_error) {
    return raw;
  }
}

function queryValue(request, name) {
  const url = String(request.raw.url || '');
  const q = url.indexOf('?');
  const values = new URLSearchParams(q === -1 ? '' : url.slice(q + 1)).getAll(name);
  return values.length ? values[values.length - 1] : null;
}

async function readBody(request) {
  const stream = request.body;
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > FORM_BODY_LIMIT) throw new HttpError(413, 'http_error', 'Request Entity Too Large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The posted form, read the way FastAPI's Form() reads it; any other body is an empty form. */
async function readForm(request) {
  const body = await readBody(request);
  const type = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  return new Form(type === 'application/x-www-form-urlencoded' ? new URLSearchParams(body.toString('utf8')) : new URLSearchParams());
}

// pydantic's lax int from a string: surrounding space, underscores and a zero fraction allowed.
function laxInt(text) {
  const trimmed = String(text).trim();
  const match = /^([+-]?\d+(?:_\d+)*)(?:\.0*)?$/.exec(trimmed);
  return match ? Number(match[1].replace(/_/g, '')) : null;
}

const TRUE_WORDS = new Set(['1', 'on', 't', 'true', 'y', 'yes']);
const FALSE_WORDS = new Set(['0', 'off', 'f', 'false', 'n', 'no']);

// Form fields with FastAPI's rules: the last value wins, an empty string counts as absent, and
// every validation problem is collected (in declaration order) for one 422.
class Form {
  constructor(params) {
    this.params = params;
    this.errors = [];
  }

  value(name) {
    const values = this.params.getAll(name);
    const last = values.length ? values[values.length - 1] : '';
    return last === '' ? null : last;
  }

  str(name, fallback = '') {
    const value = this.value(name);
    return value === null ? fallback : value;
  }

  required(name) {
    const value = this.value(name);
    if (value === null) this.errors.push(`${name}: Field required`);
    return value === null ? '' : value;
  }

  int(name, fallback) {
    const value = this.value(name);
    if (value === null) return fallback;
    const number = laxInt(value);
    if (number === null) this.errors.push(`${name}: Input should be a valid integer, unable to parse string as an integer`);
    return number;
  }

  list(name) {
    const values = this.params.getAll(name);
    return values.length ? values : null;
  }
}

function invalid(request, reply, errors) {
  logHandled(request.server.state.loggers.app, request, 422, 'invalid_request');
  return reply.code(422).send({ error: 'invalid_request', message: errors.join('; ') });
}

function sendHtml(reply, content, status = 200) {
  return reply.code(status).type('text/html; charset=utf-8').send(String(content));
}

function redirect(reply, url) {
  return reply.code(303).header('location', redirectLocation(url)).send();
}

function page(request, reply, view, context, status = 200) {
  const state = request.server.state;
  return sendHtml(reply, view({ path: decodedPath(request), config: state.config, refresh: false, ...context }), status);
}

/** A file of a built site under `root` (resolved), never anything outside it. */
function siteFile(request, reply, log, root, name) {
  const target = resolvePath(path.resolve(root, name));
  if (!strictlyInside(root, target)) {
    log.info(`site: rejected ${pyStrRepr(name)}`);
    return sendHtml(reply, 'invalid path', 400);
  }
  if (!isFile(target)) return sendHtml(reply, 'not found', 404);
  return sendFile(request, reply, target, {
    mediaType: SITE_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
    headers: SITE_HEADERS,
  });
}

/** The page kind a site file name is ("summary" for summary.html or summary.md); null otherwise. */
function pageKind(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  const kind = name.slice(0, dot);
  const ext = name.slice(dot + 1);
  return (ext === 'html' || ext === 'md') && PAGE_KINDS.includes(kind) ? kind : null;
}

// --- desktop status (tray) -----------------------------------------------------------------------

/** Client-supplied map of job_id -> last seen status. Empty means a first poll: no toasts. */
function parseStatusCursor(raw) {
  if (raw === null || pyStrip(raw) === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new HttpError(422, 'invalid_request', `cursor is not JSON: ${errorText(error)}`);
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((value) => typeof value !== 'string')
  ) {
    throw new HttpError(422, 'invalid_request', 'cursor must be a JSON object of job id to status');
  }
  return parsed;
}

// The job fields the tray line formatters read, as tray.py names them.
function trayJob(rec) {
  return {
    job_id: rec.jobId,
    recording_id: rec.recordingId,
    title: rec.title,
    status: rec.status,
    reviews: rec.reviews,
    error: rec.error,
  };
}

/** JSON the desktop shell polls: the same lines the tray shows, plus jobs that just finished. */
function statusBody(state, cursor) {
  const { store, config } = state;
  const usb = state.usb.status();
  const jobs = store.recentJobs(50).map(trayJob);
  const finished = tray.finishedSince(cursor, jobs);
  let running = null;
  let queued = 0;
  for (const job of jobs) {
    if (job.status === 'queued') {
      queued += 1;
    } else if (running === null && tray.PROCESSING.has(job.status)) {
      running = { job_id: job.job_id, recording_id: job.recording_id, status: job.status, title: job.title || job.recording_id };
    }
  }
  const datastore = pathString(config.datastore);
  return {
    version: serverVersion(),
    device_line: tray.deviceLine(usb.connected, usb.enabled),
    work_line: tray.workLine(jobs),
    running,
    queued,
    finished,
    cursor,
    usb_enabled: Boolean(config.usb_enabled),
    email_enabled: Boolean(config.email_enabled),
    email_to: String(config.email_to || ''),
    recordings_folder: path.join(datastore, 'inbox'),
    logs_folder: path.join(datastore, 'logs'),
    listen_port: Number(config.listen_port),
    listen_host: String(config.listen_host),
    adopted_serials: [...store.adoptedSerials()].sort(),
    window_open: Boolean(state.windowOpen),
  };
}

// --- routes --------------------------------------------------------------------------------------

function registerAdmin(app) {
  const log = app.state.logger.getLogger('r1cord_server.admin');
  // Sample sites already built by this process; the renderer only changes with the code.
  const previews = new Set();

  async function dashboard(request, reply) {
    const state = request.server.state;
    const { store, config } = state;
    const usb = state.usb.status();
    const rows = [];
    let queued = 0;
    for (const [job, runs] of store.latestJobs(100)) {
      const audio = audioFile(config, job.recordingId);
      const [label, tone] = statusView(job.status);
      if (job.status === 'queued') queued += 1;
      const outbox = outboxFolder(config, job.recordingId);
      rows.push({
        job,
        pages: pageLinks(config, job),
        reviews: reviewChoices(config, job.recordingId),
        hasTranscript: outbox !== null && isFile(path.join(outbox, 'transcript.txt')),
        runs,
        duration: recordingDuration(config, job.recordingId),
        size: audio ? humanSize(fs.statSync(audio).size) : '',
        hasAudio: audio !== null,
        statusLabel: label,
        statusTone: tone,
        updated: localTime(job.updatedAt),
      });
    }
    const running = runningJob(store);
    const adopted = usb.connected.filter((row) => row[2]).map(([serial, model]) => model || serial);
    const issues = (await checks(state)).filter((c) => c.state === 'warn');
    return page(request, reply, views.dashboard, {
      rows,
      running,
      runningLabel: running ? statusView(running.job.status)[0] : '',
      queued,
      usb,
      device: adopted.length ? adopted[0].replace(/_/g, ' ') : '',
      issues,
      local: isLocalDirect(request),
      notice: queryValue(request, 'notice'),
      deleted: queryValue(request, 'deleted'),
      // Keep the page current while something is moving; a still dashboard never reloads.
      refresh: running !== null || queued > 0 || (usb.syncing !== null && usb.syncing !== undefined),
    });
  }

  async function systemPage(request, reply) {
    const state = request.server.state;
    const recent = state.store.recentJobs(1);
    const model = state.modelDownload ? state.modelDownload.snapshot(state.config) : null;
    return page(request, reply, views.system, {
      checks: await checks(state),
      lastJob: recent.length ? localTime(recent[0].updatedAt) : 'never',
      serverVersion: serverVersion(),
      configPath: state.configPath || '',
      model,
    });
  }

  async function modelDownloadStart(request, reply) {
    const state = request.server.state;
    const log = (line) => state.loggers.app.info(line);
    state.modelDownload.start(state.config, { log }).catch((error) => {
      const aborted = error && (error.name === 'AbortError' || /abort/i.test(String(error.message || '')));
      if (!aborted) state.loggers.app.warn(`model download: ${errorText(error)}`);
    });
    return redirect(reply, '/admin/system');
  }

  async function modelDownloadCancel(request, reply) {
    request.server.state.modelDownload.cancel();
    return redirect(reply, '/admin/system');
  }

  async function recordingDelete(request, reply) {
    const { recordingId } = request.params;
    try {
      request.server.state.store.deleteRecording(recordingId);
    } catch (error) {
      if (!(error instanceof StoreError || error instanceof ValueError)) throw error;
      log.warning(`delete ${recordingId} refused: ${error.message}`);
      return redirect(reply, `/admin?notice=${pyQuote(`Could not delete ${recordingId}: ${error.message}`)}`);
    }
    return redirect(reply, `/admin?deleted=${pyQuote(recordingId)}`);
  }

  async function recordingAudio(request, reply) {
    const { recordingId } = request.params;
    const file = audioFile(request.server.state.config, recordingId);
    if (file === null) return sendHtml(reply, 'no audio for this recording', 404);
    return sendFile(request, reply, file, { filename: `${recordingId}${path.extname(file)}` });
  }

  async function recordingFolder(request, reply) {
    // Show in folder acts on this PC's desktop; never on behalf of a tunnel or proxy caller.
    if (!isLocalDirect(request)) return sendHtml(reply, 'Only available on the server PC itself.', 403);
    const file = audioFile(request.server.state.config, request.params.recordingId);
    if (file === null) return sendHtml(reply, 'no audio for this recording', 404);
    desktop.revealInExplorer(file);
    return redirect(reply, '/admin#recordings');
  }

  /** The recording's site as built on this PC: the pages exactly as they are (or would be) published. */
  async function adminSite(request, reply) {
    const state = request.server.state;
    const { recordingId } = request.params;
    const name = String(request.params['*'] || '');
    const outbox = outboxFolder(state.config, recordingId);
    if (outbox === null) {
      log.info(`site: rejected ${pyStrRepr(recordingId)}`);
      return sendHtml(reply, 'invalid path', 400);
    }
    const site = path.join(outbox, publish.SITE_DIR);
    const kind = pageKind(name);
    // A recording from before sites existed (or whose last build failed) is built on first view.
    if (kind !== null && !isFile(path.resolve(site, name)) && sourceKinds(outbox).includes(kind)) {
      const rec = state.store.latestFor(recordingId);
      try {
        publish.build(outbox, { title: (rec ? rec.title : '') || recordingId, theme: state.config.theme });
      } catch (error) {
        if (!(error instanceof publish.PublishError || error instanceof ValueError || isOsError(error))) throw error;
        log.warning(`site: ${recordingId}: build failed: ${errorText(error)}`);
      }
    }
    return siteFile(request, reply, log, site, name);
  }

  /** A sample recording's site in any theme, built on first request into the datastore's cache. */
  async function themePreview(request, reply) {
    const state = request.server.state;
    let theme;
    try {
      theme = render.getTheme(request.params.themeId);
    } catch (error) {
      if (!(error instanceof ValueError)) throw error;
      return sendHtml(reply, 'unknown theme', 404);
    }
    const dest = resolvePath(path.join(String(state.config.datastore), 'cache', 'theme-preview', theme.id));
    const key = process.platform === 'win32' ? dest.toLowerCase() : dest;
    let isDir = false;
    try {
      isDir = fs.statSync(dest).isDirectory();
    } catch (_error) {
      isDir = false;
    }
    if (!previews.has(key) || !isDir) {
      const pages = Object.entries(SAMPLE_PAGES).map(([kind, text]) => new render.PageSource(kind, PAGE_LABELS[kind], text));
      try {
        publish.buildInto(dest, pages, { title: SAMPLE_TITLE, photosDir: null, theme: theme.id });
      } catch (error) {
        if (!(error instanceof publish.PublishError)) throw error;
        log.warning(`theme preview ${theme.id}: ${error.message}`);
        return sendHtml(reply, `preview failed: ${error.message}`, 500);
      }
      previews.add(key);
    }
    return siteFile(request, reply, log, dest, String(request.params['*'] || ''));
  }

  /** Write (or rewrite) one AI review from the existing transcript as a new job. */
  async function addReview(request, reply) {
    const state = request.server.state;
    const { recordingId } = request.params;
    const form = await readForm(request);
    const kind = form.str('kind', '');
    let rec;
    try {
      rec = state.store.addReview(recordingId, pyStrip(kind));
    } catch (error) {
      if (!(error instanceof StoreError || error instanceof ValueError)) throw error;
      log.warning(`add review ${recordingId}/${kind} refused: ${error.message}`);
      return redirect(reply, `/admin?notice=${pyQuote(`Could not add a review to ${recordingId}: ${error.message}`)}`);
    }
    wake(state);
    return redirect(reply, `/admin/jobs/${rec.jobId}`);
  }

  async function usbToggle(request, reply) {
    const state = request.server.state;
    applyConfig(state, withUpdates(state.config, { usb_enabled: !state.config.usb_enabled }));
    state.usb.pollNow();
    return redirect(reply, '/admin/devices');
  }

  async function usbPoll(request, reply) {
    request.server.state.usb.pollNow();
    return redirect(reply, '/admin/devices');
  }

  /** Download Google's platform tools beside config.toml. Only the server PC's own user may consent. */
  async function platformToolsStart(request, reply) {
    if (!isLocalDirect(request)) return sendHtml(reply, 'Only available on the server PC itself.', 403);
    const state = request.server.state;
    const appLog = state.loggers.app;
    state.platformTools
      .start(state.configDir, {
        log: (line) => appLog.info(line),
        // The watcher looks adb up again on every pass; wake it so it starts tracking now.
        onInstalled: () => state.usb.pollNow(),
      })
      .catch((error) => {
        if (!isAbort(error)) appLog.warn(`usb: platform-tools download failed: ${errorText(error)}`);
      });
    return redirect(reply, '/admin/devices');
  }

  async function devicesPage(request, reply) {
    const state = request.server.state;
    const { store } = state;
    const usb = state.usb.status();
    const connected = new Map(usb.connected.map(([serial, model, adopted]) => [serial, [model, adopted]]));
    const adopted = store
      .devices()
      .filter((d) => d.adopted)
      .map((d) => ({ info: d, connected: connected.has(d.serial), recordings: store.deviceRecordings(d.serial) }));
    const unknown = [...connected].filter(([, [, isAdopted]]) => !isAdopted).map(([serial, [model]]) => ({ serial, model }));
    const tokens = store.tokens();
    const tools = state.platformTools ? state.platformTools.snapshot(state.configDir) : null;
    return page(request, reply, views.devices, {
      usb,
      adopted,
      unknown,
      actions: USB_ACTIONS.slice(1),
      error: queryValue(request, 'error'),
      paired: tokens.filter((t) => !t.revoked),
      revoked: tokens.filter((t) => t.revoked),
      tools,
      local: isLocalDirect(request),
      refresh: (usb.syncing !== null && usb.syncing !== undefined) || Boolean(tools && tools.active),
    });
  }

  async function deviceAdopt(request, reply) {
    const state = request.server.state;
    state.store.adoptDevice(request.params.serial);
    state.usb.pollNow();
    return redirect(reply, '/admin/devices');
  }

  async function deviceForget(request, reply) {
    request.server.state.store.forgetDevice(request.params.serial);
    return redirect(reply, '/admin/devices');
  }

  async function deviceProcess(request, reply) {
    const state = request.server.state;
    const { serial, recordingId } = request.params;
    const form = await readForm(request);
    const action = form.required('action');
    if (form.errors.length) return invalid(request, reply, form.errors);
    let rec;
    try {
      rec = state.store.processInbox(recordingId, { action: pyStrip(action) });
    } catch (error) {
      if (!(error instanceof StoreError || error instanceof ValueError || isOsError(error))) throw error;
      log.warning(`process ${serial}/${recordingId} failed: ${error.message}`);
      return redirect(reply, `/admin/devices?error=${pyQuote(`${recordingId}: ${error.message}`)}`);
    }
    state.store.setAutoJob(serial, recordingId, rec.jobId);
    wake(state);
    return redirect(reply, `/admin/jobs/${rec.jobId}`);
  }

  async function generatePair(request, reply) {
    const state = request.server.state;
    return page(request, reply, views.pairing, {
      code: state.store.createPairCode(),
      ttlS: state.config.pair_code_ttl_s,
      serverName: state.config.server_name,
    });
  }

  async function revokeToken(request, reply) {
    const tokenId = laxInt(request.params.tokenId);
    if (tokenId === null) {
      return invalid(request, reply, ['path.token_id: Input should be a valid integer, unable to parse string as an integer']);
    }
    request.server.state.store.revokeToken(tokenId);
    return redirect(reply, '/admin/devices#paired');
  }

  async function jobPage(request, reply) {
    const state = request.server.state;
    const { store, config } = state;
    const { jobId } = request.params;
    const notice = queryValue(request, 'notice');
    const sent = queryValue(request, 'sent');
    const rec = store.job(jobId);
    // notice/sent still render: an email or retry against a vanished job must explain itself.
    if (rec === null) return page(request, reply, views.job, { job: null, jobId, notice, sent });
    const result = store.resultJson(jobId);
    const logLines = store.readLog(jobId, 200);
    const outbox = store.outboxDir(rec.recordingId);
    const files = [];
    for (const parts of outboxEntries(outbox)) {
      const top = parts[0];
      // The built site is reached through the page links; a build's temporary folders never.
      if (top === publish.SITE_DIR || top.startsWith(`.${publish.SITE_DIR}-`)) continue;
      if (isFile(path.join(outbox, ...parts))) files.push(parts.join('/'));
    }
    const active = rec.status !== 'complete' && rec.status !== 'error';
    return page(request, reply, views.job, {
      job: rec,
      jobId,
      result,
      labels: PAGE_LABELS,
      pages: pageLinks(config, rec),
      reviewKinds: REVIEW_KINDS,
      retryReviews: rec.reviews.length ? rec.reviews : config.default_reviews,
      logLines,
      files,
      active,
      refresh: active,
      notice,
      sent,
    });
  }

  async function emailJob(request, reply) {
    const state = request.server.state;
    const { jobId } = request.params;
    const config = state.config;
    try {
      await state.mailer.emailJob(state.store, config, jobId);
    } catch (error) {
      if (!(error instanceof MailError || error instanceof StoreError)) throw error;
      log.warning(`email for ${jobId} failed: ${error.message}`);
      return redirect(reply, `/admin/jobs/${jobId}?notice=${pyQuote(`Email: ${error.message}`)}`);
    }
    return redirect(reply, `/admin/jobs/${jobId}?sent=${pyQuote(pyStrip(config.email_to))}`);
  }

  async function retryWriter(request, reply) {
    const state = request.server.state;
    const { jobId } = request.params;
    const form = await readForm(request);
    const chosen = pyStrip(form.str('writer', '')) || null;
    const reviews = form.list('reviews');
    // The form sends an empty marker entry, so "none ticked" differs from "field absent" (= the job's own).
    const chosenReviews = reviews !== null ? reviews.filter((kind) => kind) : null;
    try {
      state.store.retryWriter(jobId, chosen, chosenReviews);
    } catch (error) {
      if (!(error instanceof StoreError || error instanceof ValueError)) throw error;
      return redirect(reply, `/admin/jobs/${jobId}?notice=${pyQuote(error.message)}`);
    }
    wake(state);
    return redirect(reply, `/admin/jobs/${jobId}`);
  }

  async function retryPublish(request, reply) {
    const state = request.server.state;
    const { jobId } = request.params;
    try {
      state.store.retryPublish(jobId);
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      return redirect(reply, `/admin/jobs/${jobId}?notice=${pyQuote(error.message)}`);
    }
    wake(state);
    return redirect(reply, `/admin/jobs/${jobId}`);
  }

  async function adminFile(request, reply) {
    // Resolve both halves by hand: never mkdir for a hostile id, and never let either the
    // recording id or the file name step outside that recording's outbox folder.
    const { recordingId } = request.params;
    const name = String(request.params['*'] || '');
    const outboxRoot = resolvePath(path.join(String(request.server.state.config.datastore), 'outbox'));
    const outbox = resolvePath(path.resolve(outboxRoot, recordingId));
    const target = resolvePath(path.resolve(outbox, name));
    if (!samePath(path.dirname(outbox), outboxRoot) || (!samePath(outbox, target) && !strictlyInside(outbox, target))) {
      log.info(`files: rejected ${pyStrRepr(recordingId)} / ${pyStrRepr(name)}`);
      return sendHtml(reply, 'invalid path', 400);
    }
    if (!isFile(target)) return sendHtml(reply, 'not found', 404);
    return sendFile(request, reply, target);
  }

  function configPage(request, reply, { saved, restartNote, themeChanged = false, promptError = null, status = 200 }) {
    const state = request.server.state;
    const promptsDir = state.promptsDir;
    const prompts = REVIEW_KINDS.map((kind) => {
      const failed = promptError !== null && promptError.kind === kind;
      return {
        kind,
        label: PAGE_LABELS[kind],
        // A prompt that could not be saved comes back as typed, with the reason.
        text: failed ? promptError.text : instructions.loadPrompt(promptsDir, kind),
        custom: instructions.isCustom(promptsDir, kind),
        error: failed ? promptError.message : '',
      };
    });
    return page(
      request,
      reply,
      views.config,
      {
        saved,
        restartNote,
        gwsPath: gwsExecutable(state.config.gws_cmd),
        prompts,
        reviewKinds: REVIEW_KINDS,
        labels: PAGE_LABELS,
        maxPromptChars: instructions.MAX_PROMPT_CHARS,
        themes: render.listThemes(),
        themeChanged,
        promptSaved: queryValue(request, 'prompt_saved'),
        promptRestored: queryValue(request, 'prompt_restored'),
      },
      status,
    );
  }

  async function configGet(request, reply) {
    return configPage(request, reply, { saved: false, restartNote: false });
  }

  async function configSave(request, reply) {
    const state = request.server.state;
    const old = state.config;
    const form = await readForm(request);
    const listenPort = form.int('listen_port', 8765);
    const writerTimeout = form.int('writer_timeout_s', 900);
    const pairTtl = form.int('pair_code_ttl_s', 600);
    const usbPoll = form.int('usb_poll_s', 3);
    const idleExit = form.int('idle_exit_min', 10);
    if (form.errors.length) return invalid(request, reply, form.errors);
    const text = (name) => pyStrip(form.str(name));
    const defaultReviews = form.list('default_reviews');
    const changes = {
      server_name: text('server_name') || old.server_name,
      listen_host: text('listen_host') || old.listen_host,
      listen_port: listenPort,
      webdav_folder: text('webdav_folder') || String(old.webdav_folder),
      public_url_base: text('public_url_base').replace(/\/+$/, '') || old.public_url_base,
      theme: text('theme') || old.theme,
      default_writer: text('default_writer') || old.default_writer,
      // The form sends an empty marker entry, so "none ticked" (transcript only) differs from absent.
      default_reviews:
        defaultReviews !== null ? defaultReviews.filter((kind) => REVIEW_KINDS.includes(kind)) : old.default_reviews,
      writer_timeout_s: writerTimeout,
      claude_cmd: text('claude_cmd') || old.claude_cmd,
      codex_cmd: text('codex_cmd') || old.codex_cmd,
      grok_cmd: text('grok_cmd') || old.grok_cmd,
      asr_model: text('asr_model') || old.asr_model,
      asr_device: text('asr_device') || old.asr_device,
      asr_quant: text('asr_quant') || old.asr_quant,
      asr_language: form.str('asr_language'),
      admin_remote: form.str('admin_remote') === 'on',
      pair_code_ttl_s: pairTtl,
      usb_enabled: form.str('usb_enabled') === 'on',
      adb_cmd: text('adb_cmd') || old.adb_cmd,
      usb_poll_s: Math.max(1, usbPoll),
      usb_auto_action: text('usb_auto_action') || old.usb_auto_action,
      usb_device_root: text('usb_device_root').replace(/\/+$/, '') || old.usb_device_root,
      run_mode: text('run_mode') || old.run_mode,
      idle_exit_min: Math.max(1, idleExit),
      email_enabled: form.str('email_enabled') === 'on',
      email_to: text('email_to'),
      gws_cmd: text('gws_cmd') || old.gws_cmd,
    };
    try {
      render.getTheme(changes.theme);
    } catch (error) {
      if (!(error instanceof ValueError)) throw error;
      changes.theme = old.theme;
    }
    if (!USB_ACTIONS.includes(changes.usb_auto_action)) changes.usb_auto_action = old.usb_auto_action;
    if (!RUN_MODES.includes(changes.run_mode)) changes.run_mode = old.run_mode;
    let newConfig;
    try {
      newConfig = withUpdates(old, changes);
    } catch (error) {
      if (!(error instanceof ValueError)) throw error;
      return invalid(request, reply, [error.message]);
    }
    const rotated = pyStrip(form.str('new_admin_password'));
    if (rotated) newConfig = withUpdates(newConfig, { admin_password: rotated });
    applyConfig(state, newConfig);
    state.usb.pollNow();
    const restart = newConfig.listen_host !== old.listen_host || newConfig.listen_port !== old.listen_port;
    return configPage(request, reply, { saved: true, restartNote: restart, themeChanged: newConfig.theme !== old.theme });
  }

  async function promptSave(request, reply) {
    const { kind } = request.params;
    const form = await readForm(request);
    const prompt = form.str('prompt', '');
    if (!REVIEW_KINDS.includes(kind)) return sendHtml(reply, 'not found', 404);
    try {
      instructions.savePrompt(request.server.state.promptsDir, kind, prompt);
    } catch (error) {
      if (!(error instanceof instructions.PromptError)) throw error;
      const promptError = { kind, message: error.message, text: prompt };
      return configPage(request, reply, { saved: false, restartNote: false, promptError, status: 400 });
    }
    return redirect(reply, `/admin/config?prompt_saved=${kind}#prompt-${kind}`);
  }

  async function promptRestore(request, reply) {
    const { kind } = request.params;
    if (!REVIEW_KINDS.includes(kind)) return sendHtml(reply, 'not found', 404);
    instructions.restorePrompt(request.server.state.promptsDir, kind);
    return redirect(reply, `/admin/config?prompt_restored=${kind}#prompt-${kind}`);
  }

  /**
   * Rebuild every published recording's pages in the current theme and deploy them into its
   * folder, removing the MD DOCS leftovers they replace. `dry_run` lists what would happen.
   */
  async function republishStart(request, reply) {
    const state = request.server.state;
    const raw = queryValue(request, 'dry_run');
    let dryRun = false;
    if (raw !== null) {
      const word = raw.trim().toLowerCase();
      if (TRUE_WORDS.has(word)) dryRun = true;
      else if (!FALSE_WORDS.has(word)) {
        return invalid(request, reply, ['query.dry_run: Input should be a valid boolean, unable to interpret input']);
      }
    }
    const { store, config } = state;
    if (dryRun) {
      return page(request, reply, views.republish, {
        plan: publish.planRepublish(store, config),
        run: null,
        theme: render.getTheme(config.theme),
        labels: PAGE_SHORT_LABELS,
      });
    }
    if (!state.republish.start(store, config)) {
      return redirect(reply, `/admin/republish?notice=${pyQuote('A republish is already running.')}`);
    }
    return redirect(reply, '/admin/republish');
  }

  async function republishStatus(request, reply) {
    const state = request.server.state;
    const run = state.republish;
    return page(request, reply, views.republish, {
      plan: null,
      run,
      theme: render.getTheme(run.theme || state.config.theme),
      labels: PAGE_SHORT_LABELS,
      notice: queryValue(request, 'notice'),
      refresh: run.running,
    });
  }

  function importPage(request, reply, error) {
    return page(request, reply, views.importPage, { error, reviewKinds: REVIEW_KINDS, labels: PAGE_LABELS });
  }

  async function importGet(request, reply) {
    return importPage(request, reply, queryValue(request, 'error'));
  }

  async function importSubmit(request, reply) {
    const state = request.server.state;
    const form = await readForm(request);
    const folder = form.required('folder');
    if (form.errors.length) return invalid(request, reply, form.errors);
    const title = form.str('title', '');
    const reviews = form.list('reviews');
    const doPublish = ['1', 'on', 'true', 'yes'].includes(form.str('publish', '').toLowerCase());
    // The form sends an empty marker entry; a post without the field gets the default reviews.
    const chosen = reviews !== null ? reviews.filter((kind) => kind) : state.config.default_reviews;
    let rec;
    try {
      rec = state.store.importFolder(pathString(pyStrip(folder)), {
        title: pyStrip(title) || null,
        reviews: chosen,
        publish: doPublish,
      });
    } catch (error) {
      return importPage(request, reply, errorText(error));
    }
    wake(state);
    return redirect(reply, `/admin/jobs/${rec.jobId}`);
  }

  async function apiStatus(request, reply) {
    const cursor = parseStatusCursor(queryValue(request, 'cursor'));
    return reply.send(statusBody(request.server.state, cursor));
  }

  /**
   * Flip USB mode or email-finished-jobs, then return the same payload as GET. The desktop tray
   * needs a JSON toggle; the HTML pages keep POST /admin/usb/toggle and Settings.
   */
  async function apiStatusToggle(request, reply) {
    const state = request.server.state;
    let body;
    try {
      body = JSON.parse((await readBody(request)).toString('utf8'));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      body = {};
    }
    const toggle = body !== null && typeof body === 'object' && !Array.isArray(body) ? body.toggle : undefined;
    if (toggle !== 'usb' && toggle !== 'email') {
      throw new HttpError(422, 'invalid_request', 'toggle must be usb or email');
    }
    const old = state.config;
    if (toggle === 'usb') {
      applyConfig(state, withUpdates(old, { usb_enabled: !old.usb_enabled }));
      state.usb.pollNow();
    } else {
      applyConfig(state, withUpdates(old, { email_enabled: !old.email_enabled }));
    }
    const cursor = parseStatusCursor(queryValue(request, 'cursor'));
    return reply.send(statusBody(state, cursor));
  }

  /** Ask this process to exit. Only a local-direct caller may; a tunnel must not stop the server. */
  async function apiShutdown(request, reply) {
    if (!isLocalDirect(request)) {
      throw new HttpError(403, 'forbidden', 'shutdown is only available on this PC');
    }
    request.server.state.requestExit();
    return reply.send({ ok: true });
  }

  app.register(async (admin) => {
    // Bodies stay unread streams until the handler, which runs after requireAdmin.
    admin.removeAllContentTypeParsers();
    admin.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
    const guard = { preHandler: [requireAdminHook] };
    admin.get('/admin', guard, dashboard);
    admin.get('/admin/system', guard, systemPage);
    admin.post('/admin/system/model-download', guard, modelDownloadStart);
    admin.post('/admin/system/model-cancel', guard, modelDownloadCancel);
    admin.post('/admin/recordings/:recordingId/delete', guard, recordingDelete);
    admin.get('/admin/recordings/:recordingId/audio', guard, recordingAudio);
    admin.post('/admin/recordings/:recordingId/folder', guard, recordingFolder);
    admin.get('/admin/site/:recordingId/*', guard, adminSite);
    admin.get('/admin/theme-preview/:themeId/*', guard, themePreview);
    admin.post('/admin/recordings/:recordingId/reviews', guard, addReview);
    admin.post('/admin/usb/toggle', guard, usbToggle);
    admin.post('/admin/usb/poll', guard, usbPoll);
    admin.get('/admin/devices', guard, devicesPage);
    admin.post('/admin/devices/platform-tools', guard, platformToolsStart);
    admin.post('/admin/devices/:serial/adopt', guard, deviceAdopt);
    admin.post('/admin/devices/:serial/forget', guard, deviceForget);
    admin.post('/admin/devices/:serial/recordings/:recordingId/process', guard, deviceProcess);
    admin.post('/admin/pair', guard, generatePair);
    admin.post('/admin/tokens/:tokenId/revoke', guard, revokeToken);
    admin.get('/admin/jobs/:jobId', guard, jobPage);
    admin.post('/admin/jobs/:jobId/email', guard, emailJob);
    admin.post('/admin/jobs/:jobId/retry-writer', guard, retryWriter);
    admin.post('/admin/jobs/:jobId/retry-publish', guard, retryPublish);
    admin.get('/admin/files/:recordingId/*', guard, adminFile);
    admin.get('/admin/config', guard, configGet);
    admin.post('/admin/config', guard, configSave);
    admin.post('/admin/prompts/:kind', guard, promptSave);
    admin.post('/admin/prompts/:kind/restore', guard, promptRestore);
    admin.post('/admin/republish', guard, republishStart);
    admin.get('/admin/republish', guard, republishStatus);
    admin.get('/admin/import', guard, importGet);
    admin.post('/admin/import', guard, importSubmit);
    admin.get('/admin/api/status', guard, apiStatus);
    admin.post('/admin/api/status', guard, apiStatusToggle);
    admin.post('/admin/api/shutdown', guard, apiShutdown);
  });
}

module.exports = { registerAdmin };
