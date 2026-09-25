// Python semantics the pipeline reproduces so its files match the Python server's byte for byte:
// text-mode file I/O (utf-8, universal newlines in, os.linesep out), str.strip()/splitlines(),
// repr(), int() and round() of JSON values.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ValueError } = require('../errors');

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const LENIENT_UTF8 = new TextDecoder('utf-8', { ignoreBOM: true });

// Characters Python's str.isspace() accepts; str.strip() removes exactly these.
const PY_SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_STRIP_RE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'g');
const PY_SPLIT_RE = new RegExp(`[${PY_SPACE}]+`);
// str.splitlines() boundaries.
const PY_LINES_RE = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
const PY_NONPRINTABLE_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

// Python text-mode writes turn '\n' into os.linesep.
function platformText(text) {
  return os.EOL === '\n' ? text : text.replace(/\n/g, os.EOL);
}

// Path.write_text(text, encoding="utf-8").
function writeText(file, text) {
  fs.writeFileSync(file, platformText(text), 'utf8');
}

// Path.read_text(encoding="utf-8"[, errors="replace"]): universal newlines, a BOM is kept.
function readText(file, { errors = 'strict' } = {}) {
  const bytes = fs.readFileSync(file);
  let text;
  if (errors === 'replace') {
    text = LENIENT_UTF8.decode(bytes);
  } else {
    try {
      text = STRICT_UTF8.decode(bytes);
    } catch (_error) {
      throw new ValueError(`'utf-8' codec can't decode ${path.basename(file)}`);
    }
  }
  return text.replace(/\r\n?/g, '\n');
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (_error) {
    return false;
  }
}

function isDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch (_error) {
    return false;
  }
}

// shutil.copy2: contents plus timestamps.
function copy2(source, dest) {
  fs.copyFileSync(source, dest);
  const stat = fs.statSync(source);
  fs.utimesSync(dest, stat.atime, stat.mtime);
}

function pyStrip(value) {
  return String(value).replace(PY_STRIP_RE, '');
}

// str.split() with no separator: runs of whitespace, no empty items.
function pySplit(value) {
  const text = pyStrip(value);
  return text ? text.split(PY_SPLIT_RE) : [];
}

function pySplitlines(value) {
  const text = String(value);
  if (!text) return [];
  const lines = text.split(PY_LINES_RE);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function pyStrRepr(value) {
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

// Python float repr: fixed notation for exponents -4..15, else d.ddde+XX. JSON cannot tell 1.0
// from 1, so callers that know a value is a float say so.
function pyFloatRepr(value) {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  const [mantissa, exponentText] = value.toExponential().split('e');
  const exponent = Number(exponentText);
  if (exponent >= -4 && exponent < 16) {
    const text = String(value);
    return Number.isInteger(value) ? `${text}.0` : text;
  }
  const sign = exponent < 0 ? '-' : '+';
  return `${mantissa}e${sign}${String(Math.abs(exponent)).padStart(2, '0')}`;
}

// repr() of a JSON value.
function pyRepr(value) {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : pyFloatRepr(value);
  if (typeof value === 'string') return pyStrRepr(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  return `{${Object.entries(value).map(([key, item]) => `${pyStrRepr(key)}: ${pyRepr(item)}`).join(', ')}}`;
}

// int() of a JSON value: TypeError for None and containers, ValueError for a non-integer string.
function pyInt(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValueError(`cannot convert float ${pyFloatRepr(value)} to integer`);
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const text = pyStrip(value);
    if (/^[+-]?\d+(_\d+)*$/.test(text)) return Number(text.replace(/_/g, ''));
    throw new ValueError(`invalid literal for int() with base 10: ${pyStrRepr(value)}`);
  }
  const kind = value === null || value === undefined ? 'NoneType' : Array.isArray(value) ? 'list' : 'dict';
  throw new TypeError(`int() argument must be a string, a bytes-like object or a real number, not '${kind}'`);
}

// Python truthiness for JSON values: empty containers are false.
function pyTruthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

// round(x) for a float: half to even.
function pyRound(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

// f"{n:,}".
function thousands(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// str(exc) for whatever was thrown.
function errorText(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

module.exports = {
  PY_SPACE,
  copy2,
  errorText,
  isDir,
  isFile,
  platformText,
  pyFloatRepr,
  pyInt,
  pyRepr,
  pyRound,
  pySplit,
  pySplitlines,
  pyStrRepr,
  pyStrip,
  pyTruthy,
  readText,
  thousands,
  writeText,
};
