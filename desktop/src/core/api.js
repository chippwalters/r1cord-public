// /v1 routes — wire contract offload-api-v1.md is authoritative.
// Port of r1cord_server/api.py: status codes, JSON error bodies, one log line per error.

'use strict';

const { canonicalReviews } = require('./config');
const { ValueError } = require('./errors');
const { requireTokenHook } = require('./auth');
const { requestPath } = require('./log');
const {
  WRITERS,
  AudioMismatch,
  HashMismatch,
  Incomplete,
  JobActive,
  JobNotUploading,
  OffsetMismatch,
  RetryNotAllowed,
  TooLarge,
  UnknownJob,
} = require('./store');

const EXPECTED_STATUS = new Set([400, 401, 404, 409]);
const FILE_NAME_RE = /^[A-Za-z0-9._-]+$/;
const PHOTO_RE = /^photo-[A-Za-z0-9._-]+\.jpg$/;
const AUDIO = new Set(['audio.m4a', 'audio.wav']);
const SHA = /^[0-9a-fA-F]{64}$/;
const MAX_PUT_BYTES = 64 * 1024 * 1024;
const RETRY_BODY_MSG =
  'retry body must be {"writer": "claude_code" | "codex" | "grok_build", ' +
  '"reviews": ["summary" | "outline" | "organized", ...]}';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sendError(request, reply, status, error, message, extra = {}) {
  const logger = request.server.state.loggers.api;
  const level = EXPECTED_STATUS.has(status) ? 'info' : 'warning';
  const parts = [`${request.method} ${requestPath(request)} -> ${status} ${error}`];
  if (extra && Object.keys(extra).length) parts.push(JSON.stringify(extra));
  parts.push(message);
  logger[level](parts.join(' | '));
  return reply.code(status).send({ error, message, ...extra });
}

function crash(request, reply, error, endpointName) {
  const logger = request.server.state.loggers.api;
  const where = request ? `${request.method} ${requestPath(request)}` : endpointName;
  logger.warning(`${where} -> 500 internal_error | ${error.name}: ${error.message}`, error);
  return reply.code(500).send({ error: 'internal_error', message: 'unexpected server error' });
}

function guarded(handler) {
  return async function guardedHandler(request, reply) {
    try {
      return await handler(request, reply);
    } catch (error) {
      if (error && error.name === 'HttpError') throw error;
      return crash(request, reply, error, handler.name);
    }
  };
}

function wakeWorker(request) {
  const worker = request.server && request.server.state && request.server.state.worker;
  if (worker && typeof worker.wake === 'function') worker.wake();
}

function requestedReviews(job) {
  if (job.reviews === undefined || job.reviews === null) {
    return job.summarize ? ['summary'] : [];
  }
  return canonicalReviews(job.reviews);
}

