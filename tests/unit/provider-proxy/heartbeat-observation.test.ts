import { describe, expect, it } from 'vitest';

import { ControlClientError, type ControlExchange } from '#src/provider-proxy/control-client.js';
import {
  applyAnswer,
  applyLocalFailure,
  applyNoResponse,
  heartbeatObservationFromExchange,
  type HeartbeatEvidenceWindow,
  type HeartbeatLocalFailureObservation,
  type HeartbeatReplyObservation,
} from '#src/provider-proxy/heartbeat-observation.js';
import { MAX_HEARTBEAT_CHALLENGE_CHARACTERS, MAX_PROXY_CONTROL_FRAME_BYTES } from '#src/provider-proxy/protocol.js';

const BOUND = { spanMs: 5_000, materialSchedulerLatenessMs: 1_250 } as const;
const TIMING = { nowMonotonicMs: 10_000n, schedulerLatenessMs: 100, bound: BOUND } as const;
const WINDOWS = [
  { kind: 'clear' },
  {
    kind: 'silence',
    firstObservedAtMonotonicMs: 0n,
    attempts: 2,
    schedulerLatenessAfterFirstObservationMs: 0,
  },
  {
    kind: 'answered-unusable',
    firstObservedAtMonotonicMs: 0n,
    attempts: 2,
    schedulerLatenessAfterFirstObservationMs: 0,
  },
] as const satisfies readonly HeartbeatEvidenceWindow[];

function refusal(
  message: string,
  protocolCode: 'invalid_request' | 'method_not_found',
  heartbeatRefusal:
    | Readonly<{ reason: 'challenge-mismatch'; nextHeartbeatChallenge: string }>
    | Readonly<{ reason: 'teardown-latched'; nextHeartbeatChallenge: null }>
    | null,
): ControlExchange {
  const failure = {
    kind: 'json-rpc-error' as const,
    jsonRpcCode: protocolCode === 'method_not_found' ? -32_601 : -32_600,
    protocolCode,
    admissionReason: null,
    heartbeatRefusal,
  };
  const error = new ControlClientError('control_call_failed', message, 'remote-response', failure);
  return { kind: 'response', response: { kind: 'refusal', failure, error } };
}

const REPLIES = [
  heartbeatObservationFromExchange({
    kind: 'response',
    response: { kind: 'result', value: { state: 'active', nextHeartbeatChallenge: 'accepted-next' } },
  }),
  heartbeatObservationFromExchange(
    refusal('challenge mismatch', 'invalid_request', {
      reason: 'challenge-mismatch',
      nextHeartbeatChallenge: 'mismatch-next',
    }),
  ),
  heartbeatObservationFromExchange(
    refusal('teardown latched', 'invalid_request', {
      reason: 'teardown-latched',
      nextHeartbeatChallenge: null,
    }),
  ),
  heartbeatObservationFromExchange(refusal('method not found', 'method_not_found', null)),
  heartbeatObservationFromExchange(refusal('unusable reply', 'invalid_request', null)),
].map((observation) => {
  if (observation.kind !== 'reply') throw new Error('test exchange did not produce a reply');
  return observation;
}) satisfies readonly HeartbeatReplyObservation[];

const timeout = new ControlClientError('control_call_failed', 'heartbeat timed out', 'timeout');
const NO_RESPONSE = heartbeatObservationFromExchange({ kind: 'no-response', cause: 'timeout', error: timeout });
if (NO_RESPONSE.kind !== 'no-response-before-deadline') throw new Error('test exchange did not produce silence');

const localEncodeError = new Error('cannot encode heartbeat');
const localWriteError = new Error('cannot write heartbeat');
const channelNotOpenError = new ControlClientError('control_client_closed', 'channel not open', 'closed');
const channelFaultError = new ControlClientError('control_call_failed', 'invalid frame', 'remote-response', {
  kind: 'invalid-frame',
});
const LOCAL_FAILURES = [
  heartbeatObservationFromExchange({ kind: 'not-sent', cause: 'encode-failed', error: localEncodeError }),
  heartbeatObservationFromExchange({ kind: 'not-sent', cause: 'write-threw', error: localWriteError }),
  heartbeatObservationFromExchange({
    kind: 'not-sent',
    cause: 'connection-already-closed',
    error: channelNotOpenError,
  }),
  heartbeatObservationFromExchange({
    kind: 'channel-fault',
    cause: 'invalid-unattributable-frame',
    error: channelFaultError,
  }),
].map((observation) => {
  if (observation.kind !== 'locally-unsent' && observation.kind !== 'channel-fault') {
    throw new Error('test exchange did not produce a local failure');
  }
  return observation;
}) satisfies readonly HeartbeatLocalFailureObservation[];

