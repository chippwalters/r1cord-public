// The programs the core runs (writer CLIs, gws): Python's shutil.which lookup, and
// a spawn that also starts npm's `.cmd` shims, which Node refuses to run without a shell
// (CVE-2024-27980). A shim is unwrapped to the program it starts: its native exe, or node plus its
// script. Any other batch file goes through cmd.exe with cross-spawn's escaping, for our fixed argv
// only. Children never open a console window, and a timeout or abort kills the whole tree.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const WIN_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC';
// A shim line that runs `"%dp0%\<target>" %*` (npm cmd-shim; older shims say %~dp0).
const SHIM_TARGET = /"%(?:~dp0|dp0%)\\([^"]+)"\s+%\*/g;
const BATCH_EXT = new Set(['.cmd', '.bat']);
const META_CHARS = /([()\][%!^"`<>&|;, *?])/g;
const NPM_BIN_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

// process.env is case-insensitive on Windows; an injected plain object is not.
function envGet(env, name, platform) {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function envHas(env, name, platform) {
  return envGet(env, name, platform) !== undefined;
}

// os.path.join(dir, name) without normalizing `dir` (so "." stays ".\name", as in Python).
function joinRaw(dir, name, platform) {
  const sep = platform === 'win32' ? '\\' : '/';
  const last = dir.slice(-1);
  if (last === '/' || (platform === 'win32' && (last === '\\' || /^[A-Za-z]:$/.test(dir)))) return dir + name;
  return dir + sep + name;
}

function accessCheck(file, platform) {
  try {
    const stat = fs.statSync(file);
    if (stat.isDirectory()) return false;
    if (platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch (_error) {
    return false;
  }
}

// os.path.split(cmd): [head, tail], the head without trailing separators unless it is the root.
function splitPath(text, platform) {
  let drive = '';
  let rest = text;
  if (platform === 'win32' && /^[A-Za-z]:/.test(text)) {
    drive = text.slice(0, 2);
    rest = text.slice(2);
  }
  const cut = platform === 'win32' ? Math.max(rest.lastIndexOf('/'), rest.lastIndexOf('\\')) : rest.lastIndexOf('/');
  const head = rest.slice(0, cut + 1);
  const stripped = head.replace(platform === 'win32' ? /[\\/]+$/ : /\/+$/, '');
  return [drive + (stripped || head), rest.slice(cut + 1)];
}

/**
 * shutil.which(cmd) as Python 3.12 does it: a name with a directory part is checked only there;
 * on Windows the current directory is searched first (unless NoDefaultCurrentDirectoryInExePath
 * is set) and PATHEXT extensions are tried, the bare name only when it already has one.
 * @param {string} cmd
 * @param {{env?: object, platform?: string}} [options]
 * @returns {string|null}
 */
function which(cmd, { env = process.env, platform = process.platform } = {}) {
  const [dirname, base] = splitPath(String(cmd), platform);
  let dirs;
  if (dirname) {
    dirs = [dirname];
  } else {
    const pathVar = envGet(env, 'PATH', platform);
    if (!pathVar) return null;
    dirs = pathVar.split(platform === 'win32' ? ';' : ':');
    if (platform === 'win32' && !envHas(env, 'NoDefaultCurrentDirectoryInExePath', platform)) dirs.unshift('.');
  }
  let files = [base];
  if (platform === 'win32') {
    const pathext = (envGet(env, 'PATHEXT', platform) || WIN_DEFAULT_PATHEXT)
      .split(';')
      .filter(Boolean)
      .map((ext) => ext.replace(/\.+$/, ''));
    files = pathext.map((ext) => base + ext);
    const upper = base.toUpperCase();
    if (pathext.some((ext) => upper.endsWith(ext.toUpperCase()))) files.unshift(base);
  }
  const seen = new Set();
  for (const dir of dirs) {
    const key = platform === 'win32' ? dir.replace(/\//g, '\\').toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const file of files) {
      const candidate = joinRaw(dir, file, platform);
      if (accessCheck(candidate, platform)) return candidate;
    }
  }
  return null;
}

function escapeCommand(arg) {
  return arg.replace(META_CHARS, '^$1');
}

function escapeArgument(arg, doubleEscape) {
  let out = String(arg);
  out = out.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  out = out.replace(/(?=(\\+?)?)\1$/, '$1$1');
  out = `"${out}"`;
  out = out.replace(META_CHARS, '^$1');
  if (doubleEscape) out = out.replace(META_CHARS, '^$1');
  return out;
}

function viaCmd(file, args, env, platform) {
  const line = [escapeCommand(path.normalize(file)), ...args.map((arg) => escapeArgument(arg, NPM_BIN_SHIM.test(file)))];
  return {
    command: envGet(env, 'COMSPEC', platform) || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line.join(' ')}"`],
    windowsVerbatimArguments: true,
  };
}

// The target an npm cmd-shim runs, or null when `file` is not one.
function shimTarget(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_error) {
    return null;
  }
  let last = null;
  for (const match of text.matchAll(SHIM_TARGET)) last = match;
  if (!last) return null;
  const dir = path.dirname(file);
  return { target: path.join(dir, last[1]), usesNode: /_prog|node(?:\.exe)?"?\s/i.test(text.slice(0, last.index)) };
}

/**
 * How to start `argv` with shell:false.
 * @param {string[]} argv resolved program first
 * @param {{env?: object, platform?: string}} [options]
 * @returns {{command: string, args: string[], windowsVerbatimArguments?: boolean}}
 */
function spawnArgs(argv, { env = process.env, platform = process.platform } = {}) {
  const [file, ...args] = argv;
  if (platform !== 'win32' || !BATCH_EXT.has(path.extname(file).toLowerCase())) return { command: file, args };
  const shim = shimTarget(file);
  if (shim && fs.existsSync(shim.target)) {
    const ext = path.extname(shim.target).toLowerCase();
    if (ext === '.exe') return { command: shim.target, args };
    if (shim.usesNode) {
      const bundled = path.join(path.dirname(file), 'node.exe');
      const node = fs.existsSync(bundled) ? bundled : which('node', { env, platform });
      if (node) return { command: node, args: [shim.target, ...args] };
    }
  }
  return viaCmd(file, args, env, platform);
}

/**
 * child_process.spawn for a resolved argv: no console window, no shell, and on POSIX its own
 * process group so killTree() reaches the grandchildren.
 * @param {string[]} argv
 * @param {object} [options] child_process.spawn options (cwd, env, stdio)
 * @returns {import('node:child_process').ChildProcess}
 */
function spawn(argv, options = {}) {
  const env = options.env || process.env;
  const spec = spawnArgs(argv, { env });
  return childProcess.spawn(spec.command, spec.args, {
    ...options,
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: Boolean(spec.windowsVerbatimArguments),
    detached: process.platform !== 'win32',
  });
}

/**
 * Kill a child and everything it started: `taskkill /T /F` on Windows, the process group on POSIX.
 * Resolves once taskkill is done (not when the child has exited).
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<void>}
 */
function killTree(child) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      childProcess.execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }, () => resolve());
    });
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (_error) {
    child.kill('SIGKILL');
  }
  return Promise.resolve();
}

module.exports = { killTree, spawn, spawnArgs, which };
