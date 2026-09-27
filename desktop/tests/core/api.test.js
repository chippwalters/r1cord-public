// In-process /v1 behaviour: 500 path, error shape, pairing, Cache-Control.
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { defaultConfig, withUpdates } = require('../../src/core/config');
const { createApp } = require('../../src/core/app');
const { NONCE_TTL_MS, createNonce, markSeen, consumeSeen } = require('../../src/core/setup-nonce');
const { createLogger } = require('../../src/core/log');

const AUDIO = Buffer.from('0123456789');
const AUDIO_SHA = crypto.createHash('sha256').update(AUDIO).digest('hex');
const CREATED_AT = 1_758_400_000_000;

const cleanup = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

function tmpPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-api-'));
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

async function openApp(config, extra = {}) {
  const app = createApp(config, { noWorker: true, noUsb: true, ...extra });
  cleanup.push(() => app.close());
  await app.ready();
  return app;
}

function jobBody(recordingId) {
  return {
    job: {
      schemaVersion: 1,
      recordingId,
      createdAt: CREATED_AT,
      title: 'Site visit',
      reviews: ['summary'],
      summarize: true,
      publish: true,
      files: [{ name: 'audio.m4a', size: AUDIO.length, sha256: AUDIO_SHA }],
    },
    metadata: { id: recordingId, title: 'Site visit', createdAt: CREATED_AT },
  };
}

function auth(token) {
  return { authorization: `Bearer ${token}` };
}

async function pair(app) {
  const page = await app.inject({ method: 'POST', url: '/admin/pair', remoteAddress: '127.0.0.1' });
  expect(page.statusCode).toBe(200);
  const match = String(page.body).match(/class="code">(\d{6})</);
  expect(match).toBeTruthy();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/pair',
    headers: { 'content-type': 'application/json' },
    payload: { code: match[1] },
  });
  expect(res.statusCode).toBe(200);
  return res.json().token;
}

