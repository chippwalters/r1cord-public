// Google's Android platform tools (adb) for USB mode, fetched only when the local user presses the
// Devices page button. The zip goes to <configDir>/platform-tools.zip.part, Windows' own tar.exe
// extracts it into a staging folder beside it, adb.exe must carry a valid Authenticode signature
// from Google, and only then is the platform-tools folder renamed into place (an older copy is
// swapped out). A failure or cancel removes the .part and the staging folder, so the install
// location only ever holds a complete, verified copy or what was there before.
// Progress lives in memory: the Devices page shows it on reload, like the System page's model.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { killTree, spawn, which } = require('./cli');
const { platformToolsAdb, platformToolsDir } = require('./paths');
const { errorText } = require('./pipeline/compat');

const PLATFORM_TOOLS_URL = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip';
// The zip is about 7 MB; anything far bigger is not what we asked for.
const MAX_BYTES = 200 * 1024 * 1024;
const EXTRACT_TIMEOUT_MS = 120_000;
const VERIFY_TIMEOUT_MS = 60_000;
const PART_NAME = 'platform-tools.zip.part';
const STAGING_PREFIX = 'platform-tools.staging-';
const OLD_SUFFIX = '.old';

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (_error) {
    return false;
  }
}

function removeQuietly(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
  } catch (_error) {
    // a leftover is removed on the next start
  }
}

function isAbort(error) {
  return Boolean(error) && (error.name === 'AbortError' || /abort/i.test(String(error.message || '')));
}

function abortError() {
  const error = new Error('platform-tools download cancelled');
  error.name = 'AbortError';
  return error;
}

// A Windows system program by absolute path: a tar.exe from Git or MSYS earlier on PATH cannot
// read zip files, and a PATH lookup would run whatever sits first.
function systemProgram(...parts) {
  return path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', ...parts);
}

