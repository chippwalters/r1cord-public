// Port of r1cord_server/mailer.py: email a finished job's AI review through the Google Workspace CLI
// (`gws`), signed in on this PC. The message is built the way Python's EmailMessage builds it
// (multipart/alternative text + HTML, the same transfer-encoding choices) and sent raw, base64url.

const crypto = require('node:crypto');
const path = require('node:path');
const cli = require('./cli');
const { PAGE_LABELS } = require('./config');
const { pathString } = require('./paths');
const { renderFragment } = require('./render');
const { stripBrandHeader } = require('./render/markdown');
const { PY_SPACE, isFile, pyStrip, readText } = require('./pipeline/compat');

// CreateProcess caps a command line at 32,767 characters; the message travels base64-encoded in
// `--json`, so keep it well inside that.
const MAX_RAW_CHARS = 28_000;
const SEND_TIMEOUT_S = 90;
// The review an email carries, best first; the transcript when there is none.
const EMAIL_ORDER = ['summary', 'organized', 'outline'];
const MAX_LINE = 78;
const PY_RSTRIP_RE = new RegExp(`[${PY_SPACE}]+$`);

// The email could not be composed or `gws` refused to send it.
class MailError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MailError';
  }
}

/**
 * Resolve `gws` to its native binary.
 *
 * The npm shim (`gws.cmd`) runs through cmd.exe, which caps a command line at 8,191 characters and
 * re-parses quotes; the binary it wraps takes the full 32,767 and the arguments verbatim.
 * @param {string} cmd
 * @returns {string|null}
 */
function gwsExecutable(cmd) {
  const found = isFile(cmd) ? pathString(String(cmd)) : cli.which(cmd);
  if (!found) return null;
  if (['.cmd', '.bat', '.ps1'].includes(path.extname(found).toLowerCase())) {
    const native = path.join(path.dirname(found), 'node_modules', '@googleworkspace', 'cli', 'node_modules', '.bin_real', 'gws.exe');
    if (isFile(native)) return native;
  }
  return found;
}

// --- MIME, as email.message.EmailMessage + policy.SMTP write it --------------------------------

const QP_BODY_SAFE = new Set(
  Array.from(' !"#$%&\'()*+,-./0123456789:;<>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\t\r\n', (ch) => ch.charCodeAt(0)),
);

function quoteByte(code) {
  return `=${code.toString(16).toUpperCase().padStart(2, '0')}`;
}

// email.quoprimime.body_encode(body, maxlinelen) over a latin-1 string (one char per byte).
function qpBodyEncode(body, maxLineLen) {
  if (!body) return body;
  let encoded = '';
  for (let i = 0; i < body.length; i += 1) {
    const code = body.charCodeAt(i);
    encoded += QP_BODY_SAFE.has(code) ? body[i] : quoteByte(code);
  }
  const softBreak = '=\n';
  const maxLineLen1 = maxLineLen - 1;
  const out = [];
  const lines = encoded.split(/\r\n|\r|\n/);
  if (/[\r\n]$/.test(encoded)) lines.pop();
  for (const line of lines) {
    let start = 0;
    const lastStart = line.length - 1 - maxLineLen;
    while (start <= lastStart) {
      const stop = start + maxLineLen1;
      if (line[stop - 2] === '=') {
        out.push(line.slice(start, stop - 1));
        start = stop - 2;
      } else if (line[stop - 1] === '=') {
        out.push(line.slice(start, stop));
        start = stop - 1;
      } else {
        out.push(`${line.slice(start, stop)}=`);
        start = stop;
      }
    }
    const last = line[line.length - 1];
    if (line && (last === ' ' || last === '\t')) {
      const room = start - lastStart;
      let q;
      if (room >= 3) q = quoteByte(last.charCodeAt(0));
      else if (room === 2) q = last + softBreak;
      else q = softBreak + quoteByte(last.charCodeAt(0));
      out.push(line.slice(start, -1) + q);
    } else {
      out.push(line.slice(start));
    }
  }
  if (/[\r\n]$/.test(body)) out.push('');
  return out.join('\n');
}

// bytes.splitlines(): \r\n, \r and \n.
function byteLines(buffer) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0x0a || buffer[i] === 0x0d) {
      lines.push(buffer.subarray(start, i));
      if (buffer[i] === 0x0d && buffer[i + 1] === 0x0a) i += 1;
      start = i + 1;
    }
  }
  if (start < buffer.length) lines.push(buffer.subarray(start));
  return lines;
}

