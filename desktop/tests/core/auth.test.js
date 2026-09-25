// Auth edge cases: bearer tokens, local-direct, Basic through a proxy, Host/Origin guards.
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { defaultConfig, withUpdates } = require('../../src/core/config');
const { createApp } = require('../../src/core/app');
const {
  checkBrowserRequest,
  hostName,
  isLocalDirect,
  requireAdmin,
  requireToken,
} = require('../../src/core/auth');
const { HttpError } = require('../../src/core/http-error');

const cleanup = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

function tmpPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-auth-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cfg(tmp) {
  return withUpdates(defaultConfig(), {
    datastore: path.join(tmp, 'ds'),
    webdav_folder: path.join(tmp, 'wd'),
    public_url_base: 'https://example.test/files',
    admin_password: 'test-admin-pass1',
    listen_port: 0,
  });
}

async function openApp(config) {
  const app = createApp(config, { noWorker: true, noUsb: true });
  cleanup.push(() => app.close());
  await app.ready();
  return app;
}

function fakeRequest({ method = 'GET', headers = {}, ip = '127.0.0.1', store = null, config = null } = {}) {
  const lower = {};
  for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;
  return {
    method,
    headers: lower,
    ip,
    socket: { remoteAddress: ip },
    server: { state: { store, config } },
  };
}

describe('hostName', () => {
  it('strips the port and brackets', () => {
    expect(hostName('127.0.0.1:8765')).toBe('127.0.0.1');
    expect(hostName('[::1]:8765')).toBe('::1');
    expect(hostName('localhost')).toBe('localhost');
  });
});

