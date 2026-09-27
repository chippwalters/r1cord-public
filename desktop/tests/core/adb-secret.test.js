// Secrets over adb stdin and the SetupProvider result parser. adb is faked; nothing is spawned.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  AdbSecretError,
  ContentCallError,
  parseCallResult,
  runContentCall,
  stageToken,
  typeAuthKey,
} = require('../../src/core/adb-secret');

const ADB = 'C:\\tools\\adb.exe';
const SERIAL = 'R1DEVICESERIAL001';
const TOKEN = 'ab'.repeat(32);
const NONCE = '0123456789abcdef'.repeat(2);
const KEY = 'tskey-auth-kEXAMPLE1234-abcdefABCDEF0123456789';

function fakeRun(result = { code: 0, stdout: '', stderr: '' }) {
  const calls = [];
  const run = async (argv, options = {}) => {
    calls.push({ argv, input: options.input || null, copy: options.input ? Buffer.from(options.input) : null });
    return typeof result === 'function' ? result(argv, options) : result;
  };
  return { run, calls };
}

describe('stageToken', () => {
  it('sends the token only on stdin of `adb shell -T` and zeroes the buffer afterwards', async () => {
    const { run, calls } = fakeRun();
    const lines = [];
    await stageToken(ADB, SERIAL, NONCE, TOKEN, { run, log: (line) => lines.push(line) });
    expect(calls).toHaveLength(1);
    expect(calls[0].argv).toEqual([ADB, '-s', SERIAL, 'shell', '-T']);
    expect(calls[0].argv.join(' ')).not.toContain(TOKEN);
    const script = calls[0].copy.toString('utf8');
    expect(script).toContain(`content write --uri 'content://com.chippwalters.r1cord.setup/token/${NONCE}'`);
    expect(script).toContain(`\n${TOKEN}\n`);
    expect(script.trimEnd().endsWith('exit')).toBe(true);
    expect(calls[0].input.every((byte) => byte === 0)).toBe(true);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  it('refuses a malformed token or nonce without running adb', async () => {
    const { run, calls } = fakeRun();
    await expect(stageToken(ADB, SERIAL, NONCE, TOKEN.toUpperCase(), { run })).rejects.toThrow(AdbSecretError);
    await expect(stageToken(ADB, SERIAL, NONCE, `${TOKEN.slice(1)};`, { run })).rejects.toThrow(AdbSecretError);
    await expect(stageToken(ADB, SERIAL, 'not-a-nonce', TOKEN, { run })).rejects.toThrow(AdbSecretError);
    await expect(stageToken(ADB, 'serial; reboot', NONCE, TOKEN, { run })).rejects.toThrow(AdbSecretError);
    expect(calls).toHaveLength(0);
  });

  it('reports a device failure with anything secret-shaped redacted', async () => {
    const { run } = fakeRun({ code: 1, stdout: '', stderr: `Error: rejected ${TOKEN}` });
    const failure = stageToken(ADB, SERIAL, NONCE, TOKEN, { run });
    await expect(failure).rejects.toThrow(/content write failed/);
    await expect(failure).rejects.not.toThrow(TOKEN);
  });
});

describe('typeAuthKey', () => {
  it('types the key through stdin, never argv, and logs only the command name', async () => {
    const { run, calls } = fakeRun();
    const lines = [];
    await typeAuthKey(ADB, SERIAL, KEY, { run, log: (line) => lines.push(line) });
    expect(calls[0].argv).toEqual([ADB, '-s', SERIAL, 'shell', '-T']);
    expect(calls[0].copy.toString('utf8')).toBe(`input text '${KEY}'\nexit\n`);
    expect(calls[0].input.every((byte) => byte === 0)).toBe(true);
    expect(lines).toEqual(['adb-secret: input text']);
  });

  it.each([
    ['shell metacharacters', `${KEY};reboot`],
    ['command substitution', 'tskey-auth-$(reboot)aaaaaa'],
    ['a quote', "tskey-auth-abc'defghijk"],
    ['spaces', 'tskey-auth-abc defghijkl'],
    ['a newline', 'tskey-auth-abcdefghijk\nreboot'],
    ['too short', 'tskey-abc'],
    ['the wrong prefix', 'key-auth-abcdefghijklmnop'],
  ])('rejects a key with %s', async (_label, key) => {
    const { run, calls } = fakeRun();
    await expect(typeAuthKey(ADB, SERIAL, key, { run })).rejects.toThrow(AdbSecretError);
    expect(calls).toHaveLength(0);
  });
});

describe('parseCallResult', () => {
  it('reads ok and the JSON string in either key order', () => {
    expect(parseCallResult('Result: Bundle[{ok=true, json={"v":1,"paired":true,"vpn":"up"}}]\n')).toEqual({
      ok: true,
      json: { v: 1, paired: true, vpn: 'up' },
    });
    expect(parseCallResult('Result: Bundle[{json={"v":1,"error":"busy","reason":"Recording {x}, \\"y\\""}, ok=false}]')).toEqual({
      ok: false,
      json: { v: 1, error: 'busy', reason: 'Recording {x}, "y"' },
    });
  });

  it('keeps nested objects whole', () => {
    const out = parseCallResult('Result: Bundle[{ok=true, json={"v":1,"results":{"443":"open","41641":"timeout"}}}]');
    expect(out.json.results).toEqual({ 443: 'open', 41641: 'timeout' });
  });

  it.each([
    ['a null result', 'Result: null'],
    ['no result line', 'Error while accessing provider:com.chippwalters.r1cord.setup'],
    ['a bundle without json', 'Result: Bundle[{ok=true}]'],
    ['broken JSON', 'Result: Bundle[{ok=true, json={"v":1,}]'],
    ['the content usage text', 'usage: adb shell content [subcommand] [options]\n\nusage: adb shell content insert --uri <URI> …'],
  ])('throws on %s', (_label, text) => {
    expect(() => parseCallResult(text)).toThrow(ContentCallError);
  });

  it('reports usage text as rejected arguments, not a provider result', () => {
    expect(() => parseCallResult('\nusage: adb shell content call --uri <URI> --method <METHOD> [--arg <ARG>]\n  [--extra <KEY>:<TYPE>:<VAL>]\n')).toThrow(
      "the R1's content command rejected the arguments",
    );
  });
});

describe('runContentCall', () => {
  it('quotes every word for the device shell and returns the parsed bundle', async () => {
    const { run, calls } = fakeRun({ code: 0, stdout: 'Result: Bundle[{ok=true, json={"v":1,"paired":true}}]', stderr: '' });
    const out = await runContentCall(ADB, SERIAL, 'PROVISION', NONCE, [
      ['serverUrl', 's', 'https://pc.example.ts.net'],
      ['serverName', 's', "Chipp's PC"],
    ], { run });
    expect(out).toEqual({ ok: true, json: { v: 1, paired: true } });
    const argv = calls[0].argv;
    expect(argv.slice(0, 4)).toEqual([ADB, '-s', SERIAL, 'shell']);
    expect(argv).toHaveLength(5);
    expect(argv[4]).toBe(
      `'content' 'call' '--uri' 'content://com.chippwalters.r1cord.setup' '--method' 'PROVISION' '--arg' '${NONCE}' ` +
        `'--extra' 'serverUrl:s:https\\://pc.example.ts.net' '--extra' 'serverName:s:Chipp'\\''s PC'`,
    );
  });

  it('doubles a backslash in an extra value before escaping its colons', async () => {
    const { run, calls } = fakeRun({ code: 0, stdout: 'Result: Bundle[{ok=true, json={"v":1}}]', stderr: '' });
    await runContentCall(ADB, SERIAL, 'PROVISION', NONCE, [['serverName', 's', 'C:\\PC']], { run });
    expect(calls[0].argv[4]).toContain(`'--extra' 'serverName:s:C\\:\\\\PC'`);
  });

  it('refuses unknown methods and control characters before running adb', async () => {
    const { run, calls } = fakeRun();
    await expect(runContentCall(ADB, SERIAL, 'DELETE_ALL', null, [], { run })).rejects.toThrow(ContentCallError);
    await expect(runContentCall(ADB, SERIAL, 'NONCE', 'abc\nreboot', [], { run })).rejects.toThrow(ContentCallError);
    await expect(runContentCall(ADB, SERIAL, 'PROBE', '100.64.0.1', [['ports;x', 's', '443']], { run })).rejects.toThrow(ContentCallError);
    expect(calls).toHaveLength(0);
  });
});
