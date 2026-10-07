import { describe, expect, it } from 'vitest';

import {
  advanceWaitRenderCursor,
  parseWaitStreamEvent,
  parseWaitStreamEventValue,
} from '#src/jobs/wait/stream-event.js';
import { mapWaitSubscriptionError } from '#src/cli/wait-stream-error.js';
import { WaitBuildMismatchError } from '#src/coordinator/handoff-routing/wait-invocation.js';

import type { CarrierInterruptedWaitEvent } from '#src/jobs/wait/contract.js';

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
    const cursor = '7';
    const decision = advanceWaitRenderCursor(cursor, INTERRUPTED);

    // `observedMaxJournalSeq` is what was seen, not what was consumed. Advancing the resume cursor past it
    // would let a reconnect skip journal events this stream never delivered.
    expect(decision.cursor).toBe(cursor);
    expect(decision.shouldRender).toBe(true);
  });

  it('cannot represent a carrier interruption as a terminal', () => {
    expect(() => parseWaitStreamEvent('terminal', JSON.stringify(INTERRUPTED))).toThrow();
  });

  it.each([
    ['result', { content: 'done', outcome: { kind: 'completed' }, durationMs: 1 }],
    ['resultPath', '/tmp/result.md'],
    ['availability', { kind: 'pending' }],
    ['usage', { inputTokens: 1 }],
    ['exitCode', 0],
  ])('reads an interruption carrying %s as another build, never as an internal error', (field, value) => {
    let failure: unknown;
    try {
      parseWaitStreamEventValue({ ...INTERRUPTED, [field]: value });
    } catch (error) {
      failure = error;
    }
    expect(mapWaitSubscriptionError(failure)).toBeInstanceOf(WaitBuildMismatchError);
  });
});
