// "Set up R1" end to end against a scripted fake R1 (adb), a fake tailnet and fake verified APKs.
// Nothing is spawned; the fake device answers the exact commands setup sends and records them, so
// the tests can check what reached argv, stdin, the log and the progress JSON. The same fakes drive
// the R1 app updates (r1_auto_update) the setup manager checks and installs.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { NO_OTHER_PEER, SetupError, classifyIsolation, createSetupManager, pickOtherPeer, readRecords } = require('../../src/core/setup');
const { hashToken } = require('../../src/core/store');
const realUpdates = require('../../src/core/updates');
const { defaultConfig, saveConfig, withUpdates } = require('../../src/core/config');
const { createApp } = require('../../src/core/app');
const { createLogger } = require('../../src/core/log');
const { ServeConsentError, policySnippet } = require('../../src/core/tailscale');
const { setup: setupView } = require('../../src/core/admin/views/setup');

const ADB = 'C:\\tools\\adb.exe';
const SERIAL = 'R1DEVICESERIAL001';
const KEY = 'tskey-auth-kEXAMPLE1234-abcdefABCDEF0123456789';
const PC = {
  installed: true,
  running: true,
  backendState: 'Running',
  dnsName: 'office-pc.example-tailnet.ts.net',
  tailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'],
  tags: ['tag:r1cord-server'],
  peers: [],
};
const R1_PEER = { id: 'nR1', hostName: 'r1', dnsName: 'r1.example-tailnet.ts.net', ips: ['100.64.0.9'], tags: ['tag:r1cord'], online: true };
const OTHER_PEER = { id: 'nNAS', hostName: 'nas', dnsName: 'nas.example-tailnet.ts.net', ips: ['100.64.0.2'], tags: [], online: true };
const PROBE_PORT = 41641;
const MANIFEST_URL = 'https://updates.example.test/r1cord/manifest.json';

const APK_VERSIONS = {
  r1cord: { package: 'com.chippwalters.r1cord', versionCode: 17, versionName: '0.4.0' },
  controls: { package: 'com.chippwalters.r1cord.controls', versionCode: 1, versionName: '1.0.0' },
  tailscale: { package: 'com.tailscale.ipn', versionCode: 298177930, versionName: '1.102.4' },
};

const cleanup = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  realUpdates.resetForTests();
});

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-setup-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function bundle(ok, json) {
  return { code: 0, stdout: `Result: Bundle[{ok=${ok}, json=${JSON.stringify(json)}}]\n`, stderr: '' };
}

// Tailscale 1.102.4's screens as `uiautomator dump` reports them on the R1: [text, content-desc,
// class, bounds]. Text labels are not clickable; setup taps their bounds' centre.
function screenXml(nodes) {
  const body = nodes
    .map(([text, desc, cls, bounds, extra = ''], i) => `<node index="${i}" text="${text}" content-desc="${desc}" class="${cls}" clickable="${/EditText|ImageView/.test(cls)}" bounds="${bounds}"${extra} />`)
    .join('');
  return `<?xml version="1.0"?><hierarchy rotation="0">${body}</hierarchy>`;
}
const TV = 'android.widget.TextView';
const BACK = ['', 'Go back to the previous screen', 'android.widget.ImageView', '[0,20][50,70]'];
const SCREEN_FIRST_RUN = screenXml([
  ['Tailscale is a mesh VPN for securely connecting your devices.', '', TV, '[20,100][460,200]'],
  ['Get Started', '', TV, '[40,520][440,580]'],
]);
const SCREEN_MAIN = screenXml([
  ['', 'Open settings', 'android.widget.ImageView', '[420,20][470,70]'],
  ['Connect to VPN', '', TV, '[20,100][460,150]'],
  ['Welcome to Tailscale', '', TV, '[20,200][460,260]'],
  ['Log in', '', TV, '[40,520][440,580]'],
]);
const SCREEN_SETTINGS = screenXml([
  BACK,
  ['Accounts', '', TV, '[20,100][460,150]'],
  ['DNS settings', '', TV, '[20,160][460,210]'],
  ['App split tunneling', '', TV, '[20,220][460,270]'],
]);
const SCREEN_ACCOUNTS = screenXml([
  BACK,
  ['', 'menu', 'android.widget.ImageView', '[420,20][470,70]'],
  ['Add another account', '', TV, '[20,100][460,150]'],
  ['Reauthenticate', '', TV, '[20,160][460,210]'],
  ['Delete tailnet', '', TV, '[20,220][460,270]'],
]);
const SCREEN_MENU = screenXml([
  ['Use an alternate server', '', TV, '[240,20][470,70]'],
  ['Use an auth key', '', TV, '[240,80][470,130]'],
]);
const SCREEN_KEY = screenXml([
  BACK,
  ['Add another account', '', TV, '[60,20][400,70]'],
  ['Add an account using an auth key', '', TV, '[20,100][460,150]'],
  ['Auth key', '', TV, '[20,200][460,240]'],
  ['', '', 'android.widget.EditText', '[20,250][460,310]', ' hint="ie: tskey-auth-…"'],
  ['Add account', '', TV, '[300,400][460,460]'],
]);
const SIGN_IN_PATH = [SCREEN_MAIN, SCREEN_SETTINGS, SCREEN_ACCOUNTS, SCREEN_MENU, SCREEN_KEY];
// uiautomator's answer while the display is off.
const SCREEN_OFF = 'ERROR: null root node returned by UiTestAutomationBridge.\n';

/**
 * A scripted R1 and its adb. `opts` picks the scenario; every call is recorded.
 */
