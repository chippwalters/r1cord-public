// The whisper.cpp ASR engine: `transcribe(audioPath, { model, device, language, signal, log })` ->
// AsrResult, with no files written. Each attempt runs in its own short-lived worker process
// (src/asr-worker/index.js), which exits after the job so the GPU memory goes back, as asr.py drops
// its model after each job.
//
// Config devices (same values Python 0.3.4 accepts):
//   cpu     CPU only; never falls back
//   auto    Vulkan if a GPU works, else CPU (Metal then CPU on macOS). A load or first-decode
//           failure is logged in one line and the next backend is tried; an audio decoding failure
//           is not a backend problem and stops at once.
//   cuda    legacy; treated as auto, with one log line that CUDA is not bundled.
// Engine tests may still pass vulkan or metal to pin that backend.
//
// The worker transport is injectable: by default child_process.fork of the worker script under plain
// Node. When the core is an Electron utilityProcess, host.spawnWorker asks main to fork another
// utilityProcess (RunAsNode may be off, so child_process.fork would throw) and relays messages
// over parentPort keyed by id. spawnWorker(scriptPath, args, {env}) returns
// {postMessage, on('message'|'exit'), kill}.

const childProcess = require('node:child_process');
const path = require('node:path');
const { ValueError } = require('../errors');
const { AsrError } = require('./asr');
const { isFile, pyRound, pyStrRepr, pyStrip } = require('./compat');
const models = require('./models');
const { SAMPLE_RATE, addonPackage, workerEnv } = require('../../asr-worker');

const WORKER_SCRIPT = path.join(__dirname, '..', '..', 'asr-worker', 'index.js');
const DEVICES = ['auto', 'cuda', 'cpu', 'vulkan', 'metal'];
const STDERR_TAIL_BYTES = 4096;

// faster-whisper 1.2.1 WhisperModel.transcribe() defaults (asr.py passes only language,
// word_timestamps=False and vad_filter=False), in whisper.node option names. The thresholds whisper.node
// does not expose (entropy 2.4 for compression ratio 2.4, logprob -1.0, no-speech 0.6, max initial
// timestamp 1.0, suppress_blank) are whisper.cpp's own defaults and equal faster-whisper's. VAD is off in
// whisper.cpp unless asked for. Conditioning on previous text is whisper.cpp's default within a file,
// dropped above temperature 0.5 as faster-whisper's prompt_reset_on_temperature does.
const DECODE_OPTIONS = Object.freeze({
  beamSize: 5,
  bestOf: 5,
  temperature: 0.0,
  temperatureInc: 0.2,
  tokenTimestamps: false,
});

/**
 * The backends to try for a configured device, in order.
 * @param {string} device
 * @param {string} [platform]
 * @returns {string[]}
 */
function autoBackends(platform = process.platform) {
  return platform === 'darwin' ? ['metal', 'cpu'] : ['vulkan', 'cpu'];
}

function backendPlan(device, platform = process.platform) {
  if (!DEVICES.includes(device)) {
    throw new ValueError(`unknown asr device: ${pyStrRepr(device)} (expected auto|cuda|cpu)`);
  }
  if (device === 'cpu') return ['cpu'];
  if (device === 'auto' || device === 'cuda') return autoBackends(platform);
  return [device];
}

function packageInstalled(name, modulePaths) {
  try {
    require.resolve(name, modulePaths && modulePaths.length ? { paths: modulePaths } : undefined);
    return true;
  } catch (_error) {
    return false;
  }
}

/**
 * The default transport: fork the worker under the current Node, IPC channel, stderr kept for crashes.
 * @param {string} scriptPath
 * @param {string[]} args
 * @returns {{postMessage: (message: object) => void, on: (event: string, handler: Function) => void, kill: () => void}}
 */
