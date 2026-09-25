// Default config/datastore locations and PurePath-style string handling.
// Windows mirrors r1cord_server/config.py `_config_dir` exactly; the macOS/Linux rows
// come from ELECTRON-PLAN §3.4. Nothing here touches the disk beyond os.homedir().

const os = require('node:os');
const path = require('node:path');

// Options: { env = process.env, platform = process.platform, home = os.homedir() }.
function configDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    // Python: (Path(LOCALAPPDATA) if set else Path.home() / ".r1cord") / "R1CORD".
    const base = env.LOCALAPPDATA || path.join(home, '.r1cord');
    return path.join(base, 'R1CORD');
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'R1CORD');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'r1cord');
}

// Linux keeps data under XDG_DATA_HOME, everywhere else beside the config (plan §3.4).
function dataDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (platform === 'linux') {
    return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'r1cord');
  }
  return configDir({ env, platform, home });
}

function defaultConfigPath(options = {}) {
  const env = options.env || process.env;
  if (env.R1CORD_SERVER_CONFIG) return env.R1CORD_SERVER_CONFIG;
  return path.join(configDir(options), 'config.toml');
}

function defaultDatastore(options = {}) {
  return path.join(dataDir(options), 'data');
}

function defaultWebdavFolder(options = {}) {
  return path.join(dataDir(options), 'publish');
}

// An explicit --config wins, then R1CORD_SERVER_CONFIG, then the default
// (Python __main__.py passes args.config straight to config.load).
function resolveConfigPath({ config = null, ...options } = {}) {
  return config || defaultConfigPath(options);
}

// Where the Devices page installs Google's platform tools: beside the loaded config.toml
// (%LOCALAPPDATA%\R1CORD for a default install), never inside the app bundle.
function platformToolsDir(configFolder) {
  return path.join(configFolder, 'platform-tools');
}

function platformToolsAdb(configFolder) {
  return path.join(platformToolsDir(configFolder), 'adb.exe');
}

// str(Path(value)) on Windows: backslash separators, no trailing slash, repeated
// separators collapsed, "." dropped, ".." kept (PurePath never resolves lexically).
// On POSIX str(Path(value)) is the input verbatim.
function pathString(value) {
  if (typeof value !== 'string') {
    const kind = value === null ? 'NoneType' : Array.isArray(value) ? 'list' : typeof value;
    throw new TypeError(`argument should be a str or an os.PathLike object, not '${kind}'`);
  }
  if (process.platform !== 'win32') return value;
  if (value === '') return '.';
  let prefix = '';
  let rest = value;
  const unc = /^[/\\]{2}([^/\\]+)[/\\]+([^\\/]+)/.exec(rest);
  if (unc) {
    prefix = `\\\\${unc[1]}\\${unc[2]}`;
    rest = rest.slice(unc[0].length);
  } else {
    const drive = /^([a-zA-Z]:)([\s\S]*)$/.exec(rest);
    if (drive) {
      prefix = drive[1];
      rest = drive[2];
    }
  }
  const root = /^[/\\]+/.exec(rest);
  if (root) {
    prefix += '\\';
    rest = rest.slice(root[0].length);
  }
  const segments = rest.split(/[/\\]+/).filter((segment) => segment !== '' && segment !== '.');
  const joined = prefix + segments.join('\\');
  return joined || '.';
}

// PurePath.parts on Windows: the drive or UNC root is the first part, "." dropped,
// ".." kept. Lexical only — the WebDAV mount raises on realpath.
function pathParts(value) {
  const string = pathString(value);
  if (string === '.') return ['.'];
  let prefix = '';
  let rest = string;
  const unc = /^\\\\([^\\]+)\\([^\\]+)/.exec(rest);
  if (unc) {
    prefix = unc[0];
    rest = rest.slice(unc[0].length);
  } else {
    const drive = /^([a-zA-Z]:)([\s\S]*)$/.exec(rest);
    if (drive) {
      prefix = drive[1];
      rest = drive[2];
    }
  }
  const root = /^\\+/.exec(rest);
  if (root) {
    prefix += '\\';
    rest = rest.slice(root[0].length);
  }
  const segments = rest.split(/\\+/).filter((segment) => segment !== '' && segment !== '.');
  return prefix ? [prefix, ...segments] : segments;
}

module.exports = {
  configDir,
  dataDir,
  defaultConfigPath,
  defaultDatastore,
  defaultWebdavFolder,
  resolveConfigPath,
  platformToolsDir,
  platformToolsAdb,
  pathString,
  pathParts,
};
