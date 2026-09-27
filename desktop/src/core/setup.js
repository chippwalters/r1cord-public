// "Set up R1": one idempotent USB run for one adopted serial. It checks the device is the Rabbit R1
// build this release targets, checks from the tailnet that this PC shares only /v1 of its API-only
// listener, holds R1CORD's maintenance gate when the installed app has one (an R1CORD older than
// the gate, or none at all, is simply installed like any other APK), installs R1CORD, the
// device-controls helper and Tailscale from verified APKs (bundled or cached; the release server is
// contacted only when the owner ticks the download box), grants what the recorder and VPN need,
// signs Tailscale in with a one-use auth key typed over adb stdin, pairs the app with this PC's
// tailnet URL, proves by a nonce which tailnet peer the USB-attached R1 is, and runs an isolation
// self-test (this PC's 443 open, a test port on this PC and 443 on another tailnet device closed).
// Ready needs every step, a passing /v1 check, the owner's confirmation that the tailnet policy was
// replaced, and an isolation pass; a Ready run is stamped on the R1's saved record.
// Every step ends done | skipped | failed: reason; a failed step stops the run; END_MAINTENANCE
// always runs last. Progress is plain JSON for the page to poll and never holds a key or token.
// The USB watcher is suspended for the whole run so its reverse/pull passes cannot interleave.
//
// R1 app updates (r1_auto_update) reuse the same pieces: checkForUpdate compares what the R1 runs
// with the newest verified APKs on this PC, installUpdates runs only the identity, maintenance and
// install steps (maintenance only when the installed R1CORD has the gate).

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const adbSecret = require('./adb-secret');
const { hashToken } = require('./store');
const { R1_TAG, SERVER_TAG } = require('./tailscale');

const R1CORD_PACKAGE = 'com.chippwalters.r1cord';
const CONTROLS_PACKAGE = 'com.chippwalters.r1cord.controls';
const TAILSCALE_PACKAGE = 'com.tailscale.ipn';
const R1_PRODUCT_NAME = 'gsi_r1';
// The R1 reports `ro.product.model` as "Rabbit R1"; `adb devices -l` shows it as "Rabbit_R1"
// because adb replaces spaces, so accept either spelling.
const R1_PRODUCT_MODELS = new Set(['Rabbit R1', 'Rabbit_R1']);

/** True when getprop's (trimmed) name/model are the Rabbit R1 build this release targets. */
function isR1Build(name, model) {
  return String(name).trim() === R1_PRODUCT_NAME && R1_PRODUCT_MODELS.has(String(model).trim());
}

// First R1CORD versionCode with the SetupProvider maintenance gate.
const MAINTENANCE_MIN_VERSION = 17;
const RECORDS_FILE = 'r1-setup.json';
const UI_DUMP = '/data/local/tmp/r1cord-ui.xml';
const SHELL_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const PEER_WAIT_MS = 120_000;
const POLL_MS = 3_000;
const UI_SETTLE_MS = 1_500;
const MAX_UI_STEPS = 20;

const APKS = Object.freeze([
  { entry: 'r1cord', package: R1CORD_PACKAGE, label: 'R1CORD', name: 'R1CORD' },
  { entry: 'controls', package: CONTROLS_PACKAGE, label: 'the device-controls helper', name: 'R1CORD device controls' },
  { entry: 'tailscale', package: TAILSCALE_PACKAGE, label: 'Tailscale', name: 'Tailscale' },
]);

// The Set up R1 form's two owner checkboxes; the page and the step messages quote them.
const DOWNLOAD_LABEL = 'Download missing or newer apps from the R1CORD release server';
const POLICY_LABEL = 'I replaced the tailnet policy with the R1CORD policy (no allow-all rule)';
const NO_OTHER_PEER = 'No other tailnet device to test against — isolation not proven.';
// Verified APKs on this PC change only when something downloads one; the Setup page asks often.
const LOCAL_APKS_TTL_MS = 60_000;

const STEPS = Object.freeze([
  ['identity', 'Check this is the Rabbit R1'],
  ['pc', 'This PC on the tailnet'],
  ['maintenance', 'Pause recording and uploads'],
  ['install-r1cord', 'Install R1CORD'],
  ['install-controls', 'Install the device-controls helper'],
  ['install-tailscale', 'Install Tailscale'],
  ['grants', 'Permissions and HOME app'],
  ['tailscale-login', 'Sign the R1 in to Tailscale'],
  ['always-on', 'Always-on VPN'],
  ['provision', 'Pair the R1 with this PC'],
  ['peer', 'Confirm the R1 on the tailnet'],
  ['isolation', 'Tailnet isolation self-test'],
  ['finish', 'Leave maintenance'],
]);

// Tailscale 1.102.4's screens on the way to the auth-key form, as observed on the R1. Labels are
// matched exactly against a node's text or content-desc.
const ACCOUNTS_SCREEN_LABELS = Object.freeze(['Add another account', 'Reauthenticate', 'Delete tailnet']);

class SetupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SetupError';
  }
}

function fail(message) {
  return new SetupError(message);
}

const done = (detail = '') => ({ status: 'done', detail });
const skipped = (detail = '') => ({ status: 'skipped', detail });

