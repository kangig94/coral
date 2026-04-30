import * as fs from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { JobStore } from '#src/jobs/store.js';
import { SimulationRuntime } from '#tools/simulation/core/backend.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import type { JobTerminal } from '#src/jobs/records.js';
import type { WaitStreamEvent, WaitStreamRequest } from '#src/jobs/wait.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { parseExpression } from '#src/workflow/parser.js';
import { workflowPlanDeclaredEvent } from '#src/workflow/events.js';
import { buildWorkflowPlan, type WorkflowPlan } from '#src/workflow/plan.js';
import { commitWorkflowEvents } from '#src/workflow/projections.js';
import { resumeAll } from '#src/workflow/recover.js';
import type { WorkflowExecutionPort } from '#src/workflow/command.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';

// NOTE: "running" and "queued" branches today share the same code path
// (both hit waitForAtoms). We retain two tests so that if phase-differentiated
// behavior is added later, the test scaffold already exists. The distinct
// third branch ("absent" -> relaunch) is the genuine divergence.

const SCHEMAS_DIR = join(process.cwd(), 'src/store/schemas');
const storageAdapter = {
  readdirSync: (path: string, opts: { withFileTypes: true }) => fs.readdirSync(path, opts),
  readFileSync: (path: string, enc: 'utf-8') => fs.readFileSync(path, enc),
};
const PROJECT_ROOT = '/tmp/coral-workflow-project';
const BACKEND_NAMESPACE = 'workflow-test-ns';

function running(job: string, session: string) {
  return {
    status: 'running' as const,
    job,
    session,
  };
}

function terminal(jobId: string, content: string): WaitStreamEvent {
  const result: JobTerminal = { content, outcome: { kind: 'completed' } };
  return {
    type: 'terminal',
    jobId,
    remainingJobIds: [],
    resultPath: `/tmp/coral-exports/jobs/${jobId}/result.md`,
    result,
  };
}

async function* emit(events: WaitStreamEvent[]): AsyncGenerator<WaitStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

function createWorkflowPlan(): WorkflowPlan {
  return buildWorkflowPlan('workflow-1', parseExpression('architect'), {
    defaultProvider: 'codex',
  });
}

function createHarness(options: {
  atomPhase: 'running' | 'queued' | null;
  projectionPhase: 'running' | 'queued' | null;
  projectionLastSeq?: number;
}) {
  const db = new Database(':memory:');
  applyStoreSchemas({ db, storage: storageAdapter as never, schemasDir: SCHEMAS_DIR });

  const runtime = new SimulationRuntime();
  const progressStore = new JobStore(BACKEND_NAMESPACE, runtime, createDefaultUpcasterRegistry(), {
    db,
    providers: permissiveProviderLookupPort,
  });
  const plan = createWorkflowPlan();
  const atomJobId = plan.slots[0].slotId;
  commitWorkflowEvents(
    db,
    (c) => {
      c.append(workflowPlanDeclaredEvent('workflow-1', plan));
      return undefined;
    },
    runtime.time,
    permissiveProviderLookupPort,
  );

  progressStore.initJob({
    jobId: 'workflow-1',
    sessionId: 'workflow-session-1',
    provider: 'codex',
    projectRoot: PROJECT_ROOT,
    backendNamespace: BACKEND_NAMESPACE,
    jobKind: 'workflow',
    initialPhase: 'running',
  });

  if (options.atomPhase !== null) {
    progressStore.initJob({
      jobId: atomJobId,
      sessionId: 'session-atom-1',
      provider: 'codex',
      projectRoot: PROJECT_ROOT,
      backendNamespace: BACKEND_NAMESPACE,
      initialPhase: options.atomPhase,
    });
  }

  if (options.projectionPhase !== null) {
    db.prepare(
      `INSERT INTO projection_jobs (
         job_id, phase, session_id, provider, project_root, backend_namespace,
         job_kind, parent_workflow_job_id, workflow_slot, created_at, last_seq
	       )
	       VALUES (?, ?, ?, ?, ?, ?, 'provider', ?, ?, '2026-04-20T00:00:00.000Z', ?)
	       ON CONFLICT(job_id) DO UPDATE SET
	         phase = excluded.phase,
	         session_id = excluded.session_id,
	         provider = excluded.provider,
	         project_root = excluded.project_root,
	         backend_namespace = excluded.backend_namespace,
	         job_kind = excluded.job_kind,
	         parent_workflow_job_id = excluded.parent_workflow_job_id,
	         workflow_slot = excluded.workflow_slot,
	         created_at = excluded.created_at,
	         last_seq = excluded.last_seq`,
    ).run(
      atomJobId,
      options.projectionPhase,
      'session-atom-1',
      'codex',
      PROJECT_ROOT,
      BACKEND_NAMESPACE,
      'workflow-1',
      plan.slots[0].slotId,
      options.projectionLastSeq ?? 7,
    );
  }

  const waitRequests: WaitStreamRequest[] = [];
  const executionSvc: WorkflowExecutionPort & {
    coralDispatch: ReturnType<typeof vi.fn>;
    waitStream: ReturnType<typeof vi.fn>;
    awaitLaunch: ReturnType<typeof vi.fn>;
  } = {
    coralDispatch: vi.fn(async (_provider, _coralName, input) =>
      running(String(input.jobId ?? 'relaunched-atom-1'), `session-${String(input.jobId ?? 'relaunched-atom-1')}`),
    ),
    resume: vi.fn(async () => running('job-resumed', 'session-resumed')),
    abort: vi.fn(() => ({ aborted: [], notFound: [] })),
    awaitLaunch: vi.fn(async (): Promise<'ready'> => 'ready'),
    waitStream: vi.fn((req: WaitStreamRequest) => {
      waitRequests.push({
        ...req,
        jobIds: [...req.jobIds],
        ...(req.cursor ? { cursor: { afterSeq: req.cursor.afterSeq } } : {}),
      });
      return emit(req.jobIds.map((jobId) => terminal(jobId, `result:${jobId}`)));
    }),
    waitForJobTerminal: vi.fn(async () => {}),
    cleanupWorkflowSessions: vi.fn(),
  };

  const createInvocationContext = (projectRoot: string): InvocationContext => ({
    projectRoot,
    pluginRoot: '/tmp/coral-workflow-plugin',
    coralEnv: {},
  });

  return { db, plan, progressStore, executionSvc, createInvocationContext, waitRequests };
}

