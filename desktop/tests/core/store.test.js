// Port of tests/test_store.py: one Vitest case per pytest function, same scenarios and assertions.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const { defaultConfig, withUpdates } = require('../../src/core/config');
const { ValueError } = require('../../src/core/errors');
const {
  ACTIVE_STATUSES,
  AudioMismatch,
  HashMismatch,
  Incomplete,
  JobActive,
  JobNotUploading,
  JobStore,
  OffsetMismatch,
  RetryNotAllowed,
  StoreError,
  TooLarge,
  UnknownJob,
  hashToken,
  utcnowIso,
} = require('../../src/core/store');

const cleanup = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()();
});

function tmpPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-store-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cfg(tmp) {
  return withUpdates(defaultConfig(), {
    datastore: path.join(tmp, 'ds'),
    webdav_folder: path.join(tmp, 'wd'),
    public_url_base: 'https://example.test/files',
    admin_password: 'test-admin-pass1',
  });
}

function openStore(config, options) {
  const store = new JobStore(config, options);
  cleanup.push(() => store.close());
  return store;
}

// A second connection to the store's database, for the rows the Python tests edit through store._conn.
function sql(config, statement, ...params) {
  const db = new DatabaseSync(path.join(config.datastore, 'index.sqlite'));
  try {
    return db.prepare(statement).all(...params);
  } finally {
    db.close();
  }
}

function audioSpec(data, name = 'audio.m4a') {
  const bytes = Buffer.from(data);
  return [{ name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }, bytes];
}

function request(recordingId, spec, title = 'Site visit') {
  return { recordingId, createdAtMs: 1_758_400_000_000, title, reviews: ['summary'], publish: true, files: [spec] };
}

function validRequest(spec, overrides = {}) {
  return {
    recordingId: 'rec-v',
    createdAtMs: 1_758_400_000_000,
    title: 'Site visit',
    reviews: ['summary'],
    publish: false,
    files: [spec],
    ...overrides,
  };
}

