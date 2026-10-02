import { describe, expect, it } from 'vitest';

import { advanceWaitRenderCursor, parseWaitStreamEvent } from '#src/jobs/wait-stream-event.js';

import type { CarrierInterruptedWaitEvent } from '#src/jobs/wait.js';

const INTERRUPTED: CarrierInterruptedWaitEvent = {
  type: 'interrupted',
  jobId: 'job-1',
  storedPhase: 'running',
  observedMaxJournalSeq: 12,
  remainingJobIds: ['job-1', 'job-2'],
  observation: { kind: 'carrier_interrupted', reason: 'carrier_absent' },
  continuity: 'unavailable',
  outcome: 'unknown',
};

describe('carrier interrupted wait event', () => {
  it('rejects malformed carrier input', () => {
    expect(() => parseWaitStreamEvent('interrupted', JSON.stringify({ ...INTERRUPTED, jobId: '' }))).toThrow();
  });

  it('never advances the render cursor', () => {
    const decision = advanceWaitRenderCursor({ afterSeq: 3 }, INTERRUPTED);

    // `observedMaxJournalSeq` is what was seen, not what was consumed. Advancing the resume cursor past it
    // would let a reconnect skip journal events this stream never delivered.
    expect(decision.cursor).toEqual({ afterSeq: 3 });
    expect(decision.shouldRender).toBe(true);
  });

  it('cannot represent a carrier interruption as a terminal', () => {
    expect(() => parseWaitStreamEvent('terminal', JSON.stringify(INTERRUPTED))).toThrow();
  });
});
