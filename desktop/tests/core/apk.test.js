// APK Signature Scheme v2/v3 verification and binary-manifest parsing, on synthetic APKs signed at
// run time (tests/core/apk-fixture.js).
import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ApkVerifyError, checkPinned, parseBinaryManifest, verifyApk } = require('../../src/core/apk');
const { buildApk, buildAxml, buildUnsignedApk, lineageAttr, makeSigner } = require('./apk-fixture');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-apk-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function write(bytes) {
  counter += 1;
  const file = path.join(dir, `t${counter}.apk`);
  fs.writeFileSync(file, bytes);
  return file;
}

const ec = makeSigner('ec');
const ec2 = makeSigner('ec');
const rsa = makeSigner('rsa');
const manifest = buildAxml({ package: 'com.example.recorder', versionCode: 17, versionName: '0.4.0', minSdk: 33 });

function expectRefused(bytes, pattern) {
  const file = write(bytes);
  let caught = null;
  try {
    verifyApk(file);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApkVerifyError);
  expect(caught.message).toMatch(pattern);
}

describe('verifyApk', () => {
  it('accepts a v2 ECDSA-signed APK and reports its identity and signer', () => {
    const info = verifyApk(write(buildApk({ manifest, v2: [{ identity: ec }] })));
    expect(info).toEqual({
      package: 'com.example.recorder',
      versionCode: 17,
      versionName: '0.4.0',
      minSdk: 33,
      signerCertSha256: [ec.certSha256],
      schemes: [2],
    });
  });

  it('accepts RSA PKCS#1 and PSS signatures, and v2+v3 by the same signer', () => {
    for (const algorithm of [0x0103, 0x0101, 0x0104, 0x0102]) {
      const info = verifyApk(write(buildApk({ manifest, v2: [{ identity: rsa, algorithm }], v3: [{ identity: rsa, algorithm }] })));
      expect(info.schemes).toEqual([2, 3]);
      expect(info.signerCertSha256).toEqual([rsa.certSha256]);
    }
  });

  it('refuses an APK whose entry bytes changed after signing', () => {
    const bytes = buildApk({ manifest, v2: [{ identity: ec }] });
    const dex = bytes.indexOf(Buffer.alloc(16, 7));
    bytes[dex + 5] ^= 0xff;
    expectRefused(bytes, /content digest mismatch/);
  });

  it('refuses a signed digest that does not match the signature', () => {
    // The signer signs a wrong digest: the signature is valid, the content digest is not.
    expectRefused(buildApk({ manifest, v2: [{ identity: ec, digestOverride: Buffer.alloc(32, 1) }] }), /content digest mismatch/);
    // Bytes changed inside the signed data: the signature no longer verifies.
    const bytes = buildApk({ manifest, v2: [{ identity: ec }] });
    const certAt = bytes.indexOf(ec.cert);
    bytes[certAt + ec.cert.length - 5] ^= 0x01;
    expectRefused(bytes, /ECDSA with SHA2-256 signature does not verify/);
  });

  it('refuses a certificate whose key is not the signing key', () => {
    expectRefused(buildApk({ manifest, v2: [{ identity: ec, certIdentity: ec2 }] }), /does not match the signer's public key/);
  });

  it('refuses DSA and other unsupported signature algorithms', () => {
    expectRefused(buildApk({ manifest, v2: [{ identity: ec, algorithm: 0x0301 }] }), /no supported signature algorithm \(found 0x0301\)/);
    expectRefused(buildApk({ manifest, v2: [{ identity: ec, algorithm: 0x0421 }] }), /no supported signature algorithm/);
  });

  it('refuses an algorithm that does not fit the key', () => {
    expectRefused(buildApk({ manifest, v2: [{ identity: ec, algorithm: 0x0103 }] }), /with a ec key/);
  });

  it('refuses more than one signer', () => {
    expectRefused(buildApk({ manifest, v2: [{ identity: ec }, { identity: ec2 }] }), /2 signers; exactly one is required/);
    expectRefused(buildApk({ manifest, v3: [{ identity: ec }, { identity: ec2 }] }), /v3 block has 2 signers/);
  });

  it('refuses v2 and v3 blocks from different signers', () => {
    expectRefused(buildApk({ manifest, v2: [{ identity: ec }], v3: [{ identity: ec2 }] }), /v2 and v3 signers disagree/);
  });

  it('refuses an APK without a signing block, and a v2 block whose v3 was stripped', () => {
    expectRefused(buildUnsignedApk({ manifest }), /no APK Signing Block/);
    const strip = { id: 0xbeeff00d, value: Buffer.from([3, 0, 0, 0]) };
    expectRefused(buildApk({ manifest, v2: [{ identity: ec, attributes: [strip] }] }), /v3 signature was stripped/);
  });

  it('refuses a truncated file and a non-ZIP file', () => {
    const bytes = buildApk({ manifest, v2: [{ identity: ec }] });
    expectRefused(bytes.subarray(0, bytes.length - 30), /not a ZIP file|central directory/);
    expectRefused(crypto.randomBytes(4096), /not a ZIP file/);
  });

  it('follows a v3 rotation lineage and reports the final certificate', () => {
    const por = { id: 0x3ba06f8c, value: lineageAttr([ec, ec2]) };
    const info = verifyApk(write(buildApk({ manifest, v2: [{ identity: ec }], v3: [{ identity: ec2, attributes: [por] }] })));
    expect(info.signerCertSha256).toEqual([ec2.certSha256]);
    expect(info.schemes).toEqual([2, 3]);
  });

  it('refuses a lineage with a forged link or one that does not end at the signer', () => {
    const forged = { id: 0x3ba06f8c, value: lineageAttr([ec, ec2], 0x0201, { breakSignature: true }) };
    expectRefused(buildApk({ manifest, v3: [{ identity: ec2, attributes: [forged] }] }), /proof-of-rotation level 2: .*does not verify/);
    const wrongEnd = { id: 0x3ba06f8c, value: lineageAttr([ec2, ec]) };
    expectRefused(buildApk({ manifest, v3: [{ identity: ec2, attributes: [wrongEnd] }] }), /last proof-of-rotation certificate is not the signing certificate/);
  });
});

describe('checkPinned', () => {
  const info = { package: 'com.example.recorder', signerCertSha256: [ec.certSha256] };

  it('passes the pinned package and certificate', () => {
    expect(checkPinned(info, { package: 'com.example.recorder', certSha256: ec.certSha256 })).toBe(info);
  });

  it('refuses another signer or another package', () => {
    expect(() => checkPinned(info, { package: 'com.example.recorder', certSha256: ec2.certSha256 })).toThrow(/not the pinned/);
    expect(() => checkPinned(info, { package: 'com.example.other', certSha256: ec.certSha256 })).toThrow(/expected com\.example\.other/);
    expect(() => checkPinned(info, null)).toThrow(ApkVerifyError);
  });

  it('refuses a verified APK signed by a key other than the pin', () => {
    const got = verifyApk(write(buildApk({ manifest, v2: [{ identity: ec2 }] })));
    expect(() => checkPinned(got, { package: 'com.example.recorder', certSha256: ec.certSha256 })).toThrow(/not the pinned/);
  });
});

describe('parseBinaryManifest', () => {
  it('reads package, versionCode, versionName and minSdk from UTF-16 and UTF-8 string pools', () => {
    for (const utf8 of [false, true]) {
      expect(parseBinaryManifest(buildAxml({ package: 'com.example.app', versionCode: 298177930, versionName: '1.2.3-x', minSdk: 26, utf8 }))).toEqual({
        package: 'com.example.app',
        versionCode: 298177930,
        versionName: '1.2.3-x',
        minSdk: 26,
      });
    }
  });

  it('defaults minSdk to 1 without <uses-sdk>', () => {
    expect(parseBinaryManifest(buildAxml({ minSdk: null })).minSdk).toBe(1);
  });

  it('refuses a document that is not a manifest, or is cut short', () => {
    expect(() => parseBinaryManifest(buildAxml({ root: 'application' }))).toThrow(/root element is <application>/);
    const whole = buildAxml();
    expect(() => parseBinaryManifest(whole.subarray(0, whole.length - 10))).toThrow(ApkVerifyError);
    expect(() => parseBinaryManifest(Buffer.from('<manifest/>'))).toThrow(/not a binary XML file/);
    expect(() => parseBinaryManifest(buildAxml({ package: 'nodots' }))).toThrow(/invalid package name/);
  });
});
