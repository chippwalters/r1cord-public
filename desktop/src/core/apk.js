// APK verification for the R1 installers: APK Signature Scheme v2/v3 and the package identity from
// the binary AndroidManifest.xml, with nothing but node:crypto, node:zlib and node:fs.
//
// Fail-closed: anything this file does not fully understand is an ApkVerifyError, never a pass.
// It accepts exactly one signer per scheme block, a v2 and/or v3 block (v1-only APKs are refused),
// the RSA (PSS, PKCS#1 v1.5) and ECDSA algorithms with SHA-256/512, and a v3 proof-of-rotation
// lineage, whose final certificate is the one reported. The content digests are recomputed over
// the whole file in 1 MiB chunks, read through one bounded buffer, so a 100 MB APK is read once.
// Format references: source.android.com "APK Signature Scheme v2" / "v3", and AOSP's
// ApkSignatureSchemeV2Verifier / V3Verifier and ResourceTypes.h (binary XML).

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const zlib = require('node:zlib');

class ApkVerifyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApkVerifyError';
  }
}

function fail(message) {
  throw new ApkVerifyError(message);
}

const EOCD_SIG = 0x06054b50;
const EOCD_SIZE = 22;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const SIG_BLOCK_MAGIC = Buffer.from('APK Sig Block 42', 'latin1');
const V2_BLOCK_ID = 0x7109871a;
const V3_BLOCK_ID = 0xf05368c0;
const V31_BLOCK_ID = 0x1b93ad61;
const PROOF_OF_ROTATION_ATTR = 0x3ba06f8c;
const STRIPPING_PROTECTION_ATTR = 0xbeeff00d;
const CHUNK_SIZE = 1024 * 1024;
const MAX_SIGNING_BLOCK = 32 * 1024 * 1024;
const MAX_CENTRAL_DIRECTORY = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MANIFEST_NAME = 'AndroidManifest.xml';

// Signature algorithm ids from the v2 spec. The content digest family follows the hash.
const ALGORITHMS = new Map([
  [0x0101, { name: 'RSASSA-PSS with SHA2-256', key: 'rsa', hash: 'sha256', pssSalt: 32 }],
  [0x0102, { name: 'RSASSA-PSS with SHA2-512', key: 'rsa', hash: 'sha512', pssSalt: 64 }],
  [0x0103, { name: 'RSASSA-PKCS1-v1_5 with SHA2-256', key: 'rsa', hash: 'sha256' }],
  [0x0104, { name: 'RSASSA-PKCS1-v1_5 with SHA2-512', key: 'rsa', hash: 'sha512' }],
  [0x0201, { name: 'ECDSA with SHA2-256', key: 'ec', hash: 'sha256' }],
  [0x0202, { name: 'ECDSA with SHA2-512', key: 'ec', hash: 'sha512' }],
]);

