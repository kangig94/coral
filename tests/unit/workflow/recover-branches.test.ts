import { currentCoralStoreFormat } from '#src/store-format.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JobStore } from '#src/jobs/store.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import type { JobTerminal } from '#src/jobs/records.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { decodeEventBody, encodeEventBody } from '#src/store/body-codec.js';
import { parseExpression } from '#src/workflow/parser.js';
import { workflowCompletedEvent, workflowPlanDeclaredEvent, workflowRegistry } from '#src/workflow/events.js';
import { buildWorkflowPlan, type WorkflowPlan } from '#src/workflow/plan.js';
import { commitWorkflowEvents } from '#src/workflow/projections.js';
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
import { createProjectionSessionLookup } from '#src/sessions/lookup.js';
import { createWorkflowRecoveryFinalizer } from '#src/coordinator/services/workflow-recovery-finalizer.js';
import { createFailedWorkflowDescendantReleaser } from '#src/coordinator/services/workflow-recovery-descendants.js';
import { releaseSessionJobClaim } from '#src/sessions/job-release.js';
import { SessionManager } from '#src/sessions/shell.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { canonicalizeWorkDir } from '#src/runtime/canonical-work-dir.js';

const PROJECT_ROOT = canonicalizeWorkDir(process.cwd(), process.cwd());
const BACKEND_NAMESPACE = 'workflow-test-ns';
type ResumeAllOptions = Parameters<typeof resumeAllWorkflowRecovery>[0];

