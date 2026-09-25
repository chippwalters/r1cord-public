// SQLite job index plus datastore folders. All SQL stays in this module.
// Port of r1cord_server/store.py: same index.sqlite schema, same datastore layout and the same
// result.json / job.json / job.log bytes, so either server can open the other's datastore.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const { DatabaseSync } = require('node:sqlite');
const { REVIEW_KINDS, canonicalReviews } = require('./config');
const naming = require('./naming');
const { ValueError } = require('./errors');
const { pathString } = require('./paths');

const SCHEMA_VERSION = 1;
// PRAGMA user_version baseline; the Python server ignores it, so it can still open the database.
const USER_VERSION = 1;
const ACTIVE_STATUSES = Object.freeze([
  'uploading',
  'queued',
  'transcribing',
  'transcribed',
  'writing',
  'written',
  'publishing',
  'published',
]);
const TERMINAL_STATUSES = Object.freeze(['complete', 'error']);
const RETRY_WRITER_STATUSES = Object.freeze(['transcribed', 'written', 'published', 'complete', 'error']);
const AUDIO_NAMES = Object.freeze(['audio.m4a', 'audio.wav']);
const FILE_NAME_RE = /^[A-Za-z0-9._-]+$/;
const PHOTO_RE = /^photo-[A-Za-z0-9._-]+\.jpg$/;
const SHA256_RE = /^[0-9a-fA-F]{64}$/;
const WRITERS = Object.freeze(['claude_code', 'codex', 'grok_build', 'none']);
const PROCESS_ACTIONS = Object.freeze(['transcribe', 'review', 'publish']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (
    id INTEGER PRIMARY KEY,
    sha256 TEXT UNIQUE,
    label TEXT,
    created_at TEXT,
    last_used_at TEXT,
    revoked INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pair_codes (
    code TEXT PRIMARY KEY,
    expires_at TEXT,
    used INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    recording_id TEXT,
    status TEXT,
    error TEXT,
    title TEXT,
    reviews TEXT NOT NULL DEFAULT '',
    publish INTEGER,
    writer TEXT,
    publish_folder TEXT,
    skip_asr INTEGER DEFAULT 0,
    only_publish INTEGER DEFAULT 0,
    created_at TEXT,
    updated_at TEXT,
    finished_at TEXT,
    asr_json TEXT,
    timings_json TEXT
);
CREATE TABLE IF NOT EXISTS job_files (
    job_id TEXT,
    name TEXT,
    size INTEGER,
    sha256 TEXT,
    received INTEGER DEFAULT 0,
    PRIMARY KEY (job_id, name)
);
CREATE TABLE IF NOT EXISTS devices (
    serial TEXT PRIMARY KEY,
    model TEXT,
    adopted_at TEXT,
    last_seen_at TEXT,
    last_sync_at TEXT,
    last_error TEXT
);
CREATE TABLE IF NOT EXISTS device_recordings (
    serial TEXT,
    recording_id TEXT,
    device_status TEXT,
    title TEXT,
    created_at_ms INTEGER,
    first_seen_at TEXT,
    pulled_at TEXT,
    auto_job_id TEXT,
    changed_since_job INTEGER DEFAULT 0,
    flag TEXT,
    PRIMARY KEY (serial, recording_id)
);
CREATE TABLE IF NOT EXISTS device_files (
    serial TEXT,
    recording_id TEXT,
    name TEXT,
    size INTEGER,
    mtime INTEGER,
    sha256 TEXT,
    pulled_at TEXT,
    PRIMARY KEY (serial, recording_id, name)
);
-- Recordings deleted on the admin page. The USB watcher never pulls these again; an explicit
-- Send or Import (create_job) clears the mark.
CREATE TABLE IF NOT EXISTS deleted_recordings (
    recording_id TEXT PRIMARY KEY,
    deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_recording ON jobs (recording_id);
CREATE INDEX IF NOT EXISTS jobs_status_created ON jobs (status, created_at);
`;

const INSERT_JOB =
  'INSERT INTO jobs (job_id, recording_id, status, error, title, reviews, ' +
  'publish, writer, publish_folder, skip_asr, ' +
  'only_publish, created_at, updated_at, finished_at, asr_json, timings_json) ';

const SILENT_LOGGER = Object.freeze({ info() {}, warn() {} });

// --- errors -------------------------------------------------------------------

class StoreError extends Error {
  constructor(message) {
    super(message);
    this.name = new.target.name;
  }
}

class JobActive extends StoreError {
  constructor(jobId) {
    super(`job already active: ${jobId}`);
    this.jobId = jobId;
  }
}

class AudioMismatch extends StoreError {
  constructor(recordingId) {
    super(`audio hash mismatch for recording ${recordingId}`);
    this.recordingId = recordingId;
  }
}

class OffsetMismatch extends StoreError {
  constructor(received) {
    super(`offset mismatch: received ${received}`);
    this.received = received;
  }
}

class TooLarge extends StoreError {
  constructor(size) {
    super(`body would exceed manifest size ${size}`);
    this.size = size;
  }
}

class Incomplete extends StoreError {
  constructor(files) {
    super('upload incomplete');
    this.files = files;
  }
}

class HashMismatch extends StoreError {
  constructor(files) {
    super(`hash mismatch: ${pyReprList(files)}`);
    this.files = files;
  }
}

class JobNotUploading extends StoreError {
  constructor(jobId, status) {
    super(`job ${jobId} is ${status}, not uploading`);
    this.jobId = jobId;
    this.status = status;
  }
}

class RetryNotAllowed extends StoreError {}

class UnknownJob extends StoreError {
  constructor(jobId) {
    super(`unknown job ${jobId}`);
    this.jobId = jobId;
  }
}

// OSError.strerror: the system's text for a filesystem error, without the code and path. libuv
// errors carry a negative errno; the native rm reports "EPERM, Permission denied: <path>".
function strerror(error) {
  if (Number.isInteger(error.errno) && error.errno < 0) return util.getSystemErrorMessage(error.errno);
  const native = /^[A-Z][A-Z0-9]*, ([^:]+):/.exec(String(error.message));
  return native ? native[1] : String(error.message);
}

// Python's FileNotFoundError: an Error with code ENOENT, like Node's own.
function fileNotFound(message) {
  const error = new Error(message);
  error.code = 'ENOENT';
  return error;
}

// --- Python-compatible helpers --------------------------------------------------

// Characters Python's str.isspace() accepts; str.strip() removes exactly these.
const PY_SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_STRIP_RE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'g');
const PY_RSTRIP_RE = new RegExp(`[${PY_SPACE}]+$`);
// str.splitlines() boundaries (after universal-newline reading turned \r\n and \r into \n).
const PY_LINES_RE = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
const PY_NONPRINTABLE_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

function pyStrip(value) {
  return String(value).replace(PY_STRIP_RE, '');
}

function pyRstrip(value) {
  return String(value).replace(PY_RSTRIP_RE, '');
}

function codePoints(value) {
  return Array.from(String(value));
}

// Python's repr() of a str, as used in error messages.
function pyRepr(value) {
  const text = String(value);
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (ch === '\\' || ch === quote) out += `\\${ch}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch !== ' ' && PY_NONPRINTABLE_RE.test(ch)) {
      if (cp <= 0xff) out += `\\x${cp.toString(16).padStart(2, '0')}`;
      else if (cp <= 0xffff) out += `\\u${cp.toString(16).padStart(4, '0')}`;
      else out += `\\U${cp.toString(16).padStart(8, '0')}`;
    } else out += ch;
  }
  return out + quote;
}

