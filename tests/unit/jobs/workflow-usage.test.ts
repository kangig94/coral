import { workflowDeclaredBodySchema } from '#src/workflow/events.js';
import { jobOpenedBodySchema, jobExecutionRequestedBodySchema } from '#src/jobs/launch.js';
import { jobRuntimeStartedBodySchema, jobProgressBodySchema } from '#src/jobs/event-bodies.js';
import { jobExecutionOutcomeAcceptedBodySchema } from '#src/jobs/terminal/result.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Database } from '#src/store/db.js';
import type { CoralEventInput } from '#src/store/envelope.js';
import type { UsageSummary } from '#src/providers/contract.js';

import { describe, expect, it } from 'vitest';

import { applyBundledStoreSchema } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { commit as commitEvents } from '#src/store/append.js';
import { appendJobExecutionEnded } from '#src/jobs/terminal/recording.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { composeReducers } from '#src/store/reducers.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { workflowPlanDeclaredEvent, workflowRegistry } from '#src/workflow/events.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { createDefaultStoreReadContext } from '#src/read-model/read-context.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { aggregateWorkflowUsage } from '#src/jobs/workflow-usage.js';
import { loadJobProjectionDetail, readJobEvents } from '#src/jobs/read-queries.js';

import { testConversationFacet } from '#tests/helpers/session.js';

const projectRoot = '/tmp/workflow-usage-project';
const namespace = 'workflow-usage-ns';
const createdAt = '2026-04-21T00:00:00.000Z';
const readCtx = createDefaultStoreReadContext();

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return db;
}

function commit(db: Database, inputs: readonly (CoralEventInput | readonly CoralEventInput[])[]) {
  return commitEvents(
    db,
    (c) => {
      for (const input of inputs.flat()) {
        const body =
          input.type === 'job.opened'
            ? jobOpenedBodySchema.parse(input.body)
            : input.type === 'job.execution.requested'
              ? jobExecutionRequestedBodySchema.parse(input.body)
              : input.type === 'job.execution.started'
                ? jobRuntimeStartedBodySchema.parse(input.body)
                : input.type === 'job.execution.progress'
                  ? jobProgressBodySchema.parse(input.body)
                  : input.type === 'job.execution.outcome.accepted'
                    ? jobExecutionOutcomeAcceptedBodySchema.parse(input.body)
                    : workflowDeclaredBodySchema.parse(input.body);
        const causeRef = c.append({ ...input, body });
        if (input.type === 'job.execution.outcome.accepted') {
          appendJobExecutionEnded(c, {
            jobId: input.stream.id,
            execution: 1,
            causeRef,
            namespace: input.namespace,
            project: input.project,
          });
        }
      }
      return undefined;
    },
    {
      now: () => new Date(createdAt),
      reducers: composeReducers(jobsRegistry, workflowRegistry),
      bodyCodec: createEventBodyCodec(),
      providers: permissiveProviderLookupPort,
    },
  );
}

function launchJob(
  jobId: string,
  options: {
    parentWorkflowJobId?: string;
    workflowSlotId?: string;
    enqueueSequence?: number;
  } & ({ provider: string; jobKind?: 'provider' } | { jobKind: 'workflow' }),
): CoralEventInput[] {
  const workflow = options.jobKind === 'workflow';
  const owner =
    workflow || options.parentWorkflowJobId !== undefined
      ? { kind: 'workflow', id: options.parentWorkflowJobId ?? jobId }
      : { kind: 'provider-session', id: jobId };
  const refs = {
    jobId,
    ...(workflow ? { workflowId: jobId } : {}),
    ...(options.parentWorkflowJobId === undefined
      ? {}
      : {
          parentJobId: options.parentWorkflowJobId,
          workflowId: options.parentWorkflowJobId,
          workflowSlotId: options.workflowSlotId,
        }),
  };
  const event = {
    stream: { kind: 'job' as const, id: jobId },
    namespace,
    project: projectRoot,
    correlationId: `${jobId}-correlation`,
    refs,
  };
  return [
    {
      ...event,
      type: 'job.opened',
      body: {
        owner,
        projectRoot,
        createdAt,
        ...(workflow
          ? { jobKind: 'workflow', cwd: fixtureCanonicalWorkDir(projectRoot), bypassPermissions: false }
          : {
              jobKind: 'provider',
              conversation: testConversationFacet(options.provider, projectRoot),
              workflowSlotId: options.workflowSlotId,
            }),
      },
    },
    {
      ...event,
      type: 'job.execution.requested',
      body: {
        execution: 1,
        input: `run ${jobId}`,
        action: 'exec',
        pool: 'default',
        enqueueSequence: options.enqueueSequence ?? 0,
        coralEnv: {},
        createdAt,
        backendNamespace: namespace,
        bundleHash: 'workflow-usage-bundle',
      },
    },
  ];
}