function parseCreateJobBody(body) {
  if (!isPlainObject(body)) return { error: 'Input should be a valid dictionary' };
  if (!Object.prototype.hasOwnProperty.call(body, 'job')) return { error: 'job: Field required' };
  if (!isPlainObject(body.job)) return { error: 'job: Input should be a valid dictionary' };
  const job = body.job;
  const missing = [];
  for (const key of ['recordingId', 'createdAt', 'title', 'files']) {
    if (!Object.prototype.hasOwnProperty.call(job, key)) missing.push(`${key}: Field required`);
  }
  if (missing.length) return { error: missing.join('; ') };
  if (typeof job.recordingId !== 'string') return { error: 'recordingId: Input should be a valid string' };
  if (typeof job.createdAt !== 'number' || !Number.isFinite(job.createdAt)) {
    return { error: 'createdAt: Input should be a valid integer' };
  }
  if (typeof job.title !== 'string') return { error: 'title: Input should be a valid string' };
  if (!Array.isArray(job.files)) return { error: 'files: Input should be a valid list' };
  if (Object.prototype.hasOwnProperty.call(job, 'reviews') && job.reviews !== null && !Array.isArray(job.reviews)) {
    return { error: 'reviews: Input should be a valid list' };
  }
  if (Array.isArray(job.reviews) && job.reviews.some((kind) => typeof kind !== 'string')) {
    return { error: 'reviews: Input should be a valid string' };
  }
  const files = [];
  for (let i = 0; i < job.files.length; i += 1) {
    const spec = job.files[i];
    if (!isPlainObject(spec)) return { error: `files.${i}: Input should be a valid dictionary` };
    for (const key of ['name', 'size', 'sha256']) {
      if (!Object.prototype.hasOwnProperty.call(spec, key)) return { error: `files.${i}.${key}: Field required` };
    }
    if (typeof spec.name !== 'string') return { error: `files.${i}.name: Input should be a valid string` };
    if (typeof spec.size !== 'number' || !Number.isFinite(spec.size)) {
      return { error: `files.${i}.size: Input should be a valid integer` };
    }
    if (typeof spec.sha256 !== 'string') return { error: `files.${i}.sha256: Input should be a valid string` };
    files.push({ name: spec.name, size: spec.size, sha256: spec.sha256 });
  }
  let schemaVersion = 1;
  if (Object.prototype.hasOwnProperty.call(job, 'schemaVersion')) {
    if (typeof job.schemaVersion !== 'number' || !Number.isInteger(job.schemaVersion)) {
      return { error: 'schemaVersion: Input should be a valid integer' };
    }
    schemaVersion = job.schemaVersion;
  }
  let summarize = true;
  if (Object.prototype.hasOwnProperty.call(job, 'summarize')) summarize = Boolean(job.summarize);
  let publish = true;
  if (Object.prototype.hasOwnProperty.call(job, 'publish')) publish = Boolean(job.publish);
  const metadata = Object.prototype.hasOwnProperty.call(body, 'metadata') ? body.metadata : {};
  if (!isPlainObject(metadata)) return { error: 'metadata: Input should be a valid dictionary' };
  const reviews = Object.prototype.hasOwnProperty.call(job, 'reviews') ? job.reviews : undefined;
  return {
    value: {
      schemaVersion,
      recordingId: job.recordingId,
      createdAt: Math.trunc(job.createdAt),
      title: job.title,
      reviews,
      summarize,
      publish,
      files,
      metadata,
    },
  };
}

function validateJobIn(job) {
  if (job.schemaVersion !== 1) return `unsupported schemaVersion: ${job.schemaVersion} (expected 1)`;
  const title = job.title.trim();
  if (!title || title.length > 120) return 'title must be 1–120 characters after trim';
  if (
    !job.recordingId ||
    job.recordingId === '.' ||
    job.recordingId === '..' ||
    job.recordingId.includes('/') ||
    job.recordingId.includes('\\') ||
    job.recordingId.includes('\x00') ||
    job.recordingId !== job.recordingId.trim()
  ) {
    return 'invalid recordingId';
  }
  if (!job.files.length) return 'files manifest is empty';
  let audio = 0;
  const seen = new Set();
  for (const spec of job.files) {
    if (seen.has(spec.name)) return `duplicate file name: ${spec.name}`;
    seen.add(spec.name);
    if (!FILE_NAME_RE.test(spec.name)) return `invalid file name: ${spec.name}`;
    if (AUDIO.has(spec.name)) audio += 1;
    else if (!PHOTO_RE.test(spec.name)) return `file name not allowed: ${spec.name}`;
    if (spec.size < 0) return `invalid size for ${spec.name}`;
    if (!SHA.test(spec.sha256)) return `invalid sha256 for ${spec.name}`;
  }
  if (audio !== 1) return 'manifest must contain exactly one audio.m4a or audio.wav';
  return null;
}

function parseOffset(query) {
  if (!query || query.offset === undefined) return { ok: true, value: 0 };
  const raw = Array.isArray(query.offset) ? query.offset[0] : query.offset;
  if (typeof raw === 'number' && Number.isInteger(raw)) return { ok: true, value: raw };
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return { ok: true, value: Number(raw) };
  return { ok: false };
}

