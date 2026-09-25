// Fastify application factory. Used by index.js and by Vitest.
// Port of r1cord_server/app.py: recover interrupted jobs, Cache-Control, JSON errors. The worker
// and the USB watcher always exist (the admin reads their state); noWorker / noUsb only keep them
// from starting, as R1CORD_NO_WORKER / R1CORD_NO_USB do in Python.

'use strict';

require('./sqlite-warning');

const fs = require('node:fs');
const path = require('node:path');
const Fastify = require('fastify');
const { JobStore } = require('./store');
const { setupFileLogger, logHandled, requestPath } = require('./log');
const { HttpError } = require('./http-error');
const { registerApi } = require('./api');
const { registerAdmin } = require('./admin/routes');
const { sendFile } = require('./admin/send-file');
const defaultMailer = require('./mailer');
const { UsbWatcher } = require('./usb');
const { Worker } = require('./worker');
const { acquireDatastoreLock, releaseDatastoreLock } = require('./lock');
const { createModelDownload } = require('./pipeline/model-download');
const { createPlatformToolsDownload } = require('./platform-tools');

const STATIC_ROOT = path.join(__dirname, '..', '..', 'r1cord_server', 'static');
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

function monotonicSeconds() {
  return Number(process.hrtime.bigint()) / 1e9;
}

/** Last user activity: an open admin window counts as "now". One place the idle check reads. */
function activityAt(state, now = monotonicSeconds()) {
  if (state && state.windowOpen) return now;
  return state ? state.last_activity : now;
}

function sendJsonError(request, reply, statusCode, error, message, extra, headers) {
  if (headers) {
    for (const [key, value] of Object.entries(headers)) reply.header(key, value);
  }
  return reply.code(statusCode).send({ error, message, ...extra });
}

function createApp(config, options = {}) {
  const configPath = options.configPath || path.join(path.dirname(String(config.datastore)), 'config.toml');
  const promptsDir = path.join(path.dirname(configPath), 'prompts');
  const logger = options.logger || setupFileLogger(config);
  const appLog = logger.getLogger('r1cord_server.app');
  const apiLog = logger.getLogger('r1cord_server.api');
  const lock = options.lock === false ? null : acquireDatastoreLock(config.datastore);
  let app;
  try {
    app = buildApp(config, options, { configPath, promptsDir, logger, appLog, apiLog, lock });
  } catch (error) {
    releaseDatastoreLock(lock);
    throw error;
  }
  return app;
}

