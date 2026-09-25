// Port of r1cord_server/worker.py: the serial job loop.
//
// Module map (Python -> Node):
//   worker.py                  -> worker.js                 claims `queued` jobs one at a time (store.nextQueued, oldest
//                                                           first), runs the steps below, owns every status change
//   pipeline/asr.py            -> pipeline/asr.js           engine interface (createAsrEngine: whisper.cpp,
//                                                           pipeline/asr-whispercpp.js), transcript.txt / transcript.json writer
//   pipeline/instructions.py   -> pipeline/instructions.js  default prompts, <config dir>/prompts/<kind>.md overrides
//                                                           (save / restore), the INSTRUCTIONS.md frame
//   pipeline/writers.py        -> pipeline/writers.js       writer CLIs (claude_code / codex / grok_build), <kind>.md
//                                                           validation, the transcript page Markdown
//   pipeline/publish.py        -> pipeline/publish.js       site build into outbox/<rid>/site, deploy to the publish
//                                                           folder, republish of every published recording
//   mailer.py                  -> mailer.js                 email a complete job through gws
//   (shutil.which, Popen)      -> cli.js                    which, spawn of npm .cmd shims, kill tree
//   (Python text I/O)          -> pipeline/compat.js        utf-8 + universal newlines in, os.linesep out, repr/int/round
//
// One job: transcribing -> transcribed (ASR, or `asr: skipped`) -> transcript.md -> writing -> written (one
// writer run per review; a failed review never stops the others) -> site build (not publishing) or
// publishing -> published (build + deploy) -> complete, or error naming the failed step(s). A retry
// with only_publish rebuilds transcript.md and publishes. Every step logs to the job and records its
// timing; ASR / publish failures end the job as `error` with `<step>: <reason>`. After `complete`
// with email_enabled the job is emailed; a failed email is logged and never changes the status.
//
// The worker recovers nothing itself: startup recovery is store.recoverInterrupted() in app.js,
// before start(). stop() aborts the running job's child processes and leaves its status alone, so
// that recovery requeues it on the next start, as after the Python server exits mid-job.

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const defaultMailer = require('./mailer');
const publish = require('./pipeline/publish');
const defaultWriters = require('./pipeline/writers');
const { createAsrEngine, writeTranscript } = require('./pipeline/asr');
const { buildInstructions, loadPrompt } = require('./pipeline/instructions');
const { copy2, errorText, isFile, pyInt, pyRound, pyStrip, pyTruthy, readText, writeText } = require('./pipeline/compat');

const { transcriptMarkdown } = defaultWriters;

const POLL_MS = 2000;
const STOP_WAIT_MS = 5000;
const PHOTO_GLOB = process.platform === 'win32' ? /^photo-.*\.jpg$/is : /^photo-.*\.jpg$/s;

const SILENT_LOGGER = Object.freeze({ info() {}, warn() {}, error() {} });

