// Port of tests/test_worker.py: one Vitest case per pytest function (ASR, writers and email stubbed),
// plus the Node-only stop / wake behaviour.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const render = require('../../src/core/render');
const naming = require('../../src/core/naming');
const { defaultConfig, withUpdates } = require('../../src/core/config');
const { JobStore } = require('../../src/core/store');
const { createWorker } = require('../../src/core/worker');
const { DEFAULT_PROMPTS, savePrompt } = require('../../src/core/pipeline/instructions');
const { readText, writeText } = require('../../src/core/pipeline/compat');

const RECORDING_ID = 'rec-worker-1';
const PAGE_ORDER = ['transcript', 'summary', 'outline', 'organized'];

const cleanup = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanup.length) await cleanup.pop()();
});

function tmpPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-worker-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

class FakeAsr {
  constructor() {
    this.calls = [];
    this.fail = false;
  }

  async transcribe(audio, { model, device, language }) {
    this.calls.push([path.basename(audio), model, device, language]);
    if (this.fail) throw new Error('whisper exploded');
    return {
      engine: 'fake',
      model,
      device,
      language: language || 'en',
      durationMs: 1000,
      duration: 1,
      segments: [{ id: 1, start: 0, end: 1, text: 'hello world' }],
      text: 'hello world',
    };
  }
}

class FakeWriters {
  constructor() {
    this.calls = [];
    this.fail = false;
    this.failKinds = new Set();
  }

  async runWriter(workDir, { kind, writer, timeoutS }) {
    const n = this.calls.length + 1;
    const instructions = readText(path.join(workDir, 'INSTRUCTIONS.md'));
    this.calls.push({ work: workDir, kind, writer, timeoutS, instructions });
    if (this.fail || this.failKinds.has(kind)) throw new Error('claude CLI died');
    if (!instructions.includes('Site visit')) throw new Error('writer must receive INSTRUCTIONS.md with the title');
    if (!instructions.includes(`Write ONLY ${kind}.md`)) throw new Error('INSTRUCTIONS.md names another file');
    if (!fs.existsSync(path.join(workDir, 'transcript.txt'))) throw new Error('no transcript.txt');
    writeText(path.join(workDir, `${kind}.md`), `# Site visit\n\n${kind} take ${n}\n`);
    return path.join(workDir, `${kind}.md`);
  }
}

// Kinds whose page is in the publish folder, in page order.
function published(folder) {
  return PAGE_ORDER.filter((kind) => fs.existsSync(path.join(folder, `${kind}.html`)));
}

function cfg(tmp, overrides = {}) {
  return withUpdates(defaultConfig(), {
    datastore: path.join(tmp, 'ds'),
    webdav_folder: path.join(tmp, 'wd'),
    public_url_base: 'https://example.test/files',
    admin_password: 'test-admin-pass1',
    ...overrides,
  });
}

function recordingLogger() {
  const logger = { warnings: [], errors: [], info() {} };
  logger.warn = (message) => logger.warnings.push(message);
  logger.error = (message) => logger.errors.push(message);
  return logger;
}

class Rig {
  constructor() {
    const tmp = tmpPath();
    this.cfg = cfg(tmp);
    this.store = new JobStore(this.cfg);
    cleanup.push(() => this.store.close());
    this.prompts = path.join(tmp, 'prompts');
    this.fakeAsr = new FakeAsr();
    this.fakeWriters = new FakeWriters();
    this.logger = recordingLogger();
    this.worker = this.makeWorker(this.cfg);
  }

  makeWorker(config, options = {}) {
    const worker = createWorker({
      config,
      store: this.store,
      logger: this.logger,
      asr: this.fakeAsr,
      writers: this.fakeWriters,
      promptsDir: this.prompts,
      ...options,
    });
    cleanup.push(() => worker.stop());
    return worker;
  }

  site() {
    return path.join(this.store.outboxDir(RECORDING_ID), 'site');
  }

