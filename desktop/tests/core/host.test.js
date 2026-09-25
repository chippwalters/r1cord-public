import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { installHost, payloadOf } = require('../../src/core/host');

function fakeParentPort() {
  const handlers = {};
  const posted = [];
  return {
    posted,
    postMessage(msg) {
      posted.push(msg);
    },
    on(event, fn) {
      (handlers[event] ||= []).push(fn);
    },
    emit(event, payload) {
      (handlers[event] || []).forEach((fn) => fn(payload));
    },
  };
}

const originalParent = process.parentPort;

afterEach(() => {
  if (originalParent === undefined) delete process.parentPort;
  else process.parentPort = originalParent;
});

describe('payloadOf', () => {
  it('unwraps Electron MessageEvent data', () => {
    expect(payloadOf({ data: { type: 'shutdown' } })).toEqual({ type: 'shutdown' });
  });

  it('keeps a typed payload as-is', () => {
    expect(payloadOf({ type: 'windowOpen', open: true })).toEqual({ type: 'windowOpen', open: true });
  });
});

describe('installHost without parentPort', () => {
  it('returns a disconnected API whose methods do not throw', () => {
    delete process.parentPort;
    const desktop = { setHostReveal: vi.fn() };
    const onShutdown = vi.fn();
    const host = installHost({ port: 8797, desktop, onShutdown });
    expect(host.connected).toBe(false);
    host.openDashboard();
    host.runModeChanged('plug');
    expect(desktop.setHostReveal).not.toHaveBeenCalled();
    host.requestExit();
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(host.spawnWorker).toBeNull();
  });
});

describe('installHost with parentPort', () => {
  it('posts ready, routes reveal, and forwards host actions', () => {
    const parent = fakeParentPort();
    process.parentPort = parent;
    const desktop = { setHostReveal: vi.fn() };
    const host = installHost({ port: 8797, desktop });
    expect(host.connected).toBe(true);
    expect(parent.posted).toEqual([{ type: 'ready', port: 8797 }]);
    expect(desktop.setHostReveal).toHaveBeenCalledTimes(1);
    desktop.setHostReveal.mock.calls[0][0]('D:\\inbox\\audio.m4a');
    host.openDashboard();
    host.requestExit();
    host.runModeChanged('always');
    expect(parent.posted).toEqual([
      { type: 'ready', port: 8797 },
      { type: 'reveal', path: 'D:\\inbox\\audio.m4a' },
      { type: 'openDashboard' },
      { type: 'requestExit' },
      { type: 'runModeChanged', mode: 'always' },
    ]);
  });

  it('handles shutdown and windowOpen from main', () => {
    const parent = fakeParentPort();
    process.parentPort = parent;
    const onShutdown = vi.fn();
    const onWindowOpen = vi.fn();
    installHost({ port: 8797, onShutdown, onWindowOpen });
    parent.emit('message', { data: { type: 'shutdown' } });
    parent.emit('message', { type: 'windowOpen', open: true });
    parent.emit('message', { data: { type: 'windowOpen', open: false } });
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(onWindowOpen.mock.calls).toEqual([[true], [false]]);
  });

  it('does not call onShutdown for requestExit when connected', () => {
    const parent = fakeParentPort();
    process.parentPort = parent;
    const onShutdown = vi.fn();
    const host = installHost({ port: 8797, onShutdown });
    host.requestExit();
    expect(onShutdown).not.toHaveBeenCalled();
    expect(parent.posted).toContainEqual({ type: 'requestExit' });
  });

  it('spawnWorker asks main to fork and relays messages and exit by id', () => {
    const parent = fakeParentPort();
    process.parentPort = parent;
    const host = installHost({ port: 8797 });
    const worker = host.spawnWorker('D:\\app\\src\\asr-worker\\index.js', [], { env: { GGML_VK_DISABLE_COOPMAT: '1' } });
    const start = parent.posted.find((msg) => msg.type === 'asr:start');
    expect(start).toMatchObject({
      type: 'asr:start',
      script: 'D:\\app\\src\\asr-worker\\index.js',
      args: [],
      env: { GGML_VK_DISABLE_COOPMAT: '1' },
    });
    expect(start.id).toMatch(/^[0-9a-f-]{36}$/i);

    const messages = [];
    const exits = [];
    worker.on('message', (msg) => messages.push(msg));
    worker.on('exit', (code, detail) => exits.push([code, detail]));
    worker.postMessage({ type: 'start', backend: 'vulkan' });
    expect(parent.posted).toContainEqual({ type: 'asr:post', id: start.id, message: { type: 'start', backend: 'vulkan' } });

    parent.emit('message', { type: 'asr:message', id: start.id, message: { type: 'log', line: 'asr: loading vulkan/q8_0' } });
    parent.emit('message', { data: { type: 'asr:exit', id: start.id, code: 0, detail: '' } });
    expect(messages).toEqual([{ type: 'log', line: 'asr: loading vulkan/q8_0' }]);
    expect(exits).toEqual([[0, '']]);

    worker.kill();
    expect(parent.posted).toContainEqual({ type: 'asr:kill', id: start.id });
  });
});
