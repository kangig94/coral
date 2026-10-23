import { executionHarness, openedJob, requestedExecution } from '#tests/helpers/job-executions.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { JobStore } from '#src/jobs/store.js';
import { createTestExecutionFinisher } from '#tests/helpers/execution-finisher.js';
import { describe, expect, it } from 'vitest';
import type { CauseRefToken } from '#src/causality/cause-ref.js';
import type { CommitContext } from '#src/store/append.js';
import type { ResolvableCoralEventInput } from '#src/store/envelope.js';
import { providerRequestFailed, type ProviderFailureCause } from '#src/providers/fault.js';
import type { ProviderTerminalEventBody } from '#src/providers/contract.js';
import {
  materializeJobRecoveryFaultInCommit,
  materializeProviderFailureCauseInCommit,
  materializeProviderTerminal,
  appendProviderTerminalInCommit,
} from '#src/coordinator/services/terminal-materializer.js';

type RecordedInput = {
  input: ResolvableCoralEventInput<unknown, unknown>;
  token: CauseRefToken<unknown>;
};

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
  jobId: 'f10f3e57-0d04-53df-b4c3-3bcf75a1222d',
  execution: 1,
  parentJobId: 'parent-1',
  workflowSlotId: 'slot-1',
} as const;

describe('terminal-materializer canonical output boundary', () => {
  it.each([[{ kind: 'ghost_launch' }, { kind: 'job_fault', fault: { kind: 'ghost_launch' } }]] as const)(
    'returns an immediate canonical job outcome for %j',
    (fault, expected) => {
      const recorder = createContextRecorder();

      const outcome = materializeJobRecoveryFaultInCommit(recorder.c, fault, OPTIONS);

      expect(outcome).toEqual(expected);
      expect(recorder.appended).toEqual([]);
    },
  );

  it.each([['missing_launch_record', { kind: 'missing_launch_record' }]] as const)(
    'appends a canonical job progress cause event for %s',
    (_label, fault) => {
      const recorder = createContextRecorder();

      const outcome = materializeJobRecoveryFaultInCommit(recorder.c, fault, OPTIONS);

      expect(outcome).toEqual({
        kind: 'failed',
        causeRef: recorder.appended[0]?.token,
      });
      expect(recorder.appended[0]?.input).toEqual({
        type: 'job.execution.progress',
        stream: { kind: 'job', id: 'f10f3e57-0d04-53df-b4c3-3bcf75a1222d' },
        refs: {
          jobId: 'f10f3e57-0d04-53df-b4c3-3bcf75a1222d',
          parentJobId: 'parent-1',
          workflowSlotId: 'slot-1',
        },
        body: { ...fault, execution: 1 },
      });
    },
  );

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
      'job.adapter_unparseable',
      {
        provider: 'claude',
        exitCode: 17,
        stdout: 'partial stdout',
        stderr: 'partial stderr',
        parseError: 'bad json',
      },
    ],
    [
      'request failed',
      providerRequestFailed({
        provider: 'codex',
        message: 'transport reset',
      }),
      'job.provider_failed',
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
        stream: { kind: 'job', id: 'f10f3e57-0d04-53df-b4c3-3bcf75a1222d' },
        refs: {
          jobId: 'f10f3e57-0d04-53df-b4c3-3bcf75a1222d',
          parentJobId: 'parent-1',
          workflowSlotId: 'slot-1',
        },
        body: { ...expectedBody, execution: 1 },
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

  it('records provider failure causes and terminal events in one commit closure', async () => {
    const journal = executionHarness();
    const stream = { kind: 'job', id: OPTIONS.jobId } as const;
    journal.append(
      { ...openedJob({ owner: { kind: 'provider-session', id: OPTIONS.jobId } }), stream },
      { ...requestedExecution(), stream },
    );
    const runtime = new SimulationRuntime();
    const store = new JobStore('tests', runtime, journal.ctx.bodyCodec, {
      db: journal.db,
      reducers: journal.ctx.reducers,
      providers: journal.ctx.providers,
    });
    const finisher = createTestExecutionFinisher(store, runtime);
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

    const acceptedCause = await finisher.accept(OPTIONS, (commit) => {
      appendProviderTerminalInCommit(commit, terminal, OPTIONS);
      return undefined;
    });
    await finisher.finish(OPTIONS);
    const appended = journal
      .events()
      .filter((event) => event.type === 'job.provider_failed' || event.type === 'job.execution.outcome.accepted');

    expect(appended).toHaveLength(2);
    expect(appended[0]).toMatchObject({
      type: 'job.provider_failed',
      body: {
        provider: 'codex',
        reason: 'request_failed',
        message: 'transport reset',
      },
    });
    expect(appended[1]).toMatchObject({
      type: 'job.execution.outcome.accepted',
      body: {
        terminal: {
          content: 'failed',
          outcome: {
            kind: 'failed',
            causeRef: { stream, seq: appended[0]?.seq },
          },
          durationMs: 0,
        },
        diagnostics: {
          processExit: { exitCode: 1, signal: null },
        },
      },
    });
    expect(acceptedCause.seq).toBe(appended[1]?.seq);
    journal.db.close();
  });
});
