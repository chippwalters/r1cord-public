// The signed release manifest, consent before any request, rollback refusal and APK downloads.
// A throwaway Ed25519 key stands in for the publication key (verifyManifest's publicKey option);
// fetch is injected, so nothing here touches the network.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const updates = require('../../src/core/updates');
const { SIGNER_PINS } = require('../../src/core/release-keys');
const { buildApk, buildAxml, makeSigner } = require('./apk-fixture');

const { UpdateError, compareVersions, ensureApk, fetchManifest, updateState, verifyManifest } = updates;
const keys = crypto.generateKeyPairSync('ed25519');
const PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const URL_BASE = 'https://updates.example.test/r1cord/';
const MANIFEST_URL = `${URL_BASE}manifest.json`;
const HEX = 'ab'.repeat(32);

function manifestData(overrides = {}) {
  return {
    schema: 1,
    sequence: 3,
    publishedAt: '2026-09-26T00:00:00Z',
    desktop: { version: '0.5.0', url: 'https://updates.example.test/R1CORD-Desktop-0.5.0-win-x64.zip', size: 10, sha256: HEX, notes: 'https://updates.example.test/guide.html' },
    android: {
      r1cord: {
        package: 'com.chippwalters.r1cord',
        versionName: '0.4.0',
        versionCode: 17,
        file: 'R1CORD-0.4.0.apk',
        size: 100,
        sha256: HEX,
        certSha256: SIGNER_PINS['com.chippwalters.r1cord'],
        minDesktop: '0.5.0',
      },
    },
    ...overrides,
  };
}

function signed(data, key = keys.privateKey) {
  const bytes = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return { bytes, sig: `${crypto.sign(null, bytes, key).toString('base64')}\n` };
}