function runtimeStarted(jobId: string, jobKind: 'provider' | 'workflow' = 'provider'): CoralEventInput {
  return {
    type: 'job.execution.started',
    stream: { kind: 'job', id: jobId },
    namespace,
    project: projectRoot,
    correlationId: `${jobId}-correlation`,
    refs: jobKind === 'workflow' ? { workflowId: jobId } : { jobId },
    body:
      jobKind === 'workflow'
        ? { execution: 1, transport: 'workflow', startedAt: createdAt }
        : {
            execution: 1,
            transport: 'durable-cli',
            pid: 123,
            stdoutPath: `/tmp/${jobId}.out`,
            stderrPath: `/tmp/${jobId}.err`,
            startedAt: createdAt,
          },
  };
}

function outcomeAccepted(
  jobId: string,
  options: {
    jobKind?: 'provider' | 'workflow';
    parentWorkflowJobId?: string;
    workflowSlotId?: string;
    usage?: UsageSummary;
    outcome?: { kind: 'completed' } | { kind: 'provider_exit'; code: number; note?: string };
  } = {},
): CoralEventInput {
  return {
    type: 'job.execution.outcome.accepted',
    stream: { kind: 'job', id: jobId },
    namespace,
    project: projectRoot,
    correlationId: `${jobId}-correlation`,
    refs:
      options.jobKind === 'workflow'
        ? { workflowId: jobId }
        : {
            jobId,
            ...(options.parentWorkflowJobId === undefined
              ? {}
              : {
                  parentJobId: options.parentWorkflowJobId,
                  workflowId: options.parentWorkflowJobId,
                  workflowSlotId: options.workflowSlotId,
                }),
          },
    body: {
      execution: 1,
      terminal: {
        content: `${jobId} result`,
        outcome: options.outcome ?? { kind: 'completed' },
        durationMs: 10,
      },
      ...(options.usage === undefined ? {} : { diagnostics: { usage: options.usage } }),
    },
  };
}

function seedWorkflowWithChildren(db: Database, workflowJobId: string): void {
  commit(db, [
    workflowPlanDeclaredEvent(
      workflowJobId,
      {
        slots: [
          {
            slotId: `${workflowJobId}:0:0`,
            dependencies: [],
            provider: 'claude',
            instruction: 'aggregate Claude usage',
          },
          {
            slotId: `${workflowJobId}:0:1`,
            dependencies: [],
            provider: 'codex',
            instruction: 'aggregate Codex usage',
          },
        ],
      },
      TEST_PROVIDER_SCOPE,
    ),
    launchJob(workflowJobId, { jobKind: 'workflow', enqueueSequence: 1 }),
    runtimeStarted(workflowJobId, 'workflow'),
    launchJob('10000000-0000-4000-8000-000000000004', {
      provider: 'claude',
      parentWorkflowJobId: workflowJobId,
      workflowSlotId: `${workflowJobId}:0:0`,
      enqueueSequence: 2,
    }),
    outcomeAccepted('10000000-0000-4000-8000-000000000004', {
      parentWorkflowJobId: workflowJobId,
      workflowSlotId: `${workflowJobId}:0:0`,
      usage: {
        inputTokens: 100,
        cacheReadTokens: 50,
        cacheWriteTokens: 10,
        outputTokens: 20,
        costUsd: 0.25,
        jobsWithoutCostData: 7,
      },
    }),
    launchJob('10000000-0000-4000-8000-000000000005', {
      provider: 'codex',
      parentWorkflowJobId: workflowJobId,
      workflowSlotId: `${workflowJobId}:0:1`,
      enqueueSequence: 3,
    }),
    outcomeAccepted('10000000-0000-4000-8000-000000000005', {
      parentWorkflowJobId: workflowJobId,
      workflowSlotId: `${workflowJobId}:0:1`,
      outcome: { kind: 'provider_exit', code: 1, note: 'failed after spending tokens' },
      usage: {
        inputTokens: 7,
        cacheReadTokens: 3,
        outputTokens: 5,
      },
    }),
  ]);
}

