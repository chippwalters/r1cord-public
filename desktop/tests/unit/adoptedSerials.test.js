import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  adoptedSerialsPath,
  readAdoptedSerials,
  writeAdoptedSerials,
} = require('../../src/main/services/startup/adoptedSerials');

describe('adopted serials file', () => {
  it('round-trips serials the shell writes for the watcher', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-adopted-'));
    const file = writeAdoptedSerials(dir, ['S2', 'S1']);
    expect(file).toBe(adoptedSerialsPath(dir));
    expect(readAdoptedSerials(file)).toEqual(['S2', 'S1']);
  });

  it('treats a missing or empty file as unrestricted', () => {
    expect(readAdoptedSerials('D:\\no-such\\adopted-serials.json')).toBeNull();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-adopted-'));
    const file = writeAdoptedSerials(dir, []);
    expect(readAdoptedSerials(file)).toBeNull();
  });
});
