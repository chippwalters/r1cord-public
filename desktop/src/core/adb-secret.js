// Secrets to an R1 over adb without putting them on any command line. A Tailscale auth key or a
// device token is written to the stdin of `adb -s <serial> shell -T` as part of a tiny script
// (a here-document for `content write`, one `input text` line for the auth-key field), so neither
// Windows' process list nor the device's `content` argv carries a token. No PTY is allocated, so
// the device never echoes the script back. Logging names only the command; the Buffers holding
// the secret are zeroed before the call returns. Also the SetupProvider `content call` wrapper and
// its `Result: Bundle[{ok=…, json=…}]` parser. Every process is started from an args array with
// shell:false through the injectable `run` (tests pass a fake and never spawn adb).

'use strict';

const os = require('node:os');
const path = require('node:path');
const { killTree, spawn } = require('./cli');

const SETUP_AUTHORITY = 'com.chippwalters.r1cord.setup';
const SETUP_URI = `content://${SETUP_AUTHORITY}`;
const AUTH_KEY_RE = /^tskey-[A-Za-z0-9-]{10,200}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
// adb serials: USB serial numbers and host:port for TCP; nothing a shell would interpret.
const SERIAL_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const CALL_METHODS = new Set(['STATUS', 'BEGIN_MAINTENANCE', 'END_MAINTENANCE', 'PROVISION', 'PROBE', 'NONCE']);
const EXTRA_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const EXTRA_TYPES = new Set(['s', 'i', 'l', 'f', 'd', 'b']);
// Printable text only: no control characters (newlines would end the shell line).
const PLAIN_TEXT_RE = /^[^\u0000-\u001f\u007f]{0,512}$/;
const HEREDOC_MARK = 'R1CORD_EOF_7f3c';
const SECRET_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 4 * 1024 * 1024;

class AdbSecretError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AdbSecretError';
  }
}

class ContentCallError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContentCallError';
  }
}

/**
 * Run `argv` to completion without a shell, optionally feeding `input` to its stdin; the tree is
 * killed on timeout. Never rejects for a non-zero exit: the caller reads `code`.
 * @param {string[]} argv
 * @param {{timeoutMs?: number, input?: Buffer|null, env?: object}} [options]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
function runProcess(argv, { timeoutMs = 60_000, input = null, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(argv, { cwd: os.tmpdir(), env, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    const out = [];
    const err = [];
    let size = 0;
    let settled = false;
    const name = path.basename(String(argv[0]));
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish(reject, new Error(`${name} did not finish within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    const collect = (sink) => (chunk) => {
      size += chunk.length;
      if (size <= MAX_OUTPUT) sink.push(chunk);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    child.on('error', (error) => finish(reject, new Error(`${name}: ${error.message}`)));
    child.on('close', (code) =>
      finish(resolve, { code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }),
    );
    if (input) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

/** POSIX single-quote `value` for the device's /system/bin/sh. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function checkSerial(serial) {
  if (!SERIAL_RE.test(String(serial))) throw new AdbSecretError('invalid adb serial');
  return String(serial);
}

/** The key as a Buffer, or AdbSecretError. Never echoes the value. */
function authKeyBuffer(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
  if (!AUTH_KEY_RE.test(text)) throw new AdbSecretError('not a Tailscale auth key (expected tskey-… letters, digits and dashes)');
  return Buffer.from(text, 'utf8');
}

function tokenBuffer(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
  if (!TOKEN_RE.test(text)) throw new AdbSecretError('not a device token (expected 64 lowercase hex characters)');
  return Buffer.from(text, 'utf8');
}

function isValidAuthKey(value) {
  return AUTH_KEY_RE.test(String(value ?? ''));
}

/**
 * Feed `script` to `adb -s <serial> shell -T`, then zero it. Output is returned only as the exit
 * code and a redacted error, never the script.
 */
async function runSecretScript(adb, serial, script, label, { run = runProcess, log = () => {} } = {}) {
  log(`adb-secret: ${label}`);
  try {
    const result = await run([adb, '-s', checkSerial(serial), 'shell', '-T'], { timeoutMs: SECRET_TIMEOUT_MS, input: script });
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.code !== 0 || /Exception|Error|denied|not found/i.test(output)) {
      // The device's own error text may quote nothing secret (the script is not echoed without a
      // PTY), but keep it short and strip anything key- or token-shaped just in case.
      const detail = redact(output.trim()).slice(0, 300);
      throw new AdbSecretError(`${label} failed (exit ${result.code})${detail ? `: ${detail}` : ''}`);
    }
  } finally {
    script.fill(0);
  }
}

/** Replace anything shaped like an auth key or a token. */
function redact(text) {
  return String(text)
    .replace(/tskey-[A-Za-z0-9-]+/g, 'tskey-[redacted]')
    .replace(/\b[0-9a-f]{64}\b/g, '[redacted]');
}

