import { describe, expect, it } from 'vitest';

import type { CauseRefToken } from '#src/causality/cause-ref.js';
import type { AppendedEvent, CommitContext } from '#src/store/append.js';
import type { ResolvableCoralEventInput } from '#src/store/envelope.js';
import { providerRequestFailed, providerSessionUnavailable, type ProviderFailureCause } from '#src/providers/fault.js';
import type { ProviderTerminalEventBody } from '#src/providers/contract.js';
import {
  materializeJobRecoveryFaultInCommit,
  materializeProviderFailureCauseInCommit,
  materializeProviderTerminal,
  recordProviderTerminal,
} from '#src/coordinator/services/terminal-materializer.js';

type RecordedInput = {
  input: ResolvableCoralEventInput<unknown, unknown>;
  token: CauseRefToken<unknown>;
};

function createCommitRecorder(): {
  readonly appended: RecordedInput[];
  readonly progressStore: {
    commit(cb: <Scope>(c: CommitContext<Scope>) => undefined): AppendedEvent[];
  };
} {
  const appended: RecordedInput[] = [];

  return {
    appended,
    progressStore: {
      commit(cb) {
        const c: CommitContext<unknown> = {
          append(input) {
            const token = { slot: appended.length } as unknown as CauseRefToken<unknown>;
            appended.push({ input, token });
            return token;
          },
        };
        cb(c);
        return [] as AppendedEvent[];
      },
    },
  };
}

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

const OPTIONS = {
  jobId: 'job-1',
  sessionId: 'session-1',
  parentJobId: 'parent-1',
  workflowSlotId: 'slot-1',
} as const;

describe('terminal-materializer canonical output boundary', () => {
  it.each([
    [{ kind: 'ghost_launch' }, { kind: 'job_fault', fault: { kind: 'ghost_launch' } }],
    [{ kind: 'wrapper_lost' }, { kind: 'job_fault', fault: { kind: 'wrapper_lost' } }],
    [
      { kind: 'wrapper_crashed', cause: { message: 'wrapper exploded' } },
      { kind: 'job_fault', fault: { kind: 'wrapper_crashed', cause: { message: 'wrapper exploded' } } },
    ],
  ] as const)('returns an immediate canonical job outcome for %j', (fault, expected) => {
    const recorder = createContextRecorder();

    const outcome = materializeJobRecoveryFaultInCommit(recorder.c, fault, OPTIONS);

    expect(outcome).toEqual(expected);
    expect(recorder.appended).toEqual([]);
  });

  it.each([
    ['missing_launch_record', { kind: 'missing_launch_record' }],
    ['recovery_parse_failed', { kind: 'recovery_parse_failed', cause: { message: 'partial stderr' } }],
  ] as const)('appends a canonical job progress cause event for %s', (_label, fault) => {
    const recorder = createContextRecorder();

    const outcome = materializeJobRecoveryFaultInCommit(recorder.c, fault, OPTIONS);

    expect(outcome).toEqual({
      kind: 'failed',
      causeRef: recorder.appended[0]?.token,
    });
    expect(recorder.appended[0]?.input).toEqual({
      type: 'job.progress.emitted',
      stream: { kind: 'job', id: 'job-1' },
      refs: {
        jobId: 'job-1',
        sessionId: 'session-1',
        parentJobId: 'parent-1',
        workflowSlotId: 'slot-1',
      },
      body: fault,
    });
  });

  it.each([
    [
      'adapter output',
      {
        type: 'session.adapter_unparseable',
        body: {
          provider: 'claude',
          exitCode: 17,
          stdout: 'partial stdout',
          stderr: 'partial stderr',
          parseError: 'bad json',
        },
      } satisfies ProviderFailureCause,
      'session.adapter_unparseable',
      {
        provider: 'claude',
        exitCode: 17,
        stdout: 'partial stdout',
        stderr: 'partial stderr',
        parseError: 'bad json',
      },
    ],
    [
      'session unavailable',
      providerSessionUnavailable({
        provider: 'claude',
        reason: 'thread missing',
      }),
      'session.provider_failed',
      {
        provider: 'claude',
        reason: 'session_unavailable',
        message: 'thread missing',
      },
    ],
    [
      'request failed',
      providerRequestFailed({
        provider: 'codex',
        message: 'transport reset',
      }),
      'session.provider_failed',
      {
        provider: 'codex',
        reason: 'request_failed',
        message: 'transport reset',
      },
    ],
  ] as const)(
    'materializes provider fault %s into a canonical session event',
    (_kind, fault, expectedType, expectedBody) => {
      const recorder = createContextRecorder();

      const outcome = materializeProviderFailureCauseInCommit(recorder.c, fault, OPTIONS);

      expect(outcome).toEqual({
        kind: 'failed',
        causeRef: recorder.appended[0]?.token,
      });
      expect(recorder.appended[0]?.input).toEqual({
        type: expectedType,
        stream: { kind: 'session', id: 'session-1' },
        refs: {
          jobId: 'job-1',
          sessionId: 'session-1',
          parentJobId: 'parent-1',
          workflowSlotId: 'slot-1',
        },
        body: expectedBody,
      });
    },
  );

  it('returns a token-free provider terminal recipe', () => {
    const recipe = materializeProviderTerminal(
      {
        kind: 'terminal',
        terminal: {
          content: 'done',
          outcome: { kind: 'completed' },
          durationMs: 42,
          usage: { inputTokens: 2 },
          warnings: ['terminal warning'],
        },
        diagnostics: {
          warnings: ['diagnostic warning'],
        },
      },
      OPTIONS,
    );

    expect(recipe).toEqual({
      terminal: {
        content: 'done',
        durationMs: 42,
      },
      outcomePlan: {
        kind: 'immediate',
        domainEvents: [],
        immediateOutcome: { kind: 'completed' },
      },
      diagnostics: {
        warnings: ['terminal warning', 'diagnostic warning'],
        usage: { inputTokens: 2 },
      },
    });
  });

  it('records provider failure causes and terminal events in one commit closure', () => {
    const recorder = createCommitRecorder();
    const terminal = {
      kind: 'terminal',
      terminal: {
        content: 'failed',
        durationMs: 0,
        outcome: { kind: 'failed' },
        exitCode: 1,
      },
      diagnostics: {},
      failureCause: providerRequestFailed({
        provider: 'codex',
        message: 'transport reset',
      }),
    } satisfies ProviderTerminalEventBody;

    recordProviderTerminal(recorder.progressStore, terminal, OPTIONS);

    expect(recorder.appended).toHaveLength(2);
    expect(recorder.appended[0]?.input).toMatchObject({
      type: 'session.provider_failed',
      stream: { kind: 'session', id: 'session-1' },
      body: {
        provider: 'codex',
        reason: 'request_failed',
        message: 'transport reset',
      },
    });
    expect(recorder.appended[1]?.input).toMatchObject({
      type: 'job.terminal.recorded',
      stream: { kind: 'job', id: 'job-1' },
      body: {
        terminal: {
          content: 'failed',
          outcome: {
            kind: 'failed',
            causeRef: recorder.appended[0]?.token,
          },
          durationMs: 0,
        },
        diagnostics: {
          processExit: { exitCode: 1, signal: null },
        },
      },
    });
  });
});
