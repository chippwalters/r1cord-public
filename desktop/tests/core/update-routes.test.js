// The Updates admin page: consent settings, the explicit Check now, the admin guard, and the
// banner other pages show. fetch is stubbed; no request leaves the process.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { defaultConfig, loadConfig, saveConfig, withUpdates } = require('../../src/core/config');
const { createApp } = require('../../src/core/app');
const { createLogger } = require('../../src/core/log');
const updates = require('../../src/core/updates');
const { updateBanner } = require('../../src/core/admin/views/updates');

const MANIFEST_URL = 'https://updates.example.test/r1cord/manifest.json';
const cleanup = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
  vi.unstubAllGlobals();
  updates.resetForTests();
});

function stubFetch() {
  const calls = [];
  vi.stubGlobal('fetch', async (url) => {
    calls.push(String(url));
    return new Response('unavailable', { status: 503 });
  });
  return calls;
}

async function openEnv(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-updates-admin-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = withUpdates(defaultConfig(), {
    datastore: path.join(root, 'datastore'),
    webdav_folder: path.join(root, 'publish'),
    admin_password: 'test-admin-pass1',
    update_manifest_url: MANIFEST_URL,
    ...overrides,
  });
  const configPath = path.join(root, 'config.toml');
  saveConfig(config, configPath);
  const app = createApp(config, { configPath, noWorker: true, noUsb: true, logger: createLogger({ sink: () => {} }) });
  cleanup.push(() => app.close());
  await app.ready();
  const request = (method, url, { form = null, headers = {} } = {}) =>
    app.inject({
      method,
      url,
      headers: form ? { 'content-type': 'application/x-www-form-urlencoded', ...headers } : headers,
      payload: form ? new URLSearchParams(form).toString() : undefined,
    });
  return { app, configPath, request };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('/admin/updates', () => {
  it('saves consent and the R1 auto-update choice to config.toml, and checks once when consent is new', async () => {
    const calls = stubFetch();
    const env = await openEnv();
    const res = await env.request('POST', '/admin/updates/settings', { form: { update_check: 'on', r1_auto_update: 'install' } });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/admin/updates?saved=1');
    const saved = loadConfig(env.configPath);
    expect(saved).toMatchObject({ update_check: true, update_check_asked: true, r1_auto_update: 'install' });
    expect(env.app.state.config.update_check).toBe(true);
    await settle();
    expect(calls).toEqual([MANIFEST_URL]);
  });

  it('records a "no" answer without any request, and keeps an invalid auto-update value out', async () => {
    const calls = stubFetch();
    const env = await openEnv({ r1_auto_update: 'ask' });
    const res = await env.request('POST', '/admin/updates/settings', { form: { r1_auto_update: 'everything', return_to: '/admin' } });
    expect(res.headers.location).toBe('/admin');
    expect(loadConfig(env.configPath)).toMatchObject({ update_check: false, update_check_asked: true, r1_auto_update: 'ask' });
    await settle();
    expect(calls).toEqual([]);
  });

  it('only returns to admin pages', async () => {
    stubFetch();
    const env = await openEnv();
    for (const target of ['https://evil.example/', '//evil.example/admin', '/admin/../x', '/other']) {
      const res = await env.request('POST', '/admin/updates/settings', { form: { return_to: target } });
      expect(res.headers.location).toBe('/admin/updates?saved=1');
    }
  });

  it('Check now fetches once even with daily checks off, and the page shows the failure', async () => {
    const calls = stubFetch();
    const env = await openEnv({ update_check: false });
    const res = await env.request('POST', '/admin/updates/check');
    expect(res.statusCode).toBe(303);
    expect(calls).toEqual([MANIFEST_URL]);
    const page = await env.request('GET', '/admin/updates');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Check now');
    expect(page.body).toContain('HTTP 503');
  });

  it('refuses tunnel callers and cross-site posts before reading the form', async () => {
    const calls = stubFetch();
    const env = await openEnv();
    const tunnel = await env.request('POST', '/admin/updates/settings', { form: { update_check: 'on' }, headers: { 'cf-connecting-ip': '203.0.113.9' } });
    expect(tunnel.statusCode).toBe(403);
    const crossSite = await env.request('POST', '/admin/updates/check', { headers: { origin: 'https://evil.example' } });
    expect(crossSite.statusCode).toBe(403);
    expect(loadConfig(env.configPath).update_check).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('R1 app updates on /admin/updates', () => {
  const SERIAL = 'R1DEVICESERIAL001';
  const pending = (check = {}) => ({
    serial: SERIAL,
    installing: false,
    lastResult: null,
    check: {
      serial: SERIAL,
      checkedAt: '2026-09-26T10:00:00Z',
      items: [{ entry: 'r1cord', name: 'R1CORD', package: 'com.chippwalters.r1cord', from: { versionName: '0.4.0', versionCode: 17 }, to: { versionName: '0.4.1', versionCode: 18 } }],
      legacy: false,
      error: null,
      installing: false,
      ...check,
    },
  });

  async function envWith(rows) {
    stubFetch();
    const env = await openEnv({ r1_auto_update: 'ask' });
    const setup = env.app.state.setup;
    setup.r1Updates = () => rows;
    setup.installUpdates = vi.fn(async () => ({ ok: true, detail: 'R1CORD: installed 0.4.1 (18)' }));
    return { ...env, setup };
  }

  it('shows the pending update, and Install runs installUpdates for that R1', async () => {
    const env = await envWith([pending()]);
    const page = await env.request('GET', '/admin/updates');
    expect(page.body).toContain('Update R1CORD 0.4.0 → 0.4.1');
    expect(page.body).toContain(`action="/admin/updates/r1/${SERIAL}/install"`);
    const res = await env.request('POST', `/admin/updates/r1/${SERIAL}/install`);
    expect(res.statusCode).toBe(303);
    expect(env.setup.installUpdates).toHaveBeenCalledTimes(1);
    expect(env.setup.installUpdates).toHaveBeenCalledWith(env.app.state, SERIAL);
  });

  it('never installs for a tunnel caller, an R1CORD without the maintenance gate, or with nothing pending', async () => {
    const tunnel = await envWith([pending()]);
    const refused = await tunnel.request('POST', `/admin/updates/r1/${SERIAL}/install`, { headers: { 'cf-connecting-ip': '203.0.113.9' } });
    expect(refused.statusCode).toBe(403);
    expect(tunnel.setup.installUpdates).not.toHaveBeenCalled();

    const legacy = await envWith([pending({ legacy: true })]);
    const page = await legacy.request('GET', '/admin/updates');
    expect(page.body).not.toContain(`action="/admin/updates/r1/${SERIAL}/install"`);
    const res = await legacy.request('POST', `/admin/updates/r1/${SERIAL}/install`);
    expect(res.headers.location).toMatch(/error=/);
    expect(legacy.setup.installUpdates).not.toHaveBeenCalled();

    const none = await envWith([]);
    const nothing = await none.request('POST', `/admin/updates/r1/${SERIAL}/install`);
    expect(nothing.headers.location).toMatch(/error=/);
    expect(none.setup.installUpdates).not.toHaveBeenCalled();
  });

  it('shows the last install result', async () => {
    const env = await envWith([{ serial: SERIAL, installing: false, check: null, lastResult: { at: '2026-09-26T10:05:00Z', ok: false, detail: 'R1CORD is busy (upload); try again when it is idle' } }]);
    const page = await env.request('GET', '/admin/updates');
    expect(page.body).toContain('R1CORD is busy (upload); try again when it is idle');
    expect(page.body).toContain('Failed');
  });
});

describe('updateBanner', () => {
  const quiet = { desktop: { available: false, current: '0.5.0', latest: null } };

  it('asks the first-run question until it is answered', () => {
    const html = String(updateBanner({ path: '/admin', config: { update_check_asked: false }, updates: quiet }));
    expect(html).toContain('Check for updates?');
    expect(html).toContain('action="/admin/updates/settings"');
  });

  it('announces a newer desktop, and is empty otherwise', () => {
    const newer = { desktop: { available: true, current: '0.5.0', latest: '0.6.0' } };
    expect(String(updateBanner({ config: { update_check_asked: true }, updates: newer }))).toContain('R1CORD Desktop 0.6.0 is available');
    expect(updateBanner({ config: { update_check_asked: true }, updates: quiet })).toBe('');
  });
});