function pyReprList(values) {
  return `[${values.map(pyRepr).join(', ')}]`;
}

// Python truthiness for JSON values: empty containers are false.
function pyTruthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

// str() of a JSON value.
function pyStr(value) {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return pyNumber(value);
  if (typeof value === 'string') return value;
  return jsonDumps(value);
}

// int() of a JSON value.
function pyInt(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const text = pyStrip(value);
    if (/^[+-]?\d+(_\d+)*$/.test(text)) return Number(text.replace(/_/g, ''));
  }
  throw new ValueError(`invalid literal for int() with base 10: ${pyRepr(pyStr(value))}`);
}

// A column read the way str(row[...]) does: NULL becomes 'None'.
function str(value) {
  return value === null || value === undefined ? 'None' : String(value);
}

function pyNumber(value) {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
  if (Number.isInteger(value)) return Math.abs(value) < 1e21 ? String(value) : BigInt(value).toString();
  // float repr: fixed notation for exponents -4..15, else d.ddde+XX (at least two exponent digits).
  const [mantissa, exponentText] = value.toExponential().split('e');
  const exponent = Number(exponentText);
  if (exponent >= -4 && exponent < 16) return String(value);
  const sign = exponent < 0 ? '-' : '+';
  return `${mantissa}e${sign}${String(Math.abs(exponent)).padStart(2, '0')}`;
}

const JSON_ESCAPES = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };

