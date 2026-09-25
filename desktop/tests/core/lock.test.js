import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  LOCK_NAME,
  DatastoreLocked,
  acquireDatastoreLock,
  releaseDatastoreLock,
  readLock,
  lockPath,
} = require('../../src/core/lock');
const { defaultConfig, saveConfig, withUpdates } = require('../../src/core/config');
const { createApp } = require('../../src/core/app');
const { listenError } = require('../../src/core/index');

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const INDEX = path.join(REPO, 'src', 'core', 'index.js');

const cleanup = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-lock-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeToml(root, listenPort) {
  const datastore = path.join(root, 'ds');
  const config = withUpdates(defaultConfig(), {
    datastore,
    webdav_folder: path.join(root, 'wd'),
    public_url_base: 'https://example.test/files',
    admin_password: 'test-admin-pass1',
    listen_host: '127.0.0.1',
    listen_port: listenPort,
  });
  const configPath = path.join(root, 'config.toml');
  saveConfig(config, configPath);
  return { config, configPath, datastore };
}

function waitExit(child, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`child ${child.pid} did not exit in ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr: child.stderrText || '' });
    });
  });
}

function collectStderr(child) {
  child.stderrText = '';
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      child.stderrText += chunk;
    });
  }
}

function spawnCore(configPath, port) {
  const child = spawn(
    process.execPath,
    [INDEX, '--config', configPath, '--port', String(port), '--no-usb', '--no-worker'],
    { cwd: REPO, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  collectStderr(child);
  cleanup.push(async () => {
    if (child.exitCode == null && child.signalCode == null) {
      child.kill();
      await waitExit(child, 4000).catch(() => {});
    }
  });
  return child;
}

function getStatus(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/admin/api/status`, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
  });
}

async function waitStatus(port, timeoutMs = 15000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const code = await getStatus(port);
      if (code === 200) return;
      last = `HTTP ${code}`;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`core on ${port} not ready: ${last}`);
}

