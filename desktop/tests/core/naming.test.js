import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { slugify, publishFolder, webdavUrl, publishedPages, inPublishRoot } = require('../../src/core/naming');

const tmpDirs = [];

function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-naming-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe('slugify', () => {
  it('lowercases, dashes and trims', () => {
    expect(slugify('Site visit')).toBe('site-visit');
    expect(slugify('Hello, World!!')).toBe('hello-world');
    expect(slugify('  --Foo--  ')).toBe('foo');
    expect(slugify('')).toBe('recording');
    expect(slugify('!!!')).toBe('recording');
  });

  it('truncates to 48 characters without a trailing dash', () => {
    expect(slugify('a'.repeat(80))).toBe('a'.repeat(48));
    expect(slugify('hello ' + 'world-'.repeat(20)).length).toBeLessThanOrEqual(48);
    expect(slugify('hello ' + 'world-'.repeat(20)).endsWith('-')).toBe(false);
  });

  it('collapses non-ASCII runs to one dash, no matter how many code points', () => {
    expect(slugify('Café Ünicode')).toBe('caf-nicode');
    expect(slugify('日本語メモ')).toBe('recording');
  });

  it('drops emoji, including joined families', () => {
    expect(slugify('👨‍👩‍👧 family')).toBe('family');
    expect(slugify('🎉')).toBe('recording');
    expect(slugify('🎉'.repeat(100))).toBe('recording');
  });

  it('drops Windows-illegal characters', () => {
    expect(slugify('What: The *Best* Day? (part 1) | "final"')).toBe('what-the-best-day-part-1-final');
  });

  it('strips trailing dots, padding and edge dashes', () => {
    expect(slugify('Meeting...')).toBe('meeting');
    expect(slugify('  spaced out  ')).toBe('spaced-out');
    expect(slugify('-already dashed-')).toBe('already-dashed');
  });

  it('keeps exactly 48 at the boundary', () => {
    expect(slugify('a'.repeat(48))).toBe('a'.repeat(48));
    expect(slugify('a'.repeat(49))).toBe('a'.repeat(48));
    // Truncation must not leave a trailing dash.
    expect(slugify('ab ' + 'x'.repeat(60))).toBe('ab-' + 'x'.repeat(45));
  });
});

describe('publishFolder', () => {
  it('builds the folder from local time', () => {
    const dir = makeTmp();
    const cfg = { webdav_folder: path.join(dir, 'wd'), datastore: path.join(dir, 'ds') };
    const ms = 1_758_400_000_000;
    const folder = publishFolder(cfg, ms, 'Site visit', 'rec-a');
    const dt = new Date(ms);
    const pad = (value) => String(value).padStart(2, '0');
    expect(path.basename(folder)).toBe(`${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}-${pad(dt.getHours())}${pad(dt.getMinutes())}-site-visit`);
    expect(path.basename(path.dirname(folder))).toBe(pad(dt.getMonth() + 1));
    expect(path.basename(path.dirname(path.dirname(folder)))).toBe(String(dt.getFullYear()));
    expect(path.dirname(path.dirname(path.dirname(folder)))).toBe(cfg.webdav_folder);
  });

  it('suffixes collisions and reuses the folder for the same recording', () => {
    const dir = makeTmp();
    const cfg = { webdav_folder: path.join(dir, 'wd'), datastore: path.join(dir, 'ds') };
    const ms = 1_758_400_000_000;
    const first = publishFolder(cfg, ms, 'Site visit', 'rec-a');
    fs.mkdirSync(first, { recursive: true });
    const second = publishFolder(cfg, ms, 'Site visit', 'rec-b');
    expect(second).not.toBe(first);
    expect(second.endsWith('-2')).toBe(true);
    fs.mkdirSync(second, { recursive: true });
    const occupied = [[first, 'rec-a'], [second, 'rec-b']];
    expect(publishFolder(cfg, ms, 'Site visit', 'rec-a', occupied)).toBe(first);
    expect(publishFolder(cfg, ms, 'Site visit', 'rec-c', occupied).endsWith('-3')).toBe(true);
  });

  it('honours folders recorded in the index but not on disk', () => {
    const dir = makeTmp();
    const cfg = { webdav_folder: path.join(dir, 'wd'), datastore: path.join(dir, 'ds') };
    const ms = 1_758_400_000_000;
    const first = publishFolder(cfg, ms, 'Hello', 'rec-a');
    const second = publishFolder(cfg, ms, 'Hello', 'rec-b', [[first, 'rec-a']]);
    expect(second.endsWith('-2')).toBe(true);
    expect(publishFolder(cfg, ms, 'Hello', 'rec-a', [[first, 'rec-a']])).toBe(first);
  });
});

