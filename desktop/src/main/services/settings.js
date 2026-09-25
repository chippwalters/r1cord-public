const fs = require('fs');
const path = require('path');

const STARTUP_MODES = ['manual', 'plug', 'login'];
const DEFAULT_PORT = 8765;

function settingsPath(userData) {
  return path.join(userData, 'desktop-settings.json');
}

function defaultSettings() {
  return {
    configPath: '',
    port: DEFAULT_PORT,
    startupMode: 'manual',
    adbPath: 'adb',
  };
}

function normalizeSettings(raw) {
  const merged = { ...defaultSettings(), ...raw };
  const startupMode = STARTUP_MODES.includes(merged.startupMode) ? merged.startupMode : 'manual';
  const port = Number(merged.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${merged.port}`);
  }
  return {
    configPath: merged.configPath || '',
    port,
    startupMode,
    adbPath: merged.adbPath || 'adb',
    noUsb: Boolean(raw && raw.noUsb),
    noWorker: Boolean(raw && raw.noWorker),
  };
}

function loadSettings(userData) {
  const file = settingsPath(userData);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return normalizeSettings(parsed);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ...defaultSettings() };
    }
    throw err;
  }
}

function saveSettings(userData, settings) {
  const normalized = normalizeSettings(settings);
  const persisted = {
    configPath: normalized.configPath,
    port: normalized.port,
    startupMode: normalized.startupMode,
    adbPath: normalized.adbPath,
  };
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(settingsPath(userData), `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
  return normalized;
}

function applyCliOverrides(settings, argv) {
  const next = { ...settings };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) {
      next.port = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--port=')) {
      next.port = Number(arg.slice('--port='.length));
    } else if (arg === '--config' && argv[i + 1]) {
      next.configPath = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--config=')) {
      next.configPath = arg.slice('--config='.length);
    } else if (arg === '--no-usb') {
      next.noUsb = true;
    } else if (arg === '--no-worker') {
      next.noWorker = true;
    }
  }
  return next;
}

function cliOption(argv, name) {
  const prefix = `${name}=`;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === name && argv[i + 1]) return argv[i + 1];
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return '';
}

function parseUserDataDir(argv) {
  return cliOption(argv, '--user-data-dir');
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function nodeCoreScript(appPath) {
  if (!appPath) throw new Error('appPath is required to locate the Node core');
  return path.join(appPath, 'src', 'core', 'index.js');
}

// The ffmpeg the app ships (binaries/win32, see its NOTICE.txt). Packaged it is always
// resources/win32/ffmpeg.exe (forge's prePackage hook refuses to build without it). In dev it is
// binaries/win32/ffmpeg.exe when that copy exists, else null: the core then runs `ffmpeg` from PATH.
function bundledFfmpegPath({ isPackaged, resourcesPath, appPath }) {
  if (isPackaged) return path.join(resourcesPath, 'win32', 'ffmpeg.exe');
  const file = path.join(appPath, 'binaries', 'win32', 'ffmpeg.exe');
  return fs.existsSync(file) ? file : null;
}

// appPath: where src/core lives (app.asar when packaged); cwd: a real folder, default appPath;
// ffmpegPath: the decoder the core hands the ASR worker (bundledFfmpegPath), null for PATH.
function nodeCoreInput(settings, { appPath, cwd, ffmpegPath = null } = {}) {
  const root = appPath || settings.appPath;
  return {
    scriptPath: nodeCoreScript(root),
    appPath: root,
    configPath: settings.configPath,
    port: settings.port,
    cwd: cwd || root,
    noUsb: Boolean(settings.noUsb),
    noWorker: Boolean(settings.noWorker),
    ffmpegPath,
  };
}

const nodeCoreDescriptor = {
  resolveExecutable: (input) => input.scriptPath || nodeCoreScript(input.appPath),
  buildArgs: (input) => {
    const args = [];
    if (input.configPath) args.push('--config', input.configPath);
    if (input.port) args.push('--port', String(input.port));
    if (input.host) args.push('--host', String(input.host));
    if (input.noUsb) args.push('--no-usb');
    if (input.noWorker) args.push('--no-worker');
    return args;
  },
  resolveCwd: (input) => input.cwd,
  buildEnv: (input) => {
    const env = {};
    if (input.noUsb) env.R1CORD_NO_USB = '1';
    if (input.noWorker) env.R1CORD_NO_WORKER = '1';
    if (input.ffmpegPath) env.R1CORD_FFMPEG = input.ffmpegPath;
    return env;
  },
};

module.exports = {
  STARTUP_MODES,
  DEFAULT_PORT,
  settingsPath,
  defaultSettings,
  normalizeSettings,
  loadSettings,
  saveSettings,
  applyCliOverrides,
  hasFlag,
  cliOption,
  parseUserDataDir,
  nodeCoreScript,
  bundledFfmpegPath,
  nodeCoreInput,
  nodeCoreDescriptor,
};