/**
 * Run a program to completion without a shell; kill its tree on timeout or abort.
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
function runTool(argv, { timeoutMs, signal = null, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError());
      return;
    }
    let child;
    try {
      child = spawn(argv, { cwd: os.tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    const out = [];
    const err = [];
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish(reject, new Error(`${path.basename(argv[0])} did not finish within ${timeoutMs / 1000} s`));
    }, timeoutMs);
    const onAbort = () => {
      killTree(child);
      finish(reject, abortError());
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => finish(reject, new Error(`${path.basename(argv[0])}: ${error.message}`)));
    child.on('close', (code) =>
      finish(resolve, {
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    );
  });
}

/** Extract `zip` into `dest` with the system tar (bsdtar reads zip on Windows and macOS). */
async function extractZip(zip, dest, { signal = null } = {}) {
  const tar = process.platform === 'win32' ? systemProgram('tar.exe') : which('tar') || 'tar';
  const result = await runTool([tar, '-xf', zip, '-C', dest], { timeoutMs: EXTRACT_TIMEOUT_MS, signal });
  if (result.code !== 0) {
    throw new Error(`tar could not extract the download (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

const AUTHENTICODE_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$s = Get-AuthenticodeSignature -LiteralPath $env:R1CORD_SIGNED_FILE',
  '$subject = ""',
  'if ($s.SignerCertificate) { $subject = $s.SignerCertificate.Subject }',
  '[pscustomobject]@{ status = [string]$s.Status; subject = $subject } | ConvertTo-Json -Compress',
].join('\n');

/**
 * Get-AuthenticodeSignature of `file` through Windows PowerShell, spawned without a shell.
 * @returns {Promise<{status: string, subject: string}>}
 */
async function authenticode(file, { signal = null } = {}) {
  const env = { ...process.env, R1CORD_SIGNED_FILE: file };
  // A PowerShell 7 module path makes Windows PowerShell load the wrong Security module.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  const encoded = Buffer.from(AUTHENTICODE_SCRIPT, 'utf16le').toString('base64');
  const powershell = systemProgram('WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = await runTool([powershell, '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    timeoutMs: VERIFY_TIMEOUT_MS,
    signal,
    env,
  });
  const line = result.stdout.trim().split(/\r?\n/).pop() || '';
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (_error) {
    throw new Error(`could not check the signature of adb.exe (exit ${result.code}): ${result.stderr.trim() || line}`);
  }
  return { status: String(parsed.status || ''), subject: String(parsed.subject || '') };
}

async function download(url, part, run, { fetch, signal }) {
  const response = await fetch(url, { redirect: 'follow', signal });
  if (!response.ok) {
    if (response.body) await response.body.cancel().catch(() => {});
    throw new Error(`platform-tools download failed: HTTP ${response.status} for ${url}`);
  }
  run.total = Number(response.headers.get('content-length')) || 0;
  const fd = fs.openSync(part, 'w');
  try {
    for await (const chunk of response.body) {
      run.received += chunk.length;
      if (run.received > MAX_BYTES) throw new Error(`platform-tools download is larger than ${MAX_BYTES} bytes`);
      fs.writeSync(fd, chunk);
    }
  } finally {
    fs.closeSync(fd);
  }
  if (run.total && run.received !== run.total) {
    throw new Error(`platform-tools download ended at ${run.received} of ${run.total} bytes`);
  }
}

// Leftovers of an interrupted earlier run (the process was killed mid-download).
function removeLeftovers(configDir) {
  removeQuietly(path.join(configDir, PART_NAME));
  removeQuietly(`${platformToolsDir(configDir)}${OLD_SUFFIX}`);
  for (const name of fs.readdirSync(configDir)) {
    if (name.startsWith(STAGING_PREFIX)) removeQuietly(path.join(configDir, name));
  }
}

// Rename the verified folder into place; an older copy is moved aside first and restored if the
// rename fails (e.g. its adb.exe is still running and Windows holds the folder).
function swapInto(src, target) {
  const old = `${target}${OLD_SUFFIX}`;
  removeQuietly(old);
  const hadOld = fs.existsSync(target);
  if (hadOld) fs.renameSync(target, old);
  try {
    fs.renameSync(src, target);
  } catch (error) {
    if (hadOld) fs.renameSync(old, target);
    throw error;
  }
  if (hadOld) removeQuietly(old);
}

async function install(configDir, run, { fetch, extract, verify, url, log }) {
  const signal = run.controller.signal;
  fs.mkdirSync(configDir, { recursive: true });
  removeLeftovers(configDir);
  const part = path.join(configDir, PART_NAME);
  const staging = fs.mkdtempSync(path.join(configDir, STAGING_PREFIX));
  const target = platformToolsDir(configDir);
  try {
    log(`usb: downloading platform-tools from ${url}`);
    await download(url, part, run, { fetch, signal });
    run.phase = 'extracting';
    await extract(part, staging, { signal });
    const adb = path.join(staging, 'platform-tools', 'adb.exe');
    if (!isFile(adb)) throw new Error('the download has no platform-tools/adb.exe; nothing was installed');
    if (verify) {
      run.phase = 'verifying';
      const sig = await verify(adb, { signal });
      const status = sig ? sig.status : 'missing';
      const subject = (sig && sig.subject) || '';
      if (status !== 'Valid' || !/Google/.test(subject)) {
        throw new Error(`adb.exe is not validly signed by Google (signature ${status}, signer ${subject || 'none'}); nothing was installed`);
      }
    }
    if (signal.aborted) throw abortError();
    run.phase = 'installing';
    swapInto(path.join(staging, 'platform-tools'), target);
    log(`usb: platform-tools installed at ${target}`);
    return platformToolsAdb(configDir);
  } finally {
    removeQuietly(part);
    removeQuietly(staging);
  }
}

/**
 * One background platform-tools install at a time, with its progress and last result.
 * @param {{fetch?: typeof fetch, extract?: Function, verify?: Function|null, url?: string}} [deps]
 *   verify(file) resolves {status, subject}; null skips the check (default off Windows).
 */
function createPlatformToolsDownload({
  fetch = (...args) => globalThis.fetch(...args),
  extract = extractZip,
  verify = process.platform === 'win32' ? authenticode : null,
  url = PLATFORM_TOOLS_URL,
} = {}) {
  let current = null;
  let last = null;

  /** What the Devices page shows: the running phase and bytes, or the last run's outcome. */
  function snapshot(configDir) {
    const adb = platformToolsAdb(configDir);
    return {
      active: current !== null,
      phase: current ? current.phase : '',
      received: current ? current.received : 0,
      total: current ? current.total : 0,
      installed: isFile(adb) ? adb : '',
      error: last && !last.ok ? last.error : '',
      done: last && last.ok ? last.path : '',
    };
  }

  /**
   * Start (or join) the install. Resolves to the installed adb.exe path.
   * @param {string} configDir folder of config.toml
   * @param {{log?: (line: string) => void, onInstalled?: (adb: string) => void}} [options]
   */
  function start(configDir, { log = () => {}, onInstalled = () => {} } = {}) {
    if (current) return current.promise;
    const run = { controller: new AbortController(), phase: 'downloading', received: 0, total: 0, promise: null };
    last = null;
    current = run;
    run.promise = install(configDir, run, { fetch, extract, verify, url, log })
      .then(
        (adb) => {
          last = { ok: true, path: adb };
          try {
            onInstalled(adb);
          } catch (error) {
            log(`usb: could not pick up the new adb: ${errorText(error)}`);
          }
          return adb;
        },
        (error) => {
          last = { ok: false, error: isAbort(error) ? 'cancelled' : errorText(error) };
          throw error;
        },
      )
      .finally(() => {
        if (current === run) current = null;
      });
    return run.promise;
  }

  function cancel() {
    if (current) current.controller.abort();
  }

  return {
    snapshot,
    start,
    cancel,
    get active() {
      return current !== null;
    },
  };
}

module.exports = { PLATFORM_TOOLS_URL, authenticode, createPlatformToolsDownload, extractZip, isAbort };
