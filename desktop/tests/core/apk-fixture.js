// Synthetic APKs for the verifier tests: a binary AndroidManifest.xml writer, a minimal ZIP writer,
// a self-signed X.509 certificate writer and an APK Signing Block (v2/v3) writer. Keys are made at
// run time; nothing secret is stored in the repo.

'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');

// --- little-endian helpers -----------------------------------------------------------------------

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

function u64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

/** uint32 length prefix. */
function lp(...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length), body]);
}

// --- binary XML ----------------------------------------------------------------------------------

const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

function stringPool(strings, utf8) {
  const encoded = strings.map((s) => {
    if (utf8) {
      const bytes = Buffer.from(s, 'utf8');
      return Buffer.concat([Buffer.from([s.length, bytes.length]), bytes, Buffer.from([0])]);
    }
    return Buffer.concat([u16(s.length), Buffer.from(s, 'utf16le'), u16(0)]);
  });
  const offsets = [];
  let at = 0;
  for (const e of encoded) {
    offsets.push(at);
    at += e.length;
  }
  let data = Buffer.concat(encoded);
  if (data.length % 4) data = Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]);
  const headerSize = 28;
  const stringsStart = headerSize + 4 * strings.length;
  const size = stringsStart + data.length;
  return Buffer.concat([
    u16(0x0001), u16(headerSize), u32(size),
    u32(strings.length), u32(0), u32(utf8 ? 0x100 : 0), u32(stringsStart), u32(0),
    ...offsets.map(u32), data,
  ]);
}

/**
 * A binary AndroidManifest.xml:
 * <manifest package versionCode versionName><uses-sdk minSdkVersion/></manifest>.
 * Options: { package, versionCode, versionName, minSdk (null = no uses-sdk), utf8, root }.
 */
function buildAxml({ package: pkg = 'com.example.app', versionCode = 17, versionName = '0.4.0', minSdk = 33, utf8 = false, root = 'manifest' } = {}) {
  // Attribute names first so the resource map lines up with their string indexes.
  const strings = ['versionCode', 'versionName', 'minSdkVersion', 'package', root, 'uses-sdk', ANDROID_NS, 'android', pkg, versionName];
  const S = Object.fromEntries(strings.map((s, i) => [s, i]));
  const NONE = 0xffffffff;
  const pool = stringPool(strings, utf8);
  const resMap = Buffer.concat([u16(0x0180), u16(8), u32(8 + 12), u32(0x0101021b), u32(0x0101021c), u32(0x0101020c)]);
  const attr = (ns, name, raw, type, data) => Buffer.concat([u32(ns), u32(name), u32(raw), u16(8), Buffer.from([0, type]), u32(data)]);
  const start = (name, attrs) =>
    Buffer.concat([
      u16(0x0102), u16(16), u32(16 + 20 + 20 * attrs.length), u32(1), u32(NONE),
      u32(NONE), u32(S[name]), u16(20), u16(20), u16(attrs.length), u16(0), u16(0), u16(0),
      ...attrs,
    ]);
  const end = (name) => Buffer.concat([u16(0x0103), u16(16), u32(24), u32(1), u32(NONE), u32(NONE), u32(S[name])]);
  const ns = (type) => Buffer.concat([u16(type), u16(16), u32(24), u32(1), u32(NONE), u32(S.android), u32(S[ANDROID_NS])]);
  const manifestAttrs = [
    attr(S[ANDROID_NS], S.versionCode, NONE, 0x10, versionCode),
    attr(S[ANDROID_NS], S.versionName, S[versionName], 0x03, S[versionName]),
    attr(NONE, S.package, S[pkg], 0x03, S[pkg]),
  ];
  const body = [ns(0x0100), start(root, manifestAttrs)];
  if (minSdk !== null) body.push(start('uses-sdk', [attr(S[ANDROID_NS], S.minSdkVersion, NONE, 0x10, minSdk)]), end('uses-sdk'));
  body.push(end(root), ns(0x0101));
  const content = Buffer.concat([pool, resMap, ...body]);
  return Buffer.concat([u16(0x0003), u16(8), u32(8 + content.length), content]);
}

