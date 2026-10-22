import { currentCoralStoreFormat } from '#src/store-format.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { TEST_CODEX_SCOPE, TEST_CODEX_BINDING, TEST_CLAUDE_BINDING } from '#tests/helpers/provider-credentials.js';
import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
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
import { recoverAll as recoverAllWorkflows } from '#src/workflow/recover.js';
import { type WorkflowExecutionPort } from '#src/workflow/execution-contract.js';
import type { WorkflowFinalizationIntent } from '#src/workflow/finalization.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { composeReducers } from '#src/store/reducers.js';
import { readProjectionJobConversation } from '#src/jobs/conversation/read-queries.js';
import { createWorkflowRecoveryFinalizer } from '#src/coordinator/services/workflow-recovery-finalizer.js';
import { createFailedWorkflowDescendantReleaser } from '#src/coordinator/services/workflow-recovery-descendants.js';
import { ConversationManager } from '#src/jobs/conversation/shell.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { finalizeInterruptedDurableRecovery } from '#src/coordinator/services/recovery/interrupted-finalizer.js';
import type { DurableInterruptedRecoveryPlan } from '#src/coordinator/services/recovery/interrupted-plan.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { canonicalizeWorkDir } from '#src/runtime/canonical-work-dir.js';
import { requestedExecution } from '#tests/helpers/job-executions.js';
import { createTestExecutionFinisher } from '#tests/helpers/execution-finisher.js';

const PROJECT_ROOT = canonicalizeWorkDir(process.cwd(), process.cwd());
const BACKEND_NAMESPACE = 'workflow-test-ns';
type RecoverAllOptions = Parameters<typeof recoverAllWorkflows>[0];

