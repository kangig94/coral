import { currentCoralStoreFormat } from '#src/store-format.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { afterAll, describe, expect, it } from 'vitest';

import { KbJobRecorder } from '#src/jobs/kb/recorder.js';
import { createWorkflowRecoveryFinalizer } from '#src/coordinator/services/workflow-recovery-finalizer.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { JobStore } from '#src/jobs/store.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { appendJobTerminalRecorded } from '#src/jobs/terminal/recording.js';
import type { JobTerminal } from '#src/jobs/records.js';
import { decodeEventBody } from '#src/store/body-codec.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { composeReducers } from '#src/store/reducers.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { workflowRegistry, workflowPlanDeclaredEvent } from '#src/workflow/events.js';
import type { WorkflowFinalizationIntent } from '#src/workflow/finalization.js';
import { parseExpression } from '#src/workflow/parser.js';
import { buildWorkflowPlan, type PlanSlot, type WorkflowPlan } from '#src/workflow/plan.js';
import { recoverAll } from '#src/workflow/recover.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';

const NOW = '2026-04-19T00:00:00.000Z';
const TEST_NAMESPACE = 'test-ns';
const PROJECT_ROOT = mkdtempSync(resolve(tmpdir(), 'coral-journal-atomicity-'));

afterAll(() => rmSync(PROJECT_ROOT, { recursive: true, force: true }));
type Db = Database;

function createDb(): Db {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return db;
}

function createWorkflowProgressStore(db: Db, runtime: SimulationRuntime): JobStore {
  return new JobStore(TEST_NAMESPACE, runtime, createEventBodyCodec(), {
    db,
    reducers: composeReducers(jobsRegistry, workflowRegistry),
    providers: permissiveProviderLookupPort,
  });
}

