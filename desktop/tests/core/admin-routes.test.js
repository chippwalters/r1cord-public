// Admin routes that need the app's own objects: a fake USB watcher, the live config, a stubbed
// gws run, the Explorer launch. Ports of the `inprocess` cases of tests/test_admin.py and
// tests/test_api.py; everything else there runs black-box against the Node core.
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { defaultConfig, loadConfig, saveConfig, withUpdates } = require('../../src/core/config');
const { createApp } = require('../../src/core/app');
const { createLogger } = require('../../src/core/log');
const mailer = require('../../src/core/mailer');
const desktop = require('../../src/core/desktop');

const TUNNEL = { 'cf-connecting-ip': '203.0.113.9' };
const BASIC = `Basic ${Buffer.from('admin:test-admin-pass1').toString('base64')}`;

const cleanup = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-admin-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

class FakeUsb {
  constructor() {
    this.connected = [];
    this.polls = 0;
    this.adb = 'fake-adb';
  }

  status() {
    return { enabled: true, adb: this.adb, connected: [...this.connected], syncing: null, last_error: null };
  }

  pollNow() {
    this.polls += 1;
  }

  async stop() {}
}

async function openEnv(overrides = {}, options = {}) {
  const root = tmpDir();
  const config = withUpdates(defaultConfig(), {
    datastore: path.join(root, 'datastore'),
    webdav_folder: path.join(root, 'publish'),
    public_url_base: 'https://example.test/files',
    admin_password: 'test-admin-pass1',
    server_name: 'R1CORD',
    listen_port: 8765,
    ...overrides,
  });
  const configPath = path.join(root, 'config.toml');
  saveConfig(config, configPath);
  const lines = [];
  const app = createApp(config, {
    configPath,
    noWorker: true,
    noUsb: true,
    logger: createLogger({ sink: (line) => lines.push(line) }),
    ...options,
  });
  cleanup.push(() => app.close());
  await app.ready();
  const usb = new FakeUsb();
  app.state.usb = usb;
  const request = (method, url, { form = null, headers = {} } = {}) =>
    app.inject({
      method,
      url,
      headers: form ? { 'content-type': 'application/x-www-form-urlencoded', ...headers } : headers,
      payload: form ? new URLSearchParams(form).toString() : undefined,
    });
  return { app, root, configPath, usb, lines, request };
}

function importRecording(env, recordingId, title = 'Site visit') {
  const folder = path.join(env.root, 'src', recordingId);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'audio.wav'), '0123456789abcdef');
  fs.writeFileSync(
    path.join(folder, 'metadata.json'),
    JSON.stringify({ id: recordingId, title, createdAt: 1_758_400_000_000 }),
  );
  return env.app.state.store.importFolder(folder, { title, reviews: ['summary'], publish: false });
}

function settingsForm(env, extra = {}) {
  return {
    server_name: 'R1CORD',
    listen_host: '127.0.0.1',
    listen_port: String(env.app.state.config.listen_port),
    webdav_folder: 'Z:/publish',
    public_url_base: 'https://example.test/files/',
    theme: 'Toolmaker-Noir',
    default_writer: 'codex',
    writer_timeout_s: '111',
    asr_language: 'de',
    usb_auto_action: 'publish',
    usb_device_root: '/sdcard/Download/R1CORD/',
    run_mode: 'always',
    email_to: 'me@example.test',
    ...extra,
  };
}

describe('email a job from the admin', () => {
  it('sends through gws, logs the message id, and on failure shows the reason and warns once', async () => {
    const sent = [];
    let reply = { returncode: 0, stdout: '{"id": "stub-id"}', stderr: '' };
    const run = async (argv) => {
      sent.push(argv);
      return reply;
    };
    const root = tmpDir();
    const gws = path.join(root, 'gws.exe');
    fs.writeFileSync(gws, '');
    const env = await openEnv(
      { email_to: 'me@example.test', gws_cmd: gws },
      { mailer: { ...mailer, emailJob: (store, config, jobId) => mailer.emailJob(store, config, jobId, { run }) } },
    );
    const rec = importRecording(env, 'rec-mail-1');
    fs.writeFileSync(path.join(env.app.state.store.outboxDir('rec-mail-1'), 'summary.md'), '# Done');

    const ok = await env.request('POST', `/admin/jobs/${rec.jobId}/email`);
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe(`/admin/jobs/${rec.jobId}?sent=me%40example.test`);
    const rawMessage = JSON.parse(sent[0][sent[0].indexOf('--json') + 1]).raw;
    expect(Buffer.from(rawMessage, 'base64url').toString('utf8')).toMatch(/^Subject: Site visit\r?$/m);
    expect(env.app.state.store.readLog(rec.jobId).some((line) => line.includes('email: sent to me@example.test (stub-id)'))).toBe(true);

    reply = { returncode: 1, stdout: '{"error": {"message": "Insufficient Permission"}}', stderr: '' };
    const failed = await env.request('POST', `/admin/jobs/${rec.jobId}/email`);
    expect(failed.statusCode).toBe(303);
    expect(failed.headers.location).toContain('notice=');
    const page = await env.request('GET', failed.headers.location);
    expect(page.body).toContain('Email: gws: Insufficient Permission');
    const warnings = env.lines.filter((line) => / WARNING /.test(line) && line.includes(rec.jobId));
    expect(warnings).toHaveLength(1);
  });
});

