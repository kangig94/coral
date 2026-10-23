import { describe, expect, it } from 'vitest';
import type { CauseRefToken } from '#src/causality/cause-ref.js';
import { materializeProviderFailureCauseInCommit } from '#src/coordinator/services/terminal-materializer.js';
import { providerProxyReplayFailed } from '#src/providers/proxy-failure.js';
import { jobProviderFailedBodySchema } from '#src/jobs/event-bodies.js';
import { jobsEventDescribers } from '#src/jobs/event-describers.js';
import type { CommitContext } from '#src/store/append.js';
import type { CoralEvent, ResolvableCoralEventInput } from '#src/store/envelope.js';

type RecordedInput = {
  readonly input: ResolvableCoralEventInput<unknown, unknown>;
  readonly token: CauseRefToken<unknown>;
};

const OPTIONS = {
  jobId: 'f10f3e57-0d04-53df-b4c3-3bcf75a1222d',
  execution: 1,
  parentJobId: 'parent-1',
  workflowSlotId: 'slot-1',
} as const;

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

function asSessionProviderFailedEvent(input: ResolvableCoralEventInput<unknown, unknown>): CoralEvent {
  return {
    seq: 1,
    ts: '2026-06-23T00:00:00.000Z',
    type: 'job.provider_failed',
    stream: { kind: 'job', id: 'f10f3e57-0d04-53df-b4c3-3bcf75a1222d' },
    refs: input.refs,
    body: jobProviderFailedBodySchema.parse(input.body),
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
    const body = jobProviderFailedBodySchema.parse(recorder.appended[0]?.input.body);
    expect(body.provider).toBe('@coral/provider-proxy');

    const describer = jobsEventDescribers.get('job:job.provider_failed');
    const text = describer?.(asSessionProviderFailedEvent(recorder.appended[0].input));
    expect(text).toBeDefined();
    expect(text).not.toMatch(/claude|codex/iu);
  });
});