function forkWorker(scriptPath, args = [], options = {}) {
  const child = childProcess.fork(scriptPath, args, {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
    execArgv: [],
    env: options.env || process.env,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
  });
  return {
    postMessage: (message) => child.send(message),
    on: (event, handler) => {
      if (event === 'exit') child.once('close', (code, signal) => handler(code === null ? signal : code, stderr.trim()));
      else child.on(event, handler);
    },
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}

function defaultSpawnWorker(scriptPath, args, options) {
  const parent = process.parentPort;
  if (parent && typeof parent.postMessage === 'function') {
    // Lazy: host.js has no ASR imports; this file may load before installHost().
    return require('../host').spawnWorker(scriptPath, args, options);
  }
  return forkWorker(scriptPath, args, options);
}

function logDownloadProgress(log) {
  let lastLogged = -1;
  return ({ received, total }) => {
    if (!total) return;
    const percent = Math.floor((received * 100) / total);
    const bucket = percent === 100 ? 100 : percent - (percent % 10);
    if (bucket >= 10 && bucket > lastLogged) {
      lastLogged = bucket;
      log(`asr: downloading model ... ${bucket}%`);
    }
  };
}

// One worker, one backend: resolves the worker's raw result, rejects with an error that says whether
// the next backend may be tried (`fallback`) and carries whisper.cpp's last log lines (`detail`).
function runWorker({ spawnWorker, workerScript, job, signal, log, onProgress }) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(signal.reason);
      return;
    }
    let worker;
    try {
      worker = spawnWorker(workerScript, []);
    } catch (error) {
      reject(new AsrError(`whisper.cpp worker could not start: ${error.message}`));
      return;
    }
    let outcome = null;
    let aborted = false;
    let settled = false;
    const onAbort = () => {
      aborted = true;
      worker.kill();
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      fn();
    };

    worker.on('message', (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'log') {
        log(String(message.line));
      } else if (message.type === 'progress') {
        onProgress({ stage: 'transcribe', backend: job.backend, percent: Number(message.percent) });
      } else if ((message.type === 'result' || message.type === 'error') && !outcome) {
        outcome = message;
        worker.kill();
      }
    });
    worker.on('exit', (code, detail) => {
      settle(() => {
        if (aborted) {
          reject(signal.reason);
        } else if (outcome && outcome.type === 'result') {
          resolve(outcome.result);
        } else if (outcome) {
          const [first, ...rest] = String(outcome.message).split(/\r?\n/);
          reject(Object.assign(new AsrError(first.trim()), { fallback: outcome.stage !== 'audio', detail: rest }));
        } else {
          const message = `${job.backend}: whisper.cpp worker exited (${code}) without a result`;
          reject(Object.assign(new AsrError(message), { fallback: true, detail: String(detail || '').split(/\r?\n/) }));
        }
      });
    });
    worker.postMessage({ type: 'start', ...job });
  });
}

function seconds(ms) {
  return Math.round(Number(ms)) / 1000;
}

// The worker's raw output as the AsrResult the bridge produces: ids from 0, stripped texts, times
// in seconds, duration from the decoded sample count as faster-whisper computes it.
function toAsrResult(raw, { model, language }) {
  const segments = raw.segments.map((seg, index) => ({
    id: index,
    start: seconds(seg.t0),
    end: seconds(seg.t1),
    text: pyStrip(seg.text || ''),
  }));
  const duration = Number(raw.samples) / SAMPLE_RATE;
  return {
    engine: 'whisper.cpp',
    model,
    device: raw.backend,
    language: raw.language || language || null,
    durationMs: pyRound(duration * 1000),
    duration,
    segments,
    text: segments.map((seg) => seg.text).join('\n\n'),
  };
}

