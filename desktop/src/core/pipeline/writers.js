// Port of r1cord_server/pipeline/writers.py: Claude Code / Codex / Grok Build adapters, `<kind>.md`
// validation, and the transcript page.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cli = require('../cli');
const { PY_SPACE, isFile, pySplit, pySplitlines, pyStrRepr, pyStrip, readText, platformText, writeText } = require('./compat');

const PROMPT = 'Read INSTRUCTIONS.md in this folder and do exactly what it says.';

const IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

// Writer CLI failed, timed out, or `<kind>.md` is missing/invalid.
class WriterError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WriterError';
  }
}

/**
 * The writer binary for a configured command: shutil.which, then on Windows the .cmd/.exe/.bat
 * shims npm and friends install.
 * @param {string} cmd
 * @param {{platform?: string, which?: Function}} [options]
 * @returns {string}
 */
function resolveCmd(cmd, { platform = process.platform, which = cli.which } = {}) {
  let found = which(cmd);
  if (found) return found;
  if (platform === 'win32') {
    const ext = path.win32.extname(cmd);
    const stem = ext ? cmd.slice(0, -ext.length) : cmd;
    const shims = !ext ? ['.cmd', '.exe', '.bat'] : ['.cmd', '.exe', '.bat'].includes(ext.toLowerCase()) ? [] : ['.cmd', '.exe'];
    for (const shim of shims) {
      found = which((ext ? stem : cmd) + shim);
      if (found) return found;
    }
  }
  throw new WriterError(`writer binary not found: ${cmd}`);
}

function tailWriterLog(workDir, n = 20) {
  const file = path.join(workDir, 'writer.log');
  if (!isFile(file)) return '';
  const lines = pySplitlines(readText(file, { errors: 'replace' }));
  return lines.slice(-n).join('\n');
}

function withTail(message, workDir) {
  const tail = tailWriterLog(workDir);
  return tail ? `${message}\n${tail}` : message;
}

