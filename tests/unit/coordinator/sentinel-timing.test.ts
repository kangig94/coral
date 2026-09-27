import { describe, expect, it } from 'vitest';

import { SENTINEL_TIMING, validSentinelTiming } from '#src/infra/sentinel-timing.js';

describe('coordinator sentinel timing', () => {
  it('owns the challenge, freeze reset, lapse, and grace values', () => {
    expect(SENTINEL_TIMING).toEqual({
      challengeMs: 1_000,
      schedulingGapMs: 5_000,
      lapseMs: 600_000,
      graceMs: 30_000,
    });
    expect(validSentinelTiming(SENTINEL_TIMING)).toBe(true);
  });

  it('rejects an escalation grace that outlasts the heartbeat lapse', () => {
    expect(validSentinelTiming({ ...SENTINEL_TIMING, graceMs: SENTINEL_TIMING.lapseMs })).toBe(false);
  });
});
