import { currentCoralStoreFormat } from '#src/store-format.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { TEST_PROVIDER_SCOPE, withTestProfileLocation } from '#tests/helpers/provider-credentials.js';
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JobStore } from '#src/jobs/store.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { createSimulationBackend } from '#tools/simulation/core/backend.js';
import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import type { JobTerminal } from '#src/jobs/records.js';
import type { WaitStreamEvent, WaitStreamRequest } from '#src/jobs/wait/contract.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { decodeEventBody, encodeEventBody } from '#src/store/body-codec.js';
import { parseExpression } from '#src/workflow/parser.js';
import { workflowPlanDeclaredEvent, workflowRegistry } from '#src/workflow/events.js';
import { buildWorkflowPlan, type WorkflowPlan } from '#src/workflow/plan.js';
import { commitWorkflowEvents } from '#src/workflow/projections.js';
import { loadJobProjectionDetails } from '#src/jobs/read-queries.js';
import { resumeAll as resumeAllWorkflowRecovery } from '#src/workflow/recover.js';
import { type WorkflowExecutionPort } from '#src/workflow/execution-contract.js';
import type { WorkflowFinalizationIntent } from '#src/workflow/finalization.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { composeReducers } from '#src/store/reducers.js';
import type { ProviderSession } from '#src/sessions/entry.js';
import type { ProviderSessionLaunchDecision } from '#src/jobs/launch.js';
import { createProjectionSessionLookup } from '#src/sessions/lookup.js';
import { createWorkflowRecoveryFinalizer } from '#src/coordinator/services/workflow-recovery-finalizer.js';
import { createFailedWorkflowDescendantReleaser } from '#src/coordinator/services/workflow-recovery-descendants.js';
import { releaseSessionJobClaim } from '#src/sessions/job-release.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { canonicalizeWorkDir, type CanonicalWorkDir } from '#src/runtime/canonical-work-dir.js';

let recoverClock = new Date('2026-04-27T00:00:00.000Z').getTime();
let recoverMonotonicClock = 0n;
const fixedTime = {
  now: () => {
    recoverClock += 100;
    return recoverClock;
  },
  monotonicNow: () => {
    recoverMonotonicClock += 100n;
    return recoverMonotonicClock;
  },
};

const PROJECT_ROOT = canonicalizeWorkDir(process.cwd(), process.cwd());
const BACKEND_NAMESPACE = 'workflow-test-ns';
const noFailedWorkflowDescendants = () => [];
const recoveryIds = { uuid: () => randomUUID() };

type ResumeAllOptions = Parameters<typeof resumeAllWorkflowRecovery>[0];

function resumeAll(options: Omit<ResumeAllOptions, 'ids'> & Partial<Pick<ResumeAllOptions, 'ids'>>) {
  return resumeAllWorkflowRecovery({ ids: recoveryIds, ...options });
}

async function settleWithVirtualTime<T>(operation: Promise<T>, advance: (ms: number) => Promise<void>): Promise<T> {
  let settled = false;
  void operation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await flushMicrotasks(200);
  for (let step = 0; !settled && step < 1_000; step += 1) {
    await advance(25);
  }
  if (!settled) throw new Error('Workflow recovery did not settle within the simulation virtual-time budget.');
  return operation;
}

function running(jobId: string, sessionId: string) {
  return {
    kind: 'provider-session' as const,
    status: 'running' as const,
    jobId,
    sessionId,
  };
}