function hex32(value) {
  return `0x${(value >>> 0).toString(16).padStart(4, '0')}`;
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// --- file access ---------------------------------------------------------------------------------

class ApkFile {
  constructor(filePath) {
    try {
      this.fd = fs.openSync(filePath, 'r');
    } catch (error) {
      fail(`cannot open ${filePath}: ${error.message}`);
    }
    this.size = fs.fstatSync(this.fd).size;
  }

  readInto(buffer, length, position) {
    let done = 0;
    while (done < length) {
      const n = fs.readSync(this.fd, buffer, done, length - done, position + done);
      if (n === 0) fail('unexpected end of file');
      done += n;
    }
    return buffer.subarray(0, length);
  }

  read(position, length) {
    if (position < 0 || length < 0 || position + length > this.size) fail('read outside the file');
    return this.readInto(Buffer.alloc(length), length, position);
  }

  close() {
    fs.closeSync(this.fd);
  }
}

function readU64(buffer, offset) {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('APK Signing Block size is out of range');
  return Number(value);
}

// Little-endian cursor over a signing-block structure; every overrun is an ApkVerifyError.
class Reader {
  constructor(buffer, what) {
    this.buffer = buffer;
    this.what = what;
    this.pos = 0;
  }

  get remaining() {
    return this.buffer.length - this.pos;
  }

  need(n) {
    if (n > this.remaining) fail(`${this.what}: truncated`);
  }

  u32() {
    this.need(4);
    const value = this.buffer.readUInt32LE(this.pos);
    this.pos += 4;
    return value;
  }

  bytes(n) {
    this.need(n);
    const out = this.buffer.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** A uint32-length-prefixed byte string. */
  lpBytes() {
    return this.bytes(this.u32());
  }

  /** A uint32-length-prefixed structure, as its own Reader. */
  lp(what) {
    return new Reader(this.lpBytes(), what);
  }

  rest() {
    return this.bytes(this.remaining);
  }

  end() {
    if (this.remaining !== 0) fail(`${this.what}: ${this.remaining} unexpected trailing bytes`);
  }

  /** The length-prefixed items of a length-prefixed sequence. */
  items(what) {
    const out = [];
    while (this.remaining > 0) out.push(this.lp(what));
    return out;
  }
}

// --- ZIP layout ----------------------------------------------------------------------------------

function findEocd(file) {
  if (file.size < EOCD_SIZE) fail('not a ZIP file (too small)');
  const window = Math.min(file.size, EOCD_SIZE + 0xffff);
  const base = file.size - window;
  const tail = file.read(base, window);
  for (let i = tail.length - EOCD_SIZE; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) !== EOCD_SIG) continue;
    if (i + EOCD_SIZE + tail.readUInt16LE(i + 20) !== tail.length) continue;
    const record = Buffer.from(tail.subarray(i));
    const offset = base + i;
    if (record.readUInt16LE(4) !== 0 || record.readUInt16LE(6) !== 0) fail('multi-disk ZIP files are not supported');
    const entries = record.readUInt16LE(10);
    if (record.readUInt16LE(8) !== entries) fail('ZIP entry counts disagree');
    const cdSize = record.readUInt32LE(12);
    const cdOffset = record.readUInt32LE(16);
    if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) fail('ZIP64 APKs are not supported');
    if (offset >= 20 && file.read(offset - 20, 4).readUInt32LE(0) === ZIP64_LOCATOR_SIG) fail('ZIP64 APKs are not supported');
    if (cdOffset + cdSize !== offset) fail('the ZIP central directory does not end at the end-of-central-directory record');
    return { offset, record, entries, cdSize, cdOffset };
  }
  return fail('not a ZIP file (no end-of-central-directory record)');
}

function findSigningBlock(file, cdOffset) {
  const unsigned = 'APK is not signed with APK Signature Scheme v2 or v3 (no APK Signing Block)';
  if (cdOffset < 32) fail(unsigned);
  const footer = file.read(cdOffset - 24, 24);
  if (!footer.subarray(8).equals(SIG_BLOCK_MAGIC)) fail(unsigned);
  const sizeInFooter = readU64(footer, 0);
  if (sizeInFooter < 24 || sizeInFooter > MAX_SIGNING_BLOCK) fail(`APK Signing Block size ${sizeInFooter} is out of range`);
  const total = sizeInFooter + 8;
  const start = cdOffset - total;
  if (start < 0) fail('APK Signing Block extends before the start of the file');
  const block = file.read(start, total);
  if (readU64(block, 0) !== sizeInFooter) fail('APK Signing Block size fields disagree');
  const pairs = new Map();
  const body = block.subarray(8, total - 24);
  let pos = 0;
  while (pos < body.length) {
    if (body.length - pos < 8) fail('APK Signing Block: truncated ID-value pair');
    const length = readU64(body, pos);
    if (length < 4 || length > body.length - pos - 8) fail('APK Signing Block: ID-value pair length out of range');
    const id = body.readUInt32LE(pos + 8);
    const value = body.subarray(pos + 12, pos + 8 + length);
    if (id === V2_BLOCK_ID || id === V3_BLOCK_ID || id === V31_BLOCK_ID) {
      if (pairs.has(id)) fail(`APK Signing Block: duplicate block ${hex32(id)}`);
      pairs.set(id, value);
    }
    pos += 8 + length;
  }
  return { start, pairs };
}

