import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SidecarManager, nextBackoff, redactSecrets } = require('../../src/main/services/sidecar/SidecarManager');

function fakeChild() {
  const handlers = {};
  return {
    pid: 4242,
    stdout: { on() {} },
    stderr: { on() {} },
    on(event, fn) {
      (handlers[event] ||= []).push(fn);
    },
    once(event, fn) {
      (handlers[event] ||= []).push(fn);
    },
    kill: vi.fn(function kill() {
      (handlers.exit || []).forEach((fn) => fn(null, 'SIGTERM'));
    }),
    emitExit(code, signal) {
      (handlers.exit || []).forEach((fn) => fn(code, signal));
    },
    emitError(err) {
      (handlers.error || []).forEach((fn) => fn(err));
    },
    emitMessage(msg) {
      (handlers.message || []).forEach((fn) => fn(msg));
    },
  };
}

const echoer = {
  echoer: {
    resolveExecutable: () => 'python',
    buildArgs: (input) => ['-m', 'r1cord_server', '--no-tray', '--port', String(input.port || 8775)],
    resolveCwd: () => 'D:/app',
    buildEnv: () => ({ R1CORD_NO_TRAY: '1' }),
  },
};

describe('SidecarManager', () => {
  it('builds process options from a descriptor without using shell command strings', () => {
    const manager = new SidecarManager({ descriptors: echoer });
    const options = manager.buildProcessOptions('echoer', { port: 8775 });
    expect(options).toMatchObject({
      executable: 'python',
      args: ['-m', 'r1cord_server', '--no-tray', '--port', '8775'],
      cwd: 'D:/app',
      spawnOptions: { shell: false, windowsHide: true },
    });
    expect(options.args.every((part) => typeof part === 'string')).toBe(true);
  });

  it('fails loudly for unknown sidecars', () => {
    const manager = new SidecarManager();
    expect(() => manager.buildProcessOptions('missing')).toThrow('Unknown sidecar: missing');
  });

  it('probes readiness until the status route answers', async () => {
    let t = 0;
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const manager = new SidecarManager({
      now: () => t,
      delay: async (ms) => {
        t += ms;
      },
      fetchImpl,
    });
    await expect(
      manager.waitUntilReady({ url: 'http://127.0.0.1:8775/admin/api/status', timeoutMs: 1000, intervalMs: 50 }),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('fails loudly when the sidecar never becomes ready', async () => {
    let t = 0;
    const manager = new SidecarManager({
      now: () => t,
      delay: async (ms) => {
        t += ms;
      },
      fetchImpl: vi.fn().mockRejectedValue(new Error('down')),
    });
    await expect(
      manager.waitUntilReady({ url: 'http://127.0.0.1:8775/admin/api/status', timeoutMs: 120, intervalMs: 50 }),
    ).rejects.toThrow(/sidecar not ready/);
  });

  it('restarts a crashed sidecar with doubling backoff', async () => {
    const delays = [];
    const children = [];
    const spawnImpl = vi.fn(() => {
      const child = fakeChild();
      children.push(child);
      return child;
    });
    const manager = new SidecarManager({
      descriptors: echoer,
      spawnImpl,
      delay: async (ms) => {
        delays.push(ms);
      },
      fetchImpl: async () => ({ ok: true }),
    });
    const restarts = [];
    let resolveReady;
    const nextReady = () => new Promise((resolve) => {
      resolveReady = resolve;
    });
    await manager.supervise('echoer', { port: 8775 }, {
      probeUrl: 'http://127.0.0.1:8775/admin/api/status',
      backoffMs: 500,
      maxBackoffMs: 8000,
      onReady: () => resolveReady && resolveReady(),
      onRestart: ({ delayMs }) => restarts.push(delayMs),
    });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    let ready = nextReady();
    children[0].emitExit(1, null);
    await ready;
    expect(restarts[0]).toBe(500);
    expect(delays[0]).toBe(500);
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    ready = nextReady();
    children[1].emitExit(1, null);
    await ready;
    expect(restarts[1]).toBe(500);
  });

  it('doubles backoff while the sidecar never becomes ready', async () => {
    const restarts = [];
    let t = 0;
    const manager = new SidecarManager({
      descriptors: echoer,
      spawnImpl: () => fakeChild(),
      now: () => t,
      delay: async (ms) => {
        t += ms;
      },
      fetchImpl: async () => {
        throw new Error('down');
      },
    });
    const twoRestarts = new Promise((resolve) => {
      manager.supervise('echoer', { port: 8775 }, {
        probeUrl: 'http://127.0.0.1:8775/admin/api/status',
        probeTimeoutMs: 1,
        backoffMs: 500,
        maxBackoffMs: 8000,
        onRestart: ({ delayMs }) => {
          restarts.push(delayMs);
          if (restarts.length >= 2) resolve();
        },
      });
    });
    await twoRestarts;
    await manager.stopGracefully('echoer');
    expect(restarts.slice(0, 2)).toEqual([500, 1000]);
  });

  it('does not restart a clean exit', async () => {
    const spawnImpl = vi.fn(() => fakeChild());
    const manager = new SidecarManager({
      descriptors: echoer,
      spawnImpl,
      delay: async () => {},
      fetchImpl: async () => ({ ok: true }),
    });
    let clean = 0;
    await manager.supervise('echoer', { port: 8775 }, {
      probeUrl: 'http://127.0.0.1:8775/admin/api/status',
      onCleanExit: () => {
        clean += 1;
      },
    });
    manager.processes.get('echoer').emitExit(0, null);
    expect(clean).toBe(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it('asks the sidecar to shut down and kills it after the timeout', async () => {
    const child = fakeChild();
    const manager = new SidecarManager({
      descriptors: echoer,
      spawnImpl: () => child,
      delay: async () => {},
      fetchImpl: async () => ({ ok: true }),
    });
    manager.start('echoer', { port: 8775 });
    const shutdown = vi.fn(async () => {});
    await manager.stopGracefully('echoer', { shutdown, timeoutMs: 10 });
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalled();
  });

  it('keeps a single growing restart chain when spawn emits error then exit', async () => {
    const delays = [];
    const spawnImpl = vi.fn(() => {
      const child = fakeChild();
      child.pid = 1000 + spawnImpl.mock.calls.length;
      queueMicrotask(() => {
        const err = new Error('spawn python ENOENT');
        err.code = 'ENOENT';
        child.emitError(err);
        child.emitExit(1, null);
      });
      return child;
    });
    let t = 0;
    const manager = new SidecarManager({
      descriptors: echoer,
      spawnImpl,
      now: () => t,
      delay: async (ms) => {
        delays.push(ms);
        t += ms;
      },
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
      killTreeImpl: () => {},
    });
    const restarts = [];
    const three = new Promise((resolve) => {
      manager.supervise('echoer', { port: 8775 }, {
        probeUrl: 'http://127.0.0.1:8775/admin/api/status',
        probeTimeoutMs: 90000,
        backoffMs: 500,
        maxBackoffMs: 8000,
        onRestart: ({ delayMs }) => {
          restarts.push(delayMs);
          if (restarts.length >= 3) resolve();
        },
      });
    });
    await three;
    await manager.stopGracefully('echoer');
    expect(restarts.slice(0, 3)).toEqual([500, 1000, 2000]);
    expect(delays.filter((ms) => ms === 200).length).toBeLessThan(10);
    expect(spawnImpl.mock.calls.length).toBeLessThan(8);
    expect(spawnImpl.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('kills the Windows process tree when graceful shutdown times out', async () => {
    const child = fakeChild();
    child.pid = 4242;
    const killTreeImpl = vi.fn();
    const manager = new SidecarManager({
      descriptors: echoer,
      spawnImpl: () => child,
      delay: async () => {},
      killTreeImpl,
    });
    manager.start('echoer', { port: 8775 });
    await manager.stopGracefully('echoer', { shutdown: async () => {}, timeoutMs: 10 });
    expect(killTreeImpl).toHaveBeenCalledWith(4242);
  });

  it('becomes ready on a parentPort ready message without a 200 probe', async () => {
    const child = fakeChild();
    let t = 0;
    const manager = new SidecarManager({
      descriptors: echoer,
      spawnImpl: () => child,
      now: () => t,
      delay: async (ms) => {
        t += ms;
      },
      fetchImpl: async () => ({ ok: false, status: 404 }),
    });
    await new Promise((resolve) => {
      manager.supervise('echoer', { port: 8775 }, {
        probeUrl: 'http://127.0.0.1:8775/admin/api/status',
        probeTimeoutMs: 1000,
        readyFromMessage: true,
        onReady: resolve,
      });
      child.emitMessage({ type: 'ready', port: 8775 });
    });
    expect(manager.isRunning('echoer')).toBe(true);
  });

  it('skips the kill when shutdown already exited the process', async () => {
    const child = fakeChild();
    const manager = new SidecarManager({
      descriptors: echoer,
      spawnImpl: () => child,
      delay: async () => {},
    });
    manager.start('echoer', { port: 8775 });
    const shutdown = vi.fn(async () => {
      child.emitExit(0, null);
    });
    await manager.stopGracefully('echoer', { shutdown, timeoutMs: 8000 });
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe('redactSecrets', () => {
  it('keeps the first-run admin password out of desktop.log', () => {
    const line = 'r1cord-server generated admin password: EdtMLKRMOk2iShrr';
    expect(redactSecrets(line)).toBe('r1cord-server generated admin password: <saved in config.toml>');
    expect(redactSecrets(line)).not.toMatch(/EdtMLKRMOk2iShrr/);
    expect(redactSecrets('asr: done')).toBe('asr: done');
  });
});

describe('nextBackoff', () => {
  it('doubles until the cap', () => {
    expect(nextBackoff(500, 8000)).toBe(1000);
    expect(nextBackoff(4000, 8000)).toBe(8000);
    expect(nextBackoff(8000, 8000)).toBe(8000);
  });
});
