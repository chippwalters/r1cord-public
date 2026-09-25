'use strict';

const { spawn } = require('child_process');
const fs = require('fs');

const ADB_MISSING_RETRY_MS = 60000;
const ADB_BACKOFF_MS = 500;
const ADB_MAX_BACKOFF_MS = 8000;

function nextBackoff(current, max) {
  const start = current > 0 ? current : 1;
  return Math.min(start * 2, max);
}

function parseTrackFrames(buf) {
  let data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  data = Buffer.from(data.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  const frames = [];
  while (data.length >= 4) {
    const prefix = data.subarray(0, 4).toString('latin1');
    const n = Number.parseInt(prefix, 16);
    if (!Number.isFinite(n)) {
      throw new Error(`track-devices: bad frame prefix ${JSON.stringify(prefix)}`);
    }
    if (data.length < 4 + n) break;
    if (data.length === 4 + n && data[data.length - 1] === 0x0d) break;
    frames.push(data.subarray(4, 4 + n).toString('utf8'));
    data = data.subarray(4 + n);
  }
  return { frames, rest: data };
}

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
    devices.push({ serial: parts[0], state: parts[1], model });
  }
  return devices;
}

function qualifyingSerials(devices, adoptedSerials) {
  const online = (devices || []).filter((device) => device.state === 'device').map((device) => device.serial);
  if (adoptedSerials == null) return online;
  const allow = new Set(adoptedSerials);
  return online.filter((serial) => allow.has(serial));
}

function arrivedSerials(previous, current) {
  const prev = previous instanceof Set ? previous : new Set(previous || []);
  return (current || []).filter((serial) => !prev.has(serial));
}

function shouldLaunch(devices, adoptedSerials) {
  return qualifyingSerials(devices, adoptedSerials).length > 0;
}

function isMissingAdb(err) {
  return Boolean(err && (err.code === 'ENOENT' || String(err.code || '').includes('ENOENT')));
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };
    if (!child || typeof child.on !== 'function') {
      finish(null, { code: 0, signal: null });
      return;
    }
    child.on('error', (err) => finish(err));
    child.on('exit', (code, signal) => finish(null, { code, signal }));
  });
}

function launchApp({ spawnImpl, env }) {
  const appExe = env.R1CORD_APP_EXE;
  const app = spawnImpl(appExe, ['--background'], {
    shell: false,
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  });
  if (typeof app.unref === 'function') app.unref();
  return app;
}

function loadAdopted(env, readFileSync) {
  const filePath = env && env.R1CORD_ADOPTED_SERIALS_FILE;
  if (!filePath) return null;
  const read = readFileSync || fs.readFileSync;
  let raw;
  try {
    raw = read(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  if (!raw || !String(raw).trim()) return null;
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : parsed && parsed.serials;
  if (!Array.isArray(list) || list.length === 0) return null;
  return list.map(String);
}

function consumeFrames(chunk, rest, previous, opts) {
  const parsed = parseTrackFrames(Buffer.concat([rest, chunk]));
  let adopted;
  try {
    adopted = loadAdopted(opts.env, opts.readFileSync);
  } catch (err) {
    opts.logger?.error?.(`adopted serials: ${err.message}`);
    return { rest: parsed.rest, previous, launched: 0 };
  }
  let launched = 0;
  let nextPrevious = previous;
  for (const frame of parsed.frames) {
    const current = qualifyingSerials(parseDevices(frame), adopted);
    const arrived = arrivedSerials(nextPrevious, current);
    if (arrived.length) {
      launchApp(opts);
      launched += 1;
    }
    nextPrevious = new Set(current);
  }
  return { rest: parsed.rest, previous: nextPrevious, launched };
}

// The same order the app's USB watcher uses: an explicit adb, else PATH, else the copy the
// Devices page downloads (R1CORD_DOWNLOADED_ADB), else Android Studio's SDK. Re-read on every
// retry, so an adb downloaded after this launcher started is still found.
function adbCandidates(env, existsSync = fs.existsSync) {
  const explicit = env.R1CORD_ADB && env.R1CORD_ADB !== 'adb' ? env.R1CORD_ADB : null;
  if (explicit) return [explicit];
  const files = [
    env.R1CORD_DOWNLOADED_ADB,
    env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe` : null,
  ].filter((file) => file && existsSync(file));
  return ['adb', ...files];
}

async function superviseAdb(opts) {
  const {
    spawnImpl = spawn,
    env = process.env,
    existsSync = fs.existsSync,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    logger = { info() {}, error() {} },
    state,
  } = opts;
  if (!env.R1CORD_APP_EXE) throw new Error('R1CORD_APP_EXE is not set');
  let backoff = ADB_BACKOFF_MS;
  let missingLogged = false;
  // A missing program fails asynchronously on Windows (the child's 'error' event), so the
  // fallback happens here: try the next candidate at once; wait only when none of them starts.
  let candidates = adbCandidates(env, existsSync);
  let index = 0;

  while (!state.stopped) {
    let rest = Buffer.alloc(0);
    let previous = new Set();
    const adb = candidates[index];
    try {
      const child = spawnImpl(adb, ['track-devices', '-l'], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      state.child = child;
      child.stdout?.on('data', (chunk) => {
        missingLogged = false;
        try {
          const consumed = consumeFrames(chunk, rest, previous, opts);
          rest = consumed.rest;
          previous = consumed.previous;
          if (consumed.launched) backoff = ADB_BACKOFF_MS;
        } catch (err) {
          logger.error?.(`track-devices parse: ${err.message}`);
        }
      });
      await waitForChild(child);
      if (state.stopped) return;
      logger.info?.('adb track-devices exited, restarting');
      await delay(backoff);
      backoff = nextBackoff(backoff, ADB_MAX_BACKOFF_MS);
    } catch (err) {
      if (state.stopped) return;
      if (isMissingAdb(err)) {
        if (index + 1 < candidates.length) {
          index += 1;
          continue;
        }
        if (!missingLogged) {
          logger.error?.(`adb not found: ${candidates.join(', ')}`);
          missingLogged = true;
        }
        await delay(ADB_MISSING_RETRY_MS);
        candidates = adbCandidates(env, existsSync);
        index = 0;
      } else {
        logger.info?.(`adb track-devices failed: ${err.message}`);
        await delay(backoff);
        backoff = nextBackoff(backoff, ADB_MAX_BACKOFF_MS);
      }
    }
  }
}

function run(opts = {}) {
  const state = { stopped: false, child: null };
  const merged = { ...opts, env: opts.env || process.env, state };
  const done = superviseAdb(merged);
  return {
    stop() {
      state.stopped = true;
      if (state.child && typeof state.child.kill === 'function') {
        try {
          state.child.kill();
        } catch (_err) {
          // already gone
        }
      }
    },
    done,
  };
}

if (require.main === module) {
  run();
}

module.exports = {
  ADB_MISSING_RETRY_MS,
  ADB_BACKOFF_MS,
  parseTrackFrames,
  parseDevices,
  qualifyingSerials,
  arrivedSerials,
  shouldLaunch,
  isMissingAdb,
  adbCandidates,
  run,
};