function joinLines(lines) {
  const parts = [];
  for (const line of lines) parts.push(line, Buffer.from('\n'));
  return Buffer.concat(parts);
}

function isAscii(buffer) {
  return buffer.every((byte) => byte < 0x80);
}

// email.contentmanager._encode_text with the default policy: [cte, payload with '\n' line ends].
function encodeText(text) {
  const lines = byteLines(Buffer.from(text, 'utf8'));
  const body = joinLines(lines);
  if (lines.reduce((max, line) => Math.max(max, line.length), 0) <= MAX_LINE) {
    return isAscii(body) ? ['7bit', body] : ['8bit', body];
  }
  const sniff = joinLines(lines.slice(0, 10));
  const sniffQp = qpBodyEncode(sniff.toString('latin1'), MAX_LINE);
  const sniffBase64 = `${sniff.toString('base64')}\n`;
  if (sniffQp.length <= sniffBase64.length) {
    if (lines.length <= 10) return ['quoted-printable', Buffer.from(sniffQp, 'latin1')];
    return ['quoted-printable', Buffer.from(qpBodyEncode(body.toString('latin1'), MAX_LINE), 'latin1')];
  }
  const perLine = Math.floor(MAX_LINE / 4) * 3;
  let encoded = '';
  for (let i = 0; i < body.length; i += perLine) encoded += `${body.subarray(i, i + perLine).toString('base64')}\n`;
  return ['base64', Buffer.from(encoded, 'ascii')];
}

// RFC 2047 encoded words for `text`, each at most 75 characters: the shorter of b and q.
function encodedWords(text) {
  const qEncode = (value) => {
    let out = '';
    for (const byte of Buffer.from(value, 'utf8')) {
      const ch = String.fromCharCode(byte);
      if (/[A-Za-z0-9!*+\-/]/.test(ch)) out += ch;
      else if (ch === ' ') out += '_';
      else out += quoteByte(byte);
    }
    return out;
  };
  const bEncode = (value) => Buffer.from(value, 'utf8').toString('base64');
  const useB = bEncode(text).length < qEncode(text).length;
  const encode = useB ? bEncode : qEncode;
  const wrap = (value) => `=?utf-8?${useB ? 'b' : 'q'}?${encode(value)}?=`;
  const words = [];
  let chunk = '';
  for (const ch of Array.from(text)) {
    if (chunk && wrap(chunk + ch).length > 75) {
      words.push(wrap(chunk));
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(wrap(chunk));
  return words;
}

const NON_ASCII = /[^\x00-\x7f]/;

// An unstructured header value: ASCII words stay as they are, runs of non-ASCII words become
// encoded words.
function encodeUnstructured(value) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length) out.push(...encodedWords(run.join(' ')));
    run = [];
  };
  for (const word of String(value).split(' ')) {
    if (NON_ASCII.test(word)) run.push(word);
    else {
      flush();
      out.push(word);
    }
  }
  flush();
  return out.join(' ');
}

// An address header: a non-ASCII local part or domain becomes an encoded word, as Python writes it.
function encodeAddresses(value) {
  return String(value)
    .split(',')
    .map((address) => {
      const trimmed = address.trim();
      if (!NON_ASCII.test(trimmed)) return trimmed;
      const at = trimmed.lastIndexOf('@');
      if (at < 0) return encodedWords(trimmed).join(' ');
      const encode = (part) => (NON_ASCII.test(part) ? encodedWords(part).join(' ') : part);
      return `${encode(trimmed.slice(0, at))}@${encode(trimmed.slice(at + 1))}`;
    })
    .join(', ');
}

// `Name: value`, folded at spaces so a line stays within 78 characters where it can.
function header(name, value) {
  const words = value.split(' ');
  const lines = [];
  let line = `${name}:`;
  for (const word of words) {
    if (line.length + 1 + word.length > MAX_LINE && line.trim() !== `${name}:`) {
      lines.push(line);
      line = ` ${word}`;
    } else {
      line += ` ${word}`;
    }
  }
  lines.push(line);
  return lines.join('\r\n');
}

function crlf(buffer) {
  return Buffer.from(buffer.toString('latin1').replace(/\n/g, '\r\n'), 'latin1');
}