describe('datastore lock', () => {
  it('writes pid and exe, and refuses a second holder', () => {
    const dir = tmpDir();
    const first = acquireDatastoreLock(dir, { pid: 4242, exe: 'C:\\r1cord\\node.exe', started: 1000 });
    cleanup.push(() => releaseDatastoreLock(first));
    expect(fs.existsSync(path.join(dir, LOCK_NAME))).toBe(true);
    const body = readLock(lockPath(dir));
    expect(body).toMatchObject({ pid: 4242, exe: 'C:\\r1cord\\node.exe', started: 1000 });
    const liveHolder = { pid: 99, isAlive: (pid) => pid === 4242, startMs: () => 1000, imageName: () => 'node.exe' };
    expect(() => acquireDatastoreLock(dir, liveHolder)).toThrow(DatastoreLocked);
    try {
      acquireDatastoreLock(dir, liveHolder);
    } catch (error) {
      expect(error.message).toMatch(/datastore is locked by pid 4242/);
      expect(error.message).toMatch(/C:\\r1cord\\node\.exe/);
    }
  });

  it('treats a dead pid as stale and takes over', () => {
    const dir = tmpDir();
    fs.writeFileSync(lockPath(dir), `${JSON.stringify({ pid: 999999, exe: 'gone.exe', started: 1 })}\n`);
    const held = acquireDatastoreLock(dir, { pid: 7, exe: 'me.exe', started: 2, isAlive: () => false });
    cleanup.push(() => releaseDatastoreLock(held));
    expect(readLock(lockPath(dir)).pid).toBe(7);
  });

  it('treats a live pid with a different start time as stale', () => {
    const dir = tmpDir();
    fs.writeFileSync(lockPath(dir), `${JSON.stringify({ pid: 50, exe: 'old.exe', started: 1000 })}\n`);
    const held = acquireDatastoreLock(dir, {
      pid: 8,
      exe: 'new.exe',
      started: 9000,
      isAlive: () => true,
      startMs: () => 9000,
    });
    cleanup.push(() => releaseDatastoreLock(held));
    expect(readLock(lockPath(dir)).pid).toBe(8);
  });

  it('treats a live pid running a different program as stale (pid reused after a reboot)', () => {
    const dir = tmpDir();
    fs.writeFileSync(lockPath(dir), `${JSON.stringify({ pid: 60, exe: 'C:\\R1CORD\\R1CORD Desktop.exe' })}\n`);
    const reused = { pid: 9, exe: 'me.exe', isAlive: () => true, startMs: () => null, imageName: () => 'svchost.exe' };
    const held = acquireDatastoreLock(dir, reused);
    cleanup.push(() => releaseDatastoreLock(held));
    expect(readLock(lockPath(dir)).pid).toBe(9);
  });

  it('keeps a live pid running the recorded program', () => {
    const dir = tmpDir();
    fs.writeFileSync(lockPath(dir), `${JSON.stringify({ pid: 61, exe: 'C:\\R1CORD\\R1CORD Desktop.exe' })}\n`);
    const same = { pid: 9, isAlive: () => true, startMs: () => null, imageName: () => 'r1cord desktop.exe' };
    expect(() => acquireDatastoreLock(dir, same)).toThrow(DatastoreLocked);
    expect(readLock(lockPath(dir)).pid).toBe(61);
  });

  it('an empty lock file is another core mid-create while young, and stale once old', () => {
    const dir = tmpDir();
    fs.writeFileSync(lockPath(dir), '');
    expect(() => acquireDatastoreLock(dir, { pid: 10, exe: 'me.exe' })).toThrow(DatastoreLocked);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath(dir), old, old);
    const held = acquireDatastoreLock(dir, { pid: 10, exe: 'me.exe' });
    cleanup.push(() => releaseDatastoreLock(held));
    expect(readLock(lockPath(dir)).pid).toBe(10);
  });

  it('releases on close so another core can open the datastore', async () => {
    const root = tmpDir();
    const { config } = writeToml(root, 8811);
    const first = createApp(config, { noWorker: true, noUsb: true });
    await first.ready();
    expect(fs.existsSync(path.join(config.datastore, LOCK_NAME))).toBe(true);
    expect(() => createApp(config, { noWorker: true, noUsb: true })).toThrow(/datastore is locked/);
    await first.close();
    expect(fs.existsSync(path.join(config.datastore, LOCK_NAME))).toBe(false);
    const second = createApp(config, { noWorker: true, noUsb: true });
    cleanup.push(() => second.close());
    await second.ready();
  });
});

describe('listen address in use', () => {
  it('rewrites EADDRINUSE into a clear message', () => {
    const cause = new Error('listen EADDRINUSE: address already in use 127.0.0.1:8798');
    cause.code = 'EADDRINUSE';
    const error = listenError(cause, '127.0.0.1', 8798);
    expect(error.message).toMatch(/127\.0\.0\.1:8798 is already in use/);
    expect(error.message).toMatch(/another R1CORD server or core/);
  });

  it('a spawned core exits non-zero when the port is taken', async () => {
    const root = tmpDir();
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise((resolve) => blocker.close(resolve)));
    const port = blocker.address().port;
    const { configPath } = writeToml(root, port);
    const child = spawnCore(configPath, port);
    const result = await waitExit(child, 15000);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(new RegExp(`listen address 127\\.0\\.0\\.1:${port} is already in use`));
  }, 20000);
});

describe('spawned second core', () => {
  it('is refused with the lock message and a non-zero exit', async () => {
    const root = tmpDir();
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const { configPath, datastore } = writeToml(root, port);
    const first = spawnCore(configPath, port);
    await waitStatus(port);
    expect(readLock(lockPath(datastore)).pid).toBe(first.pid);

    const second = spawnCore(configPath, port + 1);
    const result = await waitExit(second, 15000);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/datastore is locked by pid /);
    expect(result.stderr).toMatch(new RegExp(String(first.pid)));
  }, 25000);
});
