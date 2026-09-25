// Port of r1cord_server/config.py: frozen config objects, TOML load/save via smol-toml,
// defaults, coercion, validation errors, legacy mappings and theme name->id resolution.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const toml = require('smol-toml');
const { ValueError } = require('./errors');
const { defaultConfigPath, defaultDatastore, defaultWebdavFolder, pathString } = require('./paths');

// Dataclass field order; saveConfig() writes the TOML keys in this order.
const FIELD_ORDER = [
  'server_name', 'listen_host', 'listen_port', 'datastore', 'webdav_folder', 'public_url_base',
  'theme', 'default_writer', 'default_reviews', 'writer_timeout_s', 'claude_cmd', 'codex_cmd',
  'grok_cmd', 'asr_model', 'asr_device', 'asr_quant', 'asr_language', 'admin_password', 'admin_remote',
  'pair_code_ttl_s', 'usb_enabled', 'adb_cmd', 'usb_poll_s', 'usb_auto_action', 'usb_device_root',
  'run_mode', 'idle_exit_min', 'email_enabled', 'email_to', 'gws_cmd',
];
const PATH_FIELDS = new Set(['datastore', 'webdav_folder']);
const INT_FIELDS = new Set(['listen_port', 'writer_timeout_s', 'pair_code_ttl_s', 'usb_poll_s', 'idle_exit_min']);
const BOOL_FIELDS = new Set(['usb_enabled', 'email_enabled', 'admin_remote']);
const WRITERS = new Set(['claude_code', 'codex', 'grok_build', 'none']);
// Same asr_device values Python 0.3.4 accepts, so a Settings save never writes a config.toml
// the rollback server rejects. Desktop maps cuda to auto at runtime (Vulkan/CPU); asr_quant is
// Desktop-only and Python ignores it.
const ASR_QUANT_VALUES = ['q8_0', 'f16', 'q5_0', 'q5_1'];
const ASR_DEVICE_VALUES = ['auto', 'cuda', 'cpu'];
const ASR_QUANTS = new Set(ASR_QUANT_VALUES);
const ASR_DEVICES = new Set(ASR_DEVICE_VALUES);
// `review` runs default_reviews; `publish` runs them and publishes. Config files written
// before AI reviews say `summarize`, which meant the same as `review`.
const USB_ACTIONS = ['archive', 'transcribe', 'review', 'publish'];
const LEGACY_USB_ACTIONS = { summarize: 'review' };
const RUN_MODES = ['plug', 'always'];

// AI reviews of a recording's transcript, in canonical (page) order. The transcript page comes first.
const REVIEW_KINDS = ['summary', 'outline', 'organized'];
const PAGE_KINDS = ['transcript', 'summary', 'outline', 'organized'];
const PAGE_LABELS = {
  transcript: 'Transcript',
  summary: 'Summary',
  outline: 'Outline',
  organized: 'Cleaned up & organized',
};
// The admin's page links and republish table say "Organized" where the page says the full label.
const PAGE_SHORT_LABELS = { ...PAGE_LABELS, organized: 'Organized' };

const DEFAULT_THEME_ID = 'toolmaker-noir';
// The 12 MD DOCS themes vendored in r1cord_server/render/themes (@name headers),
// matched by id or name, case-insensitive.
const THEMES = new Map([
  ['altuit', 'altuit'],
  ['altuit-toc', 'altuit-toc'],
  ['altuit-toc-lg', 'altuit-toc-lg'],
  ['altuit-toc-light', 'altuit-toc-light'],
  ['altuit-toc-sketchnote', 'altuit-toc-sketchnote'],
  ['clean-light', 'clean-light'],
  ['clean light', 'clean-light'],
  ['github-dark', 'github-dark'],
  ['github dark', 'github-dark'],
  ['github-light', 'github-light'],
  ['github light', 'github-light'],
  ['high-contrast', 'high-contrast'],
  ['high contrast', 'high-contrast'],
  ['modern-dark', 'modern-dark'],
  ['modern dark', 'modern-dark'],
  ['notion', 'notion'],
  ['toolmaker-noir', 'toolmaker-noir'],
]);
// Python repr() for the messages tests and logs match on.
function pyRepr(value) {
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (value === null || value === undefined) return 'None';
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  return String(value);
}

