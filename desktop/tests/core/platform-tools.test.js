// The consented platform-tools install: a local HTTP server serves real zips built here, Windows'
// tar extracts them, and the signature check is faked except in the one test of the real check.
// Nothing here contacts Google or runs adb.
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const { authenticode, createPlatformToolsDownload } = require('../../src/core/platform-tools');

const GOOGLE = { status: 'Valid', subject: 'CN=Google LLC, O=Google LLC, L=Mountain View, S=California, C=US' };

const cleanup = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-ptools-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A stored (uncompressed) zip of {name: content}.
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralSize = centrals.reduce((sum, buf) => sum + buf.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const GOOD_ZIP = makeZip({
  'platform-tools/adb.exe': 'new-adb',
  'platform-tools/AdbWinApi.dll': 'dll',
});
const NO_ADB_ZIP = makeZip({ 'platform-tools/fastboot.exe': 'fastboot' });

async function serve() {
  const server = http.createServer((request, response) => {
    if (request.url === '/good.zip' || request.url === '/noadb.zip') {
      const body = request.url === '/good.zip' ? GOOD_ZIP : NO_ADB_ZIP;
      response.writeHead(200, { 'content-type': 'application/zip', 'content-length': body.length });
      response.end(body);
    } else if (request.url === '/stall.zip') {
      // Half the file, then nothing until the client gives up.
      response.writeHead(200, { 'content-type': 'application/zip', 'content-length': GOOD_ZIP.length });
      response.write(GOOD_ZIP.subarray(0, 40));
    } else {
      response.writeHead(404);
      response.end('not here');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

function downloader(url, signature = GOOGLE) {
  const checked = [];
  const tools = createPlatformToolsDownload({
    url,
    verify: async (file) => {
      checked.push(fs.readFileSync(file, 'utf8'));
      return signature;
    },
  });
  return { tools, checked };
}

function leftovers(configDir) {
  return fs.readdirSync(configDir).filter((name) => name !== 'config.toml' && name !== 'platform-tools');
}

describe.skipIf(process.platform !== 'win32')('platform-tools download', () => {
  it('installs a verified copy beside config.toml and cleans up after itself', async () => {
    const base = await serve();
    const configDir = tmpDir();
    const { tools, checked } = downloader(`${base}/good.zip`);
    const lines = [];
    const installed = [];

    const adb = await tools.start(configDir, { log: (line) => lines.push(line), onInstalled: (file) => installed.push(file) });

    expect(adb).toBe(path.join(configDir, 'platform-tools', 'adb.exe'));
    expect(fs.readFileSync(adb, 'utf8')).toBe('new-adb');
    expect(fs.readFileSync(path.join(configDir, 'platform-tools', 'AdbWinApi.dll'), 'utf8')).toBe('dll');
    expect(checked).toEqual(['new-adb']);
    expect(installed).toEqual([adb]);
    expect(leftovers(configDir)).toEqual([]);
    expect(lines.some((line) => line.startsWith('usb: downloading platform-tools'))).toBe(true);
    expect(lines.some((line) => line.startsWith('usb: platform-tools installed at'))).toBe(true);
    const snap = tools.snapshot(configDir);
    expect(snap).toMatchObject({ active: false, installed: adb, done: adb, error: '' });
  });

  it('replaces an older copy completely', async () => {
    const base = await serve();
    const configDir = tmpDir();
    fs.mkdirSync(path.join(configDir, 'platform-tools'));
    fs.writeFileSync(path.join(configDir, 'platform-tools', 'adb.exe'), 'old-adb');
    fs.writeFileSync(path.join(configDir, 'platform-tools', 'retired.dll'), 'old');

    await downloader(`${base}/good.zip`).tools.start(configDir);

    expect(fs.readdirSync(path.join(configDir, 'platform-tools')).sort()).toEqual(['AdbWinApi.dll', 'adb.exe']);
    expect(fs.readFileSync(path.join(configDir, 'platform-tools', 'adb.exe'), 'utf8')).toBe('new-adb');
    expect(leftovers(configDir)).toEqual([]);
  });

  it('installs nothing on an HTTP error, a zip without adb.exe, or a bad signature', async () => {
    const base = await serve();
    const cases = [
      [`${base}/missing.zip`, GOOGLE, /HTTP 404/],
      [`${base}/noadb.zip`, GOOGLE, /no platform-tools\/adb\.exe/],
      [`${base}/good.zip`, { status: 'HashMismatch', subject: GOOGLE.subject }, /not validly signed by Google.*HashMismatch/],
      [`${base}/good.zip`, { status: 'Valid', subject: 'CN=Someone Else' }, /not validly signed by Google/],
      [`${base}/good.zip`, { status: 'NotSigned', subject: '' }, /NotSigned/],
    ];
    for (const [url, signature, reason] of cases) {
      const configDir = tmpDir();
      const { tools } = downloader(url, signature);
      await expect(tools.start(configDir)).rejects.toThrow(reason);
      expect(fs.existsSync(path.join(configDir, 'platform-tools'))).toBe(false);
      expect(leftovers(configDir)).toEqual([]);
      const snap = tools.snapshot(configDir);
      expect(snap.active).toBe(false);
      expect(snap.installed).toBe('');
      expect(snap.error).toMatch(reason);
    }
  });

  it('keeps an older copy untouched when the new one fails its signature check', async () => {
    const base = await serve();
    const configDir = tmpDir();
    fs.mkdirSync(path.join(configDir, 'platform-tools'));
    fs.writeFileSync(path.join(configDir, 'platform-tools', 'adb.exe'), 'old-adb');

    const { tools } = downloader(`${base}/good.zip`, { status: 'UnknownError', subject: '' });
    await expect(tools.start(configDir)).rejects.toThrow(/not validly signed/);

    expect(fs.readdirSync(path.join(configDir, 'platform-tools'))).toEqual(['adb.exe']);
    expect(fs.readFileSync(path.join(configDir, 'platform-tools', 'adb.exe'), 'utf8')).toBe('old-adb');
    expect(leftovers(configDir)).toEqual([]);
  });

  it('shows bytes while downloading, and a cancel leaves nothing behind', async () => {
    const base = await serve();
    const configDir = tmpDir();
    const { tools } = downloader(`${base}/stall.zip`);
    const run = tools.start(configDir);
    expect(tools.start(configDir)).toBe(run);
    for (let i = 0; i < 100 && tools.snapshot(configDir).received === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const snap = tools.snapshot(configDir);
    expect(snap).toMatchObject({ active: true, phase: 'downloading', received: 40, total: GOOD_ZIP.length });

    tools.cancel();
    await expect(run).rejects.toThrow();
    expect(tools.snapshot(configDir)).toMatchObject({ active: false, error: 'cancelled', installed: '' });
    expect(fs.existsSync(path.join(configDir, 'platform-tools'))).toBe(false);
    expect(leftovers(configDir)).toEqual([]);
  });

  it('reads real Authenticode results through Windows PowerShell', async () => {
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const signed = await authenticode(tar);
    expect(signed.status).toBe('Valid');
    expect(signed.subject).toMatch(/Microsoft/);

    const file = path.join(tmpDir(), 'adb.exe');
    fs.writeFileSync(file, 'not a signed program');
    const unsigned = await authenticode(file);
    expect(unsigned.status).not.toBe('Valid');
    expect(unsigned.subject).toBe('');
  }, 60_000);
});
