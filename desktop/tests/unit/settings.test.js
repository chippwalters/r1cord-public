import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  applyCliOverrides,
  bundledFfmpegPath,
  defaultSettings,
  loadSettings,
  nodeCoreDescriptor,
  nodeCoreInput,
  parseUserDataDir,
  saveSettings,
  normalizeSettings,
} = require('../../src/main/services/settings');

describe('desktop settings', () => {
  it('defaults port and startup mode', () => {
    const settings = defaultSettings();
    expect(settings.startupMode).toBe('manual');
    expect(settings.port).toBe(8765);
    expect(settings.configPath).toBe('');
    expect(settings.core).toBeUndefined();
    expect(settings.pythonPath).toBeUndefined();
  });

  it('lets --config and --port override the saved file', () => {
    const settings = applyCliOverrides(
      { configPath: '', port: 8765, startupMode: 'manual', adbPath: 'adb' },
      ['electron', '.', '--config', 'D:\\tmp\\config.toml', '--port', '8775'],
    );
    expect(settings.configPath).toBe('D:\\tmp\\config.toml');
    expect(settings.port).toBe(8775);
  });

  it('does not persist a core selector', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-desktop-core-'));
    saveSettings(dir, { port: 8775, core: 'python', pythonPath: 'C:\\py\\python.exe' });
    const loaded = loadSettings(dir);
    expect(loaded.core).toBeUndefined();
    expect(loaded.pythonPath).toBeUndefined();
    expect(loaded.port).toBe(8775);
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'desktop-settings.json'), 'utf8'));
    expect(file.core).toBeUndefined();
    expect(file.pythonPath).toBeUndefined();
    expect(file.noUsb).toBeUndefined();
  });

  it('passes --no-usb and --no-worker from argv', () => {
    const settings = applyCliOverrides(
      { configPath: '', port: 8765, startupMode: 'manual', adbPath: 'adb' },
      ['electron', '.', '--no-usb', '--no-worker'],
    );
    expect(settings.noUsb).toBe(true);
    expect(settings.noWorker).toBe(true);
  });

  it('ignores --core and --python (removed at the P4 cutover)', () => {
    const settings = applyCliOverrides(
      { configPath: '', port: 8765, startupMode: 'manual', adbPath: 'adb' },
      ['electron', '.', '--core', 'python', '--python', 'D:\\py\\python.exe'],
    );
    expect(settings.core).toBeUndefined();
    expect(settings.pythonPath).toBeUndefined();
    expect(settings.port).toBe(8765);
  });

  it('reads --user-data-dir from argv', () => {
    expect(parseUserDataDir(['app', '--user-data-dir', 'D:\\tmp\\ud'])).toBe('D:\\tmp\\ud');
    expect(parseUserDataDir(['app', '--user-data-dir=D:\\tmp\\ud'])).toBe('D:\\tmp\\ud');
    expect(parseUserDataDir(['app', '--port', '8795'])).toBe('');
  });

  it('refuses an out-of-range port', () => {
    expect(() => normalizeSettings({ port: 0 })).toThrow(/invalid port/);
  });

  it('round-trips a settings file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-desktop-'));
    const saved = saveSettings(dir, { port: 8775, startupMode: 'plug' });
    expect(saved.port).toBe(8775);
    expect(loadSettings(dir).startupMode).toBe('plug');
  });
});

describe('the ffmpeg the core decodes audio with', () => {
  function coreEnv(ffmpegPath, appPath) {
    return nodeCoreDescriptor.buildEnv(nodeCoreInput(defaultSettings(), { appPath, ffmpegPath }));
  }

  it('is the one in resources/win32 when packaged', () => {
    const resourcesPath = path.join('C:\\Apps\\R1CORD Desktop', 'resources');
    const appPath = path.join(resourcesPath, 'app.asar');
    const ffmpegPath = bundledFfmpegPath({ isPackaged: true, resourcesPath, appPath });
    expect(coreEnv(ffmpegPath, appPath).R1CORD_FFMPEG).toBe(path.join(resourcesPath, 'win32', 'ffmpeg.exe'));
  });

  it('is binaries/win32/ffmpeg.exe in dev once it is copied there, and ffmpeg on PATH before', () => {
    const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-desktop-ffmpeg-'));
    expect(coreEnv(bundledFfmpegPath({ isPackaged: false, appPath }), appPath)).not.toHaveProperty('R1CORD_FFMPEG');

    const exe = path.join(appPath, 'binaries', 'win32', 'ffmpeg.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, '');
    expect(coreEnv(bundledFfmpegPath({ isPackaged: false, appPath }), appPath).R1CORD_FFMPEG).toBe(exe);
    fs.rmSync(appPath, { recursive: true, force: true });
  });
});
