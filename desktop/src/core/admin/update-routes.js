// Admin routes for updates: the Updates page, its settings (update-check consent, R1 auto-update
// choice), the explicit Check now, and Install for an R1 app update the setup manager found when
// the R1 was plugged in. Every route runs requireAdminHook first, exactly like the routes in
// ./routes.js, and reads the form only after it; Install also only from the server PC itself. The
// background checks are started and stopped by buildApp (src/core/app.js) through
// updates.startUpdateChecks.

'use strict';

const { SERIAL_RE } = require('../adb-secret');
const { isLocalDirect, requireAdminHook } = require('../auth');
const { saveConfig, withUpdates } = require('../config');
const { ValueError } = require('../errors');
const { HttpError } = require('../http-error');
const { logHandled, requestPath } = require('../log');
const updates = require('../updates');
const { redirectLocation } = require('./format');
const { updates: updatesView } = require('./views/updates');

const FORM_BODY_LIMIT = 1024 * 1024;
const R1_AUTO_UPDATE = ['off', 'ask', 'install'];
const LOCAL_ONLY = 'Only available on the server PC itself.';
// Where the banner's forms may send the browser back to: an admin page path, nothing else.
const RETURN_RE = /^\/admin(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9._~-]+)*$/;

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
  const previousMode = state.config.run_mode;
  saveConfig(newConfig, state.configPath);
  state.config = newConfig;
  state.store.config = newConfig;
  state.worker.config = newConfig;
  if (newConfig.run_mode !== previousMode) {
    const host = state.host;
    if (host && typeof host.runModeChanged === 'function') host.runModeChanged(newConfig.run_mode);
  }
}

function redirect(reply, url) {
  return reply.code(303).header('location', redirectLocation(url)).send();
}

function queryFlag(request, name) {
  const url = String(request.raw.url || '');
  const q = url.indexOf('?');
  return new URLSearchParams(q === -1 ? '' : url.slice(q + 1)).get(name) === '1';
}

function queryValue(request, name) {
  const url = String(request.raw.url || '');
  const q = url.indexOf('?');
  return new URLSearchParams(q === -1 ? '' : url.slice(q + 1)).get(name);
}

function warn(state, message) {
  const log = state.loggers && state.loggers.app;
  if (log && typeof log.warning === 'function') log.warning(message);
}

function r1UpdatesOf(state) {
  const setup = state.setup;
  return setup && typeof setup.r1Updates === 'function' ? setup.r1Updates() : [];
}

function registerUpdateRoutes(app) {
  async function updatesPage(request, reply) {
    const state = request.server.state;
    const r1 = r1UpdatesOf(state);
    const body = updatesView({
      path: requestPath(request),
      config: state.config,
      refresh: r1.some((row) => row.installing),
      updates: updates.updateState({ configDir: state.configDir }),
      saved: queryFlag(request, 'saved'),
      r1Updates: r1,
      local: isLocalDirect(request),
      error: queryValue(request, 'error'),
    });
    return reply.code(200).type('text/html; charset=utf-8').send(String(body));
  }

  async function updatesSettings(request, reply) {
    const state = request.server.state;
    const form = await readForm(request);
    const old = state.config;
    const changes = { update_check: formValue(form, 'update_check') === 'on', update_check_asked: true };
    const auto = formValue(form, 'r1_auto_update');
    if (auto !== null && R1_AUTO_UPDATE.includes(auto)) changes.r1_auto_update = auto;
    let newConfig;
    try {
      newConfig = withUpdates(old, changes);
    } catch (error) {
      if (!(error instanceof ValueError)) throw error;
      logHandled(state.loggers.app, request, 422, 'invalid_request');
      return reply.code(422).send({ error: 'invalid_request', message: error.message });
    }
    applyConfig(state, newConfig);
    // Consent just given: check now rather than at the next daily tick.
    if (newConfig.update_check && !old.update_check) {
      updates.fetchManifest(newConfig, { configDir: state.configDir }).catch((error) => warn(state, `update check: ${error.message}`));
    }
    const back = formValue(form, 'return_to');
    return redirect(reply, back !== null && RETURN_RE.test(back) ? back : '/admin/updates?saved=1');
  }

  async function updatesCheck(request, reply) {
    const state = request.server.state;
    try {
      await updates.fetchManifest(state.config, { force: true, configDir: state.configDir });
    } catch (error) {
      // updateState() carries the message to the page.
      warn(state, `update check: ${error.message}`);
    }
    return redirect(reply, '/admin/updates');
  }

  /** Install the R1 app update found for a plugged-in R1; runs in the background, the page polls. */
  async function r1Install(request, reply) {
    if (!isLocalDirect(request)) return reply.code(403).type('text/html; charset=utf-8').send(LOCAL_ONLY);
    const state = request.server.state;
    const { serial } = request.params;
    const setup = state.setup;
    const row = SERIAL_RE.test(serial) ? r1UpdatesOf(state).find((r) => r.serial === serial) : null;
    const check = row && row.check;
    if (!setup || !check || !check.items.length) {
      return redirect(reply, '/admin/updates?error=No R1 app update is waiting for that R1. Plug it in to check again.');
    }
    if (check.legacy) return redirect(reply, '/admin/updates?error=This R1CORD is too old to update here. Use Set up R1 while you are with the R1.');
    if (row.installing) return redirect(reply, '/admin/updates#r1-updates');
    setup.installUpdates(state, serial).catch((error) => warn(state, `updates: ${serial}: ${error.message}`));
    return redirect(reply, '/admin/updates#r1-updates');
  }

  app.register(async (admin) => {
    // Bodies stay unread streams until the handler, which runs after requireAdmin.
    admin.removeAllContentTypeParsers();
    admin.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
    const guard = { preHandler: [requireAdminHook] };
    admin.get('/admin/updates', guard, updatesPage);
    admin.post('/admin/updates/settings', guard, updatesSettings);
    admin.post('/admin/updates/check', guard, updatesCheck);
    admin.post('/admin/updates/r1/:serial/install', guard, r1Install);
  });
}

module.exports = { registerUpdateRoutes };