// Review kinds in canonical order, duplicates dropped. Unknown kinds raise ValueError.
function canonicalReviews(kinds) {
  const chosen = new Set();
  for (const kind of kinds) {
    if (!REVIEW_KINDS.includes(kind)) {
      throw new ValueError(`unknown review: ${pyRepr(kind)} (expected summary, outline or organized)`);
    }
    chosen.add(kind);
  }
  return REVIEW_KINDS.filter((kind) => chosen.has(kind));
}

// Theme id for an id or name, case-insensitive; ValueError when unknown.
function themeId(value) {
  const wanted = String(value).trim().toLowerCase();
  const id = THEMES.get(wanted);
  if (id === undefined) throw new ValueError(`unknown theme: ${pyRepr(String(value))}`);
  return id;
}

function randomPassword(length = 16) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < length; index += 1) value += alphabet[crypto.randomInt(alphabet.length)];
  return value;
}

function freeze(config) {
  config.default_reviews = Object.freeze([...config.default_reviews]);
  return Object.freeze(config);
}

// Python int(): truncates floats, parses strings (surrounding whitespace ok), rejects
// anything else — including arrays, which Number.parseInt would happily stringify.
function toInt(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValueError('cannot convert float NaN or infinity to integer');
    return Math.trunc(value);
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
      throw new ValueError(`invalid literal for int() with base 10: ${pyRepr(value)}`);
    }
    return Number.parseInt(trimmed, 10);
  }
  const kind = value === null ? 'NoneType' : Array.isArray(value) ? 'list' : typeof value;
  throw new TypeError(`int() argument must be a string or a real number, not '${kind}'`);
}

