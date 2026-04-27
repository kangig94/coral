import { describe, expect, it } from 'vitest';

import { throwBackendCommunicationError } from '#src/transport/http/backend/communication.js';
import { BackendUnreachableError } from '#src/infra/http-errors.js';

describe('transport/http backend communication', () => {
  it.each(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'])(
    'wraps fetch failures with cause.code=%s in BackendUnreachableError',
    (code) => {
      const original = new TypeError('fetch failed', { cause: { code } });

      let caught: unknown;
      try {
        throwBackendCommunicationError(original);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(BackendUnreachableError);
      expect((caught as BackendUnreachableError).message).toBe('fetch failed');
    },
  );
});