describe('workflow recovery branch rules', () => {
  it('uses waitForAtoms only when projection_jobs.phase is running', async () => {
    const harness = createHarness({ atomPhase: 'running', projectionPhase: 'running', projectionLastSeq: 17 });
    try {
      const resumed = await resumeAll({
        db: harness.db,
        progressStore: harness.progressStore,
        getExecutionService: () => harness.executionSvc,
        createInvocationContext: harness.createInvocationContext,
        finalizeWorkflow: vi.fn(),
        time: { now: () => Date.now() },
      });

      expect(resumed).toEqual(['workflow-1']);
      expect(harness.executionSvc.coralDispatch).not.toHaveBeenCalled();
      expect(harness.executionSvc.awaitLaunch).not.toHaveBeenCalled();
      expect(harness.executionSvc.waitStream).toHaveBeenCalledTimes(1);
      expect(harness.waitRequests[0]).toEqual({
        jobIds: [harness.plan.slots[0].slotId],
        timeoutSeconds: 1,
        cursor: { afterSeq: 17 },
      });
    } finally {
      harness.db.close();
    }
  });

  it('uses waitForAtoms only when projection_jobs.phase is queued', async () => {
    const harness = createHarness({ atomPhase: 'queued', projectionPhase: 'queued', projectionLastSeq: 23 });
    try {
      const resumed = await resumeAll({
        db: harness.db,
        progressStore: harness.progressStore,
        getExecutionService: () => harness.executionSvc,
        createInvocationContext: harness.createInvocationContext,
        finalizeWorkflow: vi.fn(),
        time: { now: () => Date.now() },
      });

      expect(resumed).toEqual(['workflow-1']);
      expect(harness.executionSvc.coralDispatch).not.toHaveBeenCalled();
      expect(harness.executionSvc.awaitLaunch).not.toHaveBeenCalled();
      expect(harness.executionSvc.waitStream).toHaveBeenCalledTimes(1);
      expect(harness.waitRequests[0]).toEqual({
        jobIds: [harness.plan.slots[0].slotId],
        timeoutSeconds: 1,
        cursor: { afterSeq: 23 },
      });
    } finally {
      harness.db.close();
    }
  });

  it('relaunches the step when the projection_jobs row is absent', async () => {
    const harness = createHarness({ atomPhase: null, projectionPhase: null });
    try {
      const resumed = await resumeAll({
        db: harness.db,
        progressStore: harness.progressStore,
        getExecutionService: () => harness.executionSvc,
        createInvocationContext: harness.createInvocationContext,
        finalizeWorkflow: vi.fn(),
        time: { now: () => Date.now() },
      });

      expect(resumed).toEqual(['workflow-1']);
      expect(harness.executionSvc.coralDispatch).toHaveBeenCalledTimes(1);
      expect(harness.executionSvc.coralDispatch).toHaveBeenCalledWith(
        'codex',
        'architect',
        expect.objectContaining({
          jobId: harness.plan.slots[0].slotId,
          workflowSlotId: harness.plan.slots[0].slotId,
        }),
        harness.createInvocationContext(PROJECT_ROOT),
      );
      expect(harness.executionSvc.awaitLaunch).toHaveBeenCalledWith(harness.plan.slots[0].slotId, expect.any(Number));
      expect(harness.executionSvc.waitStream).toHaveBeenCalledTimes(1);
    } finally {
      harness.db.close();
    }
  });
});
