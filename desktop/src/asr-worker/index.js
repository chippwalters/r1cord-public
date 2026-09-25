// The per-job ASR worker (ELECTRON-PLAN §3.1): decode the audio with ffmpeg, run whisper.cpp through
// @fugood/whisper.node on one backend, report, exit. Exiting after one job is what frees the VRAM, the
// way r1cord_server/pipeline/asr.py drops its model after each job.
//
// It runs as a child_process.fork of this file under plain Node, or as an Electron utilityProcess; the
// parent channel is process.send / process.on('message') or process.parentPort respectively.
//
// Parent -> worker, once:
//   {type: 'start', audioPath, modelPath, backend: 'cpu'|'vulkan'|'cuda'|'metal', quant, language: string|null,
//    ffmpeg, options: {whisper.node transcribe options}, modulePaths?: string[]}
// Worker -> parent:
//   {type: 'log', line}              a line for the job log
//   {type: 'progress', percent}      whisper.cpp progress, 0..100
//   {type: 'result', result: {backend, language, samples, segments: [{t0, t1, text}]}}   t0/t1 in ms
//   {type: 'error', stage: 'audio'|'load'|'transcribe', message}
// The whisper context is released before the result goes out. Under child_process.fork the worker then
// exits itself once the message is delivered (0 after a result, 1 after an error); a utilityProcess
// cannot confirm delivery, so it waits and the parent ends it, which the parent does in both cases.

'use strict';

const { spawn } = require('node:child_process');

const SAMPLE_RATE = 16000;
const NATIVE_LOG_LINES = 40;
// How long to wait for whisper.cpp's backend line after a load (it is logged during the load itself).
const BACKEND_LOG_WAIT_MS = 10_000;
const FFMPEG_STDERR_BYTES = 4096;

