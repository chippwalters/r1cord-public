// Consented update checks and verified APK supply for the R1.
//
// Nothing here touches the network unless the owner turned on `update_check` (Settings > Updates,
// or the first-run question), or pressed an explicit button (Check now, Set up R1) that passes
// `force`/`config`. A check is two plain GETs: manifest.json and manifest.json.sig from
// `update_manifest_url`, no identifiers, 15 s, 1 MB. The manifest must carry an Ed25519 signature
// by the pinned publication key, pass a strict schema, and not roll back the release sequence
// last accepted (kept in <configDir>/update-state.json with the accepted bytes, re-verified on
// load). APKs come from the manifest's folder into %LOCALAPPDATA%\R1CORD\tools\apk\<sha256>.apk
// via a .partial file; size, SHA-256, the v2/v3 signature, the pinned signer, the package and the
// versionCode must all match before a file is used, and cached files are re-verified every time.
// Desktop updates are notify-only: the page links the ZIP; nothing downloads or replaces the app.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { checkPinned, verifyApk } = require('./apk');
const paths = require('./paths');
const { APK_ENTRIES, MANIFEST_PUBLIC_KEY_SPKI_B64, SIGNER_PINS, pinFor } = require('./release-keys');

const MANIFEST_MAX_BYTES = 1024 * 1024;
const SIGNATURE_MAX_BYTES = 4096;
const MANIFEST_TIMEOUT_MS = 15_000;
const APK_TIMEOUT_MS = 30 * 60_000;
const FIRST_CHECK_MS = 30_000;
const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const STATE_FILE = 'update-state.json';
const FILE_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.apk$/;
const HEX64_RE = /^[0-9a-fA-F]{64}$/;
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

class UpdateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UpdateError';
  }
}

// What this process knows; the page reads it through updateState().
const runtime = {
  configDir: null,
  manifest: null,
  manifestUrl: null,
  lastCheckAt: null,
  lastError: null,
  checking: false,
  loaded: false,
};

function desktopVersion() {
  return require('../../package.json').version;
}

function parseVersion(text) {
  const match = VERSION_RE.exec(String(text));
  if (!match) return null;
  return { nums: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] || null };
}

/** Semver order of two x.y.z[-pre] strings: negative, 0 or positive. Invalid strings throw. */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new UpdateError(`not a version: ${left ? b : a}`);
  for (let i = 0; i < 3; i += 1) {
    if (left.nums[i] !== right.nums[i]) return left.nums[i] - right.nums[i];
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  const lp = left.pre.split('.');
  const rp = right.pre.split('.');
  for (let i = 0; i < Math.max(lp.length, rp.length); i += 1) {
    if (lp[i] === undefined) return -1;
    if (rp[i] === undefined) return 1;
    const ln = /^\d+$/.test(lp[i]);
    const rn = /^\d+$/.test(rp[i]);
    if (ln && rn && Number(lp[i]) !== Number(rp[i])) return Number(lp[i]) - Number(rp[i]);
    if (ln !== rn) return ln ? -1 : 1;
    if (lp[i] !== rp[i]) return lp[i] < rp[i] ? -1 : 1;
  }
  return 0;
}

// --- manifest ------------------------------------------------------------------------------------

