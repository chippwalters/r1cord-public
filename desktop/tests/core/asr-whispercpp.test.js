// The whisper.cpp engine: device selection and fallback (tests/test_asr.py's four device cases, which
// the faster-whisper bridge leaves to Python, ported to this engine), the result shape writeTranscript
// needs, the worker protocol, and the engine switch. Workers are stand-ins except in the last block,
// which forks the real worker script against stand-in whisper.node builds (ffmpeg on PATH required).
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createAsrEngine, writeTranscript } = require('../../src/core/pipeline/asr');
const { addonPackage, createWhisperCppEngine, logDownloadProgress, workerEnv } = require('../../src/core/pipeline/asr-whispercpp');
const { readText } = require('../../src/core/pipeline/compat');

const cleanup = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()();
});

function tmpPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-whispercpp-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function audioFile(tmp) {
  const audio = path.join(tmp, 'audio.m4a');
  fs.writeFileSync(audio, 'x');
  return audio;
}

// Installs stand-in whisper.node builds for `backends` under `<root>/node_modules`; `body` is the
// module source (default: an empty module, enough for "is this build installed").
function installBuilds(root, backends, body = 'module.exports = {};', platform = process.platform) {
  for (const backend of backends) {
    const name = addonPackage(backend, platform);
    const dir = path.join(root, 'node_modules', ...name.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0-test', main: 'index.js' }));
    fs.writeFileSync(path.join(dir, 'index.js'), typeof body === 'function' ? body(backend) : body);
  }
  return root;
}

const RAW = { backend: 'cpu', language: 'en', samples: 16000, segments: [{ t0: 0, t1: 1000, text: ' Hello.' }] };

// Stand-in workers: `behaviour(job, worker)` answers each started job through worker.send / worker.exit.
function fakeWorkers(behaviour) {
  const jobs = [];
  const killed = [];
  const spawnWorker = () => {
    const handlers = { message: [], exit: [] };
    const later = (fn) => setImmediate(fn);
    let exited = false;
    let job = null;
    const exit = (code) => {
      if (exited) return;
      exited = true;
      later(() => handlers.exit.forEach((handler) => handler(code, '')));
    };
    return {
      postMessage(message) {
        job = message;
        jobs.push(message);
        behaviour(message, { send: (reply) => later(() => handlers.message.forEach((handler) => handler(reply))), exit });
      },
      on(event, handler) {
        handlers[event].push(handler);
      },
      kill() {
        killed.push(job && job.backend);
        exit(null);
      },
    };
  };
  return { jobs, killed, spawnWorker };
}

function engine(tmp, spawnWorker, options = {}) {
  return createWhisperCppEngine({
    modelsDir: path.join(tmp, 'models'),
    spawnWorker,
    ensureModel: async (spec) => path.join(tmp, 'models', spec.file),
    modulePaths: [tmp],
    ...options,
  });
}

const succeed = (raw = RAW) => (job, worker) => worker.send({ type: 'result', result: { ...raw, backend: job.backend } });

describe('device selection', () => {
  it('missing audio raises "audio not found" without starting a worker', async () => {
    const tmp = tmpPath();
    const workers = fakeWorkers(succeed());
    await expect(engine(tmp, workers.spawnWorker).transcribe(path.join(tmp, 'nope.m4a'), { model: 'small', device: 'cpu' }))
      .rejects.toThrow(/audio not found/);
    expect(workers.jobs).toEqual([]);
  });

  it('an unknown device is rejected', async () => {
    const tmp = tmpPath();
    const workers = fakeWorkers(succeed());
    await expect(engine(tmp, workers.spawnWorker).transcribe(audioFile(tmp), { model: 'small', device: 'gpu' }))
      .rejects.toThrow(/unknown asr device: 'gpu' \(expected auto\|cuda\|cpu\)/);
    expect(workers.jobs).toEqual([]);
  });

  it('auto falls back past a failing GPU backend with one logged line', async () => {
    const tmp = tmpPath();
    installBuilds(tmp, ['vulkan'], undefined, 'win32');
    const workers = fakeWorkers((job, worker) => {
      if (job.backend === 'vulkan') worker.send({ type: 'error', stage: 'load', message: 'vulkan: no GPU device found\r\nggml_vk_init: failed' });
      else succeed()(job, worker);
    });
    const lines = [];

    const result = await engine(tmp, workers.spawnWorker, { platform: 'win32' })
      .transcribe(audioFile(tmp), { model: 'small', device: 'auto', log: (line) => lines.push(line) });

    expect(workers.jobs.map((job) => job.backend)).toEqual(['vulkan', 'cpu']);
    expect(result).toMatchObject({ engine: 'whisper.cpp', model: 'small', device: 'cpu' });
    expect(lines.filter((line) => line.includes('falling back'))).toEqual([
      'asr: vulkan failed: vulkan: no GPU device found; falling back to cpu',
    ]);
  });

  it('auto on a PC without GPU builds goes straight to cpu, logging nothing about it', async () => {
    const tmp = tmpPath();
    const workers = fakeWorkers(succeed());
    const lines = [];

    const result = await engine(tmp, workers.spawnWorker, { platform: 'win32' })
      .transcribe(audioFile(tmp), { model: 'small', device: 'auto', log: (line) => lines.push(line) });

    expect(workers.jobs.map((job) => job.backend)).toEqual(['cpu']);
    expect(result.device).toBe('cpu');
    expect(lines).toEqual([]);
  });

  it('auto treats a worker that dies mid-decode like a failed backend', async () => {
    const tmp = tmpPath();
    installBuilds(tmp, ['vulkan'], undefined, 'win32');
    const workers = fakeWorkers((job, worker) => {
      if (job.backend === 'vulkan') worker.exit(3221226505);
      else succeed()(job, worker);
    });
    const lines = [];

    const result = await engine(tmp, workers.spawnWorker, { platform: 'win32' })
      .transcribe(audioFile(tmp), { model: 'small', device: 'auto', log: (line) => lines.push(line) });

    expect(workers.jobs.map((job) => job.backend)).toEqual(['vulkan', 'cpu']);
    expect(result.device).toBe('cpu');
    expect(lines).toEqual(['asr: vulkan failed: vulkan: whisper.cpp worker exited (3221226505) without a result; falling back to cpu']);
  });

  it('unreadable audio is not a backend problem: no other backend is tried', async () => {
    const tmp = tmpPath();
    installBuilds(tmp, ['vulkan'], undefined, 'win32');
    const workers = fakeWorkers((job, worker) => worker.send({ type: 'error', stage: 'audio', message: 'ffmpeg could not decode the audio (exit 1): moov atom not found' }));

    await expect(engine(tmp, workers.spawnWorker, { platform: 'win32' }).transcribe(audioFile(tmp), { model: 'small', device: 'auto' }))
      .rejects.toThrow(/^ffmpeg could not decode the audio \(exit 1\): moov atom not found$/);
    expect(workers.jobs).toHaveLength(1);
  });

  it('cuda is treated as auto and logs that CUDA is not bundled', async () => {
    const tmp = tmpPath();
    installBuilds(tmp, ['vulkan'], undefined, 'win32');
    const workers = fakeWorkers(succeed());
    const lines = [];

    const result = await engine(tmp, workers.spawnWorker, { platform: 'win32' })
      .transcribe(audioFile(tmp), { model: 'small', device: 'cuda', log: (line) => lines.push(line) });

    expect(lines[0]).toBe('asr: cuda is not bundled; using auto (Vulkan/CPU)');
    expect(workers.jobs.map((job) => job.backend)).toEqual(['vulkan']);
    expect(result.device).toBe('vulkan');
  });

  it('explicit cpu runs on cpu only and forwards the language and the model file', async () => {
    const tmp = tmpPath();
    installBuilds(tmp, ['vulkan']);
    const workers = fakeWorkers(succeed({ ...RAW, language: 'fr' }));

    const result = await engine(tmp, workers.spawnWorker).transcribe(audioFile(tmp), { model: 'small', device: 'cpu', language: 'fr' });

    expect(workers.jobs).toHaveLength(1);
    expect(workers.jobs[0]).toMatchObject({ backend: 'cpu', language: 'fr', modelPath: path.join(tmp, 'models', 'ggml-small-q8_0.bin') });
    expect(result).toMatchObject({ device: 'cpu', language: 'fr' });
  });
});

describe('result and worker protocol', () => {
  it("returns the bridge's result shape, so writeTranscript writes the same files", async () => {
    const tmp = tmpPath();
    const raw = {
      backend: 'vulkan',
      language: 'en',
      samples: 105_611,
      segments: [
        { t0: 0, t1: 5500, text: ' Site visit notes, September 20th.' },
        { t0: 5500, t1: 6600, text: '  We walked the north lot. ' },
      ],
    };
    const workers = fakeWorkers((job, worker) => {
      worker.send({ type: 'log', line: 'asr: loading vulkan/q8_0' });
      worker.send({ type: 'progress', percent: 50 });
      worker.send({ type: 'result', result: raw });
    });
    const lines = [];
    const progress = [];

    const result = await engine(tmp, workers.spawnWorker, { onProgress: (p) => progress.push(p) })
      .transcribe(audioFile(tmp), { model: 'large-v3-turbo', device: 'vulkan', log: (line) => lines.push(line) });

    expect(result).toEqual({
      engine: 'whisper.cpp',
      model: 'large-v3-turbo',
      device: 'vulkan',
      language: 'en',
      durationMs: 6601,
      duration: 6.6006875,
      segments: [
        { id: 0, start: 0, end: 5.5, text: 'Site visit notes, September 20th.' },
        { id: 1, start: 5.5, end: 6.6, text: 'We walked the north lot.' },
      ],
      text: 'Site visit notes, September 20th.\n\nWe walked the north lot.',
    });
    expect(progress).toEqual([{ stage: 'transcribe', backend: 'vulkan', percent: 50 }]);
    expect(workers.killed).toEqual(['vulkan']);

    const out = path.join(tmp, 'outbox');
    writeTranscript(out, result, (line) => lines.push(line));
    expect(lines).toEqual(['asr: loading vulkan/q8_0', "asr: wrote 2 segments on vulkan language='en' duration_ms=6601"]);
    expect(readText(path.join(out, 'transcript.txt'))).toBe('Site visit notes, September 20th.\n\nWe walked the north lot.\n');
    expect(readText(path.join(out, 'transcript.json'))).toBe(`{
  "model": "large-v3-turbo",
  "device": "vulkan",
  "language": "en",
  "durationMs": 6601,
  "segments": [
    {
      "id": 0,
      "start": 0.0,
      "end": 5.5,
      "text": "Site visit notes, September 20th."
    },
    {
      "id": 1,
      "start": 5.5,
      "end": 6.6,
      "text": "We walked the north lot."
    }
  ]
}
`);
  });

  it('a forced language stands when whisper.cpp reports none', async () => {
    const tmp = tmpPath();
    const workers = fakeWorkers(succeed({ ...RAW, language: '' }));
    const result = await engine(tmp, workers.spawnWorker).transcribe(audioFile(tmp), { model: 'small', device: 'cpu', language: 'de' });
    expect(result.language).toBe('de');
  });

  it('an abort ends the worker and rejects with the reason', async () => {
    const tmp = tmpPath();
    const workers = fakeWorkers(() => {});
    const controller = new AbortController();
    const reason = new Error('stopping');

    const run = engine(tmp, workers.spawnWorker).transcribe(audioFile(tmp), { model: 'small', device: 'cpu', signal: controller.signal });
    setTimeout(() => controller.abort(reason), 50);

    await expect(run).rejects.toBe(reason);
    expect(workers.killed).toEqual(['cpu']);
  });
});

describe('Vulkan worker env', () => {
  it('sets GGML_VK_DISABLE_COOPMAT unless the user already set it, and maps R1CORD_VK_DEVICE', () => {
    expect(workerEnv({})).toMatchObject({ GGML_VK_DISABLE_COOPMAT: '1' });
    expect(workerEnv({}).GGML_VK_VISIBLE_DEVICES).toBeUndefined();
    expect(workerEnv({ GGML_VK_DISABLE_COOPMAT: '0' }).GGML_VK_DISABLE_COOPMAT).toBe('0');
    expect(workerEnv({ R1CORD_VK_DEVICE: '1' }).GGML_VK_VISIBLE_DEVICES).toBe('1');
    expect(workerEnv({ R1CORD_VK_DEVICE: '1', GGML_VK_VISIBLE_DEVICES: '0' }).GGML_VK_VISIBLE_DEVICES).toBe('1');
  });

  it('passes the constructed env into spawnWorker', async () => {
    const tmp = tmpPath();
    const seen = [];
    const workers = fakeWorkers(succeed());
    const spawnWorker = (script, args, options) => {
      seen.push(options && options.env);
      return workers.spawnWorker(script, args, options);
    };
    await engine(tmp, spawnWorker, { env: { R1CORD_VK_DEVICE: '0', PATH: 'x' } })
      .transcribe(audioFile(tmp), { model: 'small', device: 'cpu' });
    expect(seen[0]).toMatchObject({
      GGML_VK_DISABLE_COOPMAT: '1',
      GGML_VK_VISIBLE_DEVICES: '0',
      R1CORD_VK_DEVICE: '0',
      PATH: 'x',
    });
  });

  it('logs asr: downloading model ... when ensureModel reports progress', async () => {
    const tmp = tmpPath();
    const workers = fakeWorkers(succeed());
    const lines = [];
    const asr = createWhisperCppEngine({
      modelsDir: path.join(tmp, 'models'),
      spawnWorker: workers.spawnWorker,
      ensureModel: async (spec, { onProgress, log }) => {
        log(`asr: model '${spec.model}' is not downloaded yet`);
        onProgress({ received: 10, total: 100 });
        onProgress({ received: 100, total: 100 });
        return path.join(tmp, 'models', spec.file);
      },
    });
    await asr.transcribe(audioFile(tmp), { model: 'small', device: 'cpu', log: (line) => lines.push(line) });
    expect(lines.filter((line) => line.startsWith('asr: downloading'))).toEqual([
      'asr: downloading model ...',
      'asr: downloading model ... 10%',
      'asr: downloading model ... 100%',
    ]);
  });

  it('logs download progress every 10 percent', () => {
    const lines = [];
    const report = logDownloadProgress((line) => lines.push(line));
    report({ received: 0, total: 100 });
    report({ received: 9, total: 100 });
    report({ received: 10, total: 100 });
    report({ received: 19, total: 100 });
    report({ received: 20, total: 100 });
    report({ received: 100, total: 100 });
    expect(lines).toEqual([
      'asr: downloading model ... 10%',
      'asr: downloading model ... 20%',
      'asr: downloading model ... 100%',
    ]);
  });
});

describe('engine', () => {
  it('createAsrEngine always returns whisper.cpp', () => {
    const config = { datastore: path.join(os.tmpdir(), 'r1cord-data') };
    expect(createAsrEngine({ config, env: {} }).name).toBe('whisper.cpp');
    expect(createAsrEngine({ config, env: { R1CORD_ASR_ENGINE: 'faster-whisper' } }).name).toBe('whisper.cpp');
  });
});

// A stand-in whisper.node build: logs like whisper.cpp does (asynchronously, as the real thread-safe
// log callback arrives), then returns one segment. The -vulkan build finds no GPU.
function standInBuild(backend) {
  const gpuLine = backend === 'cpu' ? '' : 'whisper_backend_init_gpu: no GPU found';
  return `let log = null;
class WhisperContext {
  static toggleNativeLog(enable, callback) { log = enable ? callback : null; }
  constructor(options) {
    const lines = ['whisper_init_with_params_no_state: use gpu = ' + (options.useGpu ? 1 : 0)];
    if (options.useGpu) lines.push(${JSON.stringify(gpuLine)});
    setTimeout(() => lines.forEach((line) => log && log('info', line + '\\n')), 20);
  }
  transcribeData(data, options) {
    options.onProgress(100);
    return { stop: async () => {}, promise: Promise.resolve({ language: 'en', result: ' Hi.', isAborted: false,
      segments: [{ text: ' Hi. ' + data.byteLength, t0: 0, t1: 1000 }] }) };
  }
  async release() {}
}
module.exports = { WhisperContext };
`;
}

function wavFile(file, seconds, rate = 48000, channels = 2) {
  const samples = seconds * rate * channels;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples * 2, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples * 2, 40);
  fs.writeFileSync(file, Buffer.concat([header, Buffer.alloc(samples * 2)]));
  return file;
}

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