// --- ZIP -----------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** { entries: Buffer (local headers + data), cd: Buffer, eocd(cdOffset): Buffer } for [{name, data, deflate}]. */
function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, deflate = false } of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const stored = deflate ? zlib.deflateRawSync(data) : data;
    const method = deflate ? 8 : 0;
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0x21), u32(crc),
      u32(stored.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes, stored,
    ]);
    centrals.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0x21), u32(crc),
      u32(stored.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(offset), nameBytes,
    ]));
    locals.push(local);
    offset += local.length;
  }
  const entries = Buffer.concat(locals);
  const cd = Buffer.concat(centrals);
  const eocd = (cdOffset) =>
    Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cd.length), u32(cdOffset), u16(0)]);
  return { entries, cd, eocd };
}

// --- X.509 ---------------------------------------------------------------------------------------

function der(tag, content) {
  const n = content.length;
  let len;
  if (n < 0x80) len = Buffer.from([n]);
  else if (n < 0x100) len = Buffer.from([0x81, n]);
  else len = Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, content]);
}

function oid(text) {
  const parts = text.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const stack = [p & 0x7f];
    let v = p >>> 7;
    while (v) {
      stack.unshift((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    bytes.push(...stack);
  }
  return der(0x06, Buffer.from(bytes));
}

const seq = (...parts) => der(0x30, Buffer.concat(parts));

/** A self-signed certificate (DER) whose subject key is `publicKey`, signed by `signingKey`. */
function selfSignedCert(publicKey, signingKey = null, commonName = 'R1CORD test') {
  const signer = signingKey || null;
  const keyType = (signer ? crypto.createPublicKey(signer) : publicKey).asymmetricKeyType;
  const algId = keyType === 'rsa' ? seq(oid('1.2.840.113549.1.1.11'), der(0x05, Buffer.alloc(0))) : seq(oid('1.2.840.10045.4.3.2'));
  const name = seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from(commonName)))));
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, crypto.randomBytes(8).fill(0x11, 0, 1)),
    algId,
    name,
    seq(der(0x17, Buffer.from('250101000000Z')), der(0x17, Buffer.from('450101000000Z'))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = signer ? crypto.sign('sha256', tbs, signer) : Buffer.alloc(8);
  return seq(tbs, algId, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
}

/** A fresh signing identity: { privateKey, publicKey, cert (DER), certSha256 }. */
function makeSigner(type = 'ec') {
  const { privateKey, publicKey } =
    type === 'rsa'
      ? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
      : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const cert = selfSignedCert(publicKey, privateKey);
  return { privateKey, publicKey, cert, certSha256: crypto.createHash('sha256').update(cert).digest('hex') };
}

// --- APK Signing Block ---------------------------------------------------------------------------

const HASH = { 0x0101: 'sha256', 0x0102: 'sha512', 0x0103: 'sha256', 0x0104: 'sha512', 0x0201: 'sha256', 0x0202: 'sha512', 0x0301: 'sha256' };

function signBytes(algorithm, key, data) {
  const hash = HASH[algorithm];
  if (algorithm === 0x0101 || algorithm === 0x0102) {
    return crypto.sign(hash, data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: hash === 'sha256' ? 32 : 64 });
  }
  if (algorithm === 0x0103 || algorithm === 0x0104) return crypto.sign(hash, data, { key, padding: crypto.constants.RSA_PKCS1_PADDING });
  if (algorithm === 0x0201 || algorithm === 0x0202) return crypto.sign(hash, data, { key, dsaEncoding: 'der' });
  return crypto.randomBytes(64); // an algorithm the verifier must not accept
}

function contentDigest(hash, sections) {
  const chunks = [];
  for (const section of sections) {
    for (let at = 0; at < section.length; at += 1024 * 1024) {
      const chunk = section.subarray(at, Math.min(section.length, at + 1024 * 1024));
      chunks.push(crypto.createHash(hash).update(Buffer.from([0xa5])).update(u32(chunk.length)).update(chunk).digest());
    }
  }
  const top = crypto.createHash(hash).update(Buffer.from([0x5a])).update(u32(chunks.length));
  for (const c of chunks) top.update(c);
  return top.digest();
}

