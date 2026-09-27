// Admin routes for the Setup page: Tailscale on this PC (consented install, sign-in, the /v1 share
// and its outside check) and the per-R1 USB setup runs with their JSON progress. Every route runs
// requireAdminHook first, exactly like ./routes.js, and reads the form only after it. Anything that
// changes this PC or a device, or carries an auth key, is refused unless the request comes from the
// server PC itself (as the platform-tools download is). It also hands the USB watcher the
// r1_auto_update hook: when an adopted R1 is plugged in, the setup manager checks (ask) or checks
// and installs (install) verified R1 app updates.

'use strict';

const path = require('node:path');
const { isLocalDirect, requireAdminHook } = require('../auth');
const { saveConfig, withUpdates } = require('../config');
const { HttpError } = require('../http-error');
const { requestPath } = require('../log');
const { SERIAL_RE } = require('../adb-secret');
const { SetupError, apiPortOf, createSetupManager, pickOtherPeer } = require('../setup');
const { redirectLocation } = require('./format');
const { setup: setupView } = require('./views/setup');

const FORM_BODY_LIMIT = 64 * 1024;
const LOCAL_ONLY = 'Only available on the server PC itself.';

async function readForm(request) {
  const type = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const stream = request.body;
  const chunks = [];
  let size = 0;
  if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > FORM_BODY_LIMIT) throw new HttpError(413, 'http_error', 'Request Entity Too Large');
      chunks.push(chunk);
    }
  }
  return new URLSearchParams(type === 'application/x-www-form-urlencoded' ? Buffer.concat(chunks).toString('utf8') : '');
}

// FastAPI's Form(): the last value wins and an empty string counts as absent.
function formValue(form, name) {
  const values = form.getAll(name);
  const last = values.length ? values[values.length - 1] : '';
  return last === '' ? null : last;
}

/** Save config.toml and swap the live config into every component that holds one (as routes.js does). */
function applyConfig(state, newConfig) {
  saveConfig(newConfig, state.configPath);
  state.config = newConfig;
  state.store.config = newConfig;
  state.worker.config = newConfig;
}

function redirect(reply, url) {
  return reply.code(303).header('location', redirectLocation(url)).send();
}

function queryValue(request, name) {
  const url = String(request.raw.url || '');
  const q = url.indexOf('?');
  return new URLSearchParams(q === -1 ? '' : url.slice(q + 1)).get(name);
}

function sendHtml(reply, content, status = 200) {
  return reply.code(status).type('text/html; charset=utf-8').send(String(content));
}

function appLog(state) {
  return (state.loggers && state.loggers.app) || { info() {}, warning() {} };
}

function message(error) {
  return String((error && error.message) || error);
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{manager?: object}} [options] tests inject a setup manager with fake runners
 */
