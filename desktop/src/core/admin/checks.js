// What the server depends on, as the System page and the dashboard's System tile show it.
// Port of admin._checks, _cli_status and _server_version.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cli = require('../cli');
const mailer = require('../mailer');
const render = require('../render');
const { UsbWatcher } = require('../usb');
const { pathString } = require('../paths');
const { errorText, isDir, isFile, pyStrip } = require('../pipeline/compat');
const models = require('../pipeline/models');
const { humanSize } = require('./format');

const WRITER_NAMES = { claude_code: 'Claude Code', codex: 'Codex', grok_build: 'Grok Build' };
const LOW_DISK_BYTES = 5 * 1024 ** 3;
const PACKAGE_JSON = path.join(__dirname, '..', '..', '..', 'package.json');

/** One System row. state: ok (working), warn (needs attention), off (not in use). */
function check(name, state, detail) {
  return { name, state, detail };
}

function cliStatus(cmd) {
  if (isFile(cmd)) return pathString(cmd);
  return cli.which(cmd) || 'not found';
}

/** The app version: package.json beside the core, else "unknown". */
function serverVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).version || 'unknown');
  } catch (_error) {
    return 'unknown';
  }
}

// shutil.disk_usage(path).free: total free bytes on Windows, bytes available on POSIX.
function freeBytes(dir) {
  const stats = fs.statfsSync(dir);
  return (process.platform === 'win32' ? stats.bfree : stats.bavail) * stats.bsize;
}

function modelSnapshot(config, modelDownload) {
  if (modelDownload && typeof modelDownload.snapshot === 'function') return modelDownload.snapshot(config);
  try {
    const spec = models.resolveModel(config.asr_model, config.asr_quant || models.DEFAULT_QUANT);
    const status = models.modelStatus(models.modelsDir(config.datastore), spec);
    return { ...status, error: '' };
  } catch (error) {
    return { error: error.message, state: 'missing' };
  }
}

function lastBackend(store) {
  if (!store || typeof store.recentJobs !== 'function' || typeof store.outboxDir !== 'function') return '';
  for (const rec of store.recentJobs(50)) {
    try {
      const file = path.join(store.outboxDir(rec.recordingId), 'result.json');
      if (!isFile(file)) continue;
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const device = data && data.asr && data.asr.device;
      if (device) return String(device);
    } catch (_error) {
      continue;
    }
  }
  return '';
}

function speechCheck(config, { store, modelDownload } = {}) {
  const snap = modelSnapshot(config, modelDownload);
  const backend = lastBackend(store);
  const backendNote = backend ? ` · last backend ${backend}` : '';
  if (snap.error) return check('Speech recognition', 'warn', `${snap.error}${backendNote}`);
  if (snap.state === 'present') {
    return check('Speech recognition', 'ok', `whisper.cpp · ${config.asr_model}${backendNote}`);
  }
  if (snap.state === 'partial') {
    return check('Speech recognition', 'warn', `whisper.cpp model downloading · ${config.asr_model}${backendNote}`);
  }
  return check('Speech recognition', 'warn', `whisper.cpp model missing · ${config.asr_model}${backendNote}`);
}

/**
 * The System rows, in the order a problem would hurt.
 * @param {object} config
 * @param {{store?: object, modelDownload?: {snapshot: Function}, configDir?: string|null}} [options]
 *   configDir: folder of config.toml, where the Devices page installs platform-tools
 */
async function systemChecks(config, { store, modelDownload, configDir = null } = {}) {
  const checks = [];
  checks.push(speechCheck(config, { store, modelDownload }));

  const writerCmds = { claude_code: config.claude_cmd, codex: config.codex_cmd, grok_build: config.grok_cmd };
  if (config.default_writer === 'none') {
    checks.push(check('AI reviews writer', 'off', 'AI reviews are off (default_writer = none)'));
  } else {
    const name = WRITER_NAMES[config.default_writer];
    const cmd = writerCmds[config.default_writer];
    const found = cliStatus(cmd);
    if (found === 'not found') checks.push(check('AI reviews writer', 'warn', `${name} not found (${cmd})`));
    else checks.push(check('AI reviews writer', 'ok', `${name} · ${found}`));
  }
  const others = Object.entries(writerCmds)
    .filter(([key]) => key !== config.default_writer)
    .map(([key, cmd]) => `${WRITER_NAMES[key]} ${cliStatus(cmd) !== 'not found' ? 'found' : 'not installed'}`);
  checks.push(check('Other writers', 'off', others.join(' · ')));

  if (!config.usb_enabled) {
    checks.push(check('USB mode', 'off', 'Off — recordings arrive only by Send'));
  } else {
    const adb = UsbWatcher.adbPath(config, configDir);
    checks.push(adb ? check('USB mode', 'ok', `adb · ${adb}`) : check('USB mode', 'warn', `adb not found (${config.adb_cmd}) · download it on the Devices page`));
  }

  try {
    checks.push(check('Page theme', 'ok', render.getTheme(config.theme).name));
  } catch (_error) {
    checks.push(check('Page theme', 'warn', `Unknown theme: ${config.theme}`));
  }
  const webdav = pathString(config.webdav_folder);
  checks.push(isDir(webdav) ? check('Publish folder', 'ok', webdav) : check('Publish folder', 'warn', `Missing: ${webdav}`));

  const to = pyStrip(config.email_to);
  if (!config.email_enabled) checks.push(check('Email', 'off', 'Off'));
  else if (!to) checks.push(check('Email', 'warn', 'On, but no recipient is set (email_to)'));
  else if (mailer.gwsExecutable(config.gws_cmd) === null) {
    checks.push(check('Email', 'warn', `On, but gws was not found (${config.gws_cmd})`));
  } else checks.push(check('Email', 'ok', `To ${to} via gws`));

  const datastore = pathString(config.datastore);
  try {
    const free = freeBytes(datastore);
    checks.push(check('Storage', free >= LOW_DISK_BYTES ? 'ok' : 'warn', `${humanSize(free)} free · ${datastore}`));
  } catch (error) {
    checks.push(check('Storage', 'warn', `Cannot read ${datastore}: ${errorText(error)}`));
  }
  return checks;
}

module.exports = { serverVersion, systemChecks };
