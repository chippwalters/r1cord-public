// Build a recording's static site, and deploy it to the publish folder.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ValueError } = require('../errors');
const { PHOTO_NAME, Policy, render, stripBrandHeader } = require('./markdown');
const { pageJs, renderPage, siteCss } = require('./page');
const { getTheme } = require('./themes');

const RENDERER_VERSION = 'r1cord-render/1';
const MANIFEST_NAME = '.r1cord-site.json';
const PAGE_KINDS = ['transcript', 'summary', 'outline', 'organized'];

const SHA256 = /^[0-9a-f]{64}$/;
const SITE_PATH = new RegExp(
  '^(?:(?:transcript|summary|outline|organized)\\.(?:html|md)'
  + '|assets/[a-z0-9-]+\\.[0-9a-f]{12}\\.[a-z0-9]+'
  + '|photos/photo-[A-Za-z0-9._-]+\\.jpg)$',
);

class PageSource {
  constructor(kind, label, markdown) {
    this.kind = kind;
    this.label = label;
    this.markdown = markdown;
  }
}

class SiteManifest {
  constructor(renderer, theme, pages, files) {
    this.renderer = renderer;
    this.theme = theme;
    this.pages = pages;
    this.files = files;
  }

  toJson() {
    const files = {};
    for (const key of Object.keys(this.files).sort()) files[key] = this.files[key];
    const data = {
      files,
      pages: this.pages.slice(),
      renderer: this.renderer,
      theme: this.theme,
    };
    return `${JSON.stringify(data, null, 2)}\n`;
  }