function asAsyncChunks(body) {
  if (body == null) {
    return (async function* empty() {})();
  }
  if (typeof body[Symbol.asyncIterator] === 'function') return body;
  if (Buffer.isBuffer(body) || typeof body === 'string') {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    return (async function* one() {
      if (buf.length) yield buf;
    })();
  }
  if (typeof body[Symbol.iterator] === 'function') {
    return (async function* iter() {
      for (const chunk of body) {
        if (chunk) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      }
    })();
  }
  return (async function* empty() {})();
}

async function* limitedPut(stream) {
  let n = 0;
  for await (const chunk of asAsyncChunks(stream)) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!buf.length) continue;
    n += buf.length;
    if (n > MAX_PUT_BYTES) {
      const error = new TooLarge(MAX_PUT_BYTES);
      error.perRequest = true;
      throw error;
    }
    yield buf;
  }
}

async function drainBody(body) {
  // Read an unused request stream so the client can finish sending. destroy()
  // RSTs the socket (WinError 10054) while httpx is still writing the PUT body.
  if (!body) return;
  try {
    if (typeof body.resume === 'function') {
      if (body.readableEnded || body.destroyed) return;
      await new Promise((resolve) => {
        body.once('end', resolve);
        body.once('close', resolve);
        body.once('error', resolve);
        body.resume();
      });
      return;
    }
    if (typeof body[Symbol.asyncIterator] === 'function') {
      for await (const _chunk of body) {
        /* discard */
      }
    }
  } catch (_error) {
    // already closed
  }
}

async function pair(request, reply) {
  const body = request.body;
  if (!isPlainObject(body)) {
    return sendError(request, reply, 422, 'invalid_request', 'Input should be a valid dictionary');
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'code')) {
    return sendError(request, reply, 422, 'invalid_request', 'code: Field required');
  }
  if (typeof body.code !== 'string' && typeof body.code !== 'number') {
    return sendError(request, reply, 422, 'invalid_request', 'code: Input should be a valid string');
  }
  const code = String(body.code).trim();
  const token = request.server.state.store.redeemPairCode(code, 'device');
  if (token === null) {
    return sendError(request, reply, 400, 'invalid_code', 'unknown, used, or expired pairing code');
  }
  return reply.code(200).send({ token, serverName: request.server.state.config.server_name });
}

async function createJob(request, reply) {
  const parsed = parseCreateJobBody(request.body);
  if (parsed.error) return sendError(request, reply, 422, 'invalid_request', parsed.error);
  const job = parsed.value;
  let reviews;
  try {
    reviews = requestedReviews(job);
  } catch (error) {
    if (error instanceof ValueError) return sendError(request, reply, 400, 'invalid_request', error.message);
    throw error;
  }
  const problem = validateJobIn(job);
  if (problem) return sendError(request, reply, 422, 'invalid_request', problem);
  const store = request.server.state.store;
  let rec;
  try {
    rec = store.createJob(
      {
        recordingId: job.recordingId,
        createdAtMs: job.createdAt,
        title: job.title.trim(),
        reviews,
        publish: Boolean(job.publish),
        files: job.files.map((spec) => ({
          name: spec.name,
          size: Math.trunc(spec.size),
          sha256: spec.sha256.toLowerCase(),
        })),
        schemaVersion: job.schemaVersion,
      },
      job.metadata,
    );
  } catch (error) {
    if (error instanceof JobActive) {
      return sendError(request, reply, 409, 'job_active', 'a job is already active for this recording', {
        jobId: error.jobId,
      });
    }
    if (error instanceof AudioMismatch) {
      return sendError(
        request,
        reply,
        409,
        'audio_mismatch',
        'audio already stored for this recording with a different hash',
      );
    }
    if (error instanceof ValueError) return sendError(request, reply, 422, 'invalid_request', error.message);
    throw error;
  }
  const webdav = rec.publish ? rec.webdavUrl : null;
  return reply.code(202).send({
    jobId: rec.jobId,
    recordingId: rec.recordingId,
    status: rec.status,
    webdavUrl: webdav,
  });
}