/** v3 proof-of-rotation attribute value for identities [oldest … newest]. */
function lineageAttr(identities, algorithm = 0x0201, { breakSignature = false } = {}) {
  const levels = identities.map((id, i) => {
    const signedData = Buffer.concat([lp(id.cert), u32(algorithm)]);
    let signature = i === 0 ? Buffer.alloc(0) : signBytes(algorithm, identities[i - 1].privateKey, signedData);
    if (breakSignature && i > 0) signature = Buffer.from(signature.map((b, j) => (j === 8 ? b ^ 1 : b)));
    return lp(lp(signedData), u32(0), u32(algorithm), lp(signature));
  });
  return Buffer.concat([u32(1), ...levels]);
}

/**
 * A signer record. `signer` options: { identity, algorithm, scheme, certIdentity (cert from another
 * key), attributes: [{id, value}], digestOverride }.
 */
function signerRecord(scheme, digestBySection, s) {
  const algorithm = s.algorithm || (s.identity.publicKey.asymmetricKeyType === 'rsa' ? 0x0103 : 0x0201);
  const digest = s.digestOverride || digestBySection(HASH[algorithm] || 'sha256');
  const cert = (s.certIdentity || s.identity).cert;
  const attrs = (s.attributes || []).map((a) => lp(u32(a.id), a.value));
  const sdk = scheme === 3 ? Buffer.concat([u32(24), u32(0x7fffffff)]) : Buffer.alloc(0);
  const signedData = Buffer.concat([
    lp(lp(u32(algorithm), lp(digest))),
    lp(lp(cert)),
    sdk,
    lp(...attrs),
    scheme === 2 ? u32(0) : Buffer.alloc(0),
  ]);
  const signature = signBytes(algorithm, s.identity.privateKey, signedData);
  return lp(
    lp(signedData),
    sdk,
    lp(lp(u32(algorithm), lp(signature))),
    lp(s.identity.publicKey.export({ type: 'spki', format: 'der' })),
  );
}

/**
 * A signed APK. Options: { manifest: AXML buffer, files: extra [{name, data}], v2: [signer...],
 * v3: [signer...] } where each signer is as for signerRecord.
 */
function buildApk({ manifest = buildAxml(), files = [{ name: 'classes.dex', data: Buffer.alloc(3000, 7) }], v2 = null, v3 = null } = {}) {
  const zip = buildZip([{ name: 'AndroidManifest.xml', data: manifest, deflate: true }, ...files]);
  const blockStart = zip.entries.length;
  const digestBySection = (hash) => contentDigest(hash, [zip.entries, zip.cd, zip.eocd(blockStart)]);
  const pairs = [];
  if (v2) pairs.push(pair(0x7109871a, lp(...v2.map((s) => signerRecord(2, digestBySection, s)))));
  if (v3) pairs.push(pair(0xf05368c0, lp(...v3.map((s) => signerRecord(3, digestBySection, s)))));
  const inner = Buffer.concat(pairs);
  const size = inner.length + 8 + 16; // pairs + trailing size + magic
  const block = Buffer.concat([u64(size), inner, u64(size), Buffer.from('APK Sig Block 42', 'latin1')]);
  return Buffer.concat([zip.entries, block, zip.cd, zip.eocd(blockStart + block.length)]);
}

function pair(id, value) {
  return Buffer.concat([u64(4 + value.length), u32(id), value]);
}

/** An unsigned ZIP with the same layout (no signing block). */
function buildUnsignedApk({ manifest = buildAxml() } = {}) {
  const zip = buildZip([{ name: 'AndroidManifest.xml', data: manifest, deflate: true }]);
  return Buffer.concat([zip.entries, zip.cd, zip.eocd(zip.entries.length)]);
}

module.exports = { buildApk, buildAxml, buildUnsignedApk, lineageAttr, makeSigner };
