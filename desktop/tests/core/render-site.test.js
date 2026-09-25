import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { activeMarkup, parse } = require('./renderHtml');
const { MANIFEST_NAME, PageSource, SiteManifest, buildSite, deploySite, getTheme } = require('../../src/core/render');
const { ValueError } = require('../../src/core/errors');

const TITLE = 'Sep 23, 00:54';
const SUMMARY = `[brand-header]
# Sep 23, 00:54

The speaker describes R1 Chord. See the [outline](outline.html) and [transcript](transcript.md).

![The device](photos/photo-001.jpg)

## Action items

- [ ] None stated in the recording.
`;
const OUTLINE = '[brand-header]\n# Sep 23, 00:54\n\n- Story\n    - Pronounced "ReCord"\n';
const TRANSCRIPT = '[brand-header]\n\n# Sep 23, 00:54\n\n*2026-09-22 23:54 · 1:33*\n\nOkay, let\'s tell the story.\n';

function pages() {
  return [
    new PageSource('summary', 'Summary', SUMMARY),
    new PageSource('outline', 'Outline', OUTLINE),
    new PageSource('transcript', 'Transcript', TRANSCRIPT),
  ];
}

function photos(tmpPath) {
  const dir = path.join(tmpPath, 'inbox');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'photo-001.jpg'), Buffer.from('\xff\xd8 shown', 'latin1'));
  fs.writeFileSync(path.join(dir, 'photo-002.jpg'), Buffer.from('\xff\xd8 never referenced', 'latin1'));
  return dir;
}

function tree(root) {
  const out = {};
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else out[path.relative(root, full).split(path.sep).join('/')] = fs.readFileSync(full);
    }
  }
  walk(root);
  return out;
}

function treesEqual(a, b) {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.join('\0') !== keysB.join('\0')) return false;
  return keysA.every((key) => a[key].equals(b[key]));
}

function build(tmpPath, name = 'site', theme = 'toolmaker-noir') {
  const dest = path.join(tmpPath, name);
  const photosDir = fs.existsSync(path.join(tmpPath, 'inbox')) ? path.join(tmpPath, 'inbox') : photos(tmpPath);
  return [dest, buildSite(pages(), { title: TITLE, photosDir, theme, dest })];
}

let tmpPath;

beforeEach(() => {
  tmpPath = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-render-site-'));
});

afterEach(() => {
  fs.rmSync(tmpPath, { recursive: true, force: true });
});

