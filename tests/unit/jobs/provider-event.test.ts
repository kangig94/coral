import { describe, expect, it } from 'vitest';

import {
  applyProviderEventAtSeq,
  ProviderEventDurableStateUncommittedError,
  ProviderEventIdentityMismatchError,
  ProviderEventInvalidSeqError,
  type ApplyProviderEventInput,
  type ApplyProviderEventResult,
  type ProviderEventEffectPort,
  type ProviderOperationEventIdentity,
} from '#src/jobs/provider-event.js';
import {
  PROVIDER_INTERRUPTION_CAUSES,
  PROVIDER_STOP_CAUSES,
  type ProviderContinuityEventBody,
  type ProviderProgressEventBody,
  type ProviderSuspendedEventBody,
  type ProviderStopCause,
  type ProviderTerminalEventBody,
} from '#src/providers/contract.js';

const IDENTITY: ProviderOperationEventIdentity = {
  jobId: 'job-1',
  operationId: 'operation-1',
  proxyInstanceId: 'proxy-1',
  buildSetId: 'build-set-1',
};

const PROGRESS_EVENT: ProviderProgressEventBody = { kind: 'progress', message: 'thinking' };
const CONTINUITY_EVENT: ProviderContinuityEventBody = {
  kind: 'continuity',
  conversationRef: null,
  resumable: false,
  providerContinuity: null,
};
const TERMINAL_EVENT: ProviderTerminalEventBody = {
  kind: 'terminal',
  terminal: { content: 'done', durationMs: 5, outcome: { kind: 'completed' } },
  diagnostics: {},
};
const SUSPENDED_EVENT: ProviderSuspendedEventBody = { kind: 'suspended', reason: 'interrupt_unconfirmed' };

type FakeTx = { readonly marker: 'fake-tx' };

interface FakePortOptions {
  readonly initialWatermark?: number;
  readonly identityOk?: boolean;
  readonly failAt?: { readonly method: string; readonly makeError: () => Error };
}

interface FakePort {
  readonly port: ProviderEventEffectPort<FakeTx>;
  readonly calls: readonly string[];
  readonly watermark: () => number;
}

