// Port of tests/test_mailer.py: one Vitest case per pytest function (gws stubbed), plus one real
// send through an npm-style gws.cmd shim.
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { defaultConfig, withUpdates } = require('../../src/core/config');
const { JobStore } = require('../../src/core/store');
const { MAX_RAW_CHARS, MailError, compose, emailJob, gwsExecutable, raw, send } = require('../../src/core/mailer');
const { writeText } = require('../../src/core/pipeline/compat');

const PAGE = 'https://example.test/files/2026/09/rec/summary.html';
const PAGES = [
  { kind: 'transcript', url: 'https://example.test/files/2026/09/rec/transcript.html' },
  { kind: 'summary', url: PAGE },
];
const JOB = 'http://127.0.0.1:8765/admin/jobs/j1';

const cleanup = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()();
});

function tmpPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-mailer-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function parts(msg) {
  return Object.fromEntries(msg.parts.map((part) => [part.type, part.text]));
}

function cfg(tmp, overrides = {}) {
  return withUpdates(defaultConfig(), { datastore: path.join(tmp, 'ds'), webdav_folder: path.join(tmp, 'wd'), ...overrides });
}

function fakeGws(tmp) {
  const exe = path.join(tmp, 'gws.exe');
  fs.writeFileSync(exe, '');
  return exe;
}

// The message as it goes over the wire, decoded from the base64url `raw`.
function wire(rawText) {
  return Buffer.from(rawText, 'base64url').toString('utf8');
}

// RFC 2047 encoded words back to text, after unfolding.
function decodeHeader(mail, name) {
  const match = new RegExp(`^${name}: (.*(?:\\r\\n[ \\t].*)*)`, 'm').exec(mail);
  const value = match[1].replace(/\r\n[ \t]/g, ' ');
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_whole, kind, data) => {
      if (kind.toLowerCase() === 'b') return Buffer.from(data, 'base64').toString('utf8');
      const bytes = data.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
      return Buffer.from(bytes, 'latin1').toString('utf8');
    });
}

function sentMail(sent) {
  const argv = sent.at(-1);
  return wire(JSON.parse(argv[argv.indexOf('--json') + 1]).raw);
}

function storeWithOneJob(tmp) {
  const exe = fakeGws(tmp);
  const config = cfg(tmp, { email_to: 'me@example.test', gws_cmd: exe });
  const store = new JobStore(config);
  cleanup.push(() => store.close());
  const src = path.join(tmp, 'src', 'rec-1');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'audio.wav'), '0123456789abcdef');
  fs.writeFileSync(path.join(src, 'metadata.json'), JSON.stringify({ id: 'rec-1', title: 'Kickoff', createdAt: 1_758_400_000_000 }));
  const rec = store.importFolder(src, { title: 'Kickoff', reviews: ['summary'], publish: false });
  return { store, config, jobId: rec.jobId };
}

