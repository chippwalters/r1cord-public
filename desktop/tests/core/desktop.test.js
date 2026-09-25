// Testable parts of r1cord_server/desktop.py: explorer /select argv, host takeover,
// the raise-when-open algorithm with injected Win32, and the local-only admin route.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { defaultConfig, withUpdates } = require('../../src/core/config');
const { createApp } = require('../../src/core/app');
const desktop = require('../../src/core/desktop');

const cleanup = [];
afterEach(async () => {
  desktop.setHostReveal(null);
  while (cleanup.length) await cleanup.pop()();
});

function tmpPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-desktop-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('desktop', () => {
  it('builds the explorer /select argument Python passes to Popen', () => {
    const file = 'C:\\data\\inbox\\rec-1\\audio.m4a';
    expect(desktop.explorerSelectArg(file)).toBe(`/select,${file}`);
  });

  it('spawns explorer.exe with the file selected and does not wait', () => {
    const spawned = [];
    const file = path.join(tmpPath(), 'audio.m4a');
    fs.writeFileSync(file, 'x');
    desktop.revealInExplorer(file, {
      platform: 'linux',
      spawnExplorer: (target) => spawned.push(target),
    });
    expect(spawned).toEqual([path.resolve(file)]);
  });

  it('a host reveal callback is used instead of explorer.exe', () => {
    const spawned = [];
    const hosted = [];
    const file = path.join(tmpPath(), 'audio.m4a');
    fs.writeFileSync(file, 'x');
    desktop.setHostReveal((target) => hosted.push(target));
    desktop.revealInExplorer(file, {
      platform: 'win32',
      spawnExplorer: (target) => spawned.push(target),
      raiseWhenOpen: false,
    });
    expect(hosted).toEqual([path.resolve(file)]);
    expect(spawned).toEqual([]);
  });

  function tickingNow(step = 0.05) {
    let t = 0;
    return () => {
      const value = t;
      t += step;
      return value;
    };
  }

  it('raiseWhenOpen brings a new Explorer window to the front', async () => {
    const logs = [];
    const brought = [];
    const result = await desktop.raiseWhenOpen(new Set([1]), 'C:\\inbox\\rec-1', {
      waitS: 1,
      now: tickingNow(),
      sleep: async () => {},
      explorerWindows: () => [1, 2],
      title: () => '',
      bringToFront: (hwnd) => {
        brought.push(hwnd);
        return true;
      },
      logger: { info: (message) => logs.push(message) },
    });
    expect(result).toBe(true);
    expect(brought).toEqual([2]);
    expect(logs).toEqual([]);
  });

  it('raiseWhenOpen reuses a window whose title starts with the folder', async () => {
    const brought = [];
    const folder = 'C:\\inbox\\rec-1';
    const result = await desktop.raiseWhenOpen(new Set([1, 2]), folder, {
      waitS: 1,
      now: tickingNow(),
      sleep: async () => {},
      explorerWindows: () => [1, 2],
      title: (hwnd) => (hwnd === 2 ? folder : 'Other'),
      bringToFront: (hwnd) => {
        brought.push(hwnd);
        return true;
      },
      logger: { info() {} },
    });
    expect(result).toBe(true);
    expect(brought).toEqual([2]);
  });

  it('raiseWhenOpen flashes when Windows keeps the window behind', async () => {
    const logs = [];
    await desktop.raiseWhenOpen(new Set(), 'C:\\inbox\\rec-1', {
      waitS: 1,
      now: tickingNow(),
      sleep: async () => {},
      explorerWindows: () => [9],
      title: () => '',
      bringToFront: () => false,
      logger: { info: (message) => logs.push(message) },
    });
    expect(logs.some((line) => line.includes('behind the foreground window'))).toBe(true);
  });

  it('raiseWhenOpen logs when no Explorer window appears', async () => {
    const logs = [];
    const result = await desktop.raiseWhenOpen(new Set(), 'C:\\inbox\\rec-1', {
      waitS: 0.5,
      now: tickingNow(),
      sleep: async () => {},
      explorerWindows: () => [],
      title: () => '',
      bringToFront: () => true,
      logger: { info: (message) => logs.push(message) },
    });
    expect(result).toBe(false);
    expect(logs.some((line) => line.includes('no Explorer window'))).toBe(true);
  });

  it('show_in_folder_reveals_the_audio_on_this_pc_only', async () => {
    const launched = [];
    const spy = vi.spyOn(desktop, 'revealInExplorer').mockImplementation((file) => launched.push(file));
    cleanup.push(() => spy.mockRestore());

    const tmp = tmpPath();
    const config = withUpdates(defaultConfig(), {
      datastore: path.join(tmp, 'ds'),
      webdav_folder: path.join(tmp, 'wd'),
      public_url_base: 'https://example.test/files',
      admin_password: 'test-admin-pass1',
      listen_port: 0,
    });
    const app = createApp(config, { noWorker: true, noUsb: true });
    cleanup.push(() => app.close());
    await app.ready();

    const audio = path.join(config.datastore, 'inbox', 'rec-audio-1', 'audio.m4a');
    fs.mkdirSync(path.dirname(audio), { recursive: true });
    fs.writeFileSync(audio, Buffer.from('0123456789'));

    const local = await app.inject({
      method: 'POST',
      url: '/admin/recordings/rec-audio-1/folder',
      remoteAddress: '127.0.0.1',
    });
    expect(local.statusCode).toBe(303);
    expect(launched).toEqual([path.resolve(audio)]);

    const basic = `Basic ${Buffer.from('admin:test-admin-pass1').toString('base64')}`;
    const tunnel = await app.inject({
      method: 'POST',
      url: '/admin/recordings/rec-audio-1/folder',
      remoteAddress: '127.0.0.1',
      headers: { authorization: basic, 'cf-connecting-ip': '203.0.113.9' },
    });
    expect(tunnel.statusCode).toBe(403);
    expect(launched).toEqual([path.resolve(audio)]);
  });
});
