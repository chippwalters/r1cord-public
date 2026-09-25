// Datastore lock so two cores (or a core and a future Python server that writes this file)
// cannot open the same datastore: `<datastore>\.r1cord.lock` with pid and exe. Stale if the pid
// is dead, or if a live pid's start time does not match (pid reuse). The older Python server
// does not create this file, so index.js also refuses a port that is already bound.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LOCK_NAME = '.r1cord.lock';
const START_SKEW_MS = 5000;
// A lock file that exists but cannot be read yet is another core between its exclusive create and
// the write of its payload; it counts as held while it is this young.
const FRESH_UNREADABLE_MS = 10000;

class DatastoreLocked extends Error {
  /**
   * @param {string} datastore
   * @param {{pid?: number, exe?: string, started?: number}} [holder]
   */
  constructor(datastore, holder = {}) {
    const pid = holder.pid != null ? String(holder.pid) : 'unknown';
    const exe = holder.exe ? String(holder.exe) : 'unknown process';
    super(
      `datastore is locked by pid ${pid} (${exe}); `
        + `another R1CORD process already has this datastore open: ${datastore}`,
    );
    this.name = 'DatastoreLocked';
    this.datastore = datastore;
    this.holder = holder;
  }
}

function lockPath(datastore) {
  return path.join(String(datastore), LOCK_NAME);
}

function selfStartedMs() {
  return Date.now() - Math.round(process.uptime() * 1000);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === 'EPERM') return true;
    return false;
  }
}

function processStartMs(pid) {
  if (pid === process.pid) return selfStartedMs();
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const rest = stat.slice(close + 2).trim().split(/\s+/);
      const startTicks = Number(rest[19]);
      const btimeLine = fs.readFileSync('/proc/stat', 'utf8').split('\n').find((line) => line.startsWith('btime '));
      const btimeSec = Number((btimeLine || '').split(/\s+/)[1]);
      if (Number.isFinite(startTicks) && Number.isFinite(btimeSec)) {
        return Math.round((btimeSec + startTicks / 100) * 1000);
      }
    } catch (_error) {
      return null;
    }
  }
  return null;
}

// Windows has no cheap start time for another pid, so pid reuse is caught by the image name:
// after a crash and a reboot the recorded pid may belong to an unrelated process.
function processImageName(pid) {
  if (process.platform !== 'win32') return null;
  try {
    const out = require('node:child_process').execFileSync(
      'tasklist',
      ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 },
    );
    const match = /^"([^"]+)","(\d+)"/m.exec(out);
    return match && Number(match[2]) === pid ? match[1].toLowerCase() : null;
  } catch (_error) {
    return null;
  }
}

function readLock(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    const pid = Number(parsed.pid);
    if (!Number.isInteger(pid)) return null;
    return {
      pid,
      exe: typeof parsed.exe === 'string' ? parsed.exe : '',
      started: Number.isFinite(Number(parsed.started)) ? Number(parsed.started) : null,
    };
  } catch (_error) {
    return null;
  }
}

function isHeld(holder, { isAlive, startMs, imageName } = {}) {
  if (!holder) return false;
  const alive = isAlive || processAlive;
  const startedOf = startMs || processStartMs;
  const imageOf = imageName || processImageName;
  if (!alive(holder.pid)) return false;
  if (holder.exe) {
    const image = imageOf(holder.pid);
    if (image && image !== path.win32.basename(holder.exe).toLowerCase()) return false;
  }
  if (holder.started == null) return true;
  const actual = startedOf(holder.pid);
  if (actual == null) return true;
  return Math.abs(actual - holder.started) <= START_SKEW_MS;
}

function freshFile(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs < FRESH_UNREADABLE_MS;
  } catch (_error) {
    return false;
  }
}

function writeLock(file, payload) {
  const fd = fs.openSync(file, 'wx');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * @param {string} datastore
 * @param {{pid?: number, exe?: string, started?: number, isAlive?: Function, startMs?: Function}} [options]
 * @returns {{file: string, payload: {pid: number, exe: string, started: number}}}
 */
function acquireDatastoreLock(datastore, options = {}) {
  const root = path.resolve(String(datastore));
  fs.mkdirSync(root, { recursive: true });
  const file = lockPath(root);
  const payload = {
    pid: options.pid != null ? options.pid : process.pid,
    exe: options.exe != null ? options.exe : process.execPath,
    started: options.started != null ? options.started : selfStartedMs(),
  };
  const check = {
    isAlive: options.isAlive || processAlive,
    startMs: options.startMs || processStartMs,
    imageName: options.imageName || processImageName,
  };

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      writeLock(file, payload);
      return { file, payload };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
    const existing = readLock(file);
    if (!existing && freshFile(file)) throw new DatastoreLocked(root, {});
    if (isHeld(existing, check)) throw new DatastoreLocked(root, existing || {});
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error;
    }
  }
  throw new DatastoreLocked(root, readLock(file) || {});
}

function releaseDatastoreLock(handle) {
  if (!handle || !handle.file) return;
  try {
    const current = readLock(handle.file);
    if (current && handle.payload && current.pid !== handle.payload.pid) return;
    fs.unlinkSync(handle.file);
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
}

module.exports = {
  LOCK_NAME,
  DatastoreLocked,
  lockPath,
  acquireDatastoreLock,
  releaseDatastoreLock,
  readLock,
  processAlive,
  processStartMs,
  selfStartedMs,
};
