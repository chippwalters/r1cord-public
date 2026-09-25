// USB mode: poll adb for adopted devices and pull finished recordings into inbox/.
// Port of r1cord_server/usb.py. The watcher runs adb and JobStore calls only; it never
// executes a pipeline step. Every adb invocation has a timeout. Tests inject `_run`
// and must never spawn the real adb against a device.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnArgs, which } = require('./cli');
const { platformToolsAdb } = require('./paths');
const { AUDIO_NAMES, FILE_NAME_RE, sha256File } = require('./store');

const RECORDING_ID_RE = /^[A-Za-z0-9._-]+$/;
const FINAL_STATUSES = new Set(['SAVED', 'INTERRUPTED']);
const DEVICES_TIMEOUT_S = 10;
const LIST_TIMEOUT_S = 30;
const PULL_TIMEOUT_S = 600;
// The R1 client falls back to http://127.0.0.1:8765 when it has no validated network;
// the watcher reverse-forwards that device port to this server for adopted devices.
const DEVICE_LOOPBACK_PORT = 8765;
const TRACKER_RETRY_S = 5;
const IDLE_CHECK_S = 30;

const SILENT_LOGGER = Object.freeze({
  info() {},
  warning() {},
  warn() {},
  error() {},
});

const STOP = Object.freeze({ kind: 'stop', devices: null });
const WAKE = Object.freeze({ kind: 'wake', devices: null });
const TRACKER_DIED = Object.freeze({ kind: 'tracker_died', devices: null });

class AdbError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AdbError';
  }
}

class UsbDevice {
  constructor(serial, state, model) {
    this.serial = serial;
    this.state = state;
    this.model = model;
  }
}

class UsbStatus {
  constructor({ enabled, adb, connected = [], syncing = null, lastError = null }) {
    this.enabled = enabled;
    this.adb = adb;
    this.connected = connected;
    this.syncing = syncing;
    this.last_error = lastError;
    this.lastError = lastError;
  }
}

function monotonicSeconds() {
  return Number(process.hrtime.bigint()) / 1e9;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sameListed(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    Number(left[0]) === Number(right[0]) &&
    Number(left[1]) === Number(right[1])
  );
}

function isFile(file) {
  try {
    return fs.existsSync(file) && fs.statSync(file).isFile();
  } catch (_error) {
    return false;
  }
}

function replaceFile(src, dest) {
  if (process.platform === 'win32' && fs.existsSync(dest)) fs.rmSync(dest, { force: true });
  fs.renameSync(src, dest);
}

function rstripSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function argvPrefix(args) {
  return args.slice(0, 3).join(' ');
}

function decodeUtf8(buffer) {
  return Buffer.from(buffer || []).toString('utf8');
}

/**
 * Parse `adb devices -l` output.
 * @param {string} text
 * @returns {UsbDevice[]}
 */
