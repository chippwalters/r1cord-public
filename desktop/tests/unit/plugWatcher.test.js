import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ADB_MISSING_RETRY_MS,
  adbCandidates,
  arrivedSerials,
  parseDevices,
  parseTrackFrames,
  qualifyingSerials,
  run,
  shouldLaunch,
} = require('../../src/main/services/startup/plug-watcher.js');

const APP = 'D:\\Apps\\R1CORD Desktop.exe';

function frameFor(body) {
  const prefix = body.length.toString(16).padStart(4, '0');
  return Buffer.from(`${prefix}${body}`, 'utf8');
}

function fakeAdb() {
  const handlers = {};
  return {
    stdout: {
      on(event, fn) {
        (handlers[event] ||= []).push(fn);
      },
    },
    stderr: { on() {} },
    on(event, fn) {
      (handlers[event] ||= []).push(fn);
    },
    emitData(buf) {
      (handlers.data || []).forEach((fn) => fn(buf));
    },
    emitExit(code) {
      (handlers.exit || []).forEach((fn) => fn(code, null));
    },
    emitError(err) {
      (handlers.error || []).forEach((fn) => fn(err));
    },
    kill: vi.fn(function kill() {
      (handlers.exit || []).forEach((fn) => fn(null, 'SIGTERM'));
    }),
  };
}