function createWorkflowPlan(expression = 'architect', workflowId = 'workflow-1'): WorkflowPlan {
  return buildWorkflowPlan(workflowId, parseExpression(expression), {
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
  workflowId?: string;
  db?: Database;
  atomPhase: 'running' | 'queued' | null;
  projectionPhase: 'running' | 'queued' | 'completed' | 'error' | 'aborted' | null;
  slotStates?: Partial<Record<number, SlotRecoveryState>>;
}) {
  const db = options.db ?? newRawDatabase(':memory:');
  if (options.db === undefined) applyBundledStoreSchema(db, currentCoralStoreFormat());
  const workflowId = options.workflowId ?? 'workflow-1';

  const runtime = new SimulationRuntime();
  const progressStore = new JobStore(BACKEND_NAMESPACE, runtime, createEventBodyCodec(), {
    db,
    providers: permissiveProviderLookupPort,
    reducers: composeReducers(jobsRegistry, sessionsRegistry, workflowRegistry),
  });
  const plan = createWorkflowPlan(options.expression, workflowId);
  const jobIdsBySlot = new Map<string, string>();
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  commitWorkflowEvents(
    db,
    (c) => {
      c.append(workflowPlanDeclaredEvent(workflowId, plan, TEST_PROVIDER_SCOPE));
      return undefined;
    },
    runtime.time,
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
      stream: { kind: 'job', id: workflowId },
      namespace: BACKEND_NAMESPACE,
      project: projectRoot,
      refs: { jobId: workflowId, workflowId: workflowId },
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
        owner: { kind: 'workflow', id: workflowId },
        sessionId,
        provider: slot.provider,
        projectRoot,
        backendNamespace: BACKEND_NAMESPACE,
        jobKind: 'provider',
        pool: 'default',
        enqueueSequence: progressStore.nextEnqueueSequence(),
        providerAction: 'exec',
        parentWorkflowJobId: workflowId,
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
        JSON.stringify({ kind: 'workflow', id: workflowId }),
        projectionPhase,
        sessionId,
        slot.provider,
        projectRoot,
        projectRoot,
        BACKEND_NAMESPACE,
        workflowId,
        slot.slotId,
        projectionLastSeq,
      );
    }
  }

  const executionSvc = {
    coralDispatch: vi.fn<WorkflowExecutionPort['coralDispatch']>(),
    resume: vi.fn<WorkflowExecutionPort['resume']>(),
    recordContinuationLease: vi.fn<WorkflowExecutionPort['recordContinuationLease']>(),
    clearContinuationLease: vi.fn<WorkflowExecutionPort['clearContinuationLease']>(),
    abort: vi.fn(() => ({ aborted: [], notFound: [] })),
    awaitLaunch: vi.fn<WorkflowExecutionPort['awaitLaunch']>(),
    waitStream: vi.fn<WorkflowExecutionPort['waitStream']>(),
    waitForJobTerminal: vi.fn<WorkflowExecutionPort['waitForJobTerminal']>(),
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

function recoveryOptions(harness: ReturnType<typeof createHarness>): ResumeAllOptions {
  const coordinatorCommit = (cb: Parameters<JobStore['commit']>[0]) => harness.progressStore.commit(cb);
  return {
    db: harness.db,
    progressStore: harness.progressStore,
    clearContinuationLease: (projectRoot, input) =>
      SessionManager.forProduction(projectRoot, harness.runtime, coordinatorCommit, () => {}, {
        db: harness.db,
      }).clearContinuationLease(input),
    finalizeWorkflow: createWorkflowRecoveryFinalizer({
      runtime: harness.runtime,
      progressStore: harness.progressStore,
      coordinatorCommit,
    }),
    releaseFailedWorkflowDescendants: createFailedWorkflowDescendantReleaser({
      progressStore: harness.progressStore,
      runtime: harness.runtime,
      coordinatorCommit,
      getExecutionService: () => harness.executionSvc,
      createInvocationContext: harness.createInvocationContext,
      releaseAdoptedJob: vi.fn(),
      emitSessionReleased: vi.fn(),
      log: vi.fn(),
    }),
    ids: harness.runtime.ids,
    time: harness.runtime.time,
  };
}

async function recover(harness: ReturnType<typeof createHarness>, overrides: Partial<ResumeAllOptions> = {}) {
  const result = await resumeAllWorkflowRecovery({ ...recoveryOptions(harness), ...overrides });
  expect(harness.executionSvc.coralDispatch).not.toHaveBeenCalled();
  expect(harness.executionSvc.resume).not.toHaveBeenCalled();
  expect(harness.executionSvc.awaitLaunch).not.toHaveBeenCalled();
  expect(harness.executionSvc.waitStream).not.toHaveBeenCalled();
  expect(harness.executionSvc.recordContinuationLease).not.toHaveBeenCalled();
  return result;
}

function readContinuation(harness: ReturnType<typeof createHarness>) {
  return harness.db
    .prepare<[], { state: string; continuation_kind: string; continuation_key: string; error_message: string }>(
      `SELECT state, continuation_kind, continuation_key, error_message
         FROM recovery_quarantine
        WHERE boundary_id = 'workflow-recovery' AND subject_key = 'workflow-1'`,
    )
    .get();
}

function storeContinuation(
  harness: ReturnType<typeof createHarness>,
  stage: 'prepared' | 'external-outcome-unknown' | 'ready-to-close',
  intent?: WorkflowFinalizationIntent,
) {
  const sessions = harness.db.prepare<[], { entry: string }>('SELECT entry FROM projection_sessions').all();
  const childIds = harness.db
    .prepare<[], { job_id: string }>("SELECT job_id FROM projection_jobs WHERE parent_workflow_job_id = 'workflow-1'")
    .all()
    .map((row) => row.job_id);
  const continuation = {
    workflowId: 'workflow-1',
    sourceRevision: 'earlier-build-revision',
    childIds,
    providerSessions: sessions.map(({ entry }) => {
      const session = JSON.parse(entry) as ProviderSession;
      return {
        sessionId: session.sessionId,
        projectRoot: PROJECT_ROOT,
        version: session.version,
        activeJobId: session.activeJobId ?? null,
        continuationLease: session.continuationLease ?? null,
      };
    }),
    stage,
    intendedFinalization: intent === undefined ? { kind: 'pending' } : { kind: 'intent', intent },
    completedObligations: intent === undefined ? [] : ['workflow-recovery.resume'],
  };
  expect(
    new RecoveryQuarantineStore(harness.db, harness.runtime.time).upsert({
      boundary: 'workflow-recovery',
      subject: { key: 'workflow-1', revision: { kind: 'until-cleared' } },
      state: 'continuation',
      stage: 'settle',
      errorMessage: '',
      detail: 'workflow recovery settlement remains authoritative',
      continuation: { kind: 'workflow-recovery.v1', key: JSON.stringify(continuation) },
    }),
  ).toBe(true);
  return continuation;
}

function setPendingReplacement(harness: ReturnType<typeof createHarness>, expiresAt = '2099-01-01T00:00:00.000Z') {
  const sessionId = 'session-atom-1';
  const entry = createProjectionSessionLookup(harness.db).readProviderSession(sessionId);
  if (entry === undefined) throw new Error('Expected workflow provider session.');
  harness.db.prepare('UPDATE projection_sessions SET entry = ? WHERE session_id = ?').run(
    JSON.stringify({
      ...entry,
      continuationLease: {
        status: 'pending',
        staleJobId: harness.jobIdForSlot(harness.plan.slots[0].slotId),
        workflowId: 'workflow-1',
        workflowSlotId: harness.plan.slots[0].slotId,
        replacementGeneration: 1,
        reason: 'stale_recovery',
        expiresAt,
        recordedAt: '2026-04-27T00:00:00.000Z',
      },
    }),
    sessionId,
  );
}

const completed: JobTerminal = { content: 'saved output', outcome: { kind: 'completed' }, durationMs: 0 };
const failed: JobTerminal = { content: 'saved error', outcome: { kind: 'provider_exit', code: 1 }, durationMs: 0 };
const restartFault = {
  kind: 'recovery_failed',
  message: 'The coordinator restarted; the remaining workflow steps were not resumed.',
} as const;

describe('workflow recovery without execution', () => {
  it('clears the continuation when the workflow already has a durable completion', async () => {
    const harness = createHarness({ atomPhase: null, projectionPhase: null });
    harness.progressStore.commit((c) => {
      c.append(workflowCompletedEvent('workflow-1', { outcome: 'completed', stepDetails: [] }));
      return undefined;
    });
    const finalizeWorkflow = vi.fn();
    const releaseFailedWorkflowDescendants = vi.fn(() => []);
    try {
      expect(await recover(harness, { finalizeWorkflow, releaseFailedWorkflowDescendants })).toEqual([]);
      expect(finalizeWorkflow).not.toHaveBeenCalled();
      expect(releaseFailedWorkflowDescendants).not.toHaveBeenCalled();
      expect(readContinuation(harness)).toBeUndefined();
    } finally {
      harness.db.close();
    }
  });

  it('completes a workflow whose steps all have durable successful terminals', async () => {
    const harness = createHarness({
      expression: 'architect -> reviewer',
      atomPhase: null,
      projectionPhase: null,
      slotStates: { 0: { terminal: completed }, 1: { terminal: { ...completed, content: 'final output' } } },
    });
    const finalizeWorkflow = vi.fn();
    try {
      expect(await recover(harness, { finalizeWorkflow })).toEqual(['workflow-1']);
      expect(finalizeWorkflow).toHaveBeenCalledWith({
        outcome: 'completed',
        workflowJobId: 'workflow-1',
        finalOutput: 'final output',
        stepDetails: [
          { stepIndex: 0, atomIndex: 0, label: 'architect', output: 'saved output' },
          { stepIndex: 1, atomIndex: 0, label: 'reviewer', output: 'final output' },
        ],
      });
      expect(readContinuation(harness)).toBeUndefined();
    } finally {
      harness.db.close();
    }
  });

  it.each([
    { outcome: 'failed', terminal: failed },
    {
      outcome: 'aborted',
      terminal: { ...failed, outcome: { kind: 'aborted', reason: 'signal_abort' } } as JobTerminal,
    },
  ])('closes $outcome from the active step when every launched atom is terminal', async ({ outcome, terminal }) => {
    const harness = createHarness({
      expression: '(architect, reviewer)',
      atomPhase: null,
      projectionPhase: null,
      slotStates: { 0: { terminal: completed }, 1: { terminal } },
    });
    const finalizeWorkflow = vi.fn();
    try {
      expect(await recover(harness, { finalizeWorkflow })).toEqual(['workflow-1']);
      expect(finalizeWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome,
          workflowJobId: 'workflow-1',
          stepDetails: [
            { stepIndex: 0, atomIndex: 0, label: 'architect', output: 'saved output' },
            { stepIndex: 0, atomIndex: 1, label: 'reviewer', output: 'saved error' },
          ],
          ...(outcome === 'failed'
            ? {
                lifecycleFault: {
                  kind: 'recovery_failed',
                  message: "Step 0, atom 'reviewer' failed: exited with code 1",
                },
                failureLocation: {
                  slotId: harness.plan.slots[1].slotId,
                  stepIndex: 0,
                  atomLabel: 'reviewer',
                  jobId: harness.jobIdForSlot(harness.plan.slots[1].slotId),
                },
              }
            : { reason: 'signal_abort' }),
        }),
      );
      expect(readContinuation(harness)).toBeUndefined();
    } finally {
      harness.db.close();
    }
  });

  it.each([
    { name: 'never launched', atomPhase: null, projectionPhase: null },
    { name: 'running', atomPhase: 'running', projectionPhase: 'running' },
    { name: 'queued', atomPhase: 'queued', projectionPhase: 'queued' },
  ] as const)('fails a $name step after restart', async ({ atomPhase, projectionPhase }) => {
    const harness = createHarness({ atomPhase, projectionPhase });
    const finalizeWorkflow = vi.fn();
    const releaseFailedWorkflowDescendants = vi.fn(() => []);
    try {
      expect(await recover(harness, { finalizeWorkflow, releaseFailedWorkflowDescendants })).toEqual(['workflow-1']);
      expect(finalizeWorkflow).toHaveBeenCalledWith({
        outcome: 'failed',
        workflowJobId: 'workflow-1',
        lifecycleFault: restartFault,
        stepDetails: [],
      });
      expect(releaseFailedWorkflowDescendants).toHaveBeenCalledWith('workflow-1');
      expect(readContinuation(harness)).toBeUndefined();
    } finally {
      harness.db.close();
    }
  });

  it.each([
    { name: 'partly launched', expression: '(architect, reviewer)', first: completed },
    { name: 'completed first step', expression: 'architect -> reviewer', first: completed },
    { name: 'failed child with a running sibling', expression: '(architect, reviewer)', first: failed, running: true },
  ])('fails a $name workflow without launching the missing work', async ({ expression, first, running }) => {
    const harness = createHarness({
      expression,
      atomPhase: null,
      projectionPhase: null,
      slotStates: {
        0: { terminal: first },
        ...(running ? { 1: { atomPhase: 'running' as const, projectionPhase: 'running' as const } } : {}),
      },
    });
    const finalizeWorkflow = vi.fn();
    try {
      expect(await recover(harness, { finalizeWorkflow })).toEqual(['workflow-1']);
      expect(finalizeWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'failed',
          lifecycleFault: restartFault,
          stepDetails: [{ stepIndex: 0, atomIndex: 0, label: 'architect', output: first.content }],
        }),
      );
      expect(readContinuation(harness)).toBeUndefined();
    } finally {
      harness.db.close();
    }
  });

  it('closes from a terminal failure even when a sibling was never launched', async () => {
    const harness = createHarness({
      expression: '(architect, reviewer)',
      atomPhase: null,
      projectionPhase: null,
      slotStates: { 0: { terminal: failed } },
    });
    const finalizeWorkflow = vi.fn();
    try {
      expect(await recover(harness, { finalizeWorkflow })).toEqual(['workflow-1']);
      expect(finalizeWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'failed',
          failureLocation: expect.objectContaining({ atomLabel: 'architect' }),
        }),
      );
    } finally {
      harness.db.close();
    }
  });

  it.each(['prepared', 'external-outcome-unknown'] as const)(
    'keeps a stored %s continuation deferred',
    async (stage) => {
      const harness = createHarness({ atomPhase: 'running', projectionPhase: 'running' });
      setPendingReplacement(harness);
      const stored = storeContinuation(harness, stage);
      const finalizeWorkflow = vi.fn();
      const releaseFailedWorkflowDescendants = vi.fn(() => []);
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          expect(await recover(harness, { finalizeWorkflow, releaseFailedWorkflowDescendants })).toEqual([]);
          expect(JSON.parse(readContinuation(harness)?.continuation_key ?? 'null')).toEqual(stored);
        }
        expect(harness.progressStore.readStatus('workflow-1')?.phase).toBe('running');
        expect(createProjectionSessionLookup(harness.db).readProviderSession('session-atom-1')?.activeJobId).toBe(
          harness.jobIdForSlot(harness.plan.slots[0].slotId),
        );
        expect(
          createProjectionSessionLookup(harness.db).readProviderSession('session-atom-1')?.continuationLease,
        ).toMatchObject({ status: 'cleared', outcome: 'explicit_clear' });
        expect(finalizeWorkflow).not.toHaveBeenCalled();
        expect(releaseFailedWorkflowDescendants).not.toHaveBeenCalled();
        expect(harness.executionSvc.abort).not.toHaveBeenCalled();
      } finally {
        harness.db.close();
      }
    },
  );

  it.each([
    { outcome: 'completed', workflowJobId: 'workflow-1', finalOutput: 'recorded result', stepDetails: [] },
    { outcome: 'failed', workflowJobId: 'workflow-1', lifecycleFault: restartFault, stepDetails: [] },
    { outcome: 'aborted', workflowJobId: 'workflow-1', reason: 'signal_abort', stepDetails: [] },
  ] satisfies WorkflowFinalizationIntent[])(
    'closes a stored ready-to-close $outcome intent exactly as recorded',
    async (intent) => {
      const harness = createHarness({ atomPhase: 'running', projectionPhase: 'running' });
      setPendingReplacement(harness);
      storeContinuation(harness, 'ready-to-close', intent);
      const finalizeWorkflow = vi.fn();
      try {
        expect(await recover(harness, { finalizeWorkflow })).toEqual(['workflow-1']);
        expect(finalizeWorkflow).toHaveBeenCalledExactlyOnceWith(intent);
        expect(
          createProjectionSessionLookup(harness.db).readProviderSession('session-atom-1')?.continuationLease,
        ).toMatchObject({ status: 'cleared', outcome: 'explicit_clear' });
        expect(readContinuation(harness)).toBeUndefined();
      } finally {
        harness.db.close();
      }
    },
  );

  it.each(['2099-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z'])(
    'clears a pending replacement expiring at %s without renewal or launch',
    async (expiresAt) => {
      const harness = createHarness({
        atomPhase: null,
        projectionPhase: null,
        slotStates: { 0: { terminal: failed } },
      });
      setPendingReplacement(harness, expiresAt);
      try {
        expect(await recover(harness)).toEqual(['workflow-1']);
        expect(
          createProjectionSessionLookup(harness.db).readProviderSession('session-atom-1')?.continuationLease,
        ).toMatchObject({
          status: 'cleared',
          outcome: 'explicit_clear',
          expiresAt,
        });
        expect(
          harness.db.prepare("SELECT 1 FROM events WHERE type = 'session.continuation_lease.recorded'").get(),
        ).toBeUndefined();
        expect(readContinuation(harness)).toBeUndefined();
      } finally {
        harness.db.close();
      }
    },
  );

  it('releases the descendant claim and process-local adoption when closing an unfinished workflow', async () => {
    const harness = createHarness({ atomPhase: 'running', projectionPhase: 'running' });
    const options = recoveryOptions(harness);
    const releaseAdoptedJob = vi.fn();
    const emitSessionReleased = vi.fn();
    options.releaseFailedWorkflowDescendants = createFailedWorkflowDescendantReleaser({
      progressStore: harness.progressStore,
      runtime: harness.runtime,
      coordinatorCommit: (cb) => harness.progressStore.commit(cb),
      getExecutionService: () => harness.executionSvc,
      createInvocationContext: harness.createInvocationContext,
      releaseAdoptedJob,
      emitSessionReleased,
      log: vi.fn(),
    });
    try {
      expect(await recover(harness, options)).toEqual(['workflow-1']);
      expect(harness.progressStore.readStatus('workflow-1')?.phase).toBe('error');
      expect(
        createProjectionSessionLookup(harness.db).readProviderSession('session-atom-1')?.activeJobId,
      ).toBeUndefined();
      const childJobId = harness.jobIdForSlot(harness.plan.slots[0].slotId);
      expect(harness.executionSvc.abort).toHaveBeenCalledWith([childJobId]);
      expect(releaseAdoptedJob).toHaveBeenCalledWith(childJobId);
      expect(emitSessionReleased).toHaveBeenCalledWith({ sessionId: 'session-atom-1', jobId: childJobId });
      expect(readContinuation(harness)).toBeUndefined();
    } finally {
      harness.db.close();
    }
  });

  it('retries a failed durable close with its recorded intent', async () => {
    const harness = createHarness({ atomPhase: 'running', projectionPhase: 'running' });
    const finalizeWorkflow = vi.fn<(intent: WorkflowFinalizationIntent) => void>(() => {
      throw new Error('workflow finalizer unavailable');
    });
    const releaseFailedWorkflowDescendants = vi.fn(() => []);
    try {
      expect(await recover(harness, { finalizeWorkflow, releaseFailedWorkflowDescendants })).toEqual([]);
      const stored = JSON.parse(readContinuation(harness)?.continuation_key ?? 'null') as {
        stage: string;
        intendedFinalization: { intent: WorkflowFinalizationIntent };
      };
      expect(stored.stage).toBe('ready-to-close');
      expect(stored.intendedFinalization.intent).toMatchObject({ outcome: 'failed', lifecycleFault: restartFault });
      expect(releaseFailedWorkflowDescendants).not.toHaveBeenCalled();
      finalizeWorkflow.mockImplementation(() => {});
      expect(await recover(harness, { finalizeWorkflow, releaseFailedWorkflowDescendants })).toEqual(['workflow-1']);
      expect(finalizeWorkflow.mock.calls[1]).toEqual([stored.intendedFinalization.intent]);
      expect(releaseFailedWorkflowDescendants).toHaveBeenCalledOnce();
      expect(readContinuation(harness)).toBeUndefined();
    } finally {
      harness.db.close();
    }
  });

  it('fails closed when a durable slot is owned by another workflow', async () => {
    const harness = createHarness({ atomPhase: 'running', projectionPhase: 'running' });
    const row = harness.db
      .prepare<
        [string],
        { seq: number; body: Buffer }
      >("SELECT seq, body FROM events WHERE stream_id = ? AND type = 'job.launch.requested'")
      .get(harness.jobIdForSlot(harness.plan.slots[0].slotId));
    if (row === undefined) throw new Error('Expected child launch.');
    const body = decodeEventBody(row.body) as Record<string, unknown>;
    body.owner = { kind: 'provider-session', id: 'session-atom-1' };
    harness.db.prepare('UPDATE events SET body = ? WHERE seq = ?').run(encodeEventBody(body), row.seq);
    const finalizeWorkflow = vi.fn();
    try {
      expect(await recover(harness, { finalizeWorkflow })).toEqual(['workflow-1']);
      expect(finalizeWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'failed',
          lifecycleFault: expect.objectContaining({ message: expect.stringContaining('invalid durable relation') }),
        }),
      );
    } finally {
      harness.db.close();
    }
  });

  it('quarantines a malformed workflow and still closes a valid sibling', async () => {
    const harness = createHarness({ atomPhase: null, projectionPhase: null });
    createHarness({ db: harness.db, workflowId: 'workflow-2', atomPhase: null, projectionPhase: null });
    harness.db.prepare("UPDATE projection_workflows SET plan = ? WHERE workflow_id = 'workflow-1'").run('{invalid');
    try {
      expect(await recover(harness)).toEqual(['workflow-2']);
      expect(harness.progressStore.readStatus('workflow-2')?.phase).toBe('error');
      expect(readContinuation(harness)).toMatchObject({ state: 'active' });
      expect(harness.progressStore.readStatus('workflow-1')?.phase).toBe('running');
    } finally {
      harness.db.close();
    }
  });

  it.each(['already absent', 'owned by another job'] as const)(
    'closes when a stored descendant claim is %s',
    async (disposition) => {
      const harness = createHarness({ atomPhase: 'running', projectionPhase: 'running' });
      const childJobId = harness.jobIdForSlot(harness.plan.slots[0].slotId);
      storeContinuation(harness, 'ready-to-close', {
        outcome: 'failed',
        workflowJobId: 'workflow-1',
        lifecycleFault: restartFault,
        stepDetails: [],
      });
      releaseSessionJobClaim({
        projectRoot: PROJECT_ROOT,
        runtime: harness.runtime,
        db: harness.db,
        commitEvents: (cb) => harness.progressStore.commit(cb),
        emitSessionReleased: () => {},
        sessionId: 'session-atom-1',
        jobId: childJobId,
      });
      if (disposition === 'owned by another job') {
        seedTestSessionProjection(harness.db, {
          sessionId: 'session-atom-1',
          provider: 'codex',
          projectRoot: PROJECT_ROOT,
          backendNamespace: BACKEND_NAMESPACE,
          activeJobId: 'unrelated-successor',
        });
      }
      const log = vi.fn();
      try {
        expect(await recover(harness, { log })).toEqual(['workflow-1']);
        expect(harness.progressStore.readStatus('workflow-1')?.phase).toBe('error');
        expect(createProjectionSessionLookup(harness.db).readProviderSession('session-atom-1')?.activeJobId).toBe(
          disposition === 'already absent' ? undefined : 'unrelated-successor',
        );
        expect(harness.executionSvc.abort).toHaveBeenCalledWith([childJobId]);
        expect(readContinuation(harness)).toBeUndefined();
      } finally {
        harness.db.close();
      }
    },
  );

  it('uses the canonical target of a persisted symlink root for lease clearance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-workflow-recovery-canonical-'));
    const physicalProject = join(root, 'physical-project');
    const selectedProject = join(root, 'selected-project');
    mkdirSync(physicalProject);
    symlinkSync(physicalProject, selectedProject, 'dir');
    const harness = createHarness({ projectRoot: selectedProject, atomPhase: 'running', projectionPhase: 'running' });
    setPendingReplacement(harness);
    const options = recoveryOptions(harness);
    const clearContinuationLease = vi.fn(options.clearContinuationLease);
    try {
      expect(await recover(harness, { clearContinuationLease })).toEqual(['workflow-1']);
      expect(clearContinuationLease).toHaveBeenCalledWith(realpathSync(physicalProject), {
        sessionId: 'session-atom-1',
        jobId: harness.jobIdForSlot(harness.plan.slots[0].slotId),
        outcome: 'explicit_clear',
      });
    } finally {
      harness.db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('quarantines an unresolvable persisted workflow root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-workflow-recovery-refusal-'));
    const missingProjectRoot = join(root, 'deleted-project');
    const harness = createHarness({
      projectRoot: missingProjectRoot,
      atomPhase: 'running',
      projectionPhase: 'running',
    });
    try {
      expect(await recover(harness)).toEqual([]);
      expect(readContinuation(harness)).toMatchObject({
        state: 'active',
        error_message: expect.stringContaining(missingProjectRoot),
      });
      expect(readContinuation(harness)?.error_message).toMatch(/ENOENT|no such file or directory/);
    } finally {
      harness.db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