function registerSetupRoutes(app, options = {}) {
  if (!app.state.setup) app.state.setup = options.manager || createSetupManager();
  const manager = app.state.setup;
  const tailscale = manager.tailscale;
  // Page state that only lives as long as this process: the last sign-in URL, the tailnet's Serve
  // approval URL and the Serve check.
  const memo = { loginUrl: null, serveConsentUrl: null, verify: null };

  const usb = app.state.usb;
  if (usb && typeof usb.setDeviceConnectedHandler === 'function') {
    usb.setDeviceConnectedHandler((serial) => {
      const state = app.state;
      // Detached: the watcher never waits on a check or an install.
      manager.autoUpdate(state, serial).catch((error) => appLog(state).warning(`updates: ${serial}: ${message(error)}`));
    });
  }

  async function setupPage(request, reply) {
    const state = request.server.state;
    const ts = await tailscale.status();
    if (ts.running) memo.loginUrl = null;
    const usb = state.usb.status();
    const connected = new Set(usb.connected.map(([serial]) => serial));
    const records = manager.records(state.configDir);
    const devices = state.store
      .devices()
      .filter((d) => d.adopted)
      .map((d) => ({ serial: d.serial, connected: connected.has(d.serial), run: manager.snapshot(d.serial), record: records[d.serial] || null }));
    const install = tailscale.installSnapshot();
    // Only the Set up R1 form needs to know which APKs are already here.
    const apps = devices.length ? await manager.localApks(state) : null;
    const other = ts.running ? pickOtherPeer(ts.peers, ts.tailscaleIPs) : null;
    const body = setupView({
      path: requestPath(request),
      config: state.config,
      refresh: install.active,
      ts,
      install,
      loginUrl: memo.loginUrl,
      serveConsentUrl: memo.serveConsentUrl,
      verify: memo.verify,
      policy: tailscale.policySnippet({ otherHostIp: other ? other.ip : null }),
      apps,
      devices,
      local: isLocalDirect(request),
      error: queryValue(request, 'error'),
      notice: queryValue(request, 'notice'),
    });
    return sendHtml(reply, body);
  }

  async function tailscaleInstall(request, reply) {
    if (!isLocalDirect(request)) return sendHtml(reply, LOCAL_ONLY, 403);
    const state = request.server.state;
    const form = await readForm(request);
    if (formValue(form, 'consent') !== 'yes') return redirect(reply, '/admin/setup?error=Tick the box to agree to the download and install first.');
    const log = appLog(state);
    tailscale
      .installMsi({ consent: true, dir: path.join(state.configDir, 'tailscale-msi') })
      .catch((error) => log.warning(`tailscale: install failed: ${message(error)}`));
    return redirect(reply, '/admin/setup');
  }

  async function tailscaleLogin(request, reply) {
    if (!isLocalDirect(request)) return sendHtml(reply, LOCAL_ONLY, 403);
    try {
      const { url } = await tailscale.login();
      memo.loginUrl = url;
      return redirect(reply, url ? '/admin/setup' : '/admin/setup?notice=Tailscale is signed in.');
    } catch (error) {
      return redirect(reply, `/admin/setup?error=${encodeURIComponent(message(error))}`);
    }
  }

  async function serveToggle(request, reply) {
    if (!isLocalDirect(request)) return sendHtml(reply, LOCAL_ONLY, 403);
    const state = request.server.state;
    const form = await readForm(request);
    const on = formValue(form, 'serve') === 'on';
    try {
      if (on) await tailscale.enableServe(apiPortOf(state));
      else await tailscale.disableServe();
    } catch (error) {
      if (on && error && error.needsConsent && error.url) {
        memo.serveConsentUrl = error.url;
        return redirect(reply, '/admin/setup#remote');
      }
      return redirect(reply, `/admin/setup?error=${encodeURIComponent(message(error))}`);
    }
    memo.serveConsentUrl = null;
    applyConfig(state, withUpdates(state.config, { tailscale_serve: on }));
    memo.verify = null;
    return redirect(reply, `/admin/setup?notice=${on ? 'Sharing /v1 on the tailnet. Press Verify to check it from outside.' : 'No longer sharing /v1.'}`);
  }

  async function serveVerify(request, reply) {
    if (!isLocalDirect(request)) return sendHtml(reply, LOCAL_ONLY, 403);
    const ts = await tailscale.status();
    if (!ts.running || !ts.dnsName) return redirect(reply, '/admin/setup?error=Tailscale on this PC is not connected.');
    try {
      memo.verify = { ...(await tailscale.verifyServe(ts.dnsName, { apiPort: apiPortOf(request.server.state) })), at: new Date().toLocaleString() };
    } catch (error) {
      return redirect(reply, `/admin/setup?error=${encodeURIComponent(message(error))}`);
    }
    return redirect(reply, '/admin/setup#remote');
  }

  async function runStart(request, reply) {
    if (!isLocalDirect(request)) return sendHtml(reply, LOCAL_ONLY, 403);
    const state = request.server.state;
    const { serial } = request.params;
    if (!SERIAL_RE.test(serial) || !state.store.adoptedSerials().has(serial)) {
      return redirect(reply, '/admin/setup?error=Adopt the R1 on the Devices page first.');
    }
    const form = await readForm(request);
    const authKey = formValue(form, 'authkey');
    const allowDownload = formValue(form, 'download') === 'yes';
    const policyConfirmed = formValue(form, 'policy') === 'yes';
    try {
      manager.start(state, serial, { authKey: authKey ? authKey.trim() : null, allowDownload, policyConfirmed });
    } catch (error) {
      if (!(error instanceof SetupError)) throw error;
      return redirect(reply, `/admin/setup?error=${encodeURIComponent(error.message)}#r1-${serial}`);
    }
    return redirect(reply, `/admin/setup#r1-${serial}`);
  }

  async function runStatus(request, reply) {
    const file = String(request.params.file || '');
    const serial = file.endsWith('.json') ? file.slice(0, -'.json'.length) : '';
    if (!SERIAL_RE.test(serial)) throw new HttpError(404, 'not_found', 'Not Found');
    const run = manager.snapshot(serial) || { serial, active: false, steps: [], isolation: null, ready: false, error: null };
    return reply.code(200).header('cache-control', 'no-store').send(run);
  }

  app.register(async (admin) => {
    // Bodies stay unread streams until the handler, which runs after requireAdmin.
    admin.removeAllContentTypeParsers();
    admin.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
    const guard = { preHandler: [requireAdminHook] };
    admin.get('/admin/setup', guard, setupPage);
    admin.post('/admin/setup/tailscale/install', guard, tailscaleInstall);
    admin.post('/admin/setup/tailscale/login', guard, tailscaleLogin);
    admin.post('/admin/setup/serve', guard, serveToggle);
    admin.post('/admin/setup/verify', guard, serveVerify);
    admin.post('/admin/setup/run/:serial', guard, runStart);
    admin.get('/admin/setup/run/:file', guard, runStatus);
  });
}

module.exports = { registerSetupRoutes };
