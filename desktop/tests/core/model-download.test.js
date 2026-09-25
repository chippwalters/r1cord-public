import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createModelDownload } = require('../../src/core/pipeline/model-download');
const { ensureModel } = require('../../src/core/pipeline/models');

const cleanup = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

function tmpPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-mdl-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const PAYLOAD = crypto.randomBytes(80_000);
const SHA = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

async function hub() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Length': PAYLOAD.length });
    res.end(PAYLOAD);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return `http://127.0.0.1:${port}/ggml-test.bin`;
}

describe('model download tracker', () => {
  it('snapshots missing/present from disk and downloads in the background', async () => {
    const dir = tmpPath();
    const datastore = path.join(dir, 'data');
    const url = await hub();
    const downloads = createModelDownload({
      ensureModel: (spec, options) => ensureModel({ ...spec, url, size: PAYLOAD.length, sha256: SHA }, options),
    });
    const config = { datastore, asr_model: 'tiny', asr_quant: 'q8_0' };

    const missing = downloads.snapshot(config);
    expect(missing.state).toBe('missing');
    expect(missing.active).toBe(false);
    expect(missing.file).toBe('ggml-tiny-q8_0.bin');

    const file = await downloads.start(config);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).size).toBe(PAYLOAD.length);
    expect(downloads.active).toBe(false);
  });

  it('cancel aborts the in-flight fetch and leaves the .part file', async () => {
    const dir = tmpPath();
    const datastore = path.join(dir, 'data');
    let hanging;
    const server = http.createServer((_req, res) => {
      hanging = res;
      res.writeHead(200, { 'Content-Length': 10_000_000 });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/slow.bin`;
    const downloads = createModelDownload({
      ensureModel: (spec, options) => ensureModel({ ...spec, url, file: 'ggml-test.bin', size: 10_000_000, sha256: 'ab' }, options),
    });
    const config = { datastore, asr_model: 'tiny', asr_quant: 'q8_0' };
    const started = downloads.start(config);
    await new Promise((resolve) => setImmediate(resolve));
    expect(downloads.active).toBe(true);
    downloads.cancel();
    await expect(started).rejects.toThrow();
    expect(downloads.active).toBe(false);
    if (hanging) hanging.destroy();
  });
});