describe('buildSite', () => {
  it('writes pages, sources, assets, photos and a complete manifest', () => {
    const [dest, manifest] = build(tmpPath);
    const files = tree(dest);
    expect(manifest.pages).toEqual(['transcript', 'summary', 'outline']);
    expect(new Set(Object.keys(files).filter((rel) => rel !== MANIFEST_NAME))).toEqual(new Set(Object.keys(manifest.files)));
    const hashed = {};
    for (const [rel, data] of Object.entries(files)) {
      if (rel !== MANIFEST_NAME) hashed[rel] = crypto.createHash('sha256').update(data).digest('hex');
    }
    expect(hashed).toEqual(manifest.files);
    expect(SiteManifest.fromJson(files[MANIFEST_NAME].toString('utf8'))).toEqual(manifest);
    expect(new Set(Object.keys(files).filter((rel) => !rel.includes('/')))).toEqual(new Set([
      MANIFEST_NAME,
      ...['transcript', 'summary', 'outline'].flatMap((kind) => [`${kind}.html`, `${kind}.md`]),
    ]));
    expect(Object.keys(files).filter((rel) => rel.startsWith('assets/')).map((rel) => rel.split('.')[0]).sort()).toEqual([
      'assets/page',
      'assets/site',
      'assets/theme',
    ]);
  });

  it('publishes md sources without the brand header line', () => {
    const [dest] = build(tmpPath);
    expect(fs.readFileSync(path.join(dest, 'summary.md'), 'utf8')).toBe(SUMMARY.replace('[brand-header]\n', ''));
    expect(fs.readFileSync(path.join(dest, 'transcript.md'), 'utf8').startsWith('# Sep 23, 00:54\n')).toBe(true);
    for (const kind of ['summary', 'outline', 'transcript']) {
      expect(fs.readFileSync(path.join(dest, `${kind}.html`), 'utf8')).not.toContain('brand-header');
    }
  });

  it('every page navigates to every page and offers its markdown', () => {
    const [dest] = build(tmpPath);
    for (const kind of ['transcript', 'summary', 'outline']) {
      const doc = parse(fs.readFileSync(path.join(dest, `${kind}.html`), 'utf8'));
      const nav = doc.findAll((n) => n.tag === 'nav' && n.attrs['aria-label'] === 'Pages')[0];
      const hrefs = nav.findAll((n) => n.tag === 'a').map((a) => [a.attrs.href, a.attrs['aria-current']]);
      expect(hrefs).toEqual(['transcript', 'summary', 'outline'].map((k) => [`${k}.html`, k === kind ? 'page' : undefined]));
      const download = doc.findAll((n) => n.tag === 'a' && 'download' in n.attrs);
      expect(download).toHaveLength(1);
      expect(download[0].attrs.href).toBe(`${kind}.md`);
    }
  });

  it('copies only referenced existing photos', () => {
    const [dest, manifest] = build(tmpPath);
    expect(Object.keys(manifest.files).filter((rel) => rel.startsWith('photos/')).sort()).toEqual(['photos/photo-001.jpg']);
    expect(fs.readFileSync(path.join(dest, 'photos', 'photo-001.jpg'))).toEqual(Buffer.from('\xff\xd8 shown', 'latin1'));
  });

  it('is byte deterministic', () => {
    const [first] = build(tmpPath, 'one');
    const second = path.join(tmpPath, 'two');
    buildSite([...pages()].reverse(), { title: TITLE, photosDir: path.join(tmpPath, 'inbox'), theme: 'Toolmaker-Noir', dest: second });
    expect(treesEqual(tree(first), tree(second))).toBe(true);
  });

  it('hostile markdown and title produce no active markup and no files outside dest', () => {
    const photosDir = photos(tmpPath);
    const secret = path.join(tmpPath, 'secret.jpg');
    fs.writeFileSync(secret, Buffer.from('secret bytes'));
    fs.writeFileSync(path.join(photosDir, 'notaphoto.png'), Buffer.from('png'));
    const hostile = [
      '# Title <script>alert(1)</script>',
      '<img src=x onerror="alert(1)"> <iframe src="https://evil.example"></iframe>',
      '[js](javascript:alert(document.cookie)) [data](data:text/html,<script>alert(1)</script>)',
      `![up](../secret.jpg) ![abs](${secret.split(path.sep).join('/')}) ![trav](photos/../../secret.jpg)`,
      '![png](photos/notaphoto.png) ![missing](photos/photo-404.jpg) ![ok](photos/photo-001.jpg)',
      '[sibling-missing](organized.html) [up](../../index.html)',
    ].join('\n\n');
    const title = '</title><script>alert("t")</script><meta http-equiv="refresh" content="0;url=https://evil.example">';
    const before = new Set(Object.keys(tree(tmpPath)));
    const dest = path.join(tmpPath, 'site');
    buildSite([new PageSource('summary', 'Summary <b>', hostile)], { title, photosDir, theme: 'github-light', dest });

    const after = tree(tmpPath);
    const destTree = tree(dest);
    expect(new Set(Object.keys(after).filter((rel) => !before.has(rel)))).toEqual(new Set(Object.keys(destTree).map((rel) => `site/${rel}`)));
    expect(Object.keys(destTree).filter((rel) => rel.startsWith('photos/')).sort()).toEqual(['photos/photo-001.jpg']);
    expect(Buffer.concat(Object.values(destTree)).includes(Buffer.from('secret bytes'))).toBe(false);
    const html = fs.readFileSync(path.join(dest, 'summary.html'), 'utf8');
    expect(activeMarkup(html, { pages: ['summary.html', 'summary.md'], photos: ['photo-001.jpg'] })).toEqual([]);
    const doc = parse(html);
    expect(doc.findAll((n) => n.tag === 'title')[0].text()).toBe(`${title} — Summary <b>`);
  });

  it('CSP allows same-origin script and only the theme font hosts', () => {
    const policies = {};
    for (const theme of ['toolmaker-noir', 'altuit-toc-sketchnote', 'notion']) {
      const dest = path.join(tmpPath, theme);
      buildSite([new PageSource('summary', 'Summary', '# T\n')], { title: 'T', photosDir: null, theme, dest });
      const doc = parse(fs.readFileSync(path.join(dest, 'summary.html'), 'utf8'));
      const meta = doc.findAll((n) => n.tag === 'meta' && n.attrs['http-equiv'] === 'Content-Security-Policy');
      expect(meta).toHaveLength(1);
      const directives = Object.fromEntries(meta[0].attrs.content.split(';').map((part) => {
        const trimmed = part.trim();
        const space = trimmed.indexOf(' ');
        return [trimmed.slice(0, space), trimmed.slice(space + 1)];
      }));
      expect(directives['default-src']).toBe("'none'");
      expect(directives['script-src']).toBe("'self'");
      expect(meta[0].attrs.content.includes('unsafe')).toBe(false);
      policies[theme] = [directives['style-src'], directives['font-src']];
    }
    expect(policies['toolmaker-noir']).toEqual(["'self' https://fonts.googleapis.com", "'self' https://fonts.gstatic.com"]);
    const sketchHost = getTheme('altuit-toc-sketchnote').css.match(/@font-face[^}]*url\('(https:\/\/[^/']+)/)[1];
    expect(policies['altuit-toc-sketchnote']).toEqual([
      "'self' https://fonts.googleapis.com",
      `'self' https://fonts.gstatic.com ${sketchHost}`,
    ]);
    expect(policies.notion).toEqual(["'self'", "'self'"]);
  });

  it('empties a previous site but refuses a folder that is not one', () => {
    const [dest] = build(tmpPath);
    fs.writeFileSync(path.join(dest, 'stale.html'), 'old');
    build(tmpPath);
    expect(fs.existsSync(path.join(dest, 'stale.html'))).toBe(false);

    const other = path.join(tmpPath, 'publish');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'keep.txt'), 'user file');
    expect(() => buildSite(pages(), { title: TITLE, photosDir: null, theme: 'notion', dest: other })).toThrow(ValueError);
    expect(fs.readFileSync(path.join(other, 'keep.txt'), 'utf8')).toBe('user file');
  });

  it('rejects bad page lists', () => {
    for (const bad of [
      [],
      [new PageSource('notes', 'Notes', 'x')],
      [new PageSource('summary', 'A', 'x'), new PageSource('summary', 'B', 'y')],
    ]) {
      expect(() => buildSite(bad, { title: 'T', photosDir: null, theme: 'notion', dest: path.join(tmpPath, 'site') })).toThrow(ValueError);
    }
    expect(() => buildSite(pages(), { title: 'T', photosDir: null, theme: 'nope', dest: path.join(tmpPath, 'site') })).toThrow(ValueError);
  });
});

