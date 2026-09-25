// Port of r1cord_server/pipeline/instructions.py: INSTRUCTIONS.md for the writer CLI, a fixed
// wrapper around an editable prompt per AI review.
//
// Default prompts live here. A prompt edited on the Settings page is saved as
// `<dir of config.toml>/prompts/<kind>.md` and replaces the default until restored.

const fs = require('node:fs');
const path = require('node:path');
const { PAGE_LABELS, REVIEW_KINDS } = require('../config');
const { ValueError } = require('../errors');
const { isFile, pyInt, pyRepr, pyStrip, readText, thousands, writeText } = require('./compat');

const MAX_PROMPT_CHARS = 8_000;

const DEFAULT_PROMPTS = Object.freeze({
  summary: `Write a summary of the recording, as headings a reader can jump to from the page's Contents panel.

After the heading:
1. ## Overview: a one-paragraph abstract: what the recording is about and what came out of it.
2. ## Key points: short bullets, one idea each, the most important first. When the recording
   covers several distinct topics, group the bullets under a ### heading per topic.
3. ## Action items: a bullet list of concrete tasks, each starting with a verb. Name an owner or a
   date only when the recording does. If there are none, write "None."

Keep it concise. Use the speaker's own names for people, products and places.
`,
  outline: `Write an outline of the recording: its topics and points in the order they were discussed, as
headings a reader can jump to from the page's Contents panel.

After the heading:
- Each topic is a ## heading: a short noun phrase. Sub-topics within a topic are ### headings;
  use #### only for a further level.
- Under the lowest heading, the points made as terse bullets: fragments, not sentences; about a
  dozen words per bullet at most. Supporting detail such as numbers, names or examples goes in
  nested bullets indented by four spaces.
- Keep the order of discussion. When the speaker returns to an earlier topic, give it a new
  heading where it came up instead of moving it.
- No abstract, no commentary, no conclusions the speaker did not state.
`,
  organized: `Rewrite the recording as a clean, well-organized document that keeps ALL of its content.

After the heading:
- Group the content under clear ## headings (### where it helps), in a logical order: related
  material belongs together even when it was spoken at different times.
- Remove filler words, false starts, repetition and verbal tics ("um", "you know", "so, so").
- Keep the speaker's own wording and voice wherever possible. Fix grammar only where it gets in
  the way of reading. Keep first person if the speaker used it.
- Do not summarize or shorten: every fact, number, name, example, reason and opinion stays.
- Use paragraphs for narrative, and lists where the speaker enumerates things.
`,
});

// A prompt edit that cannot be saved (empty or too long). A ValueError, as in Python.
class PromptError extends ValueError {
  constructor(message) {
    super(message);
    this.name = 'PromptError';
  }
}

function checkKind(kind) {
  if (!REVIEW_KINDS.includes(kind)) {
    throw new ValueError(`unknown review: ${pyRepr(kind)} (expected summary, outline or organized)`);
  }
}

function promptPath(promptsDir, kind) {
  checkKind(kind);
  return path.join(String(promptsDir), `${kind}.md`);
}

function isCustom(promptsDir, kind) {
  return promptsDir !== null && promptsDir !== undefined && isFile(promptPath(promptsDir, kind));
}

// The saved override for `kind`, else the default prompt.
function loadPrompt(promptsDir, kind) {
  checkKind(kind);
  if (promptsDir !== null && promptsDir !== undefined) {
    const file = promptPath(promptsDir, kind);
    if (isFile(file)) return readText(file);
  }
  return DEFAULT_PROMPTS[kind];
}

// Store an edited prompt. Text equal to the default removes the override instead.
function savePrompt(promptsDir, kind, text) {
  checkKind(kind);
  const body = pyStrip(String(text).replace(/\r\n/g, '\n'));
  if (!body) throw new PromptError('The prompt is empty. Write the task, or use Restore default.');
  const length = Array.from(body).length;
  if (length > MAX_PROMPT_CHARS) {
    throw new PromptError(
      `The prompt is ${thousands(length)} characters; the limit is ${thousands(MAX_PROMPT_CHARS)}. Shorten it and save again.`,
    );
  }
  if (body === pyStrip(DEFAULT_PROMPTS[kind])) {
    restorePrompt(promptsDir, kind);
    return;
  }
  const file = promptPath(promptsDir, kind);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeText(file, `${body}\n`);
}