// The worker names builds after the running platform; macOS's auto plan (metal, cpu) has no vulkan step.
describe.skipIf(!hasFfmpeg || process.platform === 'darwin')('the real worker process', () => {
  it('decodes the audio, loads the build for the backend and reports its no-GPU result truthfully', async () => {
    const tmp = tmpPath();
    installBuilds(tmp, ['cpu', 'vulkan'], standInBuild);
    const audio = wavFile(path.join(tmp, 'audio.wav'), 2);
    const real = createWhisperCppEngine({ modelsDir: tmp, modulePaths: [tmp], ensureModel: async () => path.join(tmp, 'model.bin') });

    await expect(real.transcribe(audio, { model: 'small', device: 'vulkan' })).rejects.toThrow(/^vulkan: no GPU device found$/);

    const lines = [];
    const result = await real.transcribe(audio, { model: 'small', device: 'auto', log: (line) => lines.push(line) });
    expect(lines).toEqual(['asr: loading vulkan/q8_0', 'asr: vulkan failed: vulkan: no GPU device found; falling back to cpu', 'asr: loading cpu/q8_0']);
    expect(result).toMatchObject({ device: 'cpu', language: 'en', durationMs: 2000, duration: 2 });
    expect(result.segments).toEqual([{ id: 0, start: 0, end: 1, text: 'Hi. 64000' }]);
  }, 30_000);

  it('an undecodable file fails with the ffmpeg reason', async () => {
    const tmp = tmpPath();
    installBuilds(tmp, ['cpu'], standInBuild);
    const real = createWhisperCppEngine({ modelsDir: tmp, modulePaths: [tmp], ensureModel: async () => path.join(tmp, 'model.bin') });
    await expect(real.transcribe(audioFile(tmp), { model: 'small', device: 'cpu' })).rejects.toThrow(/^ffmpeg could not decode the audio/);
  }, 30_000);
});
