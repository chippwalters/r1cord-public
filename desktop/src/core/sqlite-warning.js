// Swallow the node:sqlite ExperimentalWarning. Must load before `require('node:sqlite')`.
'use strict';

const original = process.emitWarning;
if (typeof original === 'function' && !original.__r1cordSqliteFilter) {
  function filtered(warning, ...args) {
    const text = typeof warning === 'string' ? warning : warning && warning.message;
    const name = typeof warning === 'object' && warning ? warning.name : '';
    const type = typeof args[0] === 'string' ? args[0] : name;
    if ((type === 'ExperimentalWarning' || name === 'ExperimentalWarning') && /SQLite/i.test(String(text || ''))) {
      return;
    }
    return original.call(process, warning, ...args);
  }
  filtered.__r1cordSqliteFilter = true;
  process.emitWarning = filtered;
}