// Delete the override so the default prompt applies again.
function restorePrompt(promptsDir, kind) {
  fs.rmSync(promptPath(promptsDir, kind), { force: true });
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatCreated(metadata) {
  const raw = metadata.createdAt;
  if (raw === undefined || raw === null) return 'unknown';
  const fail = () => new ValueError(`metadata.createdAt is not epoch milliseconds: ${pyRepr(raw)}`);
  let ms;
  try {
    ms = pyInt(raw);
  } catch (_error) {
    throw fail();
  }
  const date = new Date(ms);
  // datetime covers years 1..9999 only.
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) throw fail();
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  return `${year}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())} UTC`;
}

function formatDuration(metadata) {
  const raw = metadata.durationMs;
  if (raw === undefined || raw === null) return 'unknown';
  let ms;
  try {
    ms = pyInt(raw);
  } catch (_error) {
    throw new ValueError(`metadata.durationMs is not an integer: ${pyRepr(raw)}`);
  }
  if (ms < 0) throw new ValueError(`metadata.durationMs is negative: ${ms}`);
  const seconds = Math.floor(ms / 1000);
  const sec = seconds % 60;
  const totalMinutes = Math.floor(seconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours) return `${hours}h ${pad2(minutes)}m ${pad2(sec)}s (${ms} ms)`;
  return `${minutes}m ${pad2(sec)}s (${ms} ms)`;
}

/**
 * INSTRUCTIONS.md for one review: the fixed frame around the editable `prompt`.
 *
 * The frame (output file, title heading, photos, recording facts, rules) is not editable, so a
 * prompt edit cannot break the page the server publishes.
 * @param {string} kind
 * @param {string} title
 * @param {string} prompt
 * @param {string[]} photos
 * @param {object} metadata
 * @returns {string}
 */
function buildInstructions(kind, title, prompt, photos, metadata) {
  checkKind(kind);
  const name = `${kind}.md`;
  const photoLines = photos.length
    ? [
      'Place photos inline where they are relevant, with a real caption:',
      '![caption](photos/<file>)',
      'Use only these photo files (do not invent paths):',
      ...photos.map((photo) => `- ${photo}`),
      'If a photo does not fit a point, put it near the top with a caption.',
    ]
    : ['No photos. Do not add image links.'];

  const lines = [
    `You are writing the ${PAGE_LABELS[kind]} of an R1CORD voice recording in this working folder.`,
    '',
    'Folder contents: transcript.txt (facts), transcript.json, metadata.json, photos/, this file.',
    `Write ONLY ${name} in the current working directory. Do not write any other file.`,
    '',
    `${name} must start with a heading: # ${title}`,
    'Everything after the heading follows the task below.',
    '',
    '## Task',
    '',
    pyStrip(prompt),
    '',
    '## Photos',
    '',
    ...photoLines,
    '',
    '## Recording',
    '',
    `- title: ${title}`,
    `- date: ${formatCreated(metadata)}`,
    `- duration: ${formatDuration(metadata)}`,
    '',
    '## Rules (always apply, whatever the task says)',
    '',
    '- Do not invent facts. Use only the transcript, metadata, and listed photos.',
    '- Do not invent photo paths. Use only files listed above.',
    '- Do not append the transcript. No transcript appendix.',
    `- Keep the heading of ${name} as described above.`,
  ];
  return `${lines.join('\n')}\n`;
}

module.exports = {
  DEFAULT_PROMPTS,
  MAX_PROMPT_CHARS,
  PromptError,
  buildInstructions,
  isCustom,
  loadPrompt,
  promptPath,
  restorePrompt,
  savePrompt,
};
