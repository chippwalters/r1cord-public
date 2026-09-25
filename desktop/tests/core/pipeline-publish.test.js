// Port of tests/test_publish.py (one Vitest case per pytest function), plus the republish behaviour
// of test_admin.py's republish tests at the module level (the HTTP part belongs to the admin port).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const render = require('../../src/core/render');
const publish = require('../../src/core/pipeline/publish');
const { defaultConfig, withUpdates } = require('../../src/core/config');
const { JobStore } = require('../../src/core/store');
const { writeText } = require('../../src/core/pipeline/compat');

const { PublishError } = publish;

const cleanup = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (cleanup.length) cleanup.pop()();
});

function tmpPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-publish-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeOutbox(tmp) {
  const outbox = path.join(tmp, 'outbox', 'rec-1');
  fs.mkdirSync(path.join(outbox, 'photos'), { recursive: true });
  writeText(path.join(outbox, 'transcript.md'), '[brand-header]\n# Site visit\n\nhello\n');
  writeText(path.join(outbox, 'summary.md'), '# Site visit\n\nbody\n\n![Gate](photos/photo-a.jpg)\n');
  writeText(path.join(outbox, 'summary.job-old.md'), '# an archived rewrite\n');
  fs.writeFileSync(path.join(outbox, 'photos', 'photo-a.jpg'), 'jpeg-a');
  return outbox;
}

function leftovers(outbox) {
  return fs.readdirSync(outbox).filter((name) => name.startsWith('.site'));
}

function tree(folder) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(folder, full).split(path.sep).join('/')] = fs.readFileSync(full).toString('base64');
    }
  };
  walk(folder);
  return out;
}

