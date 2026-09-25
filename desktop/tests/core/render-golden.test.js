import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { PageSource, buildSite, listThemes } = require('../../src/core/render');

const ROOT = path.join(__dirname, '..', '..');
const CORPUS = path.join(ROOT, 'tests', 'golden', 'render', 'corpus');
const COMMITTED = path.join(ROOT, 'tests', 'golden', 'render', 'out');
const PAGE_LABELS = {
  transcript: 'Transcript',
  summary: 'Summary',
  outline: 'Outline',
  organized: 'Cleaned up & organized',
};

function corpusPages() {
  const pages = [];
  for (const [kind, label] of Object.entries(PAGE_LABELS)) {
    const source = path.join(CORPUS, `${kind}.md`);
    if (fs.existsSync(source)) pages.push(new PageSource(kind, label, fs.readFileSync(source, 'utf8')));
  }
  if (pages.length === 0) throw new Error(`no renderer pages in ${CORPUS}`);
  return pages;
}

function tree(folder) {
  const out = {};
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else out[path.relative(folder, full).split(path.sep).join('/')] = fs.readFileSync(full);
    }
  }
  walk(folder);
  return out;
}

function firstDiff(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : len;
}

function snippet(buf, index) {
  const start = Math.max(0, index - 24);
  const end = Math.min(buf.length, index + 24);
  return buf.slice(start, end).toString('utf8').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function renderCorpus(out) {
  fs.mkdirSync(out, { recursive: true });
  for (const theme of listThemes()) {
    buildSite(corpusPages(), {
      title: 'Golden renderer corpus',
      photosDir: path.join(CORPUS, 'photos'),
      theme: theme.id,
      dest: path.join(out, theme.id),
    });
  }
}

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('golden renderer corpus', () => {
  it('JS buildSite matches committed golden bytes for all 12 themes', () => {
    const rendered = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-render-golden-'));
    tmpDirs.push(rendered);
    renderCorpus(rendered);
    const got = tree(rendered);
    const want = tree(COMMITTED);
    const missing = Object.keys(want).filter((rel) => !(rel in got));
    const extra = Object.keys(got).filter((rel) => !(rel in want));
    const mismatches = [];
    for (const rel of Object.keys(want).sort()) {
      if (!(rel in got)) continue;
      if (got[rel].equals(want[rel])) continue;
      const index = firstDiff(got[rel], want[rel]);
      mismatches.push(
        `${rel}: len got=${got[rel].length} want=${want[rel].length} firstDiff@${index}`
        + ` got="${snippet(got[rel], index)}" want="${snippet(want[rel], index)}"`,
      );
    }
    expect({ missing, extra, mismatches, themes: fs.readdirSync(rendered).length }).toEqual({
      missing: [],
      extra: [],
      mismatches: [],
      themes: 12,
    });
  });

  it('two golden renders have the same bytes', () => {
    const first = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-render-golden-a-'));
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-render-golden-b-'));
    tmpDirs.push(first, second);
    renderCorpus(first);
    renderCorpus(second);
    const a = tree(first);
    const b = tree(second);
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    for (const rel of Object.keys(a)) expect(a[rel].equals(b[rel]), rel).toBe(true);
    const hash = (files) => crypto.createHash('sha256').update(Buffer.concat(Object.keys(files).sort().map((rel) => files[rel]))).digest();
    expect(hash(a).equals(hash(b))).toBe(true);
  });
});
