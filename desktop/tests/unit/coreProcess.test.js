import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { CoreProcess, SERVICE_NAME, startupModeForRunMode } = require('../../src/main/services/core/CoreProcess');
const {
  nodeCoreDescriptor,
  nodeCoreInput,
} = require('../../src/main/services/settings');

function fakeUtilityChild() {
  const handlers = {};
  const posted = [];
  return {
    pid: 9001,
    posted,
    stdout: { on() {} },
    stderr: { on() {} },
    postMessage(msg) {
      posted.push(msg);
    },
    on(event, fn) {
      (handlers[event] ||= []).push(fn);
    },
    once(event, fn) {
      (handlers[event] ||= []).push(fn);
    },
    kill: vi.fn(function kill() {
      (handlers.exit || []).forEach((fn) => fn(1));
    }),
    emit(event, ...args) {
      (handlers[event] || []).forEach((fn) => fn(...args));
    },
  };
}

describe('startupModeForRunMode', () => {
  it('maps core run_mode to the shell startup pref', () => {
    expect(startupModeForRunMode('always')).toBe('login');
    expect(startupModeForRunMode('plug')).toBe('plug');
    expect(startupModeForRunMode('nope')).toBeNull();
  });
});

describe('nodeCoreDescriptor', () => {
  it('builds the same flags the Node core CLI accepts', () => {
    const input = nodeCoreInput(
      { configPath: 'D:\\tmp\\config.toml', port: 8797, noUsb: true, noWorker: true },
      { appPath: 'D:\\app' },
    );
    expect(nodeCoreDescriptor.resolveExecutable(input).replace(/\\/g, '/')).toBe(
      'D:/app/src/core/index.js',
    );
    expect(nodeCoreDescriptor.buildArgs(input)).toEqual([
      '--config',
      'D:\\tmp\\config.toml',
      '--port',
      '8797',
      '--no-usb',
      '--no-worker',
    ]);
    expect(nodeCoreDescriptor.buildEnv(input)).toMatchObject({
      R1CORD_NO_USB: '1',
      R1CORD_NO_WORKER: '1',
    });
  });
});

describe('CoreProcess', () => {
  it('forks with serviceName R1CORD core and piped stdio', async () => {
    const child = fakeUtilityChild();
    const forkImpl = vi.fn(() => child);
    const core = new CoreProcess({
      forkImpl,
      delay: async () => {},
      fetchImpl: async () => ({ ok: false, status: 404 }),
    });
    const ready = new Promise((resolve) => {
      core.supervise(
        nodeCoreInput(
          { configPath: 'D:\\tmp\\config.toml', port: 8797, noUsb: true },
          { appPath: 'D:\\app' },
        ),
        {
          probeUrl: 'http://127.0.0.1:8797/admin',
          onReady: resolve,
        },
      );
      queueMicrotask(() => child.emit('message', { type: 'ready', port: 8797 }));
    });
    await ready;
    expect(forkImpl).toHaveBeenCalledTimes(1);
    const [script, args, opts] = forkImpl.mock.calls[0];
    expect(path.normalize(script)).toBe(
      path.normalize('D:\\app\\src\\core\\index.js'),
    );
    expect(args).toEqual(['--config', 'D:\\tmp\\config.toml', '--port', '8797', '--no-usb']);
    expect(opts).toMatchObject({ serviceName: SERVICE_NAME, stdio: 'pipe' });
  });

  it('treats the ready message as readiness without a successful HTTP probe', async () => {
    const child = fakeUtilityChild();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 }));
    const core = new CoreProcess({
      forkImpl: () => child,
      delay: async () => {},
      fetchImpl,
    });
    await new Promise((resolve) => {
      core.supervise({ scriptPath: 'src/core/index.js', port: 8797, cwd: '.' }, {
        probeUrl: 'http://127.0.0.1:8797/admin/api/status',
        onReady: resolve,
      });
      child.emit('message', { type: 'ready', port: 8797 });
    });
    expect(core.isRunning()).toBe(true);
  });

  it('falls back to the HTTP probe when no ready message arrives', async () => {
    const child = fakeUtilityChild();
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    let t = 0;
    const core = new CoreProcess({
      forkImpl: () => child,
      now: () => t,
      delay: async (ms) => {
        t += ms;
      },
      fetchImpl,
    });
    await new Promise((resolve) => {
      core.supervise({ scriptPath: 'src/core/index.js', port: 8797, cwd: '.' }, {
        probeUrl: 'http://127.0.0.1:8797/admin',
        onReady: resolve,
      });
    });
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('dispatches core -> main messages', async () => {
    const child = fakeUtilityChild();
    const handlers = {
      reveal: vi.fn(),
      openDashboard: vi.fn(),
      requestExit: vi.fn(),
      runModeChanged: vi.fn(),
    };
    const core = new CoreProcess({
      forkImpl: () => child,
      handlers,
      delay: async () => {},
      fetchImpl: async () => ({ ok: true }),
    });
    await new Promise((resolve) => {
      core.supervise({ scriptPath: 'x', cwd: '.' }, { onReady: resolve });
      child.emit('message', { type: 'ready', port: 8797 });
    });
    child.emit('message', { type: 'reveal', path: 'D:\\a' });
    child.emit('message', { type: 'openDashboard' });
    child.emit('message', { type: 'requestExit' });
    child.emit('message', { type: 'runModeChanged', mode: 'always' });
    expect(handlers.reveal).toHaveBeenCalledWith('D:\\a');
    expect(handlers.openDashboard).toHaveBeenCalledTimes(1);
    expect(handlers.requestExit).toHaveBeenCalledTimes(1);
    expect(handlers.runModeChanged).toHaveBeenCalledWith('always');
  });

  it('posts shutdown then kills on graceful stop, and posts windowOpen', async () => {
    const child = fakeUtilityChild();
    const core = new CoreProcess({
      forkImpl: () => child,
      delay: async () => {},
      fetchImpl: async () => ({ ok: true }),
      killTreeImpl: () => {},
    });
    core.supervise({ scriptPath: 'x', cwd: '.' }, { probeUrl: 'http://127.0.0.1:8797/admin' });
    expect(core.sendWindowOpen(true)).toBe(true);
    expect(child.posted).toContainEqual({ type: 'windowOpen', open: true });
    await core.stopGracefully({ timeoutMs: 10 });
    expect(child.posted).toContainEqual({ type: 'shutdown' });
    expect(child.kill).toHaveBeenCalled();
  });

  it('restarts a crashed node core with the sidecar backoff chain', async () => {
    const children = [];
    const forkImpl = vi.fn(() => {
      const child = fakeUtilityChild();
      child.pid = 9000 + children.length;
      children.push(child);
      return child;
    });
    const restarts = [];
    const core = new CoreProcess({
      forkImpl,
      delay: async () => {},
      fetchImpl: async () => ({ ok: true }),
    });
    let resolveReady;
    const nextReady = () => new Promise((resolve) => {
      resolveReady = resolve;
    });
    await core.supervise({ scriptPath: 'x', port: 8797, cwd: '.' }, {
      probeUrl: 'http://127.0.0.1:8797/admin',
      backoffMs: 500,
      maxBackoffMs: 8000,
      onReady: () => resolveReady && resolveReady(),
      onRestart: ({ delayMs }) => restarts.push(delayMs),
    });
    expect(forkImpl).toHaveBeenCalledTimes(1);
    const ready = nextReady();
    children[0].emit('exit', 1);
    await ready;
    expect(restarts[0]).toBe(500);
    expect(forkImpl).toHaveBeenCalledTimes(2);
  });
});