function errorMessage(error) {
  return adbSecret.redact(String((error && error.message) || error || 'failed'));
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The port the API-only listener actually bound (index.js), else the configured one before it has. */
function apiPortOf(state) {
  return state.apiPort ?? state.config.api_port;
}

// --- verified-peer records (no secrets) ------------------------------------------------------------

function recordsPath(configDir) {
  return path.join(configDir, RECORDS_FILE);
}

function readRecords(configDir) {
  try {
    const data = JSON.parse(fs.readFileSync(recordsPath(configDir), 'utf8'));
    return data && typeof data.devices === 'object' && data.devices ? data.devices : {};
  } catch (_error) {
    return {};
  }
}

function writeRecord(configDir, serial, record) {
  const devices = { ...readRecords(configDir), [serial]: record };
  const file = recordsPath(configDir);
  fs.mkdirSync(configDir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, devices }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

// --- pure helpers ---------------------------------------------------------------------------------

function decodeXml(text) {
  return String(text)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

/** `uiautomator dump` XML → [{text, desc, hint, cls, clickable, bounds: [x1,y1,x2,y2]}]. */
function parseUiNodes(xml) {
  const nodes = [];
  for (const match of String(xml || '').matchAll(/<node\b([^>]*?)\/?>/g)) {
    const attrs = {};
    for (const attr of match[1].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[attr[1]] = decodeXml(attr[2]);
    const b = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(attrs.bounds || '');
    if (!b) continue;
    nodes.push({
      text: (attrs.text || '').trim(),
      desc: (attrs['content-desc'] || '').trim(),
      hint: (attrs.hint || '').trim(),
      cls: attrs.class || '',
      clickable: attrs.clickable === 'true',
      bounds: [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])],
    });
  }
  return nodes;
}

function center(node) {
  const [x1, y1, x2, y2] = node.bounds;
  return [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)];
}

function labelOf(node) {
  return node.text || node.desc;
}

function hasLabel(node, label) {
  return node.text === label || node.desc === label;
}

function findLabel(nodes, label) {
  return nodes.find((n) => hasLabel(n, label)) || null;
}

/** The first `count` visible labels of a screen, for error messages. */
function screenLabels(nodes, count = 3) {
  return nodes.map(labelOf).filter(Boolean).slice(0, count);
}

/**
 * One step of the walk to Tailscale's auth-key form from this screen:
 * {form: {field, confirm}} on the form itself, {tap: [x, y], screen} to move one screen closer,
 * or null on a screen the walk does not know (still loading, asleep, or something else).
 */
function nextAuthKeyStep(nodes) {
  const field = nodes.find((n) => /EditText/.test(n.cls));
  const confirm = findLabel(nodes, 'Add account');
  if (field && confirm) return { form: { field: center(field), confirm: center(confirm) } };
  const route = [
    ['menu', 'Use an auth key', () => true],
    ['accounts', 'menu', () => ACCOUNTS_SCREEN_LABELS.some((label) => findLabel(nodes, label))],
    ['settings', 'Accounts', () => true],
    ['main', 'Open settings', () => true],
    ['first run', 'Get Started', () => true],
  ];
  for (const [screen, label, applies] of route) {
    const node = findLabel(nodes, label);
    if (node && applies()) return { tap: center(node), screen };
  }
  return null;
}

function ipv4Tailnet(ip) {
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(String(ip));
  return Boolean(m) && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

function firstForwarded(value) {
  const first = String(value || '').split(',')[0].trim().replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '');
  return first || null;
}

/**
 * PROBE results → pass | fail | inconclusive. TCP 443 must be open; the temporary probe port
 * (which really has a listener behind Serve) must be closed or time out, and nothing may arrive.
 */
function classifyIsolation(results, probePort, connections = 0) {
  const r = results || {};
  const other = r[String(probePort)];
  const https = r['443'];
  if (connections > 0 || other === 'open') {
    return { result: 'fail', detail: `the R1 reached test port ${probePort} on this PC; the tailnet policy lets it past TCP 443` };
  }
  if (https !== 'open') return { result: 'inconclusive', detail: `TCP 443 on this PC was ${https || 'not checked'} from the R1` };
  if (other === 'closed' || other === 'timeout') return { result: 'pass', detail: `443 open, test port ${probePort} ${other}` };
  return { result: 'inconclusive', detail: `test port ${probePort} was ${other || 'not checked'}` };
}

/**
 * The tailnet device the R1 must NOT reach on 443: online, with a tailnet IPv4, not this PC, not
 * an R1 (tag:r1cord) and not a server the policy deliberately allows (tag:r1cord-server).
 * Untagged devices (people's own machines, a NAS) first. Null when there is none.
 */
function pickOtherPeer(peers, pcIps = []) {
  const own = new Set(pcIps);
  const candidates = (peers || []).filter(
    (p) => p.online && !p.tags.includes(R1_TAG) && !p.tags.includes(SERVER_TAG) && !p.ips.some((ip) => own.has(ip)) && p.ips.some(ipv4Tailnet),
  );
  candidates.sort((a, b) => a.tags.length - b.tags.length);
  const peer = candidates[0];
  return peer ? { peer, ip: peer.ips.find(ipv4Tailnet) } : null;
}

/**
 * Ready, or the first reason it is not: every step done or skipped, a passing /v1 check of this
 * PC's current name and API port in this run, the owner's policy confirmation and an isolation pass.
 */
function readiness(run, pcDnsName) {
  if (!run.steps.every((s) => s.status === 'done' || s.status === 'skipped')) {
    return { ready: false, reason: run.error || 'setup did not finish' };
  }
  const serve = run.serve;
  if (!serve || serve.ok !== true || !pcDnsName || serve.dnsName !== pcDnsName) {
    return { ready: false, reason: 'the /v1 share of this PC was not verified from the tailnet in this run' };
  }
  if (!run.policyConfirmed) return { ready: false, reason: `tick “${POLICY_LABEL}” once you have, and run setup again` };
  if (run.isolation !== 'pass') {
    return { ready: false, reason: `tailnet isolation ${run.isolation || 'not tested'}${run.isolationDetail ? `: ${run.isolationDetail}` : ''}` };
  }
  return { ready: true, reason: '' };
}

// --- device access ---------------------------------------------------------------------------------

class Device {
  constructor(adb, serial, run, log) {
    this.adb = adb;
    this.serial = serial;
    this._run = run;
    this._log = log;
  }

  /** One script for the device's sh. Only fixed text or values passed through shellQuote. */
  async raw(script, timeoutMs = SHELL_TIMEOUT_MS) {
    return this._run([this.adb, '-s', this.serial, 'shell', script], { timeoutMs });
  }

  async sh(script, timeoutMs = SHELL_TIMEOUT_MS) {
    const result = await this.raw(script, timeoutMs);
    const text = `${result.stdout}${result.stderr}`.trim();
    if (result.code !== 0 || /^(Error|Exception|Failure)\b|Exception:/m.test(text)) {
      throw fail(`${script.split(' ').slice(0, 2).join(' ').replace(/'/g, '')} failed${text ? `: ${text.split(/\r?\n/)[0]}` : ` (exit ${result.code})`}`);
    }
    return result.stdout;
  }

  async cmd(words, timeoutMs) {
    return this.sh(words.map(adbSecret.shellQuote).join(' '), timeoutMs);
  }

  async getprop(name) {
    return (await this.cmd(['getprop', name])).trim();
  }

  /** Installed versionCode of `pkg`, or null when it is not installed. */
  async versionCode(pkg) {
    const result = await this.raw(['pm', 'list', 'packages', '--show-versioncode', pkg].map(adbSecret.shellQuote).join(' '));
    for (const line of String(result.stdout).split(/\r?\n/)) {
      const m = /^package:(\S+)\s+versionCode:(\d+)/.exec(line.trim());
      if (m && m[1] === pkg) return Number(m[2]);
    }
    return null;
  }

  /** {versionCode, versionName} of the active install of `pkg` from `dumpsys package`, or null. */
  async packageInfo(pkg) {
    const result = await this.raw(['dumpsys', 'package', pkg].map(adbSecret.shellQuote).join(' '));
    const text = String(result.stdout);
    const marker = `Package [${pkg}]`;
    const start = text.indexOf(marker);
    if (start === -1) return null;
    const rest = text.slice(start + marker.length);
    const next = rest.indexOf('Package [');
    const block = next === -1 ? rest : rest.slice(0, next);
    const code = /\bversionCode=(\d+)/.exec(block);
    if (!code) return null;
    const name = /\bversionName=(\S+)/.exec(block);
    return { versionCode: Number(code[1]), versionName: name ? name[1] : '' };
  }

  /** `adb install -r` (never -d): the combined output. */
  async install(apk) {
    this._log(`setup: adb install ${path.basename(apk)} on ${this.serial}`);
    const result = await this._run([this.adb, '-s', this.serial, 'install', '-r', apk], { timeoutMs: INSTALL_TIMEOUT_MS });
    return { code: result.code, output: `${result.stdout}\n${result.stderr}` };
  }

  async call(method, arg = null, extras = []) {
    return adbSecret.runContentCall(this.adb, this.serial, method, arg, extras, { run: this._run, log: this._log });
  }
}

// --- the run ---------------------------------------------------------------------------------------

function newRun(serial, { allowDownload = false, policyConfirmed = false } = {}) {
  return {
    serial,
    allowDownload: Boolean(allowDownload),
    policyConfirmed: Boolean(policyConfirmed),
    active: true,
    startedAt: nowIso(),
    finishedAt: null,
    steps: STEPS.map(([id, label]) => ({ id, label, status: 'pending', detail: '' })),
    serve: null,
    isolation: null,
    isolationDetail: '',
    ready: false,
    readyDetail: '',
    error: null,
    finalStatus: null,
  };
}

function publicRun(run) {
  return {
    serial: run.serial,
    allowDownload: run.allowDownload,
    policyConfirmed: run.policyConfirmed,
    active: run.active,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    steps: run.steps.map((s) => ({ ...s })),
    serve: run.serve ? { ...run.serve } : null,
    isolation: run.isolation,
    isolationDetail: run.isolationDetail,
    ready: run.ready,
    readyDetail: run.readyDetail,
    error: run.error,
    finalStatus: run.finalStatus ? { ...run.finalStatus } : null,
  };
}

/**
 * @param {{run?: Function, adbPath?: (state: object) => string|null, tailscale?: object,
 *   updates?: () => object, nonces?: () => object, sleep?: (ms: number) => Promise<void>,
 *   peerWaitMs?: number, pollMs?: number, uiSettleMs?: number, log?: Function}} [deps]
 */
function createSetupManager(deps = {}) {
  const runProcess = deps.run || adbSecret.runProcess;
  const adbPath = deps.adbPath || ((state) => require('./usb').UsbWatcher.adbPath(state.config, state.configDir));
  const tailscale = deps.tailscale || require('./tailscale').createTailscale();
  const updates = deps.updates || (() => require('./updates'));
  const nonces = deps.nonces || (() => require('./setup-nonce'));
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const peerWaitMs = deps.peerWaitMs ?? PEER_WAIT_MS;
  const pollMs = deps.pollMs ?? POLL_MS;
  const uiSettleMs = deps.uiSettleMs ?? UI_SETTLE_MS;
  const runs = new Map();
  // R1 app updates: the last check per serial, the last install result, and serials whose check
  // or install is running (a setup run and an update never overlap on one serial).
  const updateChecks = new Map();
  const updateResults = new Map();
  const updateBusy = new Set();
  let suspended = 0;
  let suspending = null;
  // The last localApks() answer: {at, value}; dropped whenever a run or an update install ends.
  let localApksCache = null;

  function logFor(state) {
    return deps.log || ((line) => state.loggers && state.loggers.app && state.loggers.app.info(line));
  }

  function resolveAdb(state) {
    try {
      return adbPath(state);
    } catch (_error) {
      return null;
    }
  }

  async function suspendUsb(state, log) {
    suspended += 1;
    const usb = state.usb;
    if (suspended === 1 && usb && typeof usb.suspend === 'function') suspending = Promise.resolve(usb.suspend('setup'));
    else if (suspended === 1) log('setup: the USB watcher has no suspend(); continuing');
    try {
      if (suspending) await suspending;
    } catch (error) {
      resumeUsb(state);
      throw fail(`could not pause the USB watcher: ${errorMessage(error)}`);
    }
  }

  function resumeUsb(state) {
    suspended -= 1;
    if (suspended > 0) return;
    suspending = null;
    if (state.usb && typeof state.usb.resume === 'function') state.usb.resume();
  }

  // Maintenance -----------------------------------------------------------------------------------

  async function beginMaintenance(ctx) {
    const status = await ctx.dev.call('STATUS');
    if (status.json.busy !== false) {
      throw fail(`R1CORD is busy (${busyText(status.json)}); try again when it is idle`);
    }
    const begin = await ctx.dev.call('BEGIN_MAINTENANCE', 'desktop-setup');
    if (!begin.ok) throw fail(`R1CORD is busy (${providerError(begin.json)}); try again when it is idle`);
    ctx.maintenance = true;
  }

  /**
   * BEGIN_MAINTENANCE when the installed R1CORD has the gate (SetupProvider). An R1CORD without it,
   * or none at all, is installed like any other APK: returns the note saying so, else null.
   */
  async function holdMaintenance(ctx) {
    const version = await ctx.dev.versionCode(R1CORD_PACKAGE);
    ctx.appVersion = version;
    if (version === null) return 'R1CORD is not installed yet, so there is nothing to pause';
    if (version < MAINTENANCE_MIN_VERSION) {
      return `R1CORD versionCode ${version} has no SetupProvider, so it was not paused; it is updated like any other app`;
    }
    await beginMaintenance(ctx);
    return null;
  }

  /** The readable part of a failed SetupProvider bundle: {error, reason?|message?}. */
  function providerError(json) {
    const code = json.error ? String(json.error) : 'refused';
    const text = json.reason || json.message;
    return text ? `${code}: ${text}` : code;
  }

  function busyText(json) {
    const parts = ['capture', 'upload', 'libraryWrite', 'maintenance'].filter((k) => json[k] === true);
    if (parts.length) return parts.join(', ');
    return json.busy === true ? 'busy' : `busy state ${JSON.stringify(json.busy ?? 'unknown')}`;
  }

  // Peer verification -----------------------------------------------------------------------------

  async function verifyPeer(ctx) {
    const { createNonce, consumeSeen } = nonces();
    const nonce = createNonce(ctx.state);
    let answer;
    try {
      answer = await ctx.dev.call('NONCE', nonce);
    } finally {
      ctx.seen = consumeSeen(ctx.state, nonce);
    }
    const seen = ctx.seen;
    if (!seen) {
      const why = answer.json.status ? `HTTP ${answer.json.status}` : answer.ok ? 'no answer' : providerError(answer.json);
      throw fail(`the R1 did not reach https://${ctx.pc.dnsName}/v1 with its token (${why})`);
    }
    const ip = firstForwarded(seen.forwardedFor);
    if (answer.json.route === 'usb' || !ip) {
      throw fail('the R1 reached this PC over USB, not over the tailnet; check Tailscale is connected on the R1');
    }
    const ts = await tailscale.status();
    const peer = ts.peers.find((p) => p.ips.includes(ip));
    if (!peer) throw fail(`the check came from ${ip}, which is not a device on this tailnet`);
    if (!peer.online || !peer.tags.includes(R1_TAG)) {
      throw fail(`${peer.dnsName || ip} answered but is not an online ${R1_TAG} device; tag the R1's auth key ${R1_TAG}`);
    }
    const record = { serial: ctx.serial, nodeId: peer.id, ip, dnsName: peer.dnsName, verifiedAt: nowIso() };
    writeRecord(ctx.state.configDir, ctx.serial, record);
    ctx.verified = { peer, ip };
    return ctx.verified;
  }

  async function tryVerifyPeer(ctx) {
    try {
      return await verifyPeer(ctx);
    } catch (error) {
      ctx.log(`setup: existing pairing not verified: ${errorMessage(error)}`);
      return null;
    }
  }

  // Tailscale UI ---------------------------------------------------------------------------------

  async function dumpUi(dev) {
    const q = adbSecret.shellQuote(UI_DUMP);
    const result = await dev.raw(`uiautomator dump ${q} >/dev/null 2>&1; cat ${q}; rm -f ${q}`);
    return String(result.stdout);
  }

  async function openTailscale(dev) {
    const out = await dev.cmd([
      'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', TAILSCALE_PACKAGE,
    ]);
    const component = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith(`${TAILSCALE_PACKAGE}/`)).pop();
    if (!component) throw fail('Tailscale on the R1 has no launcher activity');
    await dev.cmd(['am', 'start', '-n', component]);
    await sleep(uiSettleMs);
  }

  /** Wake the R1, lift the keyguard and keep the display on while on USB power (uiautomator sees nothing while it is off). */
  async function keepAwake(dev) {
    await dev.cmd(['input', 'keyevent', 'KEYCODE_WAKEUP']);
    await dev.cmd(['wm', 'dismiss-keyguard']);
    await dev.cmd(['svc', 'power', 'stayon', 'usb']);
  }

  /** Let the display sleep again; a failure here must not hide the step's own result. */
  async function releaseAwake(dev, log) {
    try {
      await dev.cmd(['svc', 'power', 'stayon', 'false']);
    } catch (error) {
      log(`setup: could not restore the R1's stay-awake setting: ${errorMessage(error)}`);
    }
  }

  /** Walk to the auth-key form, one fresh dump per screen. Dumps happen only here, before anything is typed. */
  async function findAuthKeyScreen(dev) {
    let last = [];
    for (let i = 0; i < MAX_UI_STEPS; i += 1) {
      const nodes = parseUiNodes(await dumpUi(dev));
      last = nodes;
      const step = nextAuthKeyStep(nodes);
      if (step && step.form) return step.form;
      if (step) await dev.cmd(['input', 'tap', String(step.tap[0]), String(step.tap[1])]);
      await sleep(uiSettleMs);
    }
    const labels = screenLabels(last);
    const seen = labels.length ? labels.map((l) => `“${l}”`).join(', ') : 'nothing on screen';
    throw fail(`could not find Tailscale's “Use an auth key” screen (last screen: ${seen}); sign in on the R1 by hand (Accounts → Use an auth key) and run setup again`);
  }

  /** Online Android peer that is not this R1CORD-tagged; Tailscale reports the R1 as OS "android". */
  const isAndroid = (p) => String(p.os || '').toLowerCase() === 'android';

  function untaggedFail(peer) {
    const name = peer.hostName || peer.dnsName || peer.id;
    const ip = (peer.ips || []).find(ipv4Tailnet) || (peer.ips || [])[0] || 'no tailnet IP';
    return fail(`The R1 joined your tailnet WITHOUT ${R1_TAG} (the auth key had no tag), so it can reach every device on your tailnet. In the Tailscale admin console → Machines → ${name} (${ip}) → Edit ACL tags, add ${R1_TAG}, then run setup again (no key needed).`);
  }

  /** New online tag:r1cord peers; throws at once when only a new untagged Android peer joined. */
  async function waitForNewPeers(before) {
    const deadline = Date.now() + peerWaitMs;
    for (;;) {
      const ts = await tailscale.status();
      const newOnline = ts.peers.filter((p) => p.online && !before.has(p.id));
      const fresh = newOnline.filter((p) => p.tags.includes(R1_TAG));
      if (fresh.length) return fresh;
      const untagged = newOnline.find((p) => isAndroid(p) && !p.tags.includes(R1_TAG));
      if (untagged) throw untaggedFail(untagged);
      if (Date.now() >= deadline) return [];
      await sleep(pollMs);
    }
  }

  // Steps -----------------------------------------------------------------------------------------

  /** Options for updates.newestApk: the release server only with the owner's consent. */
  function apkOptions(state, allowDownload) {
    return allowDownload
      ? { config: state.config, configDir: state.configDir, allowDownload: true }
      : { configDir: state.configDir, allowDownload: false };
  }

  /** Install one verified APK with `adb install -r` unless the R1 already has it or newer. */
  async function installCandidate(ctx, spec, candidate) {
    if (candidate.info.package !== spec.package) throw fail(`the ${spec.label} APK is package ${candidate.info.package}, not ${spec.package}`);
    const installed = await ctx.dev.versionCode(spec.package);
    if (installed !== null && installed >= candidate.info.versionCode) {
      if (spec.entry === 'r1cord') ctx.appVersion = installed;
      return skipped(`installed versionCode ${installed} is current`);
    }
    const { code, output } = await ctx.dev.install(candidate.path);
    if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(output)) {
      throw fail(
        `the ${spec.label} already on the R1 is signed with a different key. Setup stops here and will not uninstall it ` +
          '(that would erase its data); compare its signer with the release fingerprint before deciding by hand',
      );
    }
    if (code !== 0 || !/\bSuccess\b/.test(output)) {
      const line = output.split(/\r?\n/).find((l) => /Failure|Error/i.test(l)) || `exit ${code}`;
      throw fail(`adb install failed: ${line.trim()}`);
    }
    if (spec.entry === 'r1cord') {
      ctx.appVersion = candidate.info.versionCode;
      // Installing restarted the app process, which dropped any maintenance it held.
      if (ctx.appVersion >= MAINTENANCE_MIN_VERSION) await beginMaintenance(ctx);
    }
    return done(`installed ${candidate.info.versionName} (${candidate.info.versionCode})`);
  }

  const steps = {
    async identity(ctx) {
      if (!ctx.adb) throw fail('adb was not found; install the Android platform tools on the Devices page');
      const name = await ctx.dev.getprop('ro.product.name');
      const model = await ctx.dev.getprop('ro.product.model');
      if (!isR1Build(name, model)) {
        throw fail(`not the Rabbit R1 build this setup supports (ro.product.name=${name || '?'}, ro.product.model=${model || '?'}); nothing was changed`);
      }
      ctx.identified = true;
      return done(`${model} · ${name}`);
    },

    async pc(ctx) {
      const ts = await tailscale.status();
      if (!ts.installed) throw fail('Tailscale is not installed on this PC; install it under Remote access first');
      if (!ts.running || !ts.dnsName) throw fail(`Tailscale on this PC is ${ts.backendState || 'not running'}; sign it in under Remote access first`);
      if (!ctx.state.config.tailscale_serve) throw fail('turn on “Share /v1 on the tailnet” under Remote access first');
      // The saved switch is not proof: check now, from the tailnet, that https://<this name>/v1 is
      // R1CORD's API behind the API-only listener and that nothing else is published.
      const apiPort = apiPortOf(ctx.state);
      let verify;
      try {
        verify = await tailscale.verifyServe(ts.dnsName, { apiPort });
      } catch (error) {
        throw fail(`could not check https://${ts.dnsName}/v1 from the tailnet: ${errorMessage(error)}`);
      }
      ctx.run.serve = { dnsName: ts.dnsName, apiPort, ok: Boolean(verify && verify.ok === true), at: nowIso() };
      if (!ctx.run.serve.ok) {
        const bad = ((verify && verify.checks) || []).filter((c) => !c.pass).map((c) => `${c.path}: ${c.detail}`);
        throw fail(`the tailnet check of https://${ts.dnsName} failed (${bad.join('; ') || 'no result'}); fix sharing under Remote access`);
      }
      ctx.pc = ts;
      return done(`${ts.dnsName} · /v1 → API listener ${apiPort}, verified from the tailnet`);
    },

    async maintenance(ctx) {
      const note = await holdMaintenance(ctx);
      return note ? skipped(note) : done('R1CORD is in maintenance (ends by itself after 10 minutes)');
    },

    async install(ctx, spec) {
      const allow = ctx.run.allowDownload === true;
      let candidate = null;
      try {
        candidate = await updates().newestApk(spec.entry, apkOptions(ctx.state, allow));
      } catch (error) {
        // Without consent this is only "nothing bundled or cached" (no manifest was fetched).
        if (allow) throw fail(`could not get a verified ${spec.label} APK: ${errorMessage(error)}`);
      }
      if (!candidate) {
        const installed = await ctx.dev.versionCode(spec.package);
        // A pre-gate R1CORD cannot be paired by this setup, so it still needs the new APK.
        const usable = installed !== null && !(spec.entry === 'r1cord' && installed < MAINTENANCE_MIN_VERSION);
        if (usable) {
          if (spec.entry === 'r1cord') ctx.appVersion = installed;
          return skipped(`installed versionCode ${installed}; no ${allow ? 'verified' : 'bundled or cached'} APK to compare`);
        }
        if (allow) throw fail(`no verified ${spec.label} APK is available on this PC or the release server`);
        throw fail(`no verified ${spec.label} APK is bundled with R1CORD Desktop or already downloaded; tick “${DOWNLOAD_LABEL}” and run again`);
      }
      return installCandidate(ctx, spec, candidate);
    },

    async grants(ctx) {
      const commands = [
        ['pm', 'grant', R1CORD_PACKAGE, 'android.permission.RECORD_AUDIO'],
        ['pm', 'grant', R1CORD_PACKAGE, 'android.permission.CAMERA'],
        ['pm', 'grant', R1CORD_PACKAGE, 'android.permission.POST_NOTIFICATIONS'],
        ['cmd', 'package', 'set-home-activity', `${R1CORD_PACKAGE}/.MainActivity`],
        ['appops', 'set', TAILSCALE_PACKAGE, 'ACTIVATE_VPN', 'allow'],
        ['pm', 'grant', TAILSCALE_PACKAGE, 'android.permission.POST_NOTIFICATIONS'],
      ];
      for (const words of commands) await ctx.dev.cmd(words);
      return done('microphone, camera, notifications, HOME app, VPN consent');
    },

    async tailscaleLogin(ctx) {
      const record = readRecords(ctx.state.configDir)[ctx.serial];
      const ts = await tailscale.status();
      if (record && record.nodeId) {
        const peer = ts.peers.find((p) => p.id === record.nodeId);
        if (peer && peer.online && peer.tags.includes(R1_TAG)) {
          ctx.knownPeer = peer;
          return skipped(`already on the tailnet as ${peer.dnsName || peer.hostName}`);
        }
      }
      if (!ctx.key) {
        // A rerun after an earlier sign-in: the app's own pairing may already prove the peer.
        const status = await ctx.dev.call('STATUS');
        if (status.json.paired === true && status.json.vpn === 'up' && (await tryVerifyPeer(ctx))) {
          return skipped(`already on the tailnet as ${ctx.verified.peer.dnsName || ctx.verified.ip}`);
        }
        const androids = ts.peers.filter((p) => p.online && isAndroid(p));
        const tagged = androids.filter((p) => p.tags.includes(R1_TAG));
        if (tagged.length === 1) {
          ctx.knownPeer = tagged[0];
          return skipped(`already on the tailnet as ${tagged[0].dnsName || tagged[0].hostName}`);
        }
        const untagged = androids.filter((p) => !p.tags.includes(R1_TAG));
        if (!tagged.length && untagged.length === 1) throw untaggedFail(untagged[0]);
        throw fail(`paste an auth key with Tags on → ${R1_TAG} (Setup step 6) to sign the R1 in`);
      }
      const before = new Set(ts.peers.map((p) => p.id));
      try {
        await keepAwake(ctx.dev);
        await openTailscale(ctx.dev);
        const form = await findAuthKeyScreen(ctx.dev);
        await ctx.dev.cmd(['input', 'tap', String(form.field[0]), String(form.field[1])]);
        await sleep(700);
        try {
          await adbSecret.typeAuthKey(ctx.adb, ctx.serial, ctx.key, { run: runProcess, log: ctx.log });
        } finally {
          ctx.key.fill(0);
          ctx.key = null;
        }
        // No dump or screenshot from here on. Hide the keyboard (Back only closes the IME when it is
        // shown) so the confirm control is where it was found.
        const ime = await ctx.dev.raw('dumpsys input_method');
        if (/mInputShown=true/.test(ime.stdout)) {
          await ctx.dev.cmd(['input', 'keyevent', '4']);
          await sleep(500);
        }
        await ctx.dev.cmd(['input', 'tap', String(form.confirm[0]), String(form.confirm[1])]);
        const fresh = await waitForNewPeers(before);
        if (!fresh.length) {
          throw fail(`no new online ${R1_TAG} device joined the tailnet within ${Math.round(peerWaitMs / 1000)} s; check the key has Tags on → ${R1_TAG} and is not expired or used, and allow the VPN on the R1 if asked`);
        }
        ctx.newPeers = fresh;
        return done(`joined as ${fresh.map((p) => p.dnsName || p.hostName).join(', ')}`);
      } finally {
        await releaseAwake(ctx.dev, ctx.log);
      }
    },

    async alwaysOn(ctx) {
      const current = (await ctx.dev.cmd(['settings', 'get', 'secure', 'always_on_vpn_app'])).trim();
      if (current && current !== 'null' && current !== TAILSCALE_PACKAGE) {
        return skipped(`another VPN app (${current}) holds always-on; left unchanged`);
      }
      if (current === TAILSCALE_PACKAGE) {
        const lockdown = (await ctx.dev.cmd(['settings', 'get', 'secure', 'always_on_vpn_lockdown'])).trim();
        if (lockdown === '0' || lockdown === 'null' || lockdown === '') return skipped('already on for Tailscale, without lockdown');
      }
      await ctx.dev.cmd(['settings', 'put', 'secure', 'always_on_vpn_app', TAILSCALE_PACKAGE]);
      await ctx.dev.cmd(['settings', 'put', 'secure', 'always_on_vpn_lockdown', '0']);
      return done('Tailscale, without lockdown');
    },

    async provision(ctx) {
      if (ctx.verified) return skipped('existing pairing already verified over the tailnet');
      const status = await ctx.dev.call('STATUS');
      if (status.json.paired === true && status.json.serverUrlSet === true && (await tryVerifyPeer(ctx))) {
        return skipped('existing pairing verified over the tailnet');
      }
      const store = ctx.state.store;
      const label = `usb:${ctx.serial}`;
      const raw = store.issueDeviceToken(label);
      const digest = hashToken(raw);
      const row = store.tokensByLabel(label).find((t) => t.sha256 === digest);
      const tokenId = row ? row.id : null;
      const url = `https://${ctx.pc.dnsName}`;
      try {
        const nonce = crypto.randomBytes(16).toString('hex');
        await adbSecret.stageToken(ctx.adb, ctx.serial, nonce, raw, { run: runProcess, log: ctx.log });
        const answer = await ctx.dev.call('PROVISION', nonce, [
          ['serverUrl', 's', url],
          ['serverName', 's', String(ctx.state.config.server_name || 'R1CORD')],
        ]);
        if (!answer.ok) {
          throw fail(`the R1 refused the pairing: ${providerError(answer.json)}`);
        }
      } catch (error) {
        if (tokenId !== null) store.revokeTokenById(tokenId);
        throw error;
      }
      ctx.newToken = { id: tokenId, label };
      return done(`paired with ${url}`);
    },

    async peer(ctx) {
      if (ctx.verified && !ctx.newToken) {
        return done(`${ctx.verified.peer.dnsName || ctx.verified.ip} (${ctx.verified.ip})`);
      }
      const { peer, ip } = await verifyPeer(ctx);
      let rotated = '';
      if (ctx.newToken && ctx.newToken.id !== null) {
        // The new token works over the tailnet; retire the older ones this setup issued.
        const store = ctx.state.store;
        const old = store.tokensByLabel(ctx.newToken.label).filter((t) => !t.revoked && t.id !== ctx.newToken.id);
        for (const t of old) store.revokeTokenById(t.id);
        if (old.length) rotated = ` · ${old.length} older token${old.length === 1 ? '' : 's'} revoked`;
      }
      return done(`${peer.dnsName || ip} (${ip})${rotated}`);
    },

    async isolation(ctx) {
      const pcIp = ctx.pc.tailscaleIPs.find(ipv4Tailnet);
      const inconclusive = (detail) => {
        ctx.run.isolation = 'inconclusive';
        ctx.run.isolationDetail = detail;
        return done(`inconclusive: ${detail}`);
      };
      if (!pcIp) return inconclusive('this PC has no tailnet IPv4 address');
      let outcome;
      try {
        outcome = await tailscale.probeListener(async (port) => {
          const answer = await ctx.dev.call('PROBE', pcIp, [['ports', 's', `443,${port}`]]);
          if (!answer.ok) throw fail(`the R1 refused the probe: ${providerError(answer.json)}`);
          return answer.json.results;
        });
      } catch (error) {
        return inconclusive(errorMessage(error));
      }
      const verdict = classifyIsolation(outcome.result, outcome.port, outcome.connections);
      ctx.run.isolation = verdict.result;
      ctx.run.isolationDetail = verdict.detail;
      if (verdict.result === 'fail') throw fail(verdict.detail);
      if (verdict.result !== 'pass') return done(`${verdict.result}: ${verdict.detail}`);

      // This PC alone cannot prove the policy: another tailnet device must be unreachable too.
      const ts = await tailscale.status();
      const other = pickOtherPeer(ts.peers, ctx.pc.tailscaleIPs);
      if (!other) return inconclusive(NO_OTHER_PEER);
      const name = other.peer.dnsName || other.peer.hostName || other.ip;
      let answer;
      try {
        answer = await ctx.dev.call('PROBE', other.ip, [['ports', 's', '443']]);
      } catch (error) {
        return inconclusive(`could not probe ${name} (${other.ip}): ${errorMessage(error)}`);
      }
      if (!answer.ok) return inconclusive(`the R1 refused to probe ${name} (${other.ip}): ${providerError(answer.json)}`);
      const result = answer.json.results ? answer.json.results['443'] : undefined;
      if (result === 'open') {
        ctx.run.isolation = 'fail';
        ctx.run.isolationDetail = `the R1 reached ${name} (${other.ip}) on TCP 443; the tailnet policy lets it reach more than this PC`;
        throw fail(ctx.run.isolationDetail);
      }
      if (result !== 'closed' && result !== 'timeout') return inconclusive(`TCP 443 on ${name} (${other.ip}) was ${result || 'not checked'}`);
      ctx.run.isolation = 'pass';
      ctx.run.isolationDetail = `${verdict.detail}; ${name} (${other.ip}) 443 ${result}`;
      return done(`pass: ${ctx.run.isolationDetail}`);
    },
  };

  const ORDER = [
    ['identity', steps.identity],
    ['pc', steps.pc],
    ['maintenance', steps.maintenance],
    ...APKS.map((spec) => [`install-${spec.entry}`, (ctx) => steps.install(ctx, spec)]),
    ['grants', steps.grants],
    ['tailscale-login', steps.tailscaleLogin],
    ['always-on', steps.alwaysOn],
    ['provision', steps.provision],
    ['peer', steps.peer],
    ['isolation', steps.isolation],
  ];

  async function finish(ctx) {
    const step = ctx.run.steps.find((s) => s.id === 'finish');
    step.status = 'running';
    try {
      if (!ctx.identified) {
        step.status = 'skipped';
        step.detail = 'nothing was changed on the device';
        return;
      }
      const version = await ctx.dev.versionCode(R1CORD_PACKAGE);
      if (version === null || version < MAINTENANCE_MIN_VERSION) {
        step.status = 'skipped';
        step.detail = 'this R1CORD has no maintenance gate';
        return;
      }
      await ctx.dev.call('END_MAINTENANCE');
      const status = await ctx.dev.call('STATUS');
      ctx.run.finalStatus = status.json;
      step.status = 'done';
      step.detail = `R1CORD ${status.json.versionName || version} · paired ${status.json.paired === true ? 'yes' : 'no'} · VPN ${status.json.vpn || '?'}`;
    } catch (error) {
      step.status = 'failed';
      step.detail = errorMessage(error);
      if (!ctx.run.error) ctx.run.error = `${step.label}: ${step.detail}`;
    }
  }

  async function execute(state, run, key) {
    const log = logFor(state);
    const ctx = { state, run, serial: run.serial, key, log, adb: null, dev: null, identified: false, maintenance: false, pc: null };
    let held = false;
    try {
      await suspendUsb(state, log);
      held = true;
      ctx.adb = resolveAdb(state);
      ctx.dev = new Device(ctx.adb, run.serial, runProcess, log);
      log(`setup: started for ${run.serial}`);
      for (const [id, fn] of ORDER) {
        const step = run.steps.find((s) => s.id === id);
        step.status = 'running';
        try {
          const outcome = await fn(ctx);
          step.status = outcome.status;
          step.detail = outcome.detail;
        } catch (error) {
          step.status = 'failed';
          step.detail = errorMessage(error);
          run.error = `${step.label}: ${step.detail}`;
          log(`setup: ${run.serial} ${id} failed: ${step.detail}`);
          break;
        }
      }
    } catch (error) {
      run.error = run.error || errorMessage(error);
    } finally {
      if (ctx.key) ctx.key.fill(0);
      ctx.key = null;
      if (ctx.dev) await finish(ctx);
      if (held) resumeUsb(state);
      const verdict = readiness(run, ctx.pc && ctx.pc.dnsName);
      run.ready = verdict.ready;
      run.readyDetail = verdict.reason;
      run.finishedAt = nowIso();
      stampReady(state, run, log);
      localApksCache = null;
      run.active = false;
      log(`setup: ${run.serial} finished (${run.ready ? 'Ready' : `not ready: ${run.readyDetail}`})`);
    }
  }

  /**
   * Keep the saved record's readyAt in step with the tailnet: set by a Ready run (the policy and
   * isolation were proven), removed by a run whose isolation test failed. Other runs leave it.
   */
  function stampReady(state, run, log) {
    if (!run.ready && run.isolation !== 'fail') return;
    const record = readRecords(state.configDir)[run.serial];
    if (!record) return;
    const { readyAt: _previous, ...rest } = record;
    try {
      writeRecord(state.configDir, run.serial, run.ready ? { ...rest, readyAt: run.finishedAt } : rest);
    } catch (error) {
      log(`setup: could not save the result for ${run.serial}: ${errorMessage(error)}`);
    }
  }

  /**
   * Start a background run. Refuses a second run for the same serial, a run while an R1 update is
   * checking or installing on it, and a malformed key; the key is copied into a Buffer that is
   * zeroed when the run ends. `allowDownload` is the owner's consent to contact the release
   * server; `policyConfirmed` their statement that the tailnet policy was replaced.
   * @param {object} state
   * @param {string} serial
   * @param {{authKey?: string|null, allowDownload?: boolean, policyConfirmed?: boolean}} [options]
   */
  function start(state, serial, { authKey = null, allowDownload = false, policyConfirmed = false } = {}) {
    if (!adbSecret.SERIAL_RE.test(String(serial))) throw fail('invalid device serial');
    const existing = runs.get(serial);
    if (existing && existing.active) throw fail(`setup is already running for ${serial}`);
    if (updateBusy.has(serial)) throw fail(`an R1 app update is running for ${serial}; try again when it has finished`);
    if (authKey && !adbSecret.isValidAuthKey(authKey)) throw fail('that is not a Tailscale auth key (tskey-… letters, digits and dashes)');
    const run = newRun(serial, { allowDownload, policyConfirmed });
    runs.set(serial, run);
    const key = authKey ? Buffer.from(String(authKey), 'utf8') : null;
    run.promise = execute(state, run, key).catch((error) => {
      run.error = run.error || errorMessage(error);
    });
    return publicRun(run);
  }

  function snapshot(serial) {
    const run = runs.get(serial);
    return run ? publicRun(run) : null;
  }

  function isActive(serial) {
    const run = runs.get(serial);
    return Boolean(run && run.active);
  }

  /** Resolves when the serial's current run has ended (tests and shutdown). */
  async function wait(serial) {
    const run = runs.get(serial);
    if (run) await run.promise;
    return snapshot(serial);
  }

  // R1 app updates --------------------------------------------------------------------------------

  function publicCheck(check) {
    return {
      ...check,
      items: check.items.map((item) => ({ ...item, from: { ...item.from }, to: { ...item.to } })),
    };
  }

  /**
   * Compare what the R1 runs (dumpsys package) with the newest verified APKs on this PC — bundled
   * or cached; the release server is asked only while `update_check` is on — and record the
   * pending update for the serial. Returns the recorded check, or null for a device that is not
   * the Rabbit R1 build. A running setup or update on the serial is left alone (returns the last check).
   */
  async function checkForUpdate(state, serial) {
    if (!adbSecret.SERIAL_RE.test(String(serial))) throw fail('invalid device serial');
    if (isActive(serial) || updateBusy.has(serial)) {
      const last = updateChecks.get(serial);
      return last ? publicCheck(last) : null;
    }
    updateBusy.add(serial);
    const log = logFor(state);
    let check;
    try {
      const adb = resolveAdb(state);
      if (!adb) throw fail('adb was not found; install the Android platform tools on the Devices page');
      const dev = new Device(adb, serial, runProcess, log);
      const name = await dev.getprop('ro.product.name');
      const model = await dev.getprop('ro.product.model');
      if (!isR1Build(name, model)) {
        log(`updates: ${serial} is not the Rabbit R1 build; no R1 update offered`);
        updateChecks.delete(serial);
        return null;
      }
      const options = apkOptions(state, state.config.update_check === true);
      const items = [];
      const problems = [];
      for (const spec of APKS) {
        const current = await dev.packageInfo(spec.package);
        // Only what is installed is updated; a missing app is Set up R1's job.
        if (!current) continue;
        let candidate = null;
        try {
          candidate = await updates().newestApk(spec.entry, options);
        } catch (error) {
          if (options.allowDownload) problems.push(`${spec.name}: ${errorMessage(error)}`);
          continue;
        }
        if (candidate && candidate.info.package === spec.package && candidate.info.versionCode > current.versionCode) {
          items.push({
            entry: spec.entry,
            name: spec.name,
            package: spec.package,
            from: { versionName: current.versionName, versionCode: current.versionCode },
            to: { versionName: candidate.info.versionName, versionCode: candidate.info.versionCode },
          });
        }
      }
      check = { serial, checkedAt: nowIso(), items, error: problems.length ? problems.join('; ') : null, installing: false };
      log(`updates: ${serial} ${items.length ? items.map((i) => `${i.name} ${i.from.versionName} → ${i.to.versionName}`).join(', ') : 'is up to date'}`);
    } catch (error) {
      check = { serial, checkedAt: nowIso(), items: [], error: errorMessage(error), installing: false };
      log(`updates: checking ${serial} failed: ${check.error}`);
    } finally {
      updateBusy.delete(serial);
    }
    updateChecks.set(serial, check);
    return publicCheck(check);
  }

  /**
   * Install the serial's pending update: only the identity, maintenance and install steps, under
   * SetupProvider BEGIN/END_MAINTENANCE (refused while R1CORD is busy) when the installed R1CORD
   * has it, `adb install -r` never -d. Refusals throw SetupError; an install that ran returns
   * {at, ok, detail} (also kept as the serial's last result).
   */
  async function installUpdates(state, serial) {
    if (!adbSecret.SERIAL_RE.test(String(serial))) throw fail('invalid device serial');
    const check = updateChecks.get(serial);
    if (!check || !check.items.length) throw fail(`no R1 app update is waiting for ${serial}; plug the R1 in to check again`);
    if (isActive(serial)) throw fail(`setup is running for ${serial}`);
    if (updateBusy.has(serial)) throw fail(`an R1 app update is already running for ${serial}`);
    updateBusy.add(serial);
    check.installing = true;
    const log = logFor(state);
    const ctx = { state, serial, log, adb: null, dev: null, identified: false, maintenance: false };
    const outcomes = [];
    let problem = null;
    let held = false;
    try {
      await suspendUsb(state, log);
      held = true;
      ctx.adb = resolveAdb(state);
      ctx.dev = new Device(ctx.adb, serial, runProcess, log);
      await steps.identity(ctx);
      const note = await holdMaintenance(ctx);
      if (note) outcomes.push(note);
      for (const item of check.items) {
        const spec = APKS.find((s) => s.entry === item.entry);
        let candidate = null;
        try {
          candidate = await updates().newestApk(spec.entry, apkOptions(state, false));
        } catch (_error) {
          candidate = null;
        }
        if (!candidate || candidate.info.versionCode < item.to.versionCode) {
          throw fail(`the verified ${spec.name} ${item.to.versionName} APK is no longer on this PC; plug the R1 in again to re-check`);
        }
        const outcome = await installCandidate(ctx, spec, candidate);
        outcomes.push(`${spec.name}: ${outcome.detail}`);
      }
    } catch (error) {
      problem = errorMessage(error);
    } finally {
      if (ctx.maintenance) {
        try {
          await ctx.dev.call('END_MAINTENANCE');
        } catch (error) {
          problem = problem || `leaving maintenance failed: ${errorMessage(error)}`;
        }
      }
      if (held) resumeUsb(state);
      updateBusy.delete(serial);
      check.installing = false;
      localApksCache = null;
    }
    const result = { at: nowIso(), ok: problem === null, detail: problem || outcomes.join(' · ') };
    updateResults.set(serial, result);
    if (result.ok) updateChecks.delete(serial);
    log(`updates: ${serial} install ${result.ok ? 'done' : 'failed'}: ${result.detail}`);
    return { ...result };
  }

  /**
   * The newest verified APK of each app already on this PC (bundled or cached; never the release
   * server), keyed by entry: {versionName, versionCode} or null when there is none. Remembered
   * for a minute, and forgotten when a run or an update install ends.
   */
  async function localApks(state) {
    if (localApksCache && Date.now() - localApksCache.at < LOCAL_APKS_TTL_MS) return { ...localApksCache.value };
    const value = {};
    for (const spec of APKS) {
      let candidate = null;
      try {
        candidate = await updates().newestApk(spec.entry, apkOptions(state, false));
      } catch (_error) {
        candidate = null;
      }
      value[spec.entry] =
        candidate && candidate.info.package === spec.package ? { versionName: candidate.info.versionName, versionCode: candidate.info.versionCode } : null;
    }
    localApksCache = { at: Date.now(), value };
    return { ...value };
  }

  /**
   * What `r1_auto_update` does when an adopted R1 is plugged in: off → nothing; ask → check and
   * record the pending update for the Updates page; install → check, then install when there is
   * an update.
   */
  async function autoUpdate(state, serial) {
    const mode = state.config && state.config.r1_auto_update;
    if (mode !== 'ask' && mode !== 'install') return null;
    const check = await checkForUpdate(state, serial);
    if (mode !== 'install' || !check || !check.items.length || check.installing) return check;
    return installUpdates(state, serial);
  }

  /** Every serial with a recorded check or install result, for the Updates page. */
  function r1Updates() {
    const serials = [...new Set([...updateChecks.keys(), ...updateResults.keys()])].sort();
    return serials.map((serial) => {
      const check = updateChecks.get(serial);
      const result = updateResults.get(serial);
      return {
        serial,
        check: check ? publicCheck(check) : null,
        installing: Boolean(check && check.installing),
        lastResult: result ? { ...result } : null,
      };
    });
  }

  return {
    start,
    snapshot,
    isActive,
    wait,
    records: (configDir) => readRecords(configDir),
    tailscale,
    checkForUpdate,
    installUpdates,
    autoUpdate,
    r1Updates,
    localApks,
  };
}

module.exports = {
  APKS,
  CONTROLS_PACKAGE,
  DOWNLOAD_LABEL,
  NO_OTHER_PEER,
  POLICY_LABEL,
  R1CORD_PACKAGE,
  RECORDS_FILE,
  STEPS,
  SetupError,
  TAILSCALE_PACKAGE,
  apiPortOf,
  classifyIsolation,
  createSetupManager,
  firstForwarded,
  nextAuthKeyStep,
  parseUiNodes,
  pickOtherPeer,
  readRecords,
  readiness,
};
