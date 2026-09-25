// In-flight ggml download for the System page. ensureModel itself is cancel-safe (the .part file
// is kept and resumed); this module tracks one active abort controller so the page can Cancel.

'use strict';

const models = require('./models');

function createModelDownload({ ensureModel = models.ensureModel } = {}) {
  let current = null;

  function snapshot(config) {
    let spec;
    try {
      spec = models.resolveModel(config.asr_model, config.asr_quant || models.DEFAULT_QUANT);
    } catch (error) {
      return {
        error: error.message,
        state: 'missing',
        path: '',
        file: '',
        size: 0,
        received: 0,
        percent: 0,
        active: false,
      };
    }
    const dir = models.modelsDir(config.datastore);
    const status = models.modelStatus(dir, spec);
    const active = Boolean(current && current.file === spec.file);
    return { spec, dir, ...status, active, error: '' };
  }

  function start(config, { log = () => {}, fetch, onProgress } = {}) {
    const snap = snapshot(config);
    if (snap.error) return Promise.reject(new Error(snap.error));
    if (snap.state === 'present') return Promise.resolve(snap.path);
    if (current && current.file === snap.spec.file) return current.promise;
    if (current) current.controller.abort();
    const controller = new AbortController();
    const promise = ensureModel(snap.spec, {
      dir: snap.dir,
      signal: controller.signal,
      fetch,
      log,
      onProgress,
    }).finally(() => {
      if (current && current.promise === promise) current = null;
    });
    current = { file: snap.spec.file, controller, promise };
    return promise;
  }

  function cancel() {
    if (current) current.controller.abort();
  }

  return {
    snapshot,
    start,
    cancel,
    get active() {
      return current !== null;
    },
  };
}

module.exports = { createModelDownload };