function createFakePort(options: FakePortOptions = {}): FakePort {
  let watermark = options.initialWatermark ?? 0;
  const calls: string[] = [];

  function record(method: string): void {
    calls.push(method);
    if (options.failAt?.method === method) {
      throw options.failAt.makeError();
    }
  }

  const port: ProviderEventEffectPort<FakeTx> = {
    runInTransaction: async (execute) => execute({ marker: 'fake-tx' }),
    verifyIdentity: async () => {
      record('verifyIdentity');
      return options.identityOk ?? true;
    },
    readWatermark: async () => {
      record('readWatermark');
      return watermark;
    },
    advanceWatermark: async (_tx, _identity, seq) => {
      record('advanceWatermark');
      watermark = seq;
    },
    appendProgress: async () => {
      record('appendProgress');
    },
    appendSessionEvent: async () => {
      record('appendSessionEvent');
    },
    appendJobTerminal: async (_tx, _identity, _seq, disposition) => {
      const suffix = disposition.kind === 'abort' ? `:${disposition.reason}` : '';
      record(`appendJobTerminal:${disposition.kind}${suffix}`);
    },
    appendSessionInterrupted: async (_tx, _identity, _seq, trigger) => {
      record(`appendSessionInterrupted:${trigger}`);
    },
    releaseSessionClaim: async () => {
      record('releaseSessionClaim');
    },
  };

  return { port, calls, watermark: () => watermark };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

// A suspended event without a recorded cause is unstateable now that `recordedStopCause` lives on the
// `suspended` variant of `ApplyProviderEventBody` itself rather than as an optional sibling field — this
// function is never called; `tsc -p tsconfig/typecheck.json` (`npm run typecheck:tests`) is what proves it.
function compileTimeAssertions(): void {
  // @ts-expect-error a suspended event must carry its recordedStopCause inline; this shape cannot be built.
  const unstateable: ApplyProviderEventInput = { identity: IDENTITY, seq: 1, event: SUSPENDED_EVENT };
  void unstateable;
}

void compileTimeAssertions;

describe('applyProviderEventAtSeq', () => {
  it('is effect-free and acknowledges the current watermark when seq is at or below it', async () => {
    const { port, calls } = createFakePort({ initialWatermark: 5 });

    const result = await applyProviderEventAtSeq(port, { identity: IDENTITY, seq: 3, event: PROGRESS_EVENT });

    expect(result).toEqual<ApplyProviderEventResult>({ kind: 'ack', committedThroughProviderSeq: 5 });
    expect(calls).toEqual(['verifyIdentity', 'readWatermark']);
  });

  it('acks the watermark for a replay at exactly the watermark, performing no writes', async () => {
    const { port, calls } = createFakePort({ initialWatermark: 5 });

    const result = await applyProviderEventAtSeq(port, { identity: IDENTITY, seq: 5, event: PROGRESS_EVENT });

    expect(result).toEqual<ApplyProviderEventResult>({ kind: 'ack', committedThroughProviderSeq: 5 });
    expect(calls).toEqual(['verifyIdentity', 'readWatermark']);
  });

  it('requests replay from watermark + 1 on a gap, applying nothing', async () => {
    const { port, calls, watermark } = createFakePort({ initialWatermark: 5 });

    const result = await applyProviderEventAtSeq(port, { identity: IDENTITY, seq: 8, event: PROGRESS_EVENT });

    expect(result).toEqual<ApplyProviderEventResult>({
      kind: 'replay',
      replayFromProviderSeq: 6,
      reason: 'sequence_gap',
    });
    expect(calls).toEqual(['verifyIdentity', 'readWatermark']);
    expect(watermark()).toBe(5);
  });

  it('refuses an identity mismatch before any write', async () => {
    const { port, calls } = createFakePort({ identityOk: false });

    const error = await rejection(applyProviderEventAtSeq(port, { identity: IDENTITY, seq: 1, event: PROGRESS_EVENT }));

    expect(error).toBeInstanceOf(ProviderEventIdentityMismatchError);
    expect(calls).toEqual(['verifyIdentity']);
  });

  // NaN defeats both watermark guards (`NaN <= watermark` and `NaN > watermark + 1` are both false), and a
  // fractional or negative seq is equally nonsensical as an event ordinal — all three must be refused before
  // `runInTransaction` is even called, not merely before a write.
  it.each([
    ['NaN', NaN],
    ['fractional', 1.5],
    ['negative', -1],
  ])('refuses a %s seq before any write', async (_label, seq) => {
    const { port, calls } = createFakePort({ initialWatermark: 0 });

    const error = await rejection(applyProviderEventAtSeq(port, { identity: IDENTITY, seq, event: PROGRESS_EVENT }));

    expect(error).toBeInstanceOf(ProviderEventInvalidSeqError);
    expect(calls).toEqual([]);
  });

  it('applies a progress event and advances the watermark atomically', async () => {
    const { port, calls, watermark } = createFakePort({ initialWatermark: 0 });

    const result = await applyProviderEventAtSeq(port, { identity: IDENTITY, seq: 1, event: PROGRESS_EVENT });

    expect(result).toEqual<ApplyProviderEventResult>({ kind: 'ack', committedThroughProviderSeq: 1 });
    expect(calls).toEqual(['verifyIdentity', 'readWatermark', 'appendProgress', 'advanceWatermark']);
    expect(watermark()).toBe(1);
  });

  it('routes continuity events to the session-event append', async () => {
    const { port, calls } = createFakePort({ initialWatermark: 0 });

    await applyProviderEventAtSeq(port, { identity: IDENTITY, seq: 1, event: CONTINUITY_EVENT });

    expect(calls).toEqual(['verifyIdentity', 'readWatermark', 'appendSessionEvent', 'advanceWatermark']);
  });

  it('releases the session claim before advancing the watermark for a direct terminal', async () => {
    const { port, calls, watermark } = createFakePort({ initialWatermark: 0 });

    const result = await applyProviderEventAtSeq(port, { identity: IDENTITY, seq: 1, event: TERMINAL_EVENT });

    expect(result).toEqual<ApplyProviderEventResult>({ kind: 'ack', committedThroughProviderSeq: 1 });
    expect(calls).toEqual([
      'verifyIdentity',
      'readWatermark',
      'appendJobTerminal:direct',
      'releaseSessionClaim',
      'advanceWatermark',
    ]);
    const releaseIndex = calls.indexOf('releaseSessionClaim');
    const advanceIndex = calls.indexOf('advanceWatermark');
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeLessThan(advanceIndex);
    expect(watermark()).toBe(1);
  });

  it('leaves the watermark unmoved, emits no ACK, and releases no claim when the transaction throws', async () => {
    const { port, calls, watermark } = createFakePort({
      initialWatermark: 0,
      failAt: { method: 'appendJobTerminal:direct', makeError: () => new Error('disk full') },
    });

    const error = await rejection(applyProviderEventAtSeq(port, { identity: IDENTITY, seq: 1, event: TERMINAL_EVENT }));

    expect((error as Error).message).toBe('disk full');
    expect(calls).toEqual(['verifyIdentity', 'readWatermark', 'appendJobTerminal:direct']);
    expect(calls).not.toContain('releaseSessionClaim');
    expect(calls).not.toContain('advanceWatermark');
    expect(watermark()).toBe(0);
  });

  it('turns a durable_state_uncommitted failure into a replay request instead of a silent failure', async () => {
    const { port, calls, watermark } = createFakePort({
      initialWatermark: 4,
      failAt: { method: 'appendSessionEvent', makeError: () => new ProviderEventDurableStateUncommittedError() },
    });

    const result = await applyProviderEventAtSeq(port, { identity: IDENTITY, seq: 5, event: CONTINUITY_EVENT });

    expect(result).toEqual<ApplyProviderEventResult>({
      kind: 'replay',
      replayFromProviderSeq: 5,
      reason: 'durable_state_uncommitted',
    });
    expect(calls).toEqual(['verifyIdentity', 'readWatermark', 'appendSessionEvent']);
    expect(calls).not.toContain('advanceWatermark');
    expect(watermark()).toBe(4);
  });

  // A cause outside the closed `ProviderStopCause` union can still reach this function at runtime (a value
  // that bypassed schema validation, or a union member added on one side of the wire before the other is
  // updated) — deciding by the positive and routing anything else through `assertNever` must refuse it
  // instead of falling into the `else` branch and writing a false `session.interrupted`.
  it('refuses an unrecognised stop cause instead of silently writing a false interruption', async () => {
    const { port, calls } = createFakePort({ initialWatermark: 0 });
    const unrecognisedCause = 'not_a_real_stop_cause' as ProviderStopCause;

    const error = await rejection(
      applyProviderEventAtSeq(port, {
        identity: IDENTITY,
        seq: 1,
        event: { ...SUSPENDED_EVENT, recordedStopCause: unrecognisedCause },
      }),
    );

    expect((error as Error).message).toContain('Unhandled case');
    expect(calls).toEqual(['verifyIdentity', 'readWatermark']);
  });

  // Driven from the production-exported cause list, not a hand-written literal, so a future addition to
  // `PROVIDER_INTERRUPTION_CAUSES` is exercised here automatically instead of the test silently going stale.
  const ABORT_CAUSES: readonly ProviderStopCause[] = PROVIDER_STOP_CAUSES.filter(
    (cause) => !(PROVIDER_INTERRUPTION_CAUSES as readonly string[]).includes(cause),
  );

  it.each(PROVIDER_INTERRUPTION_CAUSES)(
    'writes a truthful session.interrupted before the terminal for a suspended event caused by %s',
    async (cause) => {
      const { port, calls } = createFakePort({ initialWatermark: 0 });

      const result = await applyProviderEventAtSeq(port, {
        identity: IDENTITY,
        seq: 1,
        event: { ...SUSPENDED_EVENT, recordedStopCause: cause },
      });

      expect(result).toEqual<ApplyProviderEventResult>({ kind: 'ack', committedThroughProviderSeq: 1 });
      // The exact recorded cause reaches the fault, not merely "some" interruption — otherwise a `handoff`
      // could be journaled as a `restart` (or vice versa) and still pass a test that only checked the call
      // happened.
      expect(calls).toEqual([
        'verifyIdentity',
        'readWatermark',
        `appendSessionInterrupted:${cause}`,
        'appendJobTerminal:interrupted',
        'releaseSessionClaim',
        'advanceWatermark',
      ]);
    },
  );

  it.each(ABORT_CAUSES)(
    'writes only the existing abort outcome, with no false interruption, for a suspended event caused by %s',
    async (cause) => {
      const { port, calls } = createFakePort({ initialWatermark: 0 });

      const result = await applyProviderEventAtSeq(port, {
        identity: IDENTITY,
        seq: 1,
        event: { ...SUSPENDED_EVENT, recordedStopCause: cause },
      });

      expect(result).toEqual<ApplyProviderEventResult>({ kind: 'ack', committedThroughProviderSeq: 1 });
      expect(calls).toEqual([
        'verifyIdentity',
        'readWatermark',
        `appendJobTerminal:abort:${cause}`,
        'releaseSessionClaim',
        'advanceWatermark',
      ]);
      expect(calls.some((call) => call.startsWith('appendSessionInterrupted'))).toBe(false);
    },
  );
});
