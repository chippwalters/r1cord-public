// HTTP error the Fastify error handler turns into {"error","message"} JSON.
'use strict';

class HttpError extends Error {
  constructor(statusCode, error, message, extra = {}, headers = null) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.error = error;
    this.message = message;
    this.extra = extra && typeof extra === 'object' ? extra : {};
    this.headers = headers;
  }

  body() {
    return { error: this.error, message: this.message, ...this.extra };
  }
}

module.exports = { HttpError };