describe('publish', () => {
  it('the site holds every source page in page order with its photos', () => {
    const outbox = makeOutbox(tmpPath());
    writeText(path.join(outbox, 'outline.md'), '# Site visit\n\n- point\n');

    const manifest = publish.build(outbox, { title: 'Site visit', theme: 'toolmaker-noir' });

    const site = path.join(outbox, publish.SITE_DIR);
    expect(manifest.pages).toEqual(['transcript', 'summary', 'outline']);
    for (const kind of manifest.pages) {
      expect(fs.existsSync(path.join(site, `${kind}.html`)) && fs.existsSync(path.join(site, `${kind}.md`))).toBe(true);
    }
    expect(fs.readFileSync(path.join(site, 'photos', 'photo-a.jpg'), 'utf8')).toBe('jpeg-a');
    expect(fs.existsSync(path.join(site, 'organized.html'))).toBe(false); // no source, no page
    const sources = fs.readdirSync(site).filter((name) => name.endsWith('.md')).map((name) => fs.readFileSync(path.join(site, name), 'utf8'));
    expect(sources.join('')).not.toContain('archived rewrite');
    expect(leftovers(outbox)).toEqual([]);
  });

  it('the transcript page comes from transcript.txt when there is no transcript.md', () => {
    const outbox = path.join(tmpPath(), 'outbox', 'rec-2');
    fs.mkdirSync(outbox, { recursive: true });
    writeText(path.join(outbox, 'transcript.txt'), 'said <b>this</b>');

    const manifest = publish.build(outbox, { title: 'Old take', theme: 'toolmaker-noir' });

    expect(manifest.pages).toEqual(['transcript']);
    const html = fs.readFileSync(path.join(outbox, publish.SITE_DIR, 'transcript.html'), 'utf8');
    expect(html).toContain('Old take');
    expect(html).not.toContain('<b>this</b>');
  });

  it('a rebuild replaces the site and a failed build keeps the previous one', () => {
    const outbox = makeOutbox(tmpPath());
    publish.build(outbox, { title: 'Site visit', theme: 'toolmaker-noir' });
    const site = path.join(outbox, publish.SITE_DIR);
    writeText(path.join(outbox, 'organized.md'), '# Site visit\n\n## Gate\n');

    const rebuilt = publish.build(outbox, { title: 'Site visit', theme: 'github-light' });
    expect(rebuilt.theme).toBe('github-light');
    expect(rebuilt.pages).toContain('organized');
    expect(fs.existsSync(path.join(site, 'organized.html'))).toBe(true);
    const before = tree(site);

    vi.spyOn(render, 'buildSite').mockImplementation((_pages, { dest }) => {
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'summary.html'), 'half');
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });
    expect(() => publish.build(outbox, { title: 'Site visit', theme: 'toolmaker-noir' })).toThrow(PublishError);
    expect(() => publish.build(outbox, { title: 'Site visit', theme: 'toolmaker-noir' })).toThrow(/disk full/);
    expect(tree(site)).toEqual(before);
    expect(leftovers(outbox)).toEqual([]);
  });

  it('a build without any source raises', () => {
    const outbox = path.join(tmpPath(), 'outbox', 'rec-3');
    fs.mkdirSync(outbox, { recursive: true });
    expect(() => publish.build(outbox, { title: 'T', theme: 'toolmaker-noir' })).toThrow(/nothing to publish/);
    expect(fs.existsSync(path.join(outbox, publish.SITE_DIR))).toBe(false);
  });

  it('a build drops the old MD DOCS staging folder', () => {
    const outbox = makeOutbox(tmpPath());
    fs.mkdirSync(path.join(outbox, 'publish', 'photos'), { recursive: true });
    writeText(path.join(outbox, 'publish', 'summary.md'), 'staged');
    publish.build(outbox, { title: 'Site visit', theme: 'toolmaker-noir' });
    expect(fs.existsSync(path.join(outbox, 'publish'))).toBe(false);
    expect(fs.existsSync(path.join(outbox, 'summary.md'))).toBe(true); // the sources stay
  });

  it('deploy copies the site and logs each file', () => {
    const tmp = tmpPath();
    const outbox = makeOutbox(tmp);
    publish.build(outbox, { title: 'Site visit', theme: 'toolmaker-noir' });
    const folder = path.join(tmp, 'webdav', '2026', '09', 'site-visit');
    const lines = [];

    const written = publish.deploy(path.join(outbox, publish.SITE_DIR), folder, (line) => lines.push(line));

    for (const name of ['transcript.html', 'summary.html', 'transcript.md', 'summary.md']) expect(written).toContain(name);
    expect(fs.readFileSync(path.join(folder, 'summary.html')).equals(fs.readFileSync(path.join(outbox, publish.SITE_DIR, 'summary.html')))).toBe(true);
    expect(fs.existsSync(path.join(folder, 'photos', 'photo-a.jpg'))).toBe(true);
    expect(written.map((rel) => `publish: wrote ${rel}`)).toEqual(lines);
  });

  it('a deploy failure raises PublishError', () => {
    const tmp = tmpPath();
    const outbox = makeOutbox(tmp);
    expect(() => publish.deploy(path.join(outbox, publish.SITE_DIR), path.join(tmp, 'pub'), () => {})).toThrow(/deploy to/); // never built
  });

  it('legacy artifacts are only the css and images of the given pages', () => {
    const tmp = tmpPath();
    const folder = path.join(tmp, 'pub');
    fs.mkdirSync(path.join(folder, 'summary_images'), { recursive: true });
    fs.mkdirSync(path.join(folder, 'outline_images'));
    for (const name of ['summary.css', 'Outline.css', 'summary.html', 'summary.md', 'notes.css', 'transcript.css']) {
      fs.writeFileSync(path.join(folder, name), 'x');
    }
    fs.writeFileSync(path.join(folder, 'transcript_images'), 'a file, not a folder');

    const found = publish.legacyArtifacts(folder, ['summary', 'outline', 'transcript']);

    expect(found).toEqual(['summary.css', 'summary_images/', 'Outline.css', 'outline_images/', 'transcript.css']);
    expect(publish.legacyArtifacts(folder, ['organized'])).toEqual([]);
    expect(publish.legacyArtifacts(path.join(tmp, 'missing'), ['summary'])).toEqual([]);
  });
});

// --- republish (test_admin.py: test_republish_*) ------------------------------------------------

function rig() {
  const root = tmpPath();
  const config = withUpdates(defaultConfig(), {
    datastore: path.join(root, 'ds'),
    webdav_folder: path.join(root, 'wd'),
    public_url_base: 'https://example.test/files',
    admin_password: 'test-admin-pass1',
  });
  const store = new JobStore(config);
  cleanup.push(() => store.close());
  const makeRecording = (recordingId) => {
    const src = path.join(root, 'src', recordingId);
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'audio.m4a'), 'm4a');
    fs.writeFileSync(path.join(src, 'metadata.json'), JSON.stringify({ id: recordingId, title: 'Site visit', createdAt: 1_758_400_000_000 }));
    return store.importFolder(src, { title: 'Site visit', reviews: ['summary'], publish: true }).jobId;
  };
  // A recording MD DOCS published: its Markdown in the outbox, the export in its publish folder.
  const legacyPublished = (recordingId) => {
    const jobId = makeRecording(recordingId);
    store.setStatus(jobId, 'complete');
    const outbox = store.outboxDir(recordingId);
    writeText(path.join(outbox, 'transcript.md'), '[brand-header]\n\n# Site visit\n\nhello\n');
    writeText(path.join(outbox, 'summary.md'), '[brand-header]\n# Site visit\n\nbody\n');
    const folder = store.job(jobId).publishFolder;
    fs.mkdirSync(path.join(folder, 'summary_images'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'summary_images', 'photo-x.jpg'), 'jpg');
    const files = {
      'summary.html': '<html>md docs</html>',
      'summary.css': 'md docs css',
      'summary.md': '[brand-header]\n# old',
      'outline.html': 'outline page without a source on this PC',
      'outline.css': 'outline css',
      'notes.txt': "somebody's own file",
    };
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(folder, name), text);
    return [jobId, folder];
  };
  return { root, config, store, makeRecording, legacyPublished };
}