describe('plug watcher', () => {
  it('splits adb track-devices frames the way the python watcher does', () => {
    const body = 'S1\tdevice product:r1 model:Rabbit_R1\n';
    const { frames, rest } = parseTrackFrames(frameFor(body));
    expect(frames).toEqual([body]);
    expect(rest.length).toBe(0);
    const devices = parseDevices(frames[0]);
    expect(devices[0]).toMatchObject({ serial: 'S1', state: 'device', model: 'Rabbit_R1' });
    expect(shouldLaunch(devices)).toBe(true);
    expect(shouldLaunch([{ serial: 'S1', state: 'offline', model: '' }])).toBe(false);
  });

  it('launches on a device arrival and not again while it stays connected', () => {
    const adb = fakeAdb();
    const spawned = [];
    const spawnImpl = vi.fn((file, args) => {
      spawned.push({ file, args });
      if (file === 'adb') return adb;
      return { unref: vi.fn() };
    });
    const watcher = run({
      spawnImpl,
      env: { R1CORD_ADB: 'adb', R1CORD_APP_EXE: APP },
    });
    expect(spawned[0]).toEqual({ file: 'adb', args: ['track-devices', '-l'] });
    const present = frameFor('S1\tdevice\n');
    adb.emitData(present);
    adb.emitData(present);
    const launches = spawned.filter((row) => row.file === APP);
    expect(launches).toHaveLength(1);
    expect(launches[0].args).toEqual(['--background']);
    watcher.stop();
  });

  it('launches again when a qualifying device arrives after leaving', () => {
    const adb = fakeAdb();
    const spawned = [];
    const spawnImpl = vi.fn((file, args) => {
      spawned.push({ file, args });
      if (file === 'adb') return adb;
      return { unref: vi.fn() };
    });
    const watcher = run({
      spawnImpl,
      env: { R1CORD_ADB: 'adb', R1CORD_APP_EXE: APP },
    });
    adb.emitData(frameFor('S1\tdevice\n'));
    adb.emitData(frameFor(''));
    adb.emitData(frameFor('S1\tdevice\n'));
    expect(spawned.filter((row) => row.file === APP)).toHaveLength(2);
    watcher.stop();
  });

  it('launches only adopted serials when the adopted file lists them', () => {
    const adb = fakeAdb();
    const spawned = [];
    const spawnImpl = vi.fn((file, args) => {
      spawned.push({ file, args });
      if (file === 'adb') return adb;
      return { unref: vi.fn() };
    });
    const watcher = run({
      spawnImpl,
      env: {
        R1CORD_ADB: 'adb',
        R1CORD_APP_EXE: APP,
        R1CORD_ADOPTED_SERIALS_FILE: 'D:\\user\\adopted-serials.json',
      },
      readFileSync: () => JSON.stringify({ serials: ['R1ONLY'] }),
    });
    adb.emitData(frameFor('PHONE\tdevice\n'));
    expect(spawned.filter((row) => row.file === APP)).toHaveLength(0);
    adb.emitData(frameFor('R1ONLY\tdevice\n'));
    expect(spawned.filter((row) => row.file === APP)).toHaveLength(1);
    watcher.stop();
  });

  it('treats a missing or empty adopted file as launch-for-any-device', () => {
    expect(qualifyingSerials([{ serial: 'PHONE', state: 'device' }], null)).toEqual(['PHONE']);
    const adb = fakeAdb();
    const spawned = [];
    const spawnImpl = vi.fn((file, args) => {
      spawned.push({ file, args });
      if (file === 'adb') return adb;
      return { unref: vi.fn() };
    });
    const err = Object.assign(new Error('no file'), { code: 'ENOENT' });
    const watcher = run({
      spawnImpl,
      env: {
        R1CORD_ADB: 'adb',
        R1CORD_APP_EXE: APP,
        R1CORD_ADOPTED_SERIALS_FILE: 'D:\\user\\adopted-serials.json',
      },
      readFileSync: () => {
        throw err;
      },
    });
    adb.emitData(frameFor('PHONE\tdevice\n'));
    expect(spawned.filter((row) => row.file === APP)).toHaveLength(1);
    watcher.stop();
  });

  it('restarts adb track-devices after it exits', async () => {
    const children = [];
    const spawnImpl = vi.fn((file) => {
      if (file === 'adb') {
        const child = fakeAdb();
        children.push(child);
        return child;
      }
      return { unref: vi.fn() };
    });
    const watcher = run({
      spawnImpl,
      delay: async () => {},
      env: { R1CORD_ADB: 'adb', R1CORD_APP_EXE: APP },
    });
    expect(children).toHaveLength(1);
    children[0].emitExit(1);
    await vi.waitFor(() => expect(children.length).toBe(2));
    watcher.stop();
  });

  it('retries slowly and logs once when adb is missing', async () => {
    const logs = [];
    const delays = [];
    const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
    let watcher;
    watcher = run({
      spawnImpl: () => {
        throw err;
      },
      delay: async (ms) => {
        delays.push(ms);
        if (delays.length >= 2) watcher.stop();
      },
      logger: {
        error: (message) => logs.push(message),
        info() {},
      },
      env: { R1CORD_ADB: 'adb', R1CORD_APP_EXE: APP },
    });
    await watcher.done;
    expect(delays[0]).toBe(ADB_MISSING_RETRY_MS);
    expect(delays[1]).toBe(ADB_MISSING_RETRY_MS);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/adb not found/);
  });

  it('falls back to the downloaded adb when adb on PATH fails to start, without the slow retry', async () => {
    const downloaded = 'C:\\Users\\u\\AppData\\Local\\R1CORD\\platform-tools\\adb.exe';
    const pathAdb = fakeAdb();
    const downloadedAdb = fakeAdb();
    const spawned = [];
    const delays = [];
    const spawnImpl = vi.fn((file) => {
      spawned.push(file);
      if (file === 'adb') return pathAdb;
      if (file === downloaded) return downloadedAdb;
      return { pid: 99, unref() {}, on() {} };
    });
    const watcher = run({
      spawnImpl,
      existsSync: (file) => file === downloaded,
      delay: async (ms) => { delays.push(ms); },
      env: { R1CORD_ADB: 'adb', R1CORD_DOWNLOADED_ADB: downloaded, R1CORD_APP_EXE: APP },
    });
    // Windows reports a missing program asynchronously, as the child's 'error' event.
    pathAdb.emitError(Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' }));
    await vi.waitFor(() => expect(spawned).toContain(downloaded));
    expect(delays).not.toContain(ADB_MISSING_RETRY_MS);
    downloadedAdb.emitData(frameFor('S1\tdevice\n'));
    expect(spawned).toContain(APP);
    watcher.stop();
  });

  it('tries an explicit adb alone, and skips a download location with no adb in it', () => {
    expect(adbCandidates({ R1CORD_ADB: 'D:\\tools\\adb.exe', R1CORD_DOWNLOADED_ADB: 'X' }, () => true)).toEqual(['D:\\tools\\adb.exe']);
    expect(adbCandidates({ R1CORD_ADB: 'adb', R1CORD_DOWNLOADED_ADB: 'C:\\none\\adb.exe' }, () => false)).toEqual(['adb']);
  });
});

describe('arrival math', () => {
  it('reports only serials that were absent in the previous set', () => {
    expect(arrivedSerials(new Set(), ['S1'])).toEqual(['S1']);
    expect(arrivedSerials(new Set(['S1']), ['S1'])).toEqual([]);
    expect(arrivedSerials(new Set(['S1']), [])).toEqual([]);
    expect(arrivedSerials(new Set(), ['S1', 'S2'])).toEqual(['S1', 'S2']);
  });
});
