import { z } from 'zod';

import type { ControlClientError, ControlExchange } from './control-client.js';
import { heartbeatChallengeSchema } from './protocol.js';
import type { ProviderProxyHeartbeatHoldBound } from './orphan-deadline.js';

const JSON_RPC_INVALID_REQUEST = -32_600;

const heartbeatResultSchema = z
  .object({ state: z.literal('active'), nextHeartbeatChallenge: heartbeatChallengeSchema })
  .strict();

const heartbeatRefusalDataSchema = z.discriminatedUnion('heartbeatRefusal', [
  z
    .object({
      code: z.literal('invalid_request'),
      heartbeatRefusal: z.literal('challenge-mismatch'),
      nextHeartbeatChallenge: heartbeatChallengeSchema,
    })
    .strict(),
  z
    .object({
      code: z.literal('invalid_request'),
      heartbeatRefusal: z.literal('teardown-latched'),
    })
    .strict(),
]);

export type HeartbeatRefusal =
  | Readonly<{ reason: 'challenge-mismatch'; nextHeartbeatChallenge: string }>
  | Readonly<{ reason: 'teardown-latched'; nextHeartbeatChallenge: null }>;

/** Decodes only the heartbeat endpoint's complete refusal shapes. */
export function heartbeatRefusalFrom(jsonRpcCode: number, data: unknown): HeartbeatRefusal | null {
  if (jsonRpcCode !== JSON_RPC_INVALID_REQUEST) return null;
  const parsed = heartbeatRefusalDataSchema.safeParse(data);
  if (!parsed.success) return null;
  return parsed.data.heartbeatRefusal === 'challenge-mismatch'
    ? { reason: parsed.data.heartbeatRefusal, nextHeartbeatChallenge: parsed.data.nextHeartbeatChallenge }
    : { reason: parsed.data.heartbeatRefusal, nextHeartbeatChallenge: null };
}

/** Builds the endpoint's own strict success result without publishing its wire schema as another classifier. */
export function acceptedHeartbeatResult(nextHeartbeatChallenge: string): Readonly<{
  state: 'active';
  nextHeartbeatChallenge: string;
}> {
  return heartbeatResultSchema.parse({ state: 'active', nextHeartbeatChallenge });
}

declare const heartbeatObservationBrand: unique symbol;
type HeartbeatObservationBrand = Readonly<{ [heartbeatObservationBrand]: true }>;

type HeartbeatObservationShape =
  | Readonly<{
      kind: 'reply';
      reply:
        | Readonly<{ kind: 'accepted'; nextChallenge: string }>
        | Readonly<{ kind: 'challenge-mismatch'; nextChallenge: string }>
        | Readonly<{ kind: 'teardown-latched'; error: ControlClientError }>
        | Readonly<{ kind: 'method-not-found'; error: ControlClientError }>
        | Readonly<{ kind: 'unusable'; error: unknown }>;
    }>
  | Readonly<{ kind: 'no-response-before-deadline'; error: ControlClientError }>
  | Readonly<{
      kind: 'locally-unsent';
      stage: 'request-encode' | 'write' | 'channel-not-open';
      error: unknown;
    }>
  | Readonly<{ kind: 'channel-fault'; error: ControlClientError }>;

/**
 * The heartbeat owner's closed observation. The private brand prevents another module from manufacturing an
 * observation by choosing a convenient field combination; tests obtain values through
 * `heartbeatObservationFromExchange`.
 */
export type HeartbeatObservation = HeartbeatObservationShape & HeartbeatObservationBrand;
export type HeartbeatReplyObservation = Extract<HeartbeatObservation, { kind: 'reply' }>;
export type HeartbeatNoResponseObservation = Extract<HeartbeatObservation, { kind: 'no-response-before-deadline' }>;
export type HeartbeatLocalFailureObservation = Extract<
  HeartbeatObservation,
  { kind: 'locally-unsent' | 'channel-fault' }
>;

function observed<T extends HeartbeatObservationShape>(observation: T): T & HeartbeatObservationBrand {
  return observation as T & HeartbeatObservationBrand;
}

