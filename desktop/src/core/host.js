// Host bridge between the Node core and an Electron utilityProcess parent.
//
// The core has no Electron imports. Call installHost() after the HTTP server is
// listening. Plain `node src/core/index.js` has no process.parentPort: every
// method is a no-op except requestExit(), which runs onShutdown so idle exit
// still works.
//
// API returned by installHost({ port, desktop, logger, onShutdown, onWindowOpen }):
//   connected          true when process.parentPort can post
//   spawnWorker(script, args, options)
//                      -> {postMessage, on('message'|'exit'), kill}  (parentPort only)
//   openDashboard()    -> { type: 'openDashboard' }
//   requestExit()      -> { type: 'requestExit' } (or onShutdown when disconnected)
//   runModeChanged(m)  -> { type: 'runModeChanged', mode: m }
//
// When connected, installHost:
//   posts { type: 'ready', port } once
//   routes desktop reveal: desktop.setHostReveal(p => post { type: 'reveal', path: p })
//   handles main -> core { type: 'shutdown' }           -> onShutdown()
//           main -> core { type: 'windowOpen', open }   -> onWindowOpen(open)
//
// ASR worker broker (ELECTRON-PLAN §3.1): the core never child_process.forks the ASR worker
// when a parentPort exists (Electron's RunAsNode fuse may be off). It posts
//   { type: 'asr:start', id, script, args, env }
// and main forks a utilityProcess (serviceName 'R1CORD ASR'). Messages go both ways over
// parentPort keyed by id (asr:post, asr:message, asr:kill, asr:exit) rather than a transferred
// MessageChannelMain port: the worker already talks to its parent on process.parentPort, one
// relay in main is enough, and the same shape is easy to fake in tests.
//
// index.js should wire openDashboard (USB watcher), requestExit (plug-mode idle
// exit), and onWindowOpen (count an open window as activity). See the slice report.

'use strict';

const crypto = require('node:crypto');

function parentPort() {
  const port = process.parentPort;
  if (port && typeof port.postMessage === 'function') return port;
  return null;
}

function listen(port, handler) {
  if (typeof port.on === 'function') port.on('message', handler);
  else if (typeof port.addListener === 'function') port.addListener('message', handler);
}

function unlisten(port, handler) {
  if (typeof port.off === 'function') port.off('message', handler);
  else if (typeof port.removeListener === 'function') port.removeListener('message', handler);
}

/**
 * Ask main to fork the ASR worker as a utilityProcess and relay its messages.
 * @param {string} script
 * @param {string[]} [args]
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {{postMessage: Function, on: Function, kill: Function}}
 */
function spawnWorker(script, args = [], options = {}) {
  const parent = parentPort();
  if (!parent) {
    throw new Error('host.spawnWorker requires process.parentPort');
  }
  const id = crypto.randomUUID();
  const handlers = { message: [], exit: [] };
  let exited = false;
  const onMessage = (raw) => {
    const payload = payloadOf(raw);
    if (!payload || typeof payload !== 'object' || payload.id !== id) return;
    if (payload.type === 'asr:message') {
      handlers.message.forEach((handler) => handler(payload.message));
      return;
    }
    if (payload.type === 'asr:exit') {
      if (exited) return;
      exited = true;
      unlisten(parent, onMessage);
      const code = payload.code;
      const detail = payload.detail || '';
      handlers.exit.forEach((handler) => handler(code, detail));
    }
  };
  listen(parent, onMessage);
  parent.postMessage({
    type: 'asr:start',
    id,
    script,
    args: Array.isArray(args) ? args : [],
    env: options.env,
  });
  return {
    postMessage(message) {
      parent.postMessage({ type: 'asr:post', id, message });
    },
    on(event, handler) {
      if (handlers[event]) handlers[event].push(handler);
    },
    kill() {
      parent.postMessage({ type: 'asr:kill', id });
    },
  };
}

function payloadOf(message) {
  if (message == null || typeof message !== 'object') return message;
  if (Object.prototype.hasOwnProperty.call(message, 'type')) return message;
  if (Object.prototype.hasOwnProperty.call(message, 'data')) return message.data;
  return message;
}

/**
 * @param {{port?: number, desktop?: {setHostReveal?: Function}, logger?: object,
 *          onShutdown?: Function, onWindowOpen?: Function}} [options]
 */
function installHost(options = {}) {
  const port = options.port;
  const desktop = options.desktop;
  const onShutdown = options.onShutdown;
  const onWindowOpen = options.onWindowOpen;
  const parent = parentPort();
  const connected = Boolean(parent);

  function post(message) {
    if (!connected) return false;
    parent.postMessage(message);
    return true;
  }

  if (connected) {
    post({ type: 'ready', port });
    if (desktop && typeof desktop.setHostReveal === 'function') {
      desktop.setHostReveal((filePath) => {
        post({ type: 'reveal', path: filePath });
      });
    }
    const onMessage = (message) => {
      const payload = payloadOf(message);
      if (!payload || typeof payload !== 'object') return;
      if (payload.type === 'shutdown') {
        if (typeof onShutdown === 'function') onShutdown();
        return;
      }
      if (payload.type === 'windowOpen') {
        if (typeof onWindowOpen === 'function') onWindowOpen(Boolean(payload.open));
      }
    };
    listen(parent, onMessage);
  }

  return {
    connected,
    spawnWorker: connected ? spawnWorker : null,
    openDashboard() {
      post({ type: 'openDashboard' });
    },
    requestExit() {
      if (connected) {
        post({ type: 'requestExit' });
        return;
      }
      if (typeof onShutdown === 'function') onShutdown();
    },
    runModeChanged(mode) {
      post({ type: 'runModeChanged', mode });
    },
  };
}

module.exports = { installHost, payloadOf, spawnWorker };