function httpsUrl(value, what) {
  let url;
  try {
    url = new URL(String(value));
  } catch (_error) {
    throw new UpdateError(`${what} is not a URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) throw new UpdateError(`${what} must be a plain https:// URL`);
  return url;
}

function publicKeyOf(option) {
  if (option && typeof option === 'object' && option.type === 'public') return option;
  const der = Buffer.from(option || MANIFEST_PUBLIC_KEY_SPKI_B64, 'base64');
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

function schemaFail(message) {
  throw new UpdateError(`manifest rejected: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hex64(value, where) {
  if (typeof value !== 'string' || !HEX64_RE.test(value)) schemaFail(`${where} must be 64 hex digits`);
  return value.toLowerCase();
}

function wholeNumber(value, where, min) {
  if (!Number.isSafeInteger(value) || value < min) schemaFail(`${where} must be an integer >= ${min}`);
  return value;
}

function version(value, where) {
  if (typeof value !== 'string' || !parseVersion(value)) schemaFail(`${where} must be a version like 1.2.3`);
  return value;
}

function validateEntry(name, entry) {
  const where = `android.${name}`;
  if (!isObject(entry)) schemaFail(`${where} must be an object`);
  const pkg = APK_ENTRIES[name];
  if (entry.package !== pkg) schemaFail(`${where}.package must be ${pkg}`);
  if (typeof entry.versionName !== 'string' || !entry.versionName.trim() || entry.versionName.length > 100) {
    schemaFail(`${where}.versionName must be a short non-empty string`);
  }
  if (typeof entry.file !== 'string' || !FILE_RE.test(entry.file)) {
    schemaFail(`${where}.file must be a bare file name ending in .apk`);
  }
  const certSha256 = hex64(entry.certSha256, `${where}.certSha256`);
  if (certSha256 !== SIGNER_PINS[pkg]) schemaFail(`${where}.certSha256 is not the built-in signer pin for ${pkg}`);
  const out = {
    package: pkg,
    versionName: entry.versionName,
    versionCode: wholeNumber(entry.versionCode, `${where}.versionCode`, 1),
    file: entry.file,
    size: wholeNumber(entry.size, `${where}.size`, 1),
    sha256: hex64(entry.sha256, `${where}.sha256`),
    certSha256,
  };
  if (entry.minDesktop !== undefined) out.minDesktop = version(entry.minDesktop, `${where}.minDesktop`);
  return Object.freeze(out);
}

function validateManifest(data) {
  if (!isObject(data)) schemaFail('not a JSON object');
  if (data.schema !== 1) schemaFail('schema must be 1');
  const sequence = wholeNumber(data.sequence, 'sequence', 0);
  if (typeof data.publishedAt !== 'string' || Number.isNaN(Date.parse(data.publishedAt))) schemaFail('publishedAt must be a date');
  const d = data.desktop;
  if (!isObject(d)) schemaFail('desktop must be an object');
  const desktop = {
    version: version(d.version, 'desktop.version'),
    url: (() => {
      try {
        return httpsUrl(d.url, 'desktop.url').href;
      } catch (error) {
        return schemaFail(error.message);
      }
    })(),
    size: wholeNumber(d.size, 'desktop.size', 0),
    sha256: hex64(d.sha256, 'desktop.sha256'),
    notes: null,
  };
  if (d.notes !== undefined && d.notes !== null) {
    try {
      desktop.notes = httpsUrl(d.notes, 'desktop.notes').href;
    } catch (error) {
      schemaFail(error.message);
    }
  }
  if (!isObject(data.android)) schemaFail('android must be an object');
  const android = {};
  for (const name of Object.keys(APK_ENTRIES)) {
    if (data.android[name] !== undefined) android[name] = validateEntry(name, data.android[name]);
  }
  if (!Object.keys(android).length) schemaFail('android lists none of r1cord, controls, tailscale');
  return Object.freeze({
    schema: 1,
    sequence,
    publishedAt: data.publishedAt,
    desktop: Object.freeze(desktop),
    android: Object.freeze(android),
  });
}

/**
 * Check the Ed25519 signature over the exact manifest bytes, then the schema.
 * `options.publicKey` (SPKI DER base64 or KeyObject) replaces the built-in key in tests only.
 * @returns the validated manifest; throws UpdateError otherwise.
 */
function verifyManifest(bytes, sigB64, options = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(typeof bytes === 'string' ? bytes : bytes || []);
  if (buffer.length > MANIFEST_MAX_BYTES) throw new UpdateError('manifest rejected: larger than 1 MB');
  const sigText = String(sigB64 === undefined || sigB64 === null ? '' : sigB64).trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(sigText)) throw new UpdateError('manifest rejected: the signature file is not a base64 Ed25519 signature');
  const ok = crypto.verify(null, buffer, publicKeyOf(options.publicKey), Buffer.from(sigText, 'base64'));
  if (!ok) throw new UpdateError('manifest rejected: its signature is not from the R1CORD publication key (tampered or foreign manifest)');
  let data;
  try {
    data = JSON.parse(buffer.toString('utf8'));
  } catch (_error) {
    throw new UpdateError('manifest rejected: not valid JSON');
  }
  return validateManifest(data);
}

// --- persisted state -----------------------------------------------------------------------------

function stateDir(options = {}) {
  return options.configDir || runtime.configDir || paths.configDir();
}

function statePath(dir) {
  return path.join(dir, STATE_FILE);
}

/** The stored state; a file that exists but cannot be read refuses updates (it holds the rollback floor). */
function readState(dir) {
  let text;
  try {
    text = fs.readFileSync(statePath(dir), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new UpdateError(`cannot read ${statePath(dir)}: ${error.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (_error) {
    data = null;
  }
  if (!isObject(data) || (data.lastSequence !== undefined && !Number.isSafeInteger(data.lastSequence))) {
    throw new UpdateError(`${statePath(dir)} is damaged; delete it to reset update checks`);
  }
  return data;
}

function writeState(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  const file = statePath(dir);
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

/** Load the last accepted manifest from disk once (re-verifying its signature). */
function loadStored(options = {}) {
  if (runtime.loaded && !options.configDir) return;
  runtime.loaded = true;
  let stored;
  try {
    stored = readState(stateDir(options));
  } catch (error) {
    runtime.lastError = error.message;
    return;
  }
  if (stored.lastCheckAt && !runtime.lastCheckAt) runtime.lastCheckAt = stored.lastCheckAt;
  if (stored.lastError !== undefined && runtime.lastError === null) runtime.lastError = stored.lastError || null;
  if (runtime.manifest || !stored.manifest || !stored.signature || !stored.manifestUrl) return;
  try {
    const manifest = verifyManifest(Buffer.from(stored.manifest, 'base64'), stored.signature, options);
    if (manifest.sequence !== stored.lastSequence) return;
    runtime.manifest = manifest;
    runtime.manifestUrl = stored.manifestUrl;
  } catch (_error) {
    // A stored manifest that no longer verifies is simply not used; the next check replaces it.
  }
}

// --- network -------------------------------------------------------------------------------------

async function fetchChecked(fetchImpl, url, signal) {
  const response = await fetchImpl(url, { redirect: 'follow', signal });
  if (!response || !response.ok) throw new UpdateError(`${url}: HTTP ${response ? response.status : 'no response'}`);
  if (response.url && !String(response.url).startsWith('https:')) throw new UpdateError(`${url}: redirected off https`);
  return response;
}

async function* bodyChunks(response) {
  if (!response.body) return;
  for await (const chunk of response.body) yield Buffer.from(chunk);
}

async function getBytes(fetchImpl, url, maxBytes) {
  const signal = AbortSignal.timeout(MANIFEST_TIMEOUT_MS);
  const response = await fetchChecked(fetchImpl, url, signal);
  const declared = Number(response.headers && response.headers.get ? response.headers.get('content-length') : NaN);
  if (declared > maxBytes) throw new UpdateError(`${url}: larger than ${maxBytes} bytes`);
  const chunks = [];
  let size = 0;
  for await (const chunk of bodyChunks(response)) {
    size += chunk.length;
    if (size > maxBytes) throw new UpdateError(`${url}: larger than ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function describe(error) {
  if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timed out';
  return error && error.message ? error.message : String(error);
}

/**
 * Fetch, verify and accept the release manifest. Makes no request (returns null) unless
 * `config.update_check` is on or `force` is set (an explicit Check now / setup action).
 * Options: { force, fetch, configDir, publicKey (tests) }.
 */
async function fetchManifest(config, options = {}) {
  const { force = false } = options;
  if (!config || (!config.update_check && !force)) return null;
  const fetchImpl = options.fetch || globalThis.fetch;
  const dir = stateDir(options);
  const at = new Date().toISOString();
  runtime.checking = true;
  try {
    const url = httpsUrl(config.update_manifest_url, 'update_manifest_url').href;
    let bytes;
    let sig;
    try {
      bytes = await getBytes(fetchImpl, url, MANIFEST_MAX_BYTES);
      sig = (await getBytes(fetchImpl, `${url}.sig`, SIGNATURE_MAX_BYTES)).toString('utf8');
    } catch (error) {
      throw error instanceof UpdateError ? error : new UpdateError(`update check failed: ${describe(error)}`);
    }
    const manifest = verifyManifest(bytes, sig, options);
    const stored = readState(dir);
    if (Number.isSafeInteger(stored.lastSequence) && manifest.sequence < stored.lastSequence) {
      throw new UpdateError(
        `manifest rejected: release sequence ${manifest.sequence} is older than ${stored.lastSequence}, the last one accepted (rollback)`,
      );
    }
    writeState(dir, {
      ...stored,
      lastSequence: manifest.sequence,
      lastCheckAt: at,
      lastError: null,
      manifestUrl: url,
      manifest: bytes.toString('base64'),
      signature: sig.trim(),
    });
    runtime.manifest = manifest;
    runtime.manifestUrl = url;
    runtime.lastCheckAt = at;
    runtime.lastError = null;
    runtime.loaded = true;
    return manifest;
  } catch (error) {
    runtime.lastCheckAt = at;
    runtime.lastError = describe(error);
    try {
      const stored = readState(dir);
      writeState(dir, { ...stored, lastCheckAt: at, lastError: runtime.lastError });
    } catch (_error) {
      // The in-memory state still shows the error.
    }
    throw error instanceof UpdateError ? error : new UpdateError(runtime.lastError);
  } finally {
    runtime.checking = false;
  }
}

/** The manifest to use: in memory, else stored, else (when `config` is given) fetched once. */
async function currentManifest(options = {}) {
  if (options.manifest) {
    if (!options.manifestUrl) throw new UpdateError('manifestUrl is required with an explicit manifest');
    return { manifest: options.manifest, manifestUrl: httpsUrl(options.manifestUrl, 'manifest URL').href };
  }
  loadStored(options);
  if (!runtime.manifest && options.config) await fetchManifest(options.config, { ...options, force: true });
  if (!runtime.manifest) {
    throw new UpdateError('no verified release manifest yet: turn on update checks or press Check now on the Updates page');
  }
  return { manifest: runtime.manifest, manifestUrl: runtime.manifestUrl };
}

// --- APKs ----------------------------------------------------------------------------------------

function defaultApkDir() {
  return path.join(paths.configDir(), 'tools', 'apk');
}

function bundledDirs() {
  const dirs = [];
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'apk'));
  dirs.push(path.resolve(__dirname, '..', '..', 'resources', 'apk'));
  return dirs;
}

function requirePin(entryName) {
  const pin = pinFor(entryName);
  if (!pin) throw new UpdateError(`unknown APK ${JSON.stringify(entryName)}`);
  return pin;
}

async function fileSha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
  return hash.digest('hex');
}

function removeQuietly(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch (_error) {
    // Left for the next attempt to overwrite.
  }
}

function verifyPinned(file, entryName) {
  try {
    return checkPinned(verifyApk(file), requirePin(entryName));
  } catch (error) {
    throw new UpdateError(`${path.basename(file)} refused: ${error.message}`);
  }
}

/** Size, SHA-256, signature, pin, package and versionCode of a file against its manifest entry. */
async function verifyEntryFile(file, entryName, entry) {
  const size = fs.statSync(file).size;
  if (size !== entry.size) throw new UpdateError(`${entry.file} refused: ${size} bytes, the manifest says ${entry.size}`);
  const sha256 = await fileSha256(file);
  if (sha256 !== entry.sha256) throw new UpdateError(`${entry.file} refused: SHA-256 ${sha256} is not the manifest's ${entry.sha256}`);
  const info = verifyPinned(file, entryName);
  if (info.versionCode !== entry.versionCode || info.versionName !== entry.versionName) {
    throw new UpdateError(
      `${entry.file} refused: version ${info.versionName} (${info.versionCode}), the manifest says ${entry.versionName} (${entry.versionCode})`,
    );
  }
  return info;
}

async function download(fetchImpl, url, partial, entry) {
  const response = await fetchChecked(fetchImpl, url, AbortSignal.timeout(APK_TIMEOUT_MS));
  const declared = Number(response.headers && response.headers.get ? response.headers.get('content-length') : NaN);
  if (Number.isFinite(declared) && declared > 0 && declared !== entry.size) {
    throw new UpdateError(`${entry.file} refused: ${declared} bytes offered, the manifest says ${entry.size}`);
  }
  const handle = await fs.promises.open(partial, 'w');
  let size = 0;
  try {
    for await (const chunk of bodyChunks(response)) {
      size += chunk.length;
      if (size > entry.size) throw new UpdateError(`${entry.file} refused: larger than the manifest's ${entry.size} bytes`);
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
}

/**
 * A verified copy of the manifest's APK `entryName` ('r1cord' | 'controls' | 'tailscale'),
 * downloaded into the APK cache when needed. Options: { config (allows one forced manifest fetch
 * when none is known), fetch, apkDir, configDir, manifest + manifestUrl (tests) }.
 * @returns {Promise<{path: string, info: object}>}
 */
async function ensureApk(entryName, options = {}) {
  requirePin(entryName);
  const { manifest, manifestUrl } = await currentManifest(options);
  const entry = manifest.android[entryName];
  if (!entry) throw new UpdateError(`the release manifest has no ${entryName} APK`);
  if (entry.minDesktop && compareVersions(entry.minDesktop, desktopVersion()) > 0) {
    throw new UpdateError(`${entry.file} needs R1CORD Desktop ${entry.minDesktop} or newer (this is ${desktopVersion()})`);
  }
  const dir = options.apkDir || defaultApkDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${entry.sha256}.apk`);
  if (fs.existsSync(dest)) {
    try {
      return { path: dest, info: await verifyEntryFile(dest, entryName, entry) };
    } catch (_error) {
      removeQuietly(dest);
    }
  }
  const url = httpsUrl(new URL(entry.file, manifestUrl).href, `${entry.file} URL`).href;
  const partial = `${dest}.partial`;
  try {
    try {
      await download(options.fetch || globalThis.fetch, url, partial, entry);
    } catch (error) {
      throw error instanceof UpdateError ? error : new UpdateError(`${entry.file} download failed: ${describe(error)}`);
    }
    const info = await verifyEntryFile(partial, entryName, entry);
    fs.renameSync(partial, dest);
    return { path: dest, info };
  } finally {
    removeQuietly(partial);
  }
}

/** The highest-versionCode verified, pinned APK for `entryName` shipped with the desktop, or null. */
function bundledApk(entryName, options = {}) {
  requirePin(entryName);
  let best = null;
  for (const dir of options.dirs || bundledDirs()) {
    let names;
    try {
      names = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.apk')).sort();
    } catch (_error) {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      let info;
      try {
        info = checkPinned(verifyApk(file), requirePin(entryName));
      } catch (_error) {
        continue; // another package, or a file that does not verify: never offered
      }
      if (!best || info.versionCode > best.info.versionCode) best = { path: file, info };
    }
  }
  return best;
}

async function cachedApks(entryName, dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => /^[0-9a-f]{64}\.apk$/.test(name));
  } catch (_error) {
    return [];
  }
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if ((await fileSha256(file)) !== name.slice(0, 64)) continue;
      out.push({ path: file, info: checkPinned(verifyApk(file), requirePin(entryName)), source: 'cached' });
    } catch (_error) {
      // not this package, or damaged: skipped
    }
  }
  return out;
}

/**
 * The newest verified APK for `entryName` among the bundled copy, the cache and the release
 * manifest (downloaded when it is newer and `allowDownload`). Options as ensureApk, plus
 * { allowDownload = true }. Returns { path, info, source } or null when nothing verified exists.
 */
async function newestApk(entryName, options = {}) {
  requirePin(entryName);
  const { allowDownload = true } = options;
  const candidates = [];
  const bundled = bundledApk(entryName, options);
  if (bundled) candidates.push({ ...bundled, source: 'bundled' });
  candidates.push(...(await cachedApks(entryName, options.apkDir || defaultApkDir())));
  const newest = () => candidates.reduce((best, c) => (!best || c.info.versionCode > best.info.versionCode ? c : best), null);

  let entry = null;
  try {
    const { manifest } = await currentManifest(allowDownload ? options : { ...options, config: undefined });
    entry = manifest.android[entryName] || null;
  } catch (error) {
    if (!candidates.length) throw error;
  }
  const best = newest();
  if (entry && allowDownload && (!best || entry.versionCode > best.info.versionCode)) {
    try {
      candidates.push({ ...(await ensureApk(entryName, options)), source: 'download' });
    } catch (error) {
      if (!best) throw error;
      return { ...best, warning: error.message };
    }
  }
  return newest();
}

// --- state for the UI and the background schedule ------------------------------------------------

/** What the Updates page and the banner show. Options: { configDir } (defaults as fetchManifest). */
function updateState(options = {}) {
  loadStored(options.configDir ? { configDir: options.configDir } : {});
  const manifest = runtime.manifest;
  const current = desktopVersion();
  const latest = manifest ? manifest.desktop.version : null;
  const android = {};
  if (manifest) {
    for (const [name, e] of Object.entries(manifest.android)) {
      android[name] = { package: e.package, versionName: e.versionName, versionCode: e.versionCode, file: e.file, size: e.size };
    }
  }
  return {
    checking: runtime.checking,
    lastCheckAt: runtime.lastCheckAt,
    lastError: runtime.lastError,
    sequence: manifest ? manifest.sequence : null,
    publishedAt: manifest ? manifest.publishedAt : null,
    desktop: {
      current,
      latest,
      available: latest !== null && compareVersions(latest, current) > 0,
      url: manifest ? manifest.desktop.url : null,
      notes: manifest ? manifest.desktop.notes : null,
    },
    android,
  };
}

/**
 * Background checks: the first 30 s after start, then every 24 h, each only while
 * `state.config.update_check` is on. Returns stop().
 */
function startUpdateChecks(state, options = {}) {
  const { firstDelayMs = FIRST_CHECK_MS, intervalMs = CHECK_INTERVAL_MS } = options;
  if (state.configDir) {
    runtime.configDir = state.configDir;
    runtime.loaded = false;
  }
  const log = state.loggers && state.loggers.app;
  let stopped = false;
  let timer = null;
  const schedule = (ms) => {
    timer = setTimeout(tick, ms);
    if (typeof timer.unref === 'function') timer.unref();
  };
  async function tick() {
    timer = null;
    if (stopped) return;
    if (state.config && state.config.update_check) {
      try {
        await fetchManifest(state.config, { fetch: options.fetch, configDir: state.configDir });
      } catch (error) {
        if (log && typeof log.warning === 'function') log.warning(`update check: ${error.message}`);
      }
    }
    if (!stopped) schedule(intervalMs);
  }
  schedule(firstDelayMs);
  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

/** Forget in-memory state (tests). */
function resetForTests() {
  Object.assign(runtime, {
    configDir: null,
    manifest: null,
    manifestUrl: null,
    lastCheckAt: null,
    lastError: null,
    checking: false,
    loaded: false,
  });
}

module.exports = {
  UpdateError,
  bundledApk,
  compareVersions,
  desktopVersion,
  ensureApk,
  fetchManifest,
  newestApk,
  resetForTests,
  startUpdateChecks,
  updateState,
  verifyManifest,
};