function initWorkflowJob(progressStore: JobStore, jobId: string): void {
  progressStore.appendLaunchRequested(jobId, {
    jobId,
    owner: { kind: 'workflow', id: jobId },
    sessionId: null,
    provider: null,
    projectRoot: PROJECT_ROOT,
    backendNamespace: TEST_NAMESPACE,
    jobKind: 'workflow',
    pool: 'default',
    enqueueSequence: progressStore.nextEnqueueSequence(),
    request: {
      prompt: '',
      cwd: PROJECT_ROOT,
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: NOW,
  });
  progressStore.commit((c) => {
    c.append({
      type: 'job.runtime.started',
      stream: { kind: 'job', id: jobId },
      namespace: TEST_NAMESPACE,
      project: PROJECT_ROOT,
      refs: { jobId, workflowId: jobId },
      body: { transport: 'workflow', startedAt: NOW },
    });
    return undefined;
  });
}

type WorkflowRecoveryHarness = {
  db: Db;
  runtime: SimulationRuntime;
  progressStore: JobStore;
  workflowId: string;
  plan: WorkflowPlan;
};

type WaitTerminalOutcome = JobTerminal['outcome'];

function createWorkflowRecoveryHarness(db: Db, workflowId: string, expression = 'architect'): WorkflowRecoveryHarness {
  const runtime = new SimulationRuntime();
  const progressStore = createWorkflowProgressStore(db, runtime);
  const plan = buildWorkflowPlan(workflowId, parseExpression(expression), {
    defaultProvider: 'codex',
  });
  progressStore.commit((c) => {
    c.append(workflowPlanDeclaredEvent(workflowId, plan, TEST_PROVIDER_SCOPE));
    return undefined;
  });
  initWorkflowJob(progressStore, workflowId);

  return {
    db,
    runtime,
    progressStore,
    workflowId,
    plan,
  };
}

function initWorkflowSlotJob(harness: WorkflowRecoveryHarness, slot: PlanSlot): string {
  const jobId = harness.runtime.ids.uuid();
  const sessionId = `${jobId}-session`;
  seedTestSessionProjection(harness.db, {
    sessionId,
    provider: slot.provider,
    projectRoot: PROJECT_ROOT,
    backendNamespace: TEST_NAMESPACE,
    activeJobId: jobId,
  });
  harness.progressStore.appendLaunchRequested(jobId, {
    jobId,
    owner: { kind: 'workflow', id: harness.workflowId },
    sessionId,
    provider: slot.provider,
    projectRoot: PROJECT_ROOT,
    backendNamespace: TEST_NAMESPACE,
    jobKind: 'provider',
    pool: 'default',
    enqueueSequence: harness.progressStore.nextEnqueueSequence(),
    providerAction: 'exec',
    parentWorkflowJobId: harness.workflowId,
    workflowSlotId: slot.slotId,
    workflowSlotGeneration: 0,
    request: {
      prompt: '',
      cwd: PROJECT_ROOT,
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: NOW,
  });
  harness.progressStore.appendRuntimeStarted(jobId, {
    transport: 'durable-cli',
    pid: 1,
    stdoutPath: `/tmp/${jobId}.stdout`,
    stderrPath: `/tmp/${jobId}.stderr`,
    startTime: NOW,
  });
  return jobId;
}

function appendWorkflowSlotTerminal(
  harness: WorkflowRecoveryHarness,
  slot: PlanSlot,
  jobId: string,
  terminal: { content: string; outcome: WaitTerminalOutcome; durationMs: number },
): void {
  harness.progressStore.commit((c) => {
    appendJobTerminalRecorded(c, {
      jobId,
      sessionId: `${jobId}-session`,
      namespace: TEST_NAMESPACE,
      project: PROJECT_ROOT,
      parentJobId: harness.workflowId,
      workflowSlotId: slot.slotId,
      terminal,
    });
    return undefined;
  });
}

function captureWorkflowIntents(delegate: (intent: WorkflowFinalizationIntent) => void = () => {}): {
  intents: WorkflowFinalizationIntent[];
  finalizeWorkflow(intent: WorkflowFinalizationIntent): void;
} {
  const intents: WorkflowFinalizationIntent[] = [];
  return {
    intents,
    finalizeWorkflow(intent) {
      intents.push(intent);
      delegate(intent);
    },
  };
}

async function closeRecoveryHarness(
  harness: WorkflowRecoveryHarness,
  finalizeWorkflow: (intent: WorkflowFinalizationIntent) => void,
): Promise<string[]> {
  return recoverAll({
    db: harness.db,
    progressStore: harness.progressStore,
    clearContinuationLease: async () => true,
    finalizeWorkflow,
    releaseFailedWorkflowDescendants: () => [],
    ids: harness.runtime.ids,
    time: harness.runtime.time,
  });
}

describe('journal commit atomicity invariant', () => {
  it('finds no orphan terminal-causing KB operation failure after the migrated recorder path', () => {
    const db = createDb();
    try {
      const runtime = new SimulationRuntime();
      const progressStore = new JobStore('test-ns', runtime, createEventBodyCodec(), {
        db,
        providers: permissiveProviderLookupPort,
      });
      const recorder = new KbJobRecorder({
        runtime,
        progressStore,
        backendNamespace: 'test-ns',
        bundleHash: 'bundle-a',
        abortRegistry: new AbortRegistry(runtime.ids),
      });

      const { jobId, startedAtMs } = recorder.startInternalJob({
        projectRoot: PROJECT_ROOT,
        operation: 'kb.reindex',
        request: {},
      });
      recorder.appendOperationFailureWithTerminal({
        jobId,
        projectRoot: PROJECT_ROOT,
        operation: 'reindex',
        message: 'KB reindex failed: index unavailable',
        detail: { operation: 'reindex', cause: { message: 'index unavailable' } },
        startedAtMs,
      });

      const rows = db
        .prepare(
          `SELECT seq, type, body
             FROM events
            WHERE stream_kind = 'job'
              AND stream_id = ?
            ORDER BY seq ASC`,
        )
        .all(jobId) as Array<{ seq: number; type: string; body: Buffer }>;
      expect(rows.map((row) => row.type)).toEqual([
        'job.launch.requested',
        'job.runtime.started',
        'job.progress.emitted',
        'job.terminal.recorded',
      ]);

      const progress = rows[2];
      const terminal = rows[3];
      expect(progress).toBeDefined();
      expect(terminal).toBeDefined();
      if (progress === undefined || terminal === undefined) {
        throw new Error('Expected KB recorder to append progress and terminal rows.');
      }
      const progressBody = decodeEventBody(progress.body);
      const terminalBody = decodeEventBody(terminal.body);

      expect(progressBody).toMatchObject({
        kind: 'domain',
        stage: 'kb_operation_failed',
      });
      expect(terminalBody).toMatchObject({
        terminal: {
          outcome: {
            kind: 'failed',
            causeRef: { stream: { kind: 'job', id: jobId }, seq: progress.seq },
          },
        },
      });
      expect(terminal.seq).toBe(progress.seq + 1);
    } finally {
      db.close();
    }
  });

  it('drives recoverAll through failure recovery with the real finalizer and persists causal rows', async () => {
    const db = createDb();
    try {
      const harness = createWorkflowRecoveryHarness(db, 'workflow-recover-path', '(architect, critic)');
      const [failedSlot, pendingSlot] = harness.plan.slots;
      if (failedSlot === undefined || pendingSlot === undefined) throw new Error('Expected two workflow slots.');
      const failedJobId = initWorkflowSlotJob(harness, failedSlot);
      appendWorkflowSlotTerminal(harness, failedSlot, failedJobId, {
        content: '',
        outcome: { kind: 'provider_exit', code: 1 },
        durationMs: 0,
      });
      const pendingJobId = initWorkflowSlotJob(harness, pendingSlot);
      appendWorkflowSlotTerminal(harness, pendingSlot, pendingJobId, {
        content: 'critic output',
        outcome: { kind: 'completed' },
        durationMs: 0,
      });
      const realFinalizer = createWorkflowRecoveryFinalizer({
        runtime: harness.runtime,
        progressStore: harness.progressStore,
        coordinatorCommit: (cb) => harness.progressStore.commit(cb),
        log: () => {},
      });
      const captured = captureWorkflowIntents(realFinalizer);
      const message = "Step 0, atom 'architect' failed: exited with code 1";

      await expect(closeRecoveryHarness(harness, captured.finalizeWorkflow)).resolves.toEqual([harness.workflowId]);

      expect(captured.intents).toEqual([
        {
          outcome: 'failed',
          workflowJobId: harness.workflowId,
          lifecycleFault: {
            kind: 'recovery_failed',
            message,
          },
          stepDetails: [
            { stepIndex: 0, atomIndex: 0, label: 'architect', output: '' },
            { stepIndex: 0, atomIndex: 1, label: 'critic', output: 'critic output' },
          ],
          failureLocation: {
            slotId: failedSlot.slotId,
            stepIndex: 0,
            atomLabel: 'architect',
            jobId: failedJobId,
          },
        },
      ]);

      const rows = db
        .prepare(
          `SELECT seq, type, stream_kind, stream_id, body
             FROM events
            WHERE stream_id = ?
            ORDER BY seq ASC`,
        )
        .all(harness.workflowId) as Array<{
        seq: number;
        type: string;
        stream_kind: string;
        stream_id: string;
        body: Buffer;
      }>;
      const lifecycleFault = rows.find(
        (row) =>
          row.stream_kind === 'workflow' &&
          row.stream_id === harness.workflowId &&
          row.type === 'workflow.lifecycle_fault',
      );
      const completed = rows.find(
        (row) =>
          row.stream_kind === 'workflow' && row.stream_id === harness.workflowId && row.type === 'workflow.completed',
      );
      const terminal = rows.find(
        (row) =>
          row.stream_kind === 'job' && row.stream_id === harness.workflowId && row.type === 'job.terminal.recorded',
      );
      expect(lifecycleFault).toBeDefined();
      expect(completed).toBeDefined();
      expect(terminal).toBeDefined();
      if (!lifecycleFault || !completed || !terminal) {
        throw new Error(`Expected recovered workflow finalization rows for ${harness.workflowId}`);
      }

      expect(decodeEventBody(lifecycleFault.body)).toEqual({
        kind: 'recovery_failed',
        message,
      });
      expect(decodeEventBody(completed.body)).toEqual({
        outcome: 'failed',
        causeRef: { stream: { kind: 'workflow', id: harness.workflowId }, seq: lifecycleFault.seq },
        stepDetails: [
          { stepIndex: 0, atomIndex: 0, label: 'architect', output: '' },
          { stepIndex: 0, atomIndex: 1, label: 'critic', output: 'critic output' },
        ],
        failureLocation: {
          slotId: failedSlot.slotId,
          stepIndex: 0,
          atomLabel: 'architect',
          jobId: failedJobId,
        },
      });
      expect(decodeEventBody(terminal.body)).toMatchObject({
        terminal: {
          content: '',
          durationMs: 0,
          outcome: {
            kind: 'failed',
            causeRef: { stream: { kind: 'workflow', id: harness.workflowId }, seq: completed.seq },
          },
        },
      });
      expect(completed.seq).toBe(lifecycleFault.seq + 1);
      expect(terminal.seq).toBe(completed.seq + 1);
    } finally {
      db.close();
    }
  });
});
