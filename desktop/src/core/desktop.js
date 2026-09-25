// Open Explorer with a file selected, on this PC only (the admin route enforces local-direct).
// Port of r1cord_server/desktop.py. The core has no Electron imports: a host can take over via
// setHostReveal (Electron `shell.showItemInFolder`). Without a host, this spawns explorer.exe
// the same way Python does. The Win32 foreground raise is the exported `raiseWhenOpen`
// algorithm; callers inject the user32 hooks, or Electron replaces the whole reveal.

const childProcess = require('node:child_process');
const path = require('node:path');

const EXPLORER_CLASS = 'CabinetWClass';
const WAIT_S = 5.0;

const SILENT_LOGGER = Object.freeze({
  info() {},
  warning() {},
  warn() {},
  error() {},
});

let hostReveal = null;

/**
 * Electron (or a test) takes over reveal. `null` restores the explorer.exe path.
 * @param {((filePath: string) => void)|null} fn
 */
function setHostReveal(fn) {
  hostReveal = typeof fn === 'function' ? fn : null;
}

function explorerSelectArg(filePath) {
  return `/select,${filePath}`;
}

function defaultSpawnExplorer(filePath) {
  const child = childProcess.spawn('explorer.exe', [explorerSelectArg(filePath)], {
    stdio: 'ignore',
    detached: true,
    windowsHide: false,
    shell: false,
  });
  child.unref();
  return child;
}

function monotonicSeconds() {
  return Number(process.hrtime.bigint()) / 1e9;
}

/**
 * Wait for the new (or reused) Explorer window and raise it. Python runs this on a daemon
 * thread; here it is async so it does not block the core. Win32 primitives are injected.
 * @param {Set<number>} before
 * @param {string} folder
 * @param {{waitS?: number, now?: Function, sleep?: Function, explorerWindows?: Function,
 *          title?: Function, bringToFront?: Function, logger?: object}} [options]
 */
async function raiseWhenOpen(before, folder, options = {}) {
  const waitS = options.waitS === undefined ? WAIT_S : options.waitS;
  const now = options.now || monotonicSeconds;
  const pause = options.sleep || ((seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)));
  const list = options.explorerWindows || (() => []);
  const titleOf = options.title || (() => '');
  const bring = options.bringToFront || (() => false);
  const log = options.logger || SILENT_LOGGER;
  const folderText = String(folder);
  const folderName = path.basename(folderText);
  const deadline = now() + waitS;
  while (now() < deadline) {
    await pause(0.1);
    const windows = list();
    const fresh = windows.filter((hwnd) => !before.has(hwnd));
    const match = fresh.length
      ? fresh
      : windows.filter((hwnd) => {
          const title = titleOf(hwnd);
          return title.startsWith(folderText) || title.startsWith(folderName);
        });
    if (match.length) {
      if (!bring(match[0])) {
        log.info(`reveal: Windows kept ${folderText} behind the foreground window; flashing it`);
      }
      return true;
    }
  }
  log.info(`reveal: no Explorer window for ${folderText} appeared within ${waitS.toFixed(0)} s`);
  return false;
}

/**
 * Open Explorer with `path` selected. On Windows, kick the raise dance in the background
 * when Win32 hooks are supplied (or a test injects raiseWhenOpen).
 * @param {string} targetPath
 * @param {{hostReveal?: Function|null, spawnExplorer?: Function, platform?: string,
 *          raiseWhenOpen?: Function|false, explorerWindows?: Function, logger?: object}} [options]
 */
function revealInExplorer(targetPath, options = {}) {
  const file = path.resolve(String(targetPath));
  const host = options.hostReveal !== undefined ? options.hostReveal : hostReveal;
  if (typeof host === 'function') {
    host(file);
    return;
  }
  const spawnExplorer = options.spawnExplorer || defaultSpawnExplorer;
  spawnExplorer(file);
  const platform = options.platform === undefined ? process.platform : options.platform;
  if (platform !== 'win32') return;
  if (options.raiseWhenOpen === false) return;
  const raise = options.raiseWhenOpen || raiseWhenOpen;
  const before = new Set((options.explorerWindows || (() => []))());
  Promise.resolve(raise(before, path.dirname(file), options)).catch((error) => {
    const log = options.logger || SILENT_LOGGER;
    log.info(`reveal: ${error}`);
  });
}

module.exports = {
  EXPLORER_CLASS,
  WAIT_S,
  explorerSelectArg,
  raiseWhenOpen,
  revealInExplorer,
  setHostReveal,
  reveal_in_explorer: revealInExplorer,
};