/** The only constructor for a heartbeat observation: it preserves the transport owner's exchange provenance. */
export function heartbeatObservationFromExchange(exchange: ControlExchange): HeartbeatObservation {
  if (exchange.kind === 'no-response') {
    return observed({ kind: 'no-response-before-deadline', error: exchange.error });
  }
  if (exchange.kind === 'not-sent') {
    const stage =
      exchange.cause === 'encode-failed'
        ? 'request-encode'
        : exchange.cause === 'write-threw'
          ? 'write'
          : 'channel-not-open';
    return observed({ kind: 'locally-unsent', stage, error: exchange.error });
  }
  if (exchange.kind === 'channel-fault') {
    return observed({ kind: 'channel-fault', error: exchange.error });
  }
  if (exchange.response.kind === 'result') {
    const parsed = heartbeatResultSchema.safeParse(exchange.response.value);
    return parsed.success
      ? observed({ kind: 'reply', reply: { kind: 'accepted', nextChallenge: parsed.data.nextHeartbeatChallenge } })
      : observed({ kind: 'reply', reply: { kind: 'unusable', error: parsed.error } });
  }

  const { error, failure } = exchange.response;
  const refusal = failure.kind === 'json-rpc-error' ? failure.heartbeatRefusal : null;
  if (refusal?.reason === 'challenge-mismatch') {
    return observed({
      kind: 'reply',
      reply: { kind: 'challenge-mismatch', nextChallenge: refusal.nextHeartbeatChallenge },
    });
  }
  if (refusal?.reason === 'teardown-latched') {
    return observed({ kind: 'reply', reply: { kind: 'teardown-latched', error } });
  }
  if (failure.kind === 'json-rpc-error' && failure.protocolCode === 'method_not_found') {
    return observed({ kind: 'reply', reply: { kind: 'method-not-found', error } });
  }
  return observed({ kind: 'reply', reply: { kind: 'unusable', error } });
}

export type HeartbeatEvidenceWindow =
  | Readonly<{ kind: 'clear' }>
  | Readonly<{
      kind: 'silence';
      firstObservedAtMonotonicMs: bigint;
      attempts: number;
      /** Scheduler lateness accumulated after the observation that opened this window. */
      schedulerLatenessAfterFirstObservationMs: number;
    }>
  | Readonly<{
      kind: 'answered-unusable';
      firstObservedAtMonotonicMs: bigint;
      attempts: number;
      /** Scheduler lateness accumulated after the observation that opened this window. */
      schedulerLatenessAfterFirstObservationMs: number;
    }>;

export type HeartbeatEvidenceTiming = Readonly<{
  nowMonotonicMs: bigint;
  schedulerLatenessMs: number;
  bound: ProviderProxyHeartbeatHoldBound;
}>;

type SilenceWindow = Extract<HeartbeatEvidenceWindow, { kind: 'silence' }>;
type AnsweredUnusableWindow = Extract<HeartbeatEvidenceWindow, { kind: 'answered-unusable' }>;

type WindowProgress<TWindow extends SilenceWindow | AnsweredUnusableWindow> =
  | Readonly<{ effect: 'holding'; window: TWindow }>
  | Readonly<{ effect: 'bound-exhausted'; window: TWindow }>;

function advanceWindow<TKind extends SilenceWindow['kind'] | AnsweredUnusableWindow['kind']>(
  current: HeartbeatEvidenceWindow,
  kind: TKind,
  timing: HeartbeatEvidenceTiming,
): WindowProgress<Extract<HeartbeatEvidenceWindow, { kind: TKind }>> {
  type Window = Extract<HeartbeatEvidenceWindow, { kind: TKind }>;
  if (current.kind === 'clear' || current.kind !== kind) {
    return {
      effect: 'holding',
      window: {
        kind,
        firstObservedAtMonotonicMs: timing.nowMonotonicMs,
        attempts: 1,
        schedulerLatenessAfterFirstObservationMs: 0,
      } as Window,
    };
  }

  const accumulatedLatenessMs = current.schedulerLatenessAfterFirstObservationMs + timing.schedulerLatenessMs;
  const advanced = {
    ...current,
    attempts: current.attempts + 1,
    schedulerLatenessAfterFirstObservationMs: accumulatedLatenessMs,
  } as Window;
  if (timing.nowMonotonicMs - current.firstObservedAtMonotonicMs < BigInt(timing.bound.spanMs)) {
    return { effect: 'holding', window: advanced };
  }
  if (accumulatedLatenessMs >= timing.bound.materialSchedulerLatenessMs) {
    return {
      effect: 'holding',
      window: {
        kind,
        firstObservedAtMonotonicMs: timing.nowMonotonicMs,
        attempts: 1,
        schedulerLatenessAfterFirstObservationMs: 0,
      } as Window,
    };
  }
  return { effect: 'bound-exhausted', window: advanced };
}

