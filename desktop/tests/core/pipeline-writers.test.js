// Port of tests/test_writers.py: one Vitest case per pytest function, plus the Node-only cases the
// port adds (abort, npm .cmd shims).
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { renderFragment } = require('../../src/core/render');
const {
  PROMPT,
  WriterError,
  argvFor,
  resolveCmd,
  runWriter,
  transcriptMarkdown,
  validateReview,
} = require('../../src/core/pipeline/writers');
const { writeText } = require('../../src/core/pipeline/compat');

const CFG = { claude_cmd: 'claude', codex_cmd: 'codex', grok_cmd: 'grok' };

const cleanup = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()();
});

function tmpPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-writers-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function workDir() {
  const work = path.join(tmpPath(), 'work');
  fs.mkdirSync(work);
  return work;
}

// A writer that is node running `script` in the work dir.
function nodeWriter(script) {
  return () => [process.execPath, '-e', script];
}

describe('writers', () => {
  it('broken image link is rewritten to italic alt and logged', () => {
    const tmp = tmpPath();
    fs.mkdirSync(path.join(tmp, 'photos'));
    fs.writeFileSync(path.join(tmp, 'photos', 'ok.jpg'), 'jpeg');
    writeText(
      path.join(tmp, 'summary.md'),
      '# Visit\n\n![good shot](photos/ok.jpg)\n![also good](./photos/ok.jpg)\n![missing photo](photos/nope.jpg)\n',
    );
    const lines = [];
    const out = validateReview(tmp, 'summary', (line) => lines.push(line));
    const text = fs.readFileSync(out, 'utf8');
    expect(text).toContain('![good shot](photos/ok.jpg)');
    expect(text).toContain('![also good](./photos/ok.jpg)');
    expect(text).not.toContain('![missing photo](photos/nope.jpg)');
    expect(text).toContain('*missing photo*');
    expect(lines.some((line) => line.includes('photos/nope.jpg') && line.includes('missing photo'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'photos', 'ok.jpg'))).toBe(true);
  });

  it('missing or empty review raises WriterError', () => {
    const tmp = tmpPath();
    expect(() => validateReview(tmp, 'summary', () => {})).toThrow(WriterError);
    fs.writeFileSync(path.join(tmp, 'summary.md'), '');
    expect(() => validateReview(tmp, 'summary', () => {})).toThrow(WriterError);
    fs.writeFileSync(path.join(tmp, 'summary.md'), ' \n\t\n');
    expect(() => validateReview(tmp, 'summary', () => {})).toThrow(WriterError);
  });

  it('a valid review is left byte for byte untouched', () => {
    const tmp = tmpPath();
    fs.mkdirSync(path.join(tmp, 'photos'));
    fs.writeFileSync(path.join(tmp, 'photos', 'p1.jpg'), 'jpeg');
    writeText(path.join(tmp, 'summary.md'), '# Title\n\n![p](photos/p1.jpg)\n'); // no [brand-header]: nothing is added
    const before = fs.readFileSync(path.join(tmp, 'summary.md'));

    const lines = [];
    validateReview(tmp, 'summary', (line) => lines.push(line));

    expect(fs.readFileSync(path.join(tmp, 'summary.md')).equals(before)).toBe(true);
    expect(lines).toEqual([]);
  });

  it('an image pointing outside photos/ is rewritten', () => {
    const tmp = tmpPath();
    fs.mkdirSync(path.join(tmp, 'photos'));
    fs.mkdirSync(path.join(tmp, 'other'));
    fs.writeFileSync(path.join(tmp, 'other', 'escape.jpg'), 'jpeg');
    writeText(path.join(tmp, 'summary.md'), '# T\n\n![escape](../other/escape.jpg)\n');
    validateReview(tmp, 'summary', () => {});
    const text = fs.readFileSync(path.join(tmp, 'summary.md'), 'utf8');
    expect(text).not.toContain('../other/escape.jpg');
    expect(text).toContain('*escape*');
  });

  it('argv for each writer', () => {
    const resolved = {};
    const fakeResolve = (cmd) => {
      resolved[cmd] = `C:/bin/${cmd}.exe`;
      return resolved[cmd];
    };
    const work = workDir();

    expect(argvFor('claude_code', work, CFG, { resolveCmd: fakeResolve })).toEqual([
      'C:/bin/claude.exe', '-p', PROMPT, '--add-dir', work,
      '--allowedTools', 'Read,Write,Edit,Glob,Grep', '--permission-mode', 'acceptEdits',
    ]);
    expect(argvFor('codex', work, CFG, { resolveCmd: fakeResolve })).toEqual([
      'C:/bin/codex.exe', 'exec', '-C', work, '--sandbox', 'workspace-write', '--skip-git-repo-check', PROMPT,
    ]);

    const grok = argvFor('grok_build', work, CFG, { resolveCmd: fakeResolve });
    const posix = (p) => fs.realpathSync.native(p).replace(/\\/g, '/');
    expect(grok[0]).toBe('C:/bin/grok.exe');
    expect(grok.slice(1)).toEqual([
      '--prompt-file', posix(path.join(work, 'prompt.txt')),
      '--cwd', posix(work),
      '--permission-mode', 'bypassPermissions',
      '--disable-web-search', '--no-subagents', '--max-turns', '40',
    ]);
    // grok_build receives its prompt through a file written into the work dir
    expect(fs.readFileSync(path.join(work, 'prompt.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe(`${PROMPT}\n`);

    expect(() => argvFor('typewriter', work, CFG, { resolveCmd: fakeResolve })).toThrow(/unknown writer/);
  });

  it('resolveCmd reports a missing binary', () => {
    expect(() => resolveCmd('ghost-writer', { platform: 'win32', which: () => null })).toThrow(WriterError);
    expect(() => resolveCmd('ghost-writer', { platform: 'win32', which: () => null })).toThrow(
      'writer binary not found: ghost-writer',
    );
  });

  it('resolveCmd appends Windows shims', () => {
    const onPath = { 'claude.cmd': 'C:/shims/claude.cmd', 'weird.cmd': 'C:/shims/weird.cmd' };
    const which = (cmd) => onPath[cmd] || null;

    expect(resolveCmd('claude', { platform: 'win32', which })).toBe('C:/shims/claude.cmd');
    // A non-executable extension is stripped and the .cmd/.exe shims are tried.
    expect(resolveCmd('weird.sh', { platform: 'win32', which })).toBe('C:/shims/weird.cmd');
  });

  it('runWriter runs the command and returns the validated review', async () => {
    const work = workDir();
    const lines = [];
    const out = await runWriter(work, {
      kind: 'organized',
      writer: 'codex',
      timeoutS: 60,
      config: CFG,
      log: (line) => lines.push(line),
      argvFor: nodeWriter("require('fs').writeFileSync('organized.md', '# Title\\n\\nbody\\n')"),
    });

    expect(out).toBe(path.join(work, 'organized.md'));
    expect(fs.readFileSync(out, 'utf8')).toBe('# Title\n\nbody\n');
    expect(fs.readFileSync(path.join(work, 'writer.log'), 'utf8').startsWith('argv: ')).toBe(true);
    expect(lines.some((line) => line.startsWith('argv: '))).toBe(true);
  });

  it('a nonzero exit reports the code and the log tail', async () => {
    const work = workDir();
    const run = runWriter(work, {
      kind: 'summary',
      writer: 'codex',
      timeoutS: 60,
      config: CFG,
      log: () => {},
      argvFor: nodeWriter("console.log('model gave up'); process.exit(3)"),
    });
    await expect(run).rejects.toThrow(WriterError);
    await expect(run).rejects.toThrow(/writer codex exited 3[\s\S]*model gave up/);
  });

  it('a timeout kills the process and reports', async () => {
    const work = workDir();
    const marker = path.join(work, 'late.txt');
    const run = runWriter(work, {
      kind: 'summary',
      writer: 'grok_build',
      timeoutS: 1,
      config: CFG,
      log: () => {},
      argvFor: nodeWriter(`setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 3000)`),
    });
    await expect(run).rejects.toThrow('timed out after 1s');
    // no summary was produced and no partial state is kept beyond the log
    expect(fs.existsSync(path.join(work, 'summary.md'))).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(fs.existsSync(marker)).toBe(false); // the child was killed, not left running
  }, 10_000);

  it('review validation names the kind', () => {
    const tmp = tmpPath();
    fs.writeFileSync(path.join(tmp, 'summary.md'), '# Not this one\n');
    expect(() => validateReview(tmp, 'outline', () => {})).toThrow(/outline\.md missing/);
  });

  it('transcript markdown keeps spoken words literal', () => {
    const text = transcriptMarkdown(
      'Standup',
      '2025-09-20 10:13 · 2:05',
      '# not a heading, *not bold* <b>x</b>\n1. not a list\n\n- nor this [link](x)\n',
    );
    const lines = text.split('\n');
    expect(lines.slice(0, 3)).toEqual(['# Standup', '', '*2025-09-20 10:13 · 2:05*']);
    expect(text).toContain('\\# not a heading, \\*not bold\\* \\<b\\>x\\</b\\>');
    expect(text).toContain('1\\. not a list');
    expect(text).toContain('\\- nor this \\[link\\](x)');

    const html = renderFragment(text); // the pages' Markdown rules
    expect(html.split('<h1').length - 1).toBe(1); // only the title
    for (const tag of ['<ol', '<ul', '<a ', '<b>']) expect(html).not.toContain(tag);
  });

  // --- Node-only ------------------------------------------------------------------------------

  it('an abort kills the writer and rejects with the abort reason', async () => {
    const work = workDir();
    const marker = path.join(work, 'late.txt');
    const controller = new AbortController();
    const run = runWriter(work, {
      kind: 'summary',
      writer: 'codex',
      timeoutS: 60,
      config: CFG,
      log: () => {},
      signal: controller.signal,
      argvFor: nodeWriter(`setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 2000)`),
    });
    const reason = new Error('stopping');
    setTimeout(() => controller.abort(reason), 300);
    await expect(run).rejects.toBe(reason);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(fs.existsSync(marker)).toBe(false);
  }, 10_000);

  it.skipIf(process.platform !== 'win32')('an npm .cmd shim on the writer command runs with its arguments intact', async () => {
    // npm installs `codex.cmd` running `node <pkg>\bin\codex.js %*`; Node cannot spawn a .cmd itself.
    const npm = path.join(tmpPath(), 'npm dir');
    const pkg = path.join(npm, 'node_modules', 'fake-writer');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'cli.js'),
      "require('fs').writeFileSync('summary.md', '# T\\n\\n' + JSON.stringify(process.argv.slice(2)) + '\\n')",
    );
    fs.writeFileSync(
      path.join(npm, 'fakewriter.cmd'),
      [
        '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
        'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
        '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-writer\\cli.js" %*',
        '',
      ].join('\r\n'),
    );
    const work = workDir();
    const out = await runWriter(work, {
      kind: 'summary',
      writer: 'codex',
      timeoutS: 60,
      config: { ...CFG, codex_cmd: path.join(npm, 'fakewriter') },
      log: () => {},
    });
    const args = JSON.parse(fs.readFileSync(out, 'utf8').split('\n')[2]);
    expect(args).toEqual(['exec', '-C', work, '--sandbox', 'workspace-write', '--skip-git-repo-check', PROMPT]);
  });
});