  static fromJson(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (exc) {
      throw new ValueError(`site manifest is not JSON: ${exc.message}`);
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new ValueError('site manifest is not an object');
    }
    const { renderer, theme, pages, files } = data;
    if (typeof renderer !== 'string' || typeof theme !== 'string') {
      throw new ValueError('site manifest: renderer and theme must be strings');
    }
    if (!Array.isArray(pages) || pages.some((kind) => !PAGE_KINDS.includes(kind)) || new Set(pages).size !== pages.length) {
      throw new ValueError(`site manifest: bad pages ${JSON.stringify(pages)}`);
    }
    if (files === null || typeof files !== 'object' || Array.isArray(files)) {
      throw new ValueError('site manifest: files must be an object');
    }
    for (const [rel, digest] of Object.entries(files)) {
      if (typeof rel !== 'string' || !SITE_PATH.test(rel)) {
        throw new ValueError(`site manifest: bad path ${JSON.stringify(rel)}`);
      }
      if (typeof digest !== 'string' || !SHA256.test(digest)) {
        throw new ValueError(`site manifest: bad sha256 for ${rel}`);
      }
    }
    return new SiteManifest(renderer, theme, pages.slice(), { ...files });
  }
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hashed(stem, ext, data) {
  return `assets/${stem}.${sha256(data).slice(0, 12)}.${ext}`;
}

function joinRel(folder, rel) {
  return path.join(folder, ...rel.split('/'));
}

function ordered(pages) {
  const byKind = new Map();
  for (const page of pages) {
    if (!PAGE_KINDS.includes(page.kind)) {
      throw new ValueError(`unknown page kind: ${typeof page.kind === 'string' ? `'${page.kind}'` : String(page.kind)}`);
    }
    if (byKind.has(page.kind)) throw new ValueError(`duplicate page: ${page.kind}`);
    byKind.set(page.kind, page);
  }
  if (byKind.size === 0) throw new ValueError('no pages to build');
  return PAGE_KINDS.filter((kind) => byKind.has(kind)).map((kind) => byKind.get(kind));
}

function availablePhotos(photosDir) {
  if (!photosDir) return new Map();
  let stat;
  try {
    stat = fs.statSync(photosDir);
  } catch (_error) {
    return new Map();
  }
  if (!stat.isDirectory()) return new Map();
  const found = new Map();
  for (const entry of fs.readdirSync(photosDir, { withFileTypes: true })) {
    if (PHOTO_NAME.test(entry.name) && entry.isFile()) found.set(entry.name, path.join(photosDir, entry.name));
  }
  return found;
}

function emptyDir(dest) {
  if (fs.existsSync(dest)) {
    const stat = fs.lstatSync(dest);
    if (!stat.isDirectory()) throw new ValueError(`site destination is not a folder: ${dest}`);
    const names = fs.readdirSync(dest);
    if (names.length > 0 && !fs.existsSync(path.join(dest, MANIFEST_NAME))) {
      throw new ValueError(`refusing to empty ${dest}: it is not empty and holds no ${MANIFEST_NAME}`);
    }
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.mkdirSync(dest, { recursive: true });
}

function buildSite(pages, { title, photosDir, theme, dest }) {
  const chosen = getTheme(theme);
  const orderedPages = ordered(pages);
  const photos = availablePhotos(photosDir);
  const sources = {};
  for (const page of orderedPages) sources[page.kind] = stripBrandHeader(page.markdown);
  const policy = new Policy({
    pages: orderedPages.flatMap((page) => [`${page.kind}.html`, `${page.kind}.md`]),
    photos: photos.keys(),
  });

  const themeBytes = Buffer.from(chosen.css, 'utf8');
  const chromeBytes = Buffer.from(siteCss(chosen), 'utf8');
  const script = chosen.layout === 'toc' ? Buffer.from(pageJs(), 'utf8') : null;
  const links = {
    siteCss: hashed('site', 'css', chromeBytes),
    themeCss: hashed('theme', 'css', themeBytes),
    pageJs: script ? hashed('page', 'js', script) : null,
  };
  const files = { [links.siteCss]: chromeBytes, [links.themeCss]: themeBytes };
  if (script) files[links.pageJs] = script;

  const shown = new Set();
  for (const page of orderedPages) {
    const rendered = render(sources[page.kind], policy);
    for (const name of rendered.photos) shown.add(name);
    const nav = orderedPages.map((item) => ({
      label: item.label,
      href: `${item.kind}.html`,
      current: item.kind === page.kind,
    }));
    const html = renderPage({
      theme: chosen,
      title,
      label: page.label,
      kind: page.kind,
      nav,
      rendered,
      assets: links,
    });
    files[`${page.kind}.html`] = Buffer.from(html, 'utf8');
    files[`${page.kind}.md`] = Buffer.from(sources[page.kind], 'utf8');
  }
  for (const name of Array.from(shown).sort()) {
    files[`photos/${name}`] = fs.readFileSync(photos.get(name));
  }

  emptyDir(dest);
  for (const rel of Object.keys(files).sort()) {
    const target = joinRel(dest, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, files[rel]);
  }
  const digestFiles = {};
  for (const rel of Object.keys(files).sort()) digestFiles[rel] = sha256(files[rel]);
  const manifest = new SiteManifest(
    RENDERER_VERSION,
    chosen.id,
    orderedPages.map((page) => page.kind),
    digestFiles,
  );
  fs.writeFileSync(path.join(dest, MANIFEST_NAME), Buffer.from(manifest.toJson(), 'utf8'));
  return manifest;
}

function deployKey(rel, kindRank) {
  if (rel.includes('/')) return [0, rel];
  const dot = rel.lastIndexOf('.');
  const kind = rel.slice(0, dot);
  const ext = rel.slice(dot + 1);
  if (ext === 'md') return [1, kindRank[kind]];
  return [kind === 'summary' ? 3 : 2, kindRank[kind]];
}

function deployOrder(manifest) {
  const kindRank = Object.fromEntries(PAGE_KINDS.map((kind, rank) => [kind, rank]));
  return Object.keys(manifest.files).sort((a, b) => {
    const ka = deployKey(a, kindRank);
    const kb = deployKey(b, kindRank);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    if (typeof ka[1] === 'string') {
      if (ka[1] < kb[1]) return -1;
      if (ka[1] > kb[1]) return 1;
      return 0;
    }
    return ka[1] - kb[1];
  });
}

function readManifest(folder) {
  try {
    return SiteManifest.fromJson(fs.readFileSync(path.join(folder, MANIFEST_NAME)).toString('utf8'));
  } catch (_error) {
    return null;
  }
}

function deploySite(src, dest) {
  const manifestBytes = fs.readFileSync(path.join(src, MANIFEST_NAME));
  const manifest = SiteManifest.fromJson(manifestBytes.toString('utf8'));
  const order = deployOrder(manifest);
  for (const rel of order) {
    if (sha256(fs.readFileSync(joinRel(src, rel))) !== manifest.files[rel]) {
      throw new ValueError(`${joinRel(src, rel)} does not match the site manifest`);
    }
  }

  const previous = readManifest(dest);
  fs.mkdirSync(dest, { recursive: true });
  const written = [];
  for (const rel of order) {
    const target = joinRel(dest, rel);
    if (previous && previous.files[rel] === manifest.files[rel] && fs.existsSync(target) && fs.statSync(target).isFile()) {
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, fs.readFileSync(joinRel(src, rel)));
    written.push(rel);
  }
  fs.writeFileSync(path.join(dest, MANIFEST_NAME), manifestBytes);
  written.push(MANIFEST_NAME);

  if (previous) {
    const parents = new Set();
    const stale = Object.keys(previous.files).filter((rel) => !Object.prototype.hasOwnProperty.call(manifest.files, rel)).sort();
    for (const rel of stale) {
      const target = joinRel(dest, rel);
      fs.rmSync(target, { force: true });
      const parent = path.dirname(target);
      if (parent !== dest) parents.add(parent);
    }
    for (const folder of Array.from(parents).sort()) {
      try {
        fs.rmdirSync(folder);
      } catch (_error) {
        // only succeeds when nothing else is left in it
      }
    }
  }
  return written;
}

module.exports = {
  RENDERER_VERSION,
  MANIFEST_NAME,
  PAGE_KINDS,
  PageSource,
  SiteManifest,
  buildSite,
  deploySite,
};
