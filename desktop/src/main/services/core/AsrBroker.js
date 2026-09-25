// Main-process broker for the per-job ASR utilityProcess (ELECTRON-PLAN §3.1).
//
// The core (itself a utilityProcess) cannot child_process.fork when Electron's RunAsNode fuse is
// off. It posts {type:'asr:start', id, script, args, env} on parentPort; this module forks
// utilityProcess.fork(script, args, {serviceName:'R1CORD ASR'}) and relays messages both ways
// keyed by id:
//   core -> main: asr:start, asr:post{message}, asr:kill
//   main -> core: asr:message{message}, asr:exit{code, detail}
// Relaying on parentPort (rather than transferring a MessageChannelMain port) keeps the worker's
// existing process.parentPort channel, and is the simpler robust option to fake in tests.

'use strict';

const path = require('node:path');

const SERVICE_NAME = 'R1CORD ASR';
const STDERR_TAIL_BYTES = 4096;

function payloadOf(message) {
  if (message == null || typeof message !== 'object') return message;
  if (Object.prototype.hasOwnProperty.call(message, 'type')) return message;
  if (Object.prototype.hasOwnProperty.call(message, 'data')) return message.data;
  return message;
}

class AsrBroker {
  /**
   * @param {{forkImpl: Function, logger?: object, workerScript?: string}} options
   *   forkImpl is Electron's utilityProcess.fork (injectable in tests). workerScript is the one
   *   script main ships for ASR; a request naming any other path is refused, so main only ever
   *   launches its own worker.
   */
  constructor({ forkImpl, logger = console, workerScript = null } = {}) {
    this.forkImpl = forkImpl;
    this.logger = logger;
    this.workerScript = workerScript ? path.resolve(workerScript) : null;
    this.children = new Map();
  }

  /**
   * Handle a core -> main asr:* message. Returns true when consumed.
   * @param {object} msg
   * @param {{postMessage?: Function}|null} coreChild
   */
  handle(msg, coreChild) {
    if (!msg || typeof msg !== 'object') return false;
    if (msg.type === 'asr:start') {
      this.start(msg, coreChild);
      return true;
    }
    if (msg.type === 'asr:post') {
      this.post(msg.id, msg.message);
      return true;
    }
    if (msg.type === 'asr:kill') {
      this.kill(msg.id);
      return true;
    }
    return false;
  }

  start(msg, coreChild) {
    const id = msg.id;
    if (id == null || !msg.script) {
      this._reply(coreChild, { type: 'asr:exit', id, code: 1, detail: 'asr:start requires id and script' });
      return;
    }
    if (this.workerScript && path.resolve(String(msg.script)).toLowerCase() !== this.workerScript.toLowerCase()) {
      this._reply(coreChild, { type: 'asr:exit', id, code: 1, detail: `asr:start refused: not the ASR worker: ${msg.script}` });
      return;
    }
    if (typeof this.forkImpl !== 'function') {
      this._reply(coreChild, { type: 'asr:exit', id, code: 1, detail: 'utilityProcess.fork is required to run the ASR worker' });
      return;
    }
    const env = { ...process.env, ...(msg.env || {}), R1CORD_ASR_SERVICE_NAME: SERVICE_NAME };
    let child;
    try {
      child = this.forkImpl(msg.script, Array.isArray(msg.args) ? msg.args : [], {
        serviceName: SERVICE_NAME,
        stdio: 'pipe',
        env,
      });
    } catch (error) {
      this._reply(coreChild, { type: 'asr:exit', id, code: 1, detail: error.message });
      return;
    }
    if (!child) {
      this._reply(coreChild, { type: 'asr:exit', id, code: 1, detail: 'utilityProcess.fork returned null' });
      return;
    }
    let stderr = '';
    if (child.stderr && typeof child.stderr.on === 'function') {
      if (typeof child.stderr.setEncoding === 'function') child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
      });
    }
    const record = { child, coreChild };
    this.children.set(id, record);
    if (typeof child.on === 'function') {
      child.on('message', (message) => {
        this._reply(coreChild, { type: 'asr:message', id, message: payloadOf(message) });
      });
      child.on('exit', (code) => {
        this.children.delete(id);
        this._reply(coreChild, { type: 'asr:exit', id, code, detail: stderr.trim() });
      });
    }
  }

  post(id, message) {
    const record = this.children.get(id);
    if (!record || typeof record.child.postMessage !== 'function') return false;
    record.child.postMessage(message);
    return true;
  }

  kill(id) {
    const record = this.children.get(id);
    if (!record) return false;
    try {
      record.child.kill();
    } catch (_error) {
      // already gone
    }
    return true;
  }

  killAll() {
    for (const id of Array.from(this.children.keys())) this.kill(id);
  }

  _reply(coreChild, message) {
    if (coreChild && typeof coreChild.postMessage === 'function') {
      coreChild.postMessage(message);
    }
  }
}

module.exports = { AsrBroker, SERVICE_NAME };
