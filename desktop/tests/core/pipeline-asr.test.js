// Transcript files the ASR step writes, matching r1cord_server/pipeline/asr.py on disk.
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { writeTranscript } = require('../../src/core/pipeline/asr');
const { readText } = require('../../src/core/pipeline/compat');

const cleanup = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()();
});

function tmpPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-asr-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('transcript files', () => {
  it('transcript.txt holds the segments as paragraphs and transcript.json the full result', () => {
    const tmp = tmpPath();
    const result = {
      engine: 'whisper.cpp',
      model: 'large-v3-turbo',
      device: 'vulkan',
      language: 'ja',
      durationMs: 4200,
      duration: 4.2,
      segments: [
        { id: 1, start: 0, end: 2.5, text: 'こんにちは "quoted"' },
        { id: 2, start: 2.5, end: 4.2, text: 'tab\there' },
      ],
      text: 'unused',
    };
    const lines = [];

    writeTranscript(tmp, result, (line) => lines.push(line));

    expect(readText(path.join(tmp, 'transcript.txt'))).toBe('こんにちは "quoted"\n\ntab\there\n');
    const json = JSON.parse(readText(path.join(tmp, 'transcript.json')));
    expect(json).toEqual({ model: 'large-v3-turbo', device: 'vulkan', language: 'ja', durationMs: 4200, segments: result.segments });
    expect(lines).toEqual(["asr: wrote 2 segments on vulkan language='ja' duration_ms=4200"]);

    writeTranscript(tmp, { ...result, language: null, segments: [] });
    expect(readText(path.join(tmp, 'transcript.txt'))).toBe('');
    expect(JSON.parse(readText(path.join(tmp, 'transcript.json'))).segments).toEqual([]);
  });
});