  stageRecording(recordingId = RECORDING_ID, photos = []) {
    const inbox = this.store.inboxDir(recordingId);
    fs.writeFileSync(path.join(inbox, 'audio.m4a'), 'm4a-bytes');
    for (const name of photos) fs.writeFileSync(path.join(inbox, name), 'jpeg');
    writeText(
      path.join(inbox, 'metadata.json'),
      JSON.stringify({ schemaVersion: 1, id: recordingId, title: 'Site visit', createdAt: 1_758_400_000_000, status: 'SAVED' }),
    );
    return inbox;
  }

  queue(action, { recordingId = RECORDING_ID, photos = [] } = {}) {
    this.stageRecording(recordingId, photos);
    return this.store.processInbox(recordingId, { action });
  }

  queueReviews(reviews, { publish, recordingId = RECORDING_ID }) {
    const inbox = this.stageRecording(recordingId);
    return this.store.importFolder(inbox, { title: null, reviews, publish });
  }

  async run(jobId, worker = this.worker) {
    const rec = this.store.job(jobId);
    expect(rec).not.toBeNull();
    await worker.runJob(rec);
    return this.store.job(jobId);
  }

  log(jobId) {
    return this.store.readLog(jobId).join('\n');
  }
}

async function waitFor(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('worker', () => {
  it('a transcribe-only job completes and builds the local site without publishing', async () => {
    const rig = new Rig();
    const job = rig.queue('transcribe');

    const rec = await rig.run(job.jobId);

    expect(rec.status).toBe('complete');
    expect(rec.error).toBeNull();
    const outbox = rig.store.outboxDir(RECORDING_ID);
    expect(readText(path.join(outbox, 'transcript.txt'))).toBe('hello world\n');
    const page = readText(path.join(outbox, 'transcript.md')); // always written after ASR
    expect(page.startsWith('# Site visit\n')).toBe(true);
    expect(page).toContain('hello world');
    expect(rig.fakeWriters.calls).toEqual([]);
    expect(fs.existsSync(path.join(rig.site(), 'transcript.html'))).toBe(true);
    expect(fs.existsSync(job.publishFolder)).toBe(false); // built here, never deployed
    const log = rig.log(job.jobId);
    for (const line of ['asr: done', 'writer: skipped', 'publish: skipped']) expect(log).toContain(line);
    expect(rig.store.resultJson(job.jobId).webdavUrl).toBeNull();
  });

  it('a review without publish installs the summary and photos and builds the site', async () => {
    const rig = new Rig();
    const job = rig.queue('review', { photos: ['photo-p1.jpg'] });

    const rec = await rig.run(job.jobId);

    expect(rec.status).toBe('complete');
    const outbox = rig.store.outboxDir(RECORDING_ID);
    expect(readText(path.join(outbox, 'summary.md')).startsWith('# Site visit\n')).toBe(true);
    expect(fs.existsSync(path.join(outbox, 'photos', 'photo-p1.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(rig.site(), 'summary.html')) && fs.existsSync(path.join(rig.site(), 'transcript.html'))).toBe(true);
    expect(fs.existsSync(job.publishFolder)).toBe(false); // publish never ran
    expect(rig.store.resultJson(job.jobId).pages).toEqual([]);
    expect(rig.store.resultJson(job.jobId).webdavUrl).toBeNull();
    const call = rig.fakeWriters.calls[0];
    expect(call.timeoutS).toBe(rig.cfg.writer_timeout_s);
    expect(call.work).toBe(path.join(rig.store.workDir(job.jobId), 'summary')); // each review in its own folder
    expect(fs.existsSync(path.join(call.work, 'photos', 'photo-p1.jpg'))).toBe(true);
  });

  it('the publish action deploys the site with the transcript and reviews', async () => {
    const rig = new Rig();
    const job = rig.queue('publish');

    const rec = await rig.run(job.jobId);

    expect(rec.status).toBe('complete');
    const folder = job.publishFolder;
    const result = rig.store.resultJson(job.jobId);
    expect(result.webdavUrl).toBe(naming.webdavUrl(rig.cfg, folder, 'summary.html'));
    expect(result.pages.map((page) => page.kind)).toEqual(['transcript', 'summary']);
    expect(published(folder)).toEqual(['transcript', 'summary']);
    expect(readText(path.join(folder, 'summary.md'))).toBe('# Site visit\n\nsummary take 1\n');
    expect(fs.readFileSync(path.join(folder, 'summary.html')).equals(fs.readFileSync(path.join(rig.site(), 'summary.html')))).toBe(true);
    const log = rig.log(job.jobId);
    expect(log).toContain('publish: wrote summary.html\n');
    expect(log).toContain('publish: done (transcript, summary)');
  });

  it('a failed review does not stop the others and ends in error', async () => {
    const rig = new Rig();
    rig.fakeWriters.failKinds = new Set(['outline']);
    const job = rig.queueReviews(['summary', 'outline'], { publish: true });

    const rec = await rig.run(job.jobId);

    expect(rec.status).toBe('error');
    expect(rec.error.startsWith('writer: outline: ')).toBe(true);
    expect(rec.error).not.toContain('summary');
    const outbox = rig.store.outboxDir(RECORDING_ID);
    expect(fs.existsSync(path.join(outbox, 'summary.md'))).toBe(true);
    expect(fs.existsSync(path.join(outbox, 'outline.md'))).toBe(false);
    expect(published(job.publishFolder)).toEqual(['transcript', 'summary']); // published what succeeded
    const result = rig.store.resultJson(job.jobId);
    expect(result.reviews).toEqual(['summary', 'outline']);
    expect(result.pages.map((page) => page.kind)).toEqual(['transcript', 'summary']);
    const log = rig.log(job.jobId);
    expect(log).toContain('writer: summary: done in');
    expect(log).toContain('writer: outline: failed');
    expect(rig.logger.warnings).toHaveLength(1);
    expect(rig.logger.warnings[0]).toContain(job.jobId);
    expect(rig.logger.warnings[0]).toContain('outline');
  });

  it('an edited prompt reaches the instructions', async () => {
    const rig = new Rig();
    savePrompt(rig.prompts, 'organized', 'Keep every word the speaker said about fences.');
    const job = rig.queueReviews(['summary', 'organized'], { publish: false });

    await rig.run(job.jobId);

    const byKind = Object.fromEntries(rig.fakeWriters.calls.map((call) => [call.kind, call.instructions]));
    expect(byKind.organized).toContain('Keep every word the speaker said about fences.');
    expect(byKind.summary).not.toContain('Keep every word the speaker said about fences.');
    expect(byKind.summary).toContain(DEFAULT_PROMPTS.summary.trim());
  });

  it('add review skips ASR and publishes like the latest job', async () => {
    const rig = new Rig();
    const first = rig.queue('publish');
    await rig.run(first.jobId);

    const added = rig.store.addReview(RECORDING_ID, 'organized');
    const rec = await rig.run(added.jobId);

    expect(rec.status).toBe('complete');
    expect(rig.fakeAsr.calls).toHaveLength(1);
    expect(rig.fakeWriters.calls.map((call) => call.kind)).toEqual(['summary', 'organized']);
    expect(published(first.publishFolder)).toEqual(['transcript', 'summary', 'organized']);
    expect(rig.store.resultJson(added.jobId).pages.map((page) => page.kind)).toEqual(['transcript', 'summary', 'organized']);
  });

  it('an only-publish retry skips ASR and writer and republishes every page', async () => {
    const rig = new Rig();
    const job = rig.queueReviews(['summary', 'outline'], { publish: false });
    await rig.run(job.jobId);
    expect(rig.fakeAsr.calls.length && rig.fakeWriters.calls.length).toBeTruthy();
    fs.unlinkSync(path.join(rig.store.outboxDir(RECORDING_ID), 'transcript.md')); // rebuilt from transcript.txt
    rig.store.retryPublish(job.jobId);

    const rec = await rig.run(job.jobId);

    expect(rec.status).toBe('complete');
    expect(rig.fakeAsr.calls).toHaveLength(1);
    expect(rig.fakeWriters.calls).toHaveLength(2); // not re-run
    expect(published(job.publishFolder)).toEqual(['transcript', 'summary', 'outline']);
  });

  it('retry writer skips ASR and uses the new writer', async () => {
    const rig = new Rig();
    const job = rig.queue('review');
    await rig.run(job.jobId);
    rig.store.retryWriter(job.jobId, 'codex', ['outline']);

    const rec = await rig.run(job.jobId);

    expect(rec.status).toBe('complete');
    expect(rec.writer).toBe('codex');
    expect(rec.reviews).toEqual(['outline']);
    expect(rig.fakeAsr.calls).toHaveLength(1);
    const last = rig.fakeWriters.calls.at(-1);
    expect([last.writer, last.kind]).toEqual(['codex', 'outline']);
  });

  it('writer none completes with a skipped-writer log', async () => {
    const rig = new Rig();
    const job = rig.queue('transcribe');
    rig.store.setStatus(job.jobId, 'queued', { writer: 'none', reviews: ['summary'] });

    const rec = await rig.run(job.jobId);

    expect(rec.status).toBe('complete');
    expect(rig.fakeWriters.calls).toEqual([]);
    expect(rig.log(job.jobId)).toContain('writer: skipped');
  });

  it('retry writer rewrites the review and archives the previous one', async () => {
    const rig = new Rig();
    const job = rig.queue('review');
    await rig.run(job.jobId);
    const outbox = rig.store.outboxDir(RECORDING_ID);
    const first = readText(path.join(outbox, 'summary.md'));

    rig.store.retryWriter(job.jobId, 'codex');
    const rec = await rig.run(job.jobId);

    expect(rec.status).toBe('complete');
    expect(readText(path.join(outbox, `summary.${job.jobId}.md`))).toBe(first);
    expect(readText(path.join(outbox, 'summary.md'))).not.toBe(first);

    // A later job rewriting it names the archive after the job that wrote the replaced copy.
    const second = readText(path.join(outbox, 'summary.md'));
    const added = rig.store.addReview(RECORDING_ID, 'summary');
    await rig.run(added.jobId);
    expect(readText(path.join(outbox, `summary.${job.jobId}-2.md`))).toBe(second);
  });

  it('an ASR failure sets a step-prefixed error and leaves no transcript', async () => {
    const rig = new Rig();
    rig.fakeAsr.fail = true;
    const job = rig.queue('review');

    const rec = await rig.run(job.jobId);

    expect(rec.status).toBe('error');
    expect(rec.error.startsWith('asr:')).toBe(true);
    expect(rec.error).toContain('whisper exploded');
    expect(fs.existsSync(path.join(rig.store.outboxDir(RECORDING_ID), 'transcript.txt'))).toBe(false);
    expect(rig.fakeWriters.calls).toEqual([]);
    expect(rig.logger.warnings).toHaveLength(1);
    expect(rig.logger.warnings[0]).toContain(job.jobId);
    expect(rig.logger.warnings[0]).toContain('asr');
  });

  it('a writer failure keeps the transcript', async () => {
    const rig = new Rig();
    rig.fakeWriters.fail = true;
    const job = rig.queue('review');

    const rec = await rig.run(job.jobId);

    expect(rec.status).toBe('error');
    expect(rec.error.startsWith('writer:')).toBe(true);
    expect(rec.error).toContain('claude CLI died');
    expect(fs.existsSync(path.join(rig.store.outboxDir(RECORDING_ID), 'transcript.txt'))).toBe(true);
    expect(fs.existsSync(path.join(rig.store.outboxDir(RECORDING_ID), 'summary.md'))).toBe(false);
    expect(rig.logger.warnings).toHaveLength(1);
    expect(rig.logger.warnings[0]).toContain(job.jobId);
    expect(rig.logger.warnings[0]).toContain('writer');
  });

  it('a publish failure keeps the summary and the local site', async () => {
    const rig = new Rig();
    const job = rig.queue('publish');
    vi.spyOn(render, 'deploySite').mockImplementation(() => {
      throw Object.assign(new Error('WebDAV mount is gone'), { code: 'EIO' });
    });

    const rec = await rig.run(job.jobId);

    expect(rec.status).toBe('error');
    expect(rec.error.startsWith('publish:')).toBe(true);
    expect(rec.error).toContain('WebDAV mount is gone');
    const summary = path.join(rig.store.outboxDir(RECORDING_ID), 'summary.md');
    expect(readText(summary).startsWith('# Site visit\n')).toBe(true);
    expect(fs.existsSync(path.join(rig.site(), 'summary.html'))).toBe(true); // the local view still has it
    expect(rig.logger.warnings).toHaveLength(1);
    expect(rig.logger.warnings[0]).toContain(job.jobId);
    expect(rig.logger.warnings[0]).toContain('publish');
  });

  it('a missing audio file errors the ASR step', async () => {
    const rig = new Rig();
    const job = rig.queue('review');
    fs.unlinkSync(path.join(rig.store.inboxDir(RECORDING_ID), 'audio.m4a'));

    const rec = await rig.run(job.jobId);

    expect(rec.status).toBe('error');
    expect(rec.error).toBe('asr: no audio file in inbox');
    expect(rig.fakeAsr.calls).toEqual([]);
    expect(rig.logger.warnings).toHaveLength(1);
    expect(rig.logger.warnings[0]).toContain(job.jobId);
  });

  it('only-publish with nothing to publish errors the publish step', async () => {
    const rig = new Rig();
    const job = rig.queue('review');
    await rig.run(job.jobId);
    const outbox = rig.store.outboxDir(RECORDING_ID);
    for (const name of ['summary.md', 'transcript.md', 'transcript.txt']) fs.unlinkSync(path.join(outbox, name));
    rig.store.setStatus(job.jobId, 'queued', { onlyPublish: true, skipAsr: true });

    const rec = await rig.run(job.jobId);

    expect(rec.status).toBe('error');
    expect(rec.error).toBe('publish: nothing to publish (no transcript or AI review yet)');
    expect(rig.fakeAsr.calls).toHaveLength(1); // first pass only
    expect(rig.logger.warnings).toHaveLength(1);
    expect(rig.logger.warnings[0]).toContain(job.jobId);
    expect(rig.logger.warnings[0]).toContain('publish');
  });

  it('only-publish without a folder errors the publish step', async () => {
    const rig = new Rig();
    const job = rig.queue('review');
    await rig.run(job.jobId);
    rig.store.setStatus(job.jobId, 'queued', { onlyPublish: true, skipAsr: true, publishFolder: '' });

    const rec = await rig.run(job.jobId);

    expect(rec.status).toBe('error');
    expect(rec.error).toBe('publish: publish folder is not set');
    expect(rig.logger.warnings).toHaveLength(1);
    expect(rig.logger.warnings[0]).toContain(job.jobId);
  });

  it('a worker crash is recorded as error', async () => {
    const rig = new Rig();
    const job = rig.queue('review');
    rig.store.appendLog = () => {
      throw new Error('db gone');
    };
    const crashWorker = rig.makeWorker(rig.cfg, { promptsDir: null });
    crashWorker.start();
    let rec;
    try {
      rec = await waitFor(() => {
        const current = rig.store.job(job.jobId);
        return current && current.status === 'error' ? current : null;
      });
    } finally {
      await crashWorker.stop();
    }

    expect(rec.status).toBe('error');
    expect(rec.error).toBe('worker: db gone');
    expect(rig.logger.errors.some((line) => line.includes(`worker crashed on job ${job.jobId}`))).toBe(true);
  });

  it('email is sent only when enabled and complete', async () => {
    const rig = new Rig();
    const sent = [];
    const mailer = {
      async emailJob(_store, config, jobId) {
        sent.push([jobId, config.email_enabled]);
        return 'mid-1';
      },
    };
    rig.worker = rig.makeWorker(rig.cfg, { mailer });
    const job = rig.queue('review');

    // Disabled in the default config: a complete job never triggers a send.
    await rig.run(job.jobId);
    await rig.worker.emailIfComplete(job.jobId);
    expect(sent).toEqual([]);

    const emailing = rig.makeWorker(withUpdates(rig.cfg, { email_enabled: true, email_to: 'me@example.test' }), { mailer });
    await emailing.emailIfComplete(job.jobId);
    expect(sent).toEqual([[job.jobId, true]]);

    // An errored job is never emailed even when enabled.
    const failing = rig.queue('transcribe', { recordingId: 'rec-worker-2' });
    rig.fakeAsr.fail = true;
    await emailing.runJob(rig.store.job(failing.jobId));
    await emailing.emailIfComplete(failing.jobId);
    expect(sent).toHaveLength(1);
  });

  it('an email failure is logged to the job without a status change', async () => {
    const rig = new Rig();
    const mailer = {
      async emailJob() {
        throw new Error('smtp down');
      },
    };
    const emailingWorker = rig.makeWorker(withUpdates(rig.cfg, { email_enabled: true, email_to: 'me@example.test' }), { mailer });
    const job = rig.queue('review');
    await rig.run(job.jobId);

    await emailingWorker.emailIfComplete(job.jobId);

    expect(rig.store.job(job.jobId).status).toBe('complete'); // email failure never changes status
    expect(rig.log(job.jobId)).toContain('email: failed: smtp down');
    expect(rig.logger.warnings).toHaveLength(1);
    expect(rig.logger.warnings[0]).toContain(job.jobId);
    expect(rig.logger.warnings[0]).toContain('email');
  });

  // --- Node-only ------------------------------------------------------------------------------

  it('stop() aborts the running job and leaves it for startup recovery', async () => {
    const rig = new Rig();
    let started = false;
    rig.fakeAsr.transcribe = (_audio, { signal }) =>
      new Promise((_resolve, reject) => {
        started = true;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    const job = rig.queue('review');
    rig.worker.start();
    await waitFor(() => started);

    await rig.worker.stop();

    expect(rig.worker.running).toBe(false);
    expect(rig.store.job(job.jobId).status).toBe('transcribing'); // not an error: nothing failed
    expect(rig.logger.errors).toEqual([]);
    expect(rig.store.recoverInterrupted()).toEqual([[job.jobId, 'transcribing', 'queued']]);
  });

  it('the loop runs queued jobs in order and wake() starts one without waiting for the poll', async () => {
    const rig = new Rig();
    const worker = rig.makeWorker(rig.cfg, { pollMs: 60_000 });
    const first = rig.queue('transcribe', { recordingId: 'rec-a' });
    const second = rig.queue('transcribe', { recordingId: 'rec-b' });
    worker.start();
    await waitFor(() => rig.store.job(second.jobId).status === 'complete');
    expect(rig.store.job(first.jobId).status).toBe('complete');
    expect(rig.fakeAsr.calls).toHaveLength(2);

    const later = rig.queue('transcribe', { recordingId: 'rec-c' }); // the loop is idle for a minute now
    worker.wake();
    await waitFor(() => rig.store.job(later.jobId).status === 'complete', 3000);
  });
});
