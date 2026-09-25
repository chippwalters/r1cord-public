import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { activeMarkup, parse } = require('./renderHtml');
const { DEFAULT_THEME_ID, PageSource, buildSite, getTheme, listThemes } = require('../../src/core/render');
const { render } = require('../../src/core/render/markdown');
const { buildToc } = require('../../src/core/render/page');
const { THEMES_DIR, parseTheme } = require('../../src/core/render/themes');
const { ValueError } = require('../../src/core/errors');

const ROOT = path.join(__dirname, '..', '..');
const MD_DOCS = process.env.R1CORD_MD_DOCS || path.join(ROOT, '..', 'md-docs');
const TOC_THEMES = new Set(['toolmaker-noir', 'high-contrast', 'altuit-toc', 'altuit-toc-lg', 'altuit-toc-light', 'altuit-toc-sketchnote']);
const SUMMARY = '[brand-header]\n# Title\n\n## Key points\n\n- one\n\n### Detail\n\nText.\n\n#### Too deep\n';

let tmpPath;

beforeEach(() => {
  tmpPath = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-render-themes-'));
});

afterEach(() => {
  fs.rmSync(tmpPath, { recursive: true, force: true });
});

describe('themes', () => {
  it('the twelve vendored themes parse with unique ids and names sorted by name', () => {
    const themes = listThemes();
    expect(themes).toHaveLength(12);
    const stems = fs.readdirSync(THEMES_DIR).filter((name) => name.endsWith('.css')).map((name) => path.parse(name).name);
    expect(new Set(themes.map((t) => t.id))).toEqual(new Set(stems));
    expect(new Set(themes.map((t) => t.name.toLowerCase())).size).toBe(12);
    expect(themes.map((t) => t.name.toLowerCase())).toEqual([...themes.map((t) => t.name.toLowerCase())].sort());
    for (const theme of themes) {
      expect(theme.name).not.toBe('Untitled Theme');
      expect(theme.background.startsWith('#') && theme.background.length === 7).toBe(true);
    }
    expect(getTheme(DEFAULT_THEME_ID).name).toBe('Toolmaker-Noir');
  });

  it('layout detection follows MD DOCS rules', () => {
    expect(new Set(listThemes().filter((t) => t.layout === 'toc').map((t) => t.id))).toEqual(TOC_THEMES);
    const header = '/**\n * @name X\n * @background #101010\n * @text #EEEEEE\n{layout} */\n';
    expect(parseTheme('plain', header.replace('{layout}', ' * @layout toc\n')).layout).toBe('toc');
    expect(parseTheme('plain', header.replace('{layout}', ' * @layout TOC\n')).layout).toBe('toc');
    expect(parseTheme('plain', header.replace('{layout}', ' * @layout standard\n')).layout).toBe('standard');
    expect(parseTheme('plain', header.replace('{layout}', '')).layout).toBe('standard');
    expect(parseTheme('altuit-toc-new', header.replace('{layout}', '')).layout).toBe('toc');
  });

  it('missing metadata falls back to MD DOCS defaults', () => {
    const theme = parseTheme('bare', 'body { color: red; }');
    expect([theme.name, theme.background, theme.text, theme.layout]).toEqual(['Untitled Theme', '#FFFFFF', '#000000', 'standard']);
  });

  it('getTheme accepts id or name case-insensitively and rejects unknown', () => {
    expect(getTheme('TOOLMAKER-NOIR').id).toBe('toolmaker-noir');
    expect(getTheme('toolmaker-noir').id).toBe('toolmaker-noir');
    expect(getTheme('Toolmaker-Noir').id).toBe('toolmaker-noir');
    expect(getTheme('github light').id).toBe('github-light');
    expect(() => getTheme('no-such-theme')).toThrow(ValueError);
    expect(() => getTheme('')).toThrow(ValueError);
  });

  it('provenance hashes match the vendored files', () => {
    const provenance = JSON.parse(fs.readFileSync(path.join(THEMES_DIR, 'PROVENANCE.json'), 'utf8'));
    const vendored = {};
    for (const name of fs.readdirSync(THEMES_DIR).filter((n) => n.endsWith('.css'))) {
      vendored[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(THEMES_DIR, name))).digest('hex');
    }
    expect(provenance.themes).toEqual(vendored);
  });

  const hasMdDocs = fs.existsSync(path.join(MD_DOCS, 'public', 'themes'));
  (hasMdDocs ? it : it.skip)('vendored themes have not drifted from MD DOCS', () => {
    const source = {};
    for (const name of fs.readdirSync(path.join(MD_DOCS, 'public', 'themes')).filter((n) => n.endsWith('.css'))) {
      source[name] = fs.readFileSync(path.join(MD_DOCS, 'public', 'themes', name));
    }
    const vendored = {};
    for (const name of fs.readdirSync(THEMES_DIR).filter((n) => n.endsWith('.css'))) {
      vendored[name] = fs.readFileSync(path.join(THEMES_DIR, name));
    }
    expect(new Set(Object.keys(vendored))).toEqual(new Set(Object.keys(source)));
    // Content, not line endings: MD DOCS is checked out with core.autocrlf, so its working copy
    // flips to CRLF on a checkout without any theme change.
    const text = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n');
    const drifted = Object.keys(source).filter((name) => text(source[name]) !== text(vendored[name])).sort();
    expect(drifted).toEqual([]);
  });

  it.each(listThemes().map((t) => t.id))('every theme renders its layout with page nav: %s', (theme) => {
    const pages = [
      new PageSource('transcript', 'Transcript', '# Title\n\nWords.\n'),
      new PageSource('summary', 'Summary', SUMMARY),
    ];
    const manifest = buildSite(pages, { title: 'Rec', photosDir: null, theme, dest: path.join(tmpPath, 'site') });
    expect(manifest.theme).toBe(theme);
    const html = fs.readFileSync(path.join(tmpPath, 'site', 'summary.html'), 'utf8');
    const doc = parse(html);
    expect(activeMarkup(html, { pages: ['transcript.html', 'transcript.md', 'summary.html', 'summary.md'] })).toEqual([]);

    const nav = doc.findAll((n) => n.tag === 'nav' && n.attrs['aria-label'] === 'Pages');
    expect(nav).toHaveLength(1);
    const links = nav[0].findAll((n) => n.tag === 'a');
    expect(links.map((a) => [a.attrs.href, a.text().trim(), a.attrs['aria-current']])).toEqual([
      ['transcript.html', 'Transcript', undefined],
      ['summary.html', 'Summary', 'page'],
    ]);
    const download = doc.findAll((n) => n.tag === 'a' && n.attrs.href === 'summary.md');
    expect(download).toHaveLength(1);
    expect('download' in download[0].attrs).toBe(true);
    const header = doc.findAll((n) => n.tag === 'header')[0];
    expect(header.text()).toContain('Rec');
    expect(doc.findAll((n) => n.tag === 'svg')).toEqual([]);
    expect(html.toLowerCase()).not.toContain('chippwalters');

    const body = doc.findAll((n) => n.tag === 'body')[0];
    if (getTheme(theme).layout === 'toc') {
      const toc = doc.byId('tocList');
      expect(toc.findAll((n) => n.tag === 'a').map((a) => a.attrs.href)).toEqual(['#title', '#key-points', '#detail']);
      expect(['dark', 'light']).toContain(body.attrs['data-theme']);
      expect(doc.byId('themeToggle').tag).toBe('button');
      expect(doc.findAll((n) => n.tag === 'script')[0].attrs.src.startsWith('assets/page.')).toBe(true);
    } else {
      expect(body.attrs.class).toBe(`theme-${theme}`);
      expect(doc.findAll((n) => n.tag === 'script')).toEqual([]);
    }
  });

  it('toc pages open in the mode MD DOCS chooses', () => {
    const modes = {};
    for (const theme of ['toolmaker-noir', 'high-contrast', 'altuit-toc', 'altuit-toc-light']) {
      buildSite([new PageSource('summary', 'Summary', '# T\n')], { title: 'T', photosDir: null, theme, dest: path.join(tmpPath, theme) });
      const body = parse(fs.readFileSync(path.join(tmpPath, theme, 'summary.html'), 'utf8')).findAll((n) => n.tag === 'body')[0];
      modes[theme] = body.attrs['data-theme'];
    }
    expect(modes).toEqual({
      'toolmaker-noir': 'dark',
      'high-contrast': 'light',
      'altuit-toc': 'dark',
      'altuit-toc-light': 'light',
    });
  });

  it('contents tree nests like MD DOCS and keeps sections before the first h1', () => {
    const toc = buildToc(render('## Early\n\n### Sub\n\n# Title\n\n### Loose\n\n## Later\n\n### Deep\n').headings);
    const shape = toc.map((e) => [e.id, e.section, e.children.map((c) => [c.id, c.section, c.children.map((g) => g.id)])]);
    expect(shape).toEqual([
      ['early', 'toc-h2', [['sub', '', []]]],
      ['title', 'toc-h1', [['loose', '', []], ['later', 'toc-h2', ['deep']]]],
    ]);
  });
});