// pytest.raises(ErrorClass, match=pattern): returns the error for field checks.
function raises(ErrorClass, fn, pattern) {
  let caught = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected ${ErrorClass.name}`).toBeInstanceOf(ErrorClass);
  if (pattern !== undefined) expect(caught.message).toMatch(pattern);
  return caught;
}

// A clock that hands out the next stamp on every call (monkeypatching utcnow_iso in Python).
function stamps(format) {
  let index = 0;
  return () => format(index++);
}

const pad = (value) => String(value).padStart(2, '0');

function finishedJob(store, recordingId, status) {
  const [spec, data] = audioSpec('retry-audio');
  const rec = store.createJob(validRequest(spec, { recordingId }), { id: recordingId });
  store.appendFile(rec.jobId, spec.name, 0, [data]);
  store.commit(rec.jobId);
  if (status !== 'queued') store.setStatus(rec.jobId, status, { error: status === 'error' ? 'boom' : null });
  return rec;
}

// Another job for a recording whose audio is already here: nothing to upload, commit directly.
function rerun(store, recordingId, status) {
  const [spec] = audioSpec('retry-audio');
  const rec = store.createJob(validRequest(spec, { recordingId }), { id: recordingId });
  store.commit(rec.jobId);
  store.setStatus(rec.jobId, status);
  return rec;
}

function writeDrop(folder, recordingId, { title = 'Dropped', created = 1758400000000 } = {}) {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'audio.wav'), 'imported-audio');
  fs.writeFileSync(
    path.join(folder, 'metadata.json'),
    JSON.stringify({ schemaVersion: 1, id: recordingId, title, createdAt: created }),
    'utf8',
  );
}

describe('JobStore', () => {
  it('pair_code_single_use_and_expiry', () => {
    const config = cfg(tmpPath());
    const store = openStore(config);
    const code = store.createPairCode();
    expect(code).toMatch(/^\d{6}$/);
    const token = store.redeemPairCode(code, 'device');
    expect(token).not.toBeNull();
    expect(token).toHaveLength(64);
    expect(store.tokenValid(token)).toBe(true);
    expect(store.redeemPairCode(code, 'device')).toBeNull();

    const expired = store.createPairCode();
    sql(config, "UPDATE pair_codes SET expires_at = '2000-01-01T00:00:00Z' WHERE code = ?", expired);
    expect(store.redeemPairCode(expired, 'device')).toBeNull();
    expect(store.tokenValid('0'.repeat(64))).toBe(false);
  });

  it('job_active_and_reuse_after_complete', () => {
    const store = openStore(cfg(tmpPath()));
    const [spec, data] = audioSpec('audio-bytes-01');
    const rec = store.createJob(request('rec-1', spec), { id: 'rec-1', title: 'Site visit' });
    const active = raises(JobActive, () => store.createJob(request('rec-1', spec), { id: 'rec-1' }));
    expect(active.jobId).toBe(rec.jobId);

    store.appendFile(rec.jobId, spec.name, 0, [data]);
    const queued = store.commit(rec.jobId);
    expect(queued.status).toBe('queued');
    store.setStatus(rec.jobId, 'complete');

    const again = store.createJob(request('rec-1', spec), { id: 'rec-1', title: 'Site visit' });
    expect(again.jobId).not.toBe(rec.jobId);
    expect(again.status).toBe('uploading');
    expect(store.fileReceived(again.jobId, spec.name)).toBe(spec.size);
    const committed = store.commit(again.jobId);
    expect(committed.status).toBe('queued');
  });

  it('audio_mismatch', () => {
    const store = openStore(cfg(tmpPath()));
    const [spec, data] = audioSpec('original-audio');
    const rec = store.createJob(request('rec-2', spec), { id: 'rec-2' });
    store.appendFile(rec.jobId, spec.name, 0, [data]);
    store.commit(rec.jobId);
    store.setStatus(rec.jobId, 'complete');

    const [other] = audioSpec('different-audio');
    raises(AudioMismatch, () => store.createJob(request('rec-2', other), { id: 'rec-2' }));
  });

  it('append_offset_and_hash_mismatch_deletes_partial', () => {
    const store = openStore(cfg(tmpPath()));
    const data = Buffer.from('abcdefghij');
    const [spec] = audioSpec(data);
    const rec = store.createJob(request('rec-3', spec), { id: 'rec-3' });
    expect(store.fileReceived(rec.jobId, spec.name)).toBe(0);

    store.appendFile(rec.jobId, spec.name, 0, [data.subarray(0, 4)]);
    expect(store.fileReceived(rec.jobId, spec.name)).toBe(4);
    const mismatch = raises(OffsetMismatch, () => store.appendFile(rec.jobId, spec.name, 0, [Buffer.from('xxxx')]));
    expect(mismatch.received).toBe(4);

    store.appendFile(rec.jobId, spec.name, 4, [Buffer.from('XXXXXX')]);
    expect(store.fileReceived(rec.jobId, spec.name)).toBe(10);
    const hashed = raises(HashMismatch, () => store.commit(rec.jobId));
    expect(hashed.files).toContain(spec.name);
    const partial = path.join(store.inboxDir('rec-3'), '.upload', `${spec.name}.partial`);
    expect(fs.existsSync(partial)).toBe(false);
    expect(store.fileReceived(rec.jobId, spec.name)).toBe(0);

    store.appendFile(rec.jobId, spec.name, 0, [data.subarray(0, 3)]);
    raises(Incomplete, () => store.commit(rec.jobId));
  });

  it('import_folder', () => {
    const tmp = tmpPath();
    const store = openStore(cfg(tmp));
    const src = path.join(tmp, 'drop');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'audio.wav'), 'imported-audio');
    fs.writeFileSync(
      path.join(src, 'metadata.json'),
      '{"schemaVersion":1,"id":"rec-drop","title":"Dropped","createdAt":1758400000000}',
      'utf8',
    );
    const rec = store.importFolder(src, { title: null, reviews: ['summary'], publish: false });
    expect(rec.recordingId).toBe('rec-drop');
    expect(rec.status).toBe('queued');
    expect(rec.title).toBe('Dropped');
    expect(rec.publish).toBe(false);
    expect(fs.statSync(path.join(store.inboxDir('rec-drop'), 'audio.wav')).isFile()).toBe(true);
  });

  // --- create_job validation ---------------------------------------------------

  it('create_job_rejects_bad_requests', () => {
    const tmp = tmpPath();
    const store = openStore(cfg(tmp));
    const [spec] = audioSpec('valid-audio');
    const [other] = audioSpec('other-audio', 'audio.wav');
    const zeros = '0'.repeat(64);
    const cases = [
      ['empty title', validRequest(spec, { title: '   ' }), 'title'],
      ['long title', validRequest(spec, { title: 'x'.repeat(121) }), 'title'],
      ['unknown review', validRequest(spec, { reviews: ['summary', 'poem'] }), 'unknown review'],
      ['empty recording id', validRequest(spec, { recordingId: '' }), 'recordingId'],
      ['slash in id', validRequest(spec, { recordingId: 'a/b' }), 'recordingId'],
      ['backslash in id', validRequest(spec, { recordingId: 'a\\b' }), 'recordingId'],
      ['dotdot id', validRequest(spec, { recordingId: '..' }), 'recordingId'],
      ['padded id', validRequest(spec, { recordingId: ' rec' }), 'recordingId'],
      ['empty manifest', validRequest(spec, { files: [] }), 'manifest'],
      ['duplicate name', validRequest(spec, { files: [spec, spec] }), 'duplicate'],
      ['stray file', validRequest(spec, { files: [spec, { name: 'notes.txt', size: 1, sha256: zeros }] }), 'not allowed'],
      ['bad photo ext', validRequest(spec, { files: [spec, { name: 'photo-x.png', size: 1, sha256: zeros }] }), 'not allowed'],
      ['negative size', validRequest(spec, { files: [{ name: 'audio.m4a', size: -1, sha256: zeros }] }), 'size'],
      ['short sha', validRequest(spec, { files: [{ name: 'audio.m4a', size: 4, sha256: '0'.repeat(63) }] }), 'sha256'],
      ['non-hex sha', validRequest(spec, { files: [{ name: 'audio.m4a', size: 4, sha256: 'z'.repeat(64) }] }), 'sha256'],
      ['two audios', validRequest(spec, { files: [spec, other] }), 'exactly one'],
    ];
    for (const [name, req, fragment] of cases) {
      raises(ValueError, () => store.createJob(req, { id: req.recordingId }), fragment);
      expect(fs.existsSync(path.join(cfg(tmp).datastore, 'rec-v')), name).toBe(false);
    }
  });

  it('dotdot_recording_id_cannot_escape_inbox', () => {
    const tmp = tmpPath();
    const store = openStore(cfg(tmp));
    const [spec] = audioSpec('escape-attempt');
    raises(ValueError, () => store.createJob(validRequest(spec, { recordingId: '..' }), { id: '..' }), 'recordingId');
    // Nothing may land outside inbox/: the datastore root itself must stay clean.
    expect(fs.existsSync(path.join(tmp, 'ds', 'metadata.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'ds', 'audio.m4a'))).toBe(false);
  });

  it('inbox_and_outbox_dirs_reject_escaping_ids', () => {
    const store = openStore(cfg(tmpPath()));
    for (const bad of ['..', 'a/b', 'a\\b', ' rec', '']) {
      raises(ValueError, () => store.inboxDir(bad), 'recordingId');
      raises(ValueError, () => store.outboxDir(bad), 'recordingId');
    }
  });

  // Node only (Python lets these through): ids Windows would read as something other than a folder
  // of that name: a drive or alternate data stream (":"), a device, or a name with its dot dropped.
  it('recording_ids_windows_would_reinterpret_are_rejected', () => {
    const tmp = tmpPath();
    const store = openStore(cfg(tmp));
    const [spec] = audioSpec('reserved-audio');
    const bad = [
      'a:b', 'C:x', 'rec:stream:$DATA', 'CON', 'con', 'Nul.txt', 'aux.tar.gz', 'PRN', 'COM1', 'com0',
      'LPT9.log', 'COM\u00b9', 'lpt\u00b3.x', 'NUL .txt', 'CONIN$', 'conout$.x', 'rec.', 'rec. .',
      'a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b', 'a\x01b', 'a\tb', 'a\nb', 'a\x1fb',
    ];
    for (const id of bad) {
      raises(ValueError, () => store.inboxDir(id), 'recordingId');
      raises(ValueError, () => store.outboxDir(id), 'recordingId');
      raises(ValueError, () => store.createJob(validRequest(spec, { recordingId: id }), { id }), 'recordingId');
      raises(ValueError, () => store.addReview(id, 'summary'), 'recordingId');
      raises(ValueError, () => store.deleteRecording(id), 'recordingId');
    }
    const drop = path.join(tmp, 'drop');
    writeDrop(drop, 'rec:x');
    raises(ValueError, () => store.importFolder(drop, { title: null, reviews: [], publish: false }), 'recordingId');
    expect(fs.readdirSync(path.join(tmp, 'ds', 'inbox'))).toEqual([]);
    expect(fs.readdirSync(path.join(tmp, 'ds', 'outbox'))).toEqual([]);
    expect(store.recentJobs()).toEqual([]);

    // Names that only look alike stay valid.
    for (const id of ['CONTOSO', 'console-1', 'com10', 'nul-2', 'lpt', 'auxiliary.x', 'rec.a', 'a.con', 'rec-CON']) {
      expect(fs.statSync(store.inboxDir(id)).isDirectory()).toBe(true);
    }
  });

  // --- job lifecycle -------------------------------------------------------------

  it.each(ACTIVE_STATUSES)('active_job_blocks_new_job_until_terminal[%s]', (status) => {
    const store = openStore(cfg(tmpPath()));
    const [spec, data] = audioSpec('lifecycle-audio');
    const rec = store.createJob(validRequest(spec), { id: 'rec-v' });
    if (status !== 'uploading') {
      store.appendFile(rec.jobId, spec.name, 0, [data]);
      store.commit(rec.jobId);
      store.setStatus(rec.jobId, status);
    }
    expect(store.hasActiveJobs()).toBe(true);
    const active = store.activeJobFor('rec-v');
    expect(active).not.toBeNull();
    expect(active.jobId).toBe(rec.jobId);
    const error = raises(JobActive, () => store.createJob(validRequest(spec), { id: 'rec-v' }));
    expect(error.jobId).toBe(rec.jobId);

    store.setStatus(rec.jobId, 'error', { error: 'boom' });
    expect(store.hasActiveJobs()).toBe(false);
    expect(store.activeJobFor('rec-v')).toBeNull();
    const again = store.createJob(validRequest(spec), { id: 'rec-v' });
    expect(again.jobId).not.toBe(rec.jobId);
  });

  // The webdav URL is stable across jobs; result.json history feeds the worker's
  // summary.<jobId>.md archive naming for earlier summaries.
  it('second_job_reuses_publish_folder_and_keeps_history', () => {
    const store = openStore(cfg(tmpPath()));
    const [spec, data] = audioSpec('reuse-audio');
    const first = store.createJob(validRequest(spec, { publish: true }), { id: 'rec-v' });
    store.appendFile(first.jobId, spec.name, 0, [data]);
    store.commit(first.jobId);
    store.setStatus(first.jobId, 'complete');

    const second = store.createJob(validRequest(spec, { publish: true }), { id: 'rec-v' });
    expect(second.publishFolder).toBe(first.publishFolder);
    expect(second.webdavUrl).toBe(first.webdavUrl);

    const result = store.resultJson(second.jobId);
    expect(result.history.map((entry) => entry.jobId)).toEqual([first.jobId, second.jobId]);
    const [firstEntry, secondEntry] = result.history;
    expect(firstEntry.status).toBe('complete');
    expect(firstEntry.finishedAt).toBeTruthy();
    expect(secondEntry.finishedAt).toBeNull();
  });

  it('set_status_transitions_timings_and_asr', () => {
    const store = openStore(cfg(tmpPath()));
    const [spec, data] = audioSpec('timings-audio');
    const rec = store.createJob(validRequest(spec), { id: 'rec-v' });
    store.appendFile(rec.jobId, spec.name, 0, [data]);
    store.commit(rec.jobId);

    raises(UnknownJob, () => store.setStatus('no-such-job', 'queued'));

    store.setStatus(rec.jobId, 'transcribed', {
      asr: { model: 'large-v3-turbo', device: 'cuda', language: 'en', duration_s: 10 },
    });
    let job = store.job(rec.jobId);
    expect(job).not.toBeNull();
    expect(job.error).toBeNull();
    expect(job.finishedAt).toBeNull();
    const result = store.resultJson(rec.jobId);
    expect(result.asr).toEqual({ model: 'large-v3-turbo', device: 'cuda', language: 'en' });

    store.setStatus(rec.jobId, 'error', { error: 'writer: nope' });
    job = store.job(rec.jobId);
    expect(job.error).toBe('writer: nope');
    expect(job.finishedAt).not.toBeNull();

    store.setStatus(rec.jobId, 'queued');
    job = store.job(rec.jobId);
    expect(job.error).toBeNull();
    expect(job.finishedAt).toBeNull();

    store.setStatus(rec.jobId, 'complete', { timings: { asr: 11, writer: 22, publish: 33 } });
    job = store.job(rec.jobId);
    expect(job.finishedAt).not.toBeNull();
    expect(job.timings).toEqual({ asr: 11, writer: 22, publish: 33 });
    expect(store.resultJson(rec.jobId).timingsMs).toEqual({ asr: 11, writer: 22, publish: 33 });
  });

  it('result_json_written_to_outbox', () => {
    const tmp = tmpPath();
    const store = openStore(cfg(tmp));
    const [spec] = audioSpec('result-audio');
    const rec = store.createJob(validRequest(spec, { publish: false }), { id: 'rec-v' });
    const outbox = path.join(tmp, 'ds', 'outbox', 'rec-v', 'result.json');
    expect(fs.statSync(outbox).isFile()).toBe(true);
    expect(JSON.parse(fs.readFileSync(outbox, 'utf8')).jobId).toBe(rec.jobId);
    store.setStatus(rec.jobId, 'queued');
    expect(JSON.parse(fs.readFileSync(outbox, 'utf8')).status).toBe('queued');
    const result = store.resultJson(rec.jobId);
    expect(result.webdavUrl).toBeNull(); // publish=False gates the URL
  });

  it('recent_jobs_ordering_with_clock', () => {
    const store = openStore(cfg(tmpPath()), { clock: stamps((i) => `2026-01-01T00:00:${pad(i)}Z`) });
    const [spec] = audioSpec('order-audio');
    const a = store.createJob(validRequest(spec, { recordingId: 'rec-a' }), { id: 'rec-a' });
    const b = store.createJob(validRequest(spec, { recordingId: 'rec-b' }), { id: 'rec-b' });
    expect(store.recentJobs().map((job) => job.jobId)).toEqual([b.jobId, a.jobId]);
    store.setStatus(a.jobId, 'queued');
    expect(store.recentJobs().map((job) => job.jobId)).toEqual([a.jobId, b.jobId]);
  });

  it('next_queued_is_fifo_even_with_equal_created_at', () => {
    const store = openStore(cfg(tmpPath()));
    const [spec, data] = audioSpec('fifo-audio');
    const first = store.createJob(validRequest(spec, { recordingId: 'rec-a' }), { id: 'rec-a' });
    const second = store.createJob(validRequest(spec, { recordingId: 'rec-b' }), { id: 'rec-b' });
    expect(store.nextQueued()).toBeNull();
    store.appendFile(first.jobId, spec.name, 0, [data]);
    store.appendFile(second.jobId, spec.name, 0, [data]);
    store.commit(first.jobId);
    store.commit(second.jobId);
    expect(store.nextQueued()).not.toBeNull();
    expect(store.nextQueued().jobId).toBe(first.jobId);
  });

  it('recordings_index_latest_job_and_publish_gate', () => {
    const store = openStore(cfg(tmpPath()), { clock: stamps((i) => `2026-01-01T00:00:${pad(i)}Z`) });
    const [spec, data] = audioSpec('index-audio');
    const pub = store.createJob(validRequest(spec, { recordingId: 'rec-pub', publish: true }), { id: 'rec-pub' });
    store.appendFile(pub.jobId, spec.name, 0, [data]);
    store.commit(pub.jobId);
    store.setStatus(pub.jobId, 'complete');
    store.createJob(validRequest(spec, { recordingId: 'rec-priv', publish: false }), { id: 'rec-priv' });

    const index = store.recordingsIndex();
    expect(index.map((entry) => entry.recordingId)).toEqual(['rec-priv', 'rec-pub']); // newest first
    const byId = Object.fromEntries(index.map((entry) => [entry.recordingId, entry]));
    expect(byId['rec-pub'].webdavUrl).not.toBeNull();
    expect(byId['rec-pub'].status).toBe('complete');
    expect(byId['rec-priv'].webdavUrl).toBeNull(); // publish=False hides the URL
  });

  // --- upload guards -------------------------------------------------------------

  it('append_too_large_rolls_back_and_rejects_after_commit', () => {
    const store = openStore(cfg(tmpPath()));
    const data = Buffer.from('0123456789');
    const [spec] = audioSpec(data);
    const rec = store.createJob(validRequest(spec), { id: 'rec-v' });

    expect(store.fileReceived(rec.jobId, 'bogus.txt')).toBeNull();
    store.appendFile(rec.jobId, spec.name, 0, [data.subarray(0, 4)]);
    const tooLarge = raises(TooLarge, () => store.appendFile(rec.jobId, spec.name, 4, [Buffer.alloc(100, 'x')]));
    expect(tooLarge.size).toBe(data.length);
    expect(store.fileReceived(rec.jobId, spec.name)).toBe(4); // rolled back to the offset

    store.appendFile(rec.jobId, spec.name, 4, [data.subarray(4)]);
    expect(store.appendFile(rec.jobId, spec.name, data.length, [])).toBe(data.length);
    raises(TooLarge, () => store.appendFile(rec.jobId, spec.name, data.length, [Buffer.from('extra')]));

    store.commit(rec.jobId);
    raises(JobNotUploading, () => store.appendFile(rec.jobId, spec.name, data.length, []));
  });

  // --- retries ---------------------------------------------------------------------

  it('retry_writer_refusals', () => {
    const store = openStore(cfg(tmpPath()));
    raises(UnknownJob, () => store.retryWriter('no-such-job', null));

    const queued = finishedJob(store, 'rec-q', 'queued');
    raises(RetryNotAllowed, () => store.retryWriter(queued.jobId, 'codex'), 'status queued');

    const complete = finishedJob(store, 'rec-c', 'complete');
    raises(RetryNotAllowed, () => store.retryWriter(complete.jobId, 'codex'), 'transcript.txt is missing');

    fs.writeFileSync(path.join(store.outboxDir('rec-c'), 'transcript.txt'), 'hello', 'utf8');
    raises(RetryNotAllowed, () => store.retryWriter(complete.jobId, 'none'), 'invalid writer');
    raises(RetryNotAllowed, () => store.retryWriter(complete.jobId, 'bogus'), 'invalid writer');
  });

  it('retry_writer_from_terminal_and_error', () => {
    const tmp = tmpPath();
    for (const status of ['complete', 'error']) {
      const store = openStore(cfg(path.join(tmp, status)));
      const rec = finishedJob(store, 'rec-retry', status);
      fs.writeFileSync(path.join(store.outboxDir('rec-retry'), 'transcript.txt'), 'hello', 'utf8');
      const retried = store.retryWriter(rec.jobId, 'codex');
      expect(retried.status).toBe('queued');
      expect(retried.writer).toBe('codex');
      expect(retried.skipAsr).toBe(true);
      expect(retried.onlyPublish).toBe(false);
      store.setStatus(rec.jobId, 'complete');
      const keep = store.retryWriter(rec.jobId, null);
      expect(keep.writer).toBe('codex'); // no override keeps the current writer
    }
  });

  // retry-publish is allowed once there is a page to publish: a transcript or any AI review.
  it('retry_publish_contract', () => {
    const store = openStore(cfg(tmpPath()));
    raises(UnknownJob, () => store.retryPublish('no-such-job'));

    const rec = finishedJob(store, 'rec-retry', 'error');
    raises(RetryNotAllowed, () => store.retryPublish(rec.jobId), 'nothing to publish');

    fs.writeFileSync(path.join(store.outboxDir('rec-retry'), 'outline.md'), '# Outline', 'utf8');
    const retried = store.retryPublish(rec.jobId);
    expect(retried.status).toBe('queued');
    expect(retried.skipAsr).toBe(true);
    expect(retried.onlyPublish).toBe(true);
  });

  // --- import / process_inbox --------------------------------------------------------

  it('import_folder_error_paths', () => {
    const tmp = tmpPath();
    const store = openStore(cfg(tmp));
    const importFrom = (folder, reviews = ['summary']) => () =>
      store.importFolder(folder, { title: null, reviews, publish: false });

    const missing = raises(Error, importFrom(path.join(tmp, 'missing')));
    expect(missing.code).toBe('ENOENT');

    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    const noMetadata = raises(Error, importFrom(empty), 'metadata.json');
    expect(noMetadata.code).toBe('ENOENT');

    const noId = path.join(tmp, 'no-id');
    writeDrop(noId, '');
    raises(ValueError, importFrom(noId), 'missing id');

    const escape = path.join(tmp, 'escape');
    writeDrop(escape, '..');
    raises(ValueError, importFrom(escape), 'recordingId');
    expect(fs.existsSync(path.join(tmp, 'ds', 'audio.wav'))).toBe(false); // nothing copied outside inbox/

    const notObject = path.join(tmp, 'not-object');
    fs.mkdirSync(notObject);
    fs.writeFileSync(path.join(notObject, 'audio.wav'), 'x');
    fs.writeFileSync(path.join(notObject, 'metadata.json'), '[]', 'utf8');
    raises(ValueError, importFrom(notObject), 'not an object');

    const noAudio = path.join(tmp, 'no-audio');
    fs.mkdirSync(noAudio);
    fs.writeFileSync(path.join(noAudio, 'metadata.json'), '{"id":"rec-noaudio"}', 'utf8');
    raises(ValueError, importFrom(noAudio), 'exactly one');

    const twoAudios = path.join(tmp, 'two-audios');
    writeDrop(twoAudios, 'rec-two');
    fs.writeFileSync(path.join(twoAudios, 'audio.m4a'), 'second-audio');
    raises(ValueError, importFrom(twoAudios), 'exactly one');

    const badReview = path.join(tmp, 'bad-review');
    writeDrop(badReview, 'rec-review');
    raises(ValueError, importFrom(badReview, ['poem']), 'unknown review');
  });

  it('import_folder_metadata_variants', () => {
    const tmp = tmpPath();
    const store = openStore(cfg(tmp));

    const explicit = path.join(tmp, 'explicit');
    writeDrop(explicit, 'rec-meta1', { title: 'From Metadata' });
    let rec = store.importFolder(explicit, { title: null, reviews: ['organized', 'summary', 'organized'], publish: false });
    expect(rec.title).toBe('From Metadata');
    expect(rec.createdAtMs).toBe(1_758_400_000_000);
    expect(rec.reviews).toEqual(['summary', 'organized']); // canonical order, duplicates dropped
    expect(fs.statSync(path.join(store.inboxDir('rec-meta1'), 'metadata.json')).isFile()).toBe(true);

    const override = path.join(tmp, 'override');
    writeDrop(override, 'rec-meta2', { title: 'Ignored' });
    rec = store.importFolder(override, { title: 'Kept', reviews: [], publish: false });
    expect(rec.title).toBe('Kept');
    expect(rec.reviews).toEqual([]);

    const fallback = path.join(tmp, 'fallback');
    writeDrop(fallback, 'rec-meta3', { title: '   ' });
    rec = store.importFolder(fallback, { title: null, reviews: ['summary'], publish: false });
    expect(rec.title).toBe('recording');

    const longTitle = path.join(tmp, 'long');
    writeDrop(longTitle, 'rec-meta4', { title: 't'.repeat(500) });
    rec = store.importFolder(longTitle, { title: null, reviews: ['summary'], publish: false });
    expect(rec.title).toHaveLength(120);

    const noCreated = path.join(tmp, 'no-created');
    writeDrop(noCreated, 'rec-meta5', { created: 0 });
    const beforeMs = Date.now();
    rec = store.importFolder(noCreated, { title: null, reviews: ['summary'], publish: false });
    expect(rec.createdAtMs).toBeGreaterThanOrEqual(beforeMs - 60_000);
    expect(rec.createdAtMs).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('import_folder_includes_photos_and_ignores_others', () => {
    const tmp = tmpPath();
    const store = openStore(cfg(tmp));
    const src = path.join(tmp, 'photos');
    writeDrop(src, 'rec-photos');
    fs.writeFileSync(path.join(src, 'photo-b.jpg'), 'pb');
    fs.writeFileSync(path.join(src, 'photo-a.jpg'), 'pa');
    fs.writeFileSync(path.join(src, 'photo-c.gif'), 'pc'); // wrong extension: ignored
    fs.writeFileSync(path.join(src, 'notes.txt'), 'x', 'utf8'); // stray file: ignored
    const rec = store.importFolder(src, { title: null, reviews: ['summary'], publish: false });
    expect(rec.files.map((file) => file.name)).toEqual(['audio.wav', 'photo-a.jpg', 'photo-b.jpg']); // sorted after audio
  });

  it('process_inbox_actions', () => {
    const store = openStore(withUpdates(cfg(tmpPath()), { default_reviews: ['outline', 'organized'] }));
    for (const [rid, action, reviews, publish] of [
      ['rec-act1', 'transcribe', [], false],
      ['rec-act2', 'review', ['outline', 'organized'], false],
      ['rec-act3', 'publish', ['outline', 'organized'], true],
    ]) {
      writeDrop(store.inboxDir(rid), rid, { title: `USB ${rid}` });
      const rec = store.processInbox(rid, { action });
      expect(rec.status).toBe('queued');
      expect(rec.reviews).toEqual(reviews);
      expect(rec.publish).toBe(publish);
      expect(rec.title).toBe(`USB ${rid}`);
    }
    raises(ValueError, () => store.processInbox('rec-act4', { action: 'archive' }), 'invalid action');
    raises(ValueError, () => store.processInbox('rec-act4', { action: 'summarize' }), 'invalid action');
    raises(ValueError, () => store.processInbox('rec-act4', { action: 'detonate' }), 'invalid action');
  });

  it('process_inbox_title_override', () => {
    const store = openStore(cfg(tmpPath()));
    writeDrop(store.inboxDir('rec-t'), 'rec-t', { title: 'Old' });
    const rec = store.processInbox('rec-t', { action: 'transcribe', title: 'New' });
    expect(rec.title).toBe('New');
  });

  // --- device ledger ---------------------------------------------------------------

  it('device_ledger', () => {
    const store = openStore(cfg(tmpPath()), { clock: stamps((i) => `2026-01-01T00:${pad(i)}:00Z`) });

    store.upsertDeviceSeen('s1', 'Model A');
    store.upsertDeviceSeen('s1', ''); // empty model must not erase the known one
    store.upsertDeviceSeen('s2', 'Model B');
    store.upsertDeviceSeen('s3', 'Model C');
    expect(store.devices().map((d) => [d.serial, d.model])).toEqual([
      ['s3', 'Model C'],
      ['s2', 'Model B'],
      ['s1', 'Model A'],
    ]);
    expect(store.adoptedSerials()).toEqual(new Set());

    store.adoptDevice('s1');
    store.adoptDevice('s-never-seen'); // adopting an unseen serial still records it
    expect(store.adoptedSerials()).toEqual(new Set(['s1', 's-never-seen']));
    const ordered = store.devices().map((d) => d.serial);
    expect(ordered.slice(0, 2)).toEqual(['s1', 's-never-seen']); // adopted first, then last_seen DESC
    expect(ordered.slice(2)).toEqual(['s3', 's2']);

    store.deviceSynced('s2', null);
    store.deviceSynced('s1', 'adb: no route');
    let bySerial = Object.fromEntries(store.devices().map((d) => [d.serial, d]));
    expect(bySerial.s2.lastSyncAt).not.toBeNull();
    expect(bySerial.s2.lastError).toBeNull();
    expect(bySerial.s1.lastError).toBe('adb: no route');

    store.forgetDevice('s1');
    bySerial = Object.fromEntries(store.devices().map((d) => [d.serial, d]));
    expect(bySerial.s1.adopted).toBe(false);
    expect(bySerial.s1.lastError).toBeNull();
    expect(bySerial.s1.lastSeenAt).not.toBeNull(); // history survives forget
    expect(store.adoptedSerials()).toEqual(new Set(['s-never-seen']));
  });

  it('device_recording_ledger', () => {
    const store = openStore(cfg(tmpPath()));
    const [spec] = audioSpec('ledger-audio');
    const job = store.createJob(validRequest(spec, { recordingId: 'rec-d1' }), { id: 'rec-d1' });

    store.markDeviceRecording('s1', 'rec-d1', { deviceStatus: 'FINISHED', title: 'Ledgered', createdAtMs: 2000 });
    store.markDeviceRecording('s1', 'rec-d0', { deviceStatus: 'FINISHED', title: 'Older', createdAtMs: 1000 });
    store.markDeviceRecording('s1', 'rec-d1', { deviceStatus: 'UPDATED', title: 'Renamed', createdAtMs: 2000 });
    store.flagChangedSinceJob('s1', 'rec-d1');
    store.deviceRecordingPulled('s1', 'rec-d0');
    store.recordPulledFile('s1', 'rec-d0', 'audio.wav', 13, 100, 'a'.repeat(64));
    store.recordPulledFile('s1', 'rec-d0', 'photo-a.jpg', 2, 100, 'b'.repeat(64));
    store.setAutoJob('s1', 'rec-d1', job.jobId);

    const recs = store.deviceRecordings('s1');
    expect(recs.map((r) => r.recordingId)).toEqual(['rec-d1', 'rec-d0']); // created_at DESC
    const [d1, d0] = recs;
    expect(d1.title).toBe('Renamed');
    expect(d1.deviceStatus).toBe('UPDATED');
    expect(d1.autoJobId).toBe(job.jobId);
    expect(d1.changedSinceJob).toBe(false); // set_auto_job clears the flag
    expect(d1.latestJob).not.toBeNull();
    expect(d1.latestJob.jobId).toBe(job.jobId);
    expect(d0.pulledAt).not.toBeNull();
    expect(d0.fileCount).toBe(2);
    expect(d0.bytes).toBe(15);
    expect(store.deviceFileState('s1', 'rec-d0')).toEqual({
      'audio.wav': [13, 100],
      'photo-a.jpg': [2, 100],
    });

    store.flagDeviceRecording('s1', 'rec-d1', 'pull_failed');
    expect(store.deviceRecordings('s1')[0].flag).toBe('pull_failed');
    store.flagDeviceRecording('s1', 'rec-d1', null);
    expect(store.deviceRecordings('s1')[0].flag).toBeNull();
  });

  // --- tokens and pair codes -------------------------------------------------------

  it('token_lifecycle', () => {
    const store = openStore(cfg(tmpPath()));
    const code = store.createPairCode();
    const raw = store.redeemPairCode(code, 'phone');
    expect(raw).not.toBeNull();
    expect(store.tokenValid('garbage')).toBe(false);

    const tokens = store.tokens();
    expect(tokens).toHaveLength(1);
    let [entry] = tokens;
    expect(entry.sha256).toBe(hashToken(raw)); // stored hashed, never the raw token
    expect(entry.label).toBe('phone');
    expect(entry.revoked).toBe(false);
    expect(entry.lastUsedAt).toBeNull();

    expect(store.tokenValid(raw)).toBe(true);
    [entry] = store.tokens();
    expect(entry.lastUsedAt).not.toBeNull();

    const secondCode = store.createPairCode();
    const second = store.redeemPairCode(secondCode, 'tablet');
    expect(second).not.toBeNull();
    const ids = store.tokens().map((t) => t.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a)); // newest first

    store.revokeToken(entry.id);
    expect(store.tokenValid(raw)).toBe(false);
    expect(store.tokens()[0].revoked).toBe(false); // only the targeted token
  });

  it('pair_code_ttl_expiry_via_clock', () => {
    let frozen = null;
    const store = openStore(cfg(tmpPath()), { clock: () => frozen ?? utcnowIso() });
    const code = store.createPairCode(); // expires pair_code_ttl_s from now (600s default)
    frozen = '2999-01-01T00:00:00Z';
    expect(store.redeemPairCode(code, 'phone')).toBeNull();
  });

  // --- logs ---------------------------------------------------------------------------

  it('append_and_read_log', () => {
    const store = openStore(cfg(tmpPath()));
    const [spec] = audioSpec('log-audio');
    const rec = store.createJob(validRequest(spec), { id: 'rec-v' });
    store.appendLog(rec.jobId, 'step one');
    store.appendLog(rec.jobId, 'step two\n');
    const lines = store.readLog(rec.jobId);
    expect(lines.map((line) => line.slice(line.indexOf(' ') + 1))).toEqual(['step one', 'step two']);
    expect(store.readLog(rec.jobId, 1)).toEqual([lines[1]]);
    raises(UnknownJob, () => store.readLog('no-such-job'));
  });

  // --- audio mismatch across names -----------------------------------------------------

  it('audio_mismatch_across_different_audio_names', () => {
    const store = openStore(cfg(tmpPath()));
    const [m4a, data] = audioSpec('same-bytes'); // audio.m4a
    const rec = store.createJob(validRequest(m4a, { recordingId: 'rec-am' }), { id: 'rec-am' });
    store.appendFile(rec.jobId, m4a.name, 0, [data]);
    store.commit(rec.jobId);
    store.setStatus(rec.jobId, 'complete');

    const [sameBytesWav] = audioSpec('same-bytes', 'audio.wav');
    store.createJob(validRequest(sameBytesWav, { recordingId: 'rec-am' }), { id: 'rec-am' }); // same content: fine
    store.setStatus(store.activeJobFor('rec-am').jobId, 'error');

    const [otherWav] = audioSpec('different-bytes', 'audio.wav');
    raises(AudioMismatch, () => store.createJob(validRequest(otherWav, { recordingId: 'rec-am' }), { id: 'rec-am' }));
  });

  it('delete_recording_removes_this_pcs_copy_and_nothing_outside_the_publish_root', () => {
    const tmp = tmpPath();
    const config = cfg(tmp);
    const store = openStore(config);
    const rec = finishedJob(store, 'rec-del', 'complete');
    const ds = path.join(tmp, 'ds');
    const published = store.job(rec.jobId).publishFolder;
    fs.mkdirSync(published, { recursive: true });
    fs.writeFileSync(path.join(published, 'summary.html'), 'page', 'utf8');
    fs.mkdirSync(path.join(ds, 'work', 'rec-del'), { recursive: true });
    store.outboxDir('rec-del');
    // A second run whose recorded publish folder points outside webdav_folder (moved config, bad row).
    const second = rerun(store, 'rec-del', 'complete');
    const outside = path.join(tmp, 'not-published-here');
    fs.mkdirSync(outside);
    sql(config, 'UPDATE jobs SET publish_folder = ? WHERE job_id = ?', outside, second.jobId);

    store.deleteRecording('rec-del');

    for (const gone of [
      path.join(ds, 'inbox', 'rec-del'),
      path.join(ds, 'outbox', 'rec-del'),
      path.join(ds, 'work', 'rec-del'),
      published,
    ]) {
      expect(fs.existsSync(gone), gone).toBe(false);
    }
    expect(fs.statSync(outside).isDirectory()).toBe(true);
    expect(store.latestFor('rec-del')).toBeNull();
    expect(store.isDeleted('rec-del')).toBe(true);
    // An explicit Send / Import of the same recording clears the mark.
    finishedJob(store, 'rec-del', 'queued');
    expect(store.isDeleted('rec-del')).toBe(false);
  });

  it('delete_recording_refuses_while_a_job_is_running', () => {
    const tmp = tmpPath();
    const store = openStore(cfg(tmp));
    finishedJob(store, 'rec-busy', 'transcribing');
    raises(StoreError, () => store.deleteRecording('rec-busy'), 'still running');
    expect(fs.statSync(path.join(tmp, 'ds', 'inbox', 'rec-busy')).isDirectory()).toBe(true);
    expect(store.latestFor('rec-busy')).not.toBeNull();
    expect(store.isDeleted('rec-busy')).toBe(false);
  });

  // Node only: realpath fails on the rclone WebDAV mount; the lexical check must still keep the
  // delete strictly inside webdav_folder.
  it('delete_recording_stays_inside_the_publish_root_when_realpath_fails', () => {
    const tmp = tmpPath();
    const config = cfg(tmp);
    const store = openStore(config);
    const first = finishedJob(store, 'rec-mnt', 'complete');
    fs.mkdirSync(first.publishFolder, { recursive: true });
    fs.writeFileSync(path.join(first.publishFolder, 'summary.html'), 'page', 'utf8');
    // Runs whose rows name the root itself, a sibling sharing its prefix, and a path climbing out.
    const kept = [config.webdav_folder, `${config.webdav_folder}-evil`, path.join(config.webdav_folder, '..', 'outside')];
    for (const folder of kept) {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'sentinel.txt'), 'keep', 'utf8');
      const run = rerun(store, 'rec-mnt', 'complete');
      sql(config, 'UPDATE jobs SET publish_folder = ? WHERE job_id = ?', folder, run.jobId);
    }
    const realpath = vi.spyOn(fs.realpathSync, 'native').mockImplementation(() => {
      throw Object.assign(new Error('UNKNOWN: unknown error, realpath'), { code: 'UNKNOWN', errno: -4094 });
    });
    try {
      store.deleteRecording('rec-mnt');
      expect(realpath).toHaveBeenCalled();
    } finally {
      realpath.mockRestore();
    }

    expect(fs.existsSync(first.publishFolder)).toBe(false);
    for (const folder of kept) expect(fs.existsSync(path.join(folder, 'sentinel.txt')), folder).toBe(true);
    expect(store.latestFor('rec-mnt')).toBeNull();
    expect(store.isDeleted('rec-mnt')).toBe(true);
  });

  // Node only, Python semantics: where realpath works, a link inside webdav_folder is followed, so
  // a folder it points to outside the root is left alone.
  it('delete_recording_does_not_follow_a_link_out_of_the_publish_root', () => {
    const tmp = tmpPath();
    const config = cfg(tmp);
    const store = openStore(config);
    const rec = finishedJob(store, 'rec-link', 'complete');
    const outside = path.join(tmp, 'elsewhere');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'keep', 'utf8');
    const link = path.join(config.webdav_folder, '2025', 'linked');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(outside, link, 'junction');
    sql(config, 'UPDATE jobs SET publish_folder = ? WHERE job_id = ?', link, rec.jobId);

    store.deleteRecording('rec-link');

    expect(fs.existsSync(path.join(outside, 'sentinel.txt'))).toBe(true);
    expect(store.isDeleted('rec-link')).toBe(true);
  });

  it('latest_jobs_lists_each_recording_once_with_its_run_count', () => {
    const store = openStore(cfg(tmpPath()));
    finishedJob(store, 'rec-a', 'complete');
    const newestA = rerun(store, 'rec-a', 'complete');
    const onlyB = finishedJob(store, 'rec-b', 'error');
    const rows = Object.fromEntries(store.latestJobs().map(([job, runs]) => [job.recordingId, [job.jobId, runs]]));
    expect(rows).toEqual({ 'rec-a': [newestA.jobId, 2], 'rec-b': [onlyB.jobId, 1] });
  });

  // --- AI reviews -----------------------------------------------------------------------

  // A jobs row written by the summarize/summaryStyle server opens with reviews filled in.
  it('database_from_before_ai_reviews_is_migrated', () => {
    const config = cfg(tmpPath());
    fs.mkdirSync(config.datastore, { recursive: true });
    const old = new DatabaseSync(path.join(config.datastore, 'index.sqlite'));
    old.exec(`
      CREATE TABLE jobs (
          job_id TEXT PRIMARY KEY, recording_id TEXT, status TEXT, error TEXT, title TEXT,
          summarize INTEGER, publish INTEGER, summary_style TEXT, writer TEXT, webdav_url TEXT,
          publish_folder TEXT, skip_asr INTEGER DEFAULT 0, only_publish INTEGER DEFAULT 0,
          created_at TEXT, updated_at TEXT, finished_at TEXT, asr_json TEXT, timings_json TEXT
      );
    `);
    const folder = path.join(config.webdav_folder, '2025', '09', '20250920-1013-old');
    for (const [jobId, summarize] of [['j-sum', 1], ['j-txt', 0]]) {
      old
        .prepare(
          "INSERT INTO jobs VALUES (?, ?, 'complete', NULL, 'Old', ?, 1, 'minutes', 'codex', " +
            "'https://stale.test/x/summary.html', ?, 0, 0, '2025-09-20T10:13:00Z', " +
            "'2025-09-20T10:20:00Z', '2025-09-20T10:20:00Z', NULL, NULL)",
        )
        .run(jobId, `rec-${jobId}`, summarize, folder);
    }
    old.close();

    const store = openStore(config);
    const summarized = store.job('j-sum');
    const plain = store.job('j-txt');
    expect(summarized).not.toBeNull();
    expect(summarized.reviews).toEqual(['summary']);
    expect(plain).not.toBeNull();
    expect(plain.reviews).toEqual([]);
    const result = store.resultJson('j-sum');
    expect(result.reviews).toEqual(['summary']);
    expect(result).not.toHaveProperty('summarize');
    expect(result).not.toHaveProperty('summaryStyle');
    expect(result.webdavUrl).toBe('https://example.test/files/2025/09/20250920-1013-old/summary.html');
    expect(store.resultJson('j-txt').webdavUrl.endsWith('/transcript.html')).toBe(true);
    const columns = new Set(sql(config, 'PRAGMA table_info(jobs)').map((row) => row.name));
    for (const gone of ['summarize', 'summary_style', 'webdav_url']) expect(columns.has(gone)).toBe(false);
    openStore(config); // opening a migrated database again is a no-op
  });

  it('result_and_index_list_published_pages_in_page_order', () => {
    const store = openStore(cfg(tmpPath()));
    const rec = finishedJob(store, 'rec-pages', 'complete');
    expect(store.resultJson(rec.jobId).pages).toEqual([]);
    const folder = rec.publishFolder;
    fs.mkdirSync(folder, { recursive: true });
    for (const name of ['outline.html', 'transcript.html', 'summary.md']) {
      fs.writeFileSync(path.join(folder, name), 'x', 'utf8');
    }
    const base = rec.webdavUrl.slice(0, rec.webdavUrl.lastIndexOf('/'));
    const expected = [
      { kind: 'transcript', url: `${base}/transcript.html` },
      { kind: 'outline', url: `${base}/outline.html` },
    ];
    expect(store.resultJson(rec.jobId).pages).toEqual(expected);
    const index = store.recordingsIndex();
    expect(index).toHaveLength(1);
    expect(index[0].pages).toEqual(expected);
  });

  it('retry_writer_reviews_default_to_the_job_and_can_be_replaced', () => {
    const store = openStore(cfg(tmpPath()));
    const rec = finishedJob(store, 'rec-rr', 'complete');
    fs.writeFileSync(path.join(store.outboxDir('rec-rr'), 'transcript.txt'), 'hello', 'utf8');
    expect(store.retryWriter(rec.jobId, null).reviews).toEqual(['summary']);
    store.setStatus(rec.jobId, 'complete');
    expect(store.retryWriter(rec.jobId, null, ['organized', 'outline']).reviews).toEqual(['outline', 'organized']);
    store.setStatus(rec.jobId, 'complete');
    raises(ValueError, () => store.retryWriter(rec.jobId, null, []), 'at least one');
    raises(ValueError, () => store.retryWriter(rec.jobId, null, ['poem']), 'unknown review');
  });

  it('add_review_queues_a_writer_only_job_that_follows_the_latest_publish', () => {
    const store = openStore(cfg(tmpPath()));
    const first = finishedJob(store, 'rec-add', 'complete'); // publish=False in validRequest
    raises(StoreError, () => store.addReview('rec-add', 'outline'), 'no transcript');
    fs.writeFileSync(path.join(store.outboxDir('rec-add'), 'transcript.txt'), 'hello', 'utf8');
    raises(ValueError, () => store.addReview('rec-add', 'poem'), 'unknown review');

    const added = store.addReview('rec-add', 'outline');
    expect(added.jobId).not.toBe(first.jobId);
    expect(added.status).toBe('queued');
    expect(added.reviews).toEqual(['outline']);
    expect(added.skipAsr).toBe(true);
    expect(added.onlyPublish).toBe(false);
    expect(added.publish).toBe(false);
    expect(added.publishFolder).toBe(first.publishFolder);
    expect(store.nextQueued().jobId).toBe(added.jobId);
    raises(StoreError, () => store.addReview('rec-add', 'summary'), 'still running');
    raises(StoreError, () => store.addReview('rec-none', 'summary'), 'unknown recording');
  });

  // A server stopped mid-job must not leave the recording answering job_active forever.
  it('restart_recovery_moves_on_every_job_the_previous_run_left_in_flight', () => {
    const store = openStore(cfg(tmpPath()));
    const left = {};
    for (const [rid, status, transcript] of [
      ['rec-t', 'transcribing', false],
      ['rec-w', 'writing', true],
      ['rec-wx', 'writing', false], // no transcript on disk: it has to be made again
      ['rec-p', 'publishing', true],
      ['rec-d', 'published', true],
    ]) {
      left[rid] = finishedJob(store, rid, status).jobId;
      if (transcript) fs.writeFileSync(path.join(store.outboxDir(rid), 'transcript.txt'), 'words', 'utf8');
    }
    const [spec, data] = audioSpec('private-audio');
    const priv = store.createJob(validRequest(spec, { recordingId: 'rec-np', publish: false }), { id: 'rec-np' });
    store.appendFile(priv.jobId, spec.name, 0, [data]);
    store.commit(priv.jobId);
    store.setStatus(priv.jobId, 'written');
    const settled = Object.fromEntries(
      [['rec-q', 'queued'], ['rec-c', 'complete'], ['rec-e', 'error']].map(([rid, st]) => [rid, finishedJob(store, rid, st).jobId]),
    );

    const moved = Object.fromEntries(store.recoverInterrupted().map(([jobId, was, now]) => [jobId, [was, now]]));

    const state = (jobId) => {
      const rec = store.job(jobId);
      return [rec.status, rec.skipAsr, rec.onlyPublish];
    };
    expect(state(left['rec-t'])).toEqual(['queued', false, false]); // transcribe again
    expect(state(left['rec-w'])).toEqual(['queued', true, false]); // rewrite reviews from the transcript
    expect(state(left['rec-wx'])).toEqual(['queued', false, false]);
    expect(state(left['rec-p'])).toEqual(['queued', true, true]); // publish only
    expect(state(left['rec-d'])[0]).toBe('complete'); // the last step had finished
    expect(state(priv.jobId)[0]).toBe('complete'); // written and nothing to publish
    expect(new Set(Object.keys(moved))).toEqual(new Set([...Object.values(left), priv.jobId]));
    expect(moved[left['rec-p']]).toEqual(['publishing', 'queued']);
    expect(Object.fromEntries(Object.entries(settled).map(([rid, jobId]) => [rid, store.job(jobId).status]))).toEqual({
      'rec-q': 'queued',
      'rec-c': 'complete',
      'rec-e': 'error',
    });
    expect(
      store.readLog(left['rec-w']).some((line) => line.includes('recovered after a server restart: was writing')),
    ).toBe(true);
    expect(store.recoverInterrupted()).toEqual([]); // nothing left in flight
  });

  // Node only: a row an older server stored with an id this server refuses must not stop startup
  // or the listings, and nothing may be built on disk for it.
  it('rows_with_a_refused_recording_id_fail_at_recovery_and_stay_listed', () => {
    const tmp = tmpPath();
    const config = cfg(tmp);
    const warn = vi.fn();
    const store = openStore(config, { logger: { info() {}, warn } });
    const ok = finishedJob(store, 'rec-ok', 'writing');
    const folder = path.join(config.webdav_folder, '2025', '09', '20250920-1013-legacy');
    for (const [jobId, rid, status] of [['j-colon', 'C:x', 'writing'], ['j-pipe', 'a|b', 'queued'], ['j-done', 'C:z', 'complete']]) {
      sql(
        config,
        "INSERT INTO jobs VALUES (?, ?, ?, NULL, 'Legacy', 'summary', 1, 'codex', ?, 0, 0, " +
          "'2025-09-20T10:13:00Z', '2025-09-20T10:20:00Z', NULL, NULL, NULL)",
        jobId,
        rid,
        status,
        folder,
      );
    }
    const before = Object.fromEntries(['inbox', 'outbox', 'work'].map((area) => [area, fs.readdirSync(path.join(tmp, 'ds', area))]));

    const moved = Object.fromEntries(store.recoverInterrupted().map(([jobId, was, now]) => [jobId, [was, now]]));

    expect(moved).toEqual({ 'j-colon': ['writing', 'error'], 'j-pipe': ['queued', 'error'], [ok.jobId]: ['writing', 'queued'] });
    for (const jobId of ['j-colon', 'j-pipe']) {
      const job = store.job(jobId);
      expect(job.status).toBe('error');
      expect(job.error).toBe('invalid recording id');
      expect(job.finishedAt).not.toBeNull();
    }
    expect(store.job('j-done').status).toBe('complete');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(store.hasActiveJobs()).toBe(true); // only the valid job, requeued
    expect(store.recoverInterrupted()).toEqual([]);

    // Listings keep the rows; none of them builds a path from the id.
    expect(store.recordingsIndex().map((entry) => entry.recordingId).sort()).toEqual(['C:x', 'C:z', 'a|b', 'rec-ok']);
    expect(store.latestJobs().map(([job]) => job.recordingId).sort()).toEqual(['C:x', 'C:z', 'a|b', 'rec-ok']);
    expect(store.recentJobs().map((job) => job.jobId)).toContain('j-colon');
    expect(store.resultJson('j-colon').webdavUrl).toBe('https://example.test/files/2025/09/20250920-1013-legacy/summary.html');
    expect(store.pages(store.job('j-colon'))).toEqual([]);
    expect(store.activeJobFor('C:x')).toBeNull();
    expect(store.previousReviewJob('C:x', 'summary', 'other')).toBe('j-colon');
    store.setStatus('j-colon', 'error', { error: 'invalid recording id' }); // status changes still work

    const after = Object.fromEntries(['inbox', 'outbox', 'work'].map((area) => [area, fs.readdirSync(path.join(tmp, 'ds', area))]));
    expect(after).toEqual(before);
    expect(fs.readdirSync(path.join(tmp, 'ds'))).not.toContain('x');
  });
});
