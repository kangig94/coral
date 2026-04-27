import { describe, expect, it } from 'vitest';

import { throwCoordinatorCommunicationError } from '#src/transport/http/coordinator/communication.js';
import { CoordinatorUnreachableError } from '#src/infra/http-errors.js';

describe('transport/http backend communication', () => {
  it.each(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'])(
    'wraps fetch failures with cause.code=%s in CoordinatorUnreachableError',
    (code) => {
      const original = new TypeError('fetch failed', { cause: { code } });

      let caught: unknown;
      try {
        throwCoordinatorCommunicationError(original);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(CoordinatorUnreachableError);
      expect((caught as CoordinatorUnreachableError).message).toBe('fetch failed');
    },
  );
});