describe('isLocalDirect', () => {
  it('is true for a loopback peer without proxy headers', () => {
    expect(isLocalDirect(fakeRequest({ ip: '127.0.0.1' }))).toBe(true);
    expect(isLocalDirect(fakeRequest({ ip: '::1' }))).toBe(true);
  });

  it('is false for a remote peer or a loopback hop that still carries a proxy header', () => {
    expect(isLocalDirect(fakeRequest({ ip: '203.0.113.9' }))).toBe(false);
    expect(
      isLocalDirect(fakeRequest({ ip: '127.0.0.1', headers: { 'cf-connecting-ip': '203.0.113.9' } })),
    ).toBe(false);
    expect(
      isLocalDirect(fakeRequest({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.9' } })),
    ).toBe(false);
    expect(isLocalDirect(fakeRequest({ ip: '127.0.0.1', headers: { 'x-real-ip': '203.0.113.9' } }))).toBe(false);
  });
});

describe('checkBrowserRequest', () => {
  it('refuses a local-direct request whose Host is not this PC', () => {
    expect(() =>
      checkBrowserRequest(fakeRequest({ headers: { host: 'evil.example:8765' } })),
    ).toThrow(HttpError);
    checkBrowserRequest(fakeRequest({ headers: { host: '127.0.0.1:8765' } }));
    checkBrowserRequest(fakeRequest({ headers: { host: 'localhost:8765' } }));
  });

  it('refuses cross-site state-changing requests that name another origin', () => {
    const host = { host: '127.0.0.1:8765' };
    expect(() =>
      checkBrowserRequest(fakeRequest({ method: 'POST', headers: { ...host, origin: 'https://evil.example' } })),
    ).toThrow(HttpError);
    expect(() =>
      checkBrowserRequest(fakeRequest({ method: 'POST', headers: { ...host, origin: 'null' } })),
    ).toThrow(HttpError);
    expect(() =>
      checkBrowserRequest(fakeRequest({ method: 'POST', headers: { ...host, 'sec-fetch-site': 'cross-site' } })),
    ).toThrow(HttpError);
    checkBrowserRequest(
      fakeRequest({
        method: 'POST',
        headers: { ...host, origin: 'http://127.0.0.1:8765', 'sec-fetch-site': 'same-origin' },
      }),
    );
    checkBrowserRequest(fakeRequest({ method: 'POST', headers: host }));
  });
});

describe('requireToken / requireAdmin', () => {
  it('denies a missing or malformed bearer header', () => {
    const store = { tokenValid: () => true };
    expect(() => requireToken(fakeRequest({ store }))).toThrow(HttpError);
    expect(() => requireToken(fakeRequest({ store, headers: { authorization: 'Bearer' } }))).toThrow(HttpError);
    expect(() => requireToken(fakeRequest({ store, headers: { authorization: 'Token abc' } }))).toThrow(
      HttpError,
    );
    try {
      requireToken(fakeRequest({ store }));
    } catch (error) {
      expect(error.statusCode).toBe(401);
      expect(error.error).toBe('unauthorized');
      expect(error.message).toBe('missing bearer token');
    }
  });

  it('denies an unknown token after asking the store', () => {
    const store = { tokenValid: () => false };
    try {
      requireToken(fakeRequest({ store, headers: { authorization: 'Bearer not-a-real-token' } }));
    } catch (error) {
      expect(error.statusCode).toBe(401);
      expect(error.message).toBe('invalid bearer token');
    }
  });

  it('lets a local-direct caller into the admin without Basic', () => {
    const config = { admin_password: 'test-admin-pass1' };
    expect(requireAdmin(fakeRequest({ config, headers: { host: '127.0.0.1:80' } }))).toBe('admin');
  });

  it('refuses a proxied caller when admin_remote is off, before Basic', () => {
    const config = { admin_password: 'test-admin-pass1', admin_remote: false };
    const proxied = {
      config,
      ip: '127.0.0.1',
      headers: { host: 'r1cord.example.test', 'cf-connecting-ip': '203.0.113.9' },
    };
    try {
      requireAdmin(fakeRequest(proxied));
      throw new Error('expected 403');
    } catch (error) {
      expect(error.statusCode).toBe(403);
      expect(error.error).toBe('forbidden');
      expect(error.html).toMatch(/only available on this PC/i);
    }
    const encoded = Buffer.from('admin:test-admin-pass1').toString('base64');
    try {
      requireAdmin(fakeRequest({ ...proxied, headers: { ...proxied.headers, authorization: `Basic ${encoded}` } }));
      throw new Error('expected 403');
    } catch (error) {
      expect(error.statusCode).toBe(403);
    }
  });

  it('challenges a proxied caller until Basic admin/password matches when admin_remote is on', () => {
    const config = { admin_password: 'test-admin-pass1', admin_remote: true };
    const proxied = {
      config,
      ip: '127.0.0.1',
      headers: { host: 'r1cord.example.test', 'cf-connecting-ip': '203.0.113.9' },
    };
    try {
      requireAdmin(fakeRequest(proxied));
      throw new Error('expected challenge');
    } catch (error) {
      expect(error.statusCode).toBe(401);
      expect(error.headers['WWW-Authenticate']).toBe('Basic realm="r1cord-admin"');
    }
    const encoded = Buffer.from('admin:test-admin-pass1').toString('base64');
    expect(
      requireAdmin(fakeRequest({ ...proxied, headers: { ...proxied.headers, authorization: `Basic ${encoded}` } })),
    ).toBe('admin');
    const wrong = Buffer.from('admin:wrong').toString('base64');
    expect(() =>
      requireAdmin(fakeRequest({ ...proxied, headers: { ...proxied.headers, authorization: `Basic ${wrong}` } })),
    ).toThrow(HttpError);
  });
});

describe('admin over HTTP', () => {
  const basic = `Basic ${Buffer.from('admin:test-admin-pass1').toString('base64')}`;

  it('is open on loopback and answers 403 through a proxy header while admin_remote is off', async () => {
    const app = await openApp(cfg(tmpPath()));
    const open = await app.inject({ method: 'GET', url: '/admin', remoteAddress: '127.0.0.1' });
    expect(open.statusCode).toBe(200);

    const tunnel = await app.inject({
      method: 'GET',
      url: '/admin',
      remoteAddress: '127.0.0.1',
      headers: { 'cf-connecting-ip': '203.0.113.9' },
    });
    expect(tunnel.statusCode).toBe(403);
    expect(String(tunnel.headers['content-type'] || '')).toMatch(/text\/html/);
    expect(tunnel.body).toMatch(/only available on this PC/i);
    expect(tunnel.headers['www-authenticate']).toBeUndefined();

    const json = await app.inject({
      method: 'GET',
      url: '/admin/api/status',
      remoteAddress: '127.0.0.1',
      headers: { 'cf-connecting-ip': '203.0.113.9' },
    });
    expect(json.statusCode).toBe(403);
    expect(json.json()).toEqual({ error: 'forbidden', message: 'the admin is only available on this PC' });
  });

  it('needs Basic through a proxy header once admin_remote is on, and /v1 stays open', async () => {
    const config = withUpdates(cfg(tmpPath()), { admin_remote: true });
    const app = await openApp(config);
    const tunnel = await app.inject({
      method: 'GET',
      url: '/admin',
      remoteAddress: '127.0.0.1',
      headers: { 'cf-connecting-ip': '203.0.113.9' },
    });
    expect(tunnel.statusCode).toBe(401);
    expect(tunnel.headers['www-authenticate']).toBe('Basic realm="r1cord-admin"');

    const ok = await app.inject({
      method: 'GET',
      url: '/admin',
      remoteAddress: '127.0.0.1',
      headers: { 'cf-connecting-ip': '203.0.113.9', authorization: basic },
    });
    expect(ok.statusCode).toBe(200);

    const v1 = await app.inject({
      method: 'GET',
      url: '/v1/recordings',
      remoteAddress: '127.0.0.1',
      headers: { 'cf-connecting-ip': '203.0.113.9' },
    });
    expect(v1.statusCode).toBe(401);
    expect(v1.json().error).toBe('unauthorized');
  });

  it('applies the Settings switch immediately', async () => {
    const app = await openApp(cfg(tmpPath()));
    const page = await app.inject({ method: 'GET', url: '/admin/config' });
    expect(page.body).toMatch(/Allow admin through the tunnel/);

    const form = new URLSearchParams({
      server_name: 'R1CORD',
      listen_host: '127.0.0.1',
      listen_port: String(app.state.config.listen_port),
      webdav_folder: String(app.state.config.webdav_folder),
      public_url_base: app.state.config.public_url_base,
      theme: app.state.config.theme,
      default_writer: app.state.config.default_writer,
      writer_timeout_s: String(app.state.config.writer_timeout_s),
      asr_model: app.state.config.asr_model,
      asr_device: app.state.config.asr_device,
      asr_quant: app.state.config.asr_quant,
      pair_code_ttl_s: String(app.state.config.pair_code_ttl_s),
      usb_poll_s: String(app.state.config.usb_poll_s),
      usb_auto_action: app.state.config.usb_auto_action,
      usb_device_root: app.state.config.usb_device_root,
      run_mode: app.state.config.run_mode,
      idle_exit_min: String(app.state.config.idle_exit_min),
      admin_remote: 'on',
    });
    const saved = await app.inject({
      method: 'POST',
      url: '/admin/config',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form.toString(),
    });
    expect(saved.statusCode).toBe(200);
    expect(app.state.config.admin_remote).toBe(true);

    const challenge = await app.inject({
      method: 'GET',
      url: '/admin',
      remoteAddress: '127.0.0.1',
      headers: { 'cf-connecting-ip': '203.0.113.9' },
    });
    expect(challenge.statusCode).toBe(401);
    expect(challenge.headers['www-authenticate']).toBe('Basic realm="r1cord-admin"');
  });

  it('needs Basic from a remote socket when admin_remote is on', async () => {
    const app = await openApp(withUpdates(cfg(tmpPath()), { admin_remote: true }));
    const remote = await app.inject({ method: 'GET', url: '/admin', remoteAddress: '203.0.113.9' });
    expect(remote.statusCode).toBe(401);
    const ok = await app.inject({
      method: 'GET',
      url: '/admin',
      remoteAddress: '203.0.113.9',
      headers: { authorization: basic },
    });
    expect(ok.statusCode).toBe(200);
  });
});