/**
 * The whisper.cpp engine.
 * @param {{modelsDir: string, quant?: string, ffmpeg?: string|null, threads?: number,
 *   spawnWorker?: (scriptPath: string, args: string[]) => {postMessage: Function, on: Function, kill: Function},
 *   workerScript?: string, modulePaths?: string[]|null, ensureModel?: Function, env?: object, platform?: string,
 *   onProgress?: (progress: object) => void}} options
 *   modelsDir: where ggml models live (models.modelsDir(<datastore>)); quant: q8_0 (default) | f16 | q5_0 | q5_1;
 *   ffmpeg: decoder binary (default R1CORD_FFMPEG, else `ffmpeg` on PATH); threads: 0 = whisper.node's
 *   default (min(8, cores)); modulePaths: where to resolve the whisper.node builds from (default: this
 *   app's node_modules); onProgress: {stage: 'download', received, total} and {stage: 'transcribe', percent}
 */
function createWhisperCppEngine({
  modelsDir,
  quant = models.DEFAULT_QUANT,
  ffmpeg = null,
  threads = 0,
  spawnWorker = null,
  workerScript = WORKER_SCRIPT,
  modulePaths = null,
  ensureModel = models.ensureModel,
  env = process.env,
  platform = process.platform,
  onProgress = () => {},
} = {}) {
  if (!modelsDir) throw new ValueError('whisper.cpp engine: modelsDir is required');
  const decoder = ffmpeg || (env.R1CORD_FFMPEG && String(env.R1CORD_FFMPEG).trim()) || 'ffmpeg';
  const spawn = spawnWorker || defaultSpawnWorker;
  const envForWorker = workerEnv(env);
  const startWorker = (script, args) => spawn(script, args, { env: envForWorker });
  return {
    name: 'whisper.cpp',
    /**
     * @param {string} audioPath
     * @param {{model: string, device?: string, language?: string|null, signal?: AbortSignal|null,
     *   log?: (line: string) => void}} options
     * @returns {Promise<import('./asr').AsrResult>}
     */
    async transcribe(audioPath, { model, device = 'auto', language = null, signal = null, log = () => {} }) {
      if (!isFile(audioPath)) throw Object.assign(new Error(`audio not found: ${audioPath}`), { code: 'ENOENT' });
      if (device === 'cuda') {
        log('asr: cuda is not bundled; using auto (Vulkan/CPU)');
      }
      let plan = backendPlan(device, platform);
      const spec = models.resolveModel(model, quant);
      let announced = false;
      const downloadProgress = logDownloadProgress(log);
      const modelPath = await ensureModel(spec, {
        dir: modelsDir,
        signal,
        log,
        onProgress: ({ received, total }) => {
          if (!announced) {
            announced = true;
            log('asr: downloading model ...');
          }
          downloadProgress({ received, total });
          onProgress({ stage: 'download', received, total });
        },
      });
      if (device === 'auto') {
        // A GPU build that is not installed (the optional CUDA pack, Vulkan on macOS) is not a failure.
        plan = plan.filter((backend) => backend === 'cpu' || packageInstalled(addonPackage(backend, platform), modulePaths));
      }
      const options = threads > 0 ? { ...DECODE_OPTIONS, maxThreads: threads } : { ...DECODE_OPTIONS };
      for (let i = 0; i < plan.length; i += 1) {
        const backend = plan[i];
        const job = { audioPath, modelPath, backend, quant: spec.quant, language: language || null, ffmpeg: decoder, options, modulePaths };
        try {
          const raw = await runWorker({ spawnWorker: startWorker, workerScript, job, signal, log, onProgress });
          return toAsrResult(raw, { model, language });
        } catch (error) {
          if ((signal && signal.aborted) || !error.fallback || device !== 'auto' || i === plan.length - 1) {
            for (const line of error.detail || []) if (line.trim()) log(`asr: whisper.cpp: ${line.trim()}`);
            throw error;
          }
          log(`asr: ${backend} failed: ${error.message}; falling back to ${plan[i + 1]}`);
        }
      }
      throw new AsrError('whisper.cpp: no backend to run');
    },
  };
}

module.exports = {
  DECODE_OPTIONS,
  DEVICES,
  WORKER_SCRIPT,
  addonPackage,
  backendPlan,
  createWhisperCppEngine,
  defaultSpawnWorker,
  forkWorker,
  logDownloadProgress,
  toAsrResult,
  workerEnv,
};
