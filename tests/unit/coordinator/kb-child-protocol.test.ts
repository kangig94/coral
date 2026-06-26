import { describe, expect, it } from 'vitest';

import {
  KB_CHILD_REQUEST_MESSAGE,
  isKbChildJobsResult,
  isKbChildRequestMessage,
} from '#src/coordinator/kb-child/protocol.js';

describe('KB child protocol', () => {
  it('accepts active KB job list requests', () => {
    expect(
      isKbChildRequestMessage({
        type: KB_CHILD_REQUEST_MESSAGE,
        id: '1',
        method: 'kb.jobs',
      }),
    ).toBe(true);
  });

  it('validates active KB job list results', () => {
    expect(isKbChildJobsResult({ active: ['job-a', 'job-b'] })).toBe(true);
    expect(isKbChildJobsResult({ active: ['job-a', 42] })).toBe(false);
    expect(isKbChildJobsResult({ active: 'job-a' })).toBe(false);
  });
});
