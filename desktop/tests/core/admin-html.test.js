// The admin's html`` helper escapes and prints values the way Jinja2 autoescape (markupsafe) did,
// and the admin's number formatting rounds the way Python does. Expected strings were taken from
// markupsafe 3.0.3 / Jinja2 3.1.6 / CPython 3.12.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { escape, html, raw } = require('../../src/core/admin/html');
const { formatDuration, humanSize, pyQuote, redirectLocation, roundOne } = require('../../src/core/admin/format');

describe('html escaping (markupsafe.escape)', () => {
  it('escapes the five characters markupsafe escapes, with its entity spellings', () => {
    const value = '<a href="x" onclick=\'y\'>&amp; é —</a>';
    expect(String(html`<p>${value}</p>`)).toBe(
      '<p>&lt;a href=&#34;x&#34; onclick=&#39;y&#39;&gt;&amp;amp; é —&lt;/a&gt;</p>',
    );
  });

  it('keeps an attribute value inside its quotes', () => {
    const title = '" onmouseover="alert(1)';
    expect(String(html`<span title="${title}">`)).toBe('<span title="&#34; onmouseover=&#34;alert(1)">');
  });

  it('passes markup through once: nested templates and raw() are not escaped again', () => {
    const inner = html`<b>${'<i>'}</b>`;
    expect(String(html`<p>${inner}${raw('<br>')}</p>`)).toBe('<p><b>&lt;i&gt;</b><br></p>');
    expect(String(escape(escape('<')))).toBe('&lt;');
  });

  it('joins arrays, escaping each plain item and keeping each markup item', () => {
    expect(String(html`<ul>${['<x>', html`<li>${'&'}</li>`]}</ul>`)).toBe('<ul>&lt;x&gt;<li>&amp;</li></ul>');
  });

  it('honours an object that declares its own __html__', () => {
    expect(String(html`${{ __html__: () => '<em>ok</em>' }}`)).toBe('<em>ok</em>');
  });

  it('prints values as a Jinja expression does: None, True/False, float repr, Undefined empty', () => {
    expect(String(html`${null}|${true}|${false}|${1.5}|${1.5e-7}|${0.1 + 0.2}|${3}|${undefined}|`)).toBe(
      'None|True|False|1.5|1.5e-07|0.30000000000000004|3||',
    );
  });
});

describe('admin number and URL formatting', () => {
  it('sizes round half to even on the exact value, like f"{x:.1f}"', () => {
    expect(humanSize(2304)).toBe('2.2 KB'); // exactly 2.25 KB
    expect(humanSize(2049)).toBe('2.0 KB');
    expect(humanSize(1023)).toBe('1023 B');
    expect(humanSize(5 * 1024 ** 3)).toBe('5.0 GB');
  });

  it('rounds one decimal like Python round(x, 1) and prints its repr', () => {
    expect(roundOne(2.25)).toBe('2.2');
    expect(roundOne(0.05)).toBe('0.1');
    expect(roundOne(12)).toBe('12.0');
  });

  it('durations round half to even to whole seconds', () => {
    expect(formatDuration(124_500)).toBe('2:04');
    expect(formatDuration(125_500)).toBe('2:06');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
  });

  it('quotes like urllib.parse.quote and keeps a redirect URL as Starlette sends it', () => {
    expect(pyQuote('Could not: a é/b')).toBe('Could%20not%3A%20a%20%C3%A9/b');
    expect(pyQuote('me@example.test')).toBe('me%40example.test');
    expect(pyQuote('a/b', '')).toBe('a%2Fb');
    expect(redirectLocation('/admin/jobs/a b?c?notice=x%20y')).toBe('/admin/jobs/a%20b?c?notice=x%20y');
  });
});
