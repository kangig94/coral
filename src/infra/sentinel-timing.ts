export type SentinelTiming = Readonly<{
  challengeMs: number;
  schedulingGapMs: number;
  lapseMs: number;
  graceMs: number;
  dStateDeferralMs: number;
}>;

export const SENTINEL_TIMING: SentinelTiming = Object.freeze({
  challengeMs: 1_000,
  schedulingGapMs: 5_000,
  lapseMs: 10 * 60_000,
  graceMs: 30_000,
  dStateDeferralMs: 4 * 60_000,
});

export function validSentinelTiming(timing: SentinelTiming): boolean {
  return (
    Number.isSafeInteger(timing.challengeMs) &&
    Number.isSafeInteger(timing.schedulingGapMs) &&
    Number.isSafeInteger(timing.lapseMs) &&
    Number.isSafeInteger(timing.graceMs) &&
    Number.isSafeInteger(timing.dStateDeferralMs) &&
    timing.challengeMs > 0 &&
    timing.challengeMs < timing.schedulingGapMs &&
    timing.schedulingGapMs < timing.lapseMs &&
    timing.graceMs > timing.challengeMs &&
    timing.graceMs < timing.dStateDeferralMs &&
    timing.dStateDeferralMs < timing.lapseMs
  );
}

if (!validSentinelTiming(SENTINEL_TIMING)) throw new Error('Invalid coordinator sentinel timing');
