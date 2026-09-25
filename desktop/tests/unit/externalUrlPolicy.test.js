import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isAllowedExternalUrl } = require('../../src/main/services/security/externalUrlPolicy');

describe('external URL policy', () => {
  it('allows safe external web and mail links', () => {
    expect(isAllowedExternalUrl('https://example.com/docs')).toBe(true);
    expect(isAllowedExternalUrl('http://localhost:3000')).toBe(true);
    expect(isAllowedExternalUrl('mailto:support@example.com')).toBe(true);
  });

  it('rejects local and executable URL schemes', () => {
    expect(isAllowedExternalUrl('file:///C:/Windows/System32/calc.exe')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isAllowedExternalUrl('smb://server/share')).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isAllowedExternalUrl('not a url')).toBe(false);
    expect(isAllowedExternalUrl('')).toBe(false);
    expect(isAllowedExternalUrl(null)).toBe(false);
  });
});
