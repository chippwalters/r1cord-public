import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createHandler } = require('../../src/main/ipc/createHandler');

describe('IPC handler wrapper', () => {
  it('wraps successful handler results in the standard envelope', async () => {
    const handler = createHandler({
      handler: async ({ input }) => ({ echoed: input.message }),
    });

    await expect(handler({}, { message: 'hello' })).resolves.toEqual({
      success: true,
      data: { echoed: 'hello' },
    });
  });

  it('returns a standard error envelope when validation fails', async () => {
    const logger = { error: vi.fn() };
    const handler = createHandler({
      logger,
      validate: (input) => {
        if (!input || typeof input.filePath !== 'string') {
          throw new Error('filePath is required');
        }
        return input;
      },
      handler: async () => 'should not run',
    });

    await expect(handler({}, { filePath: 42 })).resolves.toEqual({
      success: false,
      error: 'filePath is required',
    });
  });

  it('logs handler failures without leaking exceptions to the renderer', async () => {
    const logger = { error: vi.fn() };
    const handler = createHandler({
      logger,
      handler: async () => {
        throw new Error('disk exploded');
      },
    });

    await expect(handler({}, {})).resolves.toEqual({
      success: false,
      error: 'disk exploded',
    });
    expect(logger.error).toHaveBeenCalled();
  });
});