export type HeartbeatAnswerTransition =
  | Readonly<{ effect: 'accepted'; window: Readonly<{ kind: 'clear' }>; nextChallenge: string }>
  | Readonly<{ effect: 'challenge-mismatch'; window: Readonly<{ kind: 'clear' }>; nextChallenge: string }>
  | Readonly<{ effect: 'teardown-latched'; window: Readonly<{ kind: 'clear' }>; error: ControlClientError }>
  | Readonly<{ effect: 'method-not-found'; window: Readonly<{ kind: 'clear' }>; error: ControlClientError }>
  | Readonly<{ effect: 'unusable-holding'; window: AnsweredUnusableWindow; error: unknown }>
  | Readonly<{ effect: 'unusable-bound-exhausted'; window: AnsweredUnusableWindow; error: unknown }>;

/** A reply can clear or advance answered evidence, but its result cannot contain a silence window. */
export function applyAnswer(
  current: HeartbeatEvidenceWindow,
  observation: HeartbeatReplyObservation,
  timing: HeartbeatEvidenceTiming,
): HeartbeatAnswerTransition {
  const { reply } = observation;
  switch (reply.kind) {
    case 'accepted':
      return { effect: reply.kind, window: { kind: 'clear' }, nextChallenge: reply.nextChallenge };
    case 'challenge-mismatch':
      return { effect: reply.kind, window: { kind: 'clear' }, nextChallenge: reply.nextChallenge };
    case 'teardown-latched':
    case 'method-not-found':
      return { effect: reply.kind, window: { kind: 'clear' }, error: reply.error };
    case 'unusable': {
      const progress = advanceWindow(current, 'answered-unusable', timing);
      return {
        effect: progress.effect === 'holding' ? 'unusable-holding' : 'unusable-bound-exhausted',
        window: progress.window,
        error: reply.error,
      };
    }
  }
}

export type HeartbeatNoResponseTransition =
  | Readonly<{ effect: 'silence-holding'; window: SilenceWindow; error: ControlClientError }>
  | Readonly<{ effect: 'silence-bound-exhausted'; window: SilenceWindow; error: ControlClientError }>;

export function applyNoResponse(
  current: HeartbeatEvidenceWindow,
  observation: HeartbeatNoResponseObservation,
  timing: HeartbeatEvidenceTiming,
): HeartbeatNoResponseTransition {
  const progress = advanceWindow(current, 'silence', timing);
  return {
    effect: progress.effect === 'holding' ? 'silence-holding' : 'silence-bound-exhausted',
    window: progress.window,
    error: observation.error,
  };
}

export type HeartbeatLocalFailureTransition =
  | Readonly<{
      effect: 'locally-unsent';
      stage: Extract<HeartbeatObservation, { kind: 'locally-unsent' }>['stage'];
      error: unknown;
    }>
  | Readonly<{ effect: 'channel-fault'; error: ControlClientError }>;

/** Local and channel failures deliberately return no evidence-window state. */
export function applyLocalFailure(observation: HeartbeatLocalFailureObservation): HeartbeatLocalFailureTransition {
  return observation.kind === 'locally-unsent'
    ? { effect: observation.kind, stage: observation.stage, error: observation.error }
    : { effect: observation.kind, error: observation.error };
}
