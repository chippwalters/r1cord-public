// Port of r1cord_server/pipeline/publish.py: a recording's pages, built from its outbox Markdown
// into `outbox/<rid>/site/`, deployed to its publish folder, and the one-off republish of every
// published recording.
//
// The site is the unit: every page whose source exists is built together, in the configured theme,
// whether or not the recording is published. The admin serves that same build as the local view.
//
// Python serializes every build and deploy with SITE_LOCK (worker, /admin/site on-demand build,
// republish thread). Here build() and deploy() are synchronous and the core has one thread, so two
// of them can never interleave; callers must keep a build and its deploy in one synchronous step.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const render = require('../render');
const naming = require('../naming');
const { PAGE_KINDS, PAGE_LABELS } = require('../config');
const { ValueError } = require('../errors');
const { pathString } = require('../paths');
const { errorText, isDir, isFile, readText } = require('./compat');
const { transcriptMarkdown } = require('./writers');

const SITE_DIR = 'site';
// The old MD DOCS publish step staged copies of the Markdown and photos here.
const LEGACY_STAGE_DIR = 'publish';

const SILENT_LOGGER = Object.freeze({ info() {}, warn() {}, error() {} });

// Building or deploying a recording's site failed. The outbox Markdown is left untouched.
class PublishError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PublishError';
  }
}

// Python's OSError: a Node system error (ENOENT, EACCES, ...).
function isOsError(error) {
  return Boolean(error) && typeof error.code === 'string' && /^E[A-Z0-9]+$/.test(error.code);
}

function isPermissionError(error) {
  return Boolean(error) && ['EACCES', 'EPERM', 'EBUSY'].includes(error.code);
}

