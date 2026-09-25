// The desktop shell's JSON: GET/POST /admin/api/status and POST /admin/api/shutdown.
// Port of tests/test_desktop_api.py (which drives the Python app in-process).
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { defaultConfig, loadConfig, saveConfig, withUpdates } = require('../../src/core/config');
const { createApp } = require('../../src/core/app');
const { createLogger } = require('../../src/core/log');

const TUNNEL = { 'cf-connecting-ip': '203.0.113.9' };
const BASIC = `Basic ${Buffer.from('admin:test-admin-pass1').toString('base64')}`;

const cleanup = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

async function openEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-status-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = withUpdates(defaultConfig(), {
    datastore: path.join(root, 'ds'),
    webdav_folder: path.join(root, 'wd'),
    public_url_base: 'https://example.test/files',
    admin_password: 'test-admin-pass1',
    server_name: 'R1CORD',
    email_to: 'ops@example.test',
  });
  const configPath = path.join(root, 'config.toml');
  saveConfig(config, configPath);
  const exits = [];
  const app = createApp(config, {
    configPath,
    noWorker: true,
    noUsb: true,
    logger: createLogger(),
    requestExit: () => exits.push(1),
  });
  cleanup.push(() => app.close());
  await app.ready();
  const importRecording = (recordingId, title = 'Site visit') => {
    const folder = path.join(root, 'src', recordingId);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'audio.wav'), '0123456789abcdef');
    fs.writeFileSync(path.join(folder, 'metadata.json'), JSON.stringify({ id: recordingId, title, createdAt: 1_758_400_000_000 }));
    return app.state.store.importFolder(folder, { title, reviews: ['summary'], publish: false });
  };
  return { app, store: app.state.store, exits, configPath, importRecording };
}

describe('GET /admin/api/status', () => {
  it('is open on loopback, answers JSON 403 through a tunnel while admin_remote is off, and refuses a rebinding host', async () => {
    const { app } = await openEnv();
    expect((await app.inject({ url: '/admin/api/status' })).statusCode).toBe(200);
    const blocked = await app.inject({ url: '/admin/api/status', headers: TUNNEL });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toEqual({ error: 'forbidden', message: 'the admin is only available on this PC' });
    const rebound = await app.inject({ url: '/admin/api/status', headers: { host: 'evil.example:8765' } });
    expect(rebound.statusCode).toBe(403);
    expect(rebound.json().error).toBe('forbidden');
  });

  it('challenges a tunnel with Basic once admin_remote is on', async () => {
    const { app } = await openEnv();
    app.state.config = { ...app.state.config, admin_remote: true };
    const blocked = await app.inject({ url: '/admin/api/status', headers: TUNNEL });
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json().error).toBe('unauthorized');
    expect((await app.inject({ url: '/admin/api/status', headers: { ...TUNNEL, authorization: BASIC } })).statusCode).toBe(200);
  });

  it('reports the version, idle lines, folders and an empty first cursor', async () => {
    const env = await openEnv();
    const rec = env.importRecording('rec-idle');
    env.store.setStatus(rec.jobId, 'complete');
    const body = (await env.app.inject({ url: '/admin/api/status' })).json();
    expect(body.version).toBeTruthy();
    expect(body.version).not.toBe('unknown');
    expect(body.device_line).toBe('No device connected');
    expect(body.work_line).toBe('Idle');
    expect(body.running).toBeNull();
    expect(body.queued).toBe(0);
    expect(body.finished).toEqual([]);
    expect(Object.keys(body.cursor)).toContain(rec.jobId);
    expect(body.usb_enabled).toBe(true);
    expect(body.email_enabled).toBe(false);
    expect(body.email_to).toBe('ops@example.test');
    expect(body.recordings_folder).toBe(path.join(env.app.state.config.datastore, 'inbox'));
    expect(body.logs_folder).toBe(path.join(env.app.state.config.datastore, 'logs'));
    expect(body.listen_port).toBe(8765);
    expect(body.listen_host).toBe('127.0.0.1');
    expect(body.window_open).toBe(false);
    env.app.state.windowOpen = true;
    expect((await env.app.inject({ url: '/admin/api/status' })).json().window_open).toBe(true);
  });

  it('names the running job and counts the queue', async () => {
    const env = await openEnv();
    const running = env.importRecording('rec-run', 'Kickoff');
    const queued = env.importRecording('rec-q', 'Follow up');
    env.store.setStatus(running.jobId, 'transcribing');
    const body = (await env.app.inject({ url: '/admin/api/status' })).json();
    expect(body.work_line).toBe('Transcribing: Kickoff (+1 queued)');
    expect(body.queued).toBe(1);
    expect(body.running).toEqual({ job_id: running.jobId, recording_id: 'rec-run', status: 'transcribing', title: 'Kickoff' });
    expect(Object.keys(body.cursor)).toContain(queued.jobId);
  });

  it('lists adopted serials in order and follows USB mode in the device line', async () => {
    const env = await openEnv();
    expect((await env.app.inject({ url: '/admin/api/status' })).json().adopted_serials).toEqual([]);
    env.store.adoptDevice('S2');
    env.store.adoptDevice('S1');
    expect((await env.app.inject({ url: '/admin/api/status' })).json().adopted_serials).toEqual(['S1', 'S2']);

    env.app.state.config = withUpdates(env.app.state.config, { usb_enabled: false });
    expect((await env.app.inject({ url: '/admin/api/status' })).json().device_line).toBe('USB mode off');
    env.app.state.config = withUpdates(env.app.state.config, { usb_enabled: true });
    env.app.state.usb._connected = [['S1', 'Rabbit_R1', true]];
    expect((await env.app.inject({ url: '/admin/api/status' })).json().device_line).toBe('Rabbit R1 connected');
  });

  it('announces a job that finished since the cursor, once', async () => {
    const env = await openEnv();
    const rec = env.importRecording('rec-done');
    env.store.setStatus(rec.jobId, 'writing');
    const first = (await env.app.inject({ url: '/admin/api/status' })).json();
    expect(first.finished).toEqual([]);
    env.store.setStatus(rec.jobId, 'complete');
    const cursorUrl = (cursor) => `/admin/api/status?cursor=${encodeURIComponent(JSON.stringify(cursor))}`;
    const second = (await env.app.inject({ url: cursorUrl(first.cursor) })).json();
    expect(second.finished).toEqual([{ title: 'Summary ready', message: 'Site visit' }]);
    const third = (await env.app.inject({ url: cursorUrl(second.cursor) })).json();
    expect(third.finished).toEqual([]);
  });

  it('rejects a malformed cursor', async () => {
    const { app } = await openEnv();
    for (const cursor of ['not-json', '[1]', '{"a": 1}']) {
      const r = await app.inject({ url: `/admin/api/status?cursor=${encodeURIComponent(cursor)}` });
      expect(r.statusCode).toBe(422);
      expect(r.json().error).toBe('invalid_request');
    }
  });
});

