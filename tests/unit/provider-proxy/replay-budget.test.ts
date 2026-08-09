import { describe, expect, it } from 'vitest';

import {
  MAX_EMERGENCY_COMPLETION_FRAME_BYTES,
  MAX_PROXY_COMPLETION_RESERVE_BYTES,
  MAX_PROXY_OPERATION_LEDGERS,
  MAX_PROXY_REPLAY_BYTES,
  MAX_PROXY_SHARED_REPLAY_BYTES,
} from '#src/provider-proxy/ledger.js';
import { ReplayAdmissionError, ReplayBudget } from '#src/provider-proxy/replay-budget.js';

function createBudget(): ReplayBudget {
  return new ReplayBudget(MAX_PROXY_SHARED_REPLAY_BYTES, MAX_PROXY_COMPLETION_RESERVE_BYTES);
}

describe('provider-proxy replay budget', () => {
  it('partitions 58,720,256 shared bytes plus 8,388,608 completion bytes into the 67,108,864 total', () => {
    const reviewedSharedBytes = 58_720_256;
    const reviewedCompletionBytes = 8_388_608;
    const budget = createBudget();
    budget.commit({
      kind: 'ordinary',
      frameBytes: reviewedSharedBytes,
      completionSlotLimitBytes: MAX_EMERGENCY_COMPLETION_FRAME_BYTES,
    });
    for (let index = 0; index < MAX_PROXY_OPERATION_LEDGERS; index += 1) {
      budget.commit({
        kind: 'completion',
        frameBytes: MAX_EMERGENCY_COMPLETION_FRAME_BYTES,
        completionSlotLimitBytes: MAX_EMERGENCY_COMPLETION_FRAME_BYTES,
      });
    }

    expect(budget.usage()).toEqual({
      sharedBytes: reviewedSharedBytes,
      completionSlotBytes: reviewedCompletionBytes,
      totalBytes: MAX_PROXY_REPLAY_BYTES,
    });

    let retainedTotal = budget.usage().totalBytes;
    try {
      budget.commit({
        kind: 'ordinary',
        frameBytes: reviewedCompletionBytes,
        completionSlotLimitBytes: MAX_EMERGENCY_COMPLETION_FRAME_BYTES,
      });
      retainedTotal = budget.usage().totalBytes;
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'replay_admission_refused', scope: 'proxy-shared-bytes' });
    }
    expect(retainedTotal).toBe(MAX_PROXY_REPLAY_BYTES);
    expect(MAX_PROXY_SHARED_REPLAY_BYTES).toBe(reviewedSharedBytes);
    expect(MAX_PROXY_COMPLETION_RESERVE_BYTES).toBe(reviewedCompletionBytes);
    expect(MAX_PROXY_SHARED_REPLAY_BYTES + MAX_PROXY_COMPLETION_RESERVE_BYTES).toBe(67_108_864);
  });

  it('charges a large completion to its slot first and only its remainder to shared replay', () => {
    const budget = createBudget();
    const charge = budget.commit({
      kind: 'completion',
      frameBytes: MAX_EMERGENCY_COMPLETION_FRAME_BYTES + 10,
      completionSlotLimitBytes: MAX_EMERGENCY_COMPLETION_FRAME_BYTES,
    });

    expect(charge).toEqual({ sharedBytes: 10, completionSlotBytes: MAX_EMERGENCY_COMPLETION_FRAME_BYTES });
    expect(budget.usage()).toEqual({
      sharedBytes: 10,
      completionSlotBytes: MAX_EMERGENCY_COMPLETION_FRAME_BYTES,
      totalBytes: MAX_EMERGENCY_COMPLETION_FRAME_BYTES + 10,
    });
  });

  it('charges an emergency completion only to its reserved operation slot', () => {
    const budget = createBudget();

    expect(
      budget.commit({
        kind: 'emergency-completion',
        frameBytes: 641,
        completionSlotLimitBytes: MAX_EMERGENCY_COMPLETION_FRAME_BYTES,
      }),
    ).toEqual({ sharedBytes: 0, completionSlotBytes: 641 });
    expect(budget.usage()).toEqual({ sharedBytes: 0, completionSlotBytes: 641, totalBytes: 641 });
  });

  it('releases the stored charge without recomputing its lane split', () => {
    const budget = createBudget();
    const charge = budget.commit({
      kind: 'completion',
      frameBytes: MAX_EMERGENCY_COMPLETION_FRAME_BYTES + 17,
      completionSlotLimitBytes: MAX_EMERGENCY_COMPLETION_FRAME_BYTES,
    });

    budget.release(charge);

    expect(budget.usage()).toEqual({ sharedBytes: 0, completionSlotBytes: 0, totalBytes: 0 });
    expect(() => budget.release(charge)).toThrow(RangeError);
  });

  it('reports the admission scope when shared replay is exhausted', () => {
    const budget = createBudget();
    budget.commit({
      kind: 'ordinary',
      frameBytes: MAX_PROXY_SHARED_REPLAY_BYTES,
      completionSlotLimitBytes: MAX_EMERGENCY_COMPLETION_FRAME_BYTES,
    });

    let caught: unknown;
    try {
      budget.commit({
        kind: 'ordinary',
        frameBytes: 1,
        completionSlotLimitBytes: MAX_EMERGENCY_COMPLETION_FRAME_BYTES,
      });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReplayAdmissionError);
    expect(caught).toMatchObject({ code: 'replay_admission_refused', scope: 'proxy-shared-bytes' });
  });
});