function removeTree(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (_error) {
    // shutil.rmtree(ignore_errors=True)
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function hex8() {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Kinds that have a page source in the outbox, in page order. The transcript page can also be made
 * from transcript.txt alone (recordings from before transcript.md).
 * @param {string} outbox
 * @returns {string[]}
 */
function sourceKinds(outbox) {
  return PAGE_KINDS.filter(
    (kind) => isFile(path.join(outbox, `${kind}.md`)) || (kind === 'transcript' && isFile(path.join(outbox, 'transcript.txt'))),
  );
}

/**
 * `transcript.md` and every `<kind>.md` in the outbox, in page order.
 * @param {string} outbox
 * @param {string} title
 * @returns {render.PageSource[]}
 */
function pageSources(outbox, title) {
  return sourceKinds(outbox).map((kind) => {
    const md = path.join(outbox, `${kind}.md`);
    const text = isFile(md) ? readText(md) : transcriptMarkdown(title, '', readText(path.join(outbox, 'transcript.txt')));
    return new render.PageSource(kind, PAGE_LABELS[kind], text);
  });
}

/**
 * (Re)build `outbox/site/` from the outbox sources and photos.
 * @param {string} outbox
 * @param {{title: string, theme: string}} options
 * @returns {render.SiteManifest}
 */
function build(outbox, { title, theme }) {
  const pages = pageSources(outbox, title);
  if (!pages.length) throw new PublishError('nothing to publish (no transcript or AI review yet)');
  const photos = path.join(outbox, 'photos');
  const manifest = buildInto(path.join(outbox, SITE_DIR), pages, { title, photosDir: isDir(photos) ? photos : null, theme });
  removeTree(path.join(outbox, LEGACY_STAGE_DIR));
  return manifest;
}

/**
 * Build into a temporary sibling, check every file the manifest names is there, then swap it in: a
 * site that is being served or deployed is never half-written.
 * @param {string} dest
 * @param {render.PageSource[]} pages
 * @param {{title: string, photosDir: string|null, theme: string}} options
 * @returns {render.SiteManifest}
 */
function buildInto(dest, pages, { title, photosDir, theme }) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}-new-${hex8()}`);
  try {
    let manifest;
    try {
      manifest = render.buildSite(pages, { title, photosDir, theme, dest: tmp });
    } catch (error) {
      if (isOsError(error) || error instanceof ValueError) throw new PublishError(`site build failed: ${errorText(error)}`);
      throw error;
    }
    const missing = Object.keys(manifest.files).filter((rel) => !isFile(path.join(tmp, ...rel.split('/'))));
    if (missing.length) throw new PublishError(`site build is missing ${missing.sort().slice(0, 3).join(', ')}`);
    swap(tmp, dest);
    return manifest;
  } finally {
    removeTree(tmp);
  }
}

function swap(fresh, dest) {
  const old = path.join(path.dirname(dest), `.${path.basename(dest)}-old-${hex8()}`);
  // A file being served right now keeps its folder from being renamed on Windows; that lasts ms.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      if (fs.existsSync(dest)) fs.renameSync(dest, old);
      break;
    } catch (error) {
      if (!isPermissionError(error) || attempt === 4) throw error;
      sleepSync(100);
    }
  }
  try {
    fs.renameSync(fresh, dest);
  } catch (error) {
    if (fs.existsSync(old)) fs.renameSync(old, dest);
    throw error;
  }
  removeTree(old);
}

/**
 * Copy a built site into its publish folder; logs every file written.
 * @param {string} site
 * @param {string} publishFolder
 * @param {(line: string) => void} log
 * @returns {string[]} the files written, in deploy order
 */
function deploy(site, publishFolder, log) {
  const folder = pathString(publishFolder);
  let written;
  try {
    fs.mkdirSync(folder, { recursive: true });
    written = render.deploySite(site, folder);
  } catch (error) {
    throw new PublishError(`deploy to ${folder} failed: ${errorText(error)}`);
  }
  for (const rel of written) log(`publish: wrote ${rel}`);
  return written;
}

// --- Republish every published recording -----------------------------------------------------

/**
 * What an MD DOCS export left beside each page the new site rewrites: `<kind>.css` and the
 * `<kind>_images/` folder Save As copied linked files into. Names as on disk; folders end in "/".
 * @param {string} folder
 * @param {string[]} kinds
 * @returns {string[]}
 */
function legacyArtifacts(folder, kinds) {
  let names;
  try {
    names = new Map(fs.readdirSync(folder).map((name) => [name.toLowerCase(), name]));
  } catch (_error) {
    return [];
  }
  const found = [];
  for (const kind of kinds) {
    const css = names.get(`${kind}.css`);
    if (css !== undefined && isFile(path.join(folder, css))) found.push(css);
    const images = names.get(`${kind}_images`);
    if (images !== undefined && isDir(path.join(folder, images))) found.push(`${images}/`);
  }
  return found;
}

/**
 * @typedef {{recordingId: string, title: string, folder: string, pages: string[], legacy: string[],
 *   skip: string}} RepublishItem  skip: why the recording is left alone; "" = it is republished
 * @typedef {{recordingId: string, title: string, folder: string, pages: string[], written: number,
 *   removed: string[], skip: string, error: string}} RepublishResult
 */

/**
 * Every recording whose latest publish folder exists: the pages its outbox sources would write
 * there and the MD DOCS leftovers that would go. Reads only; never creates a folder.
 * @param {import('../store').JobStore} store
 * @param {object} config
 * @returns {RepublishItem[]}
 */
function planRepublish(store, config) {
  const outboxRoot = path.join(config.datastore, 'outbox');
  const items = [];
  for (const [job] of store.latestJobs(1_000_000)) {
    const folder = job.publishFolder;
    if (!folder || !isDir(folder)) continue;
    const title = job.title || job.recordingId;
    const item = (pages, legacy, skip) => ({ recordingId: job.recordingId, title, folder, pages, legacy, skip });
    if (!naming.inPublishRoot(config, folder)) {
      items.push(item([], [], 'outside the publish folder'));
      continue;
    }
    const kinds = sourceKinds(path.join(outboxRoot, job.recordingId));
    if (!kinds.length) {
      items.push(item([], [], 'no transcript or AI review on this PC'));
      continue;
    }
    const skip = store.activeJobFor(job.recordingId) !== null ? 'a job is running for it' : '';
    items.push(item(kinds, legacyArtifacts(folder, kinds), skip));
  }
  return items;
}

/**
 * Rebuild one recording's site, deploy it, then remove only the legacy files it replaced.
 * @param {import('../store').JobStore} store
 * @param {object} config
 * @param {RepublishItem} item
 * @param {(line: string) => void} log
 * @returns {RepublishResult}
 */
function republishOne(store, config, item, log) {
  const result = {
    recordingId: item.recordingId,
    title: item.title,
    folder: item.folder,
    pages: [...item.pages],
    written: 0,
    removed: [],
    skip: item.skip,
    error: '',
  };
  if (item.skip) return result;
  const outbox = path.join(config.datastore, 'outbox', item.recordingId);
  try {
    if (store.activeJobFor(item.recordingId) !== null) {
      result.skip = 'a job is running for it';
      return result;
    }
    const manifest = build(outbox, { title: item.title, theme: config.theme });
    result.pages = [...manifest.pages];
    result.written = deploy(path.join(outbox, SITE_DIR), item.folder, log).length;
    const managed = new Set(Object.keys(manifest.files).map((rel) => rel.toLowerCase()));
    for (const name of legacyArtifacts(item.folder, manifest.pages)) {
      const bare = name.replace(/\/+$/, '');
      if (managed.has(bare.toLowerCase())) continue;
      const target = path.join(item.folder, bare);
      if (name.endsWith('/')) fs.rmSync(target, { recursive: true });
      else fs.unlinkSync(target);
      result.removed.push(name);
      log(`republish: removed ${name}`);
    }
  } catch (error) {
    if (!(error instanceof PublishError) && !isOsError(error)) throw error;
    result.error = errorText(error);
  }
  return result;
}

// One republish of every published recording at a time, in the background; keeps the last results.
// startedAt / finishedAt are epoch seconds, as Python's time.time().
class Republisher {
  /** @param {{logger?: {info: Function, warn: Function, error?: Function}}} [options] */
  constructor({ logger = SILENT_LOGGER } = {}) {
    this.logger = logger;
    this.theme = '';
    this.startedAt = null;
    this.finishedAt = null;
    /** @type {RepublishResult[]} */
    this.results = [];
    this.error = '';
    this._running = null;
  }

  get running() {
    return this._running !== null;
  }

  /**
   * Start a republish; false when one is already running.
   * @returns {boolean}
   */
  start(store, config) {
    if (this.running) return false;
    this.theme = config.theme;
    this.startedAt = Date.now() / 1000;
    this.finishedAt = null;
    this.results = [];
    this.error = '';
    this._running = this._run(store, config).finally(() => {
      this._running = null;
    });
    return true;
  }

  /** Resolves when the current run (if any) has finished. */
  wait() {
    return this._running || Promise.resolve();
  }

  async _run(store, config) {
    try {
      // Each recording is one synchronous build + deploy; yield between them so HTTP stays served.
      await new Promise((resolve) => setImmediate(resolve));
      for (const item of planRepublish(store, config)) {
        const lines = [];
        const result = republishOne(store, config, item, (line) => lines.push(line));
        this.results.push(result);
        if (!result.skip) {
          const summary = result.error
            ? `republish: failed: ${result.error}`
            : `republish: ${config.theme}, wrote ${result.written} files${result.removed.length ? `, removed ${result.removed.join(', ')}` : ''}`;
          this.logger.info(`${item.recordingId} ${summary}`);
          const latest = store.latestFor(item.recordingId);
          if (latest !== null) for (const line of [...lines, summary]) store.appendLog(latest.jobId, line);
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    } catch (error) {
      this.logger.error('republish crashed', error);
      this.error = errorText(error);
    } finally {
      this.finishedAt = Date.now() / 1000;
    }
  }
}

module.exports = {
  SITE_DIR,
  PublishError,
  Republisher,
  build,
  buildInto,
  deploy,
  legacyArtifacts,
  pageSources,
  planRepublish,
  republishOne,
  sourceKinds,
};
