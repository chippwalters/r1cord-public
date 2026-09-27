// Tailscale on this Windows PC: detect the client and tailnet, install the official MSI only after
// the local user consents (published SHA-256 plus an Authenticode signature from Tailscale Inc.,
// then one elevated msiexec), start the browser sign-in, share only the API-only /v1 listener with
// `tailscale serve`, check from the outside that nothing else is published, and hand out the
// tailnet policy the R1 needs. Every program runs from an args array through the injectable
// `run` / `spawnLogin`; tests fake them and never touch the real client or network.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { killTree, spawn, which } = require('./cli');
const { runProcess } = require('./adb-secret');
const { authenticode } = require('./platform-tools');

const TAILSCALE_EXE = 'C:\\Program Files\\Tailscale\\tailscale.exe';
const PKGS_URL = 'https://pkgs.tailscale.com/stable/';
const PKGS_JSON_URL = `${PKGS_URL}?mode=json`;
const MSI_NAME_RE = /^tailscale-setup-\d+(?:\.\d+){1,3}-amd64\.msi$/;
const SIGNER_RE = /Tailscale Inc\./;
const MAX_MSI_BYTES = 400 * 1024 * 1024;
const STATUS_TIMEOUT_MS = 15_000;
const SERVE_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const LOGIN_URL_WAIT_MS = 30_000;
const LOGIN_KEEP_MS = 10 * 60_000;
const VERIFY_TIMEOUT_MS = 10_000;
const R1_TAG = 'tag:r1cord';
const SERVER_TAG = 'tag:r1cord-server';

class TailscaleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TailscaleError';
  }
}

/**
 * `tailscale serve` stopped to ask for Serve/HTTPS to be enabled on the tailnet. `url` is the
 * login.tailscale.com page where the tailnet admin approves it; Share /v1 again afterwards.
 */
class ServeConsentError extends TailscaleError {
  constructor(url) {
    super(`Serve is not enabled on your tailnet yet. Approve it at ${url}, then share /v1 again.`);
    this.name = 'ServeConsentError';
    this.needsConsent = true;
    this.url = url;
  }
}

// The approval page `tailscale serve` prints (and then waits on) when Serve/HTTPS is off.
const CONSENT_URL_RE = /https:\/\/login\.tailscale\.com\/[^\s"'<>]+/;

/** The consent URL in `text`, once it is complete (whitespace after it, or `ended`). */
function consentUrl(text, ended = false) {
  const match = CONSENT_URL_RE.exec(text);
  if (!match) return null;
  if (!ended && match.index + match[0].length >= text.length) return null;
  try {
    const url = new URL(match[0]);
    return url.protocol === 'https:' && url.hostname === 'login.tailscale.com' ? url.href : null;
  } catch (_error) {
    return null;
  }
}

function systemProgram(...parts) {
  return path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', ...parts);
}

function stripDot(name) {
  return String(name || '').replace(/\.$/, '');
}

function list(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

function peerView(node) {
  return {
    id: String(node.ID || ''),
    hostName: String(node.HostName || ''),
    dnsName: stripDot(node.DNSName),
    ips: list(node.TailscaleIPs),
    tags: list(node.Tags),
    online: node.Online === true,
    os: String(node.OS || ''),
  };
}

/**
 * `tailscale status --json` as the Setup page needs it.
 * @param {object} json parsed output
 */
function parseStatus(json) {
  const self = (json && json.Self) || {};
  const backendState = String((json && json.BackendState) || '');
  const peers = Object.values((json && json.Peer) || {}).map(peerView);
  const tailnet = (json && json.CurrentTailnet) || {};
  return {
    installed: true,
    running: backendState === 'Running',
    backendState,
    dnsName: stripDot(self.DNSName),
    hostName: String(self.HostName || ''),
    tailscaleIPs: list(json && json.TailscaleIPs).length ? list(json.TailscaleIPs) : list(self.TailscaleIPs),
    tags: list(self.Tags),
    magicDnsSuffix: stripDot(json.MagicDNSSuffix || tailnet.MagicDNSSuffix || ''),
    tailnetName: String(tailnet.Name || ''),
    keyExpiry: self.KeyExpiry ? String(self.KeyExpiry) : null,
    peers,
    error: null,
  };
}

function notInstalled() {
  return {
    installed: false,
    running: false,
    backendState: '',
    dnsName: '',
    hostName: '',
    tailscaleIPs: [],
    tags: [],
    magicDnsSuffix: '',
    tailnetName: '',
    keyExpiry: null,
    peers: [],
    error: null,
  };
}

function checkPort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new TailscaleError(`invalid port ${port}`);
  return n;
}

function checkDnsName(dnsName) {
  const name = stripDot(dnsName).toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name)) throw new TailscaleError(`invalid tailnet DNS name ${dnsName}`);
  return name;
}

