import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AsrBroker, SERVICE_NAME } = require('../../src/main/services/core/AsrBroker');
const { CoreProcess } = require('../../src/main/services/core/CoreProcess');

function fakeUtilityChild() {
  const handlers = {};
  const posted = [];
  return {
    pid: 4242,
    posted,
    stdout: { on() {} },
    stderr: {
      setEncoding() {},
      on(event, fn) {
        (handlers[`stderr:${event}`] ||= []).push(fn);
      },
    },
    postMessage(msg) {
      posted.push(msg);
    },
    on(event, fn) {
      (handlers[event] ||= []).push(fn);
    },
    kill: vi.fn(function kill() {
      (handlers.exit || []).forEach((fn) => fn(null));
    }),
    emit(event, ...args) {
      (handlers[event] || []).forEach((fn) => fn(...args));
    },
  };
}

describe('AsrBroker', () => {
  it('forks only the ASR worker main ships and refuses any other script', () => {
    const coreChild = fakeUtilityChild();
    const forkImpl = vi.fn(() => fakeUtilityChild());
    const broker = new AsrBroker({ forkImpl, workerScript: 'D:\\app\\src\\asr-worker\\index.js' });

    broker.handle({ type: 'asr:start', id: 'evil', script: 'C:\\Users\\x\\payload.js', args: [] }, coreChild);
    expect(forkImpl).not.toHaveBeenCalled();
    expect(coreChild.posted[0]).toMatchObject({ type: 'asr:exit', id: 'evil', code: 1 });
    expect(coreChild.posted[0].detail).toMatch(/refused/);

    broker.handle({ type: 'asr:start', id: 'ok', script: 'D:\\APP\\src\\asr-worker\\index.js', args: [] }, coreChild);
    expect(forkImpl).toHaveBeenCalledTimes(1);
  });

  it('forks with serviceName R1CORD ASR, relays messages both ways, and kills on abort', () => {
    const asrChild = fakeUtilityChild();
    const coreChild = fakeUtilityChild();
    const forkImpl = vi.fn(() => asrChild);
    const broker = new AsrBroker({ forkImpl });

    expect(
      broker.handle(
        { type: 'asr:start', id: 'job-1', script: 'D:\\app\\src\\asr-worker\\index.js', args: [], env: { GGML_VK_DISABLE_COOPMAT: '1' } },
        coreChild,
      ),
    ).toBe(true);
    expect(forkImpl).toHaveBeenCalledTimes(1);
    const [script, args, opts] = forkImpl.mock.calls[0];
    expect(script).toBe('D:\\app\\src\\asr-worker\\index.js');
    expect(args).toEqual([]);
    expect(opts).toMatchObject({ serviceName: SERVICE_NAME, stdio: 'pipe' });
    expect(opts.env.GGML_VK_DISABLE_COOPMAT).toBe('1');
    expect(opts.env.R1CORD_ASR_SERVICE_NAME).toBe(SERVICE_NAME);

    broker.handle({ type: 'asr:post', id: 'job-1', message: { type: 'start', backend: 'vulkan' } }, coreChild);
    expect(asrChild.posted).toEqual([{ type: 'start', backend: 'vulkan' }]);

    asrChild.emit('message', { type: 'log', line: 'asr: vulkan device 0' });
    expect(coreChild.posted).toContainEqual({
      type: 'asr:message',
      id: 'job-1',
      message: { type: 'log', line: 'asr: vulkan device 0' },
    });

    broker.handle({ type: 'asr:kill', id: 'job-1' }, coreChild);
    expect(asrChild.kill).toHaveBeenCalled();
    asrChild.emit('exit', 0);
    expect(coreChild.posted).toContainEqual({ type: 'asr:exit', id: 'job-1', code: 0, detail: '' });
  });

  it('killAll ends every ASR child', () => {
    const a = fakeUtilityChild();
    const b = fakeUtilityChild();
    const children = [a, b];
    const broker = new AsrBroker({ forkImpl: () => children.shift() });
    const core = fakeUtilityChild();
    broker.handle({ type: 'asr:start', id: 'a', script: 'w.js' }, core);
    broker.handle({ type: 'asr:start', id: 'b', script: 'w.js' }, core);
    broker.killAll();
    expect(a.kill).toHaveBeenCalled();
    expect(b.kill).toHaveBeenCalled();
  });
});

describe('CoreProcess ASR broker', () => {
  it('routes asr:start from the core child and kills ASR workers on quit', async () => {
    const coreChild = fakeUtilityChild();
    const asrChild = fakeUtilityChild();
    const forkImpl = vi.fn((script) => (String(script).includes('asr-worker') ? asrChild : coreChild));
    const core = new CoreProcess({
      forkImpl,
      delay: async () => {},
      fetchImpl: async () => ({ ok: true }),
    });
    await new Promise((resolve) => {
      core.supervise({ scriptPath: 'src/core/index.js', cwd: '.' }, {
        probeUrl: 'http://127.0.0.1:8797/admin',
        onReady: resolve,
      });
      queueMicrotask(() => coreChild.emit('message', { type: 'ready', port: 8797 }));
    });
    coreChild.emit('message', { type: 'asr:start', id: 'w1', script: 'src/asr-worker/index.js', args: [] });
    expect(forkImpl.mock.calls.some((call) => call[2] && call[2].serviceName === SERVICE_NAME)).toBe(true);
    core.stopAll();
    expect(asrChild.kill).toHaveBeenCalled();
  });
});
