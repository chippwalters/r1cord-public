// Built-in trust anchors for the R1 APKs and the signed update manifest. The desktop never trusts
// a certificate or version from a download alone: every APK it installs must be signed by the
// certificate pinned here for its package, and the release manifest must carry an Ed25519
// signature by the publication key below. Changing a pin is a code change and a desktop release.

'use strict';

// SHA-256 of the DER signing certificate, lowercase hex, per Android package.
const SIGNER_PINS = Object.freeze({
  // R1CORD recorder, CHIPPWALTERS release key.
  'com.chippwalters.r1cord': '4e92be8e9853f7473f5fe9ed85fde56e2a8dac1280f279b2800861cd5265b7dc',
  // Device-controls helper, AOSP android13 platform test key (the R1's framework signer).
  'com.chippwalters.r1cord.controls': 'c8a2e9bccf597c2fb6dc66bee293fc13f2fc47ec77bc6b2b0d52c11f51192ab8',
  // Tailscale, official pkgs.tailscale.com universal APK.
  'com.tailscale.ipn': '5cdb295551bfe1a087fed6acda07141c6c929fa7c29bd273a7092813acc434bf',
});

// The manifest's android entry names and the package each one must be.
const APK_ENTRIES = Object.freeze({
  r1cord: 'com.chippwalters.r1cord',
  controls: 'com.chippwalters.r1cord.controls',
  tailscale: 'com.tailscale.ipn',
});

// Ed25519 public key of the manifest publication key, SubjectPublicKeyInfo DER, base64.
const MANIFEST_PUBLIC_KEY_SPKI_B64 = 'MCowBQYDK2VwAyEAkLkT3Dc6l0cr24zgtoZPXOkk1JFBsULwJJTMZCQYrV0=';

/** `{package, certSha256}` for a manifest entry name ('r1cord' | 'controls' | 'tailscale'), else null. */
function pinFor(entryName) {
  if (!Object.prototype.hasOwnProperty.call(APK_ENTRIES, entryName)) return null;
  const pkg = APK_ENTRIES[entryName];
  return { package: pkg, certSha256: SIGNER_PINS[pkg] };
}

module.exports = { APK_ENTRIES, MANIFEST_PUBLIC_KEY_SPKI_B64, SIGNER_PINS, pinFor };