/** argv tail for sharing the API-only listener at https://<pc>/v1 on the tailnet only. */
function serveArgs(apiPort) {
  return ['serve', '--bg', '--yes', '--set-path', '/v1', `http://127.0.0.1:${checkPort(apiPort)}/v1`];
}

function serveOffArgs() {
  return ['serve', '--https=443', '--set-path', '/v1', 'off'];
}

/** The amd64 MSI file name from pkgs.tailscale.com's `?mode=json` listing. */
function pickMsi(listing) {
  const name = listing && listing.MSIs && listing.MSIs.amd64;
  if (typeof name !== 'string' || !MSI_NAME_RE.test(name)) {
    throw new TailscaleError('pkgs.tailscale.com did not list an amd64 Windows MSI');
  }
  return name;
}

function parseSha256File(text) {
  const match = /\b([0-9a-fA-F]{64})\b/.exec(String(text || ''));
  if (!match) throw new TailscaleError('the published .sha256 file has no SHA-256');
  return match[1].toLowerCase();
}

// --- Serve verification ----------------------------------------------------------------------------

// Paths that must never reach the admin through the tailnet. The raw forms are sent verbatim
// (not normalised by a URL parser) so Serve's own path handling is what gets tested.
const ADMIN_PROBES = ['/admin', '/static/app.css', '/static/admin.css', '/v1/../admin', '/v1/%2e%2e/admin'];
// Network errors that mean the path reached nothing at all. Anything else (a timeout, a reset
// mid-answer) is no proof that the path is unpublished.
const UNREACHED_RE = /\b(ECONNREFUSED|EHOSTUNREACH|ENETUNREACH)\b/;

function r1cordUnauthorized(response) {
  if (response.status !== 401) return false;
  if (!String(response.contentType || '').toLowerCase().includes('application/json')) return false;
  try {
    const body = JSON.parse(String(response.body || ''));
    return body && body.error === 'unauthorized';
  } catch (_error) {
    return false;
  }
}

/**
 * Classify the Serve probes: `/v1/recordings` must be R1CORD's 401 JSON; every admin probe must be
 * a 404 or reach nothing (connection refused / no route). Any other answer — including a 401 or
 * 403 from R1CORD's own admin guard — means the path is mapped to something and counts as published.
 * @param {{path: string, response: object|null, error?: string, code?: string|null}[]} results
 */
function classifyServe(results) {
  const checks = results.map(({ path: probePath, response, error, code }) => {
    const status = response ? response.status : null;
    if (probePath === '/v1/recordings') {
      const pass = Boolean(response) && r1cordUnauthorized(response);
      return { path: probePath, status, expected: '401 JSON from R1CORD', pass, detail: error || (pass ? 'ok' : `got ${status ?? 'no response'}`) };
    }
    if (!response) {
      const pass = UNREACHED_RE.test(String(code || '')) || UNREACHED_RE.test(String(error || ''));
      return { path: probePath, status, expected: '404 or unreachable', pass, detail: pass ? `not published (${error})` : `no clear answer (${error || 'no response'})` };
    }
    const pass = status === 404;
    return { path: probePath, status, expected: '404 or unreachable', pass, detail: pass ? 'not published' : `HTTP ${status}: something answers on this path` };
  });
  return { ok: checks.every((c) => c.pass), checks };
}

function sameApiTarget(proxy, apiPort) {
  let url;
  try {
    url = new URL(String(proxy));
  } catch (_error) {
    return false;
  }
  return (
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
    Number(url.port) === apiPort &&
    /^\/v1\/?$/.test(url.pathname) &&
    !url.search
  );
}

/**
 * The `tailscale serve status --json` check: `https://<host>/v1` must proxy to the API-only
 * listener on `apiPort` (never the admin port).
 * @param {object|null} serveConfig parsed ServeConfig, or null when it could not be read
 * @param {string} host checked DNS name
 * @param {number} apiPort
 * @param {string} [error] why it could not be read
 */
