const { SidecarManager } = require('../sidecar/SidecarManager');
const { nodeCoreDescriptor } = require('../settings');
const { AsrBroker } = require('./AsrBroker');

const NAME = 'core';
const SERVICE_NAME = 'R1CORD core';

function startupModeForRunMode(mode) {
  if (mode === 'always') return 'login';
  if (mode === 'plug') return 'plug';
  return null;
}

class CoreProcess {
  constructor({
    sidecar,
    forkImpl,
    logger = console,
    handlers = {},
    fetchImpl,
    delay,
    now,
    killTreeImpl,
    serviceName = SERVICE_NAME,
    asrWorkerScript = null,
  } = {}) {
    this.logger = logger;
    this.handlers = handlers;
    this.forkImpl = forkImpl;
    this.serviceName = serviceName;
    this.name = NAME;
    this.asrBroker = new AsrBroker({ forkImpl, logger, workerScript: asrWorkerScript });

    this.sidecar = sidecar || new SidecarManager({
      descriptors: { [NAME]: nodeCoreDescriptor },
      spawnImpl: (modulePath, args, spawnOptions) => this._fork(modulePath, args, spawnOptions),
      fetchImpl,
      delay,
      now,
      logger,
      killTreeImpl,
    });
  }

  _fork(modulePath, args, spawnOptions) {
    if (typeof this.forkImpl !== 'function') {
      throw new Error('utilityProcess.fork is required to run the Node core');
    }
    const child = this.forkImpl(modulePath, args, {
      serviceName: this.serviceName,
      stdio: 'pipe',
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
    });
    if (!child) throw new Error('utilityProcess.fork returned null');
    if (typeof child.on === 'function') {
      child.on('exit', () => this.asrBroker.killAll());
    }
    return child;
  }

  supervise(input, opts = {}) {
    return this.sidecar.supervise(this.name, input, {
      probeUrl: opts.probeUrl,
      probeTimeoutMs: opts.probeTimeoutMs,
      backoffMs: opts.backoffMs,
      maxBackoffMs: opts.maxBackoffMs,
      readyFromMessage: true,
      onReady: opts.onReady,
      onRestart: opts.onRestart,
      onCleanExit: opts.onCleanExit,
      onMessage: (msg) => this._dispatch(msg),
    });
  }

  _dispatch(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (this.asrBroker.handle(msg, this.child())) return;
    const handlers = this.handlers;
    switch (msg.type) {
      case 'ready':
        if (typeof handlers.ready === 'function') handlers.ready(msg.port);
        break;
      case 'reveal':
        if (typeof handlers.reveal === 'function') handlers.reveal(msg.path);
        break;
      case 'openDashboard':
        if (typeof handlers.openDashboard === 'function') handlers.openDashboard();
        break;
      case 'requestExit':
        if (typeof handlers.requestExit === 'function') handlers.requestExit();
        break;
      case 'runModeChanged':
        if (typeof handlers.runModeChanged === 'function') handlers.runModeChanged(msg.mode);
        break;
      default:
        break;
    }
  }

  child() {
    return this.sidecar.processes.get(this.name);
  }

  post(message) {
    const child = this.child();
    if (child && typeof child.postMessage === 'function') {
      child.postMessage(message);
      return true;
    }
    return false;
  }

  sendWindowOpen(open) {
    return this.post({ type: 'windowOpen', open: Boolean(open) });
  }

  sendShutdown() {
    return this.post({ type: 'shutdown' });
  }

  isRunning() {
    return this.sidecar.isRunning(this.name);
  }

  async stopGracefully({ timeoutMs = 8000 } = {}) {
    this.asrBroker.killAll();
    return this.sidecar.stopGracefully(this.name, {
      timeoutMs,
      shutdown: async () => {
        this.sendShutdown();
      },
    });
  }

  stopAll() {
    this.asrBroker.killAll();
    this.sidecar.stopAll();
  }
}

module.exports = { CoreProcess, NAME, SERVICE_NAME, startupModeForRunMode };
