import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it, vi } from 'vitest';

import { JobStore } from '#src/jobs/store.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import type { JobTerminal } from '#src/jobs/records.js';
import type { WaitStreamEvent, WaitStreamRequest } from '#src/jobs/wait.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { parseExpression } from '#src/workflow/parser.js';
import { workflowPlanDeclaredEvent } from '#src/workflow/events.js';
import { buildWorkflowPlan, type WorkflowPlan } from '#src/workflow/plan.js';
import { commitWorkflowEvents } from '#src/workflow/projections.js';
import { loadJobProjectionDetails } from '#src/jobs/read-queries.js';
import { resumeAll } from '#src/workflow/recover.js';
import type { WorkflowExecutionPort } from '#src/workflow/execution-contract.js';
import type { WorkflowFinalizationIntent } from '#src/workflow/finalization.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';

// NOTE: "running" and "queued" branches today share the same code path
// (both hit waitForAtoms). We retain two tests so that if phase-differentiated
// behavior is added later, the test scaffold already exists. The distinct
// third branch ("absent" -> relaunch) is the genuine divergence.

// Monotonic deterministic clock for `resumeAll`'s `time.now`. The branch
// decisions don't assert on elapsed time, but the underlying
// `waitForAtoms`/drainDeadline checks compare absolute timestamps — fixed
// time would stall those branches; `Date.now()` would leak wall-clock
// dependence (Single Runtime World rule).
let recoverClock = new Date('2026-04-27T00:00:00.000Z').getTime();
const fixedTime = {
  now: () => {
    recoverClock += 100;
    return recoverClock;
  },
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
    seq: 0,
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

function createWorkflowPlan(expression = 'architect'): WorkflowPlan {
  return buildWorkflowPlan('workflow-1', parseExpression(expression), {
    defaultProvider: 'codex',
  });
}

function createHarness(options: {
  expression?: string;
  atomPhase: 'running' | 'queued' | null;
  projectionPhase: 'running' | 'queued' | 'completed' | 'error' | 'aborted' | null;
  projectionLastSeq?: number;
  atomTerminals?: Partial<Record<number, JobTerminal>>;
}) {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db);

  const runtime = new SimulationRuntime();
  const progressStore = new JobStore(BACKEND_NAMESPACE, runtime, createDefaultUpcasterRegistry(), {
    db,
    providers: permissiveProviderLookupPort,
  });
  const plan = createWorkflowPlan(options.expression);
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

  for (const [slotIndex, slot] of plan.slots.entries()) {
    const terminalForSlot = options.atomTerminals?.[slotIndex];
    const sessionId = `session-atom-${slotIndex + 1}`;
    if (options.atomPhase !== null || terminalForSlot !== undefined) {
      progressStore.initJob({
        jobId: slot.slotId,
        sessionId,
        provider: slot.provider,
        projectRoot: PROJECT_ROOT,
        backendNamespace: BACKEND_NAMESPACE,
        initialPhase: options.atomPhase ?? 'running',
      });
    }

    if (terminalForSlot !== undefined) {
      commitJobTerminal(progressStore, slot.slotId, sessionId, terminalForSlot);
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
        slot.slotId,
        options.projectionPhase,
        sessionId,
        slot.provider,
        PROJECT_ROOT,
        BACKEND_NAMESPACE,
        'workflow-1',
        slot.slotId,
        options.projectionLastSeq ?? 7,
      );
    }
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
    recordContinuationLease: vi.fn(async () => {}),
    claimContinuationLease: vi.fn(async () => true),
    clearContinuationLease: vi.fn(async () => true),
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
  };

  const createInvocationContext = (projectRoot: string): InvocationContext => ({
    projectRoot,
    pluginRoot: '/tmp/coral-workflow-plugin',
    coralEnv: {},
    authority: 'admin',
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
        loadJobDetails: loadJobProjectionDetails,
        getExecutionService: () => harness.executionSvc,
        createInvocationContext: harness.createInvocationContext,
        finalizeWorkflow: vi.fn(),
        time: fixedTime,
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
        loadJobDetails: loadJobProjectionDetails,
        getExecutionService: () => harness.executionSvc,
        createInvocationContext: harness.createInvocationContext,
        finalizeWorkflow: vi.fn(),
        time: fixedTime,
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
        loadJobDetails: loadJobProjectionDetails,
        getExecutionService: () => harness.executionSvc,
        createInvocationContext: harness.createInvocationContext,
        finalizeWorkflow: vi.fn(),
        time: fixedTime,
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

  it('finalizes failed recovery for an empty failed terminal output', async () => {
    const harness = createHarness({
      atomPhase: 'running',
      projectionPhase: null,
      atomTerminals: {
        0: { content: '', outcome: { kind: 'provider_exit', code: 1 } },
      },
    });
    const finalizeWorkflow = vi.fn<(intent: WorkflowFinalizationIntent) => void>();
    try {
      await expect(
        resumeAll({
          db: harness.db,
          progressStore: harness.progressStore,
          loadJobDetails: loadJobProjectionDetails,
          getExecutionService: () => harness.executionSvc,
          createInvocationContext: harness.createInvocationContext,
          finalizeWorkflow,
          time: fixedTime,
        }),
      ).rejects.toMatchObject({
        message: "Step 0, atom 'architect' failed: exited with code 1",
        aborted: false,
        failedAtom: 'architect',
        failedJobId: harness.plan.slots[0].slotId,
      });

      expect(finalizeWorkflow).toHaveBeenCalledTimes(1);
      expect(finalizeWorkflow.mock.calls[0]?.[0]).toMatchObject({
        outcome: 'failed',
        workflowJobId: 'workflow-1',
        failureLocation: {
          slotId: harness.plan.slots[0].slotId,
          stepIndex: 0,
          atomLabel: 'architect',
          jobId: harness.plan.slots[0].slotId,
        },
      });
      expect(finalizeWorkflow.mock.calls[0]?.[0].outcome).not.toBe('completed');
      expect(harness.executionSvc.waitStream).not.toHaveBeenCalled();
    } finally {
      harness.db.close();
    }
  });

  it('does not report a provider_exit code 0 atom as the recovery failure', async () => {
    const harness = createHarness({
      expression: '(architect, critic)',
      atomPhase: 'running',
      projectionPhase: null,
      atomTerminals: {
        0: { content: 'ARCH OK', outcome: { kind: 'provider_exit', code: 0 } },
        1: { content: '', outcome: { kind: 'provider_exit', code: 1 } },
      },
    });
    const finalizeWorkflow = vi.fn<(intent: WorkflowFinalizationIntent) => void>();
    try {
      await expect(
        resumeAll({
          db: harness.db,
          progressStore: harness.progressStore,
          loadJobDetails: loadJobProjectionDetails,
          getExecutionService: () => harness.executionSvc,
          createInvocationContext: harness.createInvocationContext,
          finalizeWorkflow,
          time: fixedTime,
        }),
      ).rejects.toMatchObject({
        message: "Step 0, atom 'critic' failed: exited with code 1",
        aborted: false,
        failedAtom: 'critic',
        failedJobId: harness.plan.slots[1].slotId,
      });

      expect(finalizeWorkflow).toHaveBeenCalledTimes(1);
      expect(finalizeWorkflow.mock.calls[0]?.[0]).toMatchObject({
        outcome: 'failed',
        workflowJobId: 'workflow-1',
        failureLocation: {
          slotId: harness.plan.slots[1].slotId,
          stepIndex: 0,
          atomLabel: 'critic',
          jobId: harness.plan.slots[1].slotId,
        },
      });
      expect(finalizeWorkflow.mock.calls[0]?.[0]).not.toMatchObject({
        failureLocation: {
          jobId: harness.plan.slots[0].slotId,
        },
      });
      expect(finalizeWorkflow.mock.calls[0]?.[0].outcome).not.toBe('completed');
      expect(harness.executionSvc.waitStream).not.toHaveBeenCalled();
    } finally {
      harness.db.close();
    }
  });
});