function fakeWorld(opts = {}) {
  const o = {
    name: 'gsi_r1',
    model: 'Rabbit R1',
    installed: { 'com.chippwalters.r1cord': 17, 'com.tailscale.ipn': 298177930 },
    status: { v: 1, versionName: '0.4.0', versionCode: 17, paired: false, serverUrlSet: false, busy: false, capture: false, upload: false, libraryWrite: false, maintenance: false, vpn: 'down', helper: 'absent' },
    begin: [true, { v: 1 }],
    provision: [true, { v: 1, paired: true }],
    probe: { 443: 'open', [PROBE_PORT]: 'timeout' },
    otherProbe: { 443: 'timeout' },
    serve: { ok: true, checks: [] },
    install: () => 'Performing Streamed Install\nSuccess\n',
    partials: '',
    services: 'ACTIVITY MANAGER SERVICES (dumpsys activity services)\n  (nothing)\n',
    screens: SIGN_IN_PATH,
    asleep: false,
    alwaysOn: 'null',
    joins: true,
    nonceFrom: '100.64.0.9',
    ...opts,
  };
  const calls = [];
  const secrets = [];
  const methods = [];
  const probes = [];
  const ts = { ...PC, peers: [OTHER_PEER] };
  const state = {
    config: { tailscale_serve: true, server_name: 'Office PC', api_port: 8766, update_manifest_url: MANIFEST_URL, update_check: false, r1_auto_update: 'ask' },
    configDir: tmpDir(),
    usb: {
      suspended: 0,
      resumed: 0,
      async suspend(reason) {
        this.reason = reason;
        this.suspended += 1;
        if (o.suspendGate) await o.suspendGate;
      },
      resume() {
        this.resumed += 1;
      },
    },
    store: fakeStore(),
  };
  let seen = null;
  let screen = 0;
  let awake = !o.asleep;

  async function run(argv, options = {}) {
    calls.push({ argv: [...argv], input: options.input ? Buffer.from(options.input) : null });
    if (options.input) {
      secrets.push(options.input);
      return { code: 0, stdout: '', stderr: '' };
    }
    expect(argv.slice(0, 3)).toEqual([ADB, '-s', SERIAL]);
    if (argv[3] === 'install') {
      const out = o.install(argv);
      if (/\bSuccess\b/.test(out)) {
        const info = { ...APK_VERSIONS, ...o.apks, ...o.remoteApks }[path.win32.basename(argv[5], '.apk')];
        o.installed[info.package] = info.versionCode;
      }
      return { code: 0, stdout: out, stderr: '' };
    }
    expect(argv[3]).toBe('shell');
    const script = argv[4];
    const method = /'--method' '(\w+)'/.exec(script);
    if (method) {
      methods.push(method[1]);
      switch (method[1]) {
        case 'STATUS':
          return bundle(true, o.status);
        case 'BEGIN_MAINTENANCE':
          return bundle(...o.begin);
        case 'END_MAINTENANCE':
          return bundle(true, { v: 1 });
        case 'PROVISION':
          return bundle(...o.provision);
        case 'NONCE': {
          const nonce = /'--arg' '([0-9a-f]{32})'/.exec(script)[1];
          seen = { nonce, from: { forwardedFor: o.nonceFrom, remote: '127.0.0.1' } };
          return bundle(true, { v: 1, status: 204, route: o.nonceFrom === null ? 'usb' : 'configured' });
        }
        case 'PROBE': {
          const host = /'--arg' '([0-9.]+)'/.exec(script)[1];
          probes.push({ host, ports: /'ports:s:([0-9,]+)'/.exec(script)[1] });
          return bundle(true, { v: 1, results: host === PC.tailscaleIPs[0] ? o.probe : o.otherProbe });
        }
        default:
          throw new Error(`unexpected method ${method[1]}`);
      }
    }
    if (script === "'getprop' 'ro.product.name'") return { code: 0, stdout: `${o.name}\n`, stderr: '' };
    if (script === "'getprop' 'ro.product.model'") return { code: 0, stdout: `${o.model}\n`, stderr: '' };
    const pm = /^'pm' 'list' 'packages' '--show-versioncode' '([\w.]+)'$/.exec(script);
    if (pm) {
      const lines = Object.entries(o.installed)
        .filter(([pkg]) => pkg.includes(pm[1]))
        .map(([pkg, code]) => `package:${pkg} versionCode:${code}`);
      return { code: 0, stdout: lines.join('\n'), stderr: '' };
    }
    const dumpsys = /^'dumpsys' 'package' '([\w.]+)'$/.exec(script);
    if (dumpsys) {
      const code = o.installed[dumpsys[1]];
      if (code === undefined) return { code: 0, stdout: 'Dexopt state:\n  Unable to find package: x\n', stderr: '' };
      const known = [...Object.values(APK_VERSIONS), ...Object.values(o.apks || {})];
      const name = known.find((a) => a.package === dumpsys[1] && a.versionCode === code);
      const versionName = name ? name.versionName : `v${code}`;
      return {
        code: 0,
        stdout: `Packages:\n  Package [${dumpsys[1]}] (4d2c1a):\n    userId=10123\n    versionCode=${code} minSdk=33 targetSdk=36\n    versionName=${versionName}\n`,
        stderr: '',
      };
    }
    if (script.startsWith('find /sdcard/Download/R1CORD')) return { code: 0, stdout: o.partials, stderr: '' };
    if (script.startsWith('dumpsys activity services')) return { code: 0, stdout: o.services, stderr: '' };
    if (script === "'input' 'keyevent' 'KEYCODE_WAKEUP'") {
      awake = true;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (script.startsWith('uiautomator dump')) {
      if (!awake) return { code: 0, stdout: SCREEN_OFF, stderr: '' };
      const xml = o.screens[Math.min(screen, o.screens.length - 1)];
      return { code: 0, stdout: xml, stderr: '' };
    }
    if (script.startsWith("'cmd' 'package' 'resolve-activity'")) {
      return { code: 0, stdout: 'priority=0 preferredOrder=0\ncom.tailscale.ipn/.MainActivity\n', stderr: '' };
    }
    if (script.startsWith("'input' 'tap'")) {
      if (!awake) return { code: 0, stdout: '', stderr: '' };
      screen += 1;
      const [x, y] = script.match(/\d+/g).map(Number);
      // Tapping the confirm control signs the R1 in: it joins the tailnet.
      if (x === 380 && y === 430 && o.joins) ts.peers = [...ts.peers, o.joinPeer || R1_PEER];
      return { code: 0, stdout: '', stderr: '' };
    }
    if (script === 'dumpsys input_method') return { code: 0, stdout: 'mInputShown=false\n', stderr: '' };
    if (script === "'settings' 'get' 'secure' 'always_on_vpn_app'") return { code: 0, stdout: `${o.alwaysOn}\n`, stderr: '' };
    if (script === "'settings' 'get' 'secure' 'always_on_vpn_lockdown'") return { code: 0, stdout: '0\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  }

  const tailscale = {
    status: async () => ({ ...ts, peers: ts.peers.map((p) => ({ ...p })) }),
    probeListener: async (fn) => ({ result: await fn(PROBE_PORT), port: PROBE_PORT, connections: o.connections || 0 }),
    verifyCalls: [],
    async verifyServe(dnsName, options) {
      this.verifyCalls.push([dnsName, options]);
      return o.serve;
    },
  };
  const apkCalls = [];
  const updates = o.updatesModule || {
    async newestApk(entry, options) {
      apkCalls.push({ entry, options });
      // The release server may only be asked with the owner's consent.
      if (options.allowDownload) expect(options.config).toBe(state.config);
      else expect(options.config).toBe(undefined);
      const table = options.allowDownload && o.remoteApks ? o.remoteApks : o.apks || APK_VERSIONS;
      const info = table[entry];
      return info ? { path: `C:\\apk\\${entry}.apk`, info, source: 'bundled' } : null;
    },
  };
  const nonces = {
    createNonce: () => 'c0ffee00'.repeat(4),
    consumeSeen: (_state, nonce) => (seen && seen.nonce === nonce ? seen.from : null),
  };
  const log = [];
  const manager = createSetupManager({
    run,
    adbPath: () => ADB,
    tailscale,
    updates: () => updates,
    nonces: () => nonces,
    sleep: async () => {},
    peerWaitMs: 0,
    log: (line) => log.push(line),
  });
  return { manager, state, calls, secrets, methods, probes, apkCalls, log, o, ts, tailscale };
}

function fakeStore() {
  const tokens = [];
  let nextId = 1;
  return {
    tokens,
    revoked: [],
    issueDeviceToken(label) {
      const raw = (nextId.toString(16).padStart(2, '0') + 'a'.repeat(62)).slice(0, 64);
      tokens.unshift({ id: nextId, sha256: hashToken(raw), label, revoked: false });
      nextId += 1;
      this.lastRaw = raw;
      return raw;
    },
    tokensByLabel(label) {
      return tokens.filter((t) => t.label === label);
    },
    revokeTokenById(id) {
      this.revoked.push(id);
      const row = tokens.find((t) => t.id === id);
      if (row) row.revoked = true;
    },
  };
}

async function runSetup(world, options = { authKey: KEY, policyConfirmed: true }) {
  world.manager.start(world.state, SERIAL, options);
  return world.manager.wait(SERIAL);
}

function stepStatus(run) {
  return Object.fromEntries(run.steps.map((s) => [s.id, s.status]));
}

function shellScripts(world) {
  return world.calls.filter((c) => !c.input).map((c) => c.argv.join(' '));
}

describe('a full run', () => {
  it('sets up a new R1 and ends Ready, with no secret in argv, logs or progress', async () => {
    const world = fakeWorld({ installed: { 'com.chippwalters.r1cord': 16 }, apks: APK_VERSIONS });
    const run = await runSetup(world, { authKey: KEY, policyConfirmed: true });
    expect(run.error).toBe(null);
    expect(stepStatus(run)).toEqual({
      identity: 'done',
      pc: 'done',
      maintenance: 'skipped',
      'install-r1cord': 'done',
      'install-controls': 'done',
      'install-tailscale': 'done',
      grants: 'done',
      'tailscale-login': 'done',
      'always-on': 'done',
      provision: 'done',
      peer: 'done',
      isolation: 'done',
      finish: 'done',
    });
    expect(run.isolation).toBe('pass');
    expect(run.ready).toBe(true);
    expect(run.active).toBe(false);

    const token = world.state.store.lastRaw;
    const argvText = world.calls.map((c) => c.argv.join(' ')).join('\n');
    expect(argvText).not.toContain(KEY);
    expect(argvText).not.toContain(token);
    expect(world.log.join('\n')).not.toContain(KEY);
    expect(world.log.join('\n')).not.toContain(token);
    const progress = JSON.stringify(world.manager.snapshot(SERIAL));
    expect(progress).not.toContain(KEY);
    expect(progress).not.toContain(token);
    // Both secrets travelled on stdin only, and those buffers were zeroed afterwards.
    const stdin = world.calls.filter((c) => c.input).map((c) => c.input.toString('utf8'));
    expect(stdin.some((s) => s.includes(`input text '${KEY}'`))).toBe(true);
    expect(stdin.some((s) => s.includes(token) && s.includes('content write'))).toBe(true);
    expect(world.secrets.every((buf) => buf.every((b) => b === 0))).toBe(true);

    // Installs never downgrade; the pre-gate app was simply updated, then maintenance began.
    const installs = world.calls.filter((c) => c.argv[3] === 'install').map((c) => c.argv.slice(3));
    expect(installs).toEqual([
      ['install', '-r', 'C:\\apk\\r1cord.apk'],
      ['install', '-r', 'C:\\apk\\controls.apk'],
      ['install', '-r', 'C:\\apk\\tailscale.apk'],
    ]);
    expect(world.methods).toContain('BEGIN_MAINTENANCE');
    expect(world.methods.at(-2)).toBe('END_MAINTENANCE');
    expect(world.methods.at(-1)).toBe('STATUS');
    const scripts = shellScripts(world);
    expect(scripts).toContain(`${ADB} -s ${SERIAL} shell 'pm' 'grant' 'com.chippwalters.r1cord' 'android.permission.RECORD_AUDIO'`);
    expect(scripts).toContain(`${ADB} -s ${SERIAL} shell 'cmd' 'package' 'set-home-activity' 'com.chippwalters.r1cord/.MainActivity'`);
    expect(scripts).toContain(`${ADB} -s ${SERIAL} shell 'appops' 'set' 'com.tailscale.ipn' 'ACTIVATE_VPN' 'allow'`);
    expect(scripts).toContain(`${ADB} -s ${SERIAL} shell 'settings' 'put' 'secure' 'always_on_vpn_app' 'com.tailscale.ipn'`);
    expect(scripts).toContain(`${ADB} -s ${SERIAL} shell 'settings' 'put' 'secure' 'always_on_vpn_lockdown' '0'`);
    const provision = scripts.find((s) => s.includes("'PROVISION'"));
    expect(provision).toContain("'serverUrl:s:https\\://office-pc.example-tailnet.ts.net'");
    expect(provision).toContain("'serverName:s:Office PC'");

    // The UI is never dumped once the key has been typed.
    const typedAt = world.calls.findIndex((c) => c.input && c.input.toString('utf8').includes('input text'));
    expect(world.calls.slice(typedAt).some((c) => String(c.argv[4] || '').startsWith('uiautomator'))).toBe(false);

    // The verified peer is recorded without secrets; USB polling was paused for the whole run.
    const records = readRecords(world.state.configDir);
    expect(records[SERIAL]).toMatchObject({ serial: SERIAL, nodeId: 'nR1', ip: '100.64.0.9', dnsName: 'r1.example-tailnet.ts.net' });
    const file = fs.readFileSync(path.join(world.state.configDir, 'r1-setup.json'), 'utf8');
    expect(file).not.toContain(token);
    expect(file).not.toContain(KEY);
    expect(world.state.usb.reason).toBe('setup');
    expect([world.state.usb.suspended, world.state.usb.resumed]).toEqual([1, 1]);
  });

  it('a rerun on a set-up R1 skips sign-in, reuses the pairing and mints no token', async () => {
    const world = fakeWorld();
    world.ts.peers = [OTHER_PEER, R1_PEER];
    fs.writeFileSync(
      path.join(world.state.configDir, 'r1-setup.json'),
      JSON.stringify({ version: 1, devices: { [SERIAL]: { serial: SERIAL, nodeId: 'nR1', ip: '100.64.0.9', dnsName: R1_PEER.dnsName, verifiedAt: '2026-09-01T00:00:00Z' } } }),
    );
    world.o.status = { ...world.o.status, paired: true, serverUrlSet: true, vpn: 'up' };
    world.o.installed = { 'com.chippwalters.r1cord': 17, 'com.chippwalters.r1cord.controls': 1, 'com.tailscale.ipn': 298177930 };
    world.o.alwaysOn = 'com.tailscale.ipn';
    const run = await runSetup(world, { policyConfirmed: true });
    expect(stepStatus(run)).toMatchObject({
      'install-r1cord': 'skipped',
      'install-controls': 'skipped',
      'install-tailscale': 'skipped',
      'tailscale-login': 'skipped',
      'always-on': 'skipped',
      provision: 'skipped',
      peer: 'done',
    });
    expect(run.ready).toBe(true);
    expect(world.state.store.tokens).toEqual([]);
    expect(world.calls.some((c) => c.argv[3] === 'install')).toBe(false);
  });

  it('installs over a pre-gate R1CORD like any other app: no attended flag, maintenance skipped with a note', async () => {
    const world = fakeWorld({ installed: { 'com.chippwalters.r1cord': 14 } });
    const run = await runSetup(world);
    expect(stepStatus(run)).toMatchObject({ maintenance: 'skipped', 'install-r1cord': 'done' });
    expect(run.steps.find((s) => s.id === 'maintenance').detail).toMatch(/versionCode 14 has no SetupProvider/);
    const installs = world.calls.filter((c) => c.argv[3] === 'install').map((c) => c.argv.slice(3));
    expect(installs[0]).toEqual(['install', '-r', 'C:\\apk\\r1cord.apk']);
    expect(world.calls.map((c) => c.argv.join(' ')).join('\n')).not.toMatch(/ -d |uninstall/);
    // The old app was never asked for maintenance; the freshly installed one was.
    const firstInstall = world.calls.findIndex((c) => c.argv[3] === 'install');
    const firstBegin = world.calls.findIndex((c) => String(c.argv[4] || '').includes("'BEGIN_MAINTENANCE'"));
    expect(firstBegin).toBeGreaterThan(firstInstall);
    expect(shellScripts(world).some((s) => s.includes('audio.partial') || s.includes('dumpsys activity services'))).toBe(false);
    expect(run.ready).toBe(true);
  });

  it('skips maintenance with a note when R1CORD is not installed yet, then installs it', async () => {
    const world = fakeWorld({ installed: {} });
    const run = await runSetup(world);
    expect(stepStatus(run)).toMatchObject({ maintenance: 'skipped', 'install-r1cord': 'done', finish: 'done' });
    expect(run.steps.find((s) => s.id === 'maintenance').detail).toMatch(/not installed yet/);
  });
});

describe('refusals', () => {
  it('refuses a device that is not the Rabbit R1 build and changes nothing', async () => {
    const world = fakeWorld({ name: 'sdk_gphone64', model: 'Pixel' });
    const run = await runSetup(world);
    expect(stepStatus(run).identity).toBe('failed');
    expect(run.steps.find((s) => s.id === 'identity').detail).toMatch(/not the Rabbit R1/);
    expect(stepStatus(run).finish).toBe('skipped');
    expect(world.methods).toEqual([]);
    expect(shellScripts(world).every((s) => s.includes("'getprop'"))).toBe(true);
    expect(run.ready).toBe(false);
    expect(world.state.usb.resumed).toBe(1);
  });

  it('accepts the R1 model as getprop reports it and refuses another model on the same build name', async () => {
    const r1 = await runSetup(fakeWorld({ name: 'gsi_r1', model: 'Rabbit R1' }));
    expect(stepStatus(r1).identity).toBe('done');
    const adbSpelling = await runSetup(fakeWorld({ name: 'gsi_r1', model: 'Rabbit_R1' }));
    expect(stepStatus(adbSpelling).identity).toBe('done');
    const pixel = fakeWorld({ name: 'gsi_r1', model: 'Pixel 7' });
    const run = await runSetup(pixel);
    expect(stepStatus(run).identity).toBe('failed');
    expect(run.steps.find((s) => s.id === 'identity').detail).toMatch(/ro\.product\.model=Pixel 7/);
    expect(pixel.methods).toEqual([]);
  });

  it('refuses when STATUS says R1CORD is busy, and still ends maintenance', async () => {
    const world = fakeWorld();
    world.o.status = { ...world.o.status, busy: true, capture: true };
    const run = await runSetup(world);
    expect(stepStatus(run).maintenance).toBe('failed');
    expect(run.steps.find((s) => s.id === 'maintenance').detail).toMatch(/busy \(capture\)/);
    expect(world.methods).not.toContain('BEGIN_MAINTENANCE');
    expect(world.methods).toContain('END_MAINTENANCE');
  });

  it('treats an unknown busy state as busy', async () => {
    const world = fakeWorld();
    world.o.status = { ...world.o.status, busy: 'unknown' };
    const run = await runSetup(world);
    expect(stepStatus(run).maintenance).toBe('failed');
    expect(world.methods).not.toContain('BEGIN_MAINTENANCE');
  });

  it('refuses when BEGIN_MAINTENANCE reports busy', async () => {
    const world = fakeWorld({ begin: [false, { v: 1, error: 'busy', reason: 'Upload in progress.' }] });
    const run = await runSetup(world);
    expect(run.steps.find((s) => s.id === 'maintenance').detail).toMatch(/Upload in progress/);
    expect(world.calls.some((c) => c.argv[3] === 'install')).toBe(false);
  });

  it('stops at a signature mismatch, never uninstalls, and ends maintenance', async () => {
    const world = fakeWorld({
      apks: { ...APK_VERSIONS, r1cord: { ...APK_VERSIONS.r1cord, versionCode: 18, versionName: '0.4.1' } },
      install: () => 'Performing Streamed Install\nadb: failed to install r1cord.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package com.chippwalters.r1cord signatures do not match newer version; ignoring!]\n',
    });
    const run = await runSetup(world);
    expect(stepStatus(run)['install-r1cord']).toBe('failed');
    expect(run.steps.find((s) => s.id === 'install-r1cord').detail).toMatch(/different key.*will not uninstall/);
    expect(stepStatus(run)['install-controls']).toBe('pending');
    const argvText = world.calls.map((c) => c.argv.join(' ')).join('\n');
    expect(argvText).not.toMatch(/uninstall|pm clear| -d /);
    expect(world.methods.at(-2)).toBe('END_MAINTENANCE');
  });

  it('never passes -d and skips an APK that is not newer than the installed one', async () => {
    const world = fakeWorld({ installed: { 'com.chippwalters.r1cord': 20, 'com.chippwalters.r1cord.controls': 1, 'com.tailscale.ipn': 298177931 } });
    const run = await runSetup(world);
    expect(stepStatus(run)).toMatchObject({ 'install-r1cord': 'skipped', 'install-controls': 'skipped', 'install-tailscale': 'skipped' });
    expect(world.calls.some((c) => c.argv[3] === 'install')).toBe(false);
  });

  it('fails when no verified APK is available', async () => {
    const world = fakeWorld({ apks: { r1cord: APK_VERSIONS.r1cord } });
    const run = await runSetup(world);
    expect(stepStatus(run)['install-controls']).toBe('failed');
    expect(run.steps.find((s) => s.id === 'install-controls').detail).toMatch(/no verified/);
  });

  it('asks for an auth key when the R1 is not on the tailnet yet', async () => {
    const world = fakeWorld();
    const run = await runSetup(world, {});
    expect(stepStatus(run)['tailscale-login']).toBe('failed');
    expect(run.steps.find((s) => s.id === 'tailscale-login').detail).toMatch(/auth key/);
  });

  it('refuses a malformed auth key before starting', () => {
    const world = fakeWorld();
    expect(() => world.manager.start(world.state, SERIAL, { authKey: 'tskey-auth-x;reboot' })).toThrow(SetupError);
    expect(world.calls).toEqual([]);
  });

  it('fails the sign-in step when no new tagged device joins', async () => {
    const world = fakeWorld({ joins: false });
    const run = await runSetup(world);
    expect(stepStatus(run)['tailscale-login']).toBe('failed');
    expect(run.steps.find((s) => s.id === 'tailscale-login').detail).toMatch(/no new online tag:r1cord device/);
  });

  it('fails at once when the R1 joins without tag:r1cord', async () => {
    const untagged = { id: 'nU', hostName: 'Rabbit R1', dnsName: 'rabbit-r1.example-tailnet.ts.net', ips: ['100.64.0.7'], tags: [], online: true, os: 'android' };
    const world = fakeWorld({ joinPeer: untagged });
    const run = await runSetup(world);
    expect(stepStatus(run)['tailscale-login']).toBe('failed');
    const detail = run.steps.find((s) => s.id === 'tailscale-login').detail;
    expect(detail).toMatch(/WITHOUT tag:r1cord/);
    expect(detail).toContain('Rabbit R1');
    expect(detail).toContain('100.64.0.7');
  });

  it('skips sign-in without a key when the R1 is already an online tagged peer', async () => {
    const world = fakeWorld();
    world.ts.peers = [OTHER_PEER, { ...R1_PEER, os: 'android' }];
    const run = await runSetup(world, {});
    expect(stepStatus(run)['tailscale-login']).toBe('skipped');
  });

  it('names the missing tag, not the key, when the only R1 candidate is untagged', async () => {
    const world = fakeWorld();
    world.ts.peers = [OTHER_PEER, { id: 'nU', hostName: 'Rabbit R1', dnsName: '', ips: ['100.64.0.7'], tags: [], online: true, os: 'android' }];
    const run = await runSetup(world, {});
    expect(stepStatus(run)['tailscale-login']).toBe('failed');
    const detail = run.steps.find((s) => s.id === 'tailscale-login').detail;
    expect(detail).toMatch(/WITHOUT tag:r1cord/);
    expect(detail).toContain('Rabbit R1');
  });

  it('leaves a different VPN app holding always-on alone', async () => {
    const world = fakeWorld({ alwaysOn: 'com.example.othervpn' });
    const run = await runSetup(world);
    expect(stepStatus(run)['always-on']).toBe('skipped');
    expect(shellScripts(world).some((s) => s.includes("'settings' 'put'"))).toBe(false);
  });
});

describe('Tailscale sign-in walk', () => {
  const WAKE = "'input' 'keyevent' 'KEYCODE_WAKEUP'";
  const UNLOCK = "'wm' 'dismiss-keyguard'";
  const STAY_ON = "'svc' 'power' 'stayon' 'usb'";
  const STAY_OFF = "'svc' 'power' 'stayon' 'false'";
  const shell = (c) => (c.input ? '' : String(c.argv[4] || ''));
  const taps = (world) => world.calls.map(shell).filter((s) => s.startsWith("'input' 'tap'")).map((s) => s.match(/\d+/g).map(Number));
  const typedAt = (world) => world.calls.findIndex((c) => c.input && c.input.toString('utf8').includes('input text'));
  const dumps = (world) => world.calls.map((c, i) => (shell(c).startsWith('uiautomator dump') ? i : -1)).filter((i) => i >= 0);
  const indexOf = (world, script) => world.calls.findIndex((c) => shell(c) === script);

  function expectTypedThenConfirmed(world) {
    const typed = typedAt(world);
    expect(typed).toBeGreaterThan(-1);
    expect(dumps(world).every((i) => i < typed)).toBe(true);
    const tapIdx = world.calls.map((c, i) => (shell(c).startsWith("'input' 'tap'") ? i : -1)).filter((i) => i >= 0);
    // The field is tapped before typing, "Add account" after, from the bounds recorded before typing.
    expect(tapIdx.at(-2)).toBeLessThan(typed);
    expect(tapIdx.at(-1)).toBeGreaterThan(typed);
  }

  it('walks a freshly installed Tailscale from its first-run screen to the auth-key form', async () => {
    const world = fakeWorld({ screens: [SCREEN_FIRST_RUN, ...SIGN_IN_PATH] });
    const run = await runSetup(world);
    expect(stepStatus(run)['tailscale-login']).toBe('done');
    expect(taps(world)).toEqual([
      [240, 550], // Get Started
      [445, 45], // Open settings
      [240, 125], // Accounts
      [445, 45], // menu
      [355, 105], // Use an auth key
      [240, 280], // the auth key field
      [380, 430], // Add account
    ]);
    expectTypedThenConfirmed(world);
  });

  it('starts from the logged-out main screen', async () => {
    const world = fakeWorld({ screens: SIGN_IN_PATH });
    const run = await runSetup(world);
    expect(stepStatus(run)['tailscale-login']).toBe('done');
    expect(taps(world)).toEqual([[445, 45], [240, 125], [445, 45], [355, 105], [240, 280], [380, 430]]);
    expectTypedThenConfirmed(world);
  });

  it('wakes a sleeping R1 and keeps it awake before reading the screen, and lets it sleep afterwards', async () => {
    const world = fakeWorld({ asleep: true });
    const run = await runSetup(world);
    expect(stepStatus(run)['tailscale-login']).toBe('done');
    const firstDump = dumps(world)[0];
    const wake = indexOf(world, WAKE);
    expect(wake).toBeGreaterThan(-1);
    expect(wake).toBeLessThan(indexOf(world, UNLOCK));
    expect(indexOf(world, UNLOCK)).toBeLessThan(indexOf(world, STAY_ON));
    expect(indexOf(world, STAY_ON)).toBeLessThan(firstDump);
    const confirmTap = world.calls.findIndex((c) => shell(c) === "'input' 'tap' '380' '430'");
    expect(indexOf(world, STAY_OFF)).toBeGreaterThan(confirmTap);
    expect(world.calls.filter((c) => shell(c) === STAY_OFF)).toHaveLength(1);
    expectTypedThenConfirmed(world);
  });

  it('gives up on an unknown screen, names the last screen seen, never types, and still lets the R1 sleep', async () => {
    const stuck = screenXml([
      ['Tailscale needs permission', '', TV, '[20,100][460,150]'],
      ['', 'Allow', 'android.widget.ImageView', '[20,200][220,260]'],
      ['Cancel', '', TV, '[240,200][460,260]'],
      ['Learn more', '', TV, '[20,300][460,350]'],
    ]);
    const world = fakeWorld({ screens: [stuck] });
    const run = await runSetup(world);
    expect(stepStatus(run)['tailscale-login']).toBe('failed');
    const detail = run.steps.find((s) => s.id === 'tailscale-login').detail;
    expect(detail).toContain("could not find Tailscale's “Use an auth key” screen (last screen: “Tailscale needs permission”, “Allow”, “Cancel”)");
    expect(detail).not.toContain('Learn more');
    expect(dumps(world)).toHaveLength(20);
    expect(taps(world)).toEqual([]);
    expect(typedAt(world)).toBe(-1);
    expect(indexOf(world, STAY_OFF)).toBeGreaterThan(dumps(world).at(-1));
  });
});

describe('pairing', () => {
  it('revokes the new token when PROVISION fails', async () => {
    const world = fakeWorld({ provision: [false, { v: 1, error: 'bad_url', message: 'URL must be https' }] });
    const run = await runSetup(world);
    expect(stepStatus(run).provision).toBe('failed');
    expect(run.steps.find((s) => s.id === 'provision').detail).toMatch(/bad_url/);
    const [token] = world.state.store.tokens;
    expect(token.label).toBe(`usb:${SERIAL}`);
    expect(world.state.store.revoked).toEqual([token.id]);
    expect(world.methods).toContain('END_MAINTENANCE');
  });

  it('refuses a nonce that arrived over USB instead of the tailnet', async () => {
    const world = fakeWorld({ nonceFrom: null });
    const run = await runSetup(world);
    expect(stepStatus(run).peer).toBe('failed');
    expect(run.steps.find((s) => s.id === 'peer').detail).toMatch(/over USB/);
    expect(readRecords(world.state.configDir)).toEqual({});
  });

  it('refuses a nonce presented by a device that is not a tagged R1', async () => {
    const world = fakeWorld({ nonceFrom: '100.64.0.50' });
    world.ts.peers = [{ id: 'nLaptop', hostName: 'laptop', dnsName: 'laptop.example-tailnet.ts.net', ips: ['100.64.0.50'], tags: [], online: true }];
    const run = await runSetup(world);
    expect(stepStatus(run).peer).toBe('failed');
    expect(run.steps.find((s) => s.id === 'peer').detail).toMatch(/not an online tag:r1cord device/);
  });

  it('retires older usb tokens only after the new one is verified', async () => {
    const world = fakeWorld();
    const store = world.state.store;
    store.issueDeviceToken(`usb:${SERIAL}`);
    const [old] = store.tokens;
    const run = await runSetup(world);
    expect(run.ready).toBe(true);
    expect(store.revoked).toEqual([old.id]);
  });
});

describe('isolation', () => {
  it.each([
    [{ 443: 'open', [PROBE_PORT]: 'timeout' }, 0, 'pass'],
    [{ 443: 'open', [PROBE_PORT]: 'closed' }, 0, 'pass'],
    [{ 443: 'open', [PROBE_PORT]: 'open' }, 0, 'fail'],
    [{ 443: 'open', [PROBE_PORT]: 'timeout' }, 1, 'fail'],
    [{ 443: 'timeout', [PROBE_PORT]: 'timeout' }, 0, 'inconclusive'],
    [{ 443: 'closed', [PROBE_PORT]: 'closed' }, 0, 'inconclusive'],
    [{ 443: 'open' }, 0, 'inconclusive'],
    [null, 0, 'inconclusive'],
  ])('%j with %i arrivals is %s', (results, connections, expected) => {
    expect(classifyIsolation(results, PROBE_PORT, connections).result).toBe(expected);
  });

  it('a reachable test port fails the run (red) and it is not Ready', async () => {
    const world = fakeWorld({ probe: { 443: 'open', [PROBE_PORT]: 'open' } });
    const run = await runSetup(world);
    expect(run.isolation).toBe('fail');
    expect(stepStatus(run).isolation).toBe('failed');
    expect(run.ready).toBe(false);
    expect(world.methods).toContain('END_MAINTENANCE');
  });

  it('an unreachable 443 is inconclusive (amber): every step passes but it is not Ready', async () => {
    const world = fakeWorld({ probe: { 443: 'timeout', [PROBE_PORT]: 'timeout' } });
    const run = await runSetup(world);
    expect(run.isolation).toBe('inconclusive');
    expect(run.steps.every((s) => s.status === 'done' || s.status === 'skipped')).toBe(true);
    expect(run.ready).toBe(false);
  });

  it('probes another tailnet device on 443 — not this PC, not the R1 — and passes when it is blocked', async () => {
    const world = fakeWorld();
    const run = await runSetup(world);
    expect(world.probes).toEqual([
      { host: '100.101.102.103', ports: `443,${PROBE_PORT}` },
      { host: '100.64.0.2', ports: '443' },
    ]);
    expect(run.isolation).toBe('pass');
    expect(run.ready).toBe(true);
  });

  it('fails (red) when the R1 reaches another tailnet device on 443', async () => {
    const world = fakeWorld({ otherProbe: { 443: 'open' } });
    const run = await runSetup(world);
    expect(run.isolation).toBe('fail');
    expect(run.isolationDetail).toMatch(/nas\.example-tailnet\.ts\.net \(100\.64\.0\.2\) on TCP 443/);
    expect(stepStatus(run).isolation).toBe('failed');
    expect(run.ready).toBe(false);
    expect(world.methods).toContain('END_MAINTENANCE');
  });

  it('is inconclusive (amber) and not Ready when there is no other tailnet device to test against', async () => {
    const world = fakeWorld();
    world.ts.peers = [];
    const run = await runSetup(world);
    expect(run.isolation).toBe('inconclusive');
    expect(run.isolationDetail).toBe(NO_OTHER_PEER);
    expect(run.steps.every((s) => s.status === 'done' || s.status === 'skipped')).toBe(true);
    expect(world.probes.map((p) => p.host)).toEqual(['100.101.102.103']);
    expect(run.ready).toBe(false);
    expect(run.readyDetail).toContain(NO_OTHER_PEER);
  });

  it('tests against an online device that is neither an R1 nor an allowed server, untagged first', () => {
    const peer = (id, ip, tags, online = true) => ({ id, hostName: id, dnsName: `${id}.example-tailnet.ts.net`, ips: [ip], tags, online });
    const peers = [
      R1_PEER,
      peer('offline', '100.64.0.3', [], false),
      peer('server', '100.64.0.4', ['tag:r1cord-server']),
      peer('taggednas', '100.64.0.5', ['tag:nas']),
      peer('laptop', '100.64.0.6', []),
      peer('v6only', 'fd7a:115c:a1e0::7', []),
    ];
    expect(pickOtherPeer(peers, PC.tailscaleIPs)).toMatchObject({ ip: '100.64.0.6', peer: { id: 'laptop' } });
    expect(pickOtherPeer(peers.filter((p) => p.id !== 'laptop'), PC.tailscaleIPs).ip).toBe('100.64.0.5');
    expect(pickOtherPeer([R1_PEER, peer('server', '100.64.0.4', ['tag:r1cord-server'])], PC.tailscaleIPs)).toBe(null);
  });
});

describe('concurrency', () => {
  it('refuses a second run for the same serial while one is active', async () => {
    let release;
    const world = fakeWorld({ suspendGate: new Promise((resolve) => (release = resolve)) });
    const first = world.manager.start(world.state, SERIAL, { authKey: KEY, policyConfirmed: true });
    expect(first.active).toBe(true);
    expect(() => world.manager.start(world.state, SERIAL, { authKey: KEY })).toThrow(/already running/);
    expect(world.manager.isActive(SERIAL)).toBe(true);
    release();
    const run = await world.manager.wait(SERIAL);
    expect(run.active).toBe(false);
    expect(run.ready).toBe(true);
    // Once finished, the serial can be set up again.
    expect(() => world.manager.start(world.state, SERIAL, {})).not.toThrow();
    await world.manager.wait(SERIAL);
  });
});

describe('ready', () => {
  it('verifies the port the API listener actually bound, not a changed config value', async () => {
    const world = fakeWorld();
    world.state.apiPort = 8799;
    world.state.config.api_port = 8800; // saved, not in effect until restart
    const run = await runSetup(world);
    expect(world.tailscale.verifyCalls).toEqual([[PC.dnsName, { apiPort: 8799 }]]);
    expect(run.serve).toMatchObject({ apiPort: 8799, ok: true });
    expect(run.ready).toBe(true);
  });

  it('checks /v1 from the tailnet for the current name and API port, and stops when that check fails', async () => {
    const world = fakeWorld({ serve: { ok: false, checks: [{ path: '/admin', pass: false, detail: 'HTTP 401: something answers on this path' }] } });
    const run = await runSetup(world);
    expect(world.tailscale.verifyCalls).toEqual([[PC.dnsName, { apiPort: 8766 }]]);
    expect(stepStatus(run).pc).toBe('failed');
    expect(run.steps.find((s) => s.id === 'pc').detail).toMatch(/\/admin: HTTP 401/);
    expect(world.calls.some((c) => c.argv[3] === 'install')).toBe(false);
    expect(run.ready).toBe(false);
  });

  it('is not Ready without the tailnet policy confirmation, even when every check passes', async () => {
    const world = fakeWorld();
    const run = await runSetup(world, { authKey: KEY });
    expect(run.steps.every((s) => s.status === 'done' || s.status === 'skipped')).toBe(true);
    expect(run.isolation).toBe('pass');
    expect(run.serve).toMatchObject({ dnsName: PC.dnsName, apiPort: 8766, ok: true });
    expect(run.ready).toBe(false);
    expect(run.readyDetail).toMatch(/I replaced the tailnet policy with the R1CORD policy/);
  });
});

describe('download consent', () => {
  const installs = (world) => world.calls.filter((c) => c.argv[3] === 'install').map((c) => c.argv.slice(3));

  it('without the box asks only for bundled or cached APKs, and a missing one names the box', async () => {
    const world = fakeWorld({ apks: { r1cord: APK_VERSIONS.r1cord, controls: APK_VERSIONS.controls }, installed: { 'com.chippwalters.r1cord': 17 } });
    const run = await runSetup(world);
    expect(world.apkCalls.map((c) => [c.entry, c.options])).toEqual([
      ['r1cord', { configDir: world.state.configDir, allowDownload: false }],
      ['controls', { configDir: world.state.configDir, allowDownload: false }],
      ['tailscale', { configDir: world.state.configDir, allowDownload: false }],
    ]);
    expect(stepStatus(run)['install-tailscale']).toBe('failed');
    expect(run.steps.find((s) => s.id === 'install-tailscale').detail).toMatch(/tick “Download missing or newer apps from the R1CORD release server”/);
    expect(installs(world)).toEqual([['install', '-r', 'C:\\apk\\controls.apk']]);
  });

  it('with the box ticked may use the release server', async () => {
    const world = fakeWorld({ apks: { r1cord: APK_VERSIONS.r1cord, controls: APK_VERSIONS.controls }, remoteApks: APK_VERSIONS, installed: { 'com.chippwalters.r1cord': 17 } });
    const run = await runSetup(world, { authKey: KEY, policyConfirmed: true, allowDownload: true });
    expect(world.apkCalls.every((c) => c.options.allowDownload === true && c.options.config === world.state.config)).toBe(true);
    expect(stepStatus(run)['install-tailscale']).toBe('done');
  });

  describe('against the real updater', () => {
    function isolate() {
      const dir = tmpDir();
      vi.stubEnv('LOCALAPPDATA', dir);
      vi.stubEnv('XDG_CONFIG_HOME', dir);
      const fetches = [];
      vi.stubGlobal('fetch', async (url) => {
        fetches.push(String(url));
        return new Response('unavailable', { status: 503 });
      });
      return fetches;
    }
    // R1CORD and the helper are "installed" newer than anything bundled, so only Tailscale — never
    // bundled — needs an APK from somewhere.
    const INSTALLED = { 'com.chippwalters.r1cord': 999, 'com.chippwalters.r1cord.controls': 999 };

    it('makes no request without the box and fails the missing Tailscale APK with the reason', async () => {
      const fetches = isolate();
      const world = fakeWorld({ updatesModule: realUpdates, installed: { ...INSTALLED } });
      const run = await runSetup(world);
      expect(fetches).toEqual([]);
      expect(stepStatus(run)['install-tailscale']).toBe('failed');
      expect(run.steps.find((s) => s.id === 'install-tailscale').detail).toMatch(/tick “Download missing or newer apps/);
      expect(world.calls.some((c) => c.argv[3] === 'install')).toBe(false);
    });

    it('fetches the release list only once the box is ticked', async () => {
      const fetches = isolate();
      const world = fakeWorld({ updatesModule: realUpdates, installed: { ...INSTALLED } });
      await runSetup(world, { authKey: KEY, policyConfirmed: true, allowDownload: true });
      expect(fetches[0]).toBe(MANIFEST_URL);
      expect(world.calls.some((c) => c.argv[3] === 'install')).toBe(false);
    });
  });
});

describe('R1 app updates', () => {
  const NEWER = { ...APK_VERSIONS, r1cord: { ...APK_VERSIONS.r1cord, versionCode: 18, versionName: '0.4.1' } };
  const CURRENT = { 'com.chippwalters.r1cord': 17, 'com.chippwalters.r1cord.controls': 1, 'com.tailscale.ipn': 298177930 };
  const R1CORD_UPDATE = {
    entry: 'r1cord',
    name: 'R1CORD',
    package: 'com.chippwalters.r1cord',
    from: { versionName: '0.4.0', versionCode: 17 },
    to: { versionName: '0.4.1', versionCode: 18 },
  };

  function updateWorld(mode, opts = {}) {
    const world = fakeWorld({ apks: NEWER, installed: { ...CURRENT }, ...opts });
    world.state.config.r1_auto_update = mode;
    return world;
  }
  const installs = (world) => world.calls.filter((c) => c.argv[3] === 'install').map((c) => c.argv.slice(3));

  it('off does nothing at all', async () => {
    const world = updateWorld('off');
    expect(await world.manager.autoUpdate(world.state, SERIAL)).toBe(null);
    expect(world.calls).toEqual([]);
    expect(world.manager.r1Updates()).toEqual([]);
  });

  it('ask records the pending update without installing or touching maintenance', async () => {
    const world = updateWorld('ask');
    const check = await world.manager.autoUpdate(world.state, SERIAL);
    expect(check).toMatchObject({ serial: SERIAL, items: [R1CORD_UPDATE], error: null });
    expect(installs(world)).toEqual([]);
    expect(world.methods).toEqual([]);
    expect(world.manager.r1Updates()).toMatchObject([{ serial: SERIAL, installing: false, lastResult: null, check: { items: [R1CORD_UPDATE] } }]);
    // Update checks are off: only bundled or cached APKs are compared.
    expect(world.apkCalls.every((c) => c.options.allowDownload === false)).toBe(true);
  });

  it('asks the release server only while update checks are on', async () => {
    const world = updateWorld('ask');
    world.state.config.update_check = true;
    await world.manager.checkForUpdate(world.state, SERIAL);
    expect(world.apkCalls).toHaveLength(3);
    expect(world.apkCalls.every((c) => c.options.allowDownload === true && c.options.config === world.state.config)).toBe(true);
  });

  it('install installs with -r inside maintenance, ends it, and clears the pending update', async () => {
    const world = updateWorld('install');
    const result = await world.manager.autoUpdate(world.state, SERIAL);
    expect(result).toMatchObject({ ok: true });
    expect(installs(world)).toEqual([['install', '-r', 'C:\\apk\\r1cord.apk']]);
    const scripts = world.calls.map((c) => c.argv.join(' '));
    const begin = scripts.findIndex((s) => s.includes("'BEGIN_MAINTENANCE'"));
    const install = world.calls.findIndex((c) => c.argv[3] === 'install');
    expect(begin).toBeGreaterThan(-1);
    expect(begin).toBeLessThan(install);
    expect(world.methods.at(-1)).toBe('END_MAINTENANCE');
    expect(world.manager.r1Updates()).toMatchObject([{ serial: SERIAL, check: null, lastResult: { ok: true } }]);
    expect([world.state.usb.suspended, world.state.usb.resumed]).toEqual([1, 1]);
  });

  it('install leaves a busy R1 alone and keeps the update pending', async () => {
    const world = updateWorld('install');
    world.o.status = { ...world.o.status, busy: true, upload: true };
    const result = await world.manager.autoUpdate(world.state, SERIAL);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/busy \(upload\)/);
    expect(installs(world)).toEqual([]);
    expect(world.methods).not.toContain('BEGIN_MAINTENANCE');
    expect(world.manager.r1Updates()[0]).toMatchObject({ check: { items: [R1CORD_UPDATE] }, lastResult: { ok: false } });
  });

  it('updates a pre-gate R1CORD like any other app: -r, no maintenance call to the old app, and a note', async () => {
    const world = updateWorld('install', { installed: { ...CURRENT, 'com.chippwalters.r1cord': 14 } });
    const result = await world.manager.autoUpdate(world.state, SERIAL);
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/versionCode 14 has no SetupProvider/);
    expect(installs(world)).toEqual([['install', '-r', 'C:\\apk\\r1cord.apk']]);
    // Only the freshly installed app (which has the gate) is put into and taken out of maintenance.
    const install = world.calls.findIndex((c) => c.argv[3] === 'install');
    const begin = world.calls.findIndex((c) => String(c.argv[4] || '').includes("'BEGIN_MAINTENANCE'"));
    expect(begin).toBeGreaterThan(install);
    expect(world.methods.at(-1)).toBe('END_MAINTENANCE');
    expect(world.manager.r1Updates()).toMatchObject([{ serial: SERIAL, check: null, lastResult: { ok: true } }]);
  });

  it('refuses an install with nothing pending, and a setup run while an install is running', async () => {
    const world = updateWorld('ask');
    await expect(world.manager.installUpdates(world.state, SERIAL)).rejects.toThrow(/no R1 app update is waiting/);
    await world.manager.checkForUpdate(world.state, SERIAL);
    let release;
    world.o.suspendGate = new Promise((resolve) => (release = resolve));
    const job = world.manager.installUpdates(world.state, SERIAL);
    expect(() => world.manager.start(world.state, SERIAL, {})).toThrow(/update is running/);
    release();
    expect((await job).ok).toBe(true);
  });
});

describe('Setup page: Share /v1', () => {
  async function openSetup() {
    const root = tmpDir();
    const config = withUpdates(defaultConfig(), {
      datastore: path.join(root, 'datastore'),
      webdav_folder: path.join(root, 'publish'),
      public_url_base: 'https://example.test/files',
      admin_password: 'test-admin-pass1',
      listen_port: 8765,
    });
    const configPath = path.join(root, 'config.toml');
    saveConfig(config, configPath);
    const app = createApp(config, { configPath, noWorker: true, noUsb: true, logger: createLogger({ sink: () => {} }) });
    await app.ready();
    app.state.usb = { status: () => ({ enabled: true, adb: 'fake-adb', connected: [], syncing: null, last_error: null }) };
    // The routes hold the manager's tailscale object: swap its methods for fakes.
    const tailscale = app.state.setup.tailscale;
    tailscale.status = async () => ({ ...PC });
    const post = (serve) =>
      app.inject({ method: 'POST', url: '/admin/setup/serve', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `serve=${serve}` });
    return { app, tailscale, post, page: async () => (await app.inject({ method: 'GET', url: '/admin/setup' })).body };
  }

  it('shows the tailnet approval link when Serve is not enabled, and drops it once sharing works', async () => {
    const env = await openSetup();
    try {
      const url = 'https://login.tailscale.com/f/serve?node=nABC123CNTRL';
      env.tailscale.enableServe = async () => {
        throw new ServeConsentError(url);
      };
      const refused = await env.post('on');
      expect(refused.statusCode).toBe(303);
      expect(refused.headers.location).toBe('/admin/setup#remote');
      expect(env.app.state.config.tailscale_serve).toBe(false);
      const page = await env.page();
      expect(page).toContain('Serve is not enabled on your tailnet yet');
      expect(page).toContain('<a href="https://login.tailscale.com/f/serve?node=nABC123CNTRL" target="_blank" rel="noopener">');
      expect(page).toContain('press Share /v1 again');

      env.tailscale.enableServe = async () => {};
      const shared = await env.post('on');
      expect(shared.headers.location).toMatch(/notice=Sharing/);
      expect(env.app.state.config.tailscale_serve).toBe(true);
      expect(await env.page()).not.toContain('Serve is not enabled on your tailnet yet');
    } finally {
      await env.app.close();
    }
  });
});

describe('saved result and local apps', () => {
  it('a Ready run stamps the saved record, an unrelated failure keeps it, a failed isolation test removes it', async () => {
    const world = fakeWorld();
    const ready = await runSetup(world);
    expect(ready.ready).toBe(true);
    expect(readRecords(world.state.configDir)[SERIAL].readyAt).toBe(ready.finishedAt);

    world.o.model = 'Pixel 7';
    const refused = await runSetup(world);
    expect(stepStatus(refused).identity).toBe('failed');
    expect(readRecords(world.state.configDir)[SERIAL].readyAt).toBe(ready.finishedAt);

    world.o.model = 'Rabbit R1';
    world.o.otherProbe = { 443: 'open' };
    const leaky = await runSetup(world);
    expect(leaky.isolation).toBe('fail');
    const record = readRecords(world.state.configDir)[SERIAL];
    expect(record).toMatchObject({ serial: SERIAL, nodeId: 'nR1' });
    expect(record).not.toHaveProperty('readyAt');
  });

  it('lists the verified apps already on this PC without asking the release server', async () => {
    const world = fakeWorld({ apks: { r1cord: APK_VERSIONS.r1cord, controls: APK_VERSIONS.controls } });
    world.state.config.update_check = true;
    expect(await world.manager.localApks(world.state)).toEqual({
      r1cord: { versionName: '0.4.0', versionCode: 17 },
      controls: { versionName: '1.0.0', versionCode: 1 },
      tailscale: null,
    });
    expect(world.apkCalls.map((c) => c.options.allowDownload)).toEqual([false, false, false]);
  });
});

describe('Setup page workflow', () => {
  const CONFIG = { tailscale_serve: false, api_port: 8766, update_manifest_url: MANIFEST_URL };
  const ALL_APPS = {
    r1cord: { versionName: '0.4.0', versionCode: 17 },
    controls: { versionName: '1.0.0', versionCode: 1 },
    tailscale: { versionName: '1.102.4', versionCode: 298177930 },
  };
  const NOT_INSTALLED = { installed: false, running: false, backendState: '', dnsName: '', hostName: '', tailscaleIPs: [], tags: [], peers: [], keyExpiry: null, error: null };
  const RECORD = { serial: SERIAL, nodeId: 'nR1', ip: '100.64.0.9', dnsName: R1_PEER.dnsName, verifiedAt: '2026-09-26T09:00:00Z' };
  const ORDER = ['install', 'signin', 'share', 'policy', 'tag', 'key', 'r1'];

  function render(overrides = {}) {
    const page = {
      path: '/admin/setup',
      config: CONFIG,
      ts: PC,
      install: { active: false },
      loginUrl: null,
      serveConsentUrl: null,
      verify: null,
      policy: policySnippet(),
      apps: null,
      devices: [],
      local: true,
      error: null,
      notice: null,
      ...overrides,
    };
    return String(setupView(page));
  }
  const device = (extra = {}) => ({ serial: SERIAL, connected: true, run: null, record: null, ...extra });
  const states = (page) => Object.fromEntries([...page.matchAll(/data-step="(\w+)" data-state="(\w+)"/g)].map((m) => [m[1], m[2]]));
  const numbers = (page) => [...page.matchAll(/class="wf-num">(\d+)</g)].map((m) => Number(m[1]));
  function dialogOf(page) {
    const start = page.indexOf('<dialog class="run-dialog"');
    return start < 0 ? null : { start, end: page.indexOf('</dialog>', start), html: page.slice(start, page.indexOf('</dialog>', start)) };
  }

  it('before Tailscale is installed: step 1 needs you and everything after it is blocked', () => {
    const page = render({ ts: NOT_INSTALLED, devices: [device()] });
    expect(numbers(page)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(Object.keys(states(page))).toEqual(ORDER);
    expect(states(page)).toEqual({ install: 'todo', signin: 'blocked', share: 'blocked', policy: 'blocked', tag: 'blocked', key: 'blocked', r1: 'blocked' });
    expect(page).toContain('action="/admin/setup/tailscale/install"');
  });

  it('signed in with an untagged PC: sharing, policy, tag and key need you; Set up R1 waits for sharing', () => {
    const page = render({ ts: { ...PC, tags: [] }, devices: [device()], apps: ALL_APPS });
    expect(states(page)).toEqual({ install: 'done', signin: 'done', share: 'todo', policy: 'todo', tag: 'todo', key: 'todo', r1: 'blocked' });
    expect(page).toContain('Finish step 3 first.');
  });

  it('when everything is done every step is done and folded to its one-line summary', () => {
    const page = render({ config: { ...CONFIG, tailscale_serve: true }, devices: [device({ record: { ...RECORD, readyAt: '2026-09-26T09:05:00Z' } })], apps: ALL_APPS });
    expect(states(page)).toEqual(Object.fromEntries(ORDER.map((id) => [id, 'done'])));
    expect(page).not.toMatch(/<details class="wf" open>/);
    expect(page.match(/class="wf-summary">✓ /g)).toHaveLength(7);
  });

  it('a failed tailnet check puts Share /v1 back to needs you', () => {
    const verify = { ok: false, at: 'now', checks: [{ path: '/admin', status: 401, expected: '404', pass: false, detail: 'answers' }] };
    const page = render({ config: { ...CONFIG, tailscale_serve: true }, verify });
    expect(states(page).share).toBe('todo');
  });

  it('hides the download box when every app is already on this PC, and shows it when one is missing', () => {
    const all = render({ devices: [device()], apps: ALL_APPS });
    expect(all).not.toContain('name="download"');
    expect(all).toContain('Apps on this PC: R1CORD 0.4.0, controls 1.0.0, Tailscale 1.102.4');
    const missing = render({ devices: [device()], apps: { ...ALL_APPS, tailscale: null } });
    expect(missing).toContain('name="download"');
    expect(missing).toContain('Not on this PC yet: Tailscale.');
    expect(missing).not.toContain('name="attended"');
  });

  it('renders an active run only inside its dialog, with Close disabled until the run ends', () => {
    const steps = [
      { id: 'identity', label: 'Check this is the Rabbit R1', status: 'done', detail: 'Rabbit R1 · gsi_r1' },
      { id: 'pc', label: 'This PC on the tailnet', status: 'running', detail: '' },
    ];
    const active = { serial: SERIAL, active: true, startedAt: '2026-09-26T09:00:00Z', steps, isolation: null, ready: false, readyDetail: '', error: null };
    const page = render({ devices: [device({ run: active })], apps: ALL_APPS });
    const dialog = dialogOf(page);
    expect(dialog.html).toContain(`Setting up ${SERIAL}`);
    expect(dialog.html).toContain('Keep the R1 plugged in.');
    expect(dialog.html).toContain('data-active="1"');
    expect(dialog.html).toMatch(/data-close-run\s+disabled/);
    // The step list exists once, inside the dialog; the page underneath has no inline copy.
    expect(page.split('<ol class="steps">')).toHaveLength(2);
    const list = page.indexOf('<ol class="steps">');
    expect(list).toBeGreaterThan(dialog.start);
    expect(list).toBeLessThan(dialog.end);
    expect(page.slice(0, dialog.start)).not.toContain('Check this is the Rabbit R1');

    const finished = { ...active, active: false, steps: steps.map((s) => ({ ...s, status: 'done' })), readyDetail: 'tailnet isolation inconclusive' };
    const after = dialogOf(render({ devices: [device({ run: finished })], apps: ALL_APPS }));
    expect(after.html).not.toMatch(/data-close-run\s+disabled/);
    expect(after.html).toContain('Not ready: tailnet isolation inconclusive');
    expect(after.html).not.toContain('Keep the R1 plugged in.');
  });
});
