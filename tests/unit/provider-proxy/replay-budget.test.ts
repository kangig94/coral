import { describe, expect, it } from 'vitest';

import {
  MAX_EMERGENCY_COMPLETION_FRAME_BYTES,
  MAX_PROXY_COMPLETION_RESERVE_BYTES,
  MAX_PROXY_SHARED_REPLAY_BYTES,
} from '#src/provider-proxy/ledger.js';
import { ReplayBudget } from '#src/provider-proxy/replay-budget.js';

function createBudget(): ReplayBudget {
  return new ReplayBudget(MAX_PROXY_SHARED_REPLAY_BYTES, MAX_PROXY_COMPLETION_RESERVE_BYTES);
}

describe('provider-proxy replay budget', () => {
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
});