describe('POST /admin/api/status', () => {
  it('flips USB mode or email, saves it, and refuses anything else', async () => {
    const env = await openEnv();
    const post = (payload, headers = {}) =>
      env.app.inject({ method: 'POST', url: '/admin/api/status', headers: { 'content-type': 'application/json', ...headers }, payload });
    const usb = await post({ toggle: 'usb' });
    expect(usb.statusCode).toBe(200);
    expect(usb.json().usb_enabled).toBe(false);
    const email = await post({ toggle: 'email' });
    expect(email.json().email_enabled).toBe(true);
    expect(loadConfig(env.configPath).email_enabled).toBe(true);
    for (const payload of [{ toggle: 'nope' }, '{broken']) {
      const bad = await post(payload);
      expect(bad.statusCode).toBe(422);
      expect(bad.json().error).toBe('invalid_request');
    }
  });

  it('refuses a cross-site post before reading it', async () => {
    const env = await openEnv();
    const r = await env.app.inject({
      method: 'POST',
      url: '/admin/api/status',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      payload: '{broken',
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('forbidden');
    expect(env.app.state.config.usb_enabled).toBe(true);
  });
});

describe('POST /admin/api/shutdown', () => {
  it('exits only for a local-direct caller', async () => {
    const env = await openEnv();
    const r = await env.app.inject({ method: 'POST', url: '/admin/api/shutdown' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(env.exits).toEqual([1]);

    env.exits.length = 0;
    env.app.state.config = { ...env.app.state.config, admin_remote: true };
    const tunnel = await env.app.inject({ method: 'POST', url: '/admin/api/shutdown', headers: { ...TUNNEL, authorization: BASIC } });
    expect(tunnel.statusCode).toBe(403);
    expect(tunnel.json().error).toBe('forbidden');
    const crossSite = await env.app.inject({ method: 'POST', url: '/admin/api/shutdown', headers: { origin: 'https://evil.example' } });
    expect(crossSite.statusCode).toBe(403);
    expect(env.exits).toEqual([]);
  });
});