describe('deploySite', () => {
  function site(name, pageList, theme = 'toolmaker-noir') {
    const photosDir = fs.existsSync(path.join(tmpPath, 'inbox')) ? path.join(tmpPath, 'inbox') : photos(tmpPath);
    buildSite(pageList, { title: TITLE, photosDir, theme, dest: path.join(tmpPath, name) });
    return path.join(tmpPath, name);
  }

  it('puts summary after other pages and the manifest last', () => {
    const src = site('site', pages());
    const written = deploySite(src, path.join(tmpPath, 'publish'));
    expect(written.at(-1)).toBe(MANIFEST_NAME);
    expect(written.at(-2)).toBe('summary.html');
    const firstPage = written.findIndex((rel) => !rel.includes('/'));
    expect(written.slice(0, firstPage).every((rel) => rel.includes('/'))).toBe(true);
    expect(written.slice(firstPage, firstPage + 3)).toEqual(['transcript.md', 'summary.md', 'outline.md']);
    expect(written.slice(firstPage + 3, -2)).toEqual(['transcript.html', 'outline.html']);
    expect(treesEqual(tree(path.join(tmpPath, 'publish')), tree(src))).toBe(true);
  });

  it('rewrites only the manifest when redeploying an unchanged site', () => {
    const src = site('site', pages());
    deploySite(src, path.join(tmpPath, 'publish'));
    expect(deploySite(src, path.join(tmpPath, 'publish'))).toEqual([MANIFEST_NAME]);
  });

  it('deletes only files the previous manifest listed', () => {
    const publish = path.join(tmpPath, 'publish');
    fs.mkdirSync(publish);
    const legacy = { 'summary.css': Buffer.from('legacy MD DOCS css'), 'notes.txt': Buffer.from('user file'), 'summary_images/x.png': Buffer.from('img') };
    for (const [rel, data] of Object.entries(legacy)) {
      fs.mkdirSync(path.dirname(path.join(publish, rel)), { recursive: true });
      fs.writeFileSync(path.join(publish, ...rel.split('/')), data);
    }
    const old = site('old', pages(), 'toolmaker-noir');
    deploySite(old, publish);
    const oldFiles = new Set(Object.keys(SiteManifest.fromJson(fs.readFileSync(path.join(old, MANIFEST_NAME), 'utf8')).files));

    const neu = site('new', [new PageSource('transcript', 'Transcript', TRANSCRIPT)], 'notion');
    deploySite(neu, publish);
    const newFiles = new Set(Object.keys(SiteManifest.fromJson(fs.readFileSync(path.join(neu, MANIFEST_NAME), 'utf8')).files));

    const remaining = new Set(Object.keys(tree(publish)));
    expect(remaining).toEqual(new Set([...newFiles, ...Object.keys(legacy), MANIFEST_NAME]));
    expect([...oldFiles].filter((rel) => !newFiles.has(rel)).some((rel) => remaining.has(rel))).toBe(false);
    expect(fs.existsSync(path.join(publish, 'photos'))).toBe(false);
    for (const [rel, data] of Object.entries(legacy)) {
      expect(fs.readFileSync(path.join(publish, ...rel.split('/')))).toEqual(data);
    }
  });

  it('a hostile previous manifest cannot delete outside its names', () => {
    const publish = path.join(tmpPath, 'publish');
    fs.mkdirSync(publish);
    const outside = path.join(tmpPath, 'outside.txt');
    fs.writeFileSync(outside, 'keep');
    fs.writeFileSync(path.join(publish, 'keep.html'), 'keep');
    const digest = '0'.repeat(64);
    const hostile = { renderer: 'x', theme: 'notion', pages: [], files: { '../outside.txt': digest, 'keep.html': digest } };
    fs.writeFileSync(path.join(publish, MANIFEST_NAME), JSON.stringify(hostile));
    deploySite(site('site', pages()), publish);
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
    expect(fs.readFileSync(path.join(publish, 'keep.html'), 'utf8')).toBe('keep');
    expect(() => SiteManifest.fromJson(JSON.stringify(hostile))).toThrow(ValueError);
  });

  it('refuses a site that does not match its manifest before writing', () => {
    const src = site('site', pages());
    fs.writeFileSync(path.join(src, 'outline.html'), 'tampered');
    expect(() => deploySite(src, path.join(tmpPath, 'publish'))).toThrow(ValueError);
    const publish = path.join(tmpPath, 'publish');
    expect(!fs.existsSync(publish) || Object.keys(tree(publish)).length === 0).toBe(true);
  });
});
