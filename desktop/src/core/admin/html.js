// Auto-escaping `html` tagged template for the admin pages: what Jinja2's autoescape (markupsafe)
// did for r1cord_server/templates. Interpolated values are escaped exactly as markupsafe.escape
// does (& < > " '); a SafeString (from html`` or raw()) goes in as it is; arrays are joined.
// Values print the way Jinja prints them: undefined (Jinja's Undefined) is empty, null is "None",
// booleans are "True"/"False", floats use Python's repr. Conditionals therefore pick '' themselves.

'use strict';

const { pyFloatRepr } = require('../pipeline/compat');

class SafeString {
  constructor(value) {
    this.value = String(value);
  }

  toString() {
    return this.value;
  }

  __html__() {
    return this.value;
  }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;

// str() of a value as a Jinja expression prints it.
function text(value) {
  if (value === undefined) return '';
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : pyFloatRepr(value);
  return String(value);
}

/** markupsafe.escape: markup passes through, anything else is printed and escaped. */
function escape(value) {
  if (value instanceof SafeString) return value;
  if (Array.isArray(value)) return new SafeString(value.map((item) => escape(item).value).join(''));
  if (value !== null && typeof value === 'object' && typeof value.__html__ === 'function') {
    return new SafeString(value.__html__());
  }
  return new SafeString(text(value).replace(ESCAPE_RE, (ch) => ESCAPES[ch]));
}

/** Trusted markup, inserted without escaping. */
function raw(value) {
  return new SafeString(value);
}

/** Tagged template: the literal parts are trusted, every `${value}` is escaped. */
function html(strings, ...values) {
  let out = strings[0];
  for (let index = 0; index < values.length; index += 1) {
    out += escape(values[index]).value + strings[index + 1];
  }
  return new SafeString(out);
}

module.exports = { escape, html, raw };
