import { readFileSync } from 'node:fs';

import { commit, type AppendContext, type CommitEventsFn } from '#src/store/append.js';
import type { CoralEventInput } from '#src/store/envelope.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers, type DomainEventRegistry } from '#src/store/reducers.js';
import { jobsRegistry } from '#src/jobs/events.js';
import type { JobOpenedBody, JobExecutionRequestedBody } from '#src/jobs/launch.js';
import { appendJobExecutionOutcomeAccepted, appendJobExecutionEnded } from '#src/jobs/terminal/recording.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

export const EXECUTION_JOB_ID = '10000000-0000-4000-8000-000000000001';
export const OTHER_EXECUTION_JOB_ID = '10000000-0000-4000-8000-000000000002';
export const EXECUTION_NOW = '2026-10-22T00:00:00.000Z';

export function executionInput<Body>(type: string, body: Body, jobId = EXECUTION_JOB_ID): CoralEventInput<Body> {
  return { type, stream: { kind: 'job', id: jobId }, body };
}

export function openedJob(
  overrides: Partial<Extract<JobOpenedBody, { jobKind: 'provider' }>> = {},
): CoralEventInput<JobOpenedBody> {
  return executionInput('job.opened', {
    jobKind: 'provider',
    owner: { kind: 'provider-session', id: EXECUTION_JOB_ID },
    projectRoot: '/workspace',
    createdAt: EXECUTION_NOW,
    conversation: {
      provider: 'codex',
      binding: { provider: 'codex', kind: 'profile', binding: {} },
      cwd: fixtureCanonicalWorkDir('/workspace'),
      name: 'execution-order',
      bypassPermissions: false,
      retention: 'retain',
    },
    ...overrides,
  });
}

export function requestedExecution(
  execution = 1,
  overrides: Partial<JobExecutionRequestedBody> = {},
): CoralEventInput<JobExecutionRequestedBody> {
  return executionInput('job.execution.requested', {
    execution,
    input: `input #${execution}`,
    action: execution === 1 ? 'exec' : 'resume',
    pool: 'default',
    enqueueSequence: execution,
    coralEnv: {},
    createdAt: EXECUTION_NOW,
    backendNamespace: 'tests',
    ...(execution === 1 ? {} : { originatingClientMessageId: `message-${execution}` }),
    ...overrides,
  });
}

export function executionHarness(...registries: DomainEventRegistry[]) {
  const db = newRawDatabase(':memory:');
  db.exec(readFileSync(new URL('../../src/store/schema.sql', import.meta.url), 'utf8'));
  const reducers = composeReducers(jobsRegistry, ...registries);
  const bodyCodec = createEventBodyCodec();
  const ctx: AppendContext = {
    now: () => new Date(EXECUTION_NOW),
    reducers,
    bodyCodec,
    providers: permissiveProviderLookupPort,
  };
  const readCtx = { schemas: reducers.schemas, streamKinds: reducers.streamKinds, bodyCodec };
  const commitEvents: CommitEventsFn = (cb) => commit(db, cb, ctx);
  const append = (...inputs: CoralEventInput[]) =>
    commit(
      db,
      (c) => {
        for (const input of inputs) c.append(input as Parameters<typeof c.append>[0]);
        return undefined;
      },
      ctx,
    );
  const complete = (execution = 1) =>
    commit(
      db,
      (c) => {
        const accepted = appendJobExecutionOutcomeAccepted(c, {
          jobId: EXECUTION_JOB_ID,
          execution,
          terminal: { content: 'done', outcome: { kind: 'completed' }, durationMs: 1 },
        });
        appendJobExecutionEnded(c, { jobId: EXECUTION_JOB_ID, execution, causeRef: accepted });
        return undefined;
      },
      ctx,
    );
  const events = () =>
    db
      .prepare<[], { seq: number; type: string; body: Uint8Array }>('SELECT seq, type, body FROM events ORDER BY seq')
      .all()
      .map((row) => ({ ...row, body: JSON.parse(Buffer.from(row.body).toString('utf8')) as unknown }));
  return { db, ctx, readCtx, commit: commitEvents, append, complete, events };
}
