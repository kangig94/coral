import { describe, expect, it } from 'vitest';

import {
  KB_CHILD_REQUEST_MESSAGE,
  isKbChildJobsResult,
  isKbChildKbReadHealth,
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

  it('accepts child runtime health with curate scheduler state', () => {
    expect(
      isKbChildKbReadHealth({
        phase: 'ready',
        initializedAt: 123,
        curateRunning: true,
        mutationBlocked: { owner: 'reindex', ageMs: 5000, signaledAtMs: 123456 },
      }),
    ).toBe(true);
    expect(isKbChildKbReadHealth({ phase: 'ready', curateRunning: 'yes' })).toBe(false);
    expect(isKbChildKbReadHealth({ phase: 'ready', mutationBlocked: { owner: 'reindex' } })).toBe(false);
  });
});
