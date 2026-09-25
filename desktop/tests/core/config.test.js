import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ValueError } = require('../../src/core/errors');
const { defaultConfig, loadConfig, saveConfig, withUpdates } = require('../../src/core/config');

const tmpDirs = [];

function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-config-'));
  tmpDirs.push(dir);
  return dir;
}

function write(dir, name, text) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe('config', () => {
  it('round-trips every field type through TOML', () => {
    const dir = makeTmp();
    const cfg = {
      server_name: 'Desk',
      listen_host: '0.0.0.0',
      listen_port: 9000,
      datastore: path.join(dir, 'ds'),
      webdav_folder: path.join(dir, 'wd'),
      public_url_base: 'https://x.test/pub/',
      theme: 'github-light',
      default_writer: 'codex',
      default_reviews: ['outline', 'organized'],
      writer_timeout_s: 30,
      claude_cmd: 'claude1',
      codex_cmd: 'codex1',
      grok_cmd: 'grok1',
      asr_model: 'tiny',
      asr_device: 'cpu',
      asr_quant: 'q8_0',
      asr_language: 'de',
      admin_password: 'pw-with-symbols-!?',
      admin_remote: false,
      pair_code_ttl_s: 60,
      usb_enabled: false,
      adb_cmd: 'adb1',
      usb_poll_s: 7,
      usb_auto_action: 'publish',
      usb_device_root: '/sdcard/X',
      run_mode: 'always',
      idle_exit_min: 45,
      email_enabled: true,
      email_to: 'someone@example.test',
      gws_cmd: 'gws1',
    };
    const file = path.join(dir, 'config.toml');
    saveConfig(cfg, file);
    expect(loadConfig(file)).toEqual(cfg); // paths, bools, ints, empty and slashy strings survive
  });

  it('creates the file and a random admin password on first run', () => {
    const dir = makeTmp();
    const options = { env: { LOCALAPPDATA: dir } };
    const file = path.join(dir, 'nested', 'config.toml');
    const cfg = loadConfig(file, options);
    expect(fs.existsSync(file)).toBe(true);
    expect(cfg.admin_password).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(cfg.datastore).toBe(path.join(dir, 'nested', 'data')); // data lives beside a non-default config
    expect(loadConfig(file, options)).toEqual(cfg); // the saved file round-trips
  });

  it('generates and persists an admin password when the file has none', () => {
    const dir = makeTmp();
    const file = write(dir, 'config.toml', 'server_name = "KeepMe"\n');
    const cfg = loadConfig(file, { env: { LOCALAPPDATA: dir } });
    expect(cfg.server_name).toBe('KeepMe');
    expect(cfg.admin_password).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(fs.readFileSync(file, 'utf8')).toContain(cfg.admin_password); // written back to disk
  });

  it('ignores unknown keys and tables', () => {
    const dir = makeTmp();
    const file = write(dir, 'config.toml', 'server_name = "X"\nfuture_field = 42\n[a_table]\nkey = "v"\n');
    expect(loadConfig(file, { env: { LOCALAPPDATA: dir } }).server_name).toBe('X');
  });

  it.each([
    ['default_writer = "bogus"\n', 'default_writer'],
    ['asr_device = "gpu"\n', 'asr_device'],
    ['asr_quant = "int8"\n', 'asr_quant'],
    ['asr_device = "vulkan"\n', 'asr_device'],
    ['default_reviews = ["summary", "poem"]\n', 'default_reviews'],
    ['default_reviews = "summary"\n', 'default_reviews'],
    ['usb_auto_action = "detonate"\n', 'usb_auto_action'],
    ['run_mode = "sometimes"\n', 'run_mode'],
    ['usb_poll_s = 0\n', 'usb_poll_s'],
    ['idle_exit_min = 0\n', 'idle_exit_min'],
    ['listen_port = "abc"\n', 'listen_port'],
    ['datastore = 123\n', 'datastore'],
    ['pair_code_ttl_s = [1]\n', 'pair_code_ttl_s'],
  ])('names the field on a parse error: %s', (snippet, field) => {
    const dir = makeTmp();
    const file = write(dir, 'config.toml', snippet);
    expect(() => loadConfig(file, { env: { LOCALAPPDATA: dir } })).toThrow(field);
  });

  it('still loads configs written before AI reviews', () => {
    // Customers' config.toml files name the removed summary style and the old `summarize` action.
    const dir = makeTmp();
    const options = { env: { LOCALAPPDATA: dir } };
    const file = write(
      dir,
      'config.toml',
      'admin_password = "pw"\ndefault_summary_style = "minutes"\nusb_auto_action = "summarize"\n',
    );
    const cfg = loadConfig(file, options);
    expect(cfg.usb_auto_action).toBe('review');
    expect(cfg.default_reviews).toEqual(['summary']);
    saveConfig(cfg, file);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('default_summary_style');
    expect(loadConfig(file, options)).toEqual(cfg);
  });

  it('loads default_reviews in canonical order', () => {
    const dir = makeTmp();
    const options = { env: { LOCALAPPDATA: dir } };
    const file = write(dir, 'config.toml', 'admin_password = "pw"\ndefault_reviews = ["organized", "summary", "organized"]\n');
    expect(loadConfig(file, options).default_reviews).toEqual(['summary', 'organized']);
    const empty = write(dir, 'empty.toml', 'admin_password = "pw"\ndefault_reviews = []\n');
    expect(loadConfig(empty, options).default_reviews).toEqual([]);
  });

  it('coerces ints written as strings', () => {
    const dir = makeTmp();
    const file = write(dir, 'config.toml', 'listen_port = "8123"\nusb_poll_s = "5"\n');
    const cfg = loadConfig(file, { env: { LOCALAPPDATA: dir } });
    expect(cfg.listen_port).toBe(8123);
    expect(cfg.usb_poll_s).toBe(5);
  });

  it('coerces and drops unknown keys in withUpdates, leaving the source untouched', () => {
    const base = defaultConfig({ env: { LOCALAPPDATA: 'C:\\nowhere' } });
    const updated = withUpdates(base, {
      datastore: 'C:/tmp/elsewhere',
      listen_port: '9100',
      usb_enabled: 'yes',
      server_name: 'Renamed',
      bogus_key: 123,
    });
    expect(updated.datastore).toBe('C:\\tmp\\elsewhere');
    expect(updated.listen_port).toBe(9100);
    expect(updated.usb_enabled).toBe(true);
    expect(updated.server_name).toBe('Renamed');
    expect(updated).not.toHaveProperty('bogus_key');
    expect(base.server_name).toBe('R1CORD'); // source config untouched
  });

  it('parses the email and run-mode fields', () => {
    const dir = makeTmp();
    const file = write(dir, 'config.toml', 'email_enabled = true\nemail_to = "a@b.test"\ngws_cmd = "gws9"\nrun_mode = "always"\n');
    const cfg = loadConfig(file, { env: { LOCALAPPDATA: dir } });
    expect(cfg.email_enabled).toBe(true);
    expect(cfg.email_to).toBe('a@b.test');
    expect(cfg.gws_cmd).toBe('gws9');
    expect(cfg.run_mode).toBe('always');
  });

  it('loads a theme name from an older config as its id', () => {
    const dir = makeTmp();
    const options = { env: { LOCALAPPDATA: dir } };
    const file = write(dir, 'config.toml', 'admin_password = "pw"\ntheme = "Toolmaker-Noir"\n');
    expect(loadConfig(file, options).theme).toBe('toolmaker-noir');
    const named = write(dir, 'named.toml', 'admin_password = "pw"\ntheme = "GitHub Light"\n');
    expect(loadConfig(named, options).theme).toBe('github-light');
    expect(defaultConfig().theme).toBe('toolmaker-noir');
  });

  it('falls back to the default theme with a warning when the theme is unknown', () => {
    const dir = makeTmp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = write(dir, 'config.toml', 'admin_password = "pw"\ntheme = "My-Custom"\n');
    const cfg = loadConfig(file, { env: { LOCALAPPDATA: dir } });
    expect(cfg.theme).toBe('toolmaker-noir');
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages.some((message) => message.includes('My-Custom'))).toBe(true);
  });

  it('takes a theme by name or id in withUpdates and refuses an unknown one', () => {
    expect(withUpdates(defaultConfig(), { theme: 'High Contrast' }).theme).toBe('high-contrast');
    expect(withUpdates(defaultConfig(), { theme: 'altuit-toc' }).theme).toBe('altuit-toc');
    expect(() => withUpdates(defaultConfig(), { theme: 'nope' })).toThrow(ValueError);
  });

  it('defaults asr_quant to q8_0, asr_device to auto, and admin_remote to false', () => {
    const cfg = defaultConfig({ env: { LOCALAPPDATA: 'C:\\nowhere' } });
    expect(cfg.asr_quant).toBe('q8_0');
    expect(cfg.asr_device).toBe('auto');
    expect(cfg.admin_remote).toBe(false);
    expect(cfg).not.toHaveProperty('asr_engine');
  });

  it('loads asr_quant and admin_remote, and refuses vulkan/metal as asr_device', () => {
    const dir = makeTmp();
    const options = { env: { LOCALAPPDATA: dir } };
    const file = write(
      dir,
      'config.toml',
      'admin_password = "pw"\nasr_quant = "f16"\nasr_device = "cuda"\nadmin_remote = true\n',
    );
    const cfg = loadConfig(file, options);
    expect(cfg.asr_quant).toBe('f16');
    expect(cfg.asr_device).toBe('cuda');
    expect(cfg.admin_remote).toBe(true);
    expect(() => withUpdates(cfg, { asr_device: 'vulkan' })).toThrow(/invalid asr_device: vulkan/);
    expect(() => withUpdates(cfg, { asr_device: 'metal' })).toThrow(/invalid asr_device: metal/);
  });
});