describe('heartbeat evidence-window reducer', () => {
  it('owns the strict result bound for a peer-supplied next challenge', () => {
    const atLimit = heartbeatObservationFromExchange({
      kind: 'response',
      response: {
        kind: 'result',
        value: {
          state: 'active',
          nextHeartbeatChallenge: 'x'.repeat(MAX_HEARTBEAT_CHALLENGE_CHARACTERS),
        },
      },
    });
    const overLimit = heartbeatObservationFromExchange({
      kind: 'response',
      response: {
        kind: 'result',
        value: {
          state: 'active',
          nextHeartbeatChallenge: 'x'.repeat(MAX_HEARTBEAT_CHALLENGE_CHARACTERS + 1),
        },
      },
    });

    expect(atLimit).toMatchObject({ kind: 'reply', reply: { kind: 'accepted' } });
    expect(overLimit).toMatchObject({ kind: 'reply', reply: { kind: 'unusable' } });
    expect(MAX_HEARTBEAT_CHALLENGE_CHARACTERS).toBeLessThan(MAX_PROXY_CONTROL_FRAME_BYTES / 1_000);
  });

  it.each(WINDOWS.flatMap((window) => REPLIES.map((observation) => [window, observation] as const)))(
    'crosses %s with reply %s',
    (window, observation) => {
      const transition = applyAnswer(window, observation, TIMING);
      switch (observation.reply.kind) {
        case 'accepted':
          expect(transition).toEqual({ effect: 'accepted', window: { kind: 'clear' }, nextChallenge: 'accepted-next' });
          break;
        case 'challenge-mismatch':
          expect(transition).toEqual({
            effect: 'challenge-mismatch',
            window: { kind: 'clear' },
            nextChallenge: 'mismatch-next',
          });
          break;
        case 'teardown-latched':
          expect(transition).toEqual({
            effect: 'teardown-latched',
            window: { kind: 'clear' },
            error: observation.reply.error,
          });
          break;
        case 'method-not-found':
          expect(transition).toEqual({
            effect: 'method-not-found',
            window: { kind: 'clear' },
            error: observation.reply.error,
          });
          break;
        case 'unusable':
          expect(transition).toEqual({
            effect: window.kind === 'answered-unusable' ? 'unusable-bound-exhausted' : 'unusable-holding',
            window:
              window.kind === 'answered-unusable'
                ? {
                    ...window,
                    attempts: 3,
                    schedulerLatenessAfterFirstObservationMs: 100,
                  }
                : {
                    kind: 'answered-unusable',
                    firstObservedAtMonotonicMs: 10_000n,
                    attempts: 1,
                    schedulerLatenessAfterFirstObservationMs: 0,
                  },
            error: observation.reply.error,
          });
          break;
      }
    },
  );

  it.each(WINDOWS)('crosses %s with no response', (window) => {
    const transition = applyNoResponse(window, NO_RESPONSE, TIMING);
    expect(transition).toEqual({
      effect: window.kind === 'silence' ? 'silence-bound-exhausted' : 'silence-holding',
      window:
        window.kind === 'silence'
          ? { ...window, attempts: 3, schedulerLatenessAfterFirstObservationMs: 100 }
          : {
              kind: 'silence',
              firstObservedAtMonotonicMs: 10_000n,
              attempts: 1,
              schedulerLatenessAfterFirstObservationMs: 0,
            },
      error: timeout,
    });
  });

  it.each(WINDOWS.flatMap((window) => LOCAL_FAILURES.map((observation) => [window, observation] as const)))(
    'crosses %s with local/channel failure %s without returning window state',
    (_window, observation) => {
      const transition = applyLocalFailure(observation);
      expect(transition).not.toHaveProperty('window');
      expect(transition.effect).toBe(observation.kind);
      if (observation.kind === 'locally-unsent') {
        expect(transition).toMatchObject({ stage: observation.stage, error: observation.error });
      } else {
        expect(transition).toMatchObject({ error: observation.error });
      }
    },
  );

  it('excludes the opening observation lateness and resets only after accumulated later lateness is material', () => {
    const opened = applyNoResponse({ kind: 'clear' }, NO_RESPONSE, {
      nowMonotonicMs: 0n,
      schedulerLatenessMs: BOUND.materialSchedulerLatenessMs,
      bound: BOUND,
    });
    expect(opened.window.schedulerLatenessAfterFirstObservationMs).toBe(0);

    const reset = applyNoResponse(opened.window, NO_RESPONSE, {
      nowMonotonicMs: BigInt(BOUND.spanMs),
      schedulerLatenessMs: BOUND.materialSchedulerLatenessMs,
      bound: BOUND,
    });
    expect(reset).toMatchObject({
      effect: 'silence-holding',
      window: {
        firstObservedAtMonotonicMs: BigInt(BOUND.spanMs),
        attempts: 1,
        schedulerLatenessAfterFirstObservationMs: 0,
      },
    });
  });

  it('maps a not-sent exchange to locally-unsent rather than silence', () => {
    const observation = heartbeatObservationFromExchange({
      kind: 'not-sent',
      cause: 'write-threw',
      error: localWriteError,
    });
    expect(observation).toEqual({ kind: 'locally-unsent', stage: 'write', error: localWriteError });
    expect(observation.kind).not.toBe('no-response-before-deadline');
  });
});
