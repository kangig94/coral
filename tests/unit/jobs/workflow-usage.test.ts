import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Database } from '#src/store/db.js';
import type { CoralEventInput } from '#src/store/envelope.js';
import type { UsageSummary } from '#src/providers/contract.js';
import type { TimePort } from '#src/infra/port-types.js';
import { describe, expect, it } from 'vitest';

import { WaitCoordinator } from '#src/jobs/shell/wait.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { composeReducers } from '#src/store/reducers.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { workflowPlanDeclaredEvent, workflowRegistry } from '#src/workflow/events.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { createDefaultStoreReadContext } from '#src/read-model/read-context.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { aggregateWorkflowUsage } from '#src/jobs/workflow-usage.js';
import { loadJobProjectionDetail, loadJobProjectionDetails, readJobEvents } from '#src/jobs/read-queries.js';
import { publishJobEvents, subscribeJobEvents } from '#src/jobs/shell/event-subscription.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';

const projectRoot = '/tmp/workflow-usage-project';
const namespace = 'workflow-usage-ns';
const createdAt = '2026-04-21T00:00:00.000Z';
const readCtx = createDefaultStoreReadContext();
const time = {
  now: () => Date.parse(createdAt),
  monotonicNow: () => BigInt(Date.parse(createdAt)),
  sleep: async (ms: number, options?: { signal?: AbortSignal }) => {
    await new Promise<void>((resolve, reject) => {
      if (options?.signal?.aborted) {
        const reason = options.signal.reason;
        reject(reason instanceof Error ? reason : new Error(String(reason)));
        return;
      }
      const handle = globalThis.setTimeout(resolve, ms);
      options?.signal?.addEventListener(
        'abort',
        () => {
          globalThis.clearTimeout(handle);
          const reason = options.signal?.reason;
          reject(reason instanceof Error ? reason : new Error(String(reason)));
        },
        { once: true },
      );
    });
  },
  setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => {
    if (handle !== null) {
      globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
    }
  },
  setInterval: (fn: () => void, ms: number) => globalThis.setInterval(fn, ms),
  clearInterval: (handle) => {
    if (handle !== null) {
      globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>);
    }
  },
} satisfies TimePort;

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return db;
}

function commit(db: Database, inputs: readonly CoralEventInput[]) {
  return commitInputs(db, inputs, {
    now: () => new Date(createdAt),
    reducers: composeReducers(jobsRegistry, workflowRegistry),
    bodyCodec: createEventBodyCodec(),
    providers: permissiveProviderLookupPort,
  });
}

function launchJob(
  jobId: string,
  options: {
    parentWorkflowJobId?: string;
    workflowSlotId?: string;
    enqueueSequence?: number;
  } & ({ provider: string; jobKind?: 'provider' } | { jobKind: 'workflow' }),
): CoralEventInput {
  const sessionId = `${jobId}-session`;
  const workflow = options.jobKind === 'workflow';
  const workflowOwnerId = workflow ? jobId : options.parentWorkflowJobId;
  return {
    type: 'job.launch.requested',
    stream: { kind: 'job', id: jobId },
    namespace,
    project: projectRoot,
    correlationId: `${jobId}-correlation`,
    refs: {
      ...(workflow ? { workflowId: jobId } : { sessionId }),
      ...(options.parentWorkflowJobId === undefined
        ? {}
        : {
            parentJobId: options.parentWorkflowJobId,
            workflowId: options.parentWorkflowJobId,
            workflowSlotId: options.workflowSlotId,
          }),
    },
    body: {
      owner:
        workflowOwnerId === undefined
          ? { kind: 'provider-session', id: sessionId }
          : { kind: 'workflow', id: workflowOwnerId },
      ...(workflow ? {} : { sessionId, provider: options.provider, providerAction: 'exec' as const }),
      ...(!workflow && options.workflowSlotId !== undefined ? { workflowSlotGeneration: 0 } : {}),
      projectRoot,
      backendNamespace: namespace,
      bundleHash: 'workflow-usage-bundle',
      jobKind: options.jobKind ?? 'provider',
      pool: 'default',
      enqueueSequence: options.enqueueSequence ?? 0,
      request: {
        prompt: `run ${jobId}`,
        cwd: projectRoot,
        bypassPermissions: false,
        coralEnv: {},
      },
      createdAt,
    },
  };
}

function runtimeStarted(jobId: string, jobKind: 'provider' | 'workflow' = 'provider'): CoralEventInput {
  return {
    type: 'job.runtime.started',
    stream: { kind: 'job', id: jobId },
    namespace,
    project: projectRoot,
    correlationId: `${jobId}-correlation`,
    refs: jobKind === 'workflow' ? { workflowId: jobId } : { sessionId: `${jobId}-session` },
    body:
      jobKind === 'workflow'
        ? { transport: 'workflow', startedAt: createdAt }
        : {
            transport: 'durable-cli',
            pid: 123,
            stdoutPath: `/tmp/${jobId}.out`,
            stderrPath: `/tmp/${jobId}.err`,
            startedAt: createdAt,
          },
  };
}

