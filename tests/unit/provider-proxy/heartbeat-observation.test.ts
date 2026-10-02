import { describe, expect, it } from 'vitest';

import { ControlClientError, controlExchangeForTest } from '#src/provider-proxy/control-client.js';
import {
  applyAnswer,
  applyNoResponse,
  heartbeatObservationFromExchange,
} from '#src/provider-proxy/heartbeat-observation.js';

const BOUND = { spanMs: 5_000, materialSchedulerLatenessMs: 1_250 } as const;
const TIMING = { nowMonotonicMs: 10_000n, schedulerLatenessMs: 100, bound: BOUND } as const;

const timeout = new ControlClientError('control_call_failed', 'heartbeat timed out', 'timeout');
const NO_RESPONSE = heartbeatObservationFromExchange(
  controlExchangeForTest({ kind: 'no-response', cause: 'timeout', error: timeout }),
);
if (NO_RESPONSE.kind !== 'no-response-before-deadline') throw new Error('test exchange did not produce silence');
const localWriteError = new Error('cannot write heartbeat');

describe('heartbeat evidence-window reducer', () => {
  it('clears peer silence after an accepted echo', () => {
    const observation = heartbeatObservationFromExchange(
      controlExchangeForTest({
        kind: 'response',
        response: { kind: 'result', value: { state: 'active', nextHeartbeatChallenge: 'accepted-next' } },
      }),
    );
    if (observation.kind !== 'reply') throw new Error('expected a reply');
    expect(
      applyAnswer(
        {
          kind: 'silence',
          lastObservedAtMonotonicMs: 0n,
          observedDurationMs: 4000,
          attempts: 2,
          schedulerLatenessAfterFirstObservationMs: 0,
        },
        observation,
        TIMING,
      ),
    ).toEqual({
      effect: 'accepted',
      window: { kind: 'clear' },
      nextChallenge: 'accepted-next',
    });
  });

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

  it('rebases repeated sub-cadence scheduler lateness instead of charging it to the peer', () => {
    let progress = applyNoResponse({ kind: 'clear' }, NO_RESPONSE, {
      nowMonotonicMs: 0n,
      schedulerLatenessMs: 0,
      bound: BOUND,
    });

    for (const nowMonotonicMs of [1_250n, 2_500n, 3_750n, 5_000n]) {
      progress = applyNoResponse(progress.window, NO_RESPONSE, {
        nowMonotonicMs,
        schedulerLatenessMs: 250,
        bound: BOUND,
      });
    }

    expect(progress).toMatchObject({
      effect: 'silence-holding',
      window: {
        lastObservedAtMonotonicMs: 5_000n,
        observedDurationMs: 4_000,
        attempts: 5,
        schedulerLatenessAfterFirstObservationMs: 1_000,
      },
    });

    const exhausted = applyNoResponse(progress.window, NO_RESPONSE, {
      nowMonotonicMs: 6_250n,
      schedulerLatenessMs: 250,
      bound: BOUND,
    });
    expect(exhausted).toMatchObject({
      effect: 'silence-holding',
      window: {
        lastObservedAtMonotonicMs: 6_250n,
        observedDurationMs: 0,
        attempts: 1,
        schedulerLatenessAfterFirstObservationMs: 0,
      },
    });
  });

  it('maps a not-sent exchange to locally-unsent rather than silence', () => {
    const observation = heartbeatObservationFromExchange(
      controlExchangeForTest({
        kind: 'not-sent',
        cause: 'write-threw',
        error: localWriteError,
      }),
    );
    expect(observation).toEqual({ kind: 'locally-unsent', stage: 'write', error: localWriteError });
    expect(observation.kind).not.toBe('no-response-before-deadline');
  });
});