// --- signers -------------------------------------------------------------------------------------

function publicKeyFrom(der, what) {
  try {
    return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch (error) {
    return fail(`${what}: unreadable public key (${error.message})`);
  }
}

function certificateFrom(der, what) {
  try {
    return new crypto.X509Certificate(der);
  } catch (error) {
    return fail(`${what}: unreadable X.509 certificate (${error.message})`);
  }
}

function spki(key) {
  return key.export({ type: 'spki', format: 'der' });
}

/** Verify one signature; the algorithm must be supported and match the key type. */
function verifySignature(algorithmId, key, data, signature, what) {
  const algorithm = ALGORITHMS.get(algorithmId);
  if (!algorithm) fail(`${what}: unsupported signature algorithm ${hex32(algorithmId)}`);
  if (key.asymmetricKeyType !== algorithm.key) {
    fail(`${what}: ${algorithm.name} signature with a ${key.asymmetricKeyType} key`);
  }
  const options =
    algorithm.key === 'rsa'
      ? algorithm.pssSalt
        ? { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: algorithm.pssSalt }
        : { key, padding: crypto.constants.RSA_PKCS1_PADDING }
      : { key, dsaEncoding: 'der' };
  let ok = false;
  try {
    ok = crypto.verify(algorithm.hash, data, options, signature);
  } catch (_error) {
    ok = false;
  }
  if (!ok) fail(`${what}: ${algorithm.name} signature does not verify`);
}

/** The v3 proof-of-rotation lineage: each certificate signed by the one before it. */
function verifyLineage(value, what) {
  const r = new Reader(value, `${what} proof-of-rotation`);
  const version = r.u32();
  if (version !== 1) fail(`${what}: unsupported proof-of-rotation version ${version}`);
  const certs = [];
  const seen = new Set();
  let lastKey = null;
  let lastAlgorithm = 0;
  while (r.remaining > 0) {
    const level = r.lp(`${what} proof-of-rotation level ${certs.length + 1}`);
    const signedData = level.lpBytes();
    level.u32(); // flags
    const algorithm = level.u32();
    const signature = level.lpBytes();
    level.end();
    const sd = new Reader(signedData, `${what} proof-of-rotation level ${certs.length + 1}`);
    const certDer = sd.lpBytes();
    const signedAlgorithm = sd.u32();
    sd.end();
    if (lastKey !== null) {
      if (signedAlgorithm !== lastAlgorithm) fail(`${what}: proof-of-rotation signature algorithm mismatch at level ${certs.length + 1}`);
      verifySignature(lastAlgorithm, lastKey, signedData, signature, `${what} proof-of-rotation level ${certs.length + 1}`);
    }
    const cert = certificateFrom(certDer, `${what} proof-of-rotation`);
    const digest = sha256Hex(certDer);
    if (seen.has(digest)) fail(`${what}: duplicate certificate in the proof-of-rotation lineage`);
    seen.add(digest);
    certs.push(Buffer.from(certDer));
    lastKey = cert.publicKey;
    lastAlgorithm = algorithm;
  }
  if (!certs.length) fail(`${what}: empty proof-of-rotation lineage`);
  return certs;
}

function parseSigner(blockValue, scheme) {
  const what = `v${scheme} signer`;
  const block = new Reader(blockValue, `v${scheme} block`);
  const signers = block.lp(`v${scheme} signers`).items(what);
  block.end();
  if (signers.length === 0) fail(`APK Signature Scheme v${scheme} block has no signers`);
  if (signers.length > 1) fail(`APK Signature Scheme v${scheme} block has ${signers.length} signers; exactly one is required`);
  const r = signers[0];

  const signedDataBytes = r.lpBytes();
  let minSdk = null;
  let maxSdk = null;
  if (scheme === 3) {
    minSdk = r.u32();
    maxSdk = r.u32();
  }
  const signatures = r.lp(`${what} signatures`).items(`${what} signature`).map((s) => {
    const algorithm = s.u32();
    const signature = s.lpBytes();
    s.end();
    return { algorithm, signature };
  });
  const publicKeyBytes = r.lpBytes();
  r.end();

  const sd = new Reader(signedDataBytes, `${what} signed data`);
  const digests = sd.lp(`${what} digests`).items(`${what} digest`).map((d) => {
    const algorithm = d.u32();
    const digest = d.lpBytes();
    d.end();
    return { algorithm, digest };
  });
  const certificates = sd.lp(`${what} certificates`).items(`${what} certificate`).map((c) => c.rest());
  // v3 signed data carries the SDK range between the certificates and the attributes.
  if (scheme === 3) {
    const signedMin = sd.u32();
    const signedMax = sd.u32();
    if (signedMin !== minSdk || signedMax !== maxSdk) fail('v3 signer: SDK range differs between signed and unsigned data');
    if (minSdk > maxSdk) fail('v3 signer: minSdk is greater than maxSdk');
  }
  const attributes = sd.lp(`${what} attributes`).items(`${what} attribute`).map((a) => ({ id: a.u32(), value: a.rest() }));
  // Trailing bytes are ignored as Android ignores them (apksigner writes a zero uint32); they are
  // inside the signed data, so they cannot be altered without breaking the signature.

  // Android requires the same algorithms, in the same order, in the digests and signatures.
  if (!signatures.length) fail(`${what}: no signatures`);
  const sigIds = signatures.map((s) => s.algorithm);
  const digestIds = digests.map((d) => d.algorithm);
  if (sigIds.length !== digestIds.length || sigIds.some((id, i) => id !== digestIds[i])) {
    fail(`${what}: signature algorithms differ between digests and signatures`);
  }
  if (new Set(sigIds).size !== sigIds.length) fail(`${what}: duplicate signature algorithm`);
  const supported = signatures.filter((s) => ALGORITHMS.has(s.algorithm));
  if (!supported.length) {
    fail(`${what}: no supported signature algorithm (found ${sigIds.map(hex32).join(', ')}); DSA and verity-only signatures are not accepted`);
  }

  const key = publicKeyFrom(publicKeyBytes, what);
  for (const s of supported) verifySignature(s.algorithm, key, signedDataBytes, s.signature, what);

  if (!certificates.length) fail(`${what}: no certificates`);
  const cert = certificateFrom(certificates[0], what);
  if (!spki(cert.publicKey).equals(spki(key))) fail(`${what}: first certificate's public key does not match the signer's public key`);

  const expected = supported.map((s) => ({
    algorithm: s.algorithm,
    family: ALGORITHMS.get(s.algorithm).hash,
    digest: digests.find((d) => d.algorithm === s.algorithm).digest,
  }));

  let certDer = Buffer.from(certificates[0]);
  let lineage = null;
  const por = attributes.filter((a) => a.id === PROOF_OF_ROTATION_ATTR);
  if (scheme === 3 && por.length > 1) fail('v3 signer: more than one proof-of-rotation attribute');
  if (scheme === 3 && por.length === 1) {
    lineage = verifyLineage(por[0].value, what);
    if (!lineage[lineage.length - 1].equals(certDer)) {
      fail('v3 signer: the last proof-of-rotation certificate is not the signing certificate');
    }
    certDer = lineage[lineage.length - 1];
  }
  const strippingProtection = scheme === 2 && attributes.some(
    (a) => a.id === STRIPPING_PROTECTION_ATTR && a.value.length >= 4 && a.value.readUInt32LE(0) === 3,
  );
  return { scheme, certDer, lineage, expected, minSdk, maxSdk, strippingProtection };
}

// --- content digests -----------------------------------------------------------------------------

/** Top-level chunked digests per family over sections A, C and the patched EOCD (E). */
function contentDigests(file, families, blockStart, eocd) {
  const chunks = new Map(families.map((family) => [family, []]));
  const prefix = Buffer.alloc(5);
  prefix[0] = 0xa5;
  const addChunk = (data) => {
    prefix.writeUInt32LE(data.length, 1);
    for (const family of families) {
      chunks.get(family).push(crypto.createHash(family).update(prefix).update(data).digest());
    }
  };
  const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
  const section = (start, end) => {
    for (let pos = start; pos < end; pos += CHUNK_SIZE) {
      addChunk(file.readInto(buffer, Math.min(CHUNK_SIZE, end - pos), pos));
    }
  };
  section(0, blockStart);
  section(eocd.cdOffset, eocd.offset);
  const record = Buffer.from(eocd.record);
  record.writeUInt32LE(blockStart, 16);
  addChunk(record);

  const out = new Map();
  for (const family of families) {
    const list = chunks.get(family);
    const head = Buffer.alloc(5);
    head[0] = 0x5a;
    head.writeUInt32LE(list.length, 1);
    const hash = crypto.createHash(family).update(head);
    for (const digest of list) hash.update(digest);
    out.set(family, hash.digest());
  }
  return out;
}

// --- ZIP entry and binary XML --------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The uncompressed AndroidManifest.xml from the ZIP, which must lie before the signing block. */
function readManifestEntry(file, eocd, blockStart) {
  if (eocd.cdSize > MAX_CENTRAL_DIRECTORY) fail('ZIP central directory is too large');
  const cd = file.read(eocd.cdOffset, eocd.cdSize);
  let pos = 0;
  let found = null;
  for (let i = 0; i < eocd.entries; i += 1) {
    if (cd.length - pos < 46 || cd.readUInt32LE(pos) !== CD_SIG) fail('ZIP central directory is malformed');
    const nameLength = cd.readUInt16LE(pos + 28);
    const next = pos + 46 + nameLength + cd.readUInt16LE(pos + 30) + cd.readUInt16LE(pos + 32);
    if (next > cd.length) fail('ZIP central directory is malformed');
    const name = cd.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
    if (name === MANIFEST_NAME) {
      if (found) fail('APK has more than one AndroidManifest.xml');
      found = {
        flags: cd.readUInt16LE(pos + 8),
        method: cd.readUInt16LE(pos + 10),
        crc: cd.readUInt32LE(pos + 16),
        compressedSize: cd.readUInt32LE(pos + 20),
        size: cd.readUInt32LE(pos + 24),
        localOffset: cd.readUInt32LE(pos + 42),
      };
    }
    pos = next;
  }
  if (pos !== cd.length) fail('ZIP central directory size does not match its entries');
  if (!found) fail('APK has no AndroidManifest.xml');
  if (found.flags & 1) fail('AndroidManifest.xml is encrypted');
  if (found.size > MAX_MANIFEST_BYTES || found.compressedSize > MAX_MANIFEST_BYTES) fail('AndroidManifest.xml is too large');
  if (found.localOffset + 30 > blockStart) fail('AndroidManifest.xml lies outside the signed ZIP entries');
  const header = file.read(found.localOffset, 30);
  if (header.readUInt32LE(0) !== LFH_SIG) fail('AndroidManifest.xml local header is malformed');
  const localNameLength = header.readUInt16LE(26);
  const dataStart = found.localOffset + 30 + localNameLength + header.readUInt16LE(28);
  if (dataStart + found.compressedSize > blockStart) fail('AndroidManifest.xml lies outside the signed ZIP entries');
  if (file.read(found.localOffset + 30, localNameLength).toString('utf8') !== MANIFEST_NAME) {
    fail('AndroidManifest.xml local header name differs from the central directory');
  }
  const data = file.read(dataStart, found.compressedSize);
  let content;
  if (found.method === 0) {
    content = data;
  } else if (found.method === 8) {
    try {
      content = zlib.inflateRawSync(data, { maxOutputLength: MAX_MANIFEST_BYTES });
    } catch (error) {
      fail(`AndroidManifest.xml does not inflate (${error.message})`);
    }
  } else {
    fail(`AndroidManifest.xml uses unsupported compression method ${found.method}`);
  }
  if (content.length !== found.size) fail('AndroidManifest.xml size differs from the central directory');
  if (crc32(content) !== found.crc) fail('AndroidManifest.xml CRC-32 mismatch');
  return content;
}

const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_TYPE = 0x0003;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_END_ELEMENT_TYPE = 0x0103;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
const UTF8_FLAG = 0x100;
const NO_INDEX = 0xffffffff;
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const ANDROID_NS = 'http://schemas.android.com/apk/res/android';
const ATTR_IDS = {
  versionCode: 0x0101021b,
  versionName: 0x0101021c,
  minSdkVersion: 0x0101020c,
  versionCodeMajor: 0x01010576,
};

function axmlFail(message) {
  return fail(`AndroidManifest.xml: ${message}`);
}

function parseStringPool(xml, start, headerSize, size) {
  if (headerSize < 28) axmlFail('string pool header too small');
  const count = xml.readUInt32LE(start + 8);
  const flags = xml.readUInt32LE(start + 16);
  const stringsStart = xml.readUInt32LE(start + 20);
  const end = start + size;
  if (start + headerSize + count * 4 > end) axmlFail('string pool offsets overrun');
  const utf8 = (flags & UTF8_FLAG) !== 0;
  const cache = new Map();
  const get = (index) => {
    if (index === NO_INDEX) return null;
    if (index >= count) axmlFail('string index out of range');
    if (cache.has(index)) return cache.get(index);
    let pos = start + stringsStart + xml.readUInt32LE(start + headerSize + index * 4);
    const need = (n) => {
      if (pos + n > end) axmlFail('string overruns the string pool');
    };
    let value;
    if (utf8) {
      const len8 = () => {
        need(1);
        let n = xml[pos++];
        if (n & 0x80) {
          need(1);
          n = ((n & 0x7f) << 8) | xml[pos++];
        }
        return n;
      };
      len8(); // UTF-16 length
      const bytes = len8();
      need(bytes);
      value = xml.toString('utf8', pos, pos + bytes);
    } else {
      need(2);
      let n = xml.readUInt16LE(pos);
      pos += 2;
      if (n & 0x8000) {
        need(2);
        n = ((n & 0x7fff) << 16) | xml.readUInt16LE(pos);
        pos += 2;
      }
      need(n * 2);
      value = xml.toString('utf16le', pos, pos + n * 2);
    }
    cache.set(index, value);
    return value;
  };
  return get;
}

/** package, versionCode, versionName and minSdk from a binary AndroidManifest.xml. */
function parseBinaryManifest(xml) {
  if (xml.length < 8 || xml.readUInt16LE(0) !== RES_XML_TYPE) axmlFail('not a binary XML file');
  const fileEnd = xml.readUInt32LE(4);
  if (fileEnd > xml.length || fileEnd < 8) axmlFail('bad file size');
  let pos = xml.readUInt16LE(2);
  let strings = null;
  let resourceMap = [];
  let depth = 0;
  let sawRoot = false;
  const manifest = { package: null, versionCode: null, versionCodeMajor: 0, versionName: null, minSdk: null };
  let usesSdkSeen = false;

  const attributeValue = (at, name, kind) => {
    const dataType = xml[at + 15];
    const data = xml.readInt32LE(at + 16);
    if (kind === 'int') {
      if (dataType === TYPE_INT_DEC || dataType === TYPE_INT_HEX) return data;
      return axmlFail(`${name} is not a literal integer`);
    }
    if (dataType === TYPE_STRING) return strings(data >>> 0);
    const rawIndex = xml.readUInt32LE(at + 8);
    if (rawIndex !== NO_INDEX) return strings(rawIndex);
    if (dataType === TYPE_INT_DEC || dataType === TYPE_INT_HEX) return String(data);
    return null;
  };

  while (pos < fileEnd) {
    if (fileEnd - pos < 8) axmlFail('truncated chunk');
    const type = xml.readUInt16LE(pos);
    const headerSize = xml.readUInt16LE(pos + 2);
    const size = xml.readUInt32LE(pos + 4);
    if (headerSize < 8 || size < headerSize || size > fileEnd - pos) axmlFail('malformed chunk');
    if (type === RES_STRING_POOL_TYPE) {
      if (strings) axmlFail('more than one string pool');
      strings = parseStringPool(xml, pos, headerSize, size);
    } else if (type === RES_XML_RESOURCE_MAP_TYPE) {
      resourceMap = [];
      for (let at = pos + headerSize; at + 4 <= pos + size; at += 4) resourceMap.push(xml.readUInt32LE(at));
    } else if (type === RES_XML_START_ELEMENT_TYPE) {
      if (!strings) axmlFail('element before the string pool');
      const ext = pos + headerSize;
      if (ext + 20 > pos + size) axmlFail('element header overrun');
      const elementName = strings(xml.readUInt32LE(ext + 4));
      const attributeStart = xml.readUInt16LE(ext + 8);
      const attributeSize = xml.readUInt16LE(ext + 10);
      const attributeCount = xml.readUInt16LE(ext + 12);
      if (attributeCount && attributeSize < 20) axmlFail('attribute record too small');
      if (ext + attributeStart + attributeCount * attributeSize > pos + size) axmlFail('attributes overrun');
      depth += 1;
      const isRoot = depth === 1;
      if (isRoot) {
        if (sawRoot) axmlFail('more than one root element');
        sawRoot = true;
        if (elementName !== 'manifest') axmlFail(`root element is <${elementName}>, not <manifest>`);
      }
      const isUsesSdk = depth === 2 && elementName === 'uses-sdk';
      if (isUsesSdk && usesSdkSeen) axmlFail('more than one <uses-sdk>');
      if (isUsesSdk) usesSdkSeen = true;
      if (isRoot || isUsesSdk) {
        for (let i = 0; i < attributeCount; i += 1) {
          const at = ext + attributeStart + i * attributeSize;
          const nsIndex = xml.readUInt32LE(at);
          const nameIndex = xml.readUInt32LE(at + 4);
          const resId = nameIndex < resourceMap.length ? resourceMap[nameIndex] : 0;
          const name = strings(nameIndex);
          const ns = strings(nsIndex);
          const is = (attr) => resId === ATTR_IDS[attr] || (resId === 0 && ns === ANDROID_NS && name === attr);
          if (isRoot) {
            if (nsIndex === NO_INDEX && name === 'package') manifest.package = attributeValue(at, 'package', 'string');
            else if (is('versionCode')) manifest.versionCode = attributeValue(at, 'versionCode', 'int');
            else if (is('versionCodeMajor')) manifest.versionCodeMajor = attributeValue(at, 'versionCodeMajor', 'int');
            else if (is('versionName')) manifest.versionName = attributeValue(at, 'versionName', 'string');
          } else if (is('minSdkVersion')) {
            manifest.minSdk = attributeValue(at, 'minSdkVersion', 'string');
            if (manifest.minSdk === null) axmlFail('minSdkVersion is not a literal value');
          }
        }
      }
    } else if (type === RES_XML_END_ELEMENT_TYPE) {
      depth -= 1;
      if (depth < 0) axmlFail('unbalanced elements');
    }
    pos += size;
  }
  if (!sawRoot) axmlFail('no <manifest> element');
  if (typeof manifest.package !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(manifest.package)) {
    axmlFail(`invalid package name ${JSON.stringify(manifest.package)}`);
  }
  const code = manifest.versionCode === null ? 0 : manifest.versionCode;
  if (code < 0 || manifest.versionCodeMajor < 0) axmlFail('negative versionCode');
  let minSdk = 1;
  if (manifest.minSdk !== null) {
    if (!/^\d+$/.test(manifest.minSdk)) axmlFail(`minSdkVersion ${JSON.stringify(manifest.minSdk)} is not a released API level`);
    minSdk = Number(manifest.minSdk);
  }
  return {
    package: manifest.package,
    versionCode: manifest.versionCodeMajor * 2 ** 32 + code,
    versionName: manifest.versionName,
    minSdk,
  };
}

// --- public API ----------------------------------------------------------------------------------

/**
 * Verify an APK's v2/v3 signature and content digests and read its identity.
 * @returns {{package: string, versionCode: number, versionName: string|null, minSdk: number,
 *   signerCertSha256: string[], schemes: number[]}}
 * @throws {ApkVerifyError}
 */
function verifyApk(filePath) {
  const file = new ApkFile(filePath);
  try {
    const eocd = findEocd(file);
    const block = findSigningBlock(file, eocd.cdOffset);
    if (block.pairs.has(V31_BLOCK_ID)) fail('APK Signature Scheme v3.1 is not supported');
    const signers = [];
    if (block.pairs.has(V2_BLOCK_ID)) signers.push(parseSigner(block.pairs.get(V2_BLOCK_ID), 2));
    if (block.pairs.has(V3_BLOCK_ID)) signers.push(parseSigner(block.pairs.get(V3_BLOCK_ID), 3));
    if (!signers.length) fail('APK is not signed with APK Signature Scheme v2 or v3');
    const v2 = signers.find((s) => s.scheme === 2);
    const v3 = signers.find((s) => s.scheme === 3);
    if (v2 && v2.strippingProtection && !v3) fail('APK was signed with v3 but its v3 signature was stripped');
    if (v2 && v3) {
      const v3Original = v3.lineage ? v3.lineage[0] : v3.certDer;
      if (!v2.certDer.equals(v3Original)) fail('v2 and v3 signers disagree');
    }

    const families = [...new Set(signers.flatMap((s) => s.expected.map((e) => e.family)))];
    const actual = contentDigests(file, families, block.start, eocd);
    for (const signer of signers) {
      for (const expected of signer.expected) {
        if (!actual.get(expected.family).equals(expected.digest)) {
          fail(`v${signer.scheme} content digest mismatch (${ALGORITHMS.get(expected.algorithm).name}): the APK was modified after signing`);
        }
      }
    }

    const manifest = parseBinaryManifest(readManifestEntry(file, eocd, block.start));
    const final = v3 || v2;
    return {
      ...manifest,
      signerCertSha256: [sha256Hex(final.certDer)],
      schemes: signers.map((s) => s.scheme),
    };
  } finally {
    file.close();
  }
}

/** Throw ApkVerifyError unless the verified APK is `expected.package` signed by `expected.certSha256`. */
function checkPinned(info, expected) {
  if (!expected || !expected.package || !/^[0-9a-f]{64}$/.test(String(expected.certSha256 || ''))) {
    fail('no signer pin for this APK');
  }
  if (info.package !== expected.package) fail(`APK is ${info.package}, expected ${expected.package}`);
  const certs = info.signerCertSha256 || [];
  if (certs.length !== 1 || certs[0] !== expected.certSha256) {
    fail(`${info.package} is signed by certificate ${certs.join(', ') || '(none)'}, not the pinned ${expected.certSha256}`);
  }
  return info;
}

module.exports = { ApkVerifyError, checkPinned, parseBinaryManifest, verifyApk };
