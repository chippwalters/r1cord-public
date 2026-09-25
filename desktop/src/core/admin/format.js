// Formatting the admin pages share, ported from r1cord_server/admin.py and the Python/Jinja
// built-ins it leans on: urllib.parse.quote, f"{x:.1f}", round(x, 1), status labels, sizes,
// durations and local times.

'use strict';

const { pyRound } = require('../pipeline/compat');

const ALWAYS_SAFE = /^[A-Za-z0-9_.\-~]$/;
// What Starlette's RedirectResponse leaves unquoted in a Location it is given.
const REDIRECT_SAFE = ":/%#?=@[]!$&'()*+,;";
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const STATUS_VIEW = {
  complete: ['Done', 'ok'],
  error: ['Failed', 'bad'],
  queued: ['Queued', 'idle'],
  uploading: ['Uploading', 'work'],
  transcribing: ['Transcribing', 'work'],
  transcribed: ['Transcribed', 'work'],
  writing: ['Writing', 'work'],
  written: ['Written', 'work'],
  publishing: ['Publishing', 'work'],
  published: ['Published', 'work'],
};

/** urllib.parse.quote(value, safe): UTF-8 bytes, uppercase escapes. */
function pyQuote(value, safe = '/') {
  let out = '';
  for (const byte of Buffer.from(String(value), 'utf8')) {
    const ch = String.fromCharCode(byte);
    out += byte < 0x80 && (ALWAYS_SAFE.test(ch) || safe.includes(ch))
      ? ch
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** The Location header Starlette's RedirectResponse(url) sends. */
function redirectLocation(url) {
  return pyQuote(url, REDIRECT_SAFE);
}

// A finite double as mantissa * 2**exponent, exactly.
function decompose(value) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  if (exponent === 0) return [fraction, -1074];
  return [fraction | (1n << 52n), exponent - 1075];
}

/** f"{value:.{digits}f}": the exact binary value rounded half to even. */
function pyFixed(value, digits) {
  const number = Number(value);
  if (Number.isNaN(number)) return 'nan';
  if (!Number.isFinite(number)) return number > 0 ? 'inf' : '-inf';
  const negative = number < 0 || Object.is(number, -0);
  const [mantissa, exponent] = decompose(Math.abs(number));
  const scale = 10n ** BigInt(digits);
  let scaled;
  if (exponent >= 0) {
    scaled = (mantissa << BigInt(exponent)) * scale;
  } else {
    const numerator = mantissa * scale;
    const denominator = 1n << BigInt(-exponent);
    scaled = numerator / denominator;
    const twice = (numerator - scaled * denominator) * 2n;
    if (twice > denominator || (twice === denominator && (scaled & 1n) === 1n)) scaled += 1n;
  }
  let text = scaled.toString();
  if (digits > 0) {
    text = text.padStart(digits + 1, '0');
    text = `${text.slice(0, -digits)}.${text.slice(-digits)}`;
  }
  return (negative ? '-' : '') + text;
}

/** Jinja's `value | round(1)` printed: Python's round(value, 1), then its repr. */
function roundOne(value) {
  return pyFixed(value, 1);
}

/** admin._human_size: "0 B", "2.0 KB", ... up to TB. */
function humanSize(size) {
  let value = Number(size);
  for (const unit of ['B', 'KB', 'MB', 'GB', 'TB']) {
    if (value < 1024 || unit === 'TB') return `${pyFixed(value, unit === 'B' ? 0 : 1)} ${unit}`;
    value /= 1024;
  }
  throw new Error('unreachable');
}

/** admin._format_duration: "1:32", or "1:02:03" past an hour. */
function formatDuration(ms) {
  let seconds = pyRound(Number(ms) / 1000);
  const hours = Math.floor(seconds / 3600);
  const rest = seconds - hours * 3600;
  const minutes = Math.floor(rest / 60);
  seconds = rest - minutes * 60;
  const two = (n) => String(n).padStart(2, '0');
  return hours ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`;
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * datetime.fromisoformat(iso.replace("Z", "+00:00")) as epoch ms; a value without an offset is
 * local time, as Python's astimezone() takes it. null when Python would raise ValueError.
 */
function parseIso(iso) {
  const match = ISO_RE.exec(String(iso));
  if (!match) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0', frac = '', zone] = match;
  const ms = Math.floor(Number(`0.${frac || '0'}`) * 1000);
  const parts = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms];
  if (parts[1] > 11 || parts[2] < 1 || parts[2] > 31 || parts[3] > 23 || parts[4] > 59 || parts[5] > 59) return null;
  let epoch;
  if (zone === undefined) {
    epoch = new Date(...parts).getTime();
  } else {
    epoch = Date.UTC(...parts);
    if (zone !== 'Z') {
      const offset = zone.replace(':', '');
      const minutes = Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3, 5));
      epoch -= (offset[0] === '-' ? -1 : 1) * minutes * 60000;
    }
  }
  const check = new Date(Date.UTC(parts[0], parts[1], parts[2]));
  if (check.getUTCDate() !== parts[2]) return null; // Feb 30 and the like
  return Number.isNaN(epoch) ? null : epoch;
}

/** admin._local_time: a stored UTC timestamp as this PC's local time, e.g. "Sep 23 · 11:48". */
function localTime(iso) {
  const epoch = parseIso(iso);
  if (epoch === null) return String(iso);
  const date = new Date(epoch);
  const two = (n) => String(n).padStart(2, '0');
  return `${MONTHS[date.getMonth()]} ${date.getDate()} · ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** The templates' `localtime` filter: "never" for an empty timestamp. */
function localtimeFilter(iso) {
  return iso ? localTime(iso) : 'never';
}

/** admin._elapsed: time since `updatedAt`, "42s", "3m 5s" or "2h 7m". */
function elapsed(updatedAt, now = Date.now()) {
  const epoch = parseIso(updatedAt);
  if (epoch === null) return '?';
  let seconds = Math.trunc((now - epoch) / 1000);
  if (seconds < 60) return `${seconds}s`;
  let minutes = Math.floor(seconds / 60);
  seconds %= 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  minutes %= 60;
  return `${hours}h ${minutes}m`;
}

/** str.capitalize(). */
function pyCapitalize(value) {
  const text = String(value);
  return text ? text.charAt(0).toUpperCase() + text.slice(1).toLowerCase() : '';
}

/** [label, tone] for a job status, as the status pills show it. */
function statusView(status) {
  return Object.hasOwn(STATUS_VIEW, status) ? STATUS_VIEW[status] : [pyCapitalize(status), 'work'];
}

module.exports = {
  elapsed,
  formatDuration,
  humanSize,
  localTime,
  localtimeFilter,
  pyQuote,
  redirectLocation,
  roundOne,
  statusView,
};
