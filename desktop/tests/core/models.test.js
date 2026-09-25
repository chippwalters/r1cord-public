// The whisper.cpp model manager: config model names -> ggml files, and a download that resumes, follows
// the Hugging Face redirect, verifies sha256 and never leaves an unverified file under the final name.
// A local HTTP server stands in for Hugging Face.
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ensureModel, isModelPresent, modelStatus, modelsDir, resolveModel } = require('../../src/core/pipeline/models');

const cleanup = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

function tmpPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-models-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const PAYLOAD = crypto.randomBytes(300_000);
const SHA = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

// Like Hugging Face: /resolve/... answers 302 to the CDN, the CDN serves Range requests.
// `mode`: 'range' (206 for a Range request), 'ignore-range' (always 200 with the whole file),
// 'truncate' (sends the first `cut` bytes, then drops the connection).
async function hub({ mode = 'range', cut = 0 } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/resolve/')) {
      seen.push({ url: req.url, range: req.headers.range || null, sent: 0 });
      res.writeHead(302, { Location: '/cdn/ggml-test.bin' });
      res.end();
      return;
    }
    const record = { url: req.url, range: req.headers.range || null, sent: 0 };
    seen.push(record);
    const match = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    if (mode === 'truncate') {
      res.writeHead(200, { 'Content-Length': PAYLOAD.length });
      record.sent = cut;
      res.write(PAYLOAD.subarray(0, cut), () => res.destroy());
      return;
    }
    if (match && mode === 'range') {
      const start = Number(match[1]);
      const body = PAYLOAD.subarray(start);
      record.sent = body.length;
      res.writeHead(206, { 'Content-Length': body.length, 'Content-Range': `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}` });
      res.end(body);
      return;
    }
    record.sent = PAYLOAD.length;
    res.writeHead(200, { 'Content-Length': PAYLOAD.length });
    res.end(PAYLOAD);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return { seen, url: `http://127.0.0.1:${port}/resolve/main/ggml-test.bin` };
}

function spec(url, overrides = {}) {
  return { model: 'test', quant: 'q8_0', file: 'ggml-test.bin', size: PAYLOAD.length, sha256: SHA, url, ...overrides };
}

describe('model names', () => {
  it('maps config model names and aliases to the pinned ggml files, q8_0 by default', () => {
    const turbo = resolveModel('large-v3-turbo');
    expect(turbo).toMatchObject({ file: 'ggml-large-v3-turbo-q8_0.bin', size: 874188075 });
    expect(turbo.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(turbo.url).toMatch(/^https:\/\/huggingface\.co\/ggerganov\/whisper\.cpp\/resolve\/[0-9a-f]{40}\/ggml-large-v3-turbo-q8_0\.bin$/);
    expect(resolveModel('turbo', 'f16').file).toBe('ggml-large-v3-turbo.bin');
    expect(resolveModel('small.en', 'q5_1').file).toBe('ggml-small.en-q5_1.bin');
    expect(modelsDir(path.join('D:', 'data'))).toBe(path.join('D:', 'data', 'models'));
  });

  it('refuses an unknown model, and a quantization the repo does not have', () => {
    expect(() => resolveModel('distil-large-v3')).toThrow(/unknown asr model for whisper\.cpp: 'distil-large-v3'/);
    expect(() => resolveModel('large-v3', 'q8_0')).toThrow(/no q8_0 build of 'large-v3' for whisper\.cpp \(available: f16\|q5_0\)/);
  });
});

describe('model download', () => {
  it('downloads through the redirect, verifies, and reports progress up to the full size', async () => {
    const dir = tmpPath();
    const { url, seen } = await hub();
    const progress = [];
    const lines = [];

    const file = await ensureModel(spec(url), { dir, log: (line) => lines.push(line), onProgress: (p) => progress.push(p.received) });

    expect(file).toBe(path.join(dir, 'ggml-test.bin'));
    expect(fs.readFileSync(file).equals(PAYLOAD)).toBe(true);
    expect(fs.existsSync(`${file}.part`)).toBe(false);
    expect(progress.at(-1)).toBe(PAYLOAD.length);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(lines[0]).toMatch(/model 'test' is not downloaded yet; downloading ggml-test\.bin/);
    expect(seen.map((r) => r.url)).toEqual(['/resolve/main/ggml-test.bin', '/cdn/ggml-test.bin']);
    expect(isModelPresent(dir, spec(url))).toBe(true);
  });

  it('modelStatus reports present, missing, and .part progress without polling', async () => {
    const dir = tmpPath();
    const s = spec('http://example.test/x');
    expect(modelStatus(dir, s)).toMatchObject({ state: 'missing', received: 0, percent: 0 });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${s.file}.part`), Buffer.alloc(30_000));
    const partial = modelStatus(dir, s);
    expect(partial.state).toBe('partial');
    expect(partial.received).toBe(30_000);
    expect(partial.percent).toBe(Math.floor((30_000 * 100) / s.size));
    fs.writeFileSync(path.join(dir, s.file), PAYLOAD);
    expect(modelStatus(dir, s).state).toBe('present');
  });

  it('an interrupted download is kept and the next try resumes it with a Range request', async () => {
    const dir = tmpPath();
    const broken = await hub({ mode: 'truncate', cut: 120_000 });
    await expect(ensureModel(spec(broken.url), { dir })).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, 'ggml-test.bin'))).toBe(false);
    const kept = fs.statSync(path.join(dir, 'ggml-test.bin.part')).size;
    expect(kept).toBeGreaterThan(0);

    const good = await hub();
    const lines = [];
    const file = await ensureModel(spec(good.url), { dir, log: (line) => lines.push(line) });

    expect(fs.readFileSync(file).equals(PAYLOAD)).toBe(true);
    const cdn = good.seen.find((r) => r.url.startsWith('/cdn/'));
    expect(cdn.range).toBe(`bytes=${kept}-`);
    expect(cdn.sent).toBe(PAYLOAD.length - kept);
    expect(lines[0]).toMatch(/resuming/);
  });

  it('a server that ignores Range sends the whole file again, and the result is still exact', async () => {
    const dir = tmpPath();
    fs.writeFileSync(path.join(dir, 'ggml-test.bin.part'), PAYLOAD.subarray(0, 50_000));
    const { url } = await hub({ mode: 'ignore-range' });

    const file = await ensureModel(spec(url), { dir });

    expect(fs.readFileSync(file).equals(PAYLOAD)).toBe(true);
  });

  it('a sha256 mismatch fails loud and leaves no model file behind', async () => {
    const dir = tmpPath();
    const { url } = await hub();
    const wrong = spec(url, { sha256: '0'.repeat(64) });

    await expect(ensureModel(wrong, { dir })).rejects.toThrow(/failed its sha256 check/);

    expect(fs.readdirSync(dir)).toEqual([]);
    expect(isModelPresent(dir, wrong)).toBe(false);
  });

  it('a model already in place is used without touching the network', async () => {
    const dir = tmpPath();
    fs.writeFileSync(path.join(dir, 'ggml-test.bin'), PAYLOAD);
    const { url, seen } = await hub();

    expect(await ensureModel(spec(url), { dir })).toBe(path.join(dir, 'ggml-test.bin'));
    expect(seen).toEqual([]);
  });
});
