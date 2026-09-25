import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOsAdapter, createRealOsAdapter, shouldDryRun } = require('../../src/main/services/startup/osAdapter');

describe('shouldDryRun', () => {
  it('runs real OS calls in a packaged app', () => {
    expect(shouldDryRun({ isPackaged: true, env: {} })).toBe(false);
  });

  it('dry-runs when the app is not packaged', () => {
    expect(shouldDryRun({ isPackaged: false, env: {} })).toBe(true);
  });

  it('dry-runs a packaged app when R1CORD_DESKTOP_DRY_RUN=1', () => {
    expect(shouldDryRun({ isPackaged: true, env: { R1CORD_DESKTOP_DRY_RUN: '1' } })).toBe(true);
  });
});

describe('os adapter', () => {
  it('records schtasks calls and does not run them when dry-run is on', async () => {
    const execFileImpl = vi.fn(async () => {
      throw new Error('real execFile must not run');
    });
    const os = createOsAdapter({ dryRun: true, execFileImpl });
    const result = await os.execFile('schtasks.exe', ['/Delete', '/TN', 'R1CORD', '/F']);
    expect(result).toMatchObject({ status: 0, stdout: '', stderr: '', dryRun: true });
    expect(execFileImpl).not.toHaveBeenCalled();
    expect(os.dryRun).toBe(true);
    expect(os.calls[0]).toMatchObject({
      op: 'execFile',
      file: 'schtasks.exe',
      args: ['/Delete', '/TN', 'R1CORD', '/F'],
    });
  });

  it('uses the injected implementation when dry-run is off', async () => {
    const execFileImpl = vi.fn(async () => ({ status: 0, stdout: 'ok', stderr: '' }));
    const os = createOsAdapter({ dryRun: false, execFileImpl });
    const result = await os.execFile('schtasks.exe', ['/Query', '/TN', 'R1CORD']);
    expect(execFileImpl).toHaveBeenCalledTimes(1);
    expect(result.stdout).toBe('ok');
    expect(os.dryRun).toBe(false);
  });

  it('createRealOsAdapter dry-runs unpackaged builds and runs when packaged', async () => {
    const unpackaged = createRealOsAdapter({ isPackaged: false, env: {} });
    expect(unpackaged.dryRun).toBe(true);
    const packaged = createRealOsAdapter({ isPackaged: true, env: {} });
    expect(packaged.dryRun).toBe(false);
    const forced = createRealOsAdapter({ isPackaged: true, env: { R1CORD_DESKTOP_DRY_RUN: '1' } });
    expect(forced.dryRun).toBe(true);
  });
  it('creates the task directory before writing first-run task XML', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-task-'));
    try {
      const file = path.join(root, 'tasks', 'R1CORD.xml');
      await createRealOsAdapter({ isPackaged: true, env: {} }).writeFile(file, '<Task/>');
      expect(fs.readFileSync(file, 'utf8')).toBe('<Task/>');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
