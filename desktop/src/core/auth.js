// Bearer tokens (hashed) and HTTP Basic for the admin UI.
// Port of r1cord_server/auth.py.

'use strict';

const crypto = require('node:crypto');
const { URL } = require('node:url');
const { hashToken } = require('./store');
const { HttpError } = require('./http-error');
const { requestPath } = require('./log');

const PROXY_HEADERS = ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip'];
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1']);
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1']);

function header(request, name) {
  const headers = request.headers || {};
  const value = headers[name] ?? headers[String(name).toLowerCase()];
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? value[0] : String(value);
}

function hasHeader(request, name) {
  const headers = request.headers || {};
  const key = String(name).toLowerCase();
  return Object.prototype.hasOwnProperty.call(headers, key) || Object.prototype.hasOwnProperty.call(headers, name);
}

function deny(message) {
  // Logged once, with the reason, by the app's error handler.
  return new HttpError(401, 'unauthorized', message);
}

function forbidden(message) {
  return new HttpError(403, 'forbidden', message);
}

function challenge() {
  return new HttpError(
    401,
    'unauthorized',
    'invalid admin credentials',
    {},
    { 'WWW-Authenticate': 'Basic realm="r1cord-admin"' },
  );
}

// "127.0.0.1:8765" -> "127.0.0.1", "[::1]:8765" -> "::1", "localhost" -> "localhost".
function hostName(host) {
  host = String(host || '').trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end >= 0 ? host.slice(1, end) : host;
  }
  return (host.match(/:/g) || []).length === 1 ? host.split(':')[0] : host;
}

function peerHost(request) {
  const raw =
    (request.socket && request.socket.remoteAddress) ||
    request.ip ||
    (request.raw && request.raw.socket && request.raw.socket.remoteAddress) ||
    '';
  const value = String(raw);
  if (value.startsWith('::ffff:')) return value.slice(7);
  return value;
}

function originNetloc(origin) {
  try {
    const url = new URL(origin);
    return url.host.toLowerCase();
  } catch (_error) {
    return '';
  }
}

function checkBrowserRequest(request) {
  // Refuse what a web page on another site could make this PC's browser do to the admin.
  const host = header(request, 'host') || '';
  if (isLocalDirect(request) && !LOOPBACK_NAMES.has(hostName(host))) {
    throw forbidden('the admin answers only as 127.0.0.1 or localhost on this PC');
  }
  if (!UNSAFE_METHODS.has(String(request.method || '').toUpperCase())) return;
  const origin = header(request, 'origin');
  if (origin !== undefined && (origin === 'null' || originNetloc(origin) !== host.trim().toLowerCase())) {
    throw forbidden('cross-site request refused');
  }
  if (header(request, 'sec-fetch-site') === 'cross-site') {
    throw forbidden('cross-site request refused');
  }
}

function isLocalDirect(request) {
  // True for a request that arrived on the loopback listener without passing through a proxy.
  const client = peerHost(request);
  if (!LOOPBACK_PEERS.has(client)) return false;
  return !PROXY_HEADERS.some((name) => hasHeader(request, name));
}

function asBuf(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
}

function compareDigest(a, b) {
  const left = asBuf(a);
  const right = asBuf(b);
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function requireToken(request) {
  const rawHeader = header(request, 'authorization');
  if (!rawHeader) throw deny('missing bearer token');
  const parts = rawHeader.split(/\s+/, 2);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer' || !parts[1].trim()) {
    throw deny('missing bearer token');
  }
  const raw = parts[1].trim();
  const store = request.server.state.store;
  if (!store.tokenValid(raw)) {
    // Touch the digest so a missing token still does a compare.
    compareDigest(hashToken(raw), '0'.repeat(64));
    throw deny('invalid bearer token');
  }
  return raw;
}

function parseBasic(rawHeader) {
  if (!rawHeader) return null;
  const parts = rawHeader.split(/\s+/, 2);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'basic' || !parts[1]) return null;
  let decoded;
  try {
    decoded = Buffer.from(parts[1], 'base64').toString('utf8');
  } catch (_error) {
    return null;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return null;
  return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
}

const REMOTE_ADMIN_OFF = 'the admin is only available on this PC';

function isAdminApi(request) {
  const pathname = requestPath(request);
  return pathname === '/admin/api' || pathname.startsWith('/admin/api/');
}

function remoteAdminOffHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Admin unavailable — R1CORD Server</title>
  <link rel="stylesheet" href="/static/admin.css">
  <link rel="icon" type="image/png" href="/static/favicon-64.png">
</head>
<body>
  <main>
    <h1>Admin is only available on this PC</h1>
    <p>Remote admin through the tunnel is off. Open Settings on this PC to enable it (password required).</p>
  </main>
</body>
</html>`;
}

function denyRemoteAdmin(request) {
  const error = forbidden(REMOTE_ADMIN_OFF);
  if (!isAdminApi(request)) error.html = remoteAdminOffHtml();
  return error;
}

function requireAdmin(request) {
  checkBrowserRequest(request);
  if (isLocalDirect(request)) return 'admin';
  if (!request.server.state.config.admin_remote) throw denyRemoteAdmin(request);
  const credentials = parseBasic(header(request, 'authorization'));
  if (credentials === null) throw challenge();
  const userOk = compareDigest(Buffer.from(credentials.username, 'utf8'), Buffer.from('admin'));
  const expected = Buffer.from(String(request.server.state.config.admin_password), 'utf8');
  const presented = Buffer.from(credentials.password, 'utf8');
  let passOk = false;
  if (presented.length !== expected.length) {
    compareDigest(presented.subarray(0, 1).length ? presented.subarray(0, 1) : Buffer.from('x'), Buffer.from('y'));
    passOk = false;
  } else {
    passOk = compareDigest(presented, expected);
  }
  if (!(userOk && passOk)) throw challenge();
  return credentials.username;
}

async function requireTokenHook(request) {
  requireToken(request);
}

async function requireAdminHook(request) {
  requireAdmin(request);
}

module.exports = {
  PROXY_HEADERS,
  LOOPBACK_NAMES,
  hostName,
  peerHost,
  checkBrowserRequest,
  isLocalDirect,
  requireToken,
  requireAdmin,
  requireTokenHook,
  requireAdminHook,
};
