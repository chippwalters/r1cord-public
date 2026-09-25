// File logger matching Python's r1cord_server FileHandler:
//   Formatter("%(asctime)s %(levelname)s %(message)s")
//   asctime = local "YYYY-MM-DD HH:MM:SS,mmm"
// Tests read <datastore>/logs/server.log with that line shape.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

// Python logging asctime: time.localtime + ",%03d" msecs.
function formatAsctime(date = new Date()) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())},` +
    `${pad(date.getMilliseconds(), 3)}`
  );
}

function requestPath(request) {
  const url = (request && (request.url || (request.raw && request.raw.url))) || '';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

function makeLogger(emit) {
  const write = (level, message, error) => {
    let text = String(message);
    if (error && error.stack) text += `\n${error.stack}`;
    emit(level, text);
  };
  return {
    info(message) {
      write('INFO', message);
    },
    warning(message, error) {
      write('WARNING', message, error);
    },
    warn(message, error) {
      write('WARNING', message, error);
    },
    error(message, err) {
      write('ERROR', message, err);
    },
    log(level, message, error) {
      const name = String(level).toUpperCase() === 'WARNING' || Number(level) >= 30 ? 'WARNING' : 'INFO';
      write(name, message, error);
    },
  };
}

function createLogger({ logFile = null, sink = null } = {}) {
  if (logFile) fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const emit = (level, text) => {
    const line = `${formatAsctime()} ${level} ${text}`;
    if (typeof sink === 'function') sink(line);
    if (logFile) fs.appendFileSync(logFile, `${line}${os.EOL}`, 'utf8');
  };
  const root = makeLogger(emit);
  return {
    ...root,
    logFile,
    getLogger(_name) {
      return makeLogger(emit);
    },
  };
}

function setupFileLogger(config) {
  const logFile = path.join(String(config.datastore), 'logs', 'server.log');
  return createLogger({ logFile });
}

function logHandled(logger, request, statusCode, code, detail = '') {
  const level = statusCode >= 500 ? 'warning' : 'info';
  const extra = detail ? ` | ${detail}` : '';
  logger[level](`${request.method} ${requestPath(request)} -> ${statusCode} ${code}${extra}`);
}

module.exports = {
  formatAsctime,
  requestPath,
  createLogger,
  setupFileLogger,
  logHandled,
};