function terminal(jobId: string, content: string, seq = 0): WaitStreamEvent {
  const result: JobTerminal = { content, outcome: { kind: 'completed' }, durationMs: 0 };
  return {
    type: 'terminal',
    jobId,
    seq,
    remainingJobIds: [],
    resultPath: `/tmp/coral-exports/jobs/${jobId}/result.md`,
    availability: { kind: 'available', resultPath: `/tmp/coral-exports/jobs/${jobId}/result.md` },
    result,
    cursor: { jobs: [] },
    exitCode: 0,
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

function persistedJobId(slotIndex: number): string {
  return `00000000-0000-4000-8000-${String(slotIndex + 1).padStart(12, '0')}`;
}

type SlotRecoveryState = {
  atomPhase?: 'running' | 'queued' | null;
  projectionPhase?: 'running' | 'queued' | 'completed' | 'error' | 'aborted' | null;
  terminal?: JobTerminal;
};

function createHarness(options: {
  expression?: string;
  projectRoot?: string;
  atomPhase: 'running' | 'queued' | null;
  projectionPhase: 'running' | 'queued' | 'completed' | 'error' | 'aborted' | null;
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
  const jobIdsBySlot = new Map<string, string>();
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
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
    projectRoot,
    backendNamespace: BACKEND_NAMESPACE,
    jobKind: 'workflow',
    pool: 'default',
    enqueueSequence: progressStore.nextEnqueueSequence(),
    request: {
      prompt: '',
      cwd: projectRoot,
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
      project: projectRoot,
      refs: { jobId: 'workflow-1', workflowId: 'workflow-1' },
      body: { transport: 'workflow', startedAt: new Date(runtime.time.now()).toISOString() },
    });
    return undefined;
  });

  for (const [slotIndex, slot] of plan.slots.entries()) {
    const jobId = persistedJobId(slotIndex);
    jobIdsBySlot.set(slot.slotId, jobId);
    const slotState = options.slotStates?.[slotIndex];
    const atomPhase = slotState && 'atomPhase' in slotState ? slotState.atomPhase : options.atomPhase;
    const projectionPhase =
      slotState && 'projectionPhase' in slotState ? slotState.projectionPhase : options.projectionPhase;
    const projectionLastSeq = 7;
    const terminalForSlot = slotState?.terminal;
    const sessionId = `session-atom-${slotIndex + 1}`;
    if (atomPhase !== null || terminalForSlot !== undefined) {
      seedTestSessionProjection(db, {
        sessionId,
        provider: slot.provider,
        projectRoot,
        backendNamespace: BACKEND_NAMESPACE,
        activeJobId: jobId,
      });
      progressStore.appendLaunchRequested(jobId, {
        jobId,
        owner: { kind: 'workflow', id: 'workflow-1' },
        sessionId,
        provider: slot.provider,
        projectRoot,
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
          cwd: projectRoot,
          bypassPermissions: false,
          coralEnv: {},
        },
        createdAt: new Date(runtime.time.now()).toISOString(),
      });
    }

    if (terminalForSlot !== undefined) {
      commitJobTerminal(progressStore, jobId, sessionId, terminalForSlot);
    }

    if (projectionPhase !== null) {
      db.prepare(
        `INSERT INTO projection_jobs (
           job_id, execution_owner, phase, diagnostics, session_id, provider, project_root, work_dir, backend_namespace,
           job_kind, parent_workflow_job_id, workflow_slot, created_at, last_seq
	         )
	         VALUES (?, ?, ?, '{"progressFaults":[]}', ?, ?, ?, ?, ?, 'provider', ?, ?, '2026-04-20T00:00:00.000Z', ?)
	         ON CONFLICT(job_id) DO UPDATE SET
	           execution_owner = excluded.execution_owner,
	           phase = excluded.phase,
	           diagnostics = excluded.diagnostics,
	           session_id = excluded.session_id,
	           provider = excluded.provider,
	           project_root = excluded.project_root,
	           work_dir = excluded.work_dir,
	           backend_namespace = excluded.backend_namespace,
	           job_kind = excluded.job_kind,
	           parent_workflow_job_id = excluded.parent_workflow_job_id,
	           workflow_slot = excluded.workflow_slot,
	           created_at = excluded.created_at,
	           last_seq = excluded.last_seq`,
      ).run(
        jobId,
        JSON.stringify({ kind: 'workflow', id: 'workflow-1' }),
        projectionPhase,
        sessionId,
        slot.provider,
        projectRoot,
        projectRoot,
        BACKEND_NAMESPACE,
        'workflow-1',
        slot.slotId,
        projectionLastSeq,
      );
    }
  }

  const executionSvc: WorkflowExecutionPort & {
    coralDispatch: ReturnType<typeof vi.fn<WorkflowExecutionPort['coralDispatch']>>;
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
      const nextSeq = Math.max(0, ...(req.cursor?.jobs ?? []).map((entry) => entry.seq)) + 1;
      return emit(req.jobIds.map((jobId, index) => terminal(jobId, `result:${jobId}`, nextSeq + index)));
    }),
    waitForJobTerminal: vi.fn(async () => {}),
  };

  const createInvocationContext = (projectRoot: string): InvocationContext => ({
    projectRoot: fixtureCanonicalWorkDir(projectRoot),
    pluginRoot: '/tmp/coral-workflow-plugin',
    coralEnv: {},
    principal: testProjectPrincipal(projectRoot),
  });

  const jobIdForSlot = (slotId: string): string => {
    const jobId = jobIdsBySlot.get(slotId);
    if (jobId === undefined) throw new Error(`No persisted job id for slot '${slotId}'.`);
    return jobId;
  };

  return { db, plan, progressStore, executionSvc, createInvocationContext, runtime, jobIdForSlot };
}

