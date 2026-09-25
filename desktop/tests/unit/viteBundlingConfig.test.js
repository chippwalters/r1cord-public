import { describe, expect, it } from 'vitest';

function includesSourceCommonJsTransform(config) {
  const include = config?.build?.commonjsOptions?.include;
  const includeList = Array.isArray(include) ? include : [include].filter(Boolean);

  return includeList.some((entry) => {
    if (entry instanceof RegExp) {
      return entry.test('src/main/services/paths.js') || entry.source.includes('src');
    }
    return String(entry).includes('src');
  });
}

describe('Vite Electron bundle config', () => {
  it('transforms CommonJS requires in src for the main process bundle', async () => {
    const { default: config } = await import('../../vite.main.config.mjs');
    expect(includesSourceCommonJsTransform(config)).toBe(true);
  });

  it('transforms CommonJS requires in src for the preload bundle', async () => {
    const { default: config } = await import('../../vite.preload.config.mjs');
    expect(includesSourceCommonJsTransform(config)).toBe(true);
  });
});