async function fileReceived(request, reply) {
  const { jobId, name } = request.params;
  const store = request.server.state.store;
  const rec = store.job(jobId);
  if (rec === null) return sendError(request, reply, 404, 'not_found', `unknown job ${jobId}`);
  const received = store.fileReceived(jobId, name);
  if (received === null) return sendError(request, reply, 404, 'not_found', `${name} is not in the job manifest`);
  return reply.code(200).send({ received });
}

async function putFile(request, reply) {
  const { jobId, name } = request.params;
  const offsetParsed = parseOffset(request.query);
  if (!offsetParsed.ok) {
    await drainBody(request.body);
    return sendError(request, reply, 422, 'invalid_request', 'offset: Input should be a valid integer');
  }
  const offset = offsetParsed.value;
  const store = request.server.state.store;
  const rec = store.job(jobId);
  if (rec === null) {
    await drainBody(request.body);
    return sendError(request, reply, 404, 'not_found', `unknown job ${jobId}`);
  }
  const received = store.fileReceived(jobId, name);
  if (received === null) {
    await drainBody(request.body);
    return sendError(request, reply, 404, 'not_found', `${name} is not in the job manifest`);
  }
  try {
    const newLen = await store.appendFileAsync(jobId, name, offset, limitedPut(request.body));
    return reply.code(200).send({ received: newLen });
  } catch (error) {
    await drainBody(request.body);
    if (error instanceof JobNotUploading) {
      return sendError(request, reply, 409, 'job_not_uploading', 'job is past the uploading state');
    }
    if (error instanceof OffsetMismatch) {
      return sendError(request, reply, 409, 'offset_mismatch', `offset must equal received length ${error.received}`, {
        received: error.received,
      });
    }
    if (error instanceof TooLarge) {
      const message = error.perRequest
        ? `body exceeds ${MAX_PUT_BYTES} byte per-request limit`
        : `body would exceed manifest size ${error.size}`;
      return sendError(request, reply, 413, 'too_large', message);
    }
    if (error instanceof UnknownJob) {
      return sendError(request, reply, 404, 'not_found', `unknown job or file ${jobId}/${name}`);
    }
    throw error;
  }
}

async function commitJob(request, reply) {
  const { jobId } = request.params;
  const store = request.server.state.store;
  const rec0 = store.job(jobId);
  if (rec0 === null) return sendError(request, reply, 404, 'not_found', `unknown job ${jobId}`);
  let rec;
  try {
    rec = store.commit(jobId);
  } catch (error) {
    if (error instanceof Incomplete) {
      return sendError(request, reply, 409, 'incomplete', 'one or more files are short', { files: error.files });
    }
    if (error instanceof HashMismatch) {
      return sendError(request, reply, 422, 'hash_mismatch', 'sha256 did not match the manifest', {
        files: error.files,
      });
    }
    if (error instanceof UnknownJob) {
      return sendError(request, reply, 404, 'not_found', `unknown job ${jobId}`);
    }
    throw error;
  }
  wakeWorker(request);
  const webdav = rec.publish ? rec.webdavUrl : null;
  return reply.code(200).send({ jobId: rec.jobId, status: rec.status, webdavUrl: webdav });
}

async function getJob(request, reply) {
  const { jobId } = request.params;
  const store = request.server.state.store;
  const rec = store.job(jobId);
  if (rec === null) return sendError(request, reply, 404, 'not_found', `unknown job ${jobId}`);
  return reply.code(200).send(store.resultJson(jobId));
}

async function listRecordings(request, reply) {
  const items = request.server.state.store.recordingsIndex().map((row) => ({
    recordingId: row.recordingId,
    jobId: row.jobId,
    status: row.status,
    webdavUrl: row.webdavUrl,
    pages: row.pages,
    updatedAt: row.updatedAt,
  }));
  return reply.code(200).send(items);
}