// Path.resolve(): the real path of the longest existing prefix, lexical for the rest.
function resolvePath(target) {
  const absolute = path.resolve(target);
  let existing = absolute;
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(existing), ...rest);
    } catch (_error) {
      const parent = path.dirname(existing);
      if (parent === existing) return absolute;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

function isInside(root, candidate) {
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = path.relative(norm(root), norm(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function imageTargetPath(workDir, target) {
  let t = pyStrip(target);
  if (t.startsWith('<') && t.endsWith('>')) t = pyStrip(t.slice(1, -1));
  if (!t) return null;
  // Drop an optional title after the path.
  if (t[0] === '"' || t[0] === "'") {
    const end = t.indexOf(t[0], 1);
    t = end !== -1 ? t.slice(1, end) : t.slice(1);
  } else {
    t = pySplit(t)[0];
  }
  t = t.replace(/\\/g, '/');
  if (t.startsWith('./')) t = t.slice(2);
  const photos = resolvePath(path.join(workDir, 'photos'));
  const candidate = resolvePath(path.resolve(workDir, t));
  return isInside(photos, candidate) ? candidate : null;
}

/**
 * Require a non-empty `<kind>.md`; rewrite image links that do not resolve to a listed photo.
 * @param {string} workDir
 * @param {string} kind
 * @param {(line: string) => void} log
 * @returns {string} the review's path
 */
function validateReview(workDir, kind, log) {
  const name = `${kind}.md`;
  const file = path.join(workDir, name);
  if (!isFile(file)) throw new WriterError(withTail(`${name} missing at ${file}`, workDir));
  const raw = readText(file);
  if (!pyStrip(raw)) throw new WriterError(withTail(`${name} is empty at ${file}`, workDir));

  const rewritten = raw.replace(IMAGE_RE, (whole, alt, target) => {
    const resolved = imageTargetPath(workDir, target);
    if (resolved !== null && isFile(resolved)) return whole;
    log(`broken image link rewritten: ![${alt}](${target}) -> *${alt}*`);
    return `*${alt}*`;
  });
  if (rewritten !== raw) writeText(file, rewritten);
  return file;
}

// Path.resolve().as_posix() for grok, whose parser strips backslashes.
function posixResolved(target) {
  return resolvePath(target).replace(/\\/g, '/');
}

/**
 * The argv for one writer run in `workDir`.
 * @param {string} writer claude_code | codex | grok_build
 * @param {string} workDir
 * @param {{claude_cmd: string, codex_cmd: string, grok_cmd: string}} config
 * @param {{resolveCmd?: Function}} [options]
 * @returns {string[]}
 */
function argvFor(writer, workDir, config, { resolveCmd: resolve = resolveCmd } = {}) {
  if (writer === 'claude_code') {
    return [
      resolve(config.claude_cmd),
      '-p',
      PROMPT,
      '--add-dir',
      workDir,
      '--allowedTools',
      'Read,Write,Edit,Glob,Grep',
      '--permission-mode',
      'acceptEdits',
    ];
  }
  if (writer === 'codex') {
    return [resolve(config.codex_cmd), 'exec', '-C', workDir, '--sandbox', 'workspace-write', '--skip-git-repo-check', PROMPT];
  }
  if (writer === 'grok_build') {
    const bin = resolve(config.grok_cmd);
    const promptFile = path.join(workDir, 'prompt.txt');
    writeText(promptFile, `${PROMPT}\n`);
    return [
      bin,
      '--prompt-file',
      posixResolved(promptFile),
      '--cwd',
      posixResolved(workDir),
      '--permission-mode',
      'bypassPermissions',
      '--disable-web-search',
      '--no-subagents',
      '--max-turns',
      '40',
    ];
  }
  throw new WriterError(`unknown writer: ${pyStrRepr(writer)} (expected claude_code|codex|grok_build)`);
}

function exitCode(code, signal) {
  if (code !== null) return code;
  const number = signal ? os.constants.signals[signal] : undefined;
  return number ? -number : -1;
}

/**
 * Run the writer CLI in `workDir` (holding that review's INSTRUCTIONS.md) and return the validated
 * `<kind>.md` path. Output goes to `writer.log`; a timeout or abort kills the whole process tree.
 * @param {string} workDir
 * @param {{kind: string, writer: string, timeoutS: number, config: object, log: (line: string) => void,
 *   signal?: AbortSignal, argvFor?: Function}} options
 * @returns {Promise<string>}
 */
async function runWriter(workDir, { kind, writer, timeoutS, config, log, signal = null, argvFor: makeArgv = argvFor }) {
  fs.mkdirSync(workDir, { recursive: true });
  const argv = makeArgv(writer, workDir, config);
  const logPath = path.join(workDir, 'writer.log');
  const argvLine = `argv: [${argv.map(pyStrRepr).join(', ')}]`;
  log(argvLine);
  const fd = fs.openSync(logPath, 'a');
  let outcome;
  try {
    fs.writeSync(fd, platformText(`${argvLine}\n`));
    outcome = await waitForChild(cli.spawn(argv, { cwd: workDir, stdio: ['ignore', fd, fd] }), timeoutS, signal);
  } finally {
    fs.closeSync(fd);
  }
  if (outcome.aborted) throw signal.reason instanceof Error ? signal.reason : new WriterError(`writer ${writer} was stopped`);
  if (outcome.timedOut) throw new WriterError(withTail(`writer ${writer} timed out after ${timeoutS}s`, workDir));
  if (outcome.rc !== 0) throw new WriterError(withTail(`writer ${writer} exited ${outcome.rc}`, workDir));
  return validateReview(workDir, kind, log);
}

// Wait for the child; on timeout or abort kill its tree and wait up to 10 s for it to go.
function waitForChild(child, timeoutS, signal) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let aborted = false;
    let exited = false;
    let killTimer;
    const kill = () => {
      cli.killTree(child).then(() => {
        if (!exited) killTimer = setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutS * 1000);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const done = () => {
      exited = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    child.once('error', (error) => {
      done();
      reject(error);
    });
    child.once('exit', (code, sig) => {
      done();
      resolve({ rc: exitCode(code, sig), timedOut, aborted });
    });
  });
}

const MD_SPECIAL = /([\\`*_[\]<>#|])/g;
// `^` of a MULTILINE Python pattern: the start of the text or right after '\n' (not '\r').
const MD_LINE_START = new RegExp(`(?<![^\\n])([${PY_SPACE}]*)(?:([-+])|(\\p{Nd}+)([.)]))(?=[${PY_SPACE}]|$)`, 'gu');

// Spoken words, not Markdown: keep a transcript line from turning into a heading, list, quote,
// link or tag when the page is rendered.
function escapeMarkdown(text) {
  const special = text.replace(MD_SPECIAL, '\\$1');
  return special.replace(MD_LINE_START, (_whole, lead, bullet, digits, mark) => (bullet ? `${lead}\\${bullet}` : `${lead}${digits}\\${mark}`));
}

/**
 * The transcript page source: `# title`, a date · duration line, then the transcript's paragraphs.
 * @param {string} title
 * @param {string} when
 * @param {string} transcript
 * @returns {string}
 */
function transcriptMarkdown(title, when, transcript) {
  const paragraphs = transcript
    .replace(/\r\n/g, '\n')
    .split('\n\n')
    .map(pyStrip)
    .filter(Boolean);
  const body = paragraphs.map(escapeMarkdown).join('\n\n');
  const parts = [`# ${title}`, ''];
  if (when) parts.push(`*${when}*`, '');
  parts.push(body || '*No speech was recognized.*');
  return `${parts.join('\n')}\n`;
}

module.exports = {
  PROMPT,
  WriterError,
  argvFor,
  resolveCmd,
  runWriter,
  transcriptMarkdown,
  validateReview,
};