function createWorkflowPlan(
  expression = 'architect',
  workflowId = '20000000-0000-4000-8000-000000000001',
): WorkflowPlan {
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
  const workflowId = options.workflowId ?? '20000000-0000-4000-8000-000000000001';

  const runtime = new SimulationRuntime();
  const progressStore = new JobStore(BACKEND_NAMESPACE, runtime, createEventBodyCodec(), {
    db,
    providers: permissiveProviderLookupPort,
    reducers: composeReducers(jobsRegistry, workflowRegistry),
  });
  const plan = createWorkflowPlan(options.expression, workflowId);
  const jobIdsBySlot = new Map<string, string>();
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  commitWorkflowEvents(
    db,
    (c) => {
      c.append(workflowPlanDeclaredEvent(workflowId, plan, TEST_CODEX_SCOPE));
      return undefined;
    },
    runtime.time,
    permissiveProviderLookupPort,
  );

  progressStore.appendLaunchRequested(workflowId, {
    jobId: workflowId,
    owner: { kind: 'workflow', id: workflowId },
    execution: 1,
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
      type: 'job.execution.started',
      stream: { kind: 'job', id: workflowId },
      namespace: BACKEND_NAMESPACE,
      project: projectRoot,
      refs: { jobId: workflowId, workflowId: workflowId },
      body: { execution: 1, transport: 'workflow', startedAt: new Date(runtime.time.now()).toISOString() },
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
    const terminalForSlot = slotState?.terminal;
    if (atomPhase !== null || terminalForSlot !== undefined || projectionPhase !== null) {
      progressStore.commit((commit) => {
        const metadata = {
          stream: { kind: 'job' as const, id: jobId },
          namespace: BACKEND_NAMESPACE,
          project: projectRoot,
          refs: { jobId, parentJobId: workflowId, workflowId, workflowSlotId: slot.slotId },
        };
        commit.append({
          ...metadata,
          type: 'job.opened',
          body: {
            owner: { kind: 'workflow', id: workflowId },
            projectRoot,
            createdAt: new Date(runtime.time.now()).toISOString(),
            jobKind: 'provider',
            workflowSlotId: slot.slotId,
            conversation: {
              provider: slot.provider,
              binding: slot.provider === 'claude' ? TEST_CLAUDE_BINDING : TEST_CODEX_BINDING,
              name: jobId,
              cwd: fixtureCanonicalWorkDir(projectRoot),
              bypassPermissions: false,
              retention: 'retain',
            },
          },
        });
        commit.append({
          ...metadata,
          ...requestedExecution(1, {
            backendNamespace: BACKEND_NAMESPACE,
            enqueueSequence: progressStore.nextEnqueueSequence(),
            createdAt: new Date(runtime.time.now()).toISOString(),
          }),
          stream: metadata.stream,
        });
        if (projectionPhase === 'running' || atomPhase === 'running') {
          commit.append({
            ...metadata,
            type: 'job.execution.started',
            body: {
              execution: 1,
              transport: 'app-server',
              startedAt: new Date(runtime.time.now()).toISOString(),
              providerMeta: { provider: slot.provider, leaseState: 'waiting' },
            },
          });
        } else if (projectionPhase === 'queued' || atomPhase === 'queued') {
          commit.append({
            ...metadata,
            type: 'job.execution.queued',
            body: { execution: 1, queuePosition: 0, runningJobIds: [] },
          });
        }
        return undefined;
      });
    }
    if (terminalForSlot !== undefined) commitJobTerminal(progressStore, jobId, 1, terminalForSlot);
  }

  const executionSvc = {
    coralDispatch: vi.fn<WorkflowExecutionPort['coralDispatch']>(),
    resume: vi.fn<WorkflowExecutionPort['resume']>(),
    abort: vi.fn(() => ({ aborted: [], notFound: [] })),
    awaitLaunch: vi.fn<WorkflowExecutionPort['awaitLaunch']>(),
    waitStream: vi.fn<WorkflowExecutionPort['waitStream']>(),
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

function recoveryOptions(harness: ReturnType<typeof createHarness>): RecoverAllOptions {
  const coordinatorCommit = (cb: Parameters<JobStore['commit']>[0]) => harness.progressStore.commit(cb);
  return {
    db: harness.db,
    progressStore: harness.progressStore,
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
      log: vi.fn(),
    }),
    ids: harness.runtime.ids,
    time: harness.runtime.time,
  };
}

async function recover(harness: ReturnType<typeof createHarness>, overrides: Partial<RecoverAllOptions> = {}) {
  const result = await recoverAllWorkflows({ ...recoveryOptions(harness), ...overrides });
  expect(harness.executionSvc.coralDispatch).not.toHaveBeenCalled();
  expect(harness.executionSvc.resume).not.toHaveBeenCalled();
  expect(harness.executionSvc.awaitLaunch).not.toHaveBeenCalled();
  expect(harness.executionSvc.waitStream).not.toHaveBeenCalled();
  return result;
}

function readContinuation(harness: ReturnType<typeof createHarness>) {
  return harness.db
    .prepare<[], { state: string; continuation_kind: string; continuation_key: string; error_message: string }>(
      `SELECT state, continuation_kind, continuation_key, error_message
         FROM recovery_quarantine
        WHERE boundary_id = 'workflow-recovery' AND subject_key = '20000000-0000-4000-8000-000000000001'`,
    )
    .get();
}

function storeContinuation(
  harness: ReturnType<typeof createHarness>,
  stage: 'prepared' | 'external-outcome-unknown' | 'ready-to-close',
  intent?: WorkflowFinalizationIntent,
) {
  const descendants = harness.db
    .prepare<[], { job_id: string; execution: number; project_root: string }>(
      "SELECT job_id, execution, project_root FROM projection_jobs WHERE parent_workflow_job_id = '20000000-0000-4000-8000-000000000001'",
    )
    .all()
    .map((row) => ({
      jobId: row.job_id,
      execution: row.execution,
      projectRoot: canonicalizeWorkDir(row.project_root, row.project_root),
    }));
  const childIds = descendants.map((child) => child.jobId);
  const continuation = {
    workflowId: '20000000-0000-4000-8000-000000000001',
    sourceRevision: 'earlier-build-revision',
    childIds,
    descendants,
    stage,
    intendedFinalization: intent === undefined ? { kind: 'pending' } : { kind: 'intent', intent },
    completedObligations: intent === undefined ? [] : ['workflow-recovery.resume'],
  };
  expect(
    new RecoveryQuarantineStore(harness.db, harness.runtime.time).upsert({
      boundary: 'workflow-recovery',
      subject: {
        key: '20000000-0000-4000-8000-000000000001',
        revision: { kind: 'fingerprint', value: 'earlier-build-revision' },
      },
      state: 'continuation',
      stage: 'settle',
      errorMessage: '',
      detail: 'workflow recovery settlement remains authoritative',
      continuation: { kind: 'workflow-recovery.v2', key: JSON.stringify(continuation) },
    }),
  ).toBe(true);
  return continuation;
}

function setPendingReplacement(harness: ReturnType<typeof createHarness>, prompt = 'replacement') {
  const jobId = harness.jobIdForSlot(harness.plan.slots[0].slotId);
  const status = harness.progressStore.readStatus(jobId);
  if (status?.execution !== 1) throw new Error('Expected the first child execution.');
  if (harness.progressStore.readTerminalProjection(jobId) === null) {
    commitJobTerminal(harness.progressStore, jobId, 1, {
      content: '',
      durationMs: 0,
      outcome: { kind: 'aborted', reason: 'signal_abort' },
    });
  }
  harness.progressStore.commit((commit) => {
    commit.append({
      ...requestedExecution(2, {
        backendNamespace: BACKEND_NAMESPACE,
        originatingClientMessageId: undefined,
        input: prompt,
        enqueueSequence: harness.progressStore.nextEnqueueSequence(),
        createdAt: new Date(harness.runtime.time.now()).toISOString(),
      }),
      stream: { kind: 'job', id: jobId },
      refs: {
        jobId,
        parentJobId: '20000000-0000-4000-8000-000000000001',
        workflowId: '20000000-0000-4000-8000-000000000001',
        workflowSlotId: harness.plan.slots[0].slotId,
      },
    });
    return undefined;
  });
}

function readChildConversation(harness: ReturnType<typeof createHarness>, slotIndex = 0) {
  return readProjectionJobConversation(harness.db, harness.jobIdForSlot(harness.plan.slots[slotIndex].slotId));
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
      c.append(
        workflowCompletedEvent('20000000-0000-4000-8000-000000000001', { outcome: 'completed', stepDetails: [] }),
      );
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
      expect(await recover(harness, { finalizeWorkflow })).toEqual(['20000000-0000-4000-8000-000000000001']);
      expect(finalizeWorkflow).toHaveBeenCalledWith({
        outcome: 'completed',
        workflowJobId: '20000000-0000-4000-8000-000000000001',
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
      expect(await recover(harness, { finalizeWorkflow })).toEqual(['20000000-0000-4000-8000-000000000001']);
      expect(finalizeWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome,
          workflowJobId: '20000000-0000-4000-8000-000000000001',
          stepDetails: [
            { stepIndex: 0, atomIndex: 0, label: 'architect', output: 'saved output' },
            { stepIndex: 0, atomIndex: 1, label: 'reviewer', output: 'saved error' },
          ],
          ...(outcome === 'failed'
            ? {
                lifecycleFault: {
                  kind: 'recovery_failed',
                  message: "Step 0, atom 'reviewer' failed: saved error",
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
      expect(await recover(harness, { finalizeWorkflow, releaseFailedWorkflowDescendants })).toEqual([
        '20000000-0000-4000-8000-000000000001',
      ]);
      expect(finalizeWorkflow).toHaveBeenCalledWith({
        outcome: 'failed',
        workflowJobId: '20000000-0000-4000-8000-000000000001',
        lifecycleFault: restartFault,
        stepDetails: [],
      });
      expect(releaseFailedWorkflowDescendants).toHaveBeenCalledWith('20000000-0000-4000-8000-000000000001');
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
      expect(await recover(harness, { finalizeWorkflow })).toEqual(['20000000-0000-4000-8000-000000000001']);
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
      expect(await recover(harness, { finalizeWorkflow })).toEqual(['20000000-0000-4000-8000-000000000001']);
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
        expect(harness.progressStore.readStatus('20000000-0000-4000-8000-000000000001')?.phase).toBe('running');
        expect(readChildConversation(harness)?.open).toBe(true);
        expect(readChildConversation(harness)?.execution).toBe(2);
        expect(finalizeWorkflow).not.toHaveBeenCalled();
        expect(releaseFailedWorkflowDescendants).not.toHaveBeenCalled();
        expect(harness.executionSvc.abort).not.toHaveBeenCalled();
      } finally {
        harness.db.close();
      }
    },
  );

  it.each(['prepared', 'external-outcome-unknown'] as const)(
    'settles a stored %s continuation after its last child records a terminal',
    async (stage) => {
      const harness = createHarness({
        expression: '(architect, reviewer)',
        atomPhase: 'running',
        projectionPhase: 'running',
      });
      storeContinuation(harness, stage);
      try {
        expect(await recover(harness)).toEqual([]);
        const firstChild = harness.jobIdForSlot(harness.plan.slots[0].slotId);
        const secondChild = harness.jobIdForSlot(harness.plan.slots[1].slotId);
        commitJobTerminal(harness.progressStore, firstChild, 1, completed);
        expect(await recover(harness)).toEqual([]);
        expect(harness.progressStore.readStatus('20000000-0000-4000-8000-000000000001')?.phase).toBe('running');
        commitJobTerminal(harness.progressStore, secondChild, 1, failed);
        expect(await recover(harness)).toEqual(['20000000-0000-4000-8000-000000000001']);
        expect(harness.progressStore.readStatus('20000000-0000-4000-8000-000000000001')?.phase).toBe('error');
        const completionRow = harness.db
          .prepare<
            [],
            { body: Buffer }
          >("SELECT body FROM events WHERE stream_id = '20000000-0000-4000-8000-000000000001' AND type = 'workflow.completed'")
          .get();
        if (completionRow === undefined) throw new Error('Expected durable workflow completion.');
        expect(decodeEventBody(completionRow.body)).toMatchObject({
          outcome: 'failed',
          stepDetails: [{ output: 'saved output' }, { output: 'saved error' }],
          failureLocation: { jobId: secondChild },
        });
        expect(readContinuation(harness)).toBeUndefined();
        expect(readChildConversation(harness)?.open).toBe(false);
        expect(readChildConversation(harness, 1)?.open).toBe(false);
      } finally {
        harness.db.close();
      }
    },
  );

  it.each(['prepared', 'external-outcome-unknown'] as const)(
    'clears a stored %s continuation when durable workflow completion is recorded',
    async (stage) => {
      const harness = createHarness({ atomPhase: 'running', projectionPhase: 'running' });
      storeContinuation(harness, stage);
      const finalizeWorkflow = vi.fn();
      try {
        expect(await recover(harness, { finalizeWorkflow })).toEqual([]);
        harness.progressStore.commit((c) => {
          c.append(
            workflowCompletedEvent('20000000-0000-4000-8000-000000000001', { outcome: 'completed', stepDetails: [] }),
          );
          return undefined;
        });
        expect(await recover(harness, { finalizeWorkflow })).toEqual([]);
        expect(finalizeWorkflow).not.toHaveBeenCalled();
        expect(readContinuation(harness)).toBeUndefined();
      } finally {
        harness.db.close();
      }
    },
  );

  it.each(['prepared', 'external-outcome-unknown'] as const)(
    'settles a stored %s continuation with no child journal rows',
    async (stage) => {
      const harness = createHarness({ atomPhase: null, projectionPhase: null });
      storeContinuation(harness, stage);
      try {
        expect(await recover(harness)).toEqual(['20000000-0000-4000-8000-000000000001']);
        expect(harness.progressStore.readStatus('20000000-0000-4000-8000-000000000001')?.phase).toBe('error');
        expect(readContinuation(harness)).toBeUndefined();
      } finally {
        harness.db.close();
      }
    },
  );

  it.each([
    {
      outcome: 'completed',
      workflowJobId: '20000000-0000-4000-8000-000000000001',
      finalOutput: 'recorded result',
      stepDetails: [],
    },
    {
      outcome: 'failed',
      workflowJobId: '20000000-0000-4000-8000-000000000001',
      lifecycleFault: restartFault,
      stepDetails: [],
    },
    {
      outcome: 'aborted',
      workflowJobId: '20000000-0000-4000-8000-000000000001',
      reason: 'signal_abort',
      stepDetails: [],
    },
  ] satisfies WorkflowFinalizationIntent[])(
    'closes a stored ready-to-close $outcome intent exactly as recorded',
    async (intent) => {
      const harness = createHarness({ atomPhase: 'running', projectionPhase: 'running' });
      setPendingReplacement(harness);
      storeContinuation(harness, 'ready-to-close', intent);
      const finalizeWorkflow = vi.fn();
      try {
        expect(await recover(harness, { finalizeWorkflow })).toEqual(['20000000-0000-4000-8000-000000000001']);
        expect(finalizeWorkflow).toHaveBeenCalledExactlyOnceWith(intent);
        expect(readChildConversation(harness)?.execution).toBe(2);
        expect(readContinuation(harness)).toBeUndefined();
      } finally {
        harness.db.close();
      }
    },
  );

  it.each(['replacement', 'retry replacement'])(
    'preserves a requested replacement with input %s without renewal or launch',
    async (prompt) => {
      const harness = createHarness({
        atomPhase: null,
        projectionPhase: null,
        slotStates: { 0: { terminal: failed } },
      });
      setPendingReplacement(harness, prompt);
      try {
        expect(await recover(harness)).toEqual(['20000000-0000-4000-8000-000000000001']);
        expect(readChildConversation(harness)).toMatchObject({ execution: 2, open: true, finishing: false });
        expect(
          harness.db
            .prepare(
              "SELECT 1 FROM events WHERE type = 'job.execution.requested' AND json_extract(CAST(body AS TEXT), '$.execution') = 3",
            )
            .get(),
        ).toBeUndefined();
        expect(readContinuation(harness)).toBeUndefined();
      } finally {
        harness.db.close();
      }
    },
  );

  it.each([false, true])(
    'preserves an adopted durable child with a replacement request %s so its later finalization commits',
    async (replacementRequested) => {
      const harness = createHarness({ atomPhase: 'queued', projectionPhase: 'queued' });
      if (replacementRequested) setPendingReplacement(harness);
      const options = recoveryOptions(harness);
      const childJobId = harness.jobIdForSlot(harness.plan.slots[0].slotId);
      const launchAdmission = new LaunchCoordinator({ runtime: harness.runtime });
      const launchPermit = launchAdmission.restoreActiveLaunch(
        childJobId,
        'codex',
        { kind: 'workflow', id: '20000000-0000-4000-8000-000000000001' },
        'default',
      );
      const releaseAdoptedJob = vi.fn(() => launchAdmission.releaseLaunch(launchPermit));
      options.releaseFailedWorkflowDescendants = createFailedWorkflowDescendantReleaser({
        progressStore: harness.progressStore,
        runtime: harness.runtime,
        coordinatorCommit: (cb) => harness.progressStore.commit(cb),
        getExecutionService: () => harness.executionSvc,
        createInvocationContext: harness.createInvocationContext,
        releaseAdoptedJob,
        log: vi.fn(),
      });
      const conversationManager = new ConversationManager(
        PROJECT_ROOT,
        harness.runtime,
        (cb) => harness.progressStore.commit(cb),
        harness.db,
      );
      const session = readProjectionJobConversation(harness.db, childJobId);
      const launch = harness.progressStore.readLaunchProjection(childJobId);
      const status = harness.progressStore.readStatus(childJobId);
      if (session === null || launch?.jobKind !== 'provider' || status === null) {
        throw new Error('Expected an open provider child.');
      }
      const runtimeRecord = {
        transport: 'durable-cli' as const,
        pid: 42,
        stdoutPath: '/jobs/stdout',
        stderrPath: '/jobs/stderr',
        startTime: new Date(harness.runtime.time.now()).toISOString(),
      };
      harness.progressStore.appendRuntimeStarted(childJobId, runtimeRecord);
      const plan: DurableInterruptedRecoveryPlan = {
        kind: 'durable-artifacts',
        launchRecord: launch,
        session,
        runtimeRecord,
        exit: { exitCode: 0, signal: null, endTime: new Date(harness.runtime.time.now()).toISOString() },
      };
      try {
        expect(await recover(harness, options)).toEqual(['20000000-0000-4000-8000-000000000001']);
        expect(harness.progressStore.readStatus('20000000-0000-4000-8000-000000000001')?.phase).toBe('error');
        expect(readProjectionJobConversation(harness.db, childJobId)).toMatchObject({
          jobId: childJobId,
          execution: session.execution,
          open: true,
          finishing: false,
        });
        expect(readProjectionJobConversation(harness.db, childJobId)?.execution).toBe(replacementRequested ? 2 : 1);
        expect(harness.progressStore.readTerminalProjection(childJobId)).toBeNull();
        expect(harness.executionSvc.abort).not.toHaveBeenCalled();
        expect(releaseAdoptedJob).not.toHaveBeenCalled();
        expect(launchAdmission.getActiveJobIds()).toContain(childJobId);
        expect(readContinuation(harness)).toBeUndefined();

        await finalizeInterruptedDurableRecovery(
          plan,
          {
            kind: 'durable-resolved',
            terminal: { kind: 'direct', value: completed },
            mutation: { kind: 'preserve' },
            artifactHandles: [],
          },
          status,
          {
            runtime: harness.runtime,
            conversationManager,
            executionFinisher: createTestExecutionFinisher(harness.progressStore, harness.runtime),
            abortRegistry: new AbortRegistry(),
            launchAdmission,
            launchPermit,
          },
        );
        expect(harness.progressStore.readTerminalProjection(childJobId)).toMatchObject(completed);
        expect(readProjectionJobConversation(harness.db, childJobId)).toMatchObject({
          execution: session.execution,
          open: false,
          finishing: false,
        });
        expect(launchAdmission.getActiveJobIds()).not.toContain(childJobId);
        expect(
          harness.db
            .prepare<
              [string, number],
              { count: number }
            >("SELECT COUNT(*) AS count FROM events WHERE stream_id = ? AND type = 'job.execution.ended' AND json_extract(CAST(body AS TEXT), '$.execution') = ?")
            .get(childJobId, session.execution)?.count,
        ).toBe(1);
      } finally {
        harness.db.close();
      }
    },
  );

  it('retries a failed durable close with its recorded intent', async () => {
    const harness = createHarness({ atomPhase: 'running', projectionPhase: 'running' });
    const finalizeWorkflow = vi.fn<(intent: WorkflowFinalizationIntent) => void>(() => {
      throw new Error('workflow finalizer unavailable');
    });
    const releaseFailedWorkflowDescendants = vi.fn(() => []);
    const upsert = vi.spyOn(RecoveryQuarantineStore.prototype, 'upsert');
    try {
      expect(await recover(harness, { finalizeWorkflow, releaseFailedWorkflowDescendants })).toEqual([]);
      expect(upsert.mock.calls.length).toBeGreaterThan(0);
      for (const [write] of upsert.mock.calls) {
        expect(JSON.parse(write.continuation?.key ?? 'null')).toMatchObject({ stage: 'ready-to-close' });
      }
      const stored = JSON.parse(readContinuation(harness)?.continuation_key ?? 'null') as {
        stage: string;
        intendedFinalization: { intent: WorkflowFinalizationIntent };
      };
      expect(stored.stage).toBe('ready-to-close');
      expect(stored.intendedFinalization.intent).toMatchObject({ outcome: 'failed', lifecycleFault: restartFault });
      expect(releaseFailedWorkflowDescendants).not.toHaveBeenCalled();
      finalizeWorkflow.mockImplementation(() => {});
      expect(await recover(harness, { finalizeWorkflow, releaseFailedWorkflowDescendants })).toEqual([
        '20000000-0000-4000-8000-000000000001',
      ]);
      expect(finalizeWorkflow.mock.calls[1]).toEqual([stored.intendedFinalization.intent]);
      expect(releaseFailedWorkflowDescendants).toHaveBeenCalledOnce();
      expect(readContinuation(harness)).toBeUndefined();
    } finally {
      upsert.mockRestore();
      harness.db.close();
    }
  });

  it('fails closed when a durable slot is owned by another workflow', async () => {
    const harness = createHarness({ atomPhase: 'running', projectionPhase: 'running' });
    const row = harness.db
      .prepare<
        [string],
        { seq: number; body: Buffer }
      >("SELECT seq, body FROM events WHERE stream_id = ? AND type = 'job.opened'")
      .get(harness.jobIdForSlot(harness.plan.slots[0].slotId));
    if (row === undefined) throw new Error('Expected child launch.');
    const body = decodeEventBody(row.body) as Record<string, unknown>;
    body.owner = { kind: 'provider-session', id: 'session-atom-1' };
    harness.db.prepare('UPDATE events SET body = ? WHERE seq = ?').run(encodeEventBody(body), row.seq);
    const finalizeWorkflow = vi.fn();
    try {
      expect(await recover(harness, { finalizeWorkflow })).toEqual(['20000000-0000-4000-8000-000000000001']);
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
    createHarness({
      db: harness.db,
      workflowId: '20000000-0000-4000-8000-000000000002',
      atomPhase: null,
      projectionPhase: null,
    });
    harness.db
      .prepare("UPDATE projection_workflows SET plan = ? WHERE workflow_id = '20000000-0000-4000-8000-000000000001'")
      .run('{invalid');
    try {
      expect(await recover(harness)).toEqual(['20000000-0000-4000-8000-000000000002']);
      expect(harness.progressStore.readStatus('20000000-0000-4000-8000-000000000002')?.phase).toBe('error');
      expect(readContinuation(harness)).toMatchObject({ state: 'active' });
      expect(harness.progressStore.readStatus('20000000-0000-4000-8000-000000000001')?.phase).toBe('running');
    } finally {
      harness.db.close();
    }
  });

  it.each(['no other conversation', 'another open conversation'] as const)(
    'closes an ended descendant with %s',
    async (disposition) => {
      const harness = createHarness({
        atomPhase: null,
        projectionPhase: null,
        slotStates: { 0: { terminal: failed } },
      });
      const childJobId = harness.jobIdForSlot(harness.plan.slots[0].slotId);
      storeContinuation(harness, 'ready-to-close', {
        outcome: 'failed',
        workflowJobId: '20000000-0000-4000-8000-000000000001',
        lifecycleFault: restartFault,
        stepDetails: [],
      });
      if (disposition === 'another open conversation') {
        harness.progressStore.initJob({
          jobId: '30000000-0000-4000-8000-000000000001',
          conversation: {
            provider: 'codex',
            binding: TEST_CODEX_BINDING,
            name: 'unrelated-successor',
            cwd: fixtureCanonicalWorkDir(PROJECT_ROOT),
            bypassPermissions: false,
            retention: 'retain',
          },
          projectRoot: PROJECT_ROOT,
          backendNamespace: BACKEND_NAMESPACE,
        });
      }
      const log = vi.fn();
      try {
        expect(await recover(harness, { log })).toEqual(['20000000-0000-4000-8000-000000000001']);
        expect(harness.progressStore.readStatus('20000000-0000-4000-8000-000000000001')?.phase).toBe('error');
        expect(readChildConversation(harness)).toMatchObject({ execution: 1, open: false });
        expect(readProjectionJobConversation(harness.db, '30000000-0000-4000-8000-000000000001')?.open).toBe(
          disposition === 'no other conversation' ? undefined : true,
        );
        expect(harness.executionSvc.abort).toHaveBeenCalledWith([childJobId]);
        expect(readContinuation(harness)).toBeUndefined();
      } finally {
        harness.db.close();
      }
    },
  );

  it('closes a stored descendant without inventing ownership when its projection is absent', async () => {
    const harness = createHarness({ atomPhase: null, projectionPhase: null, slotStates: { 0: { terminal: failed } } });
    const childJobId = harness.jobIdForSlot(harness.plan.slots[0].slotId);
    setPendingReplacement(harness);
    storeContinuation(harness, 'ready-to-close', {
      outcome: 'failed',
      workflowJobId: '20000000-0000-4000-8000-000000000001',
      lifecycleFault: restartFault,
      stepDetails: [],
    });
    harness.db.prepare('DELETE FROM projection_jobs WHERE job_id = ?').run(childJobId);
    try {
      expect(await recover(harness)).toEqual(['20000000-0000-4000-8000-000000000001']);
      expect(readChildConversation(harness)).toBeNull();
      expect(harness.db.prepare('SELECT 1 FROM projection_jobs WHERE job_id = ?').get(childJobId)).toBeUndefined();
      expect(harness.executionSvc.abort).not.toHaveBeenCalled();
      expect(readContinuation(harness)).toBeUndefined();
    } finally {
      harness.db.close();
    }
  });

  it('uses the canonical target of a persisted symlink root for descendant cleanup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-workflow-recovery-canonical-'));
    const physicalProject = join(root, 'physical-project');
    const selectedProject = join(root, 'selected-project');
    mkdirSync(physicalProject);
    symlinkSync(physicalProject, selectedProject, 'dir');
    const harness = createHarness({
      projectRoot: selectedProject,
      atomPhase: null,
      projectionPhase: null,
      slotStates: { 0: { terminal: failed } },
    });
    const createInvocationContext = vi.fn(harness.createInvocationContext);
    harness.createInvocationContext = createInvocationContext;
    try {
      expect(await recover(harness)).toEqual(['20000000-0000-4000-8000-000000000001']);
      expect(createInvocationContext).toHaveBeenCalledWith(realpathSync(physicalProject));
      expect(harness.executionSvc.abort).toHaveBeenCalledWith([harness.jobIdForSlot(harness.plan.slots[0].slotId)]);
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