function serveTargetCheck(serveConfig, host, apiPort, error) {
  const expected = `proxy to http://127.0.0.1:${apiPort}/v1`;
  const base = { path: 'tailscale serve /v1', status: null, expected };
  if (!serveConfig) return { ...base, pass: false, detail: `could not read tailscale serve status${error ? `: ${error}` : ''}` };
  const web = isPlainObject(serveConfig.Web) ? serveConfig.Web : {};
  const key = Object.keys(web).find((k) => k.toLowerCase() === `${host}:443`);
  const handlers = key && isPlainObject(web[key]) && isPlainObject(web[key].Handlers) ? web[key].Handlers : {};
  const handler = handlers['/v1'] || handlers['/v1/'];
  const proxy = handler && typeof handler.Proxy === 'string' ? handler.Proxy : '';
  if (!proxy) return { ...base, pass: false, detail: `/v1 is not shared on ${host}:443` };
  if (!sameApiTarget(proxy, apiPort)) return { ...base, pass: false, detail: `/v1 goes to ${proxy}, not the API listener on port ${apiPort}` };
  return { ...base, pass: true, detail: 'ok' };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** GET https://<host><rawPath> with the path sent exactly as given. */
function rawGet(host, rawPath, { timeoutMs = VERIFY_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, servername: host, port: 443, path: rawPath, method: 'GET', timeout: timeoutMs }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 65536) chunks.push(chunk);
      });
      res.on('end', () =>
        resolve({ status: res.statusCode, contentType: String(res.headers['content-type'] || ''), body: Buffer.concat(chunks).toString('utf8') }),
      );
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}

// --- policy ------------------------------------------------------------------------------------------

// Stand-in for "another tailnet device" in the deny tests when the page knows of none.
const PLACEHOLDER_OTHER_HOST = '100.64.0.2';

/**
 * The entire tailnet policy for R1s, and how to apply it. `otherHostIp` (the tailnet IPv4 of a
 * real device that is neither this PC nor an R1) makes the deny tests check a real address.
 * @param {{otherHostIp?: string|null}} [options]
 */
function policySnippet({ otherHostIp = null } = {}) {
  const policy = {
    tagOwners: {
      [R1_TAG]: ['autogroup:admin'],
      [SERVER_TAG]: ['autogroup:admin'],
    },
    hosts: {
      'other-host': otherHostIp || PLACEHOLDER_OTHER_HOST,
    },
    acls: [],
    grants: [
      { src: ['autogroup:member'], dst: ['*'], ip: ['*'] },
      { src: [R1_TAG], dst: [SERVER_TAG], ip: ['tcp:443'] },
    ],
    // A new tailnet's default policy has these two; replacing the whole policy must not silently
    // drop Tailscale SSH (check mode) or the Funnel permission.
    ssh: [{ action: 'check', src: ['autogroup:member'], dst: ['autogroup:self'], users: ['autogroup:nonroot', 'root'] }],
    nodeAttrs: [{ target: ['autogroup:member'], attr: ['funnel'] }],
    tests: [
      {
        src: R1_TAG,
        proto: 'tcp',
        accept: [`${SERVER_TAG}:443`],
        deny: [`${SERVER_TAG}:22`, `${SERVER_TAG}:8765`, `${SERVER_TAG}:8766`, 'other-host:443', 'other-host:445'],
      },
    ],
  };
  const instructions = 'Admin console → Access controls → replace everything → Save';
  const notes = [
    'This is the whole policy, not a rule to add: an allow-all rule left beside it would let an R1 reach every device.',
    'It keeps the default Tailscale SSH rule and the Funnel node attribute; merge in anything else you added yourself.',
    otherHostIp
      ? `"other-host" is ${otherHostIp}, another device on your tailnet; Save runs the tests and refuses the policy if an R1 could reach it.`
      : 'Save runs the "tests" block and refuses the policy if an R1 could reach more than this PC on TCP 443.',
  ];
  return { policy, json: JSON.stringify(policy, null, 2), instructions, notes };
}

// --- the client ---------------------------------------------------------------------------------------

/**
 * @param {{run?: Function, spawnLogin?: Function, spawnServe?: Function, killProcess?: Function,
 *   fetch?: Function, httpGet?: Function, verifySignature?: Function|null, exe?: string|null,
 *   log?: Function, createServer?: Function}} [deps]
 */