// The reason a job's steps are aborted by stop(); never recorded on the job.
class WorkerStopped extends Error {
  constructor() {
    super('worker stopped');
    this.name = 'WorkerStopped';
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Worker {
  /**
   * @param {object} options see createWorker
   */
  constructor({ config, store, logger = SILENT_LOGGER, clock = () => performance.now(), asr = null, writers = defaultWriters,
    mailer = defaultMailer, promptsDir = null, pollMs = POLL_MS, spawnWorker = null }) {
    this.config = config;
    this.store = store;
    this.logger = logger;
    this.clock = clock;
    this.asr = asr || null;
    this.spawnWorker = spawnWorker || null;
    this.writers = writers;
    this.mailer = mailer;
    this.promptsDir = promptsDir;
    this.pollMs = pollMs;
    this.republisher = new publish.Republisher({ logger });
    this._stopping = false;
    this._loop = null;
    this._wake = null;
    this._controller = null;
  }

  /** True while the loop runs. */
  get running() {
    return this._loop !== null;
  }

  /** Start the loop; a no-op when it already runs. */
  start() {
    if (this._loop !== null) return;
    this._stopping = false;
    this._loop = this._run().finally(() => {
      this._loop = null;
    });
  }

  /**
   * Stop the loop: abort the running job's child processes (its status stays as it is) and wait up
   * to 5 s for the loop to end.
   * @returns {Promise<void>}
   */
  async stop() {
    this._stopping = true;
    this.wake();
    if (this._controller) this._controller.abort(new WorkerStopped());
    const loop = this._loop;
    if (loop) await Promise.race([loop, sleep(STOP_WAIT_MS)]);
  }

  /** Look for a queued job now instead of at the next poll (after an upload is committed, say). */
  wake() {
    if (this._wake) this._wake();
  }

  /**
   * Settings > Pages > Republish all pages. dryRun: the plan, nothing written. Otherwise starts the
   * background run and returns false when one is already running.
   * @param {{dryRun?: boolean}} [options]
   * @returns {import('./pipeline/publish').RepublishItem[] | boolean}
   */
  republishAll({ dryRun = false } = {}) {
    if (dryRun) return publish.planRepublish(this.store, this.config);
    return this.republisher.start(this.store, this.config);
  }

  _idle() {
    return new Promise((resolve) => {
      const timer = setTimeout(done, this.pollMs);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this._wake = () => {
        this._wake = null;
        done();
      };
    });
  }

  async _run() {
    while (!this._stopping) {
      let job;
      try {
        job = this.store.nextQueued();
      } catch (error) {
        this.logger.error('worker: reading the queue failed', error);
        job = null;
      }
      if (job === null) {
        await this._idle();
        continue;
      }
      try {
        await this.runJob(job);
      } catch (error) {
        if (error instanceof WorkerStopped) break;
        this.logger.error(`worker crashed on job ${job.jobId}`, error);
        try {
          this.store.setStatus(job.jobId, 'error', { error: `worker: ${errorText(error)}` });
        } catch (recordError) {
          this.logger.error(`failed to record worker error for ${job.jobId}`, recordError);
        }
        continue;
      }
      await this.emailIfComplete(job.jobId);
    }
  }

  /**
   * Email a job that reached `complete` when email is enabled. A failed email is logged to the job;
   * it never changes the job's status.
   * @param {string} jobId
   */
  async emailIfComplete(jobId) {
    if (!this.config.email_enabled) return;
    const rec = this.store.job(jobId);
    if (rec === null || rec.status !== 'complete') return;
    try {
      await this.mailer.emailJob(this.store, this.config, jobId);
    } catch (error) {
      this.logger.warn(`worker: job ${jobId} email failed: ${errorText(error)}`);
      this.store.appendLog(jobId, `email: failed: ${errorText(error)}`);
    }
  }

  /**
   * Run one job through every step, as the loop does. Throws WorkerStopped when stop() interrupts
   * it; any other exception is the loop's `worker: …` error.
   * @param {object} job a JobRecord (re-read from the store first)
   */
  async runJob(job) {
    const fresh = this.store.job(job.jobId);
    if (fresh === null) return;
    job = fresh;
    this._controller = new AbortController();
    try {
      await this._runSteps(job, this._controller.signal);
    } finally {
      this._controller = null;
    }
  }

  async _runSteps(job, signal) {
    const jobLog = (line) => this.store.appendLog(job.jobId, line);
    const timings = Object.keys(job.timings || {}).length ? { ...job.timings } : { asr: 0, writer: 0, publish: 0 };

    let writerError = '';
    if (job.onlyPublish) {
      this._writeTranscriptPage(job, jobLog);
    } else {
      if (!job.skipAsr) {
        if (!(await this._runAsr(job, jobLog, timings, signal))) return;
      } else {
        jobLog('asr: skipped');
        this.store.setStatus(job.jobId, 'transcribed', { timings });
      }
      signal.throwIfAborted();
      this._writeTranscriptPage(job, jobLog);

      let failures = new Map();
      if (!job.reviews.length || job.writer === 'none') jobLog('writer: skipped');
      else failures = await this._runReviews(job, jobLog, timings, signal);
      signal.throwIfAborted();
      writerError = Array.from(failures, ([kind, reason]) => `writer: ${kind}: ${reason}`).join('\n');

      if (!job.publish) {
        this._buildSite(job, jobLog);
        jobLog('publish: skipped');
        this._finish(job, writerError, timings);
        return;
      }
    }

    if (!this._runPublish(job, jobLog, timings, writerError)) return;
    this._finish(job, writerError, timings);
  }

  // complete when every requested review was written, else error naming the failed ones.
  _finish(job, writerError, timings) {
    if (writerError) this.store.setStatus(job.jobId, 'error', { error: writerError, timings });
    else this.store.setStatus(job.jobId, 'complete', { timings });
  }

  _elapsed(t0) {
    return Math.trunc(this.clock() - t0);
  }

  async _runAsr(job, jobLog, timings, signal) {
    this.store.setStatus(job.jobId, 'transcribing', { timings });
    jobLog('asr: start');
    const inbox = this.store.inboxDir(job.recordingId);
    let audio = path.join(inbox, 'audio.m4a');
    if (!isFile(audio)) audio = path.join(inbox, 'audio.wav');
    if (!isFile(audio)) {
      this.logger.warn(`worker: job ${job.jobId} (${job.recordingId}) asr failed: no audio file in inbox`);
      this.store.setStatus(job.jobId, 'error', { error: 'asr: no audio file in inbox' });
      return false;
    }
    const language = pyStrip(this.config.asr_language || '') || null;
    const t0 = this.clock();
    let result;
    try {
      result = await this._asrEngine().transcribe(audio, {
        model: this.config.asr_model,
        device: this.config.asr_device,
        language,
        signal,
        log: jobLog,
      });
      writeTranscript(this.store.outboxDir(job.recordingId), result, jobLog);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      this.logger.warn(`worker: job ${job.jobId} asr failed: ${errorText(error)}`);
      timings.asr = this._elapsed(t0);
      this.store.setStatus(job.jobId, 'error', { error: `asr: ${errorText(error)}`, timings });
      return false;
    }
    timings.asr = this._elapsed(t0);
    const asrInfo = { model: result.model, device: result.device, language: result.language, durationMs: result.durationMs };
    this.store.setStatus(job.jobId, 'transcribed', { asr: asrInfo, timings });
    jobLog('asr: done');
    return true;
  }

  // Live config + host.spawnWorker, so a Settings change of asr_quant / asr_device takes effect on the next job.
  _asrEngine() {
    if (this.asr) return this.asr;
    return createAsrEngine({ config: this.config, spawnWorker: this.spawnWorker || undefined });
  }

  _metadata(job) {
    const file = path.join(this.store.inboxDir(job.recordingId), 'metadata.json');
    if (!isFile(file)) return {};
    const data = JSON.parse(readText(file));
    return data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {};
  }

  // outbox/transcript.md, the transcript page source. Rebuilt on every run; never fatal.
  _writeTranscriptPage(job, jobLog) {
    const outbox = this.store.outboxDir(job.recordingId);
    const source = path.join(outbox, 'transcript.txt');
    if (!isFile(source)) return;
    try {
      const text = transcriptMarkdown(job.title, this._when(job), readText(source));
      writeText(path.join(outbox, 'transcript.md'), text);
    } catch (error) {
      this.logger.warn(`worker: job ${job.jobId} transcript page failed: ${errorText(error)}`);
      jobLog(`transcript page: failed: ${errorText(error)}`);
    }
  }

  // E.g. "2025-09-20 14:13 · 2:05", in this PC's local time, from metadata, else the job.
  _when(job) {
    let metadata;
    try {
      metadata = this._metadata(job);
    } catch (_error) {
      metadata = {};
    }
    let createdMs;
    let durationMs;
    try {
      createdMs = pyInt(pyTruthy(metadata.createdAt) ? metadata.createdAt : job.createdAtMs);
      const asr = job.asr || {};
      const duration = pyTruthy(metadata.durationMs) ? metadata.durationMs : pyTruthy(asr.durationMs) ? asr.durationMs : 0;
      durationMs = pyInt(duration);
    } catch (_error) {
      createdMs = job.createdAtMs;
      durationMs = 0;
    }
    const parts = [];
    if (createdMs > 0) {
      const date = new Date(createdMs);
      parts.push(
        `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`,
      );
    }
    if (durationMs > 0) {
      const total = pyRound(durationMs / 1000);
      const hours = Math.floor(total / 3600);
      const rest = total % 3600;
      const minutes = Math.floor(rest / 60);
      const seconds = rest % 60;
      parts.push(hours ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${minutes}:${pad2(seconds)}`);
    }
    return parts.join(' · ');
  }

  _photos(inbox) {
    const names = fs.readdirSync(inbox).filter((name) => PHOTO_GLOB.test(name));
    const key = (name) => (process.platform === 'win32' ? name.toLowerCase() : name);
    return names.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  }

  // Write each requested review in its own work folder; a failed one never stops the rest.
  // Returns kind -> failure reason for the reviews that failed.
  async _runReviews(job, jobLog, timings, signal) {
    this.store.setStatus(job.jobId, 'writing', { timings });
    jobLog(`writer: start (${job.reviews.join(', ')})`);
    const work = this.store.workDir(job.jobId);
    const outbox = this.store.outboxDir(job.recordingId);
    const inbox = this.store.inboxDir(job.recordingId);
    const photos = this._photos(inbox);
    const failures = new Map();
    let total = 0;
    for (const kind of job.reviews) {
      const t0 = this.clock();
      try {
        const kindDir = this._prepareReview(job, kind, path.join(work, kind), photos);
        const written = await this.writers.runWriter(kindDir, {
          kind,
          writer: job.writer,
          timeoutS: this.config.writer_timeout_s,
          config: this.config,
          log: jobLog,
          signal,
        });
        this._installReview(job, kind, written);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        const elapsed = this._elapsed(t0);
        total += elapsed;
        this.logger.warn(`worker: job ${job.jobId} writer failed on ${kind}: ${errorText(error)}`);
        jobLog(`writer: ${kind}: failed after ${elapsed} ms: ${errorText(error)}`);
        failures.set(kind, errorText(error));
        continue;
      }
      const elapsed = this._elapsed(t0);
      total += elapsed;
      jobLog(`writer: ${kind}: done in ${elapsed} ms`);
    }
    timings.writer = total;
    const outPhotos = path.join(outbox, 'photos');
    fs.mkdirSync(outPhotos, { recursive: true });
    for (const name of photos) copy2(path.join(inbox, name), path.join(outPhotos, name));
    this.store.setStatus(job.jobId, 'written', { timings });
    jobLog(failures.size ? `writer: done, failed: ${Array.from(failures.keys()).join(', ')}` : 'writer: done');
    return failures;
  }

  // work/<jobId>/<kind>/ with the transcript, metadata, photos and that review's INSTRUCTIONS.md.
  _prepareReview(job, kind, kindDir, photos) {
    const outbox = this.store.outboxDir(job.recordingId);
    const inbox = this.store.inboxDir(job.recordingId);
    fs.mkdirSync(kindDir, { recursive: true });
    const stale = path.join(kindDir, `${kind}.md`);
    if (isFile(stale)) fs.unlinkSync(stale); // a retry must not validate the previous run's output
    for (const name of ['transcript.txt', 'transcript.json']) {
      const source = path.join(outbox, name);
      if (!isFile(source)) throw Object.assign(new Error(`missing ${name}`), { code: 'ENOENT' });
      copy2(source, path.join(kindDir, name));
    }
    const meta = path.join(inbox, 'metadata.json');
    if (isFile(meta)) copy2(meta, path.join(kindDir, 'metadata.json'));
    const photosDir = path.join(kindDir, 'photos');
    fs.mkdirSync(photosDir, { recursive: true });
    for (const name of photos) copy2(path.join(inbox, name), path.join(photosDir, name));
    const text = buildInstructions(kind, job.title, loadPrompt(this.promptsDir, kind), photos, this._metadata(job));
    writeText(path.join(kindDir, 'INSTRUCTIONS.md'), text);
    return kindDir;
  }

  // Copy `<kind>.md` into the outbox, archiving the previous version as `<kind>.<jobId>.md`.
  _installReview(job, kind, written) {
    const outbox = this.store.outboxDir(job.recordingId);
    const dest = path.join(outbox, `${kind}.md`);
    if (isFile(dest)) {
      const prevId = this.store.previousReviewJob(job.recordingId, kind, job.jobId) || job.jobId;
      let archive = path.join(outbox, `${kind}.${prevId}.md`);
      let n = 2;
      while (fs.existsSync(archive)) {
        archive = path.join(outbox, `${kind}.${prevId}-${n}.md`);
        n += 1;
      }
      copy2(dest, archive);
    }
    copy2(written, dest);
  }

  // outbox/<rid>/site in the configured theme, the local view, for a job that does not publish. A
  // failure is logged, never fatal: the Markdown is the recording's real output.
  _buildSite(job, jobLog) {
    const outbox = this.store.outboxDir(job.recordingId);
    let manifest;
    try {
      manifest = publish.build(outbox, { title: job.title || job.recordingId, theme: this.config.theme });
    } catch (error) {
      this.logger.warn(`worker: job ${job.jobId} site build failed: ${errorText(error)}`);
      jobLog(`site: failed: ${errorText(error)}`);
      return;
    }
    jobLog(`site: built ${manifest.pages.join(', ')} (${manifest.theme})`);
  }

  // Build the site from every page whose Markdown exists, then deploy it to the publish folder, in
  // one synchronous step (see publish.js). On failure the job ends in error, after any writer failures.
  _runPublish(job, jobLog, timings, writerError) {
    this.store.setStatus(job.jobId, 'publishing', { timings });
    jobLog('publish: start');
    const outbox = this.store.outboxDir(job.recordingId);
    const t0 = this.clock();
    let reason = '';
    let manifest;
    try {
      manifest = publish.build(outbox, { title: job.title || job.recordingId, theme: this.config.theme });
      jobLog(`site: built ${manifest.pages.join(', ')} (${manifest.theme})`);
      if (job.publishFolder) publish.deploy(path.join(outbox, publish.SITE_DIR), job.publishFolder, jobLog);
      else reason = 'publish folder is not set';
    } catch (error) {
      reason = errorText(error);
    }
    timings.publish = this._elapsed(t0);
    if (reason) {
      this.logger.warn(`worker: job ${job.jobId} publish failed: ${reason}`);
      const error = `publish: ${reason}`;
      this.store.setStatus(job.jobId, 'error', { error: writerError ? `${writerError}\n${error}` : error, timings });
      return false;
    }
    this.store.setStatus(job.jobId, 'published', { timings });
    jobLog(`publish: done (${manifest.pages.join(', ')})`);
    return true;
  }
}

/**
 * The job worker; `new Worker(options)` is the same.
 * @param {{config: object, store: import('./store').JobStore,
 *   logger?: {info: Function, warn: (message: string) => void, error: (message: string, error?: Error) => void},
 *   clock?: () => number, asr?: {transcribe: Function}, writers?: {runWriter: Function},
 *   mailer?: {emailJob: Function}, promptsDir?: string|null, pollMs?: number}} options
 *   logger: r1cord_server.worker's lines (warn = WARNING, error = log.exception); clock: monotonic
 *   milliseconds for step timings (performance.now); asr: an engine (default: createAsrEngine per job,
 *   whisper.cpp; spawnWorker: Electron host transport for the whisper.cpp worker); writers: the writer-CLI
 *   seam (default pipeline/writers); mailer: default mailer.js;
 *   promptsDir: `<config dir>/prompts`, null = the built-in prompts; pollMs: idle poll (2000)
 * @returns {Worker}
 */
function createWorker(options) {
  return new Worker(options);
}

module.exports = { Worker, WorkerStopped, createWorker };