/**
 * `content write --uri content://com.chippwalters.r1cord.setup/token/<nonce>` with the token on
 * the provider's stdin through a quoted here-document.
 */
async function stageToken(adb, serial, nonce, token, options = {}) {
  if (!NONCE_RE.test(String(nonce))) throw new AdbSecretError('invalid setup nonce');
  const secret = tokenBuffer(token);
  const uri = `${SETUP_URI}/token/${nonce}`;
  const script = Buffer.concat([
    Buffer.from(`content write --uri ${shellQuote(uri)} <<'${HEREDOC_MARK}'\n`, 'utf8'),
    secret,
    Buffer.from(`\n${HEREDOC_MARK}\nexit\n`, 'utf8'),
  ]);
  secret.fill(0);
  await runSecretScript(adb, serial, script, 'content write', options);
}

/** `input text '<key>'` into the focused field. The key alphabet needs no escaping beyond quotes. */
async function typeAuthKey(adb, serial, key, options = {}) {
  const secret = authKeyBuffer(key);
  const script = Buffer.concat([Buffer.from("input text '", 'utf8'), secret, Buffer.from("'\nexit\n", 'utf8')]);
  secret.fill(0);
  await runSecretScript(adb, serial, script, 'input text', options);
}

// --- content call ----------------------------------------------------------------------------------

/** The JSON object starting at `text[start]` ('{'), matched with string-aware brace counting. */
function balancedObject(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse `content call` output: `Result: Bundle[{ok=true, json={"v":1,…}}]` (keys in any order).
 * @returns {{ok: boolean, json: object}}
 */
function parseCallResult(text) {
  const output = String(text || '');
  // `content` prints its usage text (instead of calling the provider) when it rejects the argv.
  if (/^usage:/i.test(output.trim())) throw new ContentCallError("the R1's content command rejected the arguments");
  const at = output.indexOf('Result:');
  if (at === -1) throw new ContentCallError(`no result from the R1CORD setup provider: ${redact(output.trim()).slice(0, 300) || 'empty output'}`);
  const rest = output.slice(at);
  if (/^Result:\s*null/.test(rest)) throw new ContentCallError('the R1CORD setup provider returned nothing');
  const ok = /[{,\s]ok=(true|false)\b/.exec(rest);
  const jsonAt = rest.search(/[{,\s]json=\{/);
  if (!ok || jsonAt === -1) throw new ContentCallError(`unexpected setup provider result: ${redact(rest.trim()).slice(0, 300)}`);
  const body = balancedObject(rest, rest.indexOf('{', jsonAt + 1));
  let json;
  try {
    json = JSON.parse(body);
  } catch (_error) {
    throw new ContentCallError('the setup provider returned unreadable JSON');
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new ContentCallError('the setup provider returned a non-object');
  return { ok: ok[1] === 'true', json };
}

/**
 * `content` splits `--extra <KEY>:<TYPE>:<VAL>` on every unescaped `:`; escape `\` then `:` in the value.
 * @param {string|number} value
 */
function escapeExtraValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}

/**
 * `adb -s <serial> shell content call --uri content://com.chippwalters.r1cord.setup --method <m>
 * [--arg <a>] [--extra key:type:value …]`, every word quoted for the device shell.
 * @param {string} adb
 * @param {string} serial
 * @param {string} method
 * @param {string|null} [arg]
 * @param {Array<[string, string, string|number]>} [extras] [key, type, value]
 * @returns {Promise<{ok: boolean, json: object}>}
 */
async function runContentCall(adb, serial, method, arg = null, extras = [], { run = runProcess, log = () => {} } = {}) {
  if (!CALL_METHODS.has(method)) throw new ContentCallError(`unknown setup method ${method}`);
  const words = ['content', 'call', '--uri', SETUP_URI, '--method', method];
  if (arg !== null && arg !== undefined) {
    if (!PLAIN_TEXT_RE.test(String(arg))) throw new ContentCallError(`invalid argument for ${method}`);
    words.push('--arg', String(arg));
  }
  for (const [key, type, value] of extras) {
    if (!EXTRA_KEY_RE.test(key) || !EXTRA_TYPES.has(type) || !PLAIN_TEXT_RE.test(String(value))) {
      throw new ContentCallError(`invalid extra for ${method}`);
    }
    words.push('--extra', `${key}:${type}:${escapeExtraValue(value)}`);
  }
  log(`adb: content call ${method}`);
  const result = await run([adb, '-s', checkSerial(serial), 'shell', words.map(shellQuote).join(' ')], { timeoutMs: CALL_TIMEOUT_MS });
  return parseCallResult(`${result.stdout}\n${result.stderr}`);
}

module.exports = {
  AUTH_KEY_RE,
  AdbSecretError,
  ContentCallError,
  NONCE_RE,
  SERIAL_RE,
  SETUP_URI,
  TOKEN_RE,
  isValidAuthKey,
  parseCallResult,
  redact,
  runContentCall,
  runProcess,
  shellQuote,
  stageToken,
  typeAuthKey,
};
