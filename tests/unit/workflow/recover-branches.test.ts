import { currentCoralStoreFormat } from '#src/store-format.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { TEST_PROVIDER_SCOPE, withTestProfileLocation } from '#tests/helpers/provider-credentials.js';
import { describe, expect, it, vi } from 'vitest';

import { JobStore } from '#src/jobs/store.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { createSimulationBackend } from '#tools/simulation/core/backend.js';
import { AbortError } from '#src/runtime/abort.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import type { JobLaunch, JobTerminal } from '#src/jobs/records.js';
import type { WaitStreamEvent, WaitStreamRequest } from '#src/jobs/wait.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { decodeEventBody, encodeEventBody } from '#src/store/body-codec.js';
import { parseExpression } from '#src/workflow/parser.js';
import { workflowPlanDeclaredEvent, workflowRegistry } from '#src/workflow/events.js';
import { buildWorkflowPlan, type WorkflowPlan } from '#src/workflow/plan.js';
import { commitWorkflowEvents } from '#src/workflow/projections.js';
import { loadJobProjectionDetails } from '#src/jobs/read-queries.js';
import { resumeAll } from '#src/workflow/recover.js';
import { createWorkflowExecutionError, type WorkflowExecutionPort } from '#src/workflow/execution-contract.js';
import type { WorkflowFinalizationIntent } from '#src/workflow/finalization.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { composeReducers } from '#src/store/reducers.js';
import { sessionContinuationLeaseClaimedEvent } from '#src/sessions/continuation-lease-events.js';
import { jobLaunchRequestedEvent } from '#src/jobs/store.js';
import type { ProviderSession } from '#src/sessions/entry.js';
import { createProjectionSessionLookup } from '#src/sessions/lookup.js';
import { createWorkflowRecoveryFinalizer } from '#src/coordinator/services/workflow-recovery-finalizer.js';
import { createRecoveryCoordinator } from '#src/coordinator/services/recovery/index.js';
import { createFailedWorkflowDescendantReleaser } from '#src/coordinator/services/workflow-recovery-descendants.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';

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
const noFailedWorkflowDescendants = () => [];

function running(jobId: string, sessionId: string) {
  return {
    kind: 'provider-session' as const,
    status: 'running' as const,
    jobId,
    sessionId,
  };
}

