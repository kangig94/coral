import { describe, expect, it } from 'vitest';

import { serializeBootstrapError } from '#src/coordinator/bootstrap-diagnostics.js';

describe('serializeBootstrapError', () => {
  it('preserves a nested Error cause chain', () => {
    const error = new Error('coordinator startup failed', {
      cause: new Error('runtime initialization failed', {
        cause: new Error('database is locked'),
      }),
    });

    expect(serializeBootstrapError(error)).toMatchObject({
      kind: 'error',
      message: 'coordinator startup failed',
      cause: {
        kind: 'error',
        message: 'runtime initialization failed',
        cause: {
          kind: 'error',
          message: 'database is locked',
        },
      },
    });
  });

  it('stops serializing a cyclic cause after eight nested causes', () => {
    const error = new Error('cyclic failure');
    error.cause = error;

    let serialized = serializeBootstrapError(error);
    for (let causeDepth = 0; causeDepth < 8; causeDepth += 1) {
      expect(serialized).toMatchObject({ kind: 'error', message: 'cyclic failure' });
      expect(serialized.cause).toBeDefined();
      serialized = serialized.cause as Record<string, unknown>;
    }
    expect(serialized).toMatchObject({ kind: 'error', message: 'cyclic failure' });
    expect(serialized).not.toHaveProperty('cause');
  });
});
