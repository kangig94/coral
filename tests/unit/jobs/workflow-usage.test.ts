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
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { createDefaultStoreReadContext } from '#src/read-model/read-context.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { TEST_PROVIDER_CREDENTIALS } from '#tests/helpers/provider-credentials.js';
import { aggregateWorkflowUsage } from '#src/jobs/workflow-usage.js';
import { loadJobProjectionDetail, loadJobProjectionDetails, readJobEvents } from '#src/jobs/read-queries.js';
import { publishJobEvents, subscribeJobEvents } from '#src/jobs/shell/event-subscription.js';

const projectRoot = '/tmp/workflow-usage-project';
const namespace = 'workflow-usage-ns';
const createdAt = '2026-04-21T00:00:00.000Z';
const readCtx = createDefaultStoreReadContext();
const time = {
  now: () => Date.parse(createdAt),
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
  applyBundledStoreSchema(db);
  return db;
}

function commit(db: Database, inputs: readonly CoralEventInput[]) {
  return commitInputs(db, inputs, {
    now: () => new Date(createdAt),
    reducers: composeReducers(jobsRegistry),
    upcasters: createDefaultUpcasterRegistry(),
    providers: permissiveProviderLookupPort,
  });
}

function launchJob(
  jobId: string,
  options: {
    provider: string;
    jobKind?: 'provider' | 'workflow';
    parentWorkflowJobId?: string;
    enqueueSequence?: number;
  },
): CoralEventInput {
  const sessionId = `${jobId}-session`;
  return {
    type: 'job.launch.requested',
    stream: { kind: 'job', id: jobId },
    namespace,
    project: projectRoot,
    correlationId: `${jobId}-correlation`,
    refs: {
      sessionId,
      ...(options.parentWorkflowJobId === undefined
        ? {}
        : {
            parentJobId: options.parentWorkflowJobId,
            workflowSlotId: `${options.parentWorkflowJobId}:${jobId}`,
          }),
    },
    bodyVersion: 1,
    body: {
      sessionId,
      provider: options.provider,
      providerAction: 'exec',
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
        ...(options.jobKind === 'workflow' ? { providerCredentials: TEST_PROVIDER_CREDENTIALS } : {}),
      },
      createdAt,
    },
  };
}

function runtimeStarted(jobId: string): CoralEventInput {
  return {
    type: 'job.runtime.started',
    stream: { kind: 'job', id: jobId },
    namespace,
    project: projectRoot,
    correlationId: `${jobId}-correlation`,
    refs: { sessionId: `${jobId}-session` },
    bodyVersion: 1,
    body: {
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
    refs: { sessionId: `${jobId}-session` },
    bodyVersion: 1,
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
  commit(db, [
    launchJob(workflowJobId, { provider: 'workflow', jobKind: 'workflow', enqueueSequence: 1 }),
    runtimeStarted(workflowJobId),
    launchJob('claude-child', { provider: 'claude', parentWorkflowJobId: workflowJobId, enqueueSequence: 2 }),
    terminalRecorded('claude-child', {
      usage: {
        inputTokens: 100,
        cacheReadTokens: 50,
        cacheWriteTokens: 10,
        outputTokens: 20,
        costUsd: 0.25,
      },
    }),
    launchJob('codex-child', { provider: 'codex', parentWorkflowJobId: workflowJobId, enqueueSequence: 3 }),
    terminalRecorded('codex-child', {
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
      commit(db, [terminalRecorded(workflowJobId)]);

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
        diagnostics: string | null;
      };
      expect(stored.diagnostics === null ? {} : JSON.parse(stored.diagnostics)).not.toHaveProperty('usage');
    } finally {
      db.close();
    }
  });

  it('attaches workflow aggregate usage through the batch projection detail loader', () => {
    const db = createDb();
    try {
      const workflowJobId = 'workflow-usage-batch-detail';
      seedWorkflowWithChildren(db, workflowJobId);
      commit(db, [terminalRecorded(workflowJobId)]);

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

  it('skips corrupt child diagnostics when aggregating workflow usage', () => {
    const db = createDb();
    try {
      const workflowJobId = 'workflow-usage-corrupt-child';
      seedWorkflowWithChildren(db, workflowJobId);
      db.prepare('UPDATE projection_jobs SET diagnostics = ? WHERE job_id = ?').run('{not-json', 'codex-child');

      expect(aggregateWorkflowUsage(db, workflowJobId)).toEqual({
        inputTokens: 100,
        cacheReadTokens: 50,
        cacheWriteTokens: 10,
        outputTokens: 20,
        costUsd: 0.25,
      });
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
      publishJobEvents(commit(db, [terminalRecorded(workflowJobId)]));

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
