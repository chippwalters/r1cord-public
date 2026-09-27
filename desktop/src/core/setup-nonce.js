// One-use setup nonces that prove which tailnet peer is the USB-attached R1. USB setup creates a
// nonce, asks the app (over adb) to GET /v1/setup/nonce/<nonce> through its configured server
// route, and then reads back the peer address the API saw. State lives in state.setupNonces
// (Map nonce -> { createdAt, seenFrom }), shared by the admin and API listeners.

'use strict';

const crypto = require('node:crypto');

const NONCE_TTL_MS = 5 * 60 * 1000;
const NONCE_RE = /^[0-9a-f]{32}$/;

function nonces(state) {
  if (!(state.setupNonces instanceof Map)) state.setupNonces = new Map();
  return state.setupNonces;
}

function expired(entry, now) {
  return now - entry.createdAt >= NONCE_TTL_MS;
}

function prune(map, now) {
  for (const [nonce, entry] of map) {
    if (expired(entry, now)) map.delete(nonce);
  }
}

/** A fresh 32-lowercase-hex nonce, pending for five minutes. */
function createNonce(state, now = Date.now()) {
  const map = nonces(state);
  prune(map, now);
  const nonce = crypto.randomBytes(16).toString('hex');
  map.set(nonce, { createdAt: now, seenFrom: null });
  return nonce;
}

/** Record who presented a pending nonce. False (nothing recorded) when it is unknown, expired or already seen. */
function markSeen(state, nonce, seenFrom, now = Date.now()) {
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return false;
  const map = nonces(state);
  const entry = map.get(nonce);
  if (!entry) return false;
  if (expired(entry, now)) {
    map.delete(nonce);
    return false;
  }
  if (entry.seenFrom !== null) return false;
  entry.seenFrom = seenFrom;
  return true;
}

/** The recorded seenFrom of a seen nonce, removing it (one use); null when not (yet) seen or expired. */
function consumeSeen(state, nonce, now = Date.now()) {
  const map = nonces(state);
  const entry = map.get(nonce);
  if (!entry) return null;
  if (expired(entry, now)) {
    map.delete(nonce);
    return null;
  }
  if (entry.seenFrom === null) return null;
  map.delete(nonce);
  return entry.seenFrom;
}

module.exports = { NONCE_TTL_MS, NONCE_RE, createNonce, markSeen, consumeSeen };
