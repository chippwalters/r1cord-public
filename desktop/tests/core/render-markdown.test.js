import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { activeMarkup, parse } = require('./renderHtml');
const { renderFragment } = require('../../src/core/render');
const { Policy, render, slugify, stripBrandHeader } = require('../../src/core/render/markdown');

const SLUG_DOC = `# Sep 23, 00:54

## Key points
## Key points
## Key-points
### Key points 1
## What's "next"?  -- now
### \`code\` & **bold** _it_
#### Notes
## Notes
## Café résumé naïve
## ---Dashes---
##   Spaced   out
## Überblick 2026
## 日本語 heading
## A\u00a0B nbsp
## emoji \u{1F389} party
## [Link text](https://example.com) here
## ![img alt](photos/photo-1.jpg) pic
## under_score and 1.2.3
## key-points
## key-points-1
## İstanbul ǅ
`;

const MD_DOCS_IDS = [
  [1, 'sep-23-0054'],
  [2, 'key-points'],
  [2, 'key-points-1'],
  [2, 'key-points-2'],
  [3, 'key-points-1-1'],
  [2, 'whats-next-now'],
  [3, 'code-bold-it'],
  [4, 'notes'],
  [2, 'notes-1'],
  [2, 'caf-rsum-nave'],
  [2, 'dashes'],
  [2, 'spaced-out'],
  [2, 'berblick-2026'],
  [2, 'heading'],
  [2, 'a-b-nbsp'],
  [2, 'emoji-party'],
  [2, 'link-text-here'],
  [2, 'pic'],
  [2, 'under_score-and-123'],
  [2, 'key-points-3'],
  [2, 'key-points-1-2'],
  [2, 'istanbul'],
];

function headings(html) {
  return parse(html)
    .findAll((n) => ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(n.tag))
    .map((node) => [Number(node.tag.slice(1)), node.attrs.id]);
}

