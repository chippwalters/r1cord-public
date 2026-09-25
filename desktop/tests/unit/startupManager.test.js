import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { StartupManager, LOGIN_TASK, PLUG_TASK, LEGACY_TASK } = require('../../src/main/services/startup/StartupManager');
const { buildLoginTaskXml, buildPlugCmd, buildPlugTaskXml } = require('../../src/main/services/startup/taskXml');
const { createOsAdapter } = require('../../src/main/services/startup/osAdapter');

const ctx = {
  exePath: 'D:\\Apps\\R1CORD Desktop.exe',
  workingDirectory: 'D:\\Apps',
  userId: 'user',
  watcherScript: 'D:\\Apps\\resources\\plug-watcher.js',
  adbPath: 'D:\\tools\\adb.exe',
};

describe('startup task XML', () => {
  it('registers the full app at logon with restart-on-failure', () => {
    const xml = buildLoginTaskXml(ctx);
    expect(xml).toContain('<Command>D:\\Apps\\R1CORD Desktop.exe</Command>');
    expect(xml).toContain('<Arguments>--background</Arguments>');
    expect(xml).toContain('<Delay>PT15S</Delay>');
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml).toContain('<Interval>PT1M</Interval>');
    expect(xml).toContain('<Count>3</Count>');
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
  });

  it('wraps the plug watcher so Task Scheduler can set ELECTRON_RUN_AS_NODE', () => {
    const cmd = buildPlugCmd(ctx);
    expect(cmd).toContain('set ELECTRON_RUN_AS_NODE=1');
    expect(cmd).toContain(`set R1CORD_APP_EXE=${ctx.exePath}`);
    expect(cmd).toContain(`"${ctx.exePath}" "${ctx.watcherScript}"`);
    const xml = buildPlugTaskXml({
      cmdPath: 'D:\\Apps\\R1CORD-plug.cmd',
      workingDirectory: ctx.workingDirectory,
      userId: ctx.userId,
    });
    expect(xml).toContain('<Command>D:\\Apps\\R1CORD-plug.cmd</Command>');
    expect(xml).not.toContain('--background');
  });
});

describe('StartupManager commands', () => {
  it('removes both new tasks and the legacy python task in every mode', () => {
    const os = createOsAdapter({ allowOs: false });
    const manager = new StartupManager({ os, taskDir: 'D:\\tmp\\tasks' });
    const commands = manager.commandsFor('manual');
    const names = commands.map((c) => c.args.join(' '));
    expect(commands.every((c) => c.file === 'schtasks.exe')).toBe(true);
    expect(names.some((n) => n.includes(`/Delete /TN ${LOGIN_TASK}`))).toBe(true);
    expect(names.some((n) => n.includes(`/Delete /TN ${PLUG_TASK}`))).toBe(true);
    expect(names.some((n) => n.includes(`/Delete /TN ${LEGACY_TASK}`))).toBe(true);
    expect(names.some((n) => n.includes('/Create'))).toBe(false);
  });

  it('creates the login task after deleting the others', () => {
    const os = createOsAdapter({ allowOs: false });
    const manager = new StartupManager({ os, taskDir: 'D:\\tmp\\tasks' });
    const commands = manager.commandsFor('login');
    const create = commands.filter((c) => c.args[0] === '/Create');
    expect(create).toHaveLength(1);
    expect(create[0].args).toEqual(['/Create', '/TN', LOGIN_TASK, '/XML', path.join('D:\\tmp\\tasks', 'R1CORD.xml'), '/F']);
  });

  it('creates the plug watcher task after deleting the others', () => {
    const os = createOsAdapter({ allowOs: false });
    const manager = new StartupManager({ os, taskDir: 'D:\\tmp\\tasks' });
    const commands = manager.commandsFor('plug');
    const create = commands.filter((c) => c.args[0] === '/Create');
    expect(create).toHaveLength(1);
    expect(create[0].args[2]).toBe(PLUG_TASK);
  });

  it('writes XML through the os adapter and never shells out when dry-run is on', async () => {
    let execImplCalls = 0;
    const os = createOsAdapter({
      dryRun: true,
      execFileImpl: async () => {
        execImplCalls += 1;
        throw new Error('real schtasks must not run');
      },
    });
    const manager = new StartupManager({ os, taskDir: 'D:\\tmp\\tasks' });
    const result = await manager.apply('login', ctx);
    expect(execImplCalls).toBe(0);
    expect(result.dryRun).toBe(true);
    expect(result.message).toBe('dry run: not registered');
    expect(os.calls.filter((c) => c.op === 'execFile').length).toBe(result.commands.length);
    expect(os.calls.some((c) => c.op === 'writeFile' && String(c.contents).includes('--background'))).toBe(true);
    expect(os.calls.some((c) => c.op === 'writeFile' && String(c.contents).includes('ELECTRON_RUN_AS_NODE=1'))).toBe(true);
  });

  it('surfaces a non-zero schtasks create instead of ignoring it', async () => {
    const os = createOsAdapter({
      dryRun: false,
      writeFileImpl: async () => {},
      execFileImpl: async (_file, args) => {
        if (args[0] === '/Create') return { status: 1, stdout: '', stderr: 'Access is denied.' };
        return { status: 1, stdout: '', stderr: 'The system cannot find the file specified.' };
      },
    });
    const manager = new StartupManager({ os, taskDir: 'D:\\tmp\\tasks' });
    await expect(manager.apply('login', ctx)).rejects.toThrow(/schtasks failed/);
  });

  it('treats a missing-task delete as success', async () => {
    const os = createOsAdapter({
      dryRun: false,
      writeFileImpl: async () => {},
      execFileImpl: async (_file, args) => {
        if (args[0] === '/Create') return { status: 0, stdout: '', stderr: '' };
        return { status: 1, stdout: '', stderr: 'The system cannot find the file specified.' };
      },
    });
    const manager = new StartupManager({ os, taskDir: 'D:\\tmp\\tasks' });
    const result = await manager.apply('login', ctx);
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
  });
});