function terminalEvent(events: ReturnType<typeof readJobEvents>) {
  const event = events.find((candidate) => candidate.type === 'terminal');
  if (!event || event.type !== 'terminal') {
    throw new Error('Expected terminal event');
  }
  return event;
}

describe('workflow usage aggregation', () => {
  it('counts every storage row on repeated detail reads, including workflow child diagnostics', () => {
    const db = createDb();
    try {
      seedWorkflowWithChildren(db, '10000000-0000-4000-8000-000000000001');
      const counts = new Map<string, number>();
      const observation = {
        record(source: string, count: { reads?: number }) {
          counts.set(source, (counts.get(source) ?? 0) + (count.reads ?? 0));
        },
      };
      loadJobProjectionDetail(db, '10000000-0000-4000-8000-000000000001', readCtx, observation);
      expect(counts.get('job-projections')).toBe(1);
      expect(counts.get('job-details')).toBe(3);
      expect(counts.get('workflow-child-diagnostics')).toBe(2);
      loadJobProjectionDetail(db, '10000000-0000-4000-8000-000000000001', readCtx, observation);
      expect(counts.get('job-projections')).toBe(2);
      expect(counts.get('job-details')).toBe(6);
      expect(counts.get('workflow-child-diagnostics')).toBe(4);
      db.prepare('UPDATE projection_jobs SET parent_workflow_job_id = NULL WHERE job_id = ?').run(
        '10000000-0000-4000-8000-000000000005',
      );
      counts.clear();
      loadJobProjectionDetail(db, '10000000-0000-4000-8000-000000000001', readCtx, observation);
      expect(counts.get('workflow-child-diagnostics')).toBe(1);
    } finally {
      db.close();
    }
  });

  it('sums child usage from projection rows, including failed children and costless Codex jobs', () => {
    const db = createDb();
    try {
      seedWorkflowWithChildren(db, '10000000-0000-4000-8000-000000000002');

      expect(aggregateWorkflowUsage(db, '10000000-0000-4000-8000-000000000002')).toEqual({
        inputTokens: 107,
        cacheReadTokens: 53,
        cacheWriteTokens: 10,
        outputTokens: 25,
        costUsd: 0.25,
        jobsWithoutCostData: 1,
      });
    } finally {
      db.close();
    }
  });

  it('attaches workflow aggregate usage to detail and replay surfaces without storing it on the workflow row', () => {
    const db = createDb();
    try {
      const workflowJobId = '10000000-0000-4000-8000-000000000003';
      seedWorkflowWithChildren(db, workflowJobId);
      commit(db, [outcomeAccepted(workflowJobId, { jobKind: 'workflow' })]);

      const expectedUsage = {
        inputTokens: 107,
        cacheReadTokens: 53,
        cacheWriteTokens: 10,
        outputTokens: 25,
        costUsd: 0.25,
        jobsWithoutCostData: 1,
      };

      expect(loadJobProjectionDetail(db, workflowJobId, readCtx).exit?.diagnostics.usage).toEqual(expectedUsage);
      expect(terminalEvent(readJobEvents(db, workflowJobId, readCtx)).usage).toEqual(expectedUsage);

      const stored = db.prepare('SELECT diagnostics FROM projection_jobs WHERE job_id = ?').get(workflowJobId) as {
        diagnostics: string;
      };
      expect(JSON.parse(stored.diagnostics)).not.toHaveProperty('usage');
    } finally {
      db.close();
    }
  });
});