describe('markdown renderer', () => {
  it('heading ids and duplicate suffixes match MD DOCS', () => {
    expect(headings(render(SLUG_DOC).html)).toEqual(MD_DOCS_IDS);
  });

  it('slugify matches MD DOCS on unicode whitespace and punctuation', () => {
    expect(slugify('  Hello,\u2003World!  ')).toBe('hello-world');
    expect(slugify('--x--')).toBe('x');
    expect(slugify('Ünïcödé')).toBe('ncd');
  });

  it('contents outline is h1 to h3 in document order', () => {
    const rendered = render('# A\n\n#### Deep\n\n## B & <b>\n\n### C\n\n##### Deeper\n');
    expect(rendered.headings.map((h) => [h.level, h.id, h.html])).toEqual([
      [1, 'a', 'A'],
      [2, 'b-b', 'B &amp; &lt;b&gt;'],
      [3, 'c', 'C'],
    ]);
  });

  it('task list items render as disabled checkboxes', () => {
    const doc = parse(render('- [ ] open\n- [x] done\n- plain\n').html);
    const boxes = doc.findAll((n) => n.tag === 'input');
    expect(boxes.map((b) => [b.attrs.type, 'disabled' in b.attrs, 'checked' in b.attrs])).toEqual([
      ['checkbox', true, false],
      ['checkbox', true, true],
    ]);
    expect(doc.text().includes('[ ]')).toBe(false);
    expect(doc.text().includes('[x]')).toBe(false);
  });

  it('raw HTML is shown as text never rendered', () => {
    const source = (
      '<script>alert(1)</script>\n\n'
      + 'Inline <img src=x onerror=alert(1)> and <iframe src=https://evil.example></iframe>.\n\n'
      + '<div onclick="steal()">block</div>\n\n'
      + '<style>body{display:none}</style>\n'
    );
    const html = render(source).html;
    expect(activeMarkup(html)).toEqual([]);
    const text = parse(html).text();
    expect(text).toContain('<script>alert(1)</script>');
    expect(text).toContain('<img src=x onerror=alert(1)>');
  });

  it('link policy keeps web, mail, anchor and sibling pages only', () => {
    const source = [
      '[web](https://example.com/a?b=1) [plain](http://example.com) [mail](mailto:a@example.com)',
      '[anchor](#key-points) [page](summary.html) [page-anchor](outline.html#x) [source](summary.md)',
      '[js](javascript:alert(1)) [JS](JaVaScRiPt:alert(1)) [data](data:text/html;base64,PHNjcmlwdD4=)',
      '[vb](vbscript:msgbox) [file](file:///C:/Windows/win.ini) [up](../secret.html) [abs](/etc/passwd)',
      '[proto](//evil.example/x) [other](organized.html) [photo](photos/photo-1.jpg) [unc](\\\\server\\share)',
      '<javascript:alert(1)> www.example.org',
    ].join('\n');
    const policy = new Policy({ pages: ['summary.html', 'summary.md', 'outline.html', 'outline.md'] });
    const html = render(source, policy).html;
    expect(activeMarkup(html, { pages: policy.pages })).toEqual([]);
    const links = {};
    for (const a of parse(html).findAll((n) => n.tag === 'a')) links[a.text()] = a.attrs;
    expect(new Set(Object.keys(links))).toEqual(new Set(['web', 'plain', 'mail', 'anchor', 'page', 'page-anchor', 'source', 'www.example.org']));
    for (const name of ['web', 'plain', 'www.example.org']) {
      expect(links[name].target).toBe('_blank');
      expect(links[name].rel).toBe('noopener noreferrer');
    }
    for (const name of ['mail', 'anchor', 'page', 'source']) {
      expect(links[name].target).toBeUndefined();
    }
    const text = parse(html).text();
    for (const word of ['js', 'data', 'up', 'abs', 'proto', 'other', 'photo']) {
      expect(text).toContain(word);
    }
  });

  it('image policy shows only existing photos and otherwise the alt text', () => {
    const source = [
      '![Desk](photos/photo-001.jpg)',
      '![Missing](photos/photo-404.jpg)',
      '![Up](photos/../photo-001.jpg)',
      '![Abs](C:/Users/x/photo-001.jpg)',
      '![Web](https://evil.example/pixel.gif)',
      '![Png](photos/photo-001.png)',
      '![Data](data:image/png;base64,iVBORw0KGgo=)',
      '![<b onmouseover="x">alt</b>](../x.jpg)',
      '![](photos/nothing.jpg)',
    ].join('\n\n');
    const rendered = render(source, new Policy({ photos: ['photo-001.jpg'] }));
    const doc = parse(rendered.html);
    expect(doc.findAll((n) => n.tag === 'img').map((img) => img.attrs.src)).toEqual(['photos/photo-001.jpg']);
    expect(rendered.photos).toEqual(['photo-001.jpg']);
    expect(doc.findAll((n) => n.tag === 'em').map((em) => em.text())).toEqual([
      'Missing',
      'Up',
      'Abs',
      'Web',
      'Png',
      'Data',
      '<b onmouseover="x">alt</b>',
    ]);
    expect(activeMarkup(rendered.html, { photos: ['photo-001.jpg'] })).toEqual([]);
  });

  it('brand header is dropped only as the leading line', () => {
    expect(stripBrandHeader('[brand-header]\n\n# Title\n')).toBe('# Title\n');
    expect(stripBrandHeader('\ufeff[Brand-Header]\r\n# Title\r\n')).toBe('# Title\r\n');
    expect(stripBrandHeader('# Title\n[brand-header]\n')).toBe('# Title\n[brand-header]\n');
  });

  it('renderFragment drops brand header, page links and images', () => {
    const html = renderFragment(
      '[brand-header]\n# Title\n\n[summary](summary.html) [web](https://example.com) '
      + '![Desk](photos/photo-001.jpg) <script>x()</script>\n',
    );
    const doc = parse(html);
    expect(doc.text()).not.toContain('brand-header');
    expect(doc.findAll((n) => n.tag === 'a').map((a) => a.attrs.href)).toEqual(['https://example.com']);
    expect(doc.findAll((n) => n.tag === 'img')).toEqual([]);
    expect(doc.findAll((n) => n.tag === 'em').map((em) => em.text())).toEqual(['Desk']);
    expect(activeMarkup(html)).toEqual([]);
  });
});
