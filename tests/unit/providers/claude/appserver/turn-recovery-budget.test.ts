import { describe, expect, it } from 'vitest';

import { DEFAULT_STALE_TIMEOUT_MS } from '#src/workflow/execution-constants.js';
import {
  budgetUpperBoundMs,
  DEFAULT_TURN_RECOVERY_BUDGET,
  totalNoProgressRecoveryWindowMs,
  type TurnRecoveryBudget,
} from '#src/providers/claude/appserver/turn-recovery-budget.js';

function isBelowWorkflowStaleTimeout(budget: TurnRecoveryBudget): boolean {
  return (
    totalNoProgressRecoveryWindowMs(budget) < DEFAULT_STALE_TIMEOUT_MS &&
    budgetUpperBoundMs(budget) < DEFAULT_STALE_TIMEOUT_MS
  );
}

describe('turn recovery budget', () => {
  it('keeps the default no-progress recovery window below workflow stale recovery', () => {
    expect(totalNoProgressRecoveryWindowMs(DEFAULT_TURN_RECOVERY_BUDGET)).toBe(316_500);
    expect(budgetUpperBoundMs(DEFAULT_TURN_RECOVERY_BUDGET)).toBe(600_000);
    expect(totalNoProgressRecoveryWindowMs(DEFAULT_TURN_RECOVERY_BUDGET)).toBeLessThan(
      DEFAULT_STALE_TIMEOUT_MS,
    );
    expect(budgetUpperBoundMs(DEFAULT_TURN_RECOVERY_BUDGET)).toBeLessThan(
      DEFAULT_STALE_TIMEOUT_MS,
    );
    expect(isBelowWorkflowStaleTimeout(DEFAULT_TURN_RECOVERY_BUDGET)).toBe(true);
  });

  it('flags an oversized no-progress hard cap as stale-violating', () => {
    const oversizedHardCapBudget = {
      ...DEFAULT_TURN_RECOVERY_BUDGET,
      'hard-cap': {
        ...DEFAULT_TURN_RECOVERY_BUDGET['hard-cap'],
        hardCapMs: DEFAULT_STALE_TIMEOUT_MS,
      },
    } as const satisfies TurnRecoveryBudget;

    expect(totalNoProgressRecoveryWindowMs(oversizedHardCapBudget)).toBe(316_500);
    expect(budgetUpperBoundMs(oversizedHardCapBudget)).toBe(DEFAULT_STALE_TIMEOUT_MS);
    expect(isBelowWorkflowStaleTimeout(oversizedHardCapBudget)).toBe(false);
  });

  it('flags oversized phase timings as stale-violating', () => {
    const oversizedPhaseBudget = {
      ...DEFAULT_TURN_RECOVERY_BUDGET,
      'assistant-progress': {
        ...DEFAULT_TURN_RECOVERY_BUDGET['assistant-progress'],
        assistantProgressIdleMs: DEFAULT_STALE_TIMEOUT_MS,
      },
    } as const satisfies TurnRecoveryBudget;

    expect(totalNoProgressRecoveryWindowMs(oversizedPhaseBudget)).toBe(1_036_500);
    expect(budgetUpperBoundMs(oversizedPhaseBudget)).toBe(1_036_500);
    expect(isBelowWorkflowStaleTimeout(oversizedPhaseBudget)).toBe(false);
  });
});
