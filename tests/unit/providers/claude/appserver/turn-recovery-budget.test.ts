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
    expect(totalNoProgressRecoveryWindowMs(DEFAULT_TURN_RECOVERY_BUDGET)).toBe(326_500);
    expect(budgetUpperBoundMs(DEFAULT_TURN_RECOVERY_BUDGET)).toBe(600_000);
    expect(totalNoProgressRecoveryWindowMs(DEFAULT_TURN_RECOVERY_BUDGET)).toBeLessThan(DEFAULT_STALE_TIMEOUT_MS);
    expect(budgetUpperBoundMs(DEFAULT_TURN_RECOVERY_BUDGET)).toBeLessThan(DEFAULT_STALE_TIMEOUT_MS);
    expect(isBelowWorkflowStaleTimeout(DEFAULT_TURN_RECOVERY_BUDGET)).toBe(true);
  });
});
