// Port of tests/test_instructions.py: one Vitest case per pytest function.
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ValueError } = require('../../src/core/errors');
const {
  DEFAULT_PROMPTS,
  MAX_PROMPT_CHARS,
  PromptError,
  buildInstructions,
  isCustom,
  loadPrompt,
  restorePrompt,
  savePrompt,
} = require('../../src/core/pipeline/instructions');

const cleanup = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()();
});

function tmpPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-instructions-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('instructions', () => {
  it('instructions frame the prompt for that kind', () => {
    const photos = ['photo-abc123.jpg', 'photo-def456.jpg', 'photo-ghi789.jpg'];
    const text = buildInstructions('outline', 'Site visit', 'List every topic.', photos, {
      createdAt: 1758400000000,
      durationMs: 125000,
    });
    for (const name of photos) expect(text).toContain(`- ${name}`);
    expect(text).toContain('Write ONLY outline.md');
    expect(text).toContain('# Site visit');
    expect(text).not.toContain('brand-header'); // the page header is the renderer's, never the writer's
    expect(text).toContain('List every topic.');
    expect(text).toContain('No transcript appendix.');
    // The fixed rules come after the editable task, so a prompt cannot talk its way past them.
    expect(text.indexOf('List every topic.')).toBeLessThan(text.indexOf('Do not invent facts.'));
  });

  it('unknown kind is rejected', () => {
    expect(() => buildInstructions('poem', 'T', 'x', [], {})).toThrow(ValueError);
    expect(() => buildInstructions('poem', 'T', 'x', [], {})).toThrow(/unknown review/);
  });

  it('no photos forbids image links', () => {
    const text = buildInstructions('summary', 'Road trip', DEFAULT_PROMPTS.summary, [], {});
    expect(text).toContain('No photos. Do not add image links.');
    expect(text).toContain('- title: Road trip');
  });

  it('date and duration formatting', () => {
    const text = buildInstructions('summary', 'T', 'x', [], { createdAt: 0, durationMs: 125_000 });
    expect(text).toContain('- date: 1970-01-01 00:00 UTC');
    expect(text).toContain('- duration: 2m 05s (125000 ms)');

    const long = buildInstructions('summary', 'T', 'x', [], { createdAt: 0, durationMs: 3_725_000 });
    expect(long).toContain('- duration: 1h 02m 05s (3725000 ms)');
  });

  it('missing metadata renders unknown and bad values raise', () => {
    const text = buildInstructions('summary', 'T', 'x', [], {});
    expect(text).toContain('- date: unknown');
    expect(text).toContain('- duration: unknown');

    expect(() => buildInstructions('summary', 'T', 'x', [], { createdAt: 'yesterday' })).toThrow(/createdAt/);
    expect(() => buildInstructions('summary', 'T', 'x', [], { durationMs: 'forever' })).toThrow(/durationMs/);
    expect(() => buildInstructions('summary', 'T', 'x', [], { durationMs: -1 })).toThrow(/negative/);
  });

  it('prompt override save, load and restore', () => {
    const prompts = path.join(tmpPath(), 'prompts');
    expect(loadPrompt(prompts, 'organized')).toBe(DEFAULT_PROMPTS.organized);
    expect(loadPrompt(null, 'organized')).toBe(DEFAULT_PROMPTS.organized);

    savePrompt(prompts, 'organized', 'Keep it all.\r\nEvery word.\r\n');
    expect(isCustom(prompts, 'organized')).toBe(true);
    expect(loadPrompt(prompts, 'organized')).toBe('Keep it all.\nEvery word.\n');
    expect(loadPrompt(prompts, 'summary')).toBe(DEFAULT_PROMPTS.summary); // other kinds untouched

    restorePrompt(prompts, 'organized');
    expect(isCustom(prompts, 'organized')).toBe(false);
    restorePrompt(prompts, 'organized'); // restoring a default is harmless

    savePrompt(prompts, 'outline', DEFAULT_PROMPTS.outline); // saving the default is not an override
    expect(isCustom(prompts, 'outline')).toBe(false);
  });

  it('prompt size cap and empty prompt are refused at save', () => {
    const prompts = path.join(tmpPath(), 'prompts');
    savePrompt(prompts, 'summary', 'x'.repeat(MAX_PROMPT_CHARS));
    expect(() => savePrompt(prompts, 'summary', 'x'.repeat(MAX_PROMPT_CHARS + 1))).toThrow(PromptError);
    expect(() => savePrompt(prompts, 'summary', 'x'.repeat(MAX_PROMPT_CHARS + 1))).toThrow(/limit is 8,000/);
    expect(() => savePrompt(prompts, 'summary', '  \n ')).toThrow(/empty/);
    expect(loadPrompt(prompts, 'summary')).toBe(`${'x'.repeat(MAX_PROMPT_CHARS)}\n`); // the last good save stays
  });
});
