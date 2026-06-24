export type TurnRecoveryBudget = Readonly<{
  registration: Readonly<{
    promptAckMs: number;
    promptResends: number;
  }>;
  'assistant-start': Readonly<{
    assistantStartIdleMs: number;
  }>;
  'assistant-progress': Readonly<{
    assistantProgressIdleMs: number;
  }>;
  'finalization-grace': Readonly<{
    finalizationGraceMs: number;
  }>;
  replacement: Readonly<{
    replacementShutdownMs: number;
    childReadyMs: number;
    continuationAckMs: number;
    respawnAttempts: number;
  }>;
  'hard-cap': Readonly<{
    /**
     * Caps one contiguous no-semantic-progress recovery episode. Semantic
     * assistant/tool progress resets the controller's relevant idle deadline.
     */
    hardCapMs: number;
  }>;
}>;

export const DEFAULT_TURN_RECOVERY_BUDGET = {
  registration: {
    promptAckMs: 2_500,
    promptResends: 3,
  },
  'assistant-start': {
    assistantStartIdleMs: 90_000,
  },
  'assistant-progress': {
    assistantProgressIdleMs: 180_000,
  },
  'finalization-grace': {
    finalizationGraceMs: 1_500,
  },
  replacement: {
    replacementShutdownMs: 2_500,
    childReadyMs: 5_000,
    continuationAckMs: 10_000,
    respawnAttempts: 2,
  },
  'hard-cap': {
    hardCapMs: 600_000,
  },
} as const satisfies TurnRecoveryBudget;

export function totalNoProgressRecoveryWindowMs(budget: TurnRecoveryBudget): number {
  const registrationWindowMs = (budget.registration.promptResends + 1) * budget.registration.promptAckMs;
  const respawnWindowMs =
    budget.replacement.respawnAttempts *
    (budget.replacement.replacementShutdownMs + budget.replacement.childReadyMs + budget.replacement.continuationAckMs);

  return (
    registrationWindowMs +
    budget['assistant-start'].assistantStartIdleMs +
    budget['assistant-progress'].assistantProgressIdleMs +
    budget['finalization-grace'].finalizationGraceMs +
    respawnWindowMs
  );
}

export function budgetUpperBoundMs(budget: TurnRecoveryBudget): number {
  return Math.max(totalNoProgressRecoveryWindowMs(budget), budget['hard-cap'].hardCapMs);
}