describe('devices and USB mode with a connected R1', () => {
  it('offers a connected device, and adopting it polls the watcher', async () => {
    const env = await openEnv();
    env.usb.connected = [['SERIAL1', 'Rabbit_R1', false]];

    const page = (await env.request('GET', '/admin/devices')).body;
    expect(page).toContain('SERIAL1');
    expect(page).toContain('Rabbit_R1');
    expect(page).toContain('action="/admin/devices/SERIAL1/adopt"');
    expect(page).toContain('Nothing is pulled from a device until it is adopted.');

    expect((await env.request('POST', '/admin/devices/SERIAL1/adopt')).statusCode).toBe(303);
    expect(env.usb.polls).toBe(1);
    const store = env.app.state.store;
    expect(store.devices().find((d) => d.serial === 'SERIAL1').adopted).toBe(true);
    expect((await env.request('GET', '/admin/devices')).body).toContain('action="/admin/devices/SERIAL1/forget"');

    expect((await env.request('POST', '/admin/devices/SERIAL1/forget')).statusCode).toBe(303);
    expect(store.devices().find((d) => d.serial === 'SERIAL1').adopted).toBe(false);
  });

  it('the USB toggle switches the live config and polls', async () => {
    const env = await openEnv();
    expect((await env.request('POST', '/admin/usb/toggle')).statusCode).toBe(303);
    expect(env.app.state.config.usb_enabled).toBe(false);
    expect(env.usb.polls).toBe(1);
    await env.request('POST', '/admin/usb/toggle');
    expect(env.app.state.config.usb_enabled).toBe(true);
    expect(loadConfig(env.configPath).usb_enabled).toBe(true);
  });

  it('Check now wakes the watcher', async () => {
    const env = await openEnv();
    await env.request('POST', '/admin/usb/poll');
    expect(env.usb.polls).toBe(1);
  });
});