describe('republish', () => {
  it('the dry run lists pages and legacy files and writes nothing', () => {
    const { store, config, makeRecording, legacyPublished } = rig();
    const [, folder] = legacyPublished('rec-rp-1');
    const busy = makeRecording('rec-rp-busy'); // still queued
    fs.mkdirSync(store.job(busy).publishFolder, { recursive: true });
    writeText(path.join(store.outboxDir('rec-rp-busy'), 'summary.md'), '# b');
    makeRecording('rec-rp-never'); // no publish folder on disk: not listed
    const before = tree(folder);

    const plan = publish.planRepublish(store, config);

    const row = plan.find((item) => item.recordingId === 'rec-rp-1');
    expect(row.pages).toEqual(['transcript', 'summary']);
    expect(row.legacy).toEqual(['summary.css', 'summary_images/']); // the outline page is not rewritten, so its css stays
    expect(row.skip).toBe('');
    expect(plan.find((item) => item.recordingId === 'rec-rp-busy').skip).toBe('a job is running for it');
    expect(plan.some((item) => item.recordingId === 'rec-rp-never')).toBe(false);
    expect(tree(folder)).toEqual(before);
    expect(fs.existsSync(path.join(store.outboxDir('rec-rp-1'), 'site'))).toBe(false);
  });

  it('a run deploys and removes only the legacy files it replaced', async () => {
    const { root, store, config, makeRecording, legacyPublished } = rig();
    const [jobId, folder] = legacyPublished('rec-rp-2');
    const webdav = config.webdav_folder;
    fs.writeFileSync(path.join(webdav, 'index.html'), "the publish root's own page");
    const elsewhere = makeRecording('rec-rp-out');
    const outside = path.join(root, 'elsewhere', 'rec-rp-out');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'summary.css'), 'not ours to touch');
    store.setStatus(elsewhere, 'complete', { publishFolder: outside });
    writeText(path.join(store.outboxDir('rec-rp-out'), 'summary.md'), '# o');

    const republisher = new publish.Republisher();
    expect(republisher.start(store, config)).toBe(true);
    expect(republisher.start(store, config)).toBe(false); // one run at a time
    await republisher.wait();

    expect(republisher.running).toBe(false);
    expect(republisher.error).toBe('');
    const site = path.join(store.outboxDir('rec-rp-2'), 'site');
    expect(fs.existsSync(path.join(folder, 'summary.css')) || fs.existsSync(path.join(folder, 'summary_images'))).toBe(false);
    expect(fs.readFileSync(path.join(folder, 'summary.html')).equals(fs.readFileSync(path.join(site, 'summary.html')))).toBe(true);
    expect(fs.readFileSync(path.join(folder, 'summary.md')).equals(fs.readFileSync(path.join(site, 'summary.md')))).toBe(true);
    expect(fs.existsSync(path.join(folder, 'transcript.html')) && fs.existsSync(path.join(folder, '.r1cord-site.json'))).toBe(true);
    const kept = { 'outline.html': 'outline page without a source on this PC', 'outline.css': 'outline css', 'notes.txt': "somebody's own file" };
    for (const [name, text] of Object.entries(kept)) expect(fs.readFileSync(path.join(folder, name), 'utf8')).toBe(text);
    expect(fs.readFileSync(path.join(webdav, 'index.html'), 'utf8')).toBe("the publish root's own page");
    expect(tree(outside)).toEqual({ 'summary.css': Buffer.from('not ours to touch').toString('base64') });

    const done = republisher.results.find((result) => result.recordingId === 'rec-rp-2');
    expect(done.removed).toEqual(['summary.css', 'summary_images/']);
    expect(republisher.results.find((result) => result.recordingId === 'rec-rp-out').skip).toBe('outside the publish folder');
    expect(store.readLog(jobId).some((line) => line.includes('republish: toolmaker-noir'))).toBe(true);
  });
});