/**
 * Env the whisper.cpp process should run with. GGML_VK_DISABLE_COOPMAT=1 unless the caller already
 * set it (AMD 8060S crashes in the first encode otherwise). R1CORD_VK_DEVICE, when set, becomes
 * GGML_VK_VISIBLE_DEVICES; no device is pinned by default.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
function workerEnv(env = process.env) {
  const out = { ...env };
  if (out.GGML_VK_DISABLE_COOPMAT === undefined) out.GGML_VK_DISABLE_COOPMAT = '1';
  if (out.R1CORD_VK_DEVICE) out.GGML_VK_VISIBLE_DEVICES = String(out.R1CORD_VK_DEVICE);
  return out;
}

function applyWorkerEnv(env = process.env) {
  const next = workerEnv(env);
  if (env.GGML_VK_DISABLE_COOPMAT === undefined) env.GGML_VK_DISABLE_COOPMAT = next.GGML_VK_DISABLE_COOPMAT;
  if (next.GGML_VK_VISIBLE_DEVICES !== undefined) env.GGML_VK_VISIBLE_DEVICES = next.GGML_VK_VISIBLE_DEVICES;
  return next;
}

class StageError extends Error {
  constructor(stage, message) {
    super(message);
    this.stage = stage;
  }
}

function channel() {
  if (process.parentPort) {
    return {
      send: (message) => process.parentPort.postMessage(message),
      once: (handler) => process.parentPort.once('message', (event) => handler(event.data)),
      exit: () => {},
    };
  }
  if (process.send) {
    return {
      send: (message) => new Promise((resolve) => process.send(message, () => resolve())),
      once: (handler) => process.once('message', handler),
      exit: (code) => process.exit(code),
    };
  }
  throw new Error('asr worker: started without a parent channel');
}

// 16 kHz mono signed 16-bit PCM, as faster-whisper's decode_audio produces it through PyAV.
function decodeAudio(ffmpeg, audioPath) {
  return new Promise((resolve, reject) => {
    const argv = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', audioPath, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE),
      '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'];
    const child = spawn(ffmpeg, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-FFMPEG_STDERR_BYTES);
    });
    child.once('error', (error) => reject(new StageError('audio', `ffmpeg could not start (${ffmpeg}): ${error.message}`)));
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new StageError('audio', `ffmpeg could not decode the audio (exit ${code}): ${stderr.trim()}`));
        return;
      }
      const pcm = Buffer.concat(chunks);
      resolve(pcm.subarray(0, pcm.length - (pcm.length % 2)));
    });
  });
}

// The platform package for a backend. The whisper.node loader silently falls back to the CPU build
// when a variant is missing; an explicit backend must not, so the package is required directly.
// macOS has no -metal package: its default build carries Metal.
function addonPackage(backend, platform = process.platform, arch = process.arch) {
  const base = `@fugood/node-whisper-${platform}-${arch}`;
  return backend === 'vulkan' || backend === 'cuda' ? `${base}-${backend}` : base;
}

function loadAddon(backend, modulePaths) {
  const name = addonPackage(backend);
  try {
    const resolved = modulePaths && modulePaths.length ? require.resolve(name, { paths: modulePaths }) : name;
    return require(resolved);
  } catch (error) {
    throw new StageError('load', `${backend}: whisper.cpp build ${name} did not load: ${error.message}`);
  }
}

async function run(job, send) {
  applyWorkerEnv(process.env);
  const log = (line) => send({ type: 'log', line });
  const service = process.env.R1CORD_ASR_SERVICE_NAME;
  if (service) log(`asr: worker pid=${process.pid} serviceName=${service}`);
  const pcm = await decodeAudio(job.ffmpeg, job.audioPath);
  const samples = pcm.length / 2;

  const addon = loadAddon(job.backend, job.modulePaths);
  const native = [];
  let gpuDevice = null;
  let gpuName = null;
  // whisper.cpp logs which GPU backend it took, or that it found none. Those lines reach JS through a
  // thread-safe function, some turns of the event loop after the (synchronous) load has returned.
  let backendDecided;
  const backendKnown = new Promise((resolve) => {
    backendDecided = resolve;
  });
  addon.WhisperContext.toggleNativeLog(true, (_level, text) => {
    const line = String(text).trim();
    if (!line) return;
    native.push(line);
    if (native.length > NATIVE_LOG_LINES) native.shift();
    const vulkan = /^ggml_vulkan: \d+ = (.+?) \(/.exec(line);
    if (vulkan && !gpuName) gpuName = vulkan[1];
    const cuda = /Device \d+: ([^,]+), compute capability/.exec(line);
    if (cuda && !gpuName) gpuName = cuda[1];
    const using = /whisper_backend_init_gpu: using (\S+) backend/.exec(line);
    if (using) gpuDevice = using[1];
    if (using || /whisper_backend_init_gpu: no GPU found/.test(line)) backendDecided();
  });
  const nativeTail = () => native.slice(-8).join('\n');
  const nativeLogged = (ms) => Promise.race([backendKnown, new Promise((resolve) => setTimeout(resolve, ms))]);

  const useGpu = job.backend !== 'cpu';
  log(`asr: loading ${job.backend}/${job.quant}`);
  let context;
  try {
    context = await new addon.WhisperContext({ filePath: job.modelPath, useGpu });
  } catch (error) {
    await nativeLogged(1000);
    throw new StageError('load', `${job.backend}: whisper.cpp could not load the model: ${error.message}\n${nativeTail()}`);
  }
  if (useGpu) await nativeLogged(BACKEND_LOG_WAIT_MS);
  try {
    if (useGpu && !gpuDevice) {
      throw new StageError('load', `${job.backend}: no GPU device found\n${nativeTail()}`);
    }
    if (useGpu) log(`asr: ${job.backend} device ${gpuDevice}${gpuName ? ` (${gpuName})` : ''}`);

    let lastPercent = -1;
    const options = {
      ...job.options,
      language: job.language || 'auto',
      onProgress: (percent) => {
        if (percent !== lastPercent) {
          lastPercent = percent;
          send({ type: 'progress', percent });
        }
      },
    };
    let output;
    try {
      const whole = pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength;
      const arrayBuffer = whole ? pcm.buffer : pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
      output = await context.transcribeData(arrayBuffer, options).promise;
    } catch (error) {
      throw new StageError('transcribe', `${job.backend}: whisper.cpp failed: ${error.message}\n${nativeTail()}`);
    }
    if (output.isAborted) throw new StageError('transcribe', `${job.backend}: whisper.cpp stopped before the end`);
    return {
      backend: job.backend,
      language: output.language || null,
      samples,
      segments: (output.segments || []).map((seg) => ({ t0: seg.t0, t1: seg.t1, text: seg.text })),
    };
  } finally {
    await context.release();
  }
}

function main() {
  const parent = channel();
  parent.once(async (job) => {
    let code = 0;
    try {
      if (!job || job.type !== 'start') throw new StageError('load', 'asr worker: expected a start message');
      const result = await run(job, parent.send);
      await parent.send({ type: 'result', result });
    } catch (error) {
      code = 1;
      await parent.send({ type: 'error', stage: error.stage || 'transcribe', message: String(error.message || error).trim() });
    }
    parent.exit(code);
  });
}

if (require.main === module) main();

module.exports = { SAMPLE_RATE, addonPackage, applyWorkerEnv, workerEnv };
