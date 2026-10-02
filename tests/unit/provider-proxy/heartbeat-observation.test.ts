import { describe, expect, it } from 'vitest';

import { ControlClientError, controlExchangeForTest } from '#src/provider-proxy/control-client.js';
import { applyNoResponse, heartbeatObservationFromExchange } from '#src/provider-proxy/heartbeat-observation.js';

const BOUND = { spanMs: 5_000, materialSchedulerLatenessMs: 1_250 } as const;
const TIMING = { nowMonotonicMs: 10_000n, schedulerLatenessMs: 100, bound: BOUND } as const;

const timeout = new ControlClientError('control_call_failed', 'heartbeat timed out', 'timeout');
const NO_RESPONSE = heartbeatObservationFromExchange(
  controlExchangeForTest({ kind: 'no-response', cause: 'timeout', error: timeout }),
);
if (NO_RESPONSE.kind !== 'no-response-before-deadline') throw new Error('test exchange did not produce silence');

describe('heartbeat evidence-window reducer', () => {
  it('exhausts the peer silence bound on an unanswered heartbeat', () => {
    expect(
      applyNoResponse(
        {
          kind: 'silence',
          lastObservedAtMonotonicMs: 0n,
          observedDurationMs: 4000,
          attempts: 2,
          schedulerLatenessAfterFirstObservationMs: 0,
        },
        NO_RESPONSE,
        TIMING,
      ),
    ).toMatchObject({
      effect: 'silence-bound-exhausted',
      window: { kind: 'silence', observedDurationMs: 5000, attempts: 3 },
      error: timeout,
    });
  });
});
