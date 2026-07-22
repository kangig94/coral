export interface CurateUsageBudgetPort {
  isExhausted(signal: AbortSignal): Promise<boolean>;
}