describe('/v1', () => {
  it('answers 401 without a bearer token and never stores the header', async () => {
    const app = await openApp(cfg(tmpPath()));
    const res = await app.inject({ method: 'GET', url: '/v1/recordings' });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error).toBe('unauthorized');
    expect(body.message).toBeTruthy();
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('rejects an invalid pairing code and a reused code', async () => {
    const app = await openApp(cfg(tmpPath()));
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/pair',
      headers: { 'content-type': 'application/json' },
      payload: { code: '000000' },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe('invalid_code');

    const page = await app.inject({ method: 'POST', url: '/admin/pair', remoteAddress: '127.0.0.1' });
    const code = String(page.body).match(/class="code">(\d{6})</)[1];
    const first = await app.inject({
      method: 'POST',
      url: '/v1/pair',
      headers: { 'content-type': 'application/json' },
      payload: { code },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/v1/pair',
      headers: { 'content-type': 'application/json' },
      payload: { code },
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe('invalid_code');
  });

  it('returns invalid_request JSON for a missing job body', async () => {
    const app = await openApp(cfg(tmpPath()));
    const token = await pair(app);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { ...auth(token), 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe('invalid_request');
    expect(body.message).toBeTruthy();
    expect(body.detail).toBeUndefined();
  });

  it('unknown routes stay JSON and every response carries Cache-Control: no-store', async () => {
    const app = await openApp(cfg(tmpPath()));
    const noRoute = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(noRoute.statusCode).toBe(404);
    expect(noRoute.json().error).toBe('not_found');
    expect(noRoute.headers['cache-control']).toBe('no-store');

    const wrong = await app.inject({ method: 'DELETE', url: '/v1/recordings' });
    expect(wrong.statusCode).toBe(405);
    expect(wrong.json().error).toBe('http_error');
    expect(wrong.headers['cache-control']).toBe('no-store');
  });

  it('answers JSON 500 and logs once when commit throws', async () => {
    const dir = tmpPath();
    const config = cfg(dir);
    const lines = [];
    const logger = createLogger({
      logFile: path.join(config.datastore, 'logs', 'server.log'),
      sink: (line) => lines.push(line),
    });
    const app = await openApp(config, { logger });
    const token = await pair(app);
    const created = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { ...auth(token), 'content-type': 'application/json' },
      payload: jobBody('rec-boom'),
    });
    expect(created.statusCode).toBe(202);
    const jobId = created.json().jobId;
    const put = await app.inject({
      method: 'PUT',
      url: `/v1/jobs/${jobId}/files/audio.m4a?offset=0`,
      headers: { ...auth(token), 'content-type': 'application/octet-stream' },
      payload: AUDIO,
    });
    expect(put.statusCode).toBe(200);

    app.state.store.commit = () => {
      throw new Error('disk exploded');
    };

    const before = lines.length;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/commit`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error).toBe('internal_error');
    expect(body.message).toBeTruthy();

    const hits = lines.slice(before).filter((line) => line.includes('internal_error'));
    expect(hits.length).toBe(1);
    expect(hits[0]).toMatch(/POST \/v1\/jobs/);
    expect(hits[0]).toMatch(/\/commit/);
    expect(hits[0]).toMatch(/500/);
    expect(hits[0]).toMatch(/Error: disk exploded/);
    expect(hits.join('\n')).not.toContain(token);
  });

  it('wakes the worker after a successful commit, retry-writer and retry-publish', async () => {
    const app = await openApp(cfg(tmpPath()));
    const wakes = [];
    app.state.worker.wake = () => wakes.push('wake');
    const token = await pair(app);
    const created = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { ...auth(token), 'content-type': 'application/json' },
      payload: jobBody('rec-wake'),
    });
    expect(created.statusCode).toBe(202);
    const jobId = created.json().jobId;
    const put = await app.inject({
      method: 'PUT',
      url: `/v1/jobs/${jobId}/files/audio.m4a?offset=0`,
      headers: { ...auth(token), 'content-type': 'application/octet-stream' },
      payload: AUDIO,
    });
    expect(put.statusCode).toBe(200);
    const committed = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/commit`,
      headers: auth(token),
    });
    expect(committed.statusCode).toBe(200);
    expect(wakes).toEqual(['wake']);

    const rec = app.state.store.job(jobId);
    fs.mkdirSync(app.state.store.outboxDir(rec.recordingId), { recursive: true });
    fs.writeFileSync(path.join(app.state.store.outboxDir(rec.recordingId), 'transcript.txt'), 'hi');
    app.state.store.setStatus(jobId, 'complete');

    const writer = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/retry-writer`,
      headers: { ...auth(token), 'content-type': 'application/json' },
      payload: { writer: 'codex', reviews: ['summary'] },
    });
    expect(writer.statusCode).toBe(200);
    expect(wakes).toEqual(['wake', 'wake']);

    app.state.store.setStatus(jobId, 'complete');
    const published = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/retry-publish`,
      headers: auth(token),
    });
    expect(published.statusCode).toBe(200);
    expect(wakes).toEqual(['wake', 'wake', 'wake']);
  });

  it('commit does not throw when there is no worker', async () => {
    const app = await openApp(cfg(tmpPath()));
    app.state.worker = null;
    const token = await pair(app);
    const created = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { ...auth(token), 'content-type': 'application/json' },
      payload: jobBody('rec-noworker'),
    });
    const jobId = created.json().jobId;
    await app.inject({
      method: 'PUT',
      url: `/v1/jobs/${jobId}/files/audio.m4a?offset=0`,
      headers: { ...auth(token), 'content-type': 'application/octet-stream' },
      payload: AUDIO,
    });
    const committed = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/commit`,
      headers: auth(token),
    });
    expect(committed.statusCode).toBe(200);
  });
});

function postPair(app, code) {
  return app.inject({
    method: 'POST',
    url: '/v1/pair',
    headers: { 'content-type': 'application/json' },
    payload: { code },
  });
}

async function adminPairCode(app) {
  const page = await app.inject({ method: 'POST', url: '/admin/pair', remoteAddress: '127.0.0.1' });
  expect(page.statusCode).toBe(200);
  return String(page.body).match(/class="code">(\d{6})</)[1];
}

function wrongCode(good, index) {
  const code = String(index).padStart(6, '9');
  return code === good ? '888888' : code;
}

describe('/v1/pair brute-force lock', () => {
  it('still pairs with the right code after four wrong ones', async () => {
    const app = await openApp(cfg(tmpPath()));
    const good = await adminPairCode(app);
    for (let i = 0; i < 4; i += 1) expect((await postPair(app, wrongCode(good, i))).statusCode).toBe(400);
    const res = await postPair(app, good);
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('answers 429 to every pair request after five wrong codes until a new code is created', async () => {
    const app = await openApp(cfg(tmpPath()));
    const good = await adminPairCode(app);
    for (let i = 0; i < 5; i += 1) {
      const res = await postPair(app, wrongCode(good, i));
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_code');
    }

    const locked = await postPair(app, good);
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error).toBe('pairing_locked');
    const malformed = await app.inject({
      method: 'POST',
      url: '/v1/pair',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(malformed.statusCode).toBe(429);

    const fresh = await adminPairCode(app);
    const paired = await postPair(app, fresh);
    expect(paired.statusCode).toBe(200);
    // The code that was valid during the lock was never consumed by the refused attempt.
    expect((await postPair(app, good)).statusCode).toBe(200);
  });
});

describe('/v1/setup/nonce', () => {
  it('needs the bearer token, answers 204 once and records the presenting peer', async () => {
    const app = await openApp(cfg(tmpPath()));
    const token = app.state.store.issueDeviceToken('usb:TESTSERIAL');
    const nonce = createNonce(app.state);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    const url = `/v1/setup/nonce/${nonce}`;

    const anonymous = await app.inject({ method: 'GET', url, headers: { 'x-forwarded-for': '100.64.0.9' } });
    expect(anonymous.statusCode).toBe(401);
    expect(consumeSeen(app.state, nonce)).toBeNull(); // an unauthenticated request records nothing

    const seen = await app.inject({ method: 'GET', url, headers: { ...auth(token), 'x-forwarded-for': '100.64.0.7' } });
    expect(seen.statusCode).toBe(204);
    expect(seen.body).toBe('');

    const again = await app.inject({ method: 'GET', url, headers: { ...auth(token), 'x-forwarded-for': '100.64.0.8' } });
    expect(again.statusCode).toBe(404);
    expect(again.json().error).toBe('not_found');

    expect(consumeSeen(app.state, nonce)).toEqual({ forwardedFor: '100.64.0.7', remote: '127.0.0.1' });
    expect(consumeSeen(app.state, nonce)).toBeNull(); // one use
  });

  it('records a null forwardedFor for a direct request and 404s unknown or malformed nonces', async () => {
    const app = await openApp(cfg(tmpPath()));
    const token = app.state.store.issueDeviceToken('usb:TESTSERIAL');
    const nonce = createNonce(app.state);
    expect((await app.inject({ method: 'GET', url: `/v1/setup/nonce/${nonce}`, headers: auth(token) })).statusCode).toBe(204);
    expect(consumeSeen(app.state, nonce)).toEqual({ forwardedFor: null, remote: '127.0.0.1' });

    for (const bad of ['0'.repeat(32), nonce.toUpperCase(), 'not-a-nonce']) {
      const res = await app.inject({ method: 'GET', url: `/v1/setup/nonce/${bad}`, headers: auth(token) });
      expect(res.statusCode).toBe(404);
    }
  });

  it('expires nonces five minutes after creation, seen or not', () => {
    const state = {};
    const unseen = createNonce(state, 1_000);
    expect(markSeen(state, unseen, { forwardedFor: null, remote: '127.0.0.1' }, 1_000 + NONCE_TTL_MS)).toBe(false);
    expect(consumeSeen(state, unseen, 1_000 + NONCE_TTL_MS)).toBeNull();

    const seen = createNonce(state, 1_000);
    expect(markSeen(state, seen, { forwardedFor: null, remote: '127.0.0.1' }, 1_000 + NONCE_TTL_MS - 1)).toBe(true);
    expect(consumeSeen(state, seen, 1_000 + NONCE_TTL_MS)).toBeNull();
  });
});