describe('workflow recovery branch rules', () => {
  it('constructs recovery context from the canonical target of a persisted symlink root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-workflow-recovery-canonical-'));
    const physicalProject = join(root, 'physical-project');
    const selectedProject = join(root, 'selected-project');
    mkdirSync(physicalProject);
    symlinkSync(physicalProject, selectedProject, 'dir');
    const harness = createHarness({
      projectRoot: selectedProject,
      atomPhase: 'running',
      projectionPhase: 'running',
    });
    const contextRoots: CanonicalWorkDir[] = [];

    try {
      const resumed = await resumeAll({
        db: harness.db,
        progressStore: harness.progressStore,
        loadJobDetails: loadJobProjectionDetails,
        getExecutionService: () => harness.executionSvc,
        createInvocationContext: (projectRoot) => {
          contextRoots.push(projectRoot);
          return harness.createInvocationContext(projectRoot);
        },
        finalizeWorkflow: vi.fn(),
        releaseFailedWorkflowDescendants: noFailedWorkflowDescendants,
        time: fixedTime,
      });

      expect(resumed).toEqual(['workflow-1']);
      expect(contextRoots).toEqual([realpathSync(physicalProject)]);
    } finally {
      harness.db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('quarantines an unresolvable persisted workflow root with the explicit work-directory failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-workflow-recovery-refusal-'));
    const missingProjectRoot = join(root, 'deleted-project');
    const harness = createHarness({
      projectRoot: missingProjectRoot,
      atomPhase: 'running',
      projectionPhase: 'running',
    });

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

      expect(
        resumed,
        'AC11 silent divergence at the persisted-recovery workflow boundary: an unresolvable work directory was accepted',
      ).toEqual([]);
      const quarantine = harness.db
        .prepare<[], { stage: string; error_message: string; disposition_detail: string }>(
          `SELECT stage, error_message, disposition_detail
             FROM recovery_quarantine
            WHERE boundary_id = 'workflow-recovery'
              AND subject_key = 'workflow-1'`,
        )
        .get();
      expect(
        quarantine,
        'AC11 silent divergence at the persisted-recovery workflow boundary: the dedicated work-directory failure was not retained',
      ).toMatchObject({
        stage: 'hydrate',
        error_message: expect.stringContaining(missingProjectRoot),
        disposition_detail: 'workflow recovery hydration failed',
      });
      expect(quarantine?.error_message).toMatch(/ENOENT|no such file or directory/);
    } finally {
      harness.db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('relaunches an absent step with persisted source A instead of replacement-daemon source B', async () => {
    const harness = createHarness({ atomPhase: null, projectionPhase: null });
    const atomJobId = randomUUID();
    const ids = { uuid: vi.fn(() => atomJobId) };
    const replacementCredentials = withTestProfileLocation(TEST_PROVIDER_SCOPE, 'codex', '/replacement/.codex-b');
    const createReplacementContext = (projectRoot: CanonicalWorkDir): InvocationContext => ({
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
        ids,
        time: fixedTime,
      });

      expect(resumed).toEqual(['workflow-1']);
      expect(harness.executionSvc.coralDispatch).toHaveBeenCalledTimes(1);
      expect(vi.mocked(harness.executionSvc.coralDispatch).mock.calls[0]?.[3]?.providerScope).toEqual(
        TEST_PROVIDER_SCOPE,
      );
      expect(getExecutionService).toHaveBeenCalledWith(expect.objectContaining({ providerScope: TEST_PROVIDER_SCOPE }));
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
      .get(harness.jobIdForSlot(slot.slotId)) as { seq: number; body: Buffer };
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
            message: `Workflow recovery rejected invalid durable relation for slot '${slot.slotId}' and job '${harness.jobIdForSlot(slot.slotId)}'.`,
          }),
        }),
      );
      expect(harness.executionSvc.waitStream).not.toHaveBeenCalled();
    } finally {
      harness.db.close();
    }
  });

  it('defers an unknown external launch outcome and keeps descendant claims held', async () => {
    const harness = createHarness({
      expression: '(architect, reviewer)',
      atomPhase: 'running',
      projectionPhase: 'running',
      slotStates: {
        1: { atomPhase: null, projectionPhase: null },
      },
    });
    const externalError = new Error('launch response lost');
    harness.executionSvc.coralDispatch.mockRejectedValue(externalError);
    const coordinatorCommit = (cb: Parameters<JobStore['commit']>[0]) => harness.progressStore.commit(cb);
    const abort = vi.fn(() => ({ aborted: [], notFound: [] }));
    const releaseAdoptedJob = vi.fn();
    const releaseFailedWorkflowDescendants = createFailedWorkflowDescendantReleaser({
      progressStore: harness.progressStore,
      runtime: harness.runtime,
      coordinatorCommit,
      getExecutionService: () => ({ abort }),
      createInvocationContext: harness.createInvocationContext,
      releaseAdoptedJob,
      emitSessionReleased: vi.fn(),
      log: vi.fn(),
    });

    try {
      await expect(
        resumeAll({
          db: harness.db,
          progressStore: harness.progressStore,
          loadJobDetails: loadJobProjectionDetails,
          getExecutionService: () => harness.executionSvc,
          createInvocationContext: harness.createInvocationContext,
          finalizeWorkflow: createWorkflowRecoveryFinalizer({
            runtime: harness.runtime,
            progressStore: harness.progressStore,
            coordinatorCommit,
          }),
          releaseFailedWorkflowDescendants,
          time: fixedTime,
        }),
      ).resolves.toEqual([]);

      expect(harness.progressStore.readStatus('workflow-1')?.phase).toBe('running');
      expect(createProjectionSessionLookup(harness.db).readProviderSession('session-atom-1')?.activeJobId).toBe(
        harness.jobIdForSlot(harness.plan.slots[0].slotId),
      );
      expect(abort).not.toHaveBeenCalled();
      expect(releaseAdoptedJob).not.toHaveBeenCalled();
      const continuation = harness.db
        .prepare<[], { continuation_kind: string; continuation_key: string }>(
          `SELECT continuation_kind, continuation_key
             FROM recovery_quarantine
            WHERE boundary_id = 'workflow-recovery'
              AND subject_key = 'workflow-1'`,
        )
        .get();
      expect(continuation?.continuation_kind).toBe('workflow-recovery.v1');
      expect(JSON.parse(continuation?.continuation_key ?? '{}')).toMatchObject({
        stage: 'external-outcome-unknown',
        intendedFinalization: { kind: 'pending' },
      });

      await expect(
        resumeAll({
          db: harness.db,
          progressStore: harness.progressStore,
          loadJobDetails: loadJobProjectionDetails,
          getExecutionService: () => harness.executionSvc,
          createInvocationContext: harness.createInvocationContext,
          finalizeWorkflow: createWorkflowRecoveryFinalizer({
            runtime: harness.runtime,
            progressStore: harness.progressStore,
            coordinatorCommit,
          }),
          releaseFailedWorkflowDescendants,
          time: fixedTime,
        }),
      ).resolves.toEqual([]);
      expect(harness.executionSvc.coralDispatch).toHaveBeenCalledTimes(1);
      expect(abort).not.toHaveBeenCalled();
      expect(releaseAdoptedJob).not.toHaveBeenCalled();
    } finally {
      harness.db.close();
    }
  });

  it('defers a failed durable close and keeps its intended finalization authoritative', async () => {
    const harness = createHarness({ atomPhase: 'running', projectionPhase: 'running' });
    const finalizerError = new Error('workflow finalizer unavailable');
    const finalizeWorkflow = vi.fn<(intent: WorkflowFinalizationIntent) => void>(() => {
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
          signal: new AbortController().signal,
          time: fixedTime,
        }),
      ).resolves.toEqual([]);
      expect(finalizeWorkflow).toHaveBeenCalledOnce();
      expect(releaseFailedWorkflowDescendants).not.toHaveBeenCalled();
      const continuation = harness.db
        .prepare<[], { state: string; continuation_kind: string; continuation_key: string }>(
          `SELECT state, continuation_kind, continuation_key
             FROM recovery_quarantine
            WHERE boundary_id = 'workflow-recovery'
              AND subject_key = 'workflow-1'`,
        )
        .get();
      expect(continuation).toMatchObject({
        state: 'continuation',
        continuation_kind: 'workflow-recovery.v1',
      });
      expect(JSON.parse(continuation?.continuation_key ?? '{}')).toMatchObject({
        stage: 'ready-to-close',
        intendedFinalization: {
          kind: 'intent',
          intent: { outcome: 'failed', workflowJobId: 'workflow-1' },
        },
      });

      finalizeWorkflow.mockImplementation(() => {});
      await expect(
        resumeAll({
          db: harness.db,
          progressStore: harness.progressStore,
          loadJobDetails: loadJobProjectionDetails,
          getExecutionService: () => {
            throw new Error('workflow execution must not repeat after a durable intended close');
          },
          createInvocationContext: harness.createInvocationContext,
          finalizeWorkflow,
          releaseFailedWorkflowDescendants,
          signal: new AbortController().signal,
          time: fixedTime,
        }),
      ).resolves.toEqual(['workflow-1']);
      expect(finalizeWorkflow).toHaveBeenCalledTimes(2);
      expect(releaseFailedWorkflowDescendants).toHaveBeenCalledOnce();
      expect(
        harness.db
          .prepare(
            `SELECT 1
               FROM recovery_quarantine
              WHERE boundary_id = 'workflow-recovery'
                AND subject_key = 'workflow-1'`,
          )
          .get(),
      ).toBeUndefined();
    } finally {
      harness.db.close();
    }
  });

  // Issue #310. Recovery commits a replacement through `executionSvc.resume()` before it has validated
  // the durable state that follows, and its descendant authority was captured at hydration — so a job
  // this pass creates is not in the envelope this pass later cleans up.
  //
  // Every other replacement test in this file is structurally unable to see it: they pass
  // `noFailedWorkflowDescendants`, a bare function with no `composeAtomic`, so `atomicReleaser()`
  // returns null and the production release never runs at all. This one uses the real releaser and a
  // real `resume()` — the canonical-path mock above does update the session projection, but only to the
  // shape that test asserts, and the defect is exactly what the real claim swap writes there.
  //
  // The session must hold its claim when the child launches (`appendLaunchRequested` validates the
  // binding) and must have released it by the time recovery runs (`resumeResolved` rejects
  // `session_busy` before it ever reaches the replacement branch). That ordering is not incidental —
  // it is why the replaced session is never itself a descendant, and why the damage is an omission
  // rather than a rejection.
  it('cleans up the replacement it launched when recovery then fails', async () => {
    const backend = createSimulationBackend({ projectRoot: PROJECT_ROOT, pluginRoot: PROJECT_ROOT });
    const workflowId = 'workflow-replacement-envelope';
    const plan = buildWorkflowPlan(workflowId, parseExpression('architect'), { defaultProvider: 'codex' });
    const childJobId = plan.slots[0].slotId;
    const sessionId = 'session-replacement-envelope';
    const providerScope = backend.createInvocationContext().providerScope;
    if (providerScope === undefined) throw new Error('expected simulation provider scope');

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

    seedTestSessionProjection(backend.progressStore.getDb(), {
      sessionId,
      provider: 'codex',
      projectRoot: backend.projectRoot,
      backendNamespace: backend.namespace,
      activeJobId: childJobId,
    });
    backend.progressStore.appendLaunchRequested(childJobId, {
      jobId: childJobId,
      owner: { kind: 'workflow', id: workflowId },
      sessionId,
      provider: 'codex',
      projectRoot: backend.projectRoot,
      backendNamespace: backend.namespace,
      jobKind: 'provider',
      pool: 'default',
      enqueueSequence: backend.progressStore.nextEnqueueSequence(),
      providerAction: 'exec',
      parentWorkflowJobId: workflowId,
      workflowSlotId: childJobId,
      workflowSlotGeneration: 0,
      request: { prompt: '', cwd: backend.projectRoot, bypassPermissions: false, coralEnv: {} },
      createdAt: '2026-04-27T00:00:00.000Z',
    });
    commitJobTerminal(backend.progressStore, childJobId, sessionId, {
      content: '',
      outcome: { kind: 'job_fault', fault: { kind: 'ghost_launch' } },
      durationMs: 0,
    });

    // The crashed daemon released the claim and recorded a replacement intent it never completed.
    const sessionRow = backend.progressStore
      .getDb()
      .prepare<[string], { entry: string }>('SELECT entry FROM projection_sessions WHERE session_id = ?')
      .get(sessionId);
    if (sessionRow === undefined) throw new Error('expected persisted provider session');
    const sessionEntry = JSON.parse(sessionRow.entry) as ProviderSession & Record<string, unknown>;
    delete sessionEntry.activeJobId;
    sessionEntry.binding = {
      provider: 'codex',
      kind: 'profile',
      binding: {
        profile: { canonicalLocation: '/tmp/sim/accounts/codex', routing: { kind: 'home' } },
        guarantee: 'profile-only',
      },
    };
    sessionEntry.continuationLease = {
      status: 'pending',
      staleJobId: childJobId,
      workflowId,
      workflowSlotId: childJobId,
      replacementGeneration: 1,
      reason: 'stale_recovery',
      expiresAt: '2099-01-01T00:00:00.000Z',
      recordedAt: '2026-04-27T00:00:00.000Z',
    };
    sessionEntry.version = Number(sessionEntry.version) + 1;
    backend.progressStore
      .getDb()
      .prepare('UPDATE projection_sessions SET entry = ? WHERE session_id = ?')
      .run(JSON.stringify(sessionEntry), sessionId);

    const log = vi.fn<(message: string) => void>();
    const coordinatorCommit = (cb: Parameters<JobStore['commit']>[0]) => backend.progressStore.commit(cb);
    const releaseFailedWorkflowDescendants = createFailedWorkflowDescendantReleaser({
      progressStore: backend.progressStore,
      runtime: backend.runtime,
      coordinatorCommit,
      getExecutionService: () => backend.service,
      createInvocationContext: backend.createInvocationContext,
      releaseAdoptedJob: () => {},
      emitSessionReleased: () => {},
      log,
    });

    // Fails the step *after* the replacement has already committed — the window the ordering opens.
    // A Proxy rather than a spread: the execution service is a class instance, so spreading it drops
    // every prototype method and the run fails on `service.resume is not a function` instead of on the
    // defect. Methods bind to the target so private fields still resolve.
    //
    // The override also records what it was called with, because the assertions below cannot tell a
    // launched-then-abandoned replacement from a `resume()` that never launched one: if `resume()`
    // returned `rejected`, recovery still settles the workflow as failed and the session still ends with
    // no claim, so every assertion would pass while nothing was exercised. That is not hypothetical —
    // an earlier revision of this test kept the session's claim, `resumeResolved` rejected it as
    // `session_busy` before the replacement branch, and the test passed against the unfixed code.
    let replacementJobId: string | undefined;
    let claimWhileLaunching: string | undefined;
    const abort = vi.spyOn(backend.service, 'abort');
    const executionSvc = new Proxy(backend.service as object, {
      get: (target, property) => {
        if (property === 'awaitLaunch') {
          return async (jobId: string): Promise<'error'> => {
            replacementJobId = jobId;
            claimWhileLaunching = createProjectionSessionLookup(backend.progressStore.getDb()).readProviderSession(
              sessionId,
            )?.activeJobId;
            return 'error';
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as typeof backend.service;

    try {
      const settled = await settleWithVirtualTime(
        resumeAll({
          db: backend.progressStore.getDb(),
          progressStore: backend.progressStore,
          loadJobDetails: loadJobProjectionDetails,
          getExecutionService: () => executionSvc as never,
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
        backend.advance,
      );

      // The workflow does settle, and its close is not rejected. Pinned because the issue predicted the
      // opposite — that stale descendant authority would fail `composeAtomic` and defer recovery
      // permanently. It cannot: the replaced session had already released its claim, so it was never in
      // the descendant set whose version the close checks. The damage is only what is missing from that
      // set, and a passing close is what makes the omission silent.
      expect(settled).toEqual([workflowId]);
      expect(backend.progressStore.readStatus(workflowId)?.phase).toBe('error');

      // A replacement really launched, and really held the session — without this the assertions below
      // are satisfied by a `resume()` that never launched anything.
      expect(replacementJobId, 'recovery must have launched a replacement').toBeDefined();
      expect(replacementJobId).not.toBe(childJobId);
      expect(claimWhileLaunching, 'the replacement must hold the session claim while it launches').toBe(
        replacementJobId,
      );

      // Two obligations, and reverting either one alone must fail here. The claim release is what the
      // atomic close performs; the abort is what process-local cleanup performs. Asserting only the
      // first would let a reverted cleanup site pass while the replacement kept running.
      expect(
        createProjectionSessionLookup(backend.progressStore.getDb()).readProviderSession(sessionId)?.activeJobId,
        'the replacement launched during recovery must be released with the workflow it belongs to, not left holding its session',
      ).toBeUndefined();
      expect(abort, 'the replacement must also be stopped, not merely unclaimed').toHaveBeenCalledWith([
        replacementJobId,
      ]);
    } finally {
      await settleWithVirtualTime(backend.backend.shutdown('test-teardown'), backend.advance);
    }
  });

  // The sibling of the case above, and the one that was live on main before it: recovery's own lawful
  // work moves a claim it is going to release. Waiting for a child to terminate releases that child's
  // claim; completing a replacement intent swaps it. The close then has to release a descendant whose
  // claim has already moved.
  //
  // `composeAtomic` used to re-derive that judgement from a projection read and reject it — treating an
  // already-released claim as a conflict, and comparing a session version captured at hydration against
  // one this pass had itself advanced. A rejected close is not retried into a fresh read: the persisted
  // `ready-to-close` continuation comes back unchanged, so the workflow deferred forever.
  //
  // Nothing pinned it because the release primitive's own `already_absent` result was unreachable —
  // `describeSessionJobClaimReleaseResult` has carried a string for it that no run could produce.
  it('closes when a descendant claim was already released by recovery itself', async () => {
    const backend = createSimulationBackend({ projectRoot: PROJECT_ROOT, pluginRoot: PROJECT_ROOT });
    const workflowId = 'workflow-descendant-already-released';
    const plan = buildWorkflowPlan(workflowId, parseExpression('architect'), { defaultProvider: 'codex' });
    const childJobId = plan.slots[0].slotId;
    const sessionId = 'session-descendant-already-released';
    const providerScope = backend.createInvocationContext().providerScope;
    if (providerScope === undefined) throw new Error('expected simulation provider scope');

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

    // A running child still holding its claim — this is what makes it a descendant.
    seedTestSessionProjection(backend.progressStore.getDb(), {
      sessionId,
      provider: 'codex',
      projectRoot: backend.projectRoot,
      backendNamespace: backend.namespace,
      activeJobId: childJobId,
    });
    backend.progressStore.appendLaunchRequested(childJobId, {
      jobId: childJobId,
      owner: { kind: 'workflow', id: workflowId },
      sessionId,
      provider: 'codex',
      projectRoot: backend.projectRoot,
      backendNamespace: backend.namespace,
      jobKind: 'provider',
      pool: 'default',
      enqueueSequence: backend.progressStore.nextEnqueueSequence(),
      providerAction: 'exec',
      parentWorkflowJobId: workflowId,
      workflowSlotId: childJobId,
      workflowSlotGeneration: 0,
      request: { prompt: '', cwd: backend.projectRoot, bypassPermissions: false, coralEnv: {} },
      createdAt: '2026-04-27T00:00:00.000Z',
    });

    const log = vi.fn<(message: string) => void>();
    const coordinatorCommit = (cb: Parameters<JobStore['commit']>[0]) => backend.progressStore.commit(cb);
    const releaseFailedWorkflowDescendants = createFailedWorkflowDescendantReleaser({
      progressStore: backend.progressStore,
      runtime: backend.runtime,
      coordinatorCommit,
      getExecutionService: () => backend.service,
      createInvocationContext: backend.createInvocationContext,
      releaseAdoptedJob: () => {},
      emitSessionReleased: () => {},
      log,
    });

    // Recovery releases the claim itself — through the production primitive, not a hand-written row —
    // and then fails, so the close runs against a descendant that is already absent.
    const executionSvc = new Proxy(backend.service as object, {
      get: (target, property) => {
        if (property === 'waitStream') {
          return () => {
            releaseSessionJobClaim({
              projectRoot: backend.projectRoot,
              runtime: backend.runtime,
              db: backend.progressStore.getDb(),
              commitEvents: coordinatorCommit,
              emitSessionReleased: () => {},
              sessionId,
              jobId: childJobId,
            });
            throw new Error('workflow recovery failed after its own claim release');
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as typeof backend.service;

    try {
      const settled = await resumeAll({
        db: backend.progressStore.getDb(),
        progressStore: backend.progressStore,
        loadJobDetails: loadJobProjectionDetails,
        getExecutionService: () => executionSvc as never,
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
      });

      expect(settled, 'a claim recovery released itself must not make its own close unsatisfiable').toEqual([
        workflowId,
      ]);
      expect(backend.progressStore.readStatus(workflowId)?.phase).toBe('error');
      expect(log).toHaveBeenCalledWith(
        `Workflow recovery child ${childJobId} session claim ${sessionId} disposition: already absent.\n`,
      );
    } finally {
      await backend.backend.shutdown('test-teardown');
    }
  });

  // `resume()` starts the provider before it resolves (`activateCommittedProviderLaunch`), so a
  // replacement that terminalizes quickly has already released its own claim by the time the caller sees
  // a job id. The checkpoint must record it anyway. An earlier revision required the claim to still be
  // held there and threw — turning a replacement that had *succeeded* into a failed workflow and
  // dropping it from the cleanup envelope in the same move, which is the one thing the checkpoint exists
  // to prevent. It was the same moment-in-time expectation about a moving claim that `composeAtomic`
  // used to hold, re-introduced one layer up.
  it('records a replacement that released its claim before the checkpoint ran', async () => {
    const backend = createSimulationBackend({ projectRoot: PROJECT_ROOT, pluginRoot: PROJECT_ROOT });
    const workflowId = 'workflow-replacement-fast-terminal';
    const plan = buildWorkflowPlan(workflowId, parseExpression('architect'), { defaultProvider: 'codex' });
    const childJobId = plan.slots[0].slotId;
    const sessionId = 'session-replacement-fast-terminal';
    const providerScope = backend.createInvocationContext().providerScope;
    if (providerScope === undefined) throw new Error('expected simulation provider scope');

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

    seedTestSessionProjection(backend.progressStore.getDb(), {
      sessionId,
      provider: 'codex',
      projectRoot: backend.projectRoot,
      backendNamespace: backend.namespace,
      activeJobId: childJobId,
    });
    backend.progressStore.appendLaunchRequested(childJobId, {
      jobId: childJobId,
      owner: { kind: 'workflow', id: workflowId },
      sessionId,
      provider: 'codex',
      projectRoot: backend.projectRoot,
      backendNamespace: backend.namespace,
      jobKind: 'provider',
      pool: 'default',
      enqueueSequence: backend.progressStore.nextEnqueueSequence(),
      providerAction: 'exec',
      parentWorkflowJobId: workflowId,
      workflowSlotId: childJobId,
      workflowSlotGeneration: 0,
      request: { prompt: '', cwd: backend.projectRoot, bypassPermissions: false, coralEnv: {} },
      createdAt: '2026-04-27T00:00:00.000Z',
    });
    commitJobTerminal(backend.progressStore, childJobId, sessionId, {
      content: '',
      outcome: { kind: 'job_fault', fault: { kind: 'ghost_launch' } },
      durationMs: 0,
    });

    const sessionRow = backend.progressStore
      .getDb()
      .prepare<[string], { entry: string }>('SELECT entry FROM projection_sessions WHERE session_id = ?')
      .get(sessionId);
    if (sessionRow === undefined) throw new Error('expected persisted provider session');
    const sessionEntry = JSON.parse(sessionRow.entry) as ProviderSession & Record<string, unknown>;
    delete sessionEntry.activeJobId;
    sessionEntry.binding = {
      provider: 'codex',
      kind: 'profile',
      binding: {
        profile: { canonicalLocation: '/tmp/sim/accounts/codex', routing: { kind: 'home' } },
        guarantee: 'profile-only',
      },
    };
    sessionEntry.continuationLease = {
      status: 'pending',
      staleJobId: childJobId,
      workflowId,
      workflowSlotId: childJobId,
      replacementGeneration: 1,
      reason: 'stale_recovery',
      expiresAt: '2099-01-01T00:00:00.000Z',
      recordedAt: '2026-04-27T00:00:00.000Z',
    };
    sessionEntry.version = Number(sessionEntry.version) + 1;
    backend.progressStore
      .getDb()
      .prepare('UPDATE projection_sessions SET entry = ? WHERE session_id = ?')
      .run(JSON.stringify(sessionEntry), sessionId);

    const log = vi.fn<(message: string) => void>();
    const coordinatorCommit = (cb: Parameters<JobStore['commit']>[0]) => backend.progressStore.commit(cb);
    const releaseFailedWorkflowDescendants = createFailedWorkflowDescendantReleaser({
      progressStore: backend.progressStore,
      runtime: backend.runtime,
      coordinatorCommit,
      getExecutionService: () => backend.service,
      createInvocationContext: backend.createInvocationContext,
      releaseAdoptedJob: () => {},
      emitSessionReleased: () => {},
      log,
    });

    // `resume()` returns only after the replacement has already released its own claim — the race the
    // asynchronous activation makes reachable. `awaitLaunch` then fails so the close runs deterministically.
    let replacementJobId: string | undefined;
    const abort = vi.spyOn(backend.service, 'abort');
    const executionSvc = new Proxy(backend.service as object, {
      get: (target, property) => {
        if (property === 'awaitLaunch') return async (): Promise<'error'> => 'error';
        if (property === 'resume') {
          return async (...args: unknown[]) => {
            const decision = await (
              Reflect.get(target, property, target) as (...a: unknown[]) => Promise<ProviderSessionLaunchDecision>
            ).apply(target, args);
            if (decision.status === 'running' || decision.status === 'queued') {
              replacementJobId = decision.jobId;
              releaseSessionJobClaim({
                projectRoot: backend.projectRoot,
                runtime: backend.runtime,
                db: backend.progressStore.getDb(),
                commitEvents: coordinatorCommit,
                emitSessionReleased: () => {},
                sessionId,
                jobId: decision.jobId,
              });
            }
            return decision;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as typeof backend.service;

    try {
      const settled = await settleWithVirtualTime(
        resumeAll({
          db: backend.progressStore.getDb(),
          progressStore: backend.progressStore,
          loadJobDetails: loadJobProjectionDetails,
          getExecutionService: () => executionSvc as never,
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
        backend.advance,
      );

      expect(replacementJobId, 'recovery must have launched a replacement').toBeDefined();
      expect(settled).toEqual([workflowId]);
      expect(
        abort,
        'a replacement that finished before it could be checkpointed still belongs in the cleanup envelope',
      ).toHaveBeenCalledWith([replacementJobId]);
    } finally {
      await settleWithVirtualTime(backend.backend.shutdown('test-teardown'), backend.advance);
    }
  });

  // The third arm of the same result. A close that this pass defers is retried on a later pass, and by
  // then the launch fence is down — so another job can lawfully hold the session a stale descendant
  // names. Treating that as a conflict made the close permanently unsatisfiable: the persisted
  // `ready-to-close` record comes back unchanged every pass, and the descendant it names is never going
  // to hold that session again. `releaseJob` refusing to touch the other owner is the safety property;
  // the throw on top of it only converted a benign state into a workflow that never finishes.
  it('closes when a descendant session has since been claimed by another job', async () => {
    const backend = createSimulationBackend({ projectRoot: PROJECT_ROOT, pluginRoot: PROJECT_ROOT });
    const workflowId = 'workflow-descendant-foreign-owner';
    const plan = buildWorkflowPlan(workflowId, parseExpression('architect'), { defaultProvider: 'codex' });
    const childJobId = plan.slots[0].slotId;
    const sessionId = 'session-descendant-foreign-owner';
    const successorJobId = 'job-unrelated-successor';
    const providerScope = backend.createInvocationContext().providerScope;
    if (providerScope === undefined) throw new Error('expected simulation provider scope');

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

    seedTestSessionProjection(backend.progressStore.getDb(), {
      sessionId,
      provider: 'codex',
      projectRoot: backend.projectRoot,
      backendNamespace: backend.namespace,
      activeJobId: childJobId,
    });
    backend.progressStore.appendLaunchRequested(childJobId, {
      jobId: childJobId,
      owner: { kind: 'workflow', id: workflowId },
      sessionId,
      provider: 'codex',
      projectRoot: backend.projectRoot,
      backendNamespace: backend.namespace,
      jobKind: 'provider',
      pool: 'default',
      enqueueSequence: backend.progressStore.nextEnqueueSequence(),
      providerAction: 'exec',
      parentWorkflowJobId: workflowId,
      workflowSlotId: childJobId,
      workflowSlotGeneration: 0,
      request: { prompt: '', cwd: backend.projectRoot, bypassPermissions: false, coralEnv: {} },
      createdAt: '2026-04-27T00:00:00.000Z',
    });

    const log = vi.fn<(message: string) => void>();
    const coordinatorCommit = (cb: Parameters<JobStore['commit']>[0]) => backend.progressStore.commit(cb);
    const releaseFailedWorkflowDescendants = createFailedWorkflowDescendantReleaser({
      progressStore: backend.progressStore,
      runtime: backend.runtime,
      coordinatorCommit,
      getExecutionService: () => backend.service,
      createInvocationContext: backend.createInvocationContext,
      releaseAdoptedJob: () => {},
      emitSessionReleased: () => {},
      log,
    });

    // The child releases, an unrelated job claims the session, and only then does recovery fail — the
    // shape a deferred close finds when it is retried after the launch fence has lifted.
    const executionSvc = new Proxy(backend.service as object, {
      get: (target, property) => {
        if (property === 'waitStream') {
          return () => {
            releaseSessionJobClaim({
              projectRoot: backend.projectRoot,
              runtime: backend.runtime,
              db: backend.progressStore.getDb(),
              commitEvents: coordinatorCommit,
              emitSessionReleased: () => {},
              sessionId,
              jobId: childJobId,
            });
            seedTestSessionProjection(backend.progressStore.getDb(), {
              sessionId,
              provider: 'codex',
              projectRoot: backend.projectRoot,
              backendNamespace: backend.namespace,
              activeJobId: successorJobId,
            });
            throw new Error('workflow recovery failed while an unrelated job held the session');
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as typeof backend.service;

    try {
      const settled = await resumeAll({
        db: backend.progressStore.getDb(),
        progressStore: backend.progressStore,
        loadJobDetails: loadJobProjectionDetails,
        getExecutionService: () => executionSvc as never,
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
      });

      expect(settled, 'a session another job now owns must not make this close unsatisfiable forever').toEqual([
        workflowId,
      ]);
      expect(log).toHaveBeenCalledWith(
        `Workflow recovery child ${childJobId} session claim ${sessionId} disposition: owned by another job.\n`,
      );
      // The successor keeps its claim: recovery released nothing it did not own.
      expect(
        createProjectionSessionLookup(backend.progressStore.getDb()).readProviderSession(sessionId)?.activeJobId,
      ).toBe(successorJobId);
    } finally {
      await backend.backend.shutdown('test-teardown');
    }
  });
});