function boundary() {
  const digits = (crypto.randomBytes(8).readBigUInt64BE() % 9223372036854775807n).toString().padStart(19, '0');
  return `${'='.repeat(15)}${digits}==`;
}

/**
 * A composed email: the logical parts (for callers and tests) and its wire bytes (policy.SMTP).
 */
class MailMessage {
  /**
   * @param {string} to
   * @param {string} subject
   * @param {Array<{type: string, text: string}>} parts text/plain first, then text/html if any
   */
  constructor(to, subject, parts) {
    this.to = to;
    this.subject = subject;
    this.parts = parts;
    this._bytes = null;
  }

  /** @returns {Buffer} the RFC 822 message as policy.SMTP serializes it */
  bytes() {
    if (this._bytes) return this._bytes;
    const chunks = [header('To', encodeAddresses(this.to)), header('Subject', encodeUnstructured(this.subject))];
    const partHead = (part, mimeVersion) => {
      const [cte, payload] = encodeText(part.text);
      const lines = [`Content-Type: ${part.type}; charset="utf-8"`, `Content-Transfer-Encoding: ${cte}`];
      if (mimeVersion) lines.push('MIME-Version: 1.0');
      return [lines.join('\r\n'), crlf(payload)];
    };
    const buffers = [];
    if (this.parts.length === 1) {
      const [head, payload] = partHead(this.parts[0], true);
      buffers.push(Buffer.from(`${chunks.join('\r\n')}\r\n${head}\r\n\r\n`, 'utf8'), payload);
    } else {
      const mark = boundary();
      buffers.push(
        Buffer.from(
          `${chunks.join('\r\n')}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative;\r\n boundary="${mark}"\r\n\r\n`,
          'utf8',
        ),
      );
      this.parts.forEach((part, index) => {
        const [head, payload] = partHead(part, index > 0);
        buffers.push(Buffer.from(`${index > 0 ? '\r\n' : ''}--${mark}\r\n${head}\r\n\r\n`, 'ascii'), payload);
      });
      buffers.push(Buffer.from(`\r\n--${mark}--\r\n`, 'ascii'));
    }
    this._bytes = Buffer.concat(buffers);
    return this._bytes;
  }
}

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function message(to, title, bodyMd, links, { html }) {
  const textLinks = links.map(([label, url]) => `${label}: ${url}`).join('\n');
  const parts = [{ type: 'text/plain', text: `${bodyMd}\n\n${textLinks}\n` }];
  if (html) {
    // The pages' Markdown rules: raw HTML shows as text, links only to http(s), mailto and
    // anchors, photos become their captions (they only resolve on the published page).
    const rendered = renderFragment(bodyMd);
    const linkHtml = links.map(([label, url]) => `<p><a href="${htmlEscape(url)}">${htmlEscape(label)}</a></p>`).join('');
    parts.push({
      type: 'text/html',
      text:
        '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.5;' +
        `max-width:680px">${rendered}<hr>${linkHtml}</div>`,
    });
  }
  return new MailMessage(to, title, parts);
}

/**
 * The message as `gws` takes it: base64url of the SMTP bytes.
 * @param {MailMessage} msg
 * @returns {string}
 */