function terminal(jobId: string, content: string): WaitStreamEvent {
  const result: JobTerminal = { content, outcome: { kind: 'completed' }, durationMs: 0 };
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

async function* failWait(error: unknown): AsyncGenerator<WaitStreamEvent> {
  throw error;
}

function createWorkflowPlan(expression = 'architect'): WorkflowPlan {
  return buildWorkflowPlan('workflow-1', parseExpression(expression), {
    defaultProvider: 'codex',
  });
}

type SlotRecoveryState = {
  atomPhase?: 'running' | 'queued' | null;
  projectionPhase?: 'running' | 'queued' | 'completed' | 'error' | 'aborted' | null;
  projectionLastSeq?: number;
  terminal?: JobTerminal;
};

function createHarness(options: {
  expression?: string;
  atomPhase: 'running' | 'queued' | null;
  projectionPhase: 'running' | 'queued' | 'completed' | 'error' | 'aborted' | null;
  projectionLastSeq?: number;
  atomTerminals?: Partial<Record<number, JobTerminal>>;
  slotStates?: Partial<Record<number, SlotRecoveryState>>;
}) {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());

  const runtime = new SimulationRuntime();
  const progressStore = new JobStore(BACKEND_NAMESPACE, runtime, createEventBodyCodec(), {
    db,
    providers: permissiveProviderLookupPort,
    reducers: composeReducers(jobsRegistry, sessionsRegistry, workflowRegistry),
  });
  const plan = createWorkflowPlan(options.expression);
  commitWorkflowEvents(
    db,
    (c) => {
      c.append(workflowPlanDeclaredEvent('workflow-1', plan, TEST_PROVIDER_SCOPE));
      return undefined;
    },
    runtime.time,
    permissiveProviderLookupPort,
  );

  progressStore.appendLaunchRequested('workflow-1', {
    jobId: 'workflow-1',
    owner: { kind: 'workflow', id: 'workflow-1' },
    sessionId: null,
    provider: null,
    projectRoot: PROJECT_ROOT,
    backendNamespace: BACKEND_NAMESPACE,
    jobKind: 'workflow',
    pool: 'default',
    enqueueSequence: progressStore.nextEnqueueSequence(),
    request: {
      prompt: '',
      cwd: PROJECT_ROOT,
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: new Date(runtime.time.now()).toISOString(),
  });
  progressStore.commit((c) => {
    c.append({
      type: 'job.runtime.started',
      stream: { kind: 'job', id: 'workflow-1' },
      namespace: BACKEND_NAMESPACE,
      project: PROJECT_ROOT,
      refs: { jobId: 'workflow-1', workflowId: 'workflow-1' },
      body: { transport: 'workflow', startedAt: new Date(runtime.time.now()).toISOString() },
    });
    return undefined;
  });

  for (const [slotIndex, slot] of plan.slots.entries()) {
    const slotState = options.slotStates?.[slotIndex];
    const atomPhase = slotState && 'atomPhase' in slotState ? slotState.atomPhase : options.atomPhase;
    const projectionPhase =
      slotState && 'projectionPhase' in slotState ? slotState.projectionPhase : options.projectionPhase;
    const projectionLastSeq = slotState?.projectionLastSeq ?? options.projectionLastSeq ?? 7;
    const terminalForSlot = slotState?.terminal ?? options.atomTerminals?.[slotIndex];
    const sessionId = `session-atom-${slotIndex + 1}`;
    if (atomPhase !== null || terminalForSlot !== undefined) {
      seedTestSessionProjection(db, {
        sessionId,
        provider: slot.provider,
        projectRoot: PROJECT_ROOT,
        backendNamespace: BACKEND_NAMESPACE,
        activeJobId: slot.slotId,
      });
      progressStore.appendLaunchRequested(slot.slotId, {
        jobId: slot.slotId,
        owner: { kind: 'workflow', id: 'workflow-1' },
        sessionId,
        provider: slot.provider,
        projectRoot: PROJECT_ROOT,
        backendNamespace: BACKEND_NAMESPACE,
        jobKind: 'provider',
        pool: 'default',
        enqueueSequence: progressStore.nextEnqueueSequence(),
        providerAction: 'exec',
        parentWorkflowJobId: 'workflow-1',
        workflowSlotId: slot.slotId,
        workflowSlotGeneration: 0,
        request: {
          prompt: '',
          cwd: PROJECT_ROOT,
          bypassPermissions: false,
          coralEnv: {},
        },
        createdAt: new Date(runtime.time.now()).toISOString(),
      });
    }

    if (terminalForSlot !== undefined) {
      commitJobTerminal(progressStore, slot.slotId, sessionId, terminalForSlot);
    }

    if (projectionPhase !== null) {
      db.prepare(
        `INSERT INTO projection_jobs (
           job_id, execution_owner, phase, diagnostics, session_id, provider, project_root, backend_namespace,
           job_kind, parent_workflow_job_id, workflow_slot, created_at, last_seq
	         )
	         VALUES (?, ?, ?, '{"progressFaults":[]}', ?, ?, ?, ?, 'provider', ?, ?, '2026-04-20T00:00:00.000Z', ?)
	         ON CONFLICT(job_id) DO UPDATE SET
	           execution_owner = excluded.execution_owner,
	           phase = excluded.phase,
	           diagnostics = excluded.diagnostics,
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
        JSON.stringify({ kind: 'workflow', id: 'workflow-1' }),
        projectionPhase,
        sessionId,
        slot.provider,
        PROJECT_ROOT,
        BACKEND_NAMESPACE,
        'workflow-1',
        slot.slotId,
        projectionLastSeq,
      );
    }
  }

  const waitRequests: WaitStreamRequest[] = [];
  const executionSvc: WorkflowExecutionPort & {
    coralDispatch: ReturnType<typeof vi.fn>;
    waitStream: ReturnType<typeof vi.fn>;
    awaitLaunch: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
  } = {
    coralDispatch: vi.fn(async (_provider, _coralName, input) =>
      running(String(input.jobId ?? 'relaunched-atom-1'), `session-${String(input.jobId ?? 'relaunched-atom-1')}`),
    ),
    resume: vi.fn(async () => running('job-resumed', 'session-resumed')),
    recordContinuationLease: vi.fn(async () => {}),
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
    principal: testProjectPrincipal(projectRoot),
  });

  return { db, plan, progressStore, executionSvc, createInvocationContext, waitRequests };
}

function appendRecoverableWorkflowRoot(progressStore: JobStore, workflowId: string, projectRoot: string): void {
  const plan = buildWorkflowPlan(workflowId, parseExpression('architect'), { defaultProvider: 'codex' });
  commitWorkflowEvents(
    progressStore.getDb(),
    (c) => {
      c.append(workflowPlanDeclaredEvent(workflowId, plan, TEST_PROVIDER_SCOPE));
      return undefined;
    },
    fixedTime,
    permissiveProviderLookupPort,
  );
  progressStore.appendLaunchRequested(workflowId, {
    jobId: workflowId,
    owner: { kind: 'workflow', id: workflowId },
    sessionId: null,
    provider: null,
    projectRoot,
    backendNamespace: BACKEND_NAMESPACE,
    jobKind: 'workflow',
    pool: 'default',
    enqueueSequence: progressStore.nextEnqueueSequence(),
    request: { prompt: '', cwd: projectRoot, bypassPermissions: false, coralEnv: {} },
    createdAt: '2026-04-27T00:00:00.000Z',
  });
  progressStore.commit((c) => {
    c.append({
      type: 'job.runtime.started',
      stream: { kind: 'job', id: workflowId },
      namespace: BACKEND_NAMESPACE,
      project: projectRoot,
      refs: { jobId: workflowId, workflowId },
      body: { transport: 'workflow', startedAt: '2026-04-27T00:00:00.000Z' },
    });
    return undefined;
  });
  progressStore.getDb().prepare('DELETE FROM projection_workflows WHERE workflow_id = ?').run(workflowId);
}

function setPendingReplacementLease(
  harness: ReturnType<typeof createHarness>,
  expiresAt = '2099-01-01T00:00:00.000Z',
): void {
  const slot = harness.plan.slots[0];
  const sessionId = 'session-atom-1';
  const row = harness.db
    .prepare<[string], { entry: string }>('SELECT entry FROM projection_sessions WHERE session_id = ?')
    .get(sessionId);
  if (row === undefined) throw new Error('expected persisted provider session');
  const entry = JSON.parse(row.entry) as Record<string, unknown>;
  delete entry.activeJobId;
  entry.continuationLease = {
    status: 'pending',
    staleJobId: slot.slotId,
    workflowId: 'workflow-1',
    workflowSlotId: slot.slotId,
    replacementGeneration: 1,
    reason: 'stale_recovery',
    expiresAt,
    recordedAt: '2026-04-27T00:00:00.000Z',
  };
  entry.version = Number(entry.version) + 1;
  harness.db
    .prepare('UPDATE projection_sessions SET entry = ? WHERE session_id = ?')
    .run(JSON.stringify(entry), sessionId);
}

describe('workflow recovery branch rules', () => {
  it('completes a persisted replacement intent after a crash between stale abort and replacement launch', async () => {
    const harness = createHarness({
      atomPhase: 'running',
      projectionPhase: 'aborted',
      atomTerminals: {
        0: { content: '', outcome: { kind: 'aborted', reason: 'user_abort' }, durationMs: 0 },
      },
    });
    const slot = harness.plan.slots[0];
    const sessionId = 'session-atom-1';
    const row = harness.db
      .prepare<[string], { entry: string }>('SELECT entry FROM projection_sessions WHERE session_id = ?')
      .get(sessionId);
    if (row === undefined) throw new Error('expected persisted provider session');
    const entry = JSON.parse(row.entry) as Record<string, unknown>;
    delete entry.activeJobId;
    entry.continuationLease = {
      status: 'pending',
      staleJobId: slot.slotId,
      workflowId: 'workflow-1',
      workflowSlotId: slot.slotId,
      replacementGeneration: 1,
      reason: 'stale_recovery',
      expiresAt: '2099-01-01T00:00:00.000Z',
      recordedAt: '2026-04-27T00:00:00.000Z',
    };
    entry.version = Number(entry.version) + 1;
    harness.db
      .prepare('UPDATE projection_sessions SET entry = ? WHERE session_id = ?')
      .run(JSON.stringify(entry), sessionId);

    vi.mocked(harness.executionSvc.resume).mockImplementationOnce(async (_provider, input) => {
      const pendingEntry = JSON.parse(
        (
          harness.db
            .prepare<[string], { entry: string }>('SELECT entry FROM projection_sessions WHERE session_id = ?')
            .get(sessionId) as { entry: string }
        ).entry,
      ) as ProviderSession;
      if (pendingEntry.continuationLease?.status !== 'pending') throw new Error('expected pending intent');
      const claimedAt = '2026-04-27T00:00:01.000Z';
      const claimedLease = {
        ...pendingEntry.continuationLease,
        status: 'claimed' as const,
        resumedJobId: 'replacement-1',
        claimedAt,
      };
      const claimedEntry: ProviderSession = {
        ...pendingEntry,
        activeJobId: 'replacement-1',
        continuationLease: claimedLease,
        lastUsedAt: claimedAt,
        version: pendingEntry.version + 1,
      };
      const persistedBeforeClaim = JSON.parse(
        (
          harness.db
            .prepare<[string], { entry: string }>('SELECT entry FROM projection_sessions WHERE session_id = ?')
            .get(sessionId) as { entry: string }
        ).entry,
      ) as ProviderSession;
      expect(claimedEntry.version).toBe(persistedBeforeClaim.version + 1);
      const launch = {
        jobId: 'replacement-1',
        owner: { kind: 'workflow', id: 'workflow-1' },
        sessionId,
        provider: slot.provider,
        projectRoot: PROJECT_ROOT,
        backendNamespace: BACKEND_NAMESPACE,
        jobKind: 'provider',
        pool: 'default',
        enqueueSequence: harness.progressStore.nextEnqueueSequence(),
        providerAction: 'resume',
        parentWorkflowJobId: 'workflow-1',
        workflowSlotId: slot.slotId,
        workflowSlotGeneration: input.workflowSlotGeneration,
        replacesWorkflowJobId: input.replacesWorkflowJobId,
        request: { prompt: input.prompt, cwd: PROJECT_ROOT, bypassPermissions: false, coralEnv: {} },
        createdAt: '2026-04-27T00:00:01.000Z',
      } as const;
      commitInputs(
        harness.db,
        [
          sessionContinuationLeaseClaimedEvent(claimedEntry, claimedLease),
          jobLaunchRequestedEvent('replacement-1', launch),
        ],
        {
          now: () => new Date(claimedAt),
          reducers: composeReducers(jobsRegistry, sessionsRegistry, workflowRegistry),
          bodyCodec: createEventBodyCodec(),
          providers: permissiveProviderLookupPort,
        },
      );
      return { kind: 'provider-session', status: 'running', jobId: 'replacement-1', sessionId: sessionId };
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
          releaseFailedWorkflowDescendants: noFailedWorkflowDescendants,
          time: fixedTime,
        }),
      ).resolves.toEqual(['workflow-1']);
      expect(harness.executionSvc.resume).toHaveBeenCalledWith(
        slot.provider,
        expect.objectContaining({
          workflowSlotGeneration: 1,
          replacesWorkflowJobId: slot.slotId,
        }),
        expect.anything(),
      );
      expect(finalizeWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'completed', workflowJobId: 'workflow-1' }),
      );
    } finally {
      harness.db.close();
    }
  });

  it.each([
    ['ghost launch', { kind: 'job_fault', fault: { kind: 'ghost_launch' } }],
    ['lost wrapper', { kind: 'job_fault', fault: { kind: 'wrapper_lost' } }],
  ] as const)('completes a pending replacement intent after %s terminal recovery', async (_label, outcome) => {
    const harness = createHarness({
      atomPhase: 'running',
      projectionPhase: 'error',
      atomTerminals: { 0: { content: '', outcome, durationMs: 0 } },
    });
    setPendingReplacementLease(harness);

    try {
      await expect(
        resumeAll({
          db: harness.db,
          progressStore: harness.progressStore,
          loadJobDetails: loadJobProjectionDetails,
          getExecutionService: () => harness.executionSvc,
          createInvocationContext: harness.createInvocationContext,
          finalizeWorkflow: vi.fn(),
          releaseFailedWorkflowDescendants: noFailedWorkflowDescendants,
          time: fixedTime,
        }),
      ).resolves.toEqual(['workflow-1']);
      expect(harness.executionSvc.resume).toHaveBeenCalledWith(
        harness.plan.slots[0].provider,
        expect.objectContaining({
          workflowSlotGeneration: 1,
          replacesWorkflowJobId: harness.plan.slots[0].slotId,
        }),
        expect.anything(),
      );
    } finally {
      harness.db.close();
    }
  });

  it('completes a pending replacement intent after a session-interrupted failure', async () => {
    const harness = createHarness({ atomPhase: 'running', projectionPhase: 'running' });
    const slot = harness.plan.slots[0];
    const sessionId = 'session-atom-1';
    const [interrupted] = commitInputs(
      harness.db,
      [
        {
          type: 'session.interrupted',
          stream: { kind: 'session', id: sessionId },
          refs: { sessionId, jobId: slot.slotId },
          body: { trigger: 'restart', continuity: 'pre_checkpoint_preserved' },
        },
      ],
      {
        now: () => new Date('2026-04-27T00:00:00.000Z'),
        reducers: composeReducers(sessionsRegistry),
        bodyCodec: createEventBodyCodec(),
        providers: permissiveProviderLookupPort,
      },
    );
    if (interrupted === undefined) throw new Error('expected session interruption event');
    commitJobTerminal(harness.progressStore, slot.slotId, sessionId, {
      content: '',
      outcome: { kind: 'failed', causeRef: { stream: interrupted.stream, seq: interrupted.seq } },
      durationMs: 0,
    });
    setPendingReplacementLease(harness);

    try {
      await expect(
        resumeAll({
          db: harness.db,
          progressStore: harness.progressStore,
          loadJobDetails: loadJobProjectionDetails,
          getExecutionService: () => harness.executionSvc,
          createInvocationContext: harness.createInvocationContext,
          finalizeWorkflow: vi.fn(),
          releaseFailedWorkflowDescendants: noFailedWorkflowDescendants,
          time: fixedTime,
        }),
      ).resolves.toEqual(['workflow-1']);
      expect(harness.executionSvc.resume).toHaveBeenCalledTimes(1);
    } finally {
      harness.db.close();
    }
  });

  it('renews an overdue pending replacement intent before resuming it', async () => {
    const harness = createHarness({
      atomPhase: 'running',
      projectionPhase: 'error',
      atomTerminals: {
        0: {
          content: '',
          outcome: { kind: 'job_fault', fault: { kind: 'ghost_launch' } },
          durationMs: 0,
        },
      },
    });
    setPendingReplacementLease(harness, '2020-01-01T00:00:00.000Z');

    try {
      await expect(
        resumeAll({
          db: harness.db,
          progressStore: harness.progressStore,
          loadJobDetails: loadJobProjectionDetails,
          getExecutionService: () => harness.executionSvc,
          createInvocationContext: harness.createInvocationContext,
          finalizeWorkflow: vi.fn(),
          releaseFailedWorkflowDescendants: noFailedWorkflowDescendants,
          time: fixedTime,
        }),
      ).resolves.toEqual(['workflow-1']);
      expect(harness.executionSvc.recordContinuationLease).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-atom-1',
          jobId: harness.plan.slots[0].slotId,
          replacementGeneration: 1,
        }),
      );
      expect(vi.mocked(harness.executionSvc.recordContinuationLease).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(harness.executionSvc.resume).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
    } finally {
      harness.db.close();
    }
  });

  it('fails closed when persisted workflow child generations contain a gap', async () => {
    const harness = createHarness({ atomPhase: 'running', projectionPhase: 'running' });
    const slot = harness.plan.slots[0];
    harness.db
      .prepare(
        `INSERT INTO projection_jobs (
         job_id, execution_owner, phase, diagnostics, session_id, provider, project_root, backend_namespace,
         job_kind, parent_workflow_job_id, workflow_slot, workflow_slot_generation,
         replaces_workflow_job_id, created_at, last_seq
       ) VALUES (?, ?, 'completed', '{"progressFaults":[]}', ?, ?, ?, ?, 'provider', ?, ?, 2, ?, ?, 999)`,
      )
      .run(
        'invalid-generation-2',
        JSON.stringify({ kind: 'workflow', id: 'workflow-1' }),
        'session-atom-1',
        slot.provider,
        PROJECT_ROOT,
        BACKEND_NAMESPACE,
        'workflow-1',
        slot.slotId,
        slot.slotId,
        '2026-04-27T00:00:02.000Z',
      );
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
          releaseFailedWorkflowDescendants: noFailedWorkflowDescendants,
          time: fixedTime,
        }),
      ).resolves.toEqual(['workflow-1']);
      expect(finalizeWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'failed',
          workflowJobId: 'workflow-1',
          lifecycleFault: expect.objectContaining({
            kind: 'recovery_failed',
            message: `Workflow recovery rejected invalid child chain for slot '${slot.slotId}' at job 'invalid-generation-2'.`,
          }),
        }),
      );
      expect(harness.executionSvc.waitStream).not.toHaveBeenCalled();
    } finally {
      harness.db.close();
    }
  });

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
        releaseFailedWorkflowDescendants: noFailedWorkflowDescendants,
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
        releaseFailedWorkflowDescendants: noFailedWorkflowDescendants,
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

  it('relaunches an absent step with persisted source A instead of replacement-daemon source B', async () => {
    const harness = createHarness({ atomPhase: null, projectionPhase: null });
    const replacementCredentials = withTestProfileLocation(TEST_PROVIDER_SCOPE, 'codex', '/replacement/.codex-b');
    const createReplacementContext = (projectRoot: string): InvocationContext => ({
      ...harness.createInvocationContext(projectRoot),
      providerScope: replacementCredentials,
    });
    const getExecutionService = vi.fn(() => harness.executionSvc);
    try {
      const resumed = await resumeAll({
        db: harness.db,
        progressStore: harness.progressStore,
        loadJobDetails: loadJobProjectionDetails,
        getExecutionService,
        createInvocationContext: createReplacementContext,
        finalizeWorkflow: vi.fn(),
        releaseFailedWorkflowDescendants: noFailedWorkflowDescendants,
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
          owner: { kind: 'workflow', id: 'workflow-1' },
        }),
        expect.objectContaining({
          ...harness.createInvocationContext(PROJECT_ROOT),
          providerScope: TEST_PROVIDER_SCOPE,
        }),
      );
      expect(getExecutionService).toHaveBeenCalledWith(expect.objectContaining({ providerScope: TEST_PROVIDER_SCOPE }));
      expect(harness.executionSvc.awaitLaunch).toHaveBeenCalledWith(harness.plan.slots[0].slotId, expect.any(Number));
      expect(harness.executionSvc.waitStream).toHaveBeenCalledTimes(1);
    } finally {
      harness.db.close();
    }
  });

  it('recovers a partially launched active step without redispatching completed or pending atoms', async () => {
    const harness = createHarness({
      expression: '(architect, critic, verifier)',
      atomPhase: null,
      projectionPhase: null,
      slotStates: {
        0: {
          atomPhase: 'running',
          projectionPhase: 'completed',
          terminal: { content: 'ARCH_DONE', outcome: { kind: 'completed' }, durationMs: 0 },
        },
        1: {
          atomPhase: 'running',
          projectionPhase: 'running',
          projectionLastSeq: 31,
        },
        2: {
          atomPhase: null,
          projectionPhase: null,
        },
      },
    });
    const [completedSlot, pendingSlot, missingSlot] = harness.plan.slots;
    const finalizeWorkflow = vi.fn<(intent: WorkflowFinalizationIntent) => void>();
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    harness.executionSvc.coralDispatch.mockImplementation(async (_provider, _coralName, input) => {
      const jobId = String(input.jobId);
      if (jobId !== missingSlot.slotId) {
        const error = new Error(`job_terminal_order_violation:${jobId}`);
        Object.assign(error, { code: 'job_terminal_order_violation' });
        throw error;
      }
      return running(jobId, `session-${jobId}`);
    });
    harness.executionSvc.waitStream.mockImplementation((req: WaitStreamRequest) => {
      harness.waitRequests.push({
        ...req,
        jobIds: [...req.jobIds],
        ...(req.cursor ? { cursor: { afterSeq: req.cursor.afterSeq } } : {}),
      });
      return emit(
        req.jobIds.map((jobId) => terminal(jobId, jobId === pendingSlot.slotId ? 'CRIT_DONE' : 'VERIFY_DONE')),
      );
    });

    try {
      const resumed = await resumeAll({
        db: harness.db,
        progressStore: harness.progressStore,
        loadJobDetails: loadJobProjectionDetails,
        getExecutionService: () => harness.executionSvc,
        createInvocationContext: harness.createInvocationContext,
        finalizeWorkflow,
        releaseFailedWorkflowDescendants: noFailedWorkflowDescendants,
        time: fixedTime,
      });

      expect(resumed).toEqual(['workflow-1']);
      expect(harness.executionSvc.coralDispatch).toHaveBeenCalledTimes(1);
      expect(harness.executionSvc.coralDispatch).toHaveBeenCalledWith(
        'codex',
        'verifier',
        expect.objectContaining({
          jobId: missingSlot.slotId,
          workflowSlotId: missingSlot.slotId,
          owner: { kind: 'workflow', id: 'workflow-1' },
        }),
        expect.objectContaining({
          ...harness.createInvocationContext(PROJECT_ROOT),
          providerScope: TEST_PROVIDER_SCOPE,
        }),
      );
      expect(harness.executionSvc.coralDispatch).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ jobId: completedSlot.slotId }),
        expect.anything(),
      );
      expect(harness.executionSvc.coralDispatch).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ jobId: pendingSlot.slotId }),
        expect.anything(),
      );
      expect(harness.executionSvc.waitStream).toHaveBeenCalledTimes(1);
      expect(harness.waitRequests[0]).toEqual({
        jobIds: [pendingSlot.slotId, missingSlot.slotId],
        timeoutSeconds: 1,
        cursor: { afterSeq: 31 },
      });
      expect(finalizeWorkflow).toHaveBeenCalledWith({
        outcome: 'completed',
        workflowJobId: 'workflow-1',
        finalOutput:
          '<architect>\nARCH_DONE\n</architect>\n\n<critic>\nCRIT_DONE\n</critic>\n\n<verifier>\nVERIFY_DONE\n</verifier>',
        stepDetails: [
          { stepIndex: 0, atomIndex: 0, label: 'architect', output: 'ARCH_DONE' },
          { stepIndex: 0, atomIndex: 1, label: 'critic', output: 'CRIT_DONE' },
          { stepIndex: 0, atomIndex: 2, label: 'verifier', output: 'VERIFY_DONE' },
        ],
      });
    } finally {
      harness.db.close();
    }
  });

  it('aborts launched-pending atoms when a partially launched recovery relaunch fails', async () => {
    const harness = createHarness({
      expression: '(architect, critic)',
      atomPhase: null,
      projectionPhase: null,
      slotStates: {
        0: {
          atomPhase: 'running',
          projectionPhase: 'running',
          projectionLastSeq: 41,
        },
        1: {
          atomPhase: null,
          projectionPhase: null,
        },
      },
    });
    const [pendingSlot, missingSlot] = harness.plan.slots;
    const finalizeWorkflow = vi.fn<(intent: WorkflowFinalizationIntent) => void>();
    harness.executionSvc.coralDispatch.mockResolvedValue({
      status: 'rejected',
      message: 'launch capacity unavailable',
    });
    harness.executionSvc.abort.mockReturnValue({ aborted: [pendingSlot.slotId], notFound: [] });

    try {
      await expect(
        resumeAll({
          db: harness.db,
          progressStore: harness.progressStore,
          loadJobDetails: loadJobProjectionDetails,
          getExecutionService: () => harness.executionSvc,
          createInvocationContext: harness.createInvocationContext,
          finalizeWorkflow,
          releaseFailedWorkflowDescendants: noFailedWorkflowDescendants,
          time: fixedTime,
        }),
      ).resolves.toEqual(['workflow-1']);

      expect(harness.executionSvc.coralDispatch).toHaveBeenCalledTimes(1);
      expect(harness.executionSvc.coralDispatch).toHaveBeenCalledWith(
        'codex',
        'critic',
        expect.objectContaining({
          jobId: missingSlot.slotId,
          workflowSlotId: missingSlot.slotId,
          owner: { kind: 'workflow', id: 'workflow-1' },
        }),
        expect.objectContaining({
          ...harness.createInvocationContext(PROJECT_ROOT),
          providerScope: TEST_PROVIDER_SCOPE,
        }),
      );
      expect(harness.executionSvc.abort).toHaveBeenCalledWith([pendingSlot.slotId]);
      expect(harness.waitRequests).toHaveLength(1);
      expect(harness.waitRequests[0]?.jobIds).toEqual([pendingSlot.slotId]);
      expect(finalizeWorkflow).toHaveBeenCalledTimes(1);
      expect(finalizeWorkflow.mock.calls[0]?.[0]).toMatchObject({
        outcome: 'failed',
        workflowJobId: 'workflow-1',
        failureLocation: {
          slotId: missingSlot.slotId,
          stepIndex: 0,
          atomLabel: 'critic',
        },
        stepDetails: [
          {
            stepIndex: 0,
            atomIndex: 0,
            label: 'architect',
            output: `result:${pendingSlot.slotId}`,
          },
        ],
      });
    } finally {
      harness.db.close();
    }
  });

  it('does not duplicate completed active-step details when a partial relaunch fails', async () => {
    const harness = createHarness({
      expression: '(architect, critic)',
      atomPhase: null,
      projectionPhase: null,
      slotStates: {
        0: {
          atomPhase: 'running',
          projectionPhase: 'completed',
          terminal: { content: 'ARCH_DONE', outcome: { kind: 'completed' }, durationMs: 0 },
        },
        1: {
          atomPhase: null,
          projectionPhase: null,
        },
      },
    });
    const [completedSlot] = harness.plan.slots;
    const finalizeWorkflow = vi.fn<(intent: WorkflowFinalizationIntent) => void>();
    harness.executionSvc.coralDispatch.mockResolvedValue({
      status: 'rejected',
      message: 'launch capacity unavailable',
    });
    harness.executionSvc.abort.mockReturnValue({ aborted: [completedSlot.slotId], notFound: [] });
    harness.executionSvc.waitStream.mockImplementation((req: WaitStreamRequest) => {
      harness.waitRequests.push({
        ...req,
        jobIds: [...req.jobIds],
        ...(req.cursor ? { cursor: { afterSeq: req.cursor.afterSeq } } : {}),
      });
      return emit(req.jobIds.map((jobId) => terminal(jobId, 'ARCH_DONE')));
    });

    try {
      await expect(
        resumeAll({
          db: harness.db,
          progressStore: harness.progressStore,
          loadJobDetails: loadJobProjectionDetails,
          getExecutionService: () => harness.executionSvc,
          createInvocationContext: harness.createInvocationContext,
          finalizeWorkflow,
          releaseFailedWorkflowDescendants: noFailedWorkflowDescendants,
          time: fixedTime,
        }),
      ).resolves.toEqual(['workflow-1']);

      expect(harness.executionSvc.abort).toHaveBeenCalledWith([completedSlot.slotId]);
      expect(finalizeWorkflow).toHaveBeenCalledTimes(1);
      const intent = finalizeWorkflow.mock.calls[0]?.[0];
      expect(intent).toMatchObject({
        outcome: 'failed',
        workflowJobId: 'workflow-1',
      });
      expect(intent?.stepDetails).toEqual([{ stepIndex: 0, atomIndex: 0, label: 'architect', output: 'ARCH_DONE' }]);
    } finally {
      harness.db.close();
    }
  });

  it('finalizes failed recovery for an empty failed terminal output', async () => {
    const harness = createHarness({
      atomPhase: 'running',
      projectionPhase: null,
      atomTerminals: {
        0: { content: '', outcome: { kind: 'provider_exit', code: 1 }, durationMs: 0 },
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
          releaseFailedWorkflowDescendants: noFailedWorkflowDescendants,
          time: fixedTime,
        }),
      ).resolves.toEqual(['workflow-1']);

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
        0: { content: 'ARCH OK', outcome: { kind: 'provider_exit', code: 0 }, durationMs: 0 },
        1: { content: '', outcome: { kind: 'provider_exit', code: 1 }, durationMs: 0 },
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
          releaseFailedWorkflowDescendants: noFailedWorkflowDescendants,
          time: fixedTime,
        }),
      ).resolves.toEqual(['workflow-1']);

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

  it('fails closed when a durable workflow slot job is not owned by its workflow', async () => {
    const harness = createHarness({ atomPhase: 'running', projectionPhase: 'running' });
    const slot = harness.plan.slots[0];
    const finalizeWorkflow = vi.fn<(intent: WorkflowFinalizationIntent) => void>();
    const row = harness.db
      .prepare(
        "SELECT seq, body FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.launch.requested'",
      )
      .get(slot.slotId) as { seq: number; body: Buffer };
    const body = decodeEventBody(row.body) as Record<string, unknown>;
    body.owner = { kind: 'provider-session', id: 'session-atom-1' };
    harness.db.prepare('UPDATE events SET body = ? WHERE seq = ?').run(encodeEventBody(body), row.seq);

    try {
      await expect(
        resumeAll({
          db: harness.db,
          progressStore: harness.progressStore,
          loadJobDetails: loadJobProjectionDetails,
          getExecutionService: () => harness.executionSvc,
          createInvocationContext: harness.createInvocationContext,
          finalizeWorkflow,
          releaseFailedWorkflowDescendants: noFailedWorkflowDescendants,
          time: fixedTime,
        }),
      ).resolves.toEqual(['workflow-1']);
      expect(finalizeWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'failed',
          workflowJobId: 'workflow-1',
          lifecycleFault: expect.objectContaining({
            kind: 'recovery_failed',
            message: `Workflow recovery rejected invalid durable relation for slot '${slot.slotId}' and job '${slot.slotId}'.`,
          }),
        }),
      );
      expect(harness.executionSvc.waitStream).not.toHaveBeenCalled();
    } finally {
      harness.db.close();
    }
  });

  it('fails closed when a durable workflow slot has no real provider session', async () => {
    const harness = createHarness({ atomPhase: 'running', projectionPhase: 'running' });
    const slot = harness.plan.slots[0];
    const finalizeWorkflow = vi.fn<(intent: WorkflowFinalizationIntent) => void>();
    harness.db.prepare('DELETE FROM projection_sessions WHERE session_id = ?').run('session-atom-1');

    try {
      await expect(
        resumeAll({
          db: harness.db,
          progressStore: harness.progressStore,
          loadJobDetails: loadJobProjectionDetails,
          getExecutionService: () => harness.executionSvc,
          createInvocationContext: harness.createInvocationContext,
          finalizeWorkflow,
          releaseFailedWorkflowDescendants: noFailedWorkflowDescendants,
          time: fixedTime,
        }),
      ).resolves.toEqual(['workflow-1']);
      expect(finalizeWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'failed',
          workflowJobId: 'workflow-1',
          lifecycleFault: expect.objectContaining({
            kind: 'recovery_failed',
            message: `Workflow recovery could not find provider session 'session-atom-1' for slot '${slot.slotId}'.`,
          }),
        }),
      );
      expect(harness.executionSvc.waitStream).not.toHaveBeenCalled();
    } finally {
      harness.db.close();
    }
  });

  it.each([
    ['plan', '{'],
    ['provider_scope', '{'],
    ['lifecycle', 'invalid-lifecycle'],
  ] as const)('contains malformed workflow %s hydration and visits the next workflow', async (column, value) => {
    const harness = createHarness({ atomPhase: 'running', projectionPhase: 'running' });
    appendRecoverableWorkflowRoot(harness.progressStore, 'workflow-2', '/tmp/coral-workflow-project-2');
    harness.db.prepare(`UPDATE projection_workflows SET ${column} = ? WHERE workflow_id = ?`).run(value, 'workflow-1');
    const finalizeWorkflow = vi.fn<(intent: WorkflowFinalizationIntent) => void>();
    const releaseFailedWorkflowDescendants = vi.fn(() => []);

    try {
      await expect(
        resumeAll({
          db: harness.db,
          progressStore: harness.progressStore,
          loadJobDetails: loadJobProjectionDetails,
          getExecutionService: () => harness.executionSvc,
          createInvocationContext: harness.createInvocationContext,
          finalizeWorkflow,
          releaseFailedWorkflowDescendants,
          time: fixedTime,
        }),
      ).resolves.toEqual(['workflow-1', 'workflow-2']);
      expect(finalizeWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'failed',
          workflowJobId: 'workflow-1',
          lifecycleFault: expect.objectContaining({ kind: 'recovery_failed' }),
        }),
      );
      expect(finalizeWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'failed',
          workflowJobId: 'workflow-2',
          lifecycleFault: expect.objectContaining({
            kind: 'recovery_failed',
            message: 'Workflow recovery could not find a workflow projection.',
          }),
        }),
      );
      expect(releaseFailedWorkflowDescendants).toHaveBeenCalledWith('workflow-1');
      expect(releaseFailedWorkflowDescendants).toHaveBeenCalledWith('workflow-2');
    } finally {
      harness.db.close();
    }
  });

  it('contains invocation-context construction failure and visits the next workflow', async () => {
    const harness = createHarness({ atomPhase: 'running', projectionPhase: 'running' });
    appendRecoverableWorkflowRoot(harness.progressStore, 'workflow-2', '/tmp/coral-workflow-project-2');
    const finalizeWorkflow = vi.fn<(intent: WorkflowFinalizationIntent) => void>();
    const releaseFailedWorkflowDescendants = vi.fn(() => []);
    const getExecutionService = vi.fn(() => harness.executionSvc);

    try {
      await expect(
        resumeAll({
          db: harness.db,
          progressStore: harness.progressStore,
          loadJobDetails: loadJobProjectionDetails,
          getExecutionService,
          createInvocationContext: () => {
            throw new Error('invocation context unavailable');
          },
          finalizeWorkflow,
          releaseFailedWorkflowDescendants,
          time: fixedTime,
        }),
      ).resolves.toEqual(['workflow-1', 'workflow-2']);
      expect(finalizeWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'failed',
          workflowJobId: 'workflow-1',
          lifecycleFault: expect.objectContaining({
            kind: 'recovery_failed',
            message: 'invocation context unavailable',
          }),
        }),
      );
      expect(getExecutionService).not.toHaveBeenCalled();
      expect(releaseFailedWorkflowDescendants).toHaveBeenCalledWith('workflow-1');
      expect(releaseFailedWorkflowDescendants).toHaveBeenCalledWith('workflow-2');
    } finally {
      harness.db.close();
    }
  });

  it('releases real adopted child state and continues to a healthy workflow after recovery fails', async () => {
    const backend = createSimulationBackend();
    const failedWorkflowId = 'workflow-adopted-child';
    const healthyWorkflowId = 'workflow-after-adopted-child';
    const failedPlan = buildWorkflowPlan(failedWorkflowId, parseExpression('architect'), {
      defaultProvider: 'codex',
    });
    const healthyPlan = buildWorkflowPlan(healthyWorkflowId, parseExpression('architect'), {
      defaultProvider: 'codex',
    });
    const childJobId = failedPlan.slots[0].slotId;
    const healthyChildJobId = healthyPlan.slots[0].slotId;
    const sessionId = 'session-adopted-child';
    const healthySessionId = 'session-healthy-child';
    const providerScope = backend.createInvocationContext().providerScope;
    if (providerScope === undefined) throw new Error('expected simulation provider scope');
    expect(childJobId.startsWith(`${failedWorkflowId}:`)).toBe(true);

    const appendWorkflowRoot = (workflowId: string, plan: WorkflowPlan): void => {
      commitWorkflowEvents(
        backend.progressStore.getDb(),
        (c) => {
          c.append(workflowPlanDeclaredEvent(workflowId, plan, providerScope));
          return undefined;
        },
        backend.runtime.time,
        permissiveProviderLookupPort,
      );
      backend.progressStore.appendLaunchRequested(workflowId, {
        jobId: workflowId,
        owner: { kind: 'workflow', id: workflowId },
        sessionId: null,
        provider: null,
        projectRoot: backend.projectRoot,
        backendNamespace: backend.namespace,
        jobKind: 'workflow',
        pool: 'default',
        enqueueSequence: backend.progressStore.nextEnqueueSequence(),
        request: { prompt: '', cwd: backend.projectRoot, bypassPermissions: false, coralEnv: {} },
        createdAt: '2026-04-27T00:00:00.000Z',
      });
      backend.progressStore.commit((c) => {
        c.append({
          type: 'job.runtime.started',
          stream: { kind: 'job', id: workflowId },
          namespace: backend.namespace,
          project: backend.projectRoot,
          refs: { jobId: workflowId, workflowId },
          body: { transport: 'workflow', startedAt: '2026-04-27T00:00:00.000Z' },
        });
        return undefined;
      });
    };

    appendWorkflowRoot(failedWorkflowId, failedPlan);
    seedTestSessionProjection(backend.progressStore.getDb(), {
      sessionId,
      provider: 'codex',
      projectRoot: backend.projectRoot,
      backendNamespace: backend.namespace,
      activeJobId: childJobId,
    });
    const sessionRow = backend.progressStore
      .getDb()
      .prepare<[string], { entry: string }>('SELECT entry FROM projection_sessions WHERE session_id = ?')
      .get(sessionId);
    if (sessionRow === undefined) throw new Error('expected adopted child session');
    const sessionEntry = JSON.parse(sessionRow.entry) as ProviderSession;
    sessionEntry.binding = {
      provider: 'codex',
      kind: 'profile',
      binding: {
        profile: { canonicalLocation: '/tmp/sim/accounts/codex', routing: { kind: 'home' } },
        guarantee: 'profile-only',
      },
    };
    backend.progressStore
      .getDb()
      .prepare('UPDATE projection_sessions SET entry = ? WHERE session_id = ?')
      .run(JSON.stringify(sessionEntry), sessionId);

    backend.runtime.spawner.enqueueDurable({ pid: 41_424, exit: null });
    const durable = await backend.runtime.process.durable.launch({
      provider: 'codex',
      command: 'codex',
      args: ['exec'],
      jobDir: backend.progressStore.jobDir(childJobId),
    });
    const childLaunch: JobLaunch = {
      jobId: childJobId,
      owner: { kind: 'workflow', id: failedWorkflowId },
      sessionId,
      provider: 'codex',
      projectRoot: backend.projectRoot,
      backendNamespace: backend.namespace,
      jobKind: 'provider',
      pool: 'default',
      enqueueSequence: backend.progressStore.nextEnqueueSequence(),
      providerAction: 'exec',
      parentWorkflowJobId: failedWorkflowId,
      workflowSlotId: childJobId,
      workflowSlotGeneration: 0,
      request: { prompt: '', cwd: backend.projectRoot, bypassPermissions: false, coralEnv: {} },
      createdAt: '2026-04-27T00:00:00.000Z',
    };
    backend.progressStore.appendLaunchRequested(childJobId, childLaunch);
    backend.progressStore.appendRuntimeStarted(childJobId, durable.runtimeRecord);

    appendWorkflowRoot(healthyWorkflowId, healthyPlan);
    seedTestSessionProjection(backend.progressStore.getDb(), {
      sessionId: healthySessionId,
      provider: 'codex',
      projectRoot: backend.projectRoot,
      backendNamespace: backend.namespace,
      activeJobId: healthyChildJobId,
    });
    backend.progressStore.appendLaunchRequested(healthyChildJobId, {
      ...childLaunch,
      jobId: healthyChildJobId,
      owner: { kind: 'workflow', id: healthyWorkflowId },
      sessionId: healthySessionId,
      parentWorkflowJobId: healthyWorkflowId,
      workflowSlotId: healthyChildJobId,
      enqueueSequence: backend.progressStore.nextEnqueueSequence(),
    });
    commitJobTerminal(backend.progressStore, healthyChildJobId, healthySessionId, {
      content: 'healthy recovery',
      outcome: { kind: 'completed' },
      durationMs: 0,
    });
    const log = vi.fn<(message: string) => void>();
    const emitSessionReleased = vi.fn();
    const restoreActiveLaunch = vi.spyOn(backend.launchCoordinator, 'restoreActiveLaunch');
    const releaseLaunch = vi.spyOn(backend.launchCoordinator, 'releaseLaunch');
    const kill = vi.spyOn(backend.runtime.process, 'kill');
    const coordinatorCommit = (cb: Parameters<JobStore['commit']>[0]) => backend.progressStore.commit(cb);
    const recoveryCoordinator = createRecoveryCoordinator({
      progressStore: backend.progressStore,
      runtime: backend.runtime,
      runtimeState: { setLaunchFenceActive: vi.fn() },
      eventBus: backend.eventBus,
      getRecoveryService: () => backend.service,
      createInvocationContext: backend.createInvocationContext,
      log,
    });

    try {
      await recoveryCoordinator.runStartupRecovery({
        namespace: backend.namespace,
        bundleHash: 'test-bundle',
        runtime: backend.runtime,
        progressStore: backend.progressStore,
        getRecoveryService: () => backend.service,
        createInvocationContext: backend.createInvocationContext,
        signal: new AbortController().signal,
        log,
        cleanupStaleJobs: () => {},
        sessionLookup: createProjectionSessionLookup(backend.progressStore.getDb()),
        coordinatorCommit,
      });
      expect(restoreActiveLaunch).toHaveBeenCalledWith(childJobId, 'codex', childLaunch.owner, 'default');
      expect(backend.launchCoordinator.getActiveJobIds()).toContain(childJobId);

      const releaseFailedWorkflowDescendants = createFailedWorkflowDescendantReleaser({
        progressStore: backend.progressStore,
        runtime: backend.runtime,
        coordinatorCommit,
        getExecutionService: () => backend.service,
        createInvocationContext: backend.createInvocationContext,
        releaseAdoptedJob: recoveryCoordinator.releaseAdoptedJob,
        emitSessionReleased,
      });
      let workflowServiceCalls = 0;

      await expect(
        resumeAll({
          db: backend.progressStore.getDb(),
          progressStore: backend.progressStore,
          loadJobDetails: loadJobProjectionDetails,
          getExecutionService: () => {
            workflowServiceCalls += 1;
            if (workflowServiceCalls === 1) {
              throw new Error('workflow recovery failed after child adoption');
            }
            return backend.service as never;
          },
          createInvocationContext: backend.createInvocationContext,
          finalizeWorkflow: createWorkflowRecoveryFinalizer({
            runtime: backend.runtime,
            progressStore: backend.progressStore,
            coordinatorCommit,
            log,
          }),
          releaseFailedWorkflowDescendants,
          log,
          time: backend.runtime.time,
        }),
      ).resolves.toEqual([failedWorkflowId, healthyWorkflowId]);

      expect(backend.progressStore.readStatus(failedWorkflowId)?.phase).toBe('error');
      expect(backend.progressStore.readStatus(healthyWorkflowId)?.phase).toBe('completed');
      expect(kill).toHaveBeenCalledWith(durable.pid, 'SIGTERM');
      expect(releaseLaunch).toHaveBeenCalledWith(childJobId, 'default');
      expect(backend.launchCoordinator.getActiveJobIds()).not.toContain(childJobId);
      expect(backend.service.abort([childJobId])).toEqual({ aborted: [], notFound: [childJobId] });
      expect(
        createProjectionSessionLookup(backend.progressStore.getDb()).readProviderSession(sessionId)?.activeJobId,
      ).toBe(undefined);
      expect(emitSessionReleased).toHaveBeenCalledWith({ sessionId, jobId: childJobId });
      expect(log).toHaveBeenCalledWith(
        `Workflow recovery child ${childJobId} session claim ${sessionId} disposition: released.\n`,
      );
      expect(releaseFailedWorkflowDescendants(failedWorkflowId)).toEqual([
        { jobId: childJobId, sessionId, sessionClaimRelease: 'already_absent' },
      ]);
    } finally {
      await recoveryCoordinator.teardown();
      await backend.backend.shutdown('test cleanup');
    }
  });

  it('returns after emitting an aborted finalization intent', async () => {
    const harness = createHarness({
      atomPhase: 'running',
      projectionPhase: null,
      atomTerminals: {
        0: { content: '', outcome: { kind: 'aborted', reason: 'user_abort' }, durationMs: 0 },
      },
    });
    const finalizeWorkflow = vi.fn<(intent: WorkflowFinalizationIntent) => void>();
    const releaseFailedWorkflowDescendants = vi.fn(() => []);
    const log = vi.fn<(message: string) => void>();

    try {
      await expect(
        resumeAll({
          db: harness.db,
          progressStore: harness.progressStore,
          loadJobDetails: loadJobProjectionDetails,
          getExecutionService: () => harness.executionSvc,
          createInvocationContext: harness.createInvocationContext,
          finalizeWorkflow,
          releaseFailedWorkflowDescendants,
          log,
          time: fixedTime,
        }),
      ).resolves.toEqual(['workflow-1']);
      expect(finalizeWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'aborted', workflowJobId: 'workflow-1' }),
      );
      expect(releaseFailedWorkflowDescendants).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('with aborted outcome'));
      expect(log.mock.calls.flat().join('')).not.toContain('after recovery failed');
    } finally {
      harness.db.close();
    }
  });

  it('contains a thrown workflow execution abort and emits an aborted finalization intent', async () => {
    const harness = createHarness({ atomPhase: 'running', projectionPhase: 'running' });
    const finalizeWorkflow = vi.fn<(intent: WorkflowFinalizationIntent) => void>();
    const releaseFailedWorkflowDescendants = vi.fn(() => []);
    const workflowAbort = createWorkflowExecutionError('workflow child aborted', true, []);

    try {
      await expect(
        resumeAll({
          db: harness.db,
          progressStore: harness.progressStore,
          loadJobDetails: loadJobProjectionDetails,
          getExecutionService: () => {
            throw workflowAbort;
          },
          createInvocationContext: harness.createInvocationContext,
          finalizeWorkflow,
          releaseFailedWorkflowDescendants,
          time: fixedTime,
        }),
      ).resolves.toEqual(['workflow-1']);
      expect(finalizeWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'aborted', workflowJobId: 'workflow-1' }),
      );
    } finally {
      harness.db.close();
    }
  });

  it('propagates a failed workflow finalizer without releasing descendants', async () => {
    const harness = createHarness({ atomPhase: 'running', projectionPhase: 'running' });
    const finalizerError = new Error('workflow finalizer unavailable');
    const finalizeWorkflow = vi.fn(() => {
      throw finalizerError;
    });
    const releaseFailedWorkflowDescendants = vi.fn(() => []);

    try {
      await expect(
        resumeAll({
          db: harness.db,
          progressStore: harness.progressStore,
          loadJobDetails: loadJobProjectionDetails,
          getExecutionService: () => {
            throw new Error('workflow execution recovery failed');
          },
          createInvocationContext: harness.createInvocationContext,
          finalizeWorkflow,
          releaseFailedWorkflowDescendants,
          time: fixedTime,
        }),
      ).rejects.toBe(finalizerError);
      expect(finalizeWorkflow).toHaveBeenCalledOnce();
      expect(releaseFailedWorkflowDescendants).not.toHaveBeenCalled();
    } finally {
      harness.db.close();
    }
  });

  it('propagates coordinator cancellation without invoking the workflow finalizer', async () => {
    const harness = createHarness({ atomPhase: 'running', projectionPhase: 'running' });
    const finalizeWorkflow = vi.fn<(intent: WorkflowFinalizationIntent) => void>();
    const releaseFailedWorkflowDescendants = vi.fn(() => []);
    const cancellation = new AbortError({ stage: 'workflow recovery' });
    harness.executionSvc.waitStream.mockReturnValue(failWait(cancellation));

    try {
      await expect(
        resumeAll({
          db: harness.db,
          progressStore: harness.progressStore,
          loadJobDetails: loadJobProjectionDetails,
          getExecutionService: () => harness.executionSvc,
          createInvocationContext: harness.createInvocationContext,
          finalizeWorkflow,
          releaseFailedWorkflowDescendants,
          time: fixedTime,
        }),
      ).rejects.toBe(cancellation);
      expect(finalizeWorkflow).not.toHaveBeenCalled();
      expect(releaseFailedWorkflowDescendants).not.toHaveBeenCalled();
    } finally {
      harness.db.close();
    }
  });
});