function parseDevices(text) {
  const devices = [];
  for (const raw of String(text).split(/\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('List of devices') || line.startsWith('*')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    let model = '';
    for (const token of parts.slice(2)) {
      if (token.startsWith('model:')) model = token.slice('model:'.length);
    }
    devices.push(new UsbDevice(parts[0], parts[1], model));
  }
  return devices;
}

/**
 * Parse `find . -type f -exec stat -c '%s %Y %n' {} +` output run inside the device root.
 * Returns {recordingId: {fileName: [size, mtime]}}. Files not exactly one folder deep
 * are ignored; so are names that would not be safe on disk.
 * @param {string} text
 * @returns {Object<string, Object<string, [number, number]>>}
 */
function parseListing(text) {
  const listing = {};
  for (const raw of String(text).split(/\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    const sizeText = parts[0];
    const mtimeText = parts[1];
    const relRaw = parts.slice(2).join(' ');
    const size = Number.parseInt(sizeText, 10);
    const mtime = Number.parseInt(mtimeText, 10);
    if (!Number.isFinite(size) || !Number.isFinite(mtime) || String(size) !== sizeText || String(mtime) !== mtimeText) {
      continue;
    }
    let rel = relRaw;
    if (rel.startsWith('./')) rel = rel.slice(2);
    const segments = rel.split('/');
    if (segments.length !== 2) continue;
    const [recordingId, name] = segments;
    if (!RECORDING_ID_RE.test(recordingId) || !FILE_NAME_RE.test(name)) continue;
    if (!listing[recordingId]) listing[recordingId] = {};
    listing[recordingId][name] = [size, mtime];
  }
  return listing;
}

/**
 * Split `adb track-devices -l` output into complete frames.
 *
 * The adb server sends `%04x`-length-prefixed device lists; the Windows client rewrites
 * `\n` as `\r\n`, so normalize first — the declared length counts the original bytes.
 * Returns [frame texts, unconsumed remainder].
 * @param {Buffer} buf
 * @returns {[string[], Buffer]}
 */
function parseTrackFrames(buf) {
  let rest = Buffer.from(buf || []).toString('binary').replace(/\r\n/g, '\n');
  rest = Buffer.from(rest, 'binary');
  const frames = [];
  while (rest.length >= 4) {
    const prefix = rest.subarray(0, 4);
    const hex = prefix.toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      throw new AdbError(`track-devices: bad frame prefix ${utilBytes(prefix)}`);
    }
    const n = Number.parseInt(hex, 16);
    if (rest.length < 4 + n) break;
    if (rest.length === 4 + n && rest[rest.length - 1] === 0x0d) {
      // The frame body ends in a bare \r that may be the first half of a \r\n pair
      // split across chunk reads; wait for the next byte before consuming.
      break;
    }
    frames.push(rest.subarray(4, 4 + n).toString('utf8'));
    rest = rest.subarray(4 + n);
  }
  return [frames, rest];
}

function utilBytes(buf) {
  // Python bytes !r for the short prefixes tests throw on, e.g. b'zzzz'.
  const text = Buffer.from(buf).toString('latin1');
  const escaped = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `b'${escaped}'`;
}

function defaultRun(args, { timeout } = {}) {
  let proc;
  try {
    const spec = spawnArgs(args);
    proc = childProcess.spawnSync(spec.command, spec.args, {
      timeout: Math.max(0, Number(timeout) || 0) * 1000,
      windowsHide: true,
      windowsVerbatimArguments: Boolean(spec.windowsVerbatimArguments),
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
  } catch (error) {
    throw new AdbError(`${argvPrefix(args)}: ${error}`);
  }
  if (proc.error) throw new AdbError(`${argvPrefix(args)}: ${proc.error}`);
  const stdout = decodeUtf8(proc.stdout);
  const stderr = decodeUtf8(proc.stderr).trim();
  if (proc.status !== 0) {
    throw new AdbError(`${argvPrefix(args)} exited ${proc.status}: ${stderr || stdout.trim()}`);
  }
  return stdout;
}

function defaultSpawnTracker(adb) {
  return spawn([adb, 'track-devices', '-l'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
    cwd: os.tmpdir(),
  });
}

class UsbWatcher {
  /**
   * @param {import('./store').JobStore} store
   * @param {() => object} configRef
   * @param {{requestExit?: Function|null, lastActivity?: Function, openDashboard?: Function|null,
   *          onImported?: Function|null, logger?: object, spawnTracker?: Function,
   *          configDir?: string|null}} [options]
   */
  constructor(store, configRef, options = {}) {
    this.store = store;
    this._config = configRef;
    this._requestExit = options.requestExit || options.request_exit || null;
    this._lastActivity = options.lastActivity || options.last_activity || (() => null);
    this._openDashboard = options.openDashboard || options.open_dashboard || null;
    this._onImported = options.onImported || options.on_imported || null;
    this._log = options.logger || SILENT_LOGGER;
    this._spawnTrackerFn = options.spawnTracker || defaultSpawnTracker;
    // Folder of the loaded config.toml; adbPath also looks for <folder>/platform-tools/adb.exe.
    this._configDir = options.configDir || null;
    // Serials adb listed at the previous pass; null until the first pass sets the baseline.
    this._present = null;
    this._stopped = false;
    this._events = [];
    this._waiters = [];
    this._loop = null;
    this._tracker = null;
    this._devices = [];
    this._connected = [];
    this._syncing = null;
    this._lastError = null;
    this._reversed = new Set();
    this._lastAdoptedSeen = monotonicSeconds();
    this.poll_now = this.pollNow.bind(this);
    this.poll_once = this.pollOnce.bind(this);
    this.sync_device = this.syncDevice.bind(this);
    this._idle_check = this._idleCheck.bind(this);
    this._request_exit = this._requestExit;
    this._last_activity = this._lastActivity;
    this._open_dashboard = this._openDashboard;
    this._last_adopted_seen = this._lastAdoptedSeen;
  }

  get _request_exit() {
    return this._requestExit;
  }

  set _request_exit(value) {
    this._requestExit = value;
  }

  get _last_activity() {
    return this._lastActivity;
  }

  set _last_activity(value) {
    this._lastActivity = value;
  }

  get _open_dashboard() {
    return this._openDashboard;
  }

  set _open_dashboard(value) {
    this._openDashboard = value;
  }

  get _last_adopted_seen() {
    return this._lastAdoptedSeen;
  }

  set _last_adopted_seen(value) {
    this._lastAdoptedSeen = value;
  }

  start() {
    if (this._loop) return;
    this._stopped = false;
    this._lastAdoptedSeen = monotonicSeconds();
    this._loop = this._runLoop().finally(() => {
      this._loop = null;
    });
  }

  async stop() {
    this._stopped = true;
    this._put(STOP);
    const loop = this._loop;
    if (loop) await Promise.race([loop, sleep(5000)]);
    this._loop = null;
    this._stopTracker();
  }

  pollNow() {
    this._put(WAKE);
  }

  status() {
    const cfg = this._config();
    const adb = UsbWatcher.adbPath(cfg, this._configDir);
    return new UsbStatus({
      enabled: Boolean(cfg.usb_enabled),
      adb: adb || 'not found',
      connected: this._connected.map((row) => [...row]),
      syncing: this._syncing,
      lastError: this._lastError,
    });
  }

  /**
   * The adb to run: config adb_cmd when it is a file, then PATH, then the copy the Devices page
   * downloads beside config.toml, then the Android Studio SDK. Null when there is none.
   * @param {object} cfg
   * @param {string|null} [configFolder] folder of the loaded config.toml
   * @returns {string|null}
   */
  static adbPath(cfg, configFolder = null) {
    const cmd = String(cfg.adb_cmd || '');
    if (cmd) {
      try {
        if (fs.existsSync(cmd) && fs.statSync(cmd).isFile()) return cmd;
      } catch (_error) {
        // fall through to PATH / candidates
      }
    }
    const found = which(cmd);
    if (found) return found;
    const candidates = [];
    if (configFolder) candidates.push(platformToolsAdb(configFolder));
    const local = process.env.LOCALAPPDATA;
    if (local) candidates.push(path.join(local, 'Android', 'Sdk', 'platform-tools', 'adb.exe'));
    for (const candidate of candidates) {
      if (isFile(candidate)) return candidate;
    }
    return null;
  }

  async _runLoop() {
    while (!this._stopped) {
      const cfg = this._config();
      const adb = cfg.usb_enabled ? UsbWatcher.adbPath(cfg, this._configDir) : null;
      if (adb === null) {
        this._stopTracker();
        this._connected = [];
        this._syncing = null;
        this._present = null;
        if (cfg.usb_enabled) this._setError(`adb not found: ${cfg.adb_cmd}`);
        this._idleCheck(cfg);
        await this._await(TRACKER_RETRY_S);
        continue;
      }
      if (this._tracker === null || this._trackerDead(this._tracker)) {
        try {
          this._startTracker(adb);
          this.pollOnce(cfg);
        } catch (error) {
          this._warn(`usb: tracker start failed: ${error}`);
          this._setError(`adb: ${error}`);
          await this._await(TRACKER_RETRY_S);
          continue;
        }
      }
      const adoptedConnected = this._connected.some((row) => row[2]);
      const timeout = adoptedConnected ? cfg.usb_poll_s : cfg.run_mode === 'plug' ? IDLE_CHECK_S : null;
      const event = await this._await(timeout);
      if (event === STOP || this._stopped) break;
      try {
        if (event === TRACKER_DIED) continue;
        if (event && event.devices) this._devices = event.devices;
        this._apply(adb, cfg, this._devices);
        this._idleCheck(cfg);
      } catch (error) {
        if (this._log.error) this._log.error('usb: sync failed', error);
        else this._warn(`usb: sync failed: ${error}`, error);
        this._setError(`sync: ${error}`);
      }
    }
  }

  _put(event) {
    if (this._waiters.length) this._waiters.shift()(event);
    else this._events.push(event);
  }

  _await(timeout) {
    if (this._events.length) return Promise.resolve(this._events.shift());
    return new Promise((resolve) => {
      let timer = null;
      const waiter = (event) => {
        if (timer) clearTimeout(timer);
        resolve(event);
      };
      this._waiters.push(waiter);
      if (timeout != null) {
        timer = setTimeout(() => {
          const index = this._waiters.indexOf(waiter);
          if (index !== -1) this._waiters.splice(index, 1);
          resolve(null);
        }, Number(timeout) * 1000);
      }
    });
  }

  _trackerDead(proc) {
    return proc.exitCode !== null || proc.signalCode !== null;
  }

  _startTracker(adb) {
    const proc = this._spawnTrackerFn(adb);
    this._tracker = proc;
    this._readTracker(proc);
    this._log.info(`usb: tracking devices via adb (pid ${proc.pid})`);
  }

  _readTracker(proc) {
    let buf = Buffer.alloc(0);
    const stdout = proc.stdout;
    if (!stdout) return;
    const onData = (chunk) => {
      try {
        buf = Buffer.concat([buf, Buffer.from(chunk)]);
        const [frames, rest] = parseTrackFrames(buf);
        buf = rest;
        for (const frame of frames) {
          this._put({
            kind: 'devices',
            devices: parseDevices(frame).filter((dev) => dev.state === 'device'),
          });
        }
      } catch (error) {
        this._warn(`usb: tracker read failed: ${error}`);
      }
    };
    const onEnd = () => {
      if (proc === this._tracker && !this._stopped) this._put(TRACKER_DIED);
    };
    stdout.on('data', onData);
    stdout.on('end', onEnd);
    stdout.on('error', (error) => {
      this._warn(`usb: tracker read failed: ${error}`);
      onEnd();
    });
    proc.on('error', (error) => {
      this._warn(`usb: tracker read failed: ${error}`);
      onEnd();
    });
  }

  _stopTracker() {
    const proc = this._tracker;
    this._tracker = null;
    if (proc && !this._trackerDead(proc)) {
      try {
        proc.kill();
      } catch (_error) {
        // already gone
      }
    }
  }

  /**
   * One synchronous `adb devices -l` + sync pass. Initial state, Sync now, and tests.
   * @param {object} [cfg]
   */
  pollOnce(cfg) {
    cfg = cfg || this._config();
    const adb = UsbWatcher.adbPath(cfg, this._configDir);
    if (adb === null) {
      this._setError(`adb not found: ${cfg.adb_cmd}`);
      this._connected = [];
      return;
    }
    const out = this._run([adb, 'devices', '-l'], { timeout: DEVICES_TIMEOUT_S });
    this._devices = parseDevices(out).filter((dev) => dev.state === 'device');
    this._apply(adb, cfg, this._devices);
  }

  _apply(adb, cfg, devices) {
    const adopted = this.store.adoptedSerials();
    for (const dev of devices) this.store.upsertDeviceSeen(dev.serial, dev.model);
    this._connected = devices.map((dev) => [dev.serial, dev.model, adopted.has(dev.serial)]);
    this._announceArrivals(devices, adopted);
    let failed = false;
    for (const dev of devices) {
      if (!adopted.has(dev.serial)) continue;
      if (this._stopped) return;
      this._lastAdoptedSeen = monotonicSeconds();
      try {
        this._ensureReverse(adb, dev.serial, cfg);
        this.syncDevice(adb, dev.serial, cfg);
        this.store.deviceSynced(dev.serial, null);
      } catch (error) {
        if (!(error instanceof AdbError)) throw error;
        failed = true;
        this._reversed.delete(dev.serial);
        this._warn(`usb: ${dev.serial} sync aborted: ${error}`);
        this.store.deviceSynced(dev.serial, String(error));
        this._setError(`${dev.serial}: ${error}`);
      } finally {
        this._syncing = null;
      }
    }
    const present = new Set(devices.filter((dev) => adopted.has(dev.serial)).map((dev) => dev.serial));
    this._reversed = new Set([...this._reversed].filter((serial) => present.has(serial)));
    if (!failed) this._setError(null);
  }

  _announceArrivals(devices, adopted) {
    const serials = new Set(devices.map((dev) => dev.serial));
    const previous = this._present;
    this._present = serials;
    if (previous === null || this._openDashboard === null) return;
    const arrived = [...serials].filter((serial) => !previous.has(serial) && adopted.has(serial)).sort();
    if (!arrived.length) return;
    this._log.info(`usb: ${arrived.join(', ')} plugged in; opening the dashboard`);
    try {
      this._openDashboard();
    } catch (error) {
      this._warn(`usb: could not open the dashboard: ${error}`);
    }
  }

  /**
   * In `plug` mode, ask the server to exit once nothing has needed it for `idle_exit_min`.
   * @param {object} cfg
   * @param {number} [now]
   * @returns {boolean}
   */
  _idleCheck(cfg, now) {
    if (cfg.run_mode !== 'plug' || this._requestExit === null) return false;
    const at = now === undefined ? monotonicSeconds() : now;
    if (this._connected.some((row) => row[2])) {
      this._lastAdoptedSeen = at;
      return false;
    }
    const last = Math.max(this._lastAdoptedSeen, this._lastActivity() || 0);
    if (at - last < cfg.idle_exit_min * 60) return false;
    if (this.store.hasActiveJobs()) return false;
    this._log.info(
      `usb: idle for ${cfg.idle_exit_min} min with no adopted device; exiting (run_mode=plug)`,
    );
    this._requestExit();
    return true;
  }

  _ensureReverse(adb, serial, cfg) {
    if (this._reversed.has(serial)) return;
    this._run(
      [adb, '-s', serial, 'reverse', `tcp:${DEVICE_LOOPBACK_PORT}`, `tcp:${cfg.listen_port}`],
      { timeout: DEVICES_TIMEOUT_S },
    );
    this._reversed.add(serial);
    this._log.info(`usb: ${serial} reverse tcp:${DEVICE_LOOPBACK_PORT} -> ${cfg.listen_port}`);
  }

  syncDevice(adb, serial, cfg) {
    const listing = this._list(adb, serial, cfg);
    for (const recordingId of Object.keys(listing).sort()) {
      if (this._stopped) return;
      this._syncRecording(adb, serial, recordingId, listing[recordingId], cfg);
    }
  }

  _list(adb, serial, cfg) {
    const root = rstripSlash(cfg.usb_device_root);
    const cmd =
      `if cd ${root} 2>/dev/null; then ` + "find . -type f -exec stat -c '%s %Y %n' {} +; fi";
    const out = this._run([adb, '-s', serial, 'shell', cmd], { timeout: LIST_TIMEOUT_S });
    return parseListing(out);
  }

  _syncRecording(adb, serial, recordingId, files, cfg) {
    const store = this.store;
    if (store.isDeleted(recordingId)) return;
    const metaListed = files['metadata.json'];
    if (metaListed === undefined) {
      this._log.info(`usb: ${serial} skipped ${recordingId} (no metadata.json)`);
      return;
    }
    const inbox = store.inboxDir(recordingId);
    const known = store.deviceFileState(serial, recordingId);
    const remoteDir = `${rstripSlash(cfg.usb_device_root)}/${recordingId}`;

    if (!sameListed(known['metadata.json'], metaListed) || !isFile(path.join(inbox, 'metadata.json'))) {
      this._pullFile(adb, serial, remoteDir, inbox, 'metadata.json', metaListed);
      store.recordPulledFile(
        serial,
        recordingId,
        'metadata.json',
        metaListed[0],
        metaListed[1],
        sha256File(path.join(inbox, 'metadata.json')),
      );
    }
    let metadata;
    try {
      metadata = JSON.parse(fs.readFileSync(path.join(inbox, 'metadata.json'), 'utf8'));
    } catch (error) {
      this._warn(`usb: ${serial} ${recordingId} metadata.json unreadable: ${error}`);
      store.markDeviceRecording(serial, recordingId, { deviceStatus: 'UNKNOWN', title: '', createdAtMs: 0 });
      store.flagDeviceRecording(serial, recordingId, 'pull_failed');
      return;
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) metadata = {};
    const status = String(metadata.status || 'UNKNOWN');
    const title = String(metadata.title || '');
    let createdAtMs = 0;
    try {
      const raw = metadata.createdAt || 0;
      createdAtMs = Number.parseInt(String(raw), 10);
      if (!Number.isFinite(createdAtMs)) createdAtMs = 0;
    } catch (_error) {
      createdAtMs = 0;
    }
    store.markDeviceRecording(serial, recordingId, { deviceStatus: status, title, createdAtMs });

    if (!FINAL_STATUSES.has(status)) {
      this._log.info(`usb: ${serial} skipped ${recordingId} (status ${status})`);
      return;
    }
    if (store.activeJobFor(recordingId) !== null) {
      this._log.info(`usb: ${serial} skipped ${recordingId} (job active)`);
      return;
    }

    const hadJob = store.latestFor(recordingId) !== null;
    let changed = false;
    let mismatch = false;
    for (const name of Object.keys(files).sort()) {
      if (name === 'metadata.json') continue;
      const [size, mtime] = files[name];
      const target = path.join(inbox, name);
      if (sameListed(known[name], [size, mtime]) && isFile(target)) continue;
      if (isFile(target) && fs.statSync(target).size === size && !Object.prototype.hasOwnProperty.call(known, name)) {
        store.recordPulledFile(serial, recordingId, name, size, mtime, sha256File(target));
        this._log.info(`usb: ${serial} ${recordingId}/${name} already in inbox, not transferred`);
        continue;
      }
      this._syncing = `${recordingId}/${name}`;
      const partial = this._pullPartial(adb, serial, remoteDir, inbox, name, size);
      const digest = sha256File(partial);
      if (AUDIO_NAMES.includes(name) && isFile(target) && sha256File(target) !== digest) {
        fs.rmSync(partial, { force: true });
        mismatch = true;
        store.recordPulledFile(serial, recordingId, name, size, mtime, digest);
        this._warn(`usb: ${serial} ${recordingId}/${name} differs from inbox audio; kept inbox copy`);
        continue;
      }
      replaceFile(partial, target);
      store.recordPulledFile(serial, recordingId, name, size, mtime, digest);
      changed = true;
      this._log.info(`usb: ${serial} pulled ${recordingId}/${name} ${size} bytes`);
    }

    store.deviceRecordingPulled(serial, recordingId);
    store.flagDeviceRecording(serial, recordingId, mismatch ? 'audio_mismatch' : null);
    if (hadJob) {
      if (changed) store.flagChangedSinceJob(serial, recordingId);
      return;
    }
    if (status !== 'SAVED' || cfg.usb_auto_action === 'archive') return;
    if (!AUDIO_NAMES.some((name) => isFile(path.join(inbox, name)))) return;
    let rec;
    try {
      rec = store.processInbox(recordingId, { action: cfg.usb_auto_action });
    } catch (error) {
      this._warn(`usb: ${serial} could not queue ${recordingId}: ${error}`);
      store.flagDeviceRecording(serial, recordingId, 'process_failed');
      return;
    }
    store.setAutoJob(serial, recordingId, rec.jobId);
    this._log.info(`usb: ${serial} queued ${recordingId} as ${rec.jobId} (${cfg.usb_auto_action})`);
    if (typeof this._onImported === 'function') {
      try {
        this._onImported(rec);
      } catch (error) {
        this._warn(`usb: onImported failed for ${recordingId}: ${error}`);
      }
    }
  }

  _pullFile(adb, serial, remoteDir, inbox, name, listed) {
    const partial = this._pullPartial(adb, serial, remoteDir, inbox, name, listed[0]);
    replaceFile(partial, path.join(inbox, name));
  }

  _pullPartial(adb, serial, remoteDir, inbox, name, expectedSize) {
    const upload = path.join(inbox, '.upload');
    fs.mkdirSync(upload, { recursive: true });
    const partial = path.join(upload, `${name}.partial`);
    if (fs.existsSync(partial)) fs.rmSync(partial, { force: true });
    try {
      this._run([adb, '-s', serial, 'pull', '-a', `${remoteDir}/${name}`, partial], {
        timeout: PULL_TIMEOUT_S,
      });
      const actual = isFile(partial) ? fs.statSync(partial).size : -1;
      if (actual !== expectedSize) {
        throw new AdbError(`pull ${name}: got ${actual} bytes, device lists ${expectedSize}`);
      }
    } catch (error) {
      if (fs.existsSync(partial)) fs.rmSync(partial, { force: true });
      throw error;
    }
    return partial;
  }

  _run(args, { timeout } = {}) {
    return defaultRun(args, { timeout });
  }

  _setError(message) {
    this._lastError = message;
  }

  _warn(message, error) {
    if (this._log.warning) this._log.warning(message, error);
    else if (this._log.warn) this._log.warn(message, error);
  }
}

UsbWatcher.adb_path = UsbWatcher.adbPath;
UsbWatcher.adbPath = UsbWatcher.adbPath;

module.exports = {
  AdbError,
  UsbDevice,
  UsbStatus,
  UsbWatcher,
  parseDevices,
  parse_devices: parseDevices,
  parseListing,
  parse_listing: parseListing,
  parseTrackFrames,
  parse_track_frames: parseTrackFrames,
  RECORDING_ID_RE,
  FINAL_STATUSES,
  DEVICES_TIMEOUT_S,
  LIST_TIMEOUT_S,
  PULL_TIMEOUT_S,
  DEVICE_LOOPBACK_PORT,
  TRACKER_RETRY_S,
  IDLE_CHECK_S,
};