function terminalRecorded(
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
    type: 'job.terminal.recorded',
    stream: { kind: 'job', id: jobId },
    namespace,
    project: projectRoot,
    correlationId: `${jobId}-correlation`,
    refs:
      options.jobKind === 'workflow'
        ? { workflowId: jobId }
        : {
            sessionId: `${jobId}-session`,
            ...(options.parentWorkflowJobId === undefined
              ? {}
              : {
                  parentJobId: options.parentWorkflowJobId,
                  workflowId: options.parentWorkflowJobId,
                  workflowSlotId: options.workflowSlotId,
                }),
          },
    body: {
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
  seedTestSessionProjection(db, {
    sessionId: 'claude-child-session',
    provider: 'claude',
    projectRoot,
    backendNamespace: namespace,
  });
  seedTestSessionProjection(db, {
    sessionId: 'codex-child-session',
    provider: 'codex',
    projectRoot,
    backendNamespace: namespace,
  });

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
    launchJob('claude-child', {
      provider: 'claude',
      parentWorkflowJobId: workflowJobId,
      workflowSlotId: `${workflowJobId}:0:0`,
      enqueueSequence: 2,
    }),
    terminalRecorded('claude-child', {
      parentWorkflowJobId: workflowJobId,
      workflowSlotId: `${workflowJobId}:0:0`,
      usage: {
        inputTokens: 100,
        cacheReadTokens: 50,
        cacheWriteTokens: 10,
        outputTokens: 20,
        costUsd: 0.25,
      },
    }),
    launchJob('codex-child', {
      provider: 'codex',
      parentWorkflowJobId: workflowJobId,
      workflowSlotId: `${workflowJobId}:0:1`,
      enqueueSequence: 3,
    }),
    terminalRecorded('codex-child', {
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
  it('sums child usage from projection rows, including failed children and costless Codex jobs', () => {
    const db = createDb();
    try {
      seedWorkflowWithChildren(db, 'workflow-usage-parent');

      expect(aggregateWorkflowUsage(db, 'workflow-usage-parent')).toEqual({
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
      const workflowJobId = 'workflow-usage-detail';
      seedWorkflowWithChildren(db, workflowJobId);
      commit(db, [terminalRecorded(workflowJobId, { jobKind: 'workflow' })]);

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

  it('attaches workflow aggregate usage through the batch projection detail loader', () => {
    const db = createDb();
    try {
      const workflowJobId = 'workflow-usage-batch-detail';
      seedWorkflowWithChildren(db, workflowJobId);
      commit(db, [terminalRecorded(workflowJobId, { jobKind: 'workflow' })]);

      expect(
        loadJobProjectionDetails(db, [workflowJobId], readCtx).get(workflowJobId)?.exit?.diagnostics.usage,
      ).toEqual({
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

  it('rejects corrupt persisted child diagnostics instead of treating them as absent usage', () => {
    const db = createDb();
    try {
      const workflowJobId = 'workflow-usage-corrupt-child';
      seedWorkflowWithChildren(db, workflowJobId);
      db.prepare('UPDATE projection_jobs SET diagnostics = ? WHERE job_id = ?').run('{not-json', 'codex-child');

      expect(() => aggregateWorkflowUsage(db, workflowJobId)).toThrow();
    } finally {
      db.close();
    }
  });

  it('computes workflow usage for live wait terminal events through the resolver dependency', async () => {
    const db = createDb();
    try {
      const workflowJobId = 'workflow-usage-live-wait';
      seedWorkflowWithChildren(db, workflowJobId);

      const coordinator = new WaitCoordinator({
        sessionManager: {} as never,
        launchQueue: { queuePosition: () => null, getActiveJobIds: () => [] } as never,
        eventBus: {} as never,
        jobPools: new Map(),
        time,
        loadJobProjectionDetail: (jobId) => loadJobProjectionDetail(db, jobId, readCtx),
        readJobEvents: (jobId) => readJobEvents(db, jobId, readCtx),
        aggregateWorkflowUsage: (jobId) => aggregateWorkflowUsage(db, jobId),
        subscribeJobEvents,
        getCurrentJournalSeq: () =>
          (db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq,
        resultJobsRoot: '/tmp/workflow-usage-results',
      });

      const iterator = coordinator.waitForJobs({ jobIds: [workflowJobId], timeoutSeconds: 1 })[Symbol.asyncIterator]();
      const next = iterator.next();
      publishJobEvents(commit(db, [terminalRecorded(workflowJobId, { jobKind: 'workflow' })]));

      const terminal = await next;
      expect(terminal.done).toBe(false);
      expect(terminal.value).toMatchObject({
        type: 'terminal',
        jobId: workflowJobId,
        usage: {
          inputTokens: 107,
          cacheReadTokens: 53,
          cacheWriteTokens: 10,
          outputTokens: 25,
          costUsd: 0.25,
          jobsWithoutCostData: 1,
        },
      });
      await iterator.return?.(undefined);
    } finally {
      db.close();
    }
  });
});