describe('webdavUrl', () => {
  it('joins the base, the folder under the root and the page', () => {
    const dir = makeTmp();
    const cfg = {
      webdav_folder: path.join(dir, 'wd'),
      datastore: path.join(dir, 'ds'),
      public_url_base: 'https://example.test/files',
    };
    const folder = path.join(cfg.webdav_folder, '2026', '09', '20260920-2000-site-visit');
    expect(webdavUrl(cfg, folder, 'summary.html'))
      .toBe('https://example.test/files/2026/09/20260920-2000-site-visit/summary.html');
  });

  it('strips trailing slashes from the base', () => {
    const dir = makeTmp();
    const cfg = {
      webdav_folder: path.join(dir, 'wd'),
      datastore: path.join(dir, 'ds'),
      public_url_base: 'https://example.test/files/',
    };
    const folder = path.join(cfg.webdav_folder, '2026', '09', '20260920-2000-site-visit');
    expect(webdavUrl(cfg, folder, 'summary.html'))
      .toBe('https://example.test/files/2026/09/20260920-2000-site-visit/summary.html');
  });

  it('accepts an empty base', () => {
    const dir = makeTmp();
    const cfg = { webdav_folder: path.join(dir, 'wd'), datastore: path.join(dir, 'ds') };
    const folder = path.join(cfg.webdav_folder, '2026', '09', '20260920-2000-site-visit');
    expect(webdavUrl(cfg, folder, 'summary.html'))
      .toBe('/2026/09/20260920-2000-site-visit/summary.html');
  });

  it('percent-encodes segments', () => {
    const dir = makeTmp();
    const cfg = {
      webdav_folder: path.join(dir, 'wd'),
      datastore: path.join(dir, 'ds'),
      public_url_base: 'https://x.test',
    };
    const folder = path.join(cfg.webdav_folder, '2026', '09', '20260920-2000 with space');
    expect(webdavUrl(cfg, folder, 'summary.html'))
      .toBe('https://x.test/2026/09/20260920-2000%20with%20space/summary.html');
  });

  it('uses the last three segments for a folder outside the root', () => {
    const dir = makeTmp();
    const cfg = {
      webdav_folder: path.join(dir, 'wd'),
      datastore: path.join(dir, 'ds'),
      public_url_base: 'https://x.test',
    };
    const outside = path.join(dir, 'elsewhere', '2025', '12', '20251209-1010-other');
    expect(webdavUrl(cfg, outside, 'summary.html'))
      .toBe('https://x.test/2025/12/20251209-1010-other/summary.html');
  });

  it('treats a sibling sharing the root prefix as outside the root', () => {
    // "wd2" starts with the string "wd" but is a sibling, not a child; this
    // used to raise from Path.relative_to in the Python original.
    const dir = makeTmp();
    const cfg = {
      webdav_folder: path.join(dir, 'wd'),
      datastore: path.join(dir, 'ds'),
      public_url_base: 'https://x.test',
    };
    const sibling = path.join(dir, 'wd2', '2025', '12', '20251209-1010-other');
    expect(webdavUrl(cfg, sibling, 'summary.html'))
      .toBe('https://x.test/2025/12/20251209-1010-other/summary.html');
  });

  it('names the page in the URL', () => {
    const dir = makeTmp();
    const cfg = {
      webdav_folder: path.join(dir, 'wd'),
      datastore: path.join(dir, 'ds'),
      public_url_base: 'https://x.test',
    };
    const folder = path.join(cfg.webdav_folder, '2026', '09', '20260920-2000-site-visit');
    expect(webdavUrl(cfg, folder, 'transcript.html'))
      .toBe('https://x.test/2026/09/20260920-2000-site-visit/transcript.html');
  });

  it('matches the root case-insensitively', () => {
    const dir = makeTmp();
    const cfg = {
      webdav_folder: path.join(dir, 'wd'),
      datastore: path.join(dir, 'ds'),
      public_url_base: 'https://x.test',
    };
    const folder = path.join(dir, 'WD', '2026', '09', '20260920-2000-site-visit');
    expect(webdavUrl(cfg, folder, 'summary.html'))
      .toBe('https://x.test/2026/09/20260920-2000-site-visit/summary.html');
  });
});

describe('publishedPages', () => {
  it('lists existing html pages in page order', () => {
    const dir = makeTmp();
    const cfg = {
      webdav_folder: path.join(dir, 'wd'),
      datastore: path.join(dir, 'ds'),
      public_url_base: 'https://x.test',
    };
    const folder = path.join(cfg.webdav_folder, '2026', '09', '20260920-2000-site-visit');
    expect(publishedPages(cfg, folder)).toEqual([]); // folder not created yet
    expect(publishedPages(cfg, null)).toEqual([]);
    fs.mkdirSync(folder, { recursive: true });
    for (const name of ['organized.html', 'transcript.html', 'summary.md', 'outline.md', 'summary.abc.html']) {
      fs.writeFileSync(path.join(folder, name), 'x', 'utf8');
    }
    const base = 'https://x.test/2026/09/20260920-2000-site-visit';
    expect(publishedPages(cfg, folder)).toEqual([
      { kind: 'transcript', url: `${base}/transcript.html` },
      { kind: 'organized', url: `${base}/organized.html` },
    ]);
  });
});

describe('inPublishRoot', () => {
  it('accepts only folders strictly inside the root', () => {
    const dir = makeTmp();
    const cfg = { webdav_folder: path.join(dir, 'wd') };
    expect(inPublishRoot(cfg, path.join(dir, 'wd'))).toBe(false); // never the root itself
    expect(inPublishRoot(cfg, path.join(dir, 'wd', '2026'))).toBe(true);
    expect(inPublishRoot(cfg, path.join(dir, 'wd2', '2026'))).toBe(false); // sibling prefix
    expect(inPublishRoot(cfg, path.join(dir, 'elsewhere'))).toBe(false);
    expect(inPublishRoot(cfg, path.join(dir, 'WD', '2026'))).toBe(true); // case-insensitive
  });
});