function raw(msg) {
  return msg.bytes().toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Subject = title; body = the review (or the transcript when there is none) + a link to every
 * published page (`[{kind, url}]`, page order) and to the job. Shrinks to fit the command line:
 * HTML dropped first, then the text truncated with a pointer to the page.
 * @param {{to: string, title: string, reviewMd: string|null, transcript: string|null,
 *   pages: Array<{kind: string, url: string}>, jobUrl: string}} options
 * @returns {MailMessage}
 */
function compose({ to, title, reviewMd, transcript, pages, jobUrl }) {
  let bodyMd;
  if (reviewMd !== null && reviewMd !== undefined) bodyMd = pyStrip(stripBrandHeader(reviewMd));
  else if (transcript !== null && transcript !== undefined) bodyMd = pyStrip(transcript);
  else throw new MailError('nothing to email: no AI review or transcript yet');
  const links = pages.map((page) => [`${PAGE_LABELS[page.kind] || page.kind} page`, page.url]);
  links.push(['Job on the server PC', jobUrl]);

  let msg = message(to, title, bodyMd, links, { html: true });
  if (raw(msg).length <= MAX_RAW_CHARS) return msg;
  msg = message(to, title, bodyMd, links, { html: false });
  if (raw(msg).length <= MAX_RAW_CHARS) return msg;
  const note = '\n\n[Truncated to fit the email. The full text is at the link below.]';
  const chars = Array.from(bodyMd);
  let keep = chars.length;
  while (keep > 0) {
    keep = Math.trunc(keep * 0.8);
    msg = message(to, title, chars.slice(0, keep).join('').replace(PY_RSTRIP_RE, '') + note, links, { html: false });
    if (raw(msg).length <= MAX_RAW_CHARS) return msg;
  }
  throw new MailError('email is too large to send');
}

/**
 * subprocess.run(argv, capture_output=True, text=True, timeout=…) for `send`.
 * @param {string[]} argv
 * @param {{timeoutS: number}} options
 * @returns {Promise<{returncode: number, stdout: string, stderr: string}>} rejects with
 *   `{timedOut: true}` set on the error when the timeout killed it
 */
function runCapture(argv, { timeoutS }) {
  return new Promise((resolve, reject) => {
    const child = cli.spawn(argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      cli.killTree(child);
    }, timeoutS * 1000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(Object.assign(new Error(`timed out after ${timeoutS}s`), { timedOut: true }));
      else resolve({ returncode: code === null ? -1 : code, stdout, stderr });
    });
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Send through `gws gmail users messages send`; resolves to the Gmail message id.
 * @param {object} config
 * @param {MailMessage} msg
 * @param {{run?: typeof runCapture}} [options]
 * @returns {Promise<string>}
 */
async function send(config, msg, { run = runCapture } = {}) {
  const exe = gwsExecutable(config.gws_cmd);
  if (exe === null) throw new MailError(`gws not found: ${config.gws_cmd}`);
  const params = '{"userId": "me"}';
  const body = `{"raw": "${raw(msg)}"}`;
  let proc;
  try {
    proc = await run([exe, 'gmail', 'users', 'messages', 'send', '--params', params, '--json', body], { timeoutS: SEND_TIMEOUT_S });
  } catch (error) {
    if (error && error.timedOut) throw new MailError(`gws timed out after ${SEND_TIMEOUT_S}s`);
    throw error;
  }
  const out = proc.stdout || '';
  let reply = {};
  const start = out.indexOf('{');
  if (start >= 0) {
    try {
      reply = JSON.parse(out.slice(start));
    } catch (_error) {
      reply = {};
    }
  }
  if (!isPlainObject(reply)) reply = {};
  if (proc.returncode !== 0 || !Object.hasOwn(reply, 'id')) {
    const error = isPlainObject(reply.error) ? reply.error : {};
    const detail = error.message || pyStrip(proc.stderr || out).slice(-300) || `exit ${proc.returncode}`;
    throw new MailError(`gws: ${detail}`);
  }
  return String(reply.id);
}

/**
 * Email one recording's best review (summary, else organized, else outline, else the transcript) to
 * `config.email_to`, log it to the job, resolve to the Gmail id.
 * @param {import('./store').JobStore} store
 * @param {object} config
 * @param {string} jobId
 * @param {{run?: typeof runCapture}} [options]
 * @returns {Promise<string>}
 */
async function emailJob(store, config, jobId, { run = runCapture } = {}) {
  const to = pyStrip(config.email_to);
  if (!to) throw new MailError('no recipient: set email_to on the Config page');
  const rec = store.job(jobId);
  if (rec === null) throw new MailError(`unknown job ${jobId}`);
  const outbox = store.outboxDir(rec.recordingId);
  const kind = EMAIL_ORDER.find((candidate) => isFile(path.join(outbox, `${candidate}.md`)));
  const transcript = path.join(outbox, 'transcript.txt');
  const msg = compose({
    to,
    title: rec.title || rec.recordingId,
    reviewMd: kind ? readText(path.join(outbox, `${kind}.md`)) : null,
    transcript: isFile(transcript) ? readText(transcript) : null,
    pages: store.pages(rec),
    jobUrl: `http://127.0.0.1:${config.listen_port}/admin/jobs/${jobId}`,
  });
  const messageId = await send(config, msg, { run });
  store.appendLog(jobId, `email: sent to ${to} (${messageId})`);
  return messageId;
}

module.exports = {
  EMAIL_ORDER,
  MAX_RAW_CHARS,
  SEND_TIMEOUT_S,
  MailError,
  MailMessage,
  compose,
  emailJob,
  gwsExecutable,
  raw,
  send,
};