// Python bool(): empty containers are falsy (JavaScript arrays never are).
function toBool(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

// Options: { env = process.env, logger = console } (paths.js adds platform/home).
function defaultConfig(options = {}) {
  return freeze({
    server_name: 'R1CORD',
    listen_host: '127.0.0.1',
    listen_port: 8765,
    datastore: defaultDatastore(options),
    webdav_folder: defaultWebdavFolder(options),
    public_url_base: '',
    theme: DEFAULT_THEME_ID,
    default_writer: 'claude_code',
    default_reviews: ['summary'],
    writer_timeout_s: 900,
    claude_cmd: 'claude',
    codex_cmd: 'codex',
    grok_cmd: 'grok',
    asr_model: 'large-v3-turbo',
    asr_device: 'auto',
    asr_quant: 'q8_0',
    asr_language: '',
    admin_password: '',
    admin_remote: false,
    pair_code_ttl_s: 600,
    usb_enabled: true,
    adb_cmd: 'adb',
    usb_poll_s: 3,
    usb_auto_action: 'transcribe',
    usb_device_root: '/sdcard/Download/R1CORD',
    run_mode: 'plug',
    idle_exit_min: 10,
    email_enabled: false,
    email_to: '',
    gws_cmd: 'gws',
  });
}

function saveConfig(config, configPath = null, options = {}) {
  const dest = configPath || defaultConfigPath(options);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const payload = {};
  for (const key of FIELD_ORDER) {
    const value = config[key];
    payload[key] = Array.isArray(value) ? [...value] : value;
  }
  // Python's write_text() puts CRLF on Windows; keep the files byte-identical.
  const text = toml.stringify(payload);
  fs.writeFileSync(dest, process.platform === 'win32' ? text.replace(/\n/g, '\r\n') : text, 'utf8');
}

// Load config from TOML. Create defaults and a random admin password on first run.
function loadConfig(configPath = null, options = {}) {
  const { logger = console } = options;
  const cfgPath = configPath || defaultConfigPath(options);
  const stat = fs.statSync(cfgPath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) return bootstrap(cfgPath, options);
  return parseConfig(cfgPath, options, logger);
}

// Return a new config with the given fields replaced. Unknown keys are ignored; a theme
// name becomes its id, and an unknown theme raises ValueError.
function withUpdates(config, updates = {}) {
  const updated = { ...config, default_reviews: [...config.default_reviews] };
  for (const [key, value] of Object.entries(updates)) {
    if (!FIELD_ORDER.includes(key)) continue;
    if (PATH_FIELDS.has(key)) updated[key] = pathString(value);
    else if (INT_FIELDS.has(key)) updated[key] = toInt(value);
    else if (BOOL_FIELDS.has(key)) updated[key] = toBool(value);
    else if (key === 'default_reviews') updated[key] = canonicalReviews(value);
    else if (key === 'theme') updated[key] = themeId(value);
    else updated[key] = value;
  }
  assertAsr(updated);
  return freeze(updated);
}

// Python Path equality: separator-normalized, case-insensitive on Windows.
function samePath(left, right) {
  const a = pathString(String(left));
  const b = pathString(String(right));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function bootstrap(cfgPath, options) {
  const password = randomPassword();
  const datastore = samePath(cfgPath, defaultConfigPath(options))
    ? defaultDatastore(options)
    : path.join(path.dirname(cfgPath), 'data');
  const config = freeze({ ...defaultConfig(options), datastore, admin_password: password });
  saveConfig(config, cfgPath, options);
  console.log(`r1cord-server first run. Config: ${cfgPath}  Data: ${datastore}`);
  return config;
}

function parseConfig(cfgPath, options, logger) {
  const raw = toml.parse(fs.readFileSync(cfgPath, 'utf8'));
  const defaults = defaultConfig(options);
  const config = { ...defaults, default_reviews: [...defaults.default_reviews] };
  for (const key of FIELD_ORDER) {
    if (!(key in raw)) continue;
    let value = raw[key];
    try {
      if (PATH_FIELDS.has(key)) value = pathString(value);
      else if (INT_FIELDS.has(key)) value = toInt(value);
      else if (BOOL_FIELDS.has(key)) value = toBool(value);
      else if (key === 'default_reviews') {
        if (typeof value === 'string' || !Array.isArray(value)) throw new ValueError('expected a list');
        value = canonicalReviews(value);
      } else if (key === 'usb_auto_action' && Object.prototype.hasOwnProperty.call(LEGACY_USB_ACTIONS, value)) {
        value = LEGACY_USB_ACTIONS[value];
      }
    } catch (error) {
      throw new ValueError(`invalid ${key}: ${pyRepr(raw[key])} (${error.message})`);
    }
    config[key] = value;
  }
  try {
    config.theme = themeId(config.theme);
  } catch (error) {
    logger.warn(`config: unknown theme ${pyRepr(config.theme)}, using ${DEFAULT_THEME_ID}`);
    config.theme = DEFAULT_THEME_ID;
  }
  if (!config.admin_password) {
    const password = randomPassword();
    config.admin_password = password;
    saveConfig(config, cfgPath, options);
    console.log(`r1cord-server generated admin password: ${password}`);
  }
  if (!WRITERS.has(config.default_writer)) {
    throw new ValueError(`invalid default_writer: ${config.default_writer}`);
  }
  assertAsr(config);
  if (!USB_ACTIONS.includes(config.usb_auto_action)) {
    throw new ValueError(`invalid usb_auto_action: ${config.usb_auto_action}`);
  }
  if (config.usb_poll_s < 1) throw new ValueError('usb_poll_s must be >= 1');
  if (!RUN_MODES.includes(config.run_mode)) throw new ValueError(`invalid run_mode: ${config.run_mode}`);
  if (config.idle_exit_min < 1) throw new ValueError('idle_exit_min must be >= 1');
  return freeze(config);
}

function assertAsr(config) {
  if (!ASR_QUANTS.has(config.asr_quant)) {
    throw new ValueError(`invalid asr_quant: ${config.asr_quant}`);
  }
  if (!ASR_DEVICES.has(config.asr_device)) {
    throw new ValueError(`invalid asr_device: ${config.asr_device}`);
  }
}

module.exports = {
  REVIEW_KINDS,
  PAGE_KINDS,
  PAGE_LABELS,
  PAGE_SHORT_LABELS,
  USB_ACTIONS,
  RUN_MODES,
  ASR_DEVICE_VALUES,
  ASR_QUANT_VALUES,
  canonicalReviews,
  defaultConfig,
  loadConfig,
  saveConfig,
  withUpdates,
};
