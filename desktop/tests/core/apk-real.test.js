// The verifier on real release APKs, when they are present on this PC (skipped elsewhere):
// the mirrored Tailscale universal APK (v2+v3) and a shipped R1CORD APK (v2).
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { checkPinned, verifyApk } = require('../../src/core/apk');
const { pinFor } = require('../../src/core/release-keys');

const TAILSCALE = path.join(os.tmpdir(), 'r1cord-ts', 'tailscale-android-universal-1.102.4.apk');
// The app repo checked out beside this one.
const R1CORD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'r1cord', 'dist', 'release', 'R1CORD-0.3.4.apk');

describe.skipIf(!fs.existsSync(TAILSCALE))('real Tailscale APK', () => {
  it('verifies v2+v3 and carries the pinned Tailscale signer', () => {
    const info = verifyApk(TAILSCALE);
    expect(info.package).toBe('com.tailscale.ipn');
    expect(info.versionCode).toBe(298177930);
    expect(info.minSdk).toBe(26);
    expect(info.schemes).toEqual([2, 3]);
    expect(checkPinned(info, pinFor('tailscale')).signerCertSha256).toEqual([pinFor('tailscale').certSha256]);
  });
});

describe.skipIf(!fs.existsSync(R1CORD))('real R1CORD APK', () => {
  it('verifies and carries the pinned CHIPPWALTERS signer', () => {
    const info = verifyApk(R1CORD);
    expect(info.package).toBe('com.chippwalters.r1cord');
    expect(info.versionCode).toBe(16);
    expect(info.versionName).toBe('0.3.4');
    expect(checkPinned(info, pinFor('r1cord')).signerCertSha256).toEqual([pinFor('r1cord').certSha256]);
  });
});