describe('Settings', () => {
  it('a save swaps the live config into the app, the store and the worker', async () => {
    const env = await openEnv();
    const modes = [];
    env.app.state.host = { runModeChanged: (mode) => modes.push(mode) };
    const form = new URLSearchParams(settingsForm(env));
    form.append('default_reviews', '');
    form.append('default_reviews', 'organized');
    form.append('default_reviews', 'outline');
    const saved = await env.app.inject({
      method: 'POST',
      url: '/admin/config',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form.toString(),
    });
    expect(saved.body).toContain('Saved to config.toml.');
    const { state } = env.app;
    const cfg = state.config;
    expect(cfg.email_enabled).toBe(false);
    expect(cfg.email_to).toBe('me@example.test');
    expect(cfg.default_writer).toBe('codex');
    expect([...cfg.default_reviews]).toEqual(['outline', 'organized']);
    expect(cfg.public_url_base).toBe('https://example.test/files');
    expect(cfg.usb_device_root).toBe('/sdcard/Download/R1CORD');
    expect(cfg.asr_language).toBe('de');
    expect(cfg.writer_timeout_s).toBe(111);
    expect(state.store.config).toBe(cfg);
    expect(state.worker.config).toBe(cfg);
    expect(cfg.run_mode).toBe('always');
    expect(modes).toEqual(['always']);
    const again = await env.app.inject({
      method: 'POST',
      url: '/admin/config',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form.toString(),
    });
    expect(again.body).toContain('Saved to config.toml.');
    expect(modes).toEqual(['always']);
  });

  it('a malformed number is refused before anything is saved', async () => {
    const env = await openEnv();
    const r = await env.request('POST', '/admin/config', { form: settingsForm(env, { listen_port: 'abc', usb_poll_s: 'x' }) });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toEqual({
      error: 'invalid_request',
      message:
        'listen_port: Input should be a valid integer, unable to parse string as an integer; ' +
        'usb_poll_s: Input should be a valid integer, unable to parse string as an integer',
    });
    expect(loadConfig(env.configPath).default_writer).toBe('claude_code');
  });

  it('saves asr_quant and refuses vulkan as asr_device', async () => {
    const env = await openEnv();
    const page = (await env.request('GET', '/admin/config')).body;
    expect(page).toContain('name="asr_quant"');
    expect(page).toContain('name="asr_device"');
    expect(page).not.toContain('name="asr_engine"');
    expect(page).not.toContain('value="vulkan"');
    expect(page).toContain('Allow admin through the tunnel');

    const saved = await env.request('POST', '/admin/config', {
      form: settingsForm(env, { asr_quant: 'q5_0', asr_device: 'cpu' }),
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).toContain('Saved to config.toml.');
    expect(env.app.state.config.asr_quant).toBe('q5_0');
    expect(env.app.state.config.asr_device).toBe('cpu');
    expect(loadConfig(env.configPath).asr_quant).toBe('q5_0');
    expect(loadConfig(env.configPath)).not.toHaveProperty('asr_engine');

    const refused = await env.request('POST', '/admin/config', {
      form: settingsForm(env, { asr_device: 'vulkan' }),
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe('invalid_request');
    expect(refused.json().message).toMatch(/invalid asr_device: vulkan/);
    expect(env.app.state.config.asr_device).toBe('cpu');
  });
});

describe('System whisper.cpp model', () => {
  it('shows the model state and starts a download', async () => {
    const env = await openEnv({ asr_model: 'tiny', asr_quant: 'q8_0' });
    const page = (await env.request('GET', '/admin/system')).body;
    expect(page).toContain('whisper.cpp model');
    expect(page).toMatch(/missing/i);
    expect(page).toContain('action="/admin/system/model-download"');
    expect(page).toContain('Download model');
    expect(page).toMatch(/whisper\.cpp model missing/);

    const started = [];
    env.app.state.modelDownload.start = (config) => {
      started.push(config.asr_model);
      return Promise.resolve('ok');
    };
    const post = await env.request('POST', '/admin/system/model-download');
    expect(post.statusCode).toBe(303);
    expect(post.headers.location).toBe('/admin/system');
    expect(started).toEqual(['tiny']);
  });

  it('names the last backend from result.json', async () => {
    const env = await openEnv({ asr_model: 'tiny', asr_quant: 'q8_0' });
    const rec = importRecording(env, 'rec-backend-1');
    env.app.state.store.setStatus(rec.jobId, 'complete', {
      asr: { model: 'tiny', device: 'vulkan', language: 'en', durationMs: 1000 },
    });
    const page = (await env.request('GET', '/admin/system')).body;
    expect(page).toMatch(/last backend vulkan/);
  });
});

describe('Devices platform tools download', () => {
  const ACTION = 'action="/admin/devices/platform-tools"';

  it('offers the download only while adb is missing, and starts it for the local user', async () => {
    const env = await openEnv();
    expect((await env.request('GET', '/admin/devices')).body).not.toContain(ACTION);

    env.usb.adb = 'not found';
    const page = (await env.request('GET', '/admin/devices')).body;
    expect(page).toContain(ACTION);
    expect(page).toContain('https://developer.android.com/studio/releases/platform-tools');

    const started = [];
    env.app.state.platformTools.start = (configDir, { onInstalled }) => {
      started.push(configDir);
      onInstalled(path.join(configDir, 'platform-tools', 'adb.exe'));
      return Promise.resolve('ok');
    };
    const post = await env.request('POST', '/admin/devices/platform-tools');
    expect(post.statusCode).toBe(303);
    expect(post.headers.location).toBe('/admin/devices');
    expect(started).toEqual([path.dirname(env.configPath)]);
    expect(env.usb.polls).toBe(1);
  });

  it('refuses a remote admin: no button, and the POST is 403 without starting anything', async () => {
    const env = await openEnv({ admin_remote: true });
    env.usb.adb = 'not found';
    const started = [];
    env.app.state.platformTools.start = (configDir) => {
      started.push(configDir);
      return Promise.resolve('ok');
    };
    const remote = { headers: { ...TUNNEL, authorization: BASIC } };

    const page = await env.request('GET', '/admin/devices', remote);
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain(ACTION);

    const post = await env.request('POST', '/admin/devices/platform-tools', remote);
    expect(post.statusCode).toBe(403);
    expect(started).toEqual([]);
  });
});

describe('Show in folder', () => {
  it('opens Explorer on this PC only, never for a tunnel caller', async () => {
    const env = await openEnv();
    importRecording(env, 'rec-audio-1');
    const launched = [];
    desktop.setHostReveal((file) => launched.push(file));
    cleanup.push(() => desktop.setHostReveal(null));
    const audio = path.join(env.app.state.config.datastore, 'inbox', 'rec-audio-1', 'audio.wav');

    const local = await env.request('POST', '/admin/recordings/rec-audio-1/folder');
    expect(local.statusCode).toBe(303);
    expect(local.headers.location).toBe('/admin#recordings');
    expect(launched.map((file) => fs.realpathSync(file))).toEqual([fs.realpathSync(audio)]);

    const tunnel = await env.request('POST', '/admin/recordings/rec-audio-1/folder', {
      headers: { ...TUNNEL, authorization: BASIC },
    });
    expect(tunnel.statusCode).toBe(403);
    expect(launched).toHaveLength(1);
  });
});