let root;
beforeEach(() => {
  updates.resetForTests();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-updates-'));
});
afterEach(() => {
  updates.resetForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A fetch that serves `routes` (url -> Buffer | string | {status}) and records every call. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const body = routes[String(url)];
    if (body === undefined) return new Response('missing', { status: 404 });
    if (body && body.status) return new Response('error', { status: body.status });
    return new Response(body, { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

function served(data) {
  const { bytes, sig } = signed(data);
  return { [MANIFEST_URL]: bytes, [`${MANIFEST_URL}.sig`]: sig };
}

const config = (overrides = {}) => ({ update_check: true, update_manifest_url: MANIFEST_URL, ...overrides });
const opts = (fetch) => ({ fetch, configDir: root, publicKey: PUBLIC_KEY });

describe('verifyManifest', () => {
  it('accepts a manifest signed by the publication key (signature file with a trailing newline)', () => {
    const { bytes, sig } = signed(manifestData());
    const manifest = verifyManifest(bytes, sig, { publicKey: PUBLIC_KEY });
    expect(manifest.sequence).toBe(3);
    expect(manifest.android.r1cord.versionCode).toBe(17);
    expect(manifest.desktop.version).toBe('0.5.0');
  });

  it('refuses tampered bytes, another key, and a signature from the built-in key check', () => {
    const { bytes, sig } = signed(manifestData());
    const tampered = Buffer.from(bytes.toString('utf8').replace('"versionCode": 17', '"versionCode": 18'));
    expect(() => verifyManifest(tampered, sig, { publicKey: PUBLIC_KEY })).toThrow(/not from the R1CORD publication key/);
    const other = crypto.generateKeyPairSync('ed25519');
    const foreign = signed(manifestData(), other.privateKey);
    expect(() => verifyManifest(foreign.bytes, foreign.sig, { publicKey: PUBLIC_KEY })).toThrow(/not from the R1CORD publication key/);
    // Without the test key option the pinned production key applies, which did not sign this.
    expect(() => verifyManifest(bytes, sig)).toThrow(/not from the R1CORD publication key/);
    expect(() => verifyManifest(bytes, 'not base64!', { publicKey: PUBLIC_KEY })).toThrow(/not a base64 Ed25519 signature/);
  });

  it.each([
    ['a file path that leaves the folder', (m) => { m.android.r1cord.file = '../R1CORD-0.4.0.apk'; }, /bare file name/],
    ['a file in a subfolder', (m) => { m.android.r1cord.file = 'sub/R1CORD-0.4.0.apk'; }, /bare file name/],
    ['a file that is not an APK', (m) => { m.android.r1cord.file = 'R1CORD-0.4.0.exe'; }, /bare file name/],
    ['a bad sha256', (m) => { m.android.r1cord.sha256 = 'xyz'; }, /sha256 must be 64 hex digits/],
    ['a missing versionCode', (m) => { delete m.android.r1cord.versionCode; }, /versionCode must be an integer/],
    ['a missing size', (m) => { delete m.android.r1cord.size; }, /size must be an integer/],
    ['a fractional sequence', (m) => { m.sequence = 1.5; }, /sequence must be an integer/],
    ['another schema', (m) => { m.schema = 2; }, /schema must be 1/],
    ['a certificate other than the pin', (m) => { m.android.r1cord.certSha256 = HEX; }, /not the built-in signer pin/],
    ['a package other than the entry', (m) => { m.android.r1cord.package = 'com.example.evil'; }, /package must be com\.chippwalters\.r1cord/],
    ['a non-https desktop URL', (m) => { m.desktop.url = 'http://updates.example.test/x.zip'; }, /plain https/],
    ['no desktop section', (m) => { delete m.desktop; }, /desktop must be an object/],
  ])('refuses %s', (_label, mutate, pattern) => {
    const data = manifestData();
    mutate(data);
    const { bytes, sig } = signed(data);
    expect(() => verifyManifest(bytes, sig, { publicKey: PUBLIC_KEY })).toThrow(pattern);
  });
});

describe('fetchManifest', () => {
  it('makes no request while update checks are off and not forced', async () => {
    const fetch = fakeFetch(served(manifestData()));
    expect(await fetchManifest(config({ update_check: false }), opts(fetch))).toBeNull();
    expect(fetch.calls).toHaveLength(0);
    expect(fs.existsSync(path.join(root, 'update-state.json'))).toBe(false);
  });

  it('fetches manifest and signature with a plain request when on, or when forced', async () => {
    const fetch = fakeFetch(served(manifestData()));
    const manifest = await fetchManifest(config({ update_check: false }), { ...opts(fetch), force: true });
    expect(manifest.sequence).toBe(3);
    expect(fetch.calls.map((c) => c.url)).toEqual([MANIFEST_URL, `${MANIFEST_URL}.sig`]);
    for (const call of fetch.calls) expect(Object.keys(call.init).sort()).toEqual(['redirect', 'signal']);
    const state = JSON.parse(fs.readFileSync(path.join(root, 'update-state.json'), 'utf8'));
    expect(state.lastSequence).toBe(3);
  });

  it('refuses a lower sequence than the last accepted one and keeps the accepted one', async () => {
    await fetchManifest(config(), opts(fakeFetch(served(manifestData({ sequence: 5 })))));
    await expect(fetchManifest(config(), opts(fakeFetch(served(manifestData({ sequence: 4 })))))).rejects.toThrow(/sequence 4 is older than 5.*rollback/);
    const state = JSON.parse(fs.readFileSync(path.join(root, 'update-state.json'), 'utf8'));
    expect(state.lastSequence).toBe(5);
    expect(updateState().sequence).toBe(5);
    expect(updateState().lastError).toMatch(/rollback/);
    // The same sequence again is fine (the same release re-read).
    expect((await fetchManifest(config(), opts(fakeFetch(served(manifestData({ sequence: 5 })))))).sequence).toBe(5);
  });

  it('keeps the rollback floor across restarts (state file), and refuses a damaged state file', async () => {
    await fetchManifest(config(), opts(fakeFetch(served(manifestData({ sequence: 7 })))));
    updates.resetForTests();
    await expect(fetchManifest(config(), opts(fakeFetch(served(manifestData({ sequence: 6 })))))).rejects.toThrow(/rollback/);
    fs.writeFileSync(path.join(root, 'update-state.json'), '{not json');
    await expect(fetchManifest(config(), opts(fakeFetch(served(manifestData({ sequence: 9 })))))).rejects.toThrow(/damaged/);
  });

  it('refuses a non-https manifest URL without a request, and an oversized manifest', async () => {
    const fetch = fakeFetch({});
    await expect(fetchManifest(config({ update_manifest_url: 'http://updates.example.test/manifest.json' }), opts(fetch))).rejects.toThrow(/https/);
    expect(fetch.calls).toHaveLength(0);
    const big = fakeFetch({ [MANIFEST_URL]: Buffer.alloc(1024 * 1024 + 1, 0x20), [`${MANIFEST_URL}.sig`]: 'x' });
    await expect(fetchManifest(config(), opts(big))).rejects.toThrow(/larger than/);
  });

  it('reports a server error as a failed check', async () => {
    await expect(fetchManifest(config(), opts(fakeFetch({ [MANIFEST_URL]: { status: 503 } })))).rejects.toThrow(/HTTP 503/);
    expect(updateState().lastError).toMatch(/HTTP 503/);
  });
});

describe('updateState', () => {
  it('says a desktop update is available only for a newer signed version', async () => {
    const d = manifestData().desktop;
    await fetchManifest(config(), opts(fakeFetch(served(manifestData({ desktop: { ...d, version: '99.0.0' } })))));
    expect(updateState().desktop).toMatchObject({ latest: '99.0.0', available: true });
    await fetchManifest(config(), opts(fakeFetch(served(manifestData({ sequence: 4, desktop: { ...d, version: '0.0.1' } })))));
    expect(updateState().desktop.available).toBe(false);
  });
});

describe('compareVersions', () => {
  it('orders numerically, with a pre-release before its release', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.5.0', '0.5.0')).toBe(0);
    expect(compareVersions('0.5.0-rc.2', '0.5.0')).toBeLessThan(0);
    expect(compareVersions('0.5.0-rc.10', '0.5.0-rc.2')).toBeGreaterThan(0);
    expect(() => compareVersions('0.5', '0.5.0')).toThrow(UpdateError);
  });
});

describe('ensureApk', () => {
  const apkDir = () => path.join(root, 'apk');

  function entryFor(bytes, overrides = {}) {
    return manifestData({
      android: {
        r1cord: {
          ...manifestData().android.r1cord,
          size: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          ...overrides,
        },
      },
    });
  }

  async function attempt(served, manifest) {
    const fetch = fakeFetch({ [`${URL_BASE}R1CORD-0.4.0.apk`]: served });
    return ensureApk('r1cord', { manifest, manifestUrl: MANIFEST_URL, fetch, apkDir: apkDir() });
  }

  const apk = buildApk({
    manifest: buildAxml({ package: 'com.chippwalters.r1cord', versionCode: 17, versionName: '0.4.0' }),
    v2: [{ identity: makeSigner('ec') }],
  });

  it('refuses a download of the wrong size and leaves nothing behind', async () => {
    const manifest = entryFor(apk);
    await expect(attempt(Buffer.concat([apk, Buffer.alloc(1)]), manifest)).rejects.toThrow(/larger than the manifest|bytes offered/);
    await expect(attempt(apk.subarray(0, apk.length - 1), manifest)).rejects.toThrow(/bytes, the manifest says/);
    expect(fs.readdirSync(apkDir())).toEqual([]);
  });

  it('refuses a download whose SHA-256 differs from the manifest', async () => {
    await expect(attempt(apk, entryFor(apk, { sha256: HEX }))).rejects.toThrow(/SHA-256 .* is not the manifest's/);
    expect(fs.readdirSync(apkDir())).toEqual([]);
  });

  it('refuses a correctly hashed APK signed by a key other than the pinned one', async () => {
    await expect(attempt(apk, entryFor(apk))).rejects.toThrow(/refused: .*not the pinned 4e92/);
    expect(fs.readdirSync(apkDir())).toEqual([]);
  });

  it('refuses an unknown APK name and a manifest without that APK', async () => {
    await expect(ensureApk('other', {})).rejects.toThrow(/unknown APK/);
    await expect(ensureApk('controls', { manifest: manifestData(), manifestUrl: MANIFEST_URL, apkDir: apkDir() })).rejects.toThrow(/no controls APK/);
  });

  it('has nothing to download before any manifest was accepted', async () => {
    await expect(ensureApk('r1cord', { configDir: root, apkDir: apkDir() })).rejects.toThrow(/no verified release manifest/);
  });
});

describe('startUpdateChecks', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

  it('checks only while update_check is on, and stops', async () => {
    const fetch = fakeFetch(served(manifestData()));
    const state = { config: config({ update_check: false }), configDir: root };
    let stop = updates.startUpdateChecks(state, { firstDelayMs: 1, intervalMs: 5, fetch });
    await tick();
    stop();
    expect(fetch.calls).toHaveLength(0);

    state.config = config({ update_check: true });
    stop = updates.startUpdateChecks(state, { firstDelayMs: 1, intervalMs: 60_000, fetch });
    await tick();
    stop();
    expect(fetch.calls.map((c) => c.url)).toEqual([MANIFEST_URL, `${MANIFEST_URL}.sig`]);
  });
});