function buildApp(config, options, { configPath, promptsDir, logger, appLog, apiLog, lock }) {
  const store = options.store || new JobStore(config, { logger: logger.getLogger('r1cord_server.store') });

  for (const [jobId, was, now] of store.recoverInterrupted()) {
    appLog.warning(`job ${jobId} was left ${was} by the previous run; now ${now}`);
  }

  const noWorker = options.noWorker === true || process.env.R1CORD_NO_WORKER === '1';
  const noUsb = options.noUsb === true || process.env.R1CORD_NO_USB === '1';

  const mailer = options.mailer || defaultMailer;
  const worker = new Worker({
    store,
    config,
    promptsDir,
    logger: appLog,
    mailer,
    spawnWorker: options.spawnWorker || null,
  });

  const startedAt = monotonicSeconds();
  const state = {
    config,
    store,
    worker,
    usb: null,
    mailer,
    // Settings > Pages > Republish all pages runs in the background; the last run's results live here.
    republish: worker.republisher,
    configPath,
    config_path: configPath,
    // Folder of config.toml: the Devices page installs platform-tools/adb.exe here.
    configDir: path.dirname(configPath),
    promptsDir,
    prompts_dir: promptsDir,
    logger,
    loggers: { app: appLog, api: apiLog },
    lastActivity: startedAt,
    last_activity: startedAt,
    windowOpen: false,
    lock,
    host: null,
    modelDownload: options.modelDownload || createModelDownload(),
    platformTools: options.platformTools || createPlatformToolsDownload(),
    request_exit: options.requestExit || (() => {}),
    requestExit: options.requestExit || (() => {}),
    open_dashboard: options.openDashboard || (() => {}),
    openDashboard: options.openDashboard || (() => {}),
  };

  state.usb = new UsbWatcher(store, () => state.config, {
    requestExit: () => state.requestExit(),
    lastActivity: () => activityAt(state),
    openDashboard: () => state.openDashboard(),
    onImported: () => worker.wake(),
    logger: logger.getLogger('r1cord_server.usb'),
    configDir: state.configDir,
  });

  const app = Fastify({
    logger: false,
    trustProxy: false,
    bodyLimit: 1024 * 1024,
    requestTimeout: 0,
    connectionTimeout: 0,
    exposeHeadRoutes: true,
    routerOptions: {
      ignoreTrailingSlash: false,
      caseSensitive: true,
      maxParamLength: 512,
    },
  });

  const usb = state.usb;
  app.decorate('state', state);

  app.addContentTypeParser('*', (request, payload, done) => {
    done(null, payload);
  });

  app.addHook('onRequest', (request, _reply, done) => {
    const at = monotonicSeconds();
    request.server.state.lastActivity = at;
    request.server.state.last_activity = at;
    done();
  });

  app.addHook('onSend', (request, reply, payload, done) => {
    reply.header('Cache-Control', 'no-store');
    done(null, payload);
  });

  registerApi(app);
  registerAdmin(app);

  if (fs.existsSync(STATIC_ROOT)) {
    app.get('/static/*', async (request, reply) => {
      const rel = String(request.params['*'] || '');
      if (!rel || rel.split(/[\\/]/).includes('..')) {
        return sendJsonError(request, reply, 404, 'not_found', 'Not Found', {});
      }
      const file = path.resolve(STATIC_ROOT, rel);
      const root = path.resolve(STATIC_ROOT);
      const prefix = process.platform === 'win32' ? root.toLowerCase() + path.sep : root + path.sep;
      const target = process.platform === 'win32' ? file.toLowerCase() : file;
      if (target !== (process.platform === 'win32' ? root.toLowerCase() : root) && !target.startsWith(prefix)) {
        return sendJsonError(request, reply, 404, 'not_found', 'Not Found', {});
      }
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        return sendJsonError(request, reply, 404, 'not_found', 'Not Found', {});
      }
      return sendFile(request, reply, file);
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const pathname = requestPath(request);
    const allowed = METHODS.filter(
      (method) => method !== request.method && app.hasRoute({ method, url: pathname }),
    );
    if (allowed.length) {
      reply.header('allow', allowed.join(', '));
      logHandled(appLog, request, 405, 'http_error');
      return sendJsonError(request, reply, 405, 'http_error', 'Method Not Allowed', {});
    }
    logHandled(appLog, request, 404, 'not_found');
    return sendJsonError(request, reply, 404, 'not_found', 'Not Found', {});
  });

  app.setErrorHandler((error, request, reply) => {
    if (reply.sent) return;
    if (error instanceof HttpError) {
      logHandled(appLog, request, error.statusCode, error.error, error.message);
      if (typeof error.html === 'string') {
        if (error.headers) {
          for (const [key, value] of Object.entries(error.headers)) reply.header(key, value);
        }
        return reply.code(error.statusCode).type('text/html; charset=utf-8').send(error.html);
      }
      return sendJsonError(request, reply, error.statusCode, error.error, error.message, error.extra, error.headers);
    }
    const code = error && error.code;
    if (code === 'FST_ERR_CTP_INVALID_JSON_BODY' || code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
      logHandled(appLog, request, 422, 'invalid_request');
      return sendJsonError(request, reply, 422, 'invalid_request', 'JSON decode error', {});
    }
    if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || error.statusCode === 415) {
      logHandled(appLog, request, 415, 'http_error', 'Unsupported Media Type');
      return sendJsonError(request, reply, 415, 'http_error', 'Unsupported Media Type', {});
    }
    if (error.statusCode === 405) {
      logHandled(appLog, request, 405, 'http_error');
      return sendJsonError(request, reply, 405, 'http_error', 'Method Not Allowed', {});
    }
    const logger = apiLog;
    const where = `${request.method} ${requestPath(request)}`;
    logger.warning(`${where} -> 500 internal_error | ${error.name}: ${error.message}`, error);
    return sendJsonError(request, reply, 500, 'internal_error', 'unexpected server error', {});
  });

  app.addHook('onClose', async () => {
    try {
      if (state.modelDownload && typeof state.modelDownload.cancel === 'function') state.modelDownload.cancel();
      if (state.platformTools && typeof state.platformTools.cancel === 'function') state.platformTools.cancel();
    } catch (_error) {
      // shutdown must finish
    }
    try {
      await worker.stop();
    } catch (_error) {
      // shutdown must finish
    }
    try {
      await usb.stop();
    } catch (_error) {
      // shutdown must finish
    }
    try {
      store.close();
    } catch (_error) {
      // already closed
    }
    try {
      releaseDatastoreLock(state.lock);
    } catch (_error) {
      // shutdown must finish
    }
    state.lock = null;
  });

  if (!noWorker) worker.start();
  if (!noUsb) usb.start();

  return app;
}

module.exports = { createApp, activityAt, monotonicSeconds };
