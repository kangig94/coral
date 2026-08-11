import { describe, expect, it } from 'vitest';

import type { CauseRefToken } from '#src/causality/cause-ref.js';
import { materializeProviderFailureCauseInCommit } from '#src/coordinator/services/terminal-materializer.js';
import { providerRequestFailed } from '#src/providers/fault.js';
import { providerProxyReplayFailed } from '#src/providers/proxy-failure.js';
import { sessionProviderFailedBodySchema } from '#src/sessions/event-bodies.js';
import { sessionsEventDescribers } from '#src/sessions/event-describers.js';
import {
  type SessionProviderFailureDiagnostic,
  type SessionProviderFailureDiagnosticPhase,
  type SessionProviderFailureDiagnosticReason,
} from '#src/sessions/fault.js';
import type { CommitContext } from '#src/store/append.js';
import type { CoralEvent, ResolvableCoralEventInput } from '#src/store/envelope.js';

type RecordedInput = {
  readonly input: ResolvableCoralEventInput<unknown, unknown>;
  readonly token: CauseRefToken<unknown>;
};

const OPTIONS = {
  jobId: 'job-1',
  sessionId: 'session-1',
  parentJobId: 'parent-1',
  workflowSlotId: 'slot-1',
} as const;

const DIAGNOSTIC_CASES = [
  ['silent-hang', 'registered'],
  ['api-error', 'responding'],
  ['child-exit', 'sent'],
  ['finalization-failure', 'ending'],
] as const satisfies ReadonlyArray<
  readonly [SessionProviderFailureDiagnosticReason, SessionProviderFailureDiagnosticPhase]
>;

function createContextRecorder(): {
  readonly appended: RecordedInput[];
  readonly c: CommitContext<unknown>;
} {
  const appended: RecordedInput[] = [];
  return {
    appended,
    c: {
      append(input) {
        const token = { slot: appended.length } as unknown as CauseRefToken<unknown>;
        appended.push({ input, token });
        return token;
      },
    },
  };
}

function diagnostic(
  reason: SessionProviderFailureDiagnosticReason,
  phase: SessionProviderFailureDiagnosticPhase,
): SessionProviderFailureDiagnostic {
  return {
    reason,
    phase,
    idleMs: phase === 'sent' ? 2_500 : 90_000,
    attempts: phase === 'sent' ? 3 : 2,
    childOutputTail: `child output for ${reason}`,
    transcriptTail: `transcript output for ${phase}`,
    sessionId: 'session-1',
    conversationRef: 'conversation-1',
  };
}

function asSessionProviderFailedEvent(input: ResolvableCoralEventInput<unknown, unknown>): CoralEvent {
  return {
    seq: 1,
    ts: '2026-06-23T00:00:00.000Z',
    type: 'session.provider_failed',
    stream: { kind: 'session', id: 'session-1' },
    refs: input.refs,
    body: sessionProviderFailedBodySchema.parse(input.body),
  };
}

describe('terminal materializer turn failure diagnostics', () => {
  it('preserves proxy-origin replay failure without naming a provider in the durable body or user text', () => {
    const recorder = createContextRecorder();
    const outcome = materializeProviderFailureCauseInCommit(
      recorder.c,
      providerProxyReplayFailed({ reason: 'provider_replay_operation_events_exhausted' }),
      OPTIONS,
    );

    expect(outcome).toEqual({ kind: 'failed', causeRef: recorder.appended[0]?.token });
    const body = sessionProviderFailedBodySchema.parse(recorder.appended[0]?.input.body);
    expect(body.provider).toBe('@coral/provider-proxy');

    const describer = sessionsEventDescribers.get('session:session.provider_failed');
    expect(describer?.(asSessionProviderFailedEvent(recorder.appended[0].input))).toBe(
      'Provider proxy stopped the turn: Replay event count reached 4,096 for this operation.',
    );
  });

  it.each(DIAGNOSTIC_CASES)('preserves %s/%s through session fault materialization and describers', (reason, phase) => {
    const recorder = createContextRecorder();
    const expectedDiagnostic = diagnostic(reason, phase);

    const outcome = materializeProviderFailureCauseInCommit(
      recorder.c,
      providerRequestFailed({
        provider: 'claude',
        message: `${reason} provider failure`,
        diagnostic: expectedDiagnostic,
      }),
      OPTIONS,
    );

    expect(outcome).toEqual({
      kind: 'failed',
      causeRef: recorder.appended[0]?.token,
    });
    expect(recorder.appended[0]?.input.type).toBe('session.provider_failed');

    const body = sessionProviderFailedBodySchema.parse(recorder.appended[0]?.input.body);
    expect(body.diagnostic?.reason).toBe(reason);
    expect(body.diagnostic?.phase).toBe(phase);
    expect(body.diagnostic).toEqual(expectedDiagnostic);

    const describer = sessionsEventDescribers.get('session:session.provider_failed');
    expect(describer).toBeDefined();
    const description = describer?.(asSessionProviderFailedEvent(recorder.appended[0].input));
    expect(description).toContain(`reason=${reason}`);
    expect(description).toContain(`phase=${phase}`);
    expect(description).toContain(`child output for ${reason}`);
    expect(description).toContain(`transcript output for ${phase}`);
  });
});
