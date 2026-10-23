import { isRecord } from '#src/infra/json.js';
import { afterEach, describe, expect, it } from 'vitest';

import { jobsRegistry } from '#src/jobs/events.js';
import { providerArtifactIdentityKey } from '#src/providers/artifact-identity.js';
import {
  appendJobExecutionOutcomeAccepted,
  appendJobExecutionEnded,
  failedTerminalOutcome,
} from '#src/jobs/terminal/recording.js';
import {
  jobExecutionOutcomeAcceptedBodySchema,
  jobExecutionEndedBodySchema,
  jobTerminalSchema,
} from '#src/jobs/terminal/result.js';
import { readCommittedExecutionRequest } from '#src/jobs/execution-journal.js';
import { refuseLaunch } from '#src/jobs/launch.js';
import type { CoralEventInput } from '#src/store/envelope.js';
import {
  EXECUTION_JOB_ID as jobId,
  OTHER_EXECUTION_JOB_ID as otherJobId,
  EXECUTION_NOW as now,
  executionHarness,
  executionInput as input,
  openedJob,
  requestedExecution,
} from '#tests/helpers/job-executions.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

function tokenMarker(token: object): { symbol: symbol; commit: object } {
  const symbol = Object.getOwnPropertySymbols(token)[0];
  if (symbol === undefined) throw new Error('Expected a cause token marker.');
  const marker: unknown = Object.getOwnPropertyDescriptor(token, symbol)?.value;
  if (!isRecord(marker) || typeof marker.commit !== 'object' || marker.commit === null) {
    throw new Error('Expected a commit-bound cause token.');
  }
  return { symbol, commit: marker.commit };
}

const harnesses: ReturnType<typeof executionHarness>[] = [];
function harness() {
  const h = executionHarness();
  harnesses.push(h);
  return h;
}
afterEach(() => {
  for (const h of harnesses.splice(0)) h.db.close();
});

const accepted = (execution = 1) =>
  input('job.execution.outcome.accepted', {
    execution,
    terminal: { content: 'done', outcome: { kind: 'completed' }, durationMs: 1 },
  });
const end = (execution = 1, seq = 3, id = jobId) =>
  input('job.execution.ended', { execution, causeRef: { stream: { kind: 'job', id }, seq } });
const retention = (execution = 1) =>
  input('job.retention.discard.requested', { execution, attempt: 0, handles: ['/native'] });
const retained = (execution = 1) =>
  input('job.retention.discard.completed', { execution, attempt: 0, handles: ['/native'], outcome: 'discarded' });
const failedRetention = (execution = 1) =>
  input('job.retention.discard.failed', {
    execution,
    attempt: 0,
    handles: ['/native'],
    reason: 'native file kept: archive unavailable',
  });
const progress = (execution = 1) =>
  input('job.execution.progress', { execution, kind: 'domain', stage: 'working', message: 'work' });

const executionEvents: CoralEventInput[] = [
  requestedExecution(),
  input('job.execution.queued', { execution: 1, queuePosition: 0, runningJobIds: [] }),
  input('job.execution.admitted', { execution: 1 }),
  input('job.execution.started', {
    execution: 1,
    transport: 'app-server',
    startedAt: now,
    providerMeta: { provider: 'codex', leaseState: 'waiting' },
  }),
  progress(),
  input('job.execution.aborted', { execution: 1, reason: 'user_abort' }),
  accepted(),
  end(),
  input('job.continuity.checkpointed', {
    execution: 1,
    snapshot: { conversationRef: 'conversation', resumable: true, providerContinuity: null },
  }),
  input('job.artifact.recorded', {
    execution: 1,
    provider: 'codex',
    handle: '/native',
    identity: { kind: 'native' },
    identityKey: providerArtifactIdentityKey('codex', { kind: 'native' }),
  }),
  retention(),
  retained(),
  failedRetention(),
  input('job.interrupted', { execution: 1, trigger: 'restart', continuity: 'unavailable' }),
  input('job.provider_failed', { execution: 1, provider: 'codex', reason: 'request_failed', message: 'rejected' }),
  input('job.adapter_unparseable', {
    execution: 1,
    provider: 'codex',
    exitCode: 0,
    stdout: '',
    stderr: '',
    parseError: 'invalid output',
  }),
];

function expectOrderFailure(run: () => unknown) {
  expect(run).toThrowError(expect.objectContaining({ code: 'job_execution_order_violation' }));
}

function withExecution(event: CoralEventInput, execution: unknown): CoralEventInput {
  return { ...event, body: { ...(event.body as Record<string, unknown>), execution } };
}

