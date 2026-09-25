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
