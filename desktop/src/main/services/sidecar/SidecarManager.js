const { spawn } = require('child_process');

// The core prints its first-run admin password to stdout (it is also saved in config.toml);
// desktop.log must never hold it, since logs get shared for support.
function redactSecrets(text) {
  return text.replace(/(admin password:\s*)\S+/gi, '$1<saved in config.toml>');
}

function nextBackoff(current, max) {
  const start = current > 0 ? current : 1;
  return Math.min(start * 2, max);
}

// The line a crashed sidecar's stderr is about: its first line that is not a stack frame.
function errorLine(text) {
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line && !/^at\s/.test(line)) return line;
  }
  return '';
}

function payloadOf(message) {
  if (message == null || typeof message !== 'object') return message;
  if (Object.prototype.hasOwnProperty.call(message, 'type')) return message;
  if (Object.prototype.hasOwnProperty.call(message, 'data')) return message.data;
  return message;
}

function defaultKillTree(pid, spawnImpl = spawn, platform = process.platform) {
  if (!pid || pid < 0) return;
  if (platform === 'win32') {
    spawnImpl('taskkill', ['/T', '/F', '/PID', String(pid)], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch (_err) {
    // already gone
  }
}

class SidecarManager {
  constructor({
    descriptors = {},
    logger = console,
    spawnImpl = spawn,
    fetchImpl = globalThis.fetch,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    killTreeImpl,
  } = {}) {
    this.descriptors = descriptors;
    this.logger = logger;
    this.spawnImpl = spawnImpl;
    this.fetchImpl = fetchImpl;
    this.delay = delay;
    this.now = now;
    this.killTreeImpl = killTreeImpl || ((pid) => defaultKillTree(pid, spawnImpl));
    this.processes = new Map();
    this._stopping = new Set();
    this._supervise = new Map();
    // Why each sidecar last failed (its stderr error line, or how it spawned/exited), for onRestart.
    this._lastError = new Map();
  }

  getDescriptor(name) {
    const descriptor = this.descriptors[name];
    if (!descriptor) {
      throw new Error(`Unknown sidecar: ${name}`);
    }
    return descriptor;
  }

  buildProcessOptions(name, input = {}) {
    const descriptor = this.getDescriptor(name);
    const executable = descriptor.resolveExecutable(input);
    const args = descriptor.buildArgs ? descriptor.buildArgs(input) : [];
    const cwd = descriptor.resolveCwd ? descriptor.resolveCwd(input) : process.cwd();
    const env = descriptor.buildEnv ? descriptor.buildEnv(input) : {};

    if (!executable || typeof executable !== 'string') {
      throw new Error(`Sidecar ${name} did not resolve an executable`);
    }
    if (!Array.isArray(args)) {
      throw new Error(`Sidecar ${name} buildArgs must return an array`);
    }

    return {
      executable,
      args,
      cwd,
      env,
      spawnOptions: {
        cwd,
        env: { ...process.env, ...env },
        shell: false,
        windowsHide: true,
      },
    };
  }

  start(name, input = {}) {
    if (this.processes.has(name)) {
      throw new Error(`Sidecar already running: ${name}`);
    }

    const options = this.buildProcessOptions(name, input);
    this._lastError.delete(name);
    let child;
    try {
      child = this.spawnImpl(options.executable, options.args, options.spawnOptions);
    } catch (err) {
      this.logger.error?.(`[${name}] spawn failed`, { error: err.message });
      this._lastError.set(name, `spawn failed: ${err.message}`);
      this._noteDeath(name, 1, null);
      return null;
    }
    this.processes.set(name, child);

    let settled = false;
    const settle = (code, signal, kind) => {
      if (settled) return;
      settled = true;
      this.processes.delete(name);
      if (kind === 'exit') this.logger.info?.(`[${name}] exited`, { code, signal });
      this._noteDeath(name, kind === 'error' ? 1 : code, kind === 'error' ? null : signal);
    };

    const pipeLog = (chunk) => {
      const text = redactSecrets(String(chunk == null ? '' : chunk).trim());
      if (text) this.logger.info?.(`[${name}] ${text}`);
      return text;
    };
    const pipeError = (chunk) => this._noteStderr(name, pipeLog(chunk));
    const attachStdio = () => {
      if (child.stdout && !child.stdout._r1cordLogged) {
        child.stdout._r1cordLogged = true;
        child.stdout.on('data', pipeLog);
      }
      if (child.stderr && !child.stderr._r1cordLogged) {
        child.stderr._r1cordLogged = true;
        child.stderr.on('data', pipeError);
      }
    };
    attachStdio();
    if (typeof child.on === 'function') child.on('spawn', attachStdio);

    if (typeof child.on === 'function') {
      child.on('message', (message) => {
        const data = payloadOf(message);
        const spec = this._supervise.get(name);
        if (data && data.type === 'ready' && spec && typeof spec.resolveReady === 'function') {
          spec.resolveReady(true);
        }
        if (spec && typeof spec.onMessage === 'function') spec.onMessage(data);
      });
    }

    child.on('exit', (code, signal) => settle(code, signal, 'exit'));
    child.on('error', (err) => {
      const error = err && err.message ? err.message : String(err);
      this.logger.error?.(`[${name}] spawn failed`, { error });
      this._lastError.set(name, `spawn failed: ${error}`);
      settle(1, null, 'error');
    });

    return child;
  }

  // A stderr error line becomes the failure reason; one that lands after the exit was already
  // reported (stdio can trail the exit event) re-sends onRestart with the better reason.
  _noteStderr(name, text) {
    const line = errorLine(text);
    if (!line) return;
    this._lastError.set(name, line);
    const spec = this._supervise.get(name);
    if (spec && spec.restartPending && spec.restartInfo && typeof spec.onRestart === 'function') {
      spec.restartInfo = { ...spec.restartInfo, reason: line };
      spec.onRestart(spec.restartInfo);
    }
  }

  _kill(name) {
    const child = this.processes.get(name);
    if (!child) return false;
    const pid = child.pid;
    try {
      child.kill();
    } catch (_err) {
      // already gone
    }
    if (pid) this.killTreeImpl(pid);
    this.processes.delete(name);
    return true;
  }

  stop(name) {
    return this._kill(name);
  }

  stopAll() {
    for (const name of Array.from(this.processes.keys())) {
      this.stop(name);
    }
  }

  isRunning(name) {
    return this.processes.has(name);
  }

  /**
   * Resolve once the sidecar answers `url` with a 2xx, or `readyPromise` resolves; whichever
   * is first. The ready message cuts a pending probe or poll wait short.
   */
  async waitUntilReady({ url, timeoutMs = 60000, intervalMs = 200, isAborted, readyPromise } = {}) {
    if (!url && !readyPromise) throw new Error('readiness url is required');
    const started = this.now();
    let lastError = 'timeout';
    let ready = false;
    let readySignal = null;
    if (readyPromise) {
      readySignal = new Promise((resolve) => {
        Promise.resolve(readyPromise).then(
          () => {
            ready = true;
            resolve();
          },
          (err) => {
            lastError = err && err.message ? err.message : String(err);
          },
        );
      });
    }
    const orReady = (promise) => (readySignal ? Promise.race([promise, readySignal]) : promise);
    while (this.now() - started < timeoutMs) {
      if (ready) return true;
      if (isAborted && isAborted()) {
        throw new Error('sidecar exited before ready');
      }
      if (url) {
        try {
          const res = await orReady(this.fetchImpl(url));
          if (ready) return true;
          if (res && res.ok) return true;
          lastError = `HTTP ${res ? res.status : 'no response'}`;
        } catch (err) {
          lastError = err && err.message ? err.message : String(err);
        }
      }
      await orReady(this.delay(intervalMs));
      if (ready) return true;
      if (isAborted && isAborted()) {
        throw new Error('sidecar exited before ready');
      }
    }
    if (ready) return true;
    throw new Error(`sidecar not ready after ${timeoutMs}ms: ${lastError}`);
  }

  supervise(name, input, {
    probeUrl,
    probeTimeoutMs = 60000,
    backoffMs = 500,
    maxBackoffMs = 8000,
    readyFromMessage = false,
    onReady,
    onCleanExit,
    onRestart,
    onMessage,
  } = {}) {
    this._stopping.delete(name);
    this._supervise.set(name, {
      input,
      probeUrl,
      probeTimeoutMs,
      backoffMs,
      maxBackoffMs,
      currentBackoff: backoffMs,
      generation: 0,
      restartPending: false,
      readyFromMessage: Boolean(readyFromMessage),
      onReady,
      onCleanExit,
      onRestart,
      onMessage,
    });
    return this._launch(name);
  }

  _noteDeath(name, code, signal) {
    if (this._stopping.has(name)) return;
    const spec = this._supervise.get(name);
    if (!spec) return;
    spec.generation = (spec.generation || 0) + 1;
    if (!spec.lastFailure) {
      spec.lastFailure = signal ? `stopped (${signal})` : `exited with code ${code}`;
    }
    if (code === 0 && !signal) {
      this._supervise.delete(name);
      if (typeof spec.onCleanExit === 'function') spec.onCleanExit();
      return;
    }
    this._scheduleRestart(name);
  }

  async _launch(name) {
    const spec = this._supervise.get(name);
    if (!spec || this._stopping.has(name) || spec.restartPending) return;
    spec.generation = (spec.generation || 0) + 1;
    const generation = spec.generation;
    spec.readyPromise = new Promise((resolve) => {
      spec.resolveReady = resolve;
    });
    spec.lastFailure = null;
    try {
      if (!this.processes.has(name)) {
        const child = this.start(name, spec.input);
        if (!child) return;
      }
      if (spec.probeUrl || spec.readyFromMessage) {
        await this.waitUntilReady({
          url: spec.probeUrl,
          timeoutMs: spec.probeTimeoutMs,
          readyPromise: spec.readyFromMessage ? spec.readyPromise : undefined,
          isAborted: () => (
            this._stopping.has(name)
            || spec.generation !== generation
            || !this.processes.has(name)
          ),
        });
      }
      if (spec.generation !== generation || this._stopping.has(name)) return;
      spec.currentBackoff = spec.backoffMs;
      if (typeof spec.onReady === 'function') spec.onReady();
    } catch (err) {
      if (spec.generation !== generation || this._stopping.has(name) || spec.restartPending) return;
      this.logger.error?.(`[${name}] failed to start`, { error: err.message });
      spec.lastFailure = err.message;
      if (this.processes.has(name)) this._kill(name);
      this._scheduleRestart(name);
    }
  }

  async _scheduleRestart(name) {
    const spec = this._supervise.get(name);
    if (!spec || this._stopping.has(name)) return;
    if (spec.restartPending) return;
    spec.restartPending = true;
    spec.generation = (spec.generation || 0) + 1;
    const wait = spec.currentBackoff;
    spec.restartInfo = { delayMs: wait, reason: this._lastError.get(name) || spec.lastFailure || '' };
    if (typeof spec.onRestart === 'function') spec.onRestart(spec.restartInfo);
    await new Promise((resolve) => {
      spec.wakeRestart = resolve;
      Promise.resolve(this.delay(wait)).then(resolve, resolve);
    });
    spec.wakeRestart = null;
    spec.restartInfo = null;
    spec.currentBackoff = spec.retryRequested ? spec.backoffMs : nextBackoff(spec.currentBackoff, spec.maxBackoffMs);
    spec.retryRequested = false;
    spec.restartPending = false;
    if (this._stopping.has(name) || !this._supervise.has(name)) return;
    await this._launch(name);
  }

  /**
   * Skip the backoff wait of a supervised sidecar that failed and relaunch it now, with the
   * backoff reset. False when it is not waiting to restart (running, starting or not supervised).
   */
  retryNow(name) {
    const spec = this._supervise.get(name);
    if (!spec || this._stopping.has(name) || !spec.restartPending || typeof spec.wakeRestart !== 'function') {
      return false;
    }
    spec.retryRequested = true;
    spec.wakeRestart();
    return true;
  }

  async stopGracefully(name, { shutdown, timeoutMs = 8000 } = {}) {
    this._stopping.add(name);
    this._supervise.delete(name);
    const child = this.processes.get(name);
    if (!child) {
      this._stopping.delete(name);
      return true;
    }
    let exited = false;
    const done = new Promise((resolve) => {
      const finish = () => {
        exited = true;
        resolve();
      };
      if (typeof child.once === 'function') child.once('exit', finish);
      else child.on('exit', finish);
    });
    try {
      if (typeof shutdown === 'function') await shutdown();
    } catch (err) {
      this.logger.error?.(`[${name}] shutdown request failed`, { error: err.message });
    }
    await Promise.race([done, this.delay(timeoutMs)]);
    if (!exited) {
      this._kill(name);
      await Promise.race([done, this.delay(1000)]);
    }
    this.processes.delete(name);
    this._stopping.delete(name);
    return true;
  }
}

module.exports = { SidecarManager, nextBackoff, defaultKillTree, payloadOf, redactSecrets };