describe('mailer', () => {
  it('compose renders the review with its photos as captions and links to every page', () => {
    const summary = '[brand-header]\n# Site visit\n\nAbstract.\n\n![Gate](photos/photo-1.jpg)\n\n- point\n';
    const msg = compose({ to: 'me@example.test', title: 'Site visit', reviewMd: summary, transcript: 't', pages: PAGES, jobUrl: JOB });
    const p = parts(msg);
    expect(decodeHeader(wire(raw(msg)), 'Subject')).toBe('Site visit');
    expect(p['text/plain']).not.toContain('[brand-header]');
    const html = p['text/html'];
    expect(html).not.toContain('[brand-header]');
    expect(html).toContain('Abstract.');
    expect(html).toContain('<li>point</li>');
    expect(html).not.toContain('<img'); // photos only resolve on the published page
    expect(html).toContain('Gate');
    expect(html).toContain(`href="${PAGE}"`);
    expect(html).toContain(`href="${JOB}"`);
    expect(html).toContain(`href="${PAGES[0].url}"`); // every published page is linked
    expect(p['text/plain']).toContain('Transcript page: ');
    expect(p['text/plain']).toContain('Summary page: ');
  });

  it('compose without a page drops photos and falls back to the transcript', () => {
    const msg = compose({ to: 'me@example.test', title: 'T', reviewMd: null, transcript: 'Hello there.', pages: [], jobUrl: JOB });
    const p = parts(msg);
    expect(p['text/plain']).toContain('Hello there.');
    expect(p['text/plain']).not.toContain(' page: ');
    expect(() => compose({ to: 'me@example.test', title: 'T', reviewMd: null, transcript: null, pages: [], jobUrl: JOB })).toThrow(MailError);
  });

  it('compose shrinks to fit the command line', () => {
    // Big enough that HTML + text overflow, but text alone fits: the HTML part is dropped.
    const medium = 'word '.repeat(3200);
    let msg = compose({ to: 'me@example.test', title: 'T', reviewMd: medium, transcript: null, pages: PAGES, jobUrl: JOB });
    expect(Object.keys(parts(msg))).toEqual(['text/plain']);
    expect(raw(msg).length).toBeLessThanOrEqual(MAX_RAW_CHARS);
    // Too big even as text: truncated with a pointer to the page, links kept.
    const huge = 'word '.repeat(20000);
    msg = compose({ to: 'me@example.test', title: 'T', reviewMd: huge, transcript: null, pages: PAGES, jobUrl: JOB });
    const text = parts(msg)['text/plain'];
    expect(raw(msg).length).toBeLessThanOrEqual(MAX_RAW_CHARS);
    expect(text).toContain('[Truncated to fit the email.');
    expect(text).toContain(PAGE);
  });

  it('send returns the Gmail id and surfaces gws errors', async () => {
    const tmp = tmpPath();
    const exe = fakeGws(tmp);
    const config = cfg(tmp, { gws_cmd: exe });
    const msg = compose({ to: 'me@example.test', title: 'T', reviewMd: 'Hi', transcript: null, pages: [], jobUrl: JOB });
    const calls = [];
    const ok = async (argv) => {
      calls.push(argv);
      return { returncode: 0, stdout: '{\n  "id": "abc123",\n  "labelIds": ["SENT"]\n}', stderr: 'Using keyring backend: keyring' };
    };

    expect(await send(config, msg, { run: ok })).toBe('abc123');
    expect(calls[0].slice(0, 5)).toEqual([exe, 'gmail', 'users', 'messages', 'send']);
    const refused = async () => ({ returncode: 1, stdout: '{"error": {"code": 403, "message": "Insufficient Permission"}}', stderr: '' });
    await expect(send(config, msg, { run: refused })).rejects.toThrow(/Insufficient Permission/);
  });

  it('gwsExecutable resolves shims and plain exes and reports a missing one', () => {
    const tmp = tmpPath();
    // A .cmd shim hides a native binary one level deeper; that binary is preferred.
    const shim = path.join(tmp, 'gws.cmd');
    fs.writeFileSync(shim, '@echo off\n');
    const native = path.join(tmp, 'node_modules', '@googleworkspace', 'cli', 'node_modules', '.bin_real', 'gws.exe');
    fs.mkdirSync(path.dirname(native), { recursive: true });
    fs.writeFileSync(native, '');
    expect(gwsExecutable(shim)).toBe(native);

    // A shim with no native binary beside it stays the shim (still runs, just capped).
    const lonely = path.join(tmp, 'solo', 'gws.cmd');
    fs.mkdirSync(path.dirname(lonely));
    fs.writeFileSync(lonely, '@echo off\n');
    expect(gwsExecutable(lonely)).toBe(lonely);

    const exe = fakeGws(tmp);
    expect(gwsExecutable(exe)).toBe(exe);
    expect(gwsExecutable(path.join(tmp, 'missing', 'gws.exe'))).toBeNull();
  });

  it('a unicode subject and recipient survive the wire', () => {
    const title = 'Standup — naïve café ✓';
    const msg = compose({ to: 'üser@example.test', title, reviewMd: 'x', transcript: null, pages: [], jobUrl: JOB });
    expect(/^[\x00-\x7f]*$/.test(raw(msg))).toBe(true); // the base64 payload of an SMTP-serialised message must be
    const mail = wire(raw(msg));
    expect(/^[\x00-\x7f]*$/.test(mail.split('\r\n\r\n')[0])).toBe(true); // headers are ASCII on the wire
    expect(decodeHeader(mail, 'Subject')).toBe(title);
    expect(decodeHeader(mail, 'To')).toBe('üser@example.test');
  });

  it('raw HTML in the summary shows as text, never as tags', () => {
    const summary = '# Notes\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\nAT&T <b>bold</b>\n\n> a quote\n\n![Gate](photos/photo-1.jpg)\n';
    const msg = compose({ to: 'me@example.test', title: 'T', reviewMd: summary, transcript: null, pages: PAGES, jobUrl: JOB });
    const p = parts(msg);
    const html = p['text/html'];
    for (const tag of ['<script>', '<img src=x', '<b>bold</b>']) expect(html).not.toContain(tag);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('AT&amp;T'); // a bare & became an entity
    expect(html).toContain('<blockquote>'); // markdown blockquotes still work
    expect(html).toContain('a quote');
    expect(html).not.toContain('<img'); // a markdown image is its caption, never a tag
    expect(html).toContain('Gate');
    // the plain-text twin keeps the literal source
    expect(p['text/plain']).toContain('<script>alert(1)</script>');
  });

  it('a send that times out becomes a MailError', async () => {
    const tmp = tmpPath();
    const config = cfg(tmp, { gws_cmd: fakeGws(tmp) });
    const msg = compose({ to: 'me@example.test', title: 'T', reviewMd: 'Hi', transcript: null, pages: [], jobUrl: JOB });
    const hang = async () => {
      throw Object.assign(new Error('timed out after 90s'), { timedOut: true });
    };
    await expect(send(config, msg, { run: hang })).rejects.toThrow(/timed out after 90s/);
    await expect(send(config, msg, { run: hang })).rejects.toThrow(MailError);
  });

  it('emailJob refuses a blank recipient and unknown jobs', async () => {
    const { store, config, jobId } = storeWithOneJob(tmpPath());
    await expect(emailJob(store, withUpdates(config, { email_to: '   ' }), jobId)).rejects.toThrow(/no recipient/);
    await expect(emailJob(store, config, 'ghost')).rejects.toThrow(/unknown job ghost/);
  });

  it('emailJob without a review sends the transcript and logs it', async () => {
    const { store, config, jobId } = storeWithOneJob(tmpPath());
    writeText(path.join(store.outboxDir('rec-1'), 'transcript.txt'), 'hello from the transcript');
    const sent = [];
    const ok = async (argv) => {
      sent.push(argv);
      return { returncode: 0, stdout: '{"id": "mid-7"}', stderr: '' };
    };

    expect(await emailJob(store, config, jobId, { run: ok })).toBe('mid-7');
    const mail = sentMail(sent);
    expect(mail).toContain('hello from the transcript'); // the transcript became the body
    expect(mail).toContain('Subject: Kickoff');
    expect(store.readLog(jobId).some((line) => line.includes('email: sent to me@example.test (mid-7)'))).toBe(true);
  });

  it('emailJob prefers summary, then organized, then outline', async () => {
    const { store, config, jobId } = storeWithOneJob(tmpPath());
    const outbox = store.outboxDir('rec-1');
    writeText(path.join(outbox, 'transcript.txt'), 'raw words');
    const sent = [];
    const ok = async (argv) => {
      sent.push(argv);
      return { returncode: 0, stdout: '{"id": "mid-8"}', stderr: '' };
    };

    writeText(path.join(outbox, 'outline.md'), '[brand-header]\n# K\n\n- outline point\n');
    await emailJob(store, config, jobId, { run: ok });
    expect(sentMail(sent)).toContain('outline point');
    expect(sentMail(sent)).not.toContain('raw words');
    writeText(path.join(outbox, 'organized.md'), '[brand-header]\n# K\n\norganized prose\n');
    await emailJob(store, config, jobId, { run: ok });
    expect(sentMail(sent)).toContain('organized prose');
    expect(sentMail(sent)).not.toContain('outline point');
    writeText(path.join(outbox, 'summary.md'), '[brand-header]\n# K\n\nthe abstract\n');
    await emailJob(store, config, jobId, { run: ok });
    expect(sentMail(sent)).toContain('the abstract');
    expect(sentMail(sent)).not.toContain('organized prose');
  });

  // --- Node-only ------------------------------------------------------------------------------

  it.skipIf(process.platform !== 'win32')('sends through a gws.cmd shim with the message intact', async () => {
    // No native gws.exe beside the shim: the shim's node script runs, and gets the full --json.
    const tmp = tmpPath();
    const pkg = path.join(tmp, 'npm', 'node_modules', '@googleworkspace', 'cli');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'run-gws.js'),
      "const a = process.argv.slice(2); const raw = JSON.parse(a[a.indexOf('--json') + 1]).raw;" +
        "console.log(JSON.stringify({ id: Buffer.from(raw, 'base64url').toString('utf8').includes('the & body') ? 'ok-' + a[0] : 'bad' }));",
    );
    const shim = path.join(tmp, 'npm', 'gws.cmd');
    fs.writeFileSync(
      shim,
      [
        '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
        'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
        '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@googleworkspace\\cli\\run-gws.js" %*',
        '',
      ].join('\r\n'),
    );
    const msg = compose({ to: 'me@example.test', title: 'T', reviewMd: 'the & body', transcript: null, pages: [], jobUrl: JOB });
    expect(await send(cfg(tmp, { gws_cmd: shim }), msg)).toBe('ok-gmail');
  });
});
