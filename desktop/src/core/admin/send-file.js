// File responses as Starlette's FileResponse sends them: guessed media type (text/* with
// charset=utf-8), content-length, last-modified, etag, accept-ranges, an optional attachment
// filename, and byte ranges (206, multipart/byteranges, 416), so the dashboard's audio player
// can seek.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pyFloatRepr } = require('../pipeline/compat');
const { pyQuote } = require('./format');

// mimetypes.guess_type for the files the admin serves.
const MEDIA_TYPES = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.xml': 'text/xml',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.ico': 'image/vnd.microsoft.icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function guessType(name) {
  return MEDIA_TYPES[path.extname(String(name)).toLowerCase()] || 'application/octet-stream';
}

function withCharset(mediaType) {
  return mediaType.startsWith('text/') && !mediaType.toLowerCase().includes('charset=')
    ? `${mediaType}; charset=utf-8`
    : mediaType;
}

class MalformedRange extends Error {}
class RangeNotSatisfiable extends Error {}

function parseInteger(text) {
  if (!/^[+-]?\d+(_\d+)*$/.test(text)) throw new MalformedRange();
  return Number(text.replace(/_/g, ''));
}

// FileResponse._parse_range_header: [] means "send it whole".
function parseRange(header, size) {
  const eq = header.indexOf('=');
  if (eq < 0) throw new MalformedRange('Malformed range header.');
  if (header.slice(0, eq).trim().toLowerCase() !== 'bytes') throw new MalformedRange('Only support bytes range');
  const spec = header.slice(eq + 1);
  if (spec.split(',').length > 100) return [];
  const ranges = [];
  for (let part of spec.split(',')) {
    part = part.trim();
    if (!part || part === '-' || !part.includes('-')) continue;
    const dash = part.indexOf('-');
    const startText = part.slice(0, dash).trim();
    const endText = part.slice(dash + 1).trim();
    try {
      const start = startText ? parseInteger(startText) : Math.max(size - parseInteger(endText), 0);
      const end = startText && endText && parseInteger(endText) < size ? parseInteger(endText) + 1 : size;
      ranges.push([start, end]);
    } catch (_error) {
      // a non-numeric range is ignored
    }
  }
  if (!ranges.length) throw new MalformedRange('Range header: range must be requested');
  if (ranges.some(([start]) => !(start >= 0 && start < size))) throw new RangeNotSatisfiable();
  if (ranges.some(([start, end]) => start >= end)) throw new MalformedRange('Range header: start must be less than end');
  if (ranges.length === 1) return ranges;
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [ranges[0]];
  for (const [start, end] of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function plain(reply, status, text, headers = {}) {
  for (const [name, value] of Object.entries(headers)) reply.header(name, value);
  return reply.code(status).type('text/plain; charset=utf-8').send(text);
}

/**
 * Send `file` (an existing regular file).
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 * @param {string} file
 * @param {{mediaType?: string, filename?: string, headers?: Object<string, string>}} [options]
 */
function sendFile(request, reply, file, { mediaType = null, filename = null, headers = {} } = {}) {
  const stat = fs.statSync(file);
  const contentType = withCharset(mediaType || guessType(filename || file));
  const lastModified = new Date(stat.mtimeMs).toUTCString();
  const etagBase = `${pyFloatRepr(stat.mtimeMs / 1000)}-${stat.size}`;
  const etag = `"${crypto.createHash('md5').update(etagBase).digest('hex')}"`;
  const rangeHeader = request.headers.range;
  const ifRange = request.headers['if-range'];
  let ranges = [];
  if (rangeHeader !== undefined && (ifRange === undefined || ifRange === lastModified || ifRange === etag)) {
    try {
      ranges = parseRange(String(rangeHeader), stat.size);
    } catch (error) {
      // Starlette answers these with a plain response of their own, without the file's headers.
      if (error instanceof RangeNotSatisfiable) return plain(reply, 416, '', { 'content-range': `bytes */${stat.size}` });
      if (error instanceof MalformedRange) return plain(reply, 400, error.message || 'Malformed range header.');
      throw error;
    }
  }
  for (const [name, value] of Object.entries(headers)) reply.header(name, value);
  reply.header('accept-ranges', 'bytes');
  if (filename !== null) {
    const quoted = pyQuote(filename);
    reply.header(
      'content-disposition',
      quoted !== filename ? `attachment; filename*=utf-8''${quoted}` : `attachment; filename="${filename}"`,
    );
  }
  reply.header('last-modified', lastModified);
  reply.header('etag', etag);
  if (ranges.length === 0) {
    reply.header('content-length', String(stat.size));
    return reply.code(200).type(contentType).send(fs.createReadStream(file));
  }
  if (ranges.length === 1) {
    const [start, end] = ranges[0];
    reply.header('content-range', `bytes ${start}-${end - 1}/${stat.size}`);
    reply.header('content-length', String(end - start));
    return reply.code(206).type(contentType).send(fs.createReadStream(file, { start, end: end - 1 }));
  }
  const boundary = crypto.randomBytes(13).toString('hex');
  const parts = [];
  const fd = fs.openSync(file, 'r');
  try {
    for (const [start, end] of ranges) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Type: ${contentType}\r\nContent-Range: bytes ${start}-${end - 1}/${stat.size}\r\n\r\n`,
          'latin1',
        ),
      );
      const chunk = Buffer.alloc(end - start);
      fs.readSync(fd, chunk, 0, chunk.length, start);
      parts.push(chunk, Buffer.from('\r\n'));
    }
  } finally {
    fs.closeSync(fd);
  }
  parts.push(Buffer.from(`--${boundary}--`, 'latin1'));
  const body = Buffer.concat(parts);
  reply.header('content-length', String(body.length));
  return reply.code(206).type(`multipart/byteranges; boundary=${boundary}`).send(body);
}

module.exports = { sendFile };