function createTailscale({
  run = runProcess,
  spawnLogin = (argv) => spawn(argv, { stdio: ['ignore', 'pipe', 'pipe'] }),
  spawnServe = (argv) => spawn(argv, { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] }),
  killProcess = killTree,
  fetch = (...args) => globalThis.fetch(...args),
  httpGet = rawGet,
  verifySignature = process.platform === 'win32' ? authenticode : null,
  exe = null,
  log = () => {},
  createServer = (handler) => net.createServer(handler),
} = {}) {
  let install = null;
  let lastInstall = null;

  function locate() {
    if (exe) return exe;
    try {
      if (fs.statSync(TAILSCALE_EXE).isFile()) return TAILSCALE_EXE;
    } catch (_error) {
      // not in the default folder
    }
    return which('tailscale') || null;
  }

  async function cli(args, timeoutMs = SERVE_TIMEOUT_MS) {
    const program = locate();
    if (!program) throw new TailscaleError('Tailscale is not installed on this PC');
    return run([program, ...args], { timeoutMs });
  }

  async function status() {
    const program = locate();
    if (!program) return notInstalled();
    let result;
    try {
      result = await run([program, 'status', '--json'], { timeoutMs: STATUS_TIMEOUT_MS });
    } catch (error) {
      return { ...notInstalled(), installed: true, error: String(error.message || error) };
    }
    try {
      return parseStatus(JSON.parse(result.stdout));
    } catch (_error) {
      const text = (result.stderr || result.stdout || '').trim().split(/\r?\n/)[0] || `exit ${result.code}`;
      return { ...notInstalled(), installed: true, error: text };
    }
  }

  /**
   * Run `tailscale serve` for /v1 while watching its output. When Serve is not enabled on the
   * tailnet the CLI prints a login.tailscale.com approval URL and waits forever; the process tree
   * is killed at once and ServeConsentError carries the URL.
   */
  async function enableServe(apiPort) {
    const args = serveArgs(apiPort);
    const program = locate();
    if (!program) throw new TailscaleError('Tailscale is not installed on this PC');
    const child = spawnServe([program, ...args]);
    const result = await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        killProcess(child);
        settle(reject, new TailscaleError(`${path.basename(program)} did not finish within ${Math.round(SERVE_TIMEOUT_MS / 1000)} s`));
      }, SERVE_TIMEOUT_MS);
      function settle(fn, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      }
      // Serve waits on the approval page forever: stop it as soon as the URL is complete.
      function consent(ended) {
        if (settled) return true;
        const url = consentUrl(stdout, ended) || consentUrl(stderr, ended);
        if (!url) return false;
        if (!ended) killProcess(child);
        log(`tailscale: Serve needs approval on the tailnet: ${url}`);
        settle(reject, new ServeConsentError(url));
        return true;
      }
      const collect = (append) => (chunk) => {
        append(chunk.toString('utf8'));
        consent(false);
      };
      if (child.stdout) child.stdout.on('data', collect((text) => (stdout += text)));
      if (child.stderr) child.stderr.on('data', collect((text) => (stderr += text)));
      child.on('error', (error) => settle(reject, new TailscaleError(`tailscale serve: ${error.message}`)));
      child.on('close', (code) => {
        if (consent(true)) return;
        settle(resolve, { code, stdout, stderr });
      });
    });
    if (result.code !== 0) throw new TailscaleError(`tailscale serve failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
    log(`tailscale: sharing /v1 → 127.0.0.1:${apiPort}`);
  }

  async function disableServe() {
    const result = await cli(serveOffArgs());
    if (result.code !== 0) throw new TailscaleError(`tailscale serve off failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
    log('tailscale: /v1 no longer shared');
  }

  /**
   * Check from the outside what Serve publishes at https://<dnsName>. With `apiPort`, also read
   * `tailscale serve status --json` and require /v1 to proxy to that API-only listener.
   * @param {string} dnsName
   * @param {{apiPort?: number|null}} [options]
   */
  async function verifyServe(dnsName, { apiPort = null } = {}) {
    const host = checkDnsName(dnsName);
    const port = apiPort === null || apiPort === undefined ? null : checkPort(apiPort);
    const results = [];
    for (const probePath of ['/v1/recordings', ...ADMIN_PROBES]) {
      try {
        results.push({ path: probePath, response: await httpGet(host, probePath) });
      } catch (error) {
        results.push({ path: probePath, response: null, error: `no response: ${error.message || error}`, code: error.code || null });
      }
    }
    const verdict = classifyServe(results);
    if (port === null) return verdict;
    let serveConfig = null;
    let readError = '';
    try {
      const result = await cli(['serve', 'status', '--json'], STATUS_TIMEOUT_MS);
      if (result.code !== 0) readError = (result.stderr || result.stdout || '').trim().split(/\r?\n/)[0] || `exit ${result.code}`;
      else serveConfig = JSON.parse(String(result.stdout || '').trim() || '{}');
    } catch (error) {
      readError = String(error.message || error);
    }
    const target = serveTargetCheck(serveConfig, host, port, readError);
    return { ok: verdict.ok && target.pass, checks: [...verdict.checks, target], dnsName: host, apiPort: port };
  }

  /**
   * `tailscale login`: resolves the https sign-in URL it prints (the page opens it), or
   * {url: null} when it finished without one (already signed in). The process stays up until the
   * browser sign-in completes, at most ten minutes.
   */
  async function login() {
    const program = locate();
    if (!program) throw new TailscaleError('Tailscale is not installed on this PC');
    const child = spawnLogin([program, 'login']);
    return new Promise((resolve, reject) => {
      let text = '';
      let settled = false;
      const keep = setTimeout(() => killTree(child), LOGIN_KEEP_MS);
      if (typeof keep.unref === 'function') keep.unref();
      const wait = setTimeout(() => {
        killTree(child);
        settle(reject, new TailscaleError('tailscale login printed no sign-in URL'));
      }, LOGIN_URL_WAIT_MS);
      function settle(fn, value) {
        if (settled) return;
        settled = true;
        clearTimeout(wait);
        fn(value);
      }
      const onData = (chunk) => {
        text += chunk.toString('utf8');
        const match = /https:\/\/[^\s"'<>]+/.exec(text);
        if (!match) return;
        let url;
        try {
          url = new URL(match[0]);
        } catch (_error) {
          return;
        }
        if (url.protocol === 'https:') settle(resolve, { url: url.href });
      };
      if (child.stdout) child.stdout.on('data', onData);
      if (child.stderr) child.stderr.on('data', onData);
      child.on('error', (error) => settle(reject, new TailscaleError(`tailscale login: ${error.message}`)));
      child.on('close', (code) => {
        clearTimeout(keep);
        if (code === 0) settle(resolve, { url: null });
        else settle(reject, new TailscaleError(`tailscale login exited ${code}: ${text.trim().slice(0, 300)}`));
      });
    });
  }

  // MSI install ---------------------------------------------------------------------------------------

  async function download(url, file, progress) {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new TailscaleError(`download failed: HTTP ${response.status} for ${url}`);
    progress.total = Number(response.headers.get('content-length')) || 0;
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'w');
    try {
      for await (const chunk of response.body) {
        progress.received += chunk.length;
        if (progress.received > MAX_MSI_BYTES) throw new TailscaleError('the MSI download is unexpectedly large');
        hash.update(chunk);
        fs.writeSync(fd, chunk);
      }
    } finally {
      fs.closeSync(fd);
    }
    if (progress.total && progress.received !== progress.total) {
      throw new TailscaleError(`the MSI download ended at ${progress.received} of ${progress.total} bytes`);
    }
    return hash.digest('hex');
  }

  async function fetchText(url) {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new TailscaleError(`HTTP ${response.status} for ${url}`);
    return response.text();
  }

  async function runMsiexec(msi) {
    // The path travels in an environment variable so nothing is spliced into the script text.
    const script = [
      '$ErrorActionPreference = "Stop"',
      `$p = Start-Process -FilePath '${systemProgram('msiexec.exe').replace(/'/g, "''")}' -ArgumentList ('/i "{0}" /passive /norestart' -f $env:R1CORD_TAILSCALE_MSI) -Verb RunAs -Wait -PassThru`,
      'exit $p.ExitCode',
    ].join('\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const env = { ...process.env, R1CORD_TAILSCALE_MSI: msi };
    const powershell = systemProgram('WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = await run([powershell, '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      timeoutMs: INSTALL_TIMEOUT_MS,
      env,
    });
    if (result.code === 0 || result.code === 3010) return;
    if (result.code === 1602 || /cancel/i.test(result.stderr)) throw new TailscaleError('the Tailscale install was cancelled');
    throw new TailscaleError(`msiexec exited ${result.code}: ${(result.stderr || '').trim().slice(0, 300)}`);
  }

  /**
   * Download, verify and install the official MSI. Refuses without explicit consent.
   * @param {{consent: boolean, dir: string}} options dir: where the download is kept until installed
   */
  async function installMsi({ consent = false, dir } = {}) {
    if (consent !== true) throw new TailscaleError('installing Tailscale needs your explicit consent');
    if (install) throw new TailscaleError('a Tailscale install is already running');
    const progress = { phase: 'checking', received: 0, total: 0, version: '' };
    install = progress;
    lastInstall = null;
    let partial = null;
    let msi = null;
    try {
      const listing = JSON.parse(await fetchText(PKGS_JSON_URL));
      const name = pickMsi(listing);
      progress.version = String(listing.MSIsVersion || name.replace(/^tailscale-setup-|-amd64\.msi$/g, ''));
      const expected = parseSha256File(await fetchText(`${PKGS_URL}${name}.sha256`));
      fs.mkdirSync(dir, { recursive: true });
      msi = path.join(dir, name);
      partial = `${msi}.partial`;
      progress.phase = 'downloading';
      log(`tailscale: downloading ${name}`);
      const actual = await download(`${PKGS_URL}${name}`, partial, progress);
      if (actual !== expected) throw new TailscaleError(`the MSI's SHA-256 ${actual} does not match the published ${expected}; nothing was installed`);
      fs.renameSync(partial, msi);
      partial = null;
      progress.phase = 'verifying';
      if (!verifySignature) throw new TailscaleError('Authenticode verification is only available on Windows; nothing was installed');
      const sig = await verifySignature(msi);
      const sigStatus = sig ? String(sig.status || '') : 'missing';
      const subject = (sig && String(sig.subject || '')) || '';
      if (sigStatus !== 'Valid' || !SIGNER_RE.test(subject)) {
        throw new TailscaleError(`the MSI is not validly signed by Tailscale Inc. (signature ${sigStatus}, signer ${subject || 'none'}); nothing was installed`);
      }
      progress.phase = 'installing';
      log(`tailscale: installing ${name} (UAC prompt)`);
      await runMsiexec(msi);
      lastInstall = { ok: true, version: progress.version };
      log(`tailscale: installed ${progress.version}`);
      return lastInstall;
    } catch (error) {
      lastInstall = { ok: false, error: String(error.message || error) };
      throw error;
    } finally {
      install = null;
      for (const leftover of [partial, msi]) {
        if (leftover) fs.rmSync(leftover, { force: true });
      }
    }
  }

  function installSnapshot() {
    return {
      active: install !== null,
      phase: install ? install.phase : '',
      received: install ? install.received : 0,
      total: install ? install.total : 0,
      error: lastInstall && !lastInstall.ok ? lastInstall.error : '',
      done: lastInstall && lastInstall.ok ? lastInstall.version : '',
    };
  }

  /**
   * Run `fn(port)` while a loopback listener is published on the tailnet at TCP <port> through a
   * temporary `tailscale serve --tcp`. The policy must keep an R1 from reaching it; `connections`
   * counts what actually arrived. Always removed again.
   * @returns {Promise<{result: any, port: number, connections: number}>}
   */
  async function probeListener(fn) {
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    let served = false;
    try {
      const result = await cli(['serve', '--bg', '--yes', '--tcp', String(port), `tcp://127.0.0.1:${port}`]);
      if (result.code !== 0) throw new TailscaleError(`could not publish the probe port: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
      served = true;
      const value = await fn(port);
      return { result: value, port, connections };
    } finally {
      if (served) {
        try {
          await cli(['serve', '--tcp', String(port), 'off']);
        } catch (error) {
          log(`tailscale: could not remove the probe port ${port}: ${error.message || error}`);
        }
      }
      await new Promise((resolve) => server.close(() => resolve()));
    }
  }

  return {
    locate,
    status,
    enableServe,
    disableServe,
    verifyServe,
    login,
    installMsi,
    installSnapshot,
    probeListener,
    policySnippet,
  };
}

module.exports = {
  PKGS_JSON_URL,
  R1_TAG,
  SERVER_TAG,
  TAILSCALE_EXE,
  TailscaleError,
  ServeConsentError,
  classifyServe,
  createTailscale,
  parseSha256File,
  parseStatus,
  pickMsi,
  policySnippet,
  rawGet,
  serveArgs,
  serveOffArgs,
};
