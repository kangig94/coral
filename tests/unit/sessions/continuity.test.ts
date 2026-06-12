import { describe, expect, it } from 'vitest';

import { pickProviderContinuityKeys } from '#src/providers/middleware/session-continuity.js';
import type { ProviderContinuityBlob } from '#src/sessions/continuity.js';

describe('pickProviderContinuityKeys', () => {
  it('copies only provider-allowlisted continuity keys', () => {
    const source: ProviderContinuityBlob = {
      cwd: '/workspace',
      threadId: 'thread-1',
      unexpected: 'drop-me',
    };

    expect(pickProviderContinuityKeys(source, ['cwd', 'threadId'] as const)).toEqual({
      cwd: '/workspace',
      threadId: 'thread-1',
    });
    expect(source).toHaveProperty('unexpected', 'drop-me');
  });
});