async function getRecording(request, reply) {
  const { recordingId } = request.params;
  const store = request.server.state.store;
  const rec = store.latestFor(recordingId);
  if (rec === null) return sendError(request, reply, 404, 'not_found', `no job for recording ${recordingId}`);
  return reply.code(200).send(store.resultJson(rec.jobId));
}

async function retryWriter(request, reply) {
  const { jobId } = request.params;
  const store = request.server.state.store;
  const rec0 = store.job(jobId);
  if (rec0 === null) return sendError(request, reply, 404, 'not_found', `unknown job ${jobId}`);
  let writer = null;
  let reviews = null;
  const ct = String(request.headers['content-type'] || '');
  if (ct.startsWith('application/json')) {
    const payload = request.body;
    if (payload && isPlainObject(payload)) {
      if (payload.writer !== undefined && payload.writer !== null) {
        if (typeof payload.writer !== 'string') {
          return sendError(request, reply, 422, 'invalid_request', RETRY_BODY_MSG);
        }
        writer = payload.writer;
      }
      if (payload.reviews !== undefined && payload.reviews !== null) {
        if (!Array.isArray(payload.reviews)) {
          return sendError(request, reply, 422, 'invalid_request', RETRY_BODY_MSG);
        }
        try {
          reviews = canonicalReviews(payload.reviews);
        } catch (error) {
          if (error instanceof ValueError) return sendError(request, reply, 422, 'invalid_request', error.message);
          throw error;
        }
        if (!reviews.length) {
          return sendError(request, reply, 422, 'invalid_request', 'reviews must name at least one review');
        }
      }
    } else if (payload) {
      return sendError(request, reply, 422, 'invalid_request', RETRY_BODY_MSG);
    }
  }
  if (writer !== null && !WRITERS.includes(writer)) {
    return sendError(request, reply, 422, 'invalid_request', `invalid writer: ${writer}`);
  }
  let rec;
  try {
    rec = store.retryWriter(jobId, writer, reviews);
  } catch (error) {
    if (error instanceof RetryNotAllowed) {
      return sendError(request, reply, 409, 'retry_not_allowed', error.message);
    }
    if (error instanceof ValueError) return sendError(request, reply, 422, 'invalid_request', error.message);
    throw error;
  }
  wakeWorker(request);
  return reply.code(200).send({ status: rec.status });
}

async function retryPublish(request, reply) {
  const { jobId } = request.params;
  const store = request.server.state.store;
  const rec0 = store.job(jobId);
  if (rec0 === null) return sendError(request, reply, 404, 'not_found', `unknown job ${jobId}`);
  let rec;
  try {
    rec = store.retryPublish(jobId);
  } catch (error) {
    if (error instanceof RetryNotAllowed) {
      return sendError(request, reply, 409, 'retry_not_allowed', error.message);
    }
    throw error;
  }
  wakeWorker(request);
  return reply.code(200).send({ status: rec.status });
}

function registerApi(app) {
  const auth = { preHandler: [requireTokenHook] };
  app.post('/v1/pair', guarded(pair));
  app.post('/v1/jobs', auth, guarded(createJob));
  app.get('/v1/jobs/:jobId/files/:name/received', auth, guarded(fileReceived));
  app.put('/v1/jobs/:jobId/files/:name', auth, guarded(putFile));
  app.post('/v1/jobs/:jobId/commit', auth, guarded(commitJob));
  app.get('/v1/jobs/:jobId', auth, guarded(getJob));
  app.get('/v1/recordings', auth, guarded(listRecordings));
  app.get('/v1/recordings/:recordingId', auth, guarded(getRecording));
  app.post('/v1/jobs/:jobId/retry-writer', auth, guarded(retryWriter));
  app.post('/v1/jobs/:jobId/retry-publish', auth, guarded(retryPublish));
}

module.exports = { registerApi, sendError, crash, MAX_PUT_BYTES };
