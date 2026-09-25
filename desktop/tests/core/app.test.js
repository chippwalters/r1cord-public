import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { defaultConfig, withUpdates } = require('../../src/core/config');
const { createApp, activityAt, monotonicSeconds } = require('../../src/core/app');

const cleanup = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

function tmpPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-app-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function openApp() {
  const tmp = tmpPath();
  const config = withUpdates(defaultConfig(), {
    datastore: path.join(tmp, 'ds'),
    webdav_folder: path.join(tmp, 'wd'),
    public_url_base: 'https://example.test/files',
    admin_password: 'test-admin-pass1',
    run_mode: 'plug',
    idle_exit_min: 1,
  });
  const app = createApp(config, { noWorker: true, noUsb: true });
  cleanup.push(() => app.close());
  await app.ready();
  return app;
}

describe('activityAt', () => {
  it('returns last_activity when the window is closed and now when it is open', async () => {
    const app = await openApp();
    const stamped = 12.5;
    app.state.last_activity = stamped;
    app.state.windowOpen = false;
    expect(activityAt(app.state, 99)).toBe(stamped);
    app.state.windowOpen = true;
    expect(activityAt(app.state, 99)).toBe(99);
    expect(activityAt(app.state)).toBeGreaterThanOrEqual(monotonicSeconds() - 1);
  });

  it('keeps plug-mode idle from firing while the admin window is open', async () => {
    const app = await openApp();
    const exits = [];
    const watcher = app.state.usb;
    watcher._requestExit = () => exits.push(1);
    const aged = monotonicSeconds() - 120;
    watcher._lastAdoptedSeen = aged;
    app.state.last_activity = aged;
    app.state.windowOpen = true;
    expect(watcher._idleCheck(app.state.config)).toBe(false);
    expect(exits).toEqual([]);
    app.state.windowOpen = false;
    expect(watcher._idleCheck(app.state.config)).toBe(true);
    expect(exits).toEqual([1]);
  });
});