describe('jobs:execution-order', () => {
  it('registers one execution order validator', () => {
    expect(jobsRegistry.appendValidators?.map((entry) => entry.contract)).toEqual(['jobs:execution-order']);
  });

  it.each(executionEvents.map((event) => [event.type, event] as const))('requires an ordinal for %s', (type, event) => {
    const schema = jobsRegistry.entries.find((entry) => entry.type === type)!.schema;
    for (const execution of [undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(schema.safeParse(withExecution(event, execution).body).success).toBe(false);
    expect(schema.safeParse(event.body).success).toBe(true);
  });

  it.each(executionEvents.map((event) => [event.type, event] as const))('requires opened before %s', (_type, event) => {
    const h = harness();
    expectOrderFailure(() => h.append(event));
    expect(h.events()).toEqual([]);
  });

  it('enforces one job for a parent workflow slot in the durable projection', () => {
    const h = harness();
    const refs = { parentJobId: '20000000-0000-4000-8000-000000000001', workflowSlotId: 'review' };
    const first = openedJob({ owner: { kind: 'workflow', id: refs.parentJobId }, workflowSlotId: refs.workflowSlotId });
    h.append({ ...first, refs });
    expect(() => h.append({ ...first, stream: { kind: 'job', id: otherJobId }, refs })).toThrow(
      /UNIQUE constraint failed/u,
    );
  });

  it('opens workflow and KB jobs without a conversation facet', () => {
    const h = harness();
    const workflow = {
      jobKind: 'workflow',
      owner: { kind: 'workflow', id: jobId },
      projectRoot: '/workspace',
      cwd: fixtureCanonicalWorkDir('/workspace'),
      bypassPermissions: false,
      createdAt: now,
    };
    h.append(input('job.opened', workflow), requestedExecution());
    h.complete();
    h.append(
      input(
        'job.opened',
        { jobKind: 'kb', owner: { kind: 'system-task', id: 'kb' }, projectRoot: '/workspace', createdAt: now },
        otherJobId,
      ),
      {
        ...requestedExecution(1, { input: { operation: 'kb.reindex', request: {} } }),
        stream: { kind: 'job', id: otherJobId },
      },
    );
    expect(h.events()).toHaveLength(6);
    expect(() => harness().append(input('job.opened', { ...workflow, conversation: {} }))).toThrow();
    expect(() =>
      harness().append(
        input('job.opened', {
          jobKind: 'provider',
          owner: { kind: 'provider-session', id: jobId },
          projectRoot: '/workspace',
          createdAt: now,
        }),
      ),
    ).toThrow();
  });

  it('requires opened once, both in the same batch and across commits', () => {
    expectOrderFailure(() => harness().append(openedJob(), openedJob()));
    const h = harness();
    h.append(openedJob());
    expectOrderFailure(() => h.append(openedJob()));
  });

  it('starts at 1 and refuses overlapping, repeated or skipped ordinals', () => {
    expectOrderFailure(() => harness().append(openedJob(), requestedExecution(2)));
    expectOrderFailure(() => harness().append(openedJob(), requestedExecution(), requestedExecution(2)));
    const h = harness();
    h.append(openedJob(), requestedExecution());
    h.complete();
    for (const execution of [1, 3]) expectOrderFailure(() => h.append(requestedExecution(execution)));
    h.append(requestedExecution(2));
    expectOrderFailure(() => h.append(requestedExecution(3)));
  });

  it('admits consecutive requests, acceptance and end in one batch', () => {
    const h = harness();
    h.commit((c) => {
      c.append(openedJob());
      for (let execution = 1; execution <= 3; execution++) {
        c.append(requestedExecution(execution));
        const causeRef = appendJobExecutionOutcomeAccepted(c, {
          jobId,
          execution,
          terminal: { content: 'done', durationMs: 0, outcome: { kind: 'completed' } },
        });
        appendJobExecutionEnded(c, { jobId, execution, causeRef });
      }
      return undefined;
    });
    expect(h.events().filter((event) => event.type === 'job.execution.ended')).toHaveLength(3);
  });

  it.each(
    executionEvents
      .filter((event) => event.type !== 'job.execution.requested')
      .map((event) => [event.type, event] as const),
  )('%s must name the open execution', (_type, event) => {
    const h = harness();
    h.append(openedJob(), requestedExecution());
    expectOrderFailure(() => h.append(withExecution(event, 2)));
    h.complete();
    expectOrderFailure(() => h.append(event));
    h.append(requestedExecution(2));
    expectOrderFailure(() => h.append(event));
  });

  it('accepts an outcome at most once in a batch or persisted execution', () => {
    expectOrderFailure(() => harness().append(openedJob(), requestedExecution(), accepted(), accepted()));
    const h = harness();
    h.append(openedJob(), requestedExecution(), accepted());
    expectOrderFailure(() => h.append(accepted()));
    h.append(end());
  });

  it.each(
    executionEvents
      .filter((event) => !event.type.startsWith('job.retention.') && event.type !== 'job.execution.ended')
      .map((event) => [event.type, event] as const),
  )('refuses %s after acceptance', (_type, event) => {
    const h = harness();
    h.append(openedJob(), requestedExecution(), accepted());
    expectOrderFailure(() => h.append(event));
    expectOrderFailure(() => harness().append(openedJob(), requestedExecution(), accepted(), event));
  });

  it('requires the exact accepted outcome and one sole end', () => {
    expectOrderFailure(() => harness().append(openedJob(), requestedExecution(), end()));
    const h = harness();
    h.append(openedJob(), requestedExecution(), accepted());
    for (const event of [
      end(1, 1),
      end(1, 2),
      end(1, 4),
      end(1, 3, otherJobId),
      input('job.execution.ended', { execution: 1, causeRef: { stream: { kind: 'workflow', id: jobId }, seq: 3 } }),
    ])
      expectOrderFailure(() => h.append(event));
    expectOrderFailure(() => h.append(end(), end()));
    h.append(end());
    expectOrderFailure(() => h.append(end()));
    h.append(requestedExecution(2), accepted(2));
    expectOrderFailure(() => h.append(end(2, 3)));
    h.append(end(2, 6));
  });

  it('rejects same-batch cross-execution end citations atomically', () => {
    const h = harness();
    expect(() =>
      h.commit((c) => {
        c.append(openedJob());
        c.append(requestedExecution());
        const first = appendJobExecutionOutcomeAccepted(c, {
          jobId,
          execution: 1,
          terminal: { content: 'one', durationMs: 0, outcome: { kind: 'completed' } },
        });
        appendJobExecutionEnded(c, { jobId, execution: 1, causeRef: first });
        c.append(requestedExecution(2));
        appendJobExecutionOutcomeAccepted(c, {
          jobId,
          execution: 2,
          terminal: { content: 'two', durationMs: 0, outcome: { kind: 'completed' } },
        });
        appendJobExecutionEnded(c, { jobId, execution: 2, causeRef: first });
        return undefined;
      }),
    ).toThrowError(expect.objectContaining({ code: 'job_execution_order_violation' }));
    expect(h.events()).toEqual([]);
  });

  it.each([retained, failedRetention])('requires retention before the sole end for a discard execution', (close) => {
    const h = harness();
    const opened = openedJob();
    if (opened.body.jobKind !== 'provider') throw new Error('provider fixture');
    opened.body.conversation.retention = 'discard_provider_artifacts_on_terminal';
    h.append(opened, requestedExecution(), accepted());
    expectOrderFailure(() => h.append(end()));
    h.append(retention());
    expectOrderFailure(() => h.append(end()));
    h.append(close(), end());
    expectOrderFailure(() => h.append(retention()));
    expect(h.events().at(-1)?.type).toBe('job.execution.ended');
  });

  it('requires one original retention request and matching outcome', () => {
    const h = harness();
    h.append(openedJob(), requestedExecution());
    expectOrderFailure(() => h.append(retention()));
    h.append(accepted());
    expectOrderFailure(() => h.append(retained()));
    h.append(retention());
    expectOrderFailure(() => h.append(retention()));
    expectOrderFailure(() =>
      h.append(
        input('job.retention.discard.completed', {
          execution: 1,
          attempt: 1,
          handles: ['/native'],
          outcome: 'discarded',
        }),
      ),
    );
    expectOrderFailure(() =>
      h.append(
        input('job.retention.discard.failed', { execution: 1, attempt: 0, handles: ['/other'], reason: 'failed' }),
      ),
    );
    h.append(retained());
    expectOrderFailure(() => h.append(failedRetention()));
    h.append(end());
  });

  it('creates no execution for a refusal before requested commits', () => {
    const h = harness();
    expect(refuseLaunch('archive_missing', 'archive unavailable').status).toBe('refused');
    expect(h.events()).toEqual([]);
  });

  it('stores message identity with the input and forbids replay as another execution', () => {
    const h = harness();
    h.append(openedJob(), requestedExecution());
    h.complete();
    h.append(requestedExecution(2, { input: 'durable input', originatingClientMessageId: 'same-message' }));
    const request = readCommittedExecutionRequest(h.db, jobId, 'same-message', h.readCtx);
    expect(request).toEqual({
      jobId,
      requestedSeq: 5,
      request: expect.objectContaining({
        execution: 2,
        input: 'durable input',
        originatingClientMessageId: 'same-message',
      }),
    });
    h.complete(2);
    expectOrderFailure(() => h.append(requestedExecution(3, { originatingClientMessageId: 'same-message' })));
    expect(readCommittedExecutionRequest(h.db, jobId, 'same-message', h.readCtx)).toEqual(request);
    expect(readCommittedExecutionRequest(h.db, otherJobId, 'same-message', h.readCtx)).toBeNull();
  });

  it('preserves durable historical session causes while refusing fresh acceptance with one', () => {
    const terminal = {
      content: '',
      durationMs: 0,
      outcome: { kind: 'failed', causeRef: { stream: { kind: 'session', id: 'old-session' }, seq: 1 } },
    };
    expect(jobTerminalSchema.safeParse(terminal).success).toBe(true);
    expect(jobExecutionOutcomeAcceptedBodySchema.safeParse({ execution: 1, terminal }).success).toBe(false);
    expect(jobExecutionEndedBodySchema.safeParse({ execution: 1, causeRef: terminal.outcome.causeRef }).success).toBe(
      false,
    );
  });

  it('resolves fault → accepted outcome → end references in one real commit', () => {
    const h = harness();
    h.append(openedJob(), requestedExecution());
    h.commit((c) => {
      const fault = c.append(
        input('job.provider_failed', {
          execution: 1,
          provider: 'codex',
          reason: 'request_failed',
          message: 'activation rejected',
        }),
      );
      const accepted = appendJobExecutionOutcomeAccepted(c, {
        jobId,
        execution: 1,
        terminal: { content: '', durationMs: 0, outcome: failedTerminalOutcome(fault) },
      });
      appendJobExecutionEnded(c, { jobId, execution: 1, causeRef: accepted });
      return undefined;
    });
    expect(
      h
        .events()
        .slice(-3)
        .map((event) => event.body),
    ).toEqual([
      expect.objectContaining({ execution: 1, message: 'activation rejected' }),
      {
        execution: 1,
        terminal: {
          content: '',
          durationMs: 0,
          outcome: { kind: 'failed', causeRef: { stream: { kind: 'job', id: jobId }, seq: 3 } },
        },
      },
      { execution: 1, causeRef: { stream: { kind: 'job', id: jobId }, seq: 4 } },
    ]);
  });

  it('rejects forward, malformed, foreign and unsupported-path tokens with atomic rollback', () => {
    const h = harness();
    h.append(openedJob(), requestedExecution());
    let foreign: unknown;
    h.commit((c) => {
      foreign = c.append(progress());
      return undefined;
    });
    const before = h.events();
    expect(() =>
      h.commit((c) => {
        const self = c.append(progress());
        const { symbol, commit } = tokenMarker(self);
        const forward = {
          [symbol]: { slot: 2, commit },
        };
        c.append(
          input('job.execution.outcome.accepted', {
            execution: 1,
            terminal: { content: '', durationMs: 0, outcome: { kind: 'failed', causeRef: forward } },
          }),
        );
        return undefined;
      }),
    ).toThrow(/cannot be referenced/);
    for (const slot of [-1, 0.5, NaN, 999]) {
      expect(() =>
        h.commit((c) => {
          const token = c.append(progress());
          const { symbol, commit } = tokenMarker(token);
          const invalid = {
            [symbol]: { slot, commit },
          };
          c.append(input('job.execution.ended', { execution: 1, causeRef: invalid }));
          return undefined;
        }),
      ).toThrow(/invalid|cannot be referenced/);
    }
    expect(() =>
      h.commit((c) => {
        c.append(progress());
        c.append(input('job.execution.ended', { execution: 1, causeRef: foreign }));
        return undefined;
      }),
    ).toThrow(/foreign/);
    for (const path of ['detail', 'causeRef', 'terminal']) {
      expect(() =>
        h.commit((c) => {
          const token = c.append(progress());
          c.append(
            input('job.execution.progress', {
              execution: 1,
              kind: 'domain',
              stage: 'bad',
              message: 'bad',
              [path]: token,
            }),
          );
          return undefined;
        }),
      ).toThrow(/Tokens may appear only at/);
    }
    expect(() =>
      h.commit((c) => {
        const token = c.append(progress());
        c.append(
          input('job.terminal.recorded', {
            terminal: { content: '', durationMs: 0, outcome: { kind: 'failed', causeRef: token } },
          }),
        );
        return undefined;
      }),
    ).toThrow(/Tokens may appear only at/);
    expect(() =>
      h.commit((c) => {
        const token = c.append(progress());
        c.append(
          input('job.execution.outcome.accepted', {
            execution: 1,
            terminal: { content: '', durationMs: 0, outcome: { kind: 'completed', causeRef: token } },
          }),
        );
        return undefined;
      }),
    ).toThrow(/Tokens may appear only at/);
    expect(h.events()).toEqual(before);
  });
});