function jsonString(value) {
  // ensure_ascii: everything outside printable ASCII becomes \uXXXX (UTF-16 units, lower-case hex).
  const escaped = value.replace(
    /[\\"]|[^ -~]/g,
    (ch) => JSON_ESCAPES[ch] || `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return `"${escaped}"`;
}

/**
 * Python's json.dumps(value) / json.dumps(value, indent=N): same separators, same
 * ensure_ascii escaping, so files and columns match the Python server byte for byte.
 * @param {unknown} value
 * @param {number|null} [indent]
 * @returns {string}
 */
function jsonDumps(value, indent = null) {
  const itemSeparator = indent === null ? ', ' : ',';
  const encode = (item, level) => {
    if (item === null || item === undefined) return 'null';
    if (item === true) return 'true';
    if (item === false) return 'false';
    if (typeof item === 'number') return pyNumber(item);
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'string') return jsonString(item);
    const entries = Array.isArray(item)
      ? item.map((child) => encode(child, level + 1))
      : Object.entries(item)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => `${jsonString(key)}: ${encode(child, level + 1)}`);
    const [open, close] = Array.isArray(item) ? ['[', ']'] : ['{', '}'];
    if (entries.length === 0) return open + close;
    if (indent === null) return open + entries.join(itemSeparator) + close;
    const inner = `\n${' '.repeat(indent * (level + 1))}`;
    const outer = `\n${' '.repeat(indent * level)}`;
    return open + inner + entries.join(itemSeparator + inner) + outer + close;
  };
  return encode(value, 0);
}

// Python text-mode writes turn '\n' into os.linesep.
function platformText(text) {
  return os.EOL === '\n' ? text : text.replace(/\n/g, os.EOL);
}

function writeText(file, text) {
  fs.writeFileSync(file, platformText(text), 'utf8');
}

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// json.loads(path.read_text(encoding="utf-8")): undecodable or malformed files are a ValueError.
function readJson(file) {
  const bytes = fs.readFileSync(file);
  try {
    return JSON.parse(STRICT_UTF8.decode(bytes));
  } catch (error) {
    throw new ValueError(`${path.basename(file)}: ${error.message}`);
  }
}

function fileStat(file) {
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    return stat && stat.isFile() ? stat : null;
  } catch (_error) {
    return null;
  }
}

function isDir(dir) {
  try {
    const stat = fs.statSync(dir, { throwIfNoEntry: false });
    return Boolean(stat && stat.isDirectory());
  } catch (_error) {
    return false;
  }
}

// Path.resolve(): the real path when it can be read, else the lexical absolute path.
function resolvePath(target) {
  try {
    return fs.realpathSync.native(target);
  } catch (_error) {
    return path.resolve(target);
  }
}

function samePath(a, b) {
  const relative = path.relative(resolvePath(a), resolvePath(b));
  return relative === '';
}

// True when `target` sits strictly below `root` (Path.parents; case-insensitive on Windows).
function strictlyInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..';
}

// shutil.copy2: contents plus timestamps.
function copyFile2(source, dest) {
  fs.copyFileSync(source, dest);
  const stat = fs.statSync(source);
  fs.utimesSync(dest, stat.atime, stat.mtime);
}

function sortedPaths(names) {
  // sorted(Path, ...) compares case-insensitively on Windows.
  const key = process.platform === 'win32' ? (name) => name.toLowerCase() : (name) => name;
  return [...names].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka < kb) return -1;
    return ka > kb ? 1 : 0;
  });
}

function defaultTimings() {
  return { asr: 0, writer: 0, publish: 0 };
}

function isoSeconds(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function utcnowIso() {
  return isoSeconds(new Date());
}

function msToIso(ms) {
  return isoSeconds(new Date(ms));
}

function isoToMs(value) {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new ValueError(`Invalid isoformat string: ${pyRepr(value)}`);
  return ms;
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

function sha256File(file) {
  const digest = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return digest.digest('hex');
}

function compareDigest(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function isConstraintError(error) {
  // SQLITE_CONSTRAINT (19), reported as an extended code such as 2067 (UNIQUE).
  return Boolean(error) && typeof error.errcode === 'number' && (error.errcode & 0xff) === 19;
}

// A device name, alone or before a dot ("NUL.txt", "nul .txt"): Windows opens the device, not a
// folder of that name.
const RESERVED_ID_RE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³]) *(\.|$)/i;
// Characters Windows forbids in a file name (NUL is refused separately, like Python does).
const FORBIDDEN_ID_CHARS_RE = /[<>"|?*\x01-\x1f]/;

/**
 * Recording ids become folder names under inbox/ and outbox/.
 * Refuse anything that could escape those roots ("..", separators) or that Windows would
 * normalize into a different name (surrounding whitespace, a trailing dot), read as something
 * other than a folder (":" names a drive or an alternate data stream; device names) or refuse
 * outright (< > " | ? * and control characters). Python only has the first two rules; there the
 * others escape the inbox, alias another recording or fail with an OS error.
 */
function isValidRecordingId(recordingId) {
  return !(
    typeof recordingId !== 'string' ||
    !recordingId ||
    recordingId === '.' ||
    recordingId === '..' ||
    recordingId.includes('/') ||
    recordingId.includes('\\') ||
    recordingId.includes('\x00') ||
    recordingId !== pyStrip(recordingId) ||
    recordingId.includes(':') ||
    recordingId.endsWith('.') ||
    FORBIDDEN_ID_CHARS_RE.test(recordingId) ||
    RESERVED_ID_RE.test(recordingId)
  );
}

function checkRecordingId(recordingId) {
  if (!isValidRecordingId(recordingId)) {
    throw new ValueError(`invalid recordingId: ${typeof recordingId === 'string' ? pyRepr(recordingId) : String(recordingId)}`);
  }
}

// The `reviews` column: canonical kinds joined by commas; '' for transcript only.
function splitReviews(value) {
  return String(value || '').split(',').filter((kind) => REVIEW_KINDS.includes(kind));
}

// node:sqlite binds numbers, strings, null and bytes; Python's sqlite3 also binds bools as ints.
function bindable(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

// An open `.partial` upload file: writes at the running offset and rolls back to `offset` when a
// chunk would pass the manifest size.
function openPartial(file, offset, size) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, offset === 0 ? 'w' : 'r+');
  let received = offset;
  return {
    get received() {
      return received;
    },
    write(chunk) {
      if (!chunk || chunk.length === 0) return;
      if (received + chunk.length > size) {
        fs.ftruncateSync(fd, offset);
        throw new TooLarge(size);
      }
      let written = 0;
      while (written < chunk.length) {
        written += fs.writeSync(fd, chunk, written, chunk.length - written, received + written);
      }
      received += chunk.length;
    },
    close() {
      fs.closeSync(fd);
    },
  };
}

/**
 * @typedef {{name: string, size: number, sha256: string}} FileSpec
 * @typedef {{recordingId: string, createdAtMs: number, title: string, reviews: string[],
 *   publish: boolean, files: FileSpec[], schemaVersion?: number, writer?: string|null}} JobRequest
 * @typedef {{jobId: string, recordingId: string, status: string, error: string|null, title: string,
 *   reviews: string[], publish: boolean, writer: string, webdavUrl: string|null,
 *   publishFolder: string|null, skipAsr: boolean, onlyPublish: boolean, createdAt: string,
 *   updatedAt: string, finishedAt: string|null, asr: object|null, timings: Object<string, number>,
 *   createdAtMs: number, files: FileSpec[]}} JobRecord
 */

class JobStore {
  /**
   * @param {object} config frozen config (snake_case keys, as in config.toml)
   * @param {{clock?: () => string, logger?: {info: Function, warn: Function}}} [options]
   *   clock: the ISO-8601 UTC "now" (utcnowIso); logger: receives the store's log lines.
   */
  constructor(config, { clock = utcnowIso, logger = SILENT_LOGGER } = {}) {
    this.config = config;
    this._now = clock;
    this._log = logger;
    this._statements = new Map();
    const root = String(config.datastore);
    for (const name of ['inbox', 'work', 'outbox', 'logs']) fs.mkdirSync(path.join(root, name), { recursive: true });
    this._dbPath = path.join(root, 'index.sqlite');
    this._db = new DatabaseSync(this._dbPath, { timeout: 30000 });
    this._db.exec('PRAGMA journal_mode=WAL');
    this._db.exec('PRAGMA foreign_keys=ON');
    this._db.exec(SCHEMA);
    this._migrate();
    if (Number(this._get('PRAGMA user_version').user_version) === 0) this._db.exec(`PRAGMA user_version = ${USER_VERSION}`);
  }

  close() {
    this._statements.clear();
    if (this._db.isOpen) this._db.close();
  }

  /** Bring a database from before AI reviews up to date: `summarize` becomes `reviews`, and the
   * summary style and the stored URL (now derived from the publish folder) go. */
  _migrate() {
    const columns = new Set(this._all('PRAGMA table_info(jobs)').map((row) => String(row.name)));
    const stale = ['summarize', 'summary_style', 'webdav_url'].filter((column) => columns.has(column));
    if (columns.has('reviews') && stale.length === 0) return;
    this._transaction(() => {
      if (!columns.has('reviews')) {
        this._db.exec("ALTER TABLE jobs ADD COLUMN reviews TEXT NOT NULL DEFAULT ''");
        if (columns.has('summarize')) {
          this._db.exec("UPDATE jobs SET reviews = CASE WHEN summarize = 1 THEN 'summary' ELSE '' END");
        }
        this._log.info('store: migrated jobs to AI reviews');
      }
      for (const column of stale) this._db.exec(`ALTER TABLE jobs DROP COLUMN ${column}`);
    });
  }

  // --- paths -----------------------------------------------------------------

  inboxDir(recordingId) {
    checkRecordingId(recordingId);
    const dir = path.join(this.config.datastore, 'inbox', recordingId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  workDir(jobId) {
    const rec = this.job(jobId);
    if (rec === null) throw new UnknownJob(jobId);
    const dir = path.join(this.config.datastore, 'work', rec.recordingId, jobId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  outboxDir(recordingId) {
    checkRecordingId(recordingId);
    const dir = path.join(this.config.datastore, 'outbox', recordingId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // --- auth ------------------------------------------------------------------

  createPairCode() {
    const expiresAt = isoSeconds(new Date(Date.now() + Number(this.config.pair_code_ttl_s) * 1000));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = String(crypto.randomInt(1_000_000)).padStart(6, '0');
      try {
        this._run('INSERT INTO pair_codes (code, expires_at, used) VALUES (?, ?, 0)', code, expiresAt);
        return code;
      } catch (error) {
        if (!isConstraintError(error)) throw error;
      }
    }
    this._log.warn('store: could not allocate a pairing code after 20 attempts');
    throw new StoreError('could not allocate a pairing code');
  }

  redeemPairCode(code, label) {
    const now = this._now();
    const row = this._get('SELECT code, expires_at, used FROM pair_codes WHERE code = ?', code);
    if (!row || Number(row.used) !== 0 || str(row.expires_at) < now) return null;
    const raw = crypto.randomBytes(32).toString('hex');
    const digest = hashToken(raw);
    this._transaction(() => {
      this._run('UPDATE pair_codes SET used = 1 WHERE code = ?', code);
      this._run(
        'INSERT INTO tokens (sha256, label, created_at, last_used_at, revoked) VALUES (?, ?, ?, NULL, 0)',
        digest,
        label,
        now,
      );
    });
    return raw;
  }

  tokenValid(rawToken) {
    const digest = hashToken(rawToken);
    const row = this._get('SELECT id, sha256, revoked FROM tokens WHERE sha256 = ?', digest);
    if (!row || Number(row.revoked) !== 0) {
      compareDigest(digest, '0'.repeat(64));
      return false;
    }
    if (!compareDigest(str(row.sha256), digest)) return false;
    this._run('UPDATE tokens SET last_used_at = ? WHERE id = ?', this._now(), row.id);
    return true;
  }

  tokens() {
    return this._all('SELECT id, sha256, label, created_at, last_used_at, revoked FROM tokens ORDER BY id DESC').map(
      (row) => ({
        id: Number(row.id),
        sha256: str(row.sha256),
        label: String(row.label || ''),
        createdAt: str(row.created_at),
        lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
        revoked: Boolean(Number(row.revoked)),
      }),
    );
  }

  revokeToken(tokenId) {
    this._run('UPDATE tokens SET revoked = 1 WHERE id = ?', tokenId);
  }

  // --- jobs ------------------------------------------------------------------

  /**
   * @param {JobRequest} job
   * @param {object} metadata the recording's metadata.json, written to its inbox folder
   * @returns {JobRecord}
   */
  createJob(job, metadata) {
    this._validateRequest(job);
    const reviews = canonicalReviews(job.reviews);
    const active = this.activeJobFor(job.recordingId);
    if (active !== null) throw new JobActive(active.jobId);

    const inbox = this.inboxDir(job.recordingId);
    this._checkAudioMismatch(inbox, job);

    const writer = job.writer || this.config.default_writer;
    if (!WRITERS.includes(writer)) throw new ValueError(`invalid writer: ${writer}`);

    const existing = this.latestFor(job.recordingId);
    // str(Path(...)): the stored folder in its canonical lexical form.
    const publishPath = pathString(
      existing && existing.publishFolder
        ? existing.publishFolder
        : naming.publishFolder(this.config, job.createdAtMs, job.title, job.recordingId, this._occupiedFolders()),
    );

    const now = this._now();
    const jobId = crypto.randomUUID();
    const createdIso = msToIso(job.createdAtMs);
    const title = pyStrip(job.title);
    writeText(path.join(inbox, 'metadata.json'), jsonDumps(metadata, 2));
    // Files already in the inbox (an earlier job of this recording) count as received.
    const received = job.files.map((spec) => {
      const dest = path.join(inbox, spec.name);
      const stat = fileStat(dest);
      return stat && sha256File(dest) === spec.sha256.toLowerCase() && stat.size === spec.size ? spec.size : 0;
    });
    this._transaction(() => {
      this._run(
        `${INSERT_JOB}VALUES (?, ?, 'uploading', NULL, ?, ?, ?, ?, ?, 0, 0, ?, ?, NULL, NULL, ?)`,
        jobId,
        job.recordingId,
        title,
        reviews.join(','),
        job.publish ? 1 : 0,
        writer,
        publishPath,
        createdIso,
        now,
        jsonDumps(defaultTimings()),
      );
      job.files.forEach((spec, index) => {
        this._run(
          'INSERT INTO job_files (job_id, name, size, sha256, received) VALUES (?, ?, ?, ?, ?)',
          jobId,
          spec.name,
          spec.size,
          spec.sha256.toLowerCase(),
          received[index],
        );
      });
      this._run('DELETE FROM deleted_recordings WHERE recording_id = ?', job.recordingId);
    });
    const rec = this.job(jobId);
    this._writeResultJson(rec);
    return rec;
  }

  hasActiveJobs() {
    return this._get("SELECT 1 AS one FROM jobs WHERE status NOT IN ('complete', 'error') LIMIT 1") !== undefined;
  }

  /**
   * The newest job of each recording, newest first, with that recording's job count.
   * @returns {Array<[JobRecord, number]>}
   */
  latestJobs(limit = 100) {
    const rows = this._all(
      `
      SELECT * FROM (
          SELECT j.*,
                 ROW_NUMBER() OVER (PARTITION BY recording_id ORDER BY rowid DESC) AS rn,
                 COUNT(*) OVER (PARTITION BY recording_id) AS runs,
                 rowid AS rid
          FROM jobs j
      ) WHERE rn = 1
      ORDER BY updated_at DESC, rid DESC
      LIMIT ?
      `,
      limit,
    );
    return rows.map((row) => [this._jobFromRow(row), Number(row.runs)]);
  }

  isDeleted(recordingId) {
    return this._get('SELECT 1 AS one FROM deleted_recordings WHERE recording_id = ?', recordingId) !== undefined;
  }

  /**
   * Remove a recording from this PC: its inbox, outbox and work folders, every published page it
   * produced (only inside `webdav_folder`), its jobs and its device-ledger rows.
   *
   * Files go first: if one is locked (open in a media player), nothing in the index changes and the
   * delete can simply be retried. The R1's own copy is never touched; the recording is marked
   * deleted so USB mode does not pull it back.
   */
  deleteRecording(recordingId) {
    checkRecordingId(recordingId);
    if (this.activeJobFor(recordingId) !== null) {
      throw new StoreError('a job is still running for this recording; wait for it to finish');
    }
    const folders = this._all(
      'SELECT DISTINCT publish_folder FROM jobs WHERE recording_id = ? AND publish_folder IS NOT NULL',
      recordingId,
    ).map((row) => String(row.publish_folder));
    const root = String(this.config.datastore);
    const targets = ['inbox', 'outbox', 'work'].map((area) => path.join(root, area, recordingId));
    for (const folder of folders) {
      // Only a folder this server published into, never the publish root or anything outside it.
      const target = this._publishedTarget(folder);
      if (target !== null) targets.push(target);
    }
    for (const target of targets) {
      if (!fs.existsSync(target)) continue;
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch (error) {
        this._log.warn(`delete ${recordingId}: could not remove ${target}: ${error.message}`);
        const wrapped = new StoreError(`could not remove ${path.basename(target)}: ${strerror(error)}`);
        wrapped.cause = error;
        throw wrapped;
      }
    }
    this._transaction(() => {
      this._run(
        'DELETE FROM job_files WHERE job_id IN (SELECT job_id FROM jobs WHERE recording_id = ?)',
        recordingId,
      );
      for (const table of ['jobs', 'device_files', 'device_recordings']) {
        this._run(`DELETE FROM ${table} WHERE recording_id = ?`, recordingId);
      }
      this._run(
        'INSERT OR REPLACE INTO deleted_recordings (recording_id, deleted_at) VALUES (?, ?)',
        recordingId,
        this._now(),
      );
    });
    this._log.info(`delete ${recordingId}: removed ${targets.length} folder(s) and its job history`);
  }

  activeJobFor(recordingId) {
    const row = this._get(
      "SELECT * FROM jobs WHERE recording_id = ? AND status NOT IN ('complete', 'error') " +
        'ORDER BY created_at DESC, rowid DESC LIMIT 1',
      recordingId,
    );
    return row ? this._jobFromRow(row) : null;
  }

  job(jobId) {
    const row = this._get('SELECT * FROM jobs WHERE job_id = ?', jobId);
    return row ? this._jobFromRow(row) : null;
  }

  latestFor(recordingId) {
    const row = this._get('SELECT * FROM jobs WHERE recording_id = ? ORDER BY rowid DESC LIMIT 1', recordingId);
    return row ? this._jobFromRow(row) : null;
  }

  recordingsIndex() {
    const rows = this._all(`
      SELECT recording_id, job_id, status, reviews, publish, publish_folder, updated_at FROM (
          SELECT j.*, ROW_NUMBER() OVER (PARTITION BY recording_id ORDER BY rowid DESC) AS rn
          FROM jobs j
      ) WHERE rn = 1
      ORDER BY updated_at DESC
      `);
    return rows.map((row) => {
      const folder = row.publish_folder ? String(row.publish_folder) : null;
      const url = this._predictedUrl(folder, splitReviews(row.reviews));
      return {
        recordingId: str(row.recording_id),
        jobId: str(row.job_id),
        status: str(row.status),
        webdavUrl: Number(row.publish) ? url : null,
        pages: naming.publishedPages(this.config, folder),
        updatedAt: str(row.updated_at),
      };
    });
  }

  recentJobs(limit = 50) {
    return this._all('SELECT * FROM jobs ORDER BY updated_at DESC, rowid DESC LIMIT ?', limit).map((row) =>
      this._jobFromRow(row),
    );
  }

  nextQueued() {
    const row = this._get("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1");
    return row ? this._jobFromRow(row) : null;
  }

  /**
   * Requeue jobs a previous run left mid-pipeline; call before the worker starts.
   *
   * The worker owns a job from `transcribing` to `published`; if the server stopped in between,
   * nothing else would ever move the job on and its recording would answer `job_active` forever.
   * An unfinished job whose recording id this server refuses (a row written by an older server)
   * fails with "invalid recording id" instead; no folder is built for it.
   * @returns {Array<[string, string, string]>} `[jobId, was, now]` for each job it moved
   */
  recoverInterrupted() {
    const moved = [];
    const unfinished = this._all("SELECT job_id, recording_id, status FROM jobs WHERE status NOT IN ('complete', 'error')");
    for (const row of unfinished) {
      if (isValidRecordingId(row.recording_id)) continue;
      const jobId = str(row.job_id);
      this.setStatus(jobId, 'error', { error: 'invalid recording id' });
      this._log.warn(`store: job ${jobId} failed at startup: invalid recording id ${pyRepr(str(row.recording_id))}`);
      moved.push([jobId, str(row.status), 'error']);
    }
    const rows = this._all(
      'SELECT job_id, recording_id, status, publish FROM jobs WHERE status IN (?, ?, ?, ?, ?, ?)',
      'transcribing',
      'transcribed',
      'writing',
      'written',
      'publishing',
      'published',
    );
    for (const row of rows) {
      const jobId = str(row.job_id);
      const was = str(row.status);
      const hasTranscript = fileStat(path.join(this.outboxDir(str(row.recording_id)), 'transcript.txt')) !== null;
      if (was === 'published' || (was === 'written' && !Number(row.publish))) {
        this.setStatus(jobId, 'complete'); // the last step had finished
      } else if (was === 'written' || was === 'publishing') {
        this.setStatus(jobId, 'queued', { skipAsr: true, onlyPublish: true });
      } else if ((was === 'transcribed' || was === 'writing') && hasTranscript) {
        this.setStatus(jobId, 'queued', { skipAsr: true, onlyPublish: false });
      } else {
        this.setStatus(jobId, 'queued', { skipAsr: false, onlyPublish: false });
      }
      const now = this.job(jobId).status;
      this.appendLog(jobId, `recovered after a server restart: was ${was}, now ${now}`);
      moved.push([jobId, was, now]);
    }
    return moved;
  }

  /**
   * @param {string} jobId
   * @param {string} status
   * @param {{error?: string|null, skipAsr?: boolean, onlyPublish?: boolean, writer?: string,
   *   publishFolder?: string|null, reviews?: string[], asr?: object|null,
   *   timings?: Object<string, number>}} [fields] omitted (undefined) fields stay as they are
   */
  setStatus(jobId, status, fields = {}) {
    const rec = this.job(jobId);
    if (rec === null) throw new UnknownJob(jobId);
    const now = this._now();
    const updates = { status, updated_at: now };
    if (status === 'error') {
      updates.error = fields.error === undefined ? null : fields.error;
      updates.finished_at = now;
    } else {
      updates.error = null;
      if (status === 'complete') updates.finished_at = now;
      else if (status === 'queued') updates.finished_at = null;
    }
    const mapping = [
      ['skipAsr', 'skip_asr'],
      ['onlyPublish', 'only_publish'],
      ['writer', 'writer'],
      ['publishFolder', 'publish_folder'],
    ];
    for (const [key, column] of mapping) {
      if (fields[key] === undefined) continue;
      const value = fields[key];
      updates[column] = key === 'skipAsr' || key === 'onlyPublish' ? (value ? 1 : 0) : value;
    }
    if (fields.reviews !== undefined) updates.reviews = canonicalReviews(fields.reviews).join(',');
    if (fields.asr !== undefined) updates.asr_json = fields.asr !== null ? jsonDumps(fields.asr) : null;
    if (fields.timings !== undefined) updates.timings_json = jsonDumps(fields.timings);
    const columns = Object.keys(updates);
    this._run(
      `UPDATE jobs SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE job_id = ?`,
      ...columns.map((column) => updates[column]),
      jobId,
    );
    this._writeResultJson(this.job(jobId));
  }

  appendLog(jobId, line) {
    const rec = this.job(jobId);
    if (rec === null) throw new UnknownJob(jobId);
    const file = path.join(this.outboxDir(rec.recordingId), 'job.log');
    fs.appendFileSync(file, platformText(`${this._now()} ${pyRstrip(line)}\n`), 'utf8');
  }

  readLog(jobId, tail = 200) {
    const rec = this.job(jobId);
    if (rec === null) throw new UnknownJob(jobId);
    const file = path.join(this.outboxDir(rec.recordingId), 'job.log');
    if (!fileStat(file)) return [];
    const lines = fs.readFileSync(file).toString('utf8').split(PY_LINES_RE);
    if (lines[lines.length - 1] === '') lines.pop();
    if (tail <= 0) return lines;
    return lines.slice(-tail);
  }

  resultJson(jobId) {
    const rec = this.job(jobId);
    if (rec === null) throw new UnknownJob(jobId);
    const history = this._all(
      'SELECT job_id, writer, status, finished_at FROM jobs WHERE recording_id = ? ORDER BY created_at ASC, rowid ASC',
      rec.recordingId,
    ).map((row) => ({
      jobId: str(row.job_id),
      writer: str(row.writer),
      status: str(row.status),
      finishedAt: row.finished_at ? String(row.finished_at) : null,
    }));
    const asr = rec.asr;
    const field = (name) => (Object.hasOwn(asr, name) ? asr[name] : null);
    const asrOut = asr !== null ? { model: field('model'), device: field('device'), language: field('language') } : null;
    return {
      schemaVersion: SCHEMA_VERSION,
      recordingId: rec.recordingId,
      jobId: rec.jobId,
      status: rec.status,
      error: rec.error,
      title: rec.title,
      reviews: [...rec.reviews],
      publish: rec.publish,
      writer: rec.writer,
      asr: asrOut,
      webdavUrl: rec.publish ? rec.webdavUrl : null,
      pages: this.pages(rec),
      publishFolder: rec.publishFolder,
      timingsMs: Object.keys(rec.timings).length ? rec.timings : defaultTimings(),
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      history,
    };
  }

  /** The newest other job of the recording that got as far as writing `kind`: the job an existing
   * `<kind>.md` most likely came from. Names the archived copy on a rewrite. */
  previousReviewJob(recordingId, kind, jobId) {
    const rows = this._all(
      'SELECT job_id, reviews FROM jobs WHERE recording_id = ? AND job_id != ? ' +
        "AND status IN ('written', 'publishing', 'published', 'complete', 'error') " +
        'ORDER BY rowid DESC',
      recordingId,
      jobId,
    );
    const row = rows.find((candidate) => splitReviews(candidate.reviews).includes(kind));
    return row ? String(row.job_id) : null;
  }

  /** Pages actually published for the job's recording (every job of a recording shares one
   * publish folder). */
  pages(rec) {
    return naming.publishedPages(this.config, rec.publishFolder);
  }

  // --- upload ----------------------------------------------------------------

  fileReceived(jobId, name) {
    const row = this._get('SELECT received FROM job_files WHERE job_id = ? AND name = ?', jobId, name);
    if (!row) return null;
    const rec = this.job(jobId);
    if (rec === null) return null;
    const partial = fileStat(path.join(this.inboxDir(rec.recordingId), '.upload', `${name}.partial`));
    if (partial) return partial.size;
    return Number(row.received);
  }

  /**
   * Append `body` (an iterable of byte chunks) to the file's upload at `offset`.
   * @returns {number} bytes received so far
   */
  appendFile(jobId, name, offset, body) {
    const upload = this._beginAppend(jobId, name, offset);
    if (upload.done) {
      for (const chunk of body) if (chunk && chunk.length) throw new TooLarge(upload.size);
      return upload.size;
    }
    const partial = openPartial(upload.path, offset, upload.size);
    try {
      for (const chunk of body) partial.write(chunk);
    } finally {
      partial.close();
    }
    this._finishAppend(jobId, name, partial.received);
    return partial.received;
  }

  /** appendFile for an async iterable body (an HTTP request stream). */
  async appendFileAsync(jobId, name, offset, body) {
    const upload = this._beginAppend(jobId, name, offset);
    if (upload.done) {
      for await (const chunk of body) if (chunk && chunk.length) throw new TooLarge(upload.size);
      return upload.size;
    }
    const partial = openPartial(upload.path, offset, upload.size);
    try {
      for await (const chunk of body) partial.write(chunk);
    } finally {
      partial.close();
    }
    this._finishAppend(jobId, name, partial.received);
    return partial.received;
  }

  commit(jobId) {
    const rec = this.job(jobId);
    if (rec === null) throw new UnknownJob(jobId);
    if (rec.status !== 'uploading') return rec;
    const files = this._filesFor(jobId);
    const inbox = this.inboxDir(rec.recordingId);
    const incomplete = [];
    const mismatches = [];
    for (const spec of files) {
      const partial = path.join(inbox, '.upload', `${spec.name}.partial`);
      const final = path.join(inbox, spec.name);
      let source = partial;
      let stat = fileStat(partial);
      if (!stat) {
        source = final;
        stat = fileStat(final);
      }
      if (!stat) {
        incomplete.push({ name: spec.name, received: 0, size: spec.size });
        continue;
      }
      if (stat.size !== spec.size) {
        incomplete.push({ name: spec.name, received: stat.size, size: spec.size });
        continue;
      }
      if (sha256File(source) !== spec.sha256.toLowerCase()) {
        mismatches.push(spec.name);
        if (source === partial) {
          fs.unlinkSync(partial);
          this._run('UPDATE job_files SET received = 0 WHERE job_id = ? AND name = ?', jobId, spec.name);
        }
      }
    }
    if (incomplete.length) throw new Incomplete(incomplete);
    if (mismatches.length) throw new HashMismatch(mismatches);
    this._transaction(() => {
      for (const spec of files) {
        const partial = path.join(inbox, '.upload', `${spec.name}.partial`);
        const final = path.join(inbox, spec.name);
        if (fileStat(partial)) {
          if (fs.existsSync(final)) fs.unlinkSync(final);
          fs.renameSync(partial, final);
        }
        this._run('UPDATE job_files SET received = ? WHERE job_id = ? AND name = ?', spec.size, jobId, spec.name);
      }
      const uploadDir = path.join(inbox, '.upload');
      if (isDir(uploadDir) && fs.readdirSync(uploadDir).length === 0) fs.rmdirSync(uploadDir);
      const jobJson = {
        schemaVersion: SCHEMA_VERSION,
        recordingId: rec.recordingId,
        createdAt: rec.createdAt,
        title: rec.title,
        reviews: [...rec.reviews],
        publish: rec.publish,
        files: files.map((spec) => ({ name: spec.name, size: spec.size, sha256: spec.sha256 })),
      };
      writeText(path.join(inbox, 'job.json'), jsonDumps(jobJson, 2));
    });
    this.setStatus(jobId, 'queued');
    return this.job(jobId);
  }

  // --- retries ---------------------------------------------------------------

  /** Re-run the writer on the existing transcript. `reviews` defaults to the job's own; an
   * explicit list must name at least one known kind (ValueError otherwise). */
  retryWriter(jobId, writer, reviews = null) {
    const rec = this.job(jobId);
    if (rec === null) throw new UnknownJob(jobId);
    let chosenReviews = rec.reviews;
    if (reviews !== null && reviews !== undefined) {
      chosenReviews = canonicalReviews(reviews);
      if (!chosenReviews.length) throw new ValueError('choose at least one review');
    }
    if (!RETRY_WRITER_STATUSES.includes(rec.status)) {
      throw new RetryNotAllowed(`cannot retry writer from status ${rec.status}`);
    }
    if (!fileStat(path.join(this.outboxDir(rec.recordingId), 'transcript.txt'))) {
      throw new RetryNotAllowed('transcript.txt is missing');
    }
    if (!chosenReviews.length) throw new RetryNotAllowed('this job has no AI reviews; choose at least one');
    const chosen = writer || rec.writer;
    if (!WRITERS.includes(chosen) || chosen === 'none') throw new RetryNotAllowed(`invalid writer: ${chosen}`);
    this.setStatus(jobId, 'queued', { writer: chosen, reviews: chosenReviews, skipAsr: true, onlyPublish: false });
    return this.job(jobId);
  }

  retryPublish(jobId) {
    const rec = this.job(jobId);
    if (rec === null) throw new UnknownJob(jobId);
    const outbox = this.outboxDir(rec.recordingId);
    const sources = ['transcript.txt', 'transcript.md', ...REVIEW_KINDS.map((kind) => `${kind}.md`)];
    if (!sources.some((name) => fileStat(path.join(outbox, name)))) {
      throw new RetryNotAllowed('nothing to publish: no transcript or AI review yet');
    }
    this.setStatus(jobId, 'queued', { skipAsr: true, onlyPublish: true });
    return this.job(jobId);
  }

  // --- import ----------------------------------------------------------------

  /**
   * Copy a dropped R1CORD folder (metadata.json, one audio file, photo-*.jpg) into the inbox and
   * queue it.
   * @param {string} folder
   * @param {{title?: string|null, reviews: string[], publish: boolean}} options
   */
  importFolder(folder, { title = null, reviews, publish }) {
    const metaPath = path.join(folder, 'metadata.json');
    if (!fileStat(metaPath)) throw fileNotFound(`no metadata.json in ${folder}`);
    const metadata = readJson(metaPath);
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new ValueError('metadata.json is not an object');
    }
    const own = (key) => (Object.hasOwn(metadata, key) ? metadata[key] : null);
    const recordingId = pyStrip(pyTruthy(own('id')) ? pyStr(own('id')) : '');
    if (!recordingId) throw new ValueError('metadata.json missing id');
    checkRecordingId(recordingId);
    let chosenTitle = pyStrip(title || (pyTruthy(own('title')) ? pyStr(own('title')) : ''));
    if (!chosenTitle) chosenTitle = 'recording';
    const chosenReviews = canonicalReviews(reviews);
    let createdAtMs = pyInt(pyTruthy(own('createdAt')) ? own('createdAt') : 0);
    if (createdAtMs <= 0) createdAtMs = Date.now();

    const names = fs.readdirSync(folder);
    const audioFiles = names.filter((name) => AUDIO_NAMES.includes(name) && fileStat(path.join(folder, name)));
    if (audioFiles.length !== 1) throw new ValueError('import folder must contain exactly one audio.m4a or audio.wav');
    const photos = sortedPaths(names.filter((name) => PHOTO_RE.test(name) && fileStat(path.join(folder, name))));
    const specs = [audioFiles[0], ...photos].map((name) => {
      const file = path.join(folder, name);
      return { name, size: fs.statSync(file).size, sha256: sha256File(file) };
    });

    const inbox = this.inboxDir(recordingId);
    if (!samePath(folder, inbox)) {
      for (const spec of specs) copyFile2(path.join(folder, spec.name), path.join(inbox, spec.name));
      copyFile2(metaPath, path.join(inbox, 'metadata.json'));
    }

    const rec = this.createJob(
      {
        recordingId,
        createdAtMs,
        title: codePoints(chosenTitle).slice(0, 120).join(''),
        reviews: chosenReviews,
        publish,
        files: specs,
      },
      metadata,
    );
    return this.commit(rec.jobId);
  }

  /**
   * Queue a job for a recording already sitting in inbox/ (USB pull or folder drop).
   * transcribe = transcript only; review = the default AI reviews; publish = those plus publish.
   * @param {string} recordingId
   * @param {{action: string, title?: string|null}} options
   */
  processInbox(recordingId, { action, title = null }) {
    if (!PROCESS_ACTIONS.includes(action)) throw new ValueError(`invalid action: ${action}`);
    return this.importFolder(this.inboxDir(recordingId), {
      title,
      reviews: action === 'transcribe' ? [] : this.config.default_reviews,
      publish: action === 'publish',
    });
  }

  /**
   * Queue a job that writes (or rewrites) one AI review from the existing transcript.
   * ASR is skipped; the job publishes when the recording's latest job did.
   */
  addReview(recordingId, kind) {
    checkRecordingId(recordingId);
    const reviews = canonicalReviews([kind]);
    const latest = this.latestFor(recordingId);
    if (latest === null) throw new StoreError(`unknown recording ${recordingId}`);
    if (this.activeJobFor(recordingId) !== null) {
      throw new StoreError('a job is still running for this recording; wait for it to finish');
    }
    if (!fileStat(path.join(this.outboxDir(recordingId), 'transcript.txt'))) {
      throw new StoreError('no transcript yet; transcribe the recording first');
    }
    const writer = this.config.default_writer !== 'none' ? this.config.default_writer : latest.writer;
    if (writer === 'none') throw new StoreError('no writer: choose a default writer in Settings');
    const now = this._now();
    const jobId = crypto.randomUUID();
    this._run(
      `${INSERT_JOB}VALUES (?, ?, 'queued', NULL, ?, ?, ?, ?, ?, 1, 0, ?, ?, NULL, ?, ?)`,
      jobId,
      recordingId,
      latest.title,
      reviews.join(','),
      latest.publish ? 1 : 0,
      writer,
      latest.publishFolder,
      latest.createdAt,
      now,
      latest.asr !== null ? jsonDumps(latest.asr) : null,
      jsonDumps(defaultTimings()),
    );
    const rec = this.job(jobId);
    this._writeResultJson(rec);
    return rec;
  }

  // --- devices (USB ledger) ----------------------------------------------------

  upsertDeviceSeen(serial, model) {
    this._run(
      'INSERT INTO devices (serial, model, adopted_at, last_seen_at, last_sync_at, last_error) ' +
        'VALUES (?, ?, NULL, ?, NULL, NULL) ' +
        "ON CONFLICT(serial) DO UPDATE SET model = CASE WHEN excluded.model != '' " +
        'THEN excluded.model ELSE devices.model END, last_seen_at = excluded.last_seen_at',
      serial,
      model,
      this._now(),
    );
  }

  adoptDevice(serial) {
    this._run(
      'INSERT INTO devices (serial, model, adopted_at, last_seen_at, last_sync_at, last_error) ' +
        "VALUES (?, '', ?, NULL, NULL, NULL) " +
        'ON CONFLICT(serial) DO UPDATE SET adopted_at = excluded.adopted_at',
      serial,
      this._now(),
    );
  }

  forgetDevice(serial) {
    this._run('UPDATE devices SET adopted_at = NULL, last_error = NULL WHERE serial = ?', serial);
  }

  deviceSynced(serial, error) {
    this._run('UPDATE devices SET last_sync_at = ?, last_error = ? WHERE serial = ?', this._now(), error, serial);
  }

  devices() {
    return this._all('SELECT * FROM devices ORDER BY adopted_at IS NULL, last_seen_at DESC').map((row) => ({
      serial: str(row.serial),
      model: String(row.model || ''),
      adopted: Boolean(row.adopted_at),
      adoptedAt: row.adopted_at ? String(row.adopted_at) : null,
      lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : null,
      lastSyncAt: row.last_sync_at ? String(row.last_sync_at) : null,
      lastError: row.last_error ? String(row.last_error) : null,
    }));
  }

  /** @returns {Set<string>} */
  adoptedSerials() {
    return new Set(this._all('SELECT serial FROM devices WHERE adopted_at IS NOT NULL').map((row) => str(row.serial)));
  }

  /**
   * @param {string} serial
   * @param {string} recordingId
   * @param {{deviceStatus: string, title: string, createdAtMs: number}} fields
   */
  markDeviceRecording(serial, recordingId, { deviceStatus, title, createdAtMs }) {
    this._run(
      'INSERT INTO device_recordings (serial, recording_id, device_status, title, ' +
        'created_at_ms, first_seen_at, pulled_at, auto_job_id, changed_since_job, flag) ' +
        'VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL) ' +
        'ON CONFLICT(serial, recording_id) DO UPDATE SET device_status = excluded.device_status, ' +
        'title = excluded.title, created_at_ms = excluded.created_at_ms',
      serial,
      recordingId,
      deviceStatus,
      title,
      createdAtMs,
      this._now(),
    );
  }

  flagDeviceRecording(serial, recordingId, flag) {
    this._run('UPDATE device_recordings SET flag = ? WHERE serial = ? AND recording_id = ?', flag, serial, recordingId);
  }

  deviceRecordingPulled(serial, recordingId) {
    this._run(
      'UPDATE device_recordings SET pulled_at = ? WHERE serial = ? AND recording_id = ?',
      this._now(),
      serial,
      recordingId,
    );
  }

  setAutoJob(serial, recordingId, jobId) {
    this._run(
      'UPDATE device_recordings SET auto_job_id = ?, changed_since_job = 0 WHERE serial = ? AND recording_id = ?',
      jobId,
      serial,
      recordingId,
    );
  }

  flagChangedSinceJob(serial, recordingId) {
    this._run(
      'UPDATE device_recordings SET changed_since_job = 1 WHERE serial = ? AND recording_id = ?',
      serial,
      recordingId,
    );
  }

  /** @returns {Object<string, [number, number]>} file name -> [size, mtime] as last seen on the device */
  deviceFileState(serial, recordingId) {
    const rows = this._all(
      'SELECT name, size, mtime FROM device_files WHERE serial = ? AND recording_id = ?',
      serial,
      recordingId,
    );
    return Object.fromEntries(rows.map((row) => [str(row.name), [Number(row.size), Number(row.mtime)]]));
  }

  recordPulledFile(serial, recordingId, name, size, mtime, sha256) {
    this._run(
      'INSERT INTO device_files (serial, recording_id, name, size, mtime, sha256, pulled_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(serial, recording_id, name) DO UPDATE SET size = excluded.size, ' +
        'mtime = excluded.mtime, sha256 = excluded.sha256, pulled_at = excluded.pulled_at',
      serial,
      recordingId,
      name,
      size,
      mtime,
      sha256,
      this._now(),
    );
  }

  deviceRecordings(serial) {
    const rows = this._all(
      'SELECT r.*, ' +
        '(SELECT COUNT(*) FROM device_files f WHERE f.serial = r.serial AND f.recording_id = r.recording_id) AS file_count, ' +
        '(SELECT COALESCE(SUM(size), 0) FROM device_files f WHERE f.serial = r.serial AND f.recording_id = r.recording_id) AS bytes ' +
        'FROM device_recordings r WHERE r.serial = ? ORDER BY r.created_at_ms DESC',
      serial,
    );
    return rows.map((row) => ({
      serial: str(row.serial),
      recordingId: str(row.recording_id),
      deviceStatus: String(row.device_status || ''),
      title: String(row.title || ''),
      createdAtMs: Number(row.created_at_ms || 0),
      firstSeenAt: str(row.first_seen_at),
      pulledAt: row.pulled_at ? String(row.pulled_at) : null,
      autoJobId: row.auto_job_id ? String(row.auto_job_id) : null,
      changedSinceJob: Boolean(Number(row.changed_since_job || 0)),
      flag: row.flag ? String(row.flag) : null,
      fileCount: Number(row.file_count),
      bytes: Number(row.bytes),
      latestJob: this.latestFor(str(row.recording_id)),
    }));
  }

  // --- internals ---------------------------------------------------------------

  _statement(sql) {
    let statement = this._statements.get(sql);
    if (!statement) {
      statement = this._db.prepare(sql);
      this._statements.set(sql, statement);
    }
    return statement;
  }

  _get(sql, ...params) {
    return this._statement(sql).get(...params.map(bindable));
  }

  _all(sql, ...params) {
    return this._statement(sql).all(...params.map(bindable));
  }

  _run(sql, ...params) {
    return this._statement(sql).run(...params.map(bindable));
  }

  _transaction(fn) {
    this._db.exec('BEGIN');
    try {
      const result = fn();
      this._db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this._db.isTransaction) this._db.exec('ROLLBACK');
      throw error;
    }
  }

  _beginAppend(jobId, name, offset) {
    const rec = this.job(jobId);
    if (rec === null) throw new UnknownJob(jobId);
    if (rec.status !== 'uploading') throw new JobNotUploading(jobId, rec.status);
    const row = this._get('SELECT size, sha256, received FROM job_files WHERE job_id = ? AND name = ?', jobId, name);
    if (!row) throw new UnknownJob(`${jobId}/${name}`);
    const current = this.fileReceived(jobId, name);
    if (current === null) throw new UnknownJob(`${jobId}/${name}`);
    if (offset !== current) throw new OffsetMismatch(current);
    const size = Number(row.size);
    if (current === size) return { path: null, size, done: true };
    return { path: path.join(this.inboxDir(rec.recordingId), '.upload', `${name}.partial`), size, done: false };
  }

  _finishAppend(jobId, name, received) {
    this._run('UPDATE job_files SET received = ? WHERE job_id = ? AND name = ?', received, jobId, name);
  }

  _filesFor(jobId) {
    return this._all('SELECT name, size, sha256 FROM job_files WHERE job_id = ? ORDER BY name', jobId).map((row) => ({
      name: str(row.name),
      size: Number(row.size),
      sha256: str(row.sha256),
    }));
  }

  _occupiedFolders() {
    return this._all('SELECT publish_folder, recording_id FROM jobs WHERE publish_folder IS NOT NULL').map((row) => [
      str(row.publish_folder),
      str(row.recording_id),
    ]);
  }

  _checkAudioMismatch(inbox, job) {
    const incoming = new Map(job.files.filter((spec) => AUDIO_NAMES.includes(spec.name)).map((spec) => [spec.name, spec]));
    for (const audioName of AUDIO_NAMES) {
      const existing = path.join(inbox, audioName);
      if (!fileStat(existing)) continue;
      const existingHash = sha256File(existing);
      const spec = incoming.get(audioName);
      if (spec === undefined) {
        // A different audio filename for the same recording still counts.
        const other = incoming.values().next().value;
        if (other !== undefined && other.sha256.toLowerCase() !== existingHash) throw new AudioMismatch(job.recordingId);
        continue;
      }
      if (spec.sha256.toLowerCase() !== existingHash) throw new AudioMismatch(job.recordingId);
    }
  }

  _validateRequest(job) {
    const title = pyStrip(job.title);
    if (!title || codePoints(title).length > 120) throw new ValueError('title must be 1–120 characters');
    canonicalReviews(job.reviews);
    checkRecordingId(job.recordingId);
    if (!job.files || job.files.length === 0) throw new ValueError('files manifest is empty');
    let audioCount = 0;
    const seen = new Set();
    for (const spec of job.files) {
      if (seen.has(spec.name)) throw new ValueError(`duplicate file name: ${spec.name}`);
      seen.add(spec.name);
      if (!FILE_NAME_RE.test(spec.name)) throw new ValueError(`invalid file name: ${spec.name}`);
      if (AUDIO_NAMES.includes(spec.name)) audioCount += 1;
      else if (!PHOTO_RE.test(spec.name)) throw new ValueError(`file name not allowed: ${spec.name}`);
      if (spec.size < 0) throw new ValueError(`invalid size for ${spec.name}`);
      if (!SHA256_RE.test(spec.sha256)) throw new ValueError(`invalid sha256 for ${spec.name}`);
    }
    if (audioCount !== 1) throw new ValueError('manifest must contain exactly one audio.m4a or audio.wav');
  }

  /**
   * The folder delete_recording may remove for a recorded publish folder, or null when it is not
   * strictly inside webdav_folder. Links are followed where the filesystem allows it (Path.resolve());
   * where realpath fails (the rclone WebDAV mount, a folder that is gone) the lexical
   * naming.inPublishRoot decides.
   */
  _publishedTarget(folder) {
    let root;
    let real;
    try {
      root = fs.realpathSync.native(this.config.webdav_folder);
      real = fs.realpathSync.native(folder);
    } catch (_error) {
      return naming.inPublishRoot(this.config, folder) ? path.resolve(folder) : null;
    }
    return strictlyInside(root, real) ? real : null;
  }

  _predictedUrl(folder, reviews) {
    if (!folder) return null;
    const page = reviews.includes('summary') ? 'summary.html' : 'transcript.html';
    return naming.webdavUrl(this.config, folder, page);
  }

  _writeResultJson(rec) {
    // A row from an older server whose id this server refuses has no outbox folder to write to;
    // its status still changes in the index.
    if (!isValidRecordingId(rec.recordingId)) return;
    const data = this.resultJson(rec.jobId);
    writeText(path.join(this.outboxDir(rec.recordingId), 'result.json'), jsonDumps(data, 2));
  }

  _jobFromRow(row) {
    const asr = row.asr_json ? JSON.parse(row.asr_json) : null;
    const timings = row.timings_json ? JSON.parse(row.timings_json) : defaultTimings();
    const createdAt = str(row.created_at);
    let createdAtMs = 0;
    try {
      createdAtMs = isoToMs(createdAt);
    } catch (_error) {
      createdAtMs = 0;
    }
    const reviews = splitReviews(row.reviews);
    const folder = row.publish_folder ? String(row.publish_folder) : null;
    return {
      jobId: str(row.job_id),
      recordingId: str(row.recording_id),
      status: str(row.status),
      error: row.error ? String(row.error) : null,
      title: str(row.title),
      reviews,
      publish: Boolean(Number(row.publish)),
      writer: str(row.writer),
      // Predicted URL for older clients: summary.html when a summary is requested, else transcript.html.
      webdavUrl: this._predictedUrl(folder, reviews),
      publishFolder: folder,
      skipAsr: Boolean(Number(row.skip_asr)),
      onlyPublish: Boolean(Number(row.only_publish)),
      createdAt,
      updatedAt: str(row.updated_at),
      finishedAt: row.finished_at ? String(row.finished_at) : null,
      asr,
      timings: Object.fromEntries(Object.entries(timings).map(([key, value]) => [key, Math.trunc(Number(value))])),
      createdAtMs,
      files: this._filesFor(str(row.job_id)),
    };
  }
}

module.exports = {
  SCHEMA_VERSION,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  RETRY_WRITER_STATUSES,
  AUDIO_NAMES,
  FILE_NAME_RE,
  PHOTO_RE,
  SHA256_RE,
  WRITERS,
  PROCESS_ACTIONS,
  StoreError,
  JobActive,
  AudioMismatch,
  OffsetMismatch,
  TooLarge,
  Incomplete,
  HashMismatch,
  JobNotUploading,
  RetryNotAllowed,
  UnknownJob,
  JobStore,
  utcnowIso,
  msToIso,
  hashToken,
  sha256File,
  jsonDumps,
};
