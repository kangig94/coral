import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { TEST_PROVIDER_CREDENTIALS } from '#tests/helpers/provider-credentials.js';
import { describe, expect, it } from 'vitest';

import { KbJobRecorder } from '#src/jobs/kb/recorder.js';
import { WorkflowExecutionService } from '#src/coordinator/services/workflow-execution.js';
import { createWorkflowRecoveryFinalizer } from '#src/coordinator/services/workflow-recovery-finalizer.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { JobStore } from '#src/jobs/store.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { appendJobTerminalRecorded } from '#src/jobs/terminal/recording.js';
import type { WaitStreamEvent, WaitStreamRequest } from '#src/jobs/wait.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import { decodeEventBody, encodeEventBody } from '#src/store/body-codec.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { composeReducers } from '#src/store/reducers.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { workflowRegistry, workflowPlanDeclaredEvent } from '#src/workflow/events.js';
import type { WorkflowFinalizationIntent } from '#src/workflow/finalization.js';
import { parseExpression } from '#src/workflow/parser.js';
import { buildWorkflowPlan, type PlanSlot, type WorkflowPlan } from '#src/workflow/plan.js';
import { loadJobProjectionDetails } from '#src/jobs/read-queries.js';
import { resumeAll } from '#src/workflow/recover.js';
import type { WorkflowExecutionPort } from '#src/workflow/execution-contract.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';

const REPO_ROOT = process.cwd();
const NOW = '2026-04-19T00:00:00.000Z';
const TEST_NAMESPACE = 'test-ns';
const PROJECT_ROOT = '/workspace/coral';
const KB_RECORDER_PATH = 'src/jobs/kb/recorder.ts';
const KB_SHELL_PATH = 'src/kb-daemon/services/shell.ts';
const KB_SOURCE_IMPORT_SERVICE_PATH = 'src/kb-daemon/services/source-import.ts';
const KB_REINDEX_SERVICE_PATH = 'src/kb-daemon/services/reindex.ts';
const WORKFLOW_EXECUTOR_PATH = 'src/workflow/executor.ts';
const WORKFLOW_RECOVER_PATH = 'src/workflow/recover.ts';
const WORKFLOW_EXECUTION_SERVICE_PATH = 'src/coordinator/services/workflow-execution.ts';
const WORKFLOW_FINALIZATION_HELPER_PATH = 'src/coordinator/services/workflow-finalization.ts';
const WORKFLOW_RECOVERY_FINALIZER_PATH = 'src/coordinator/services/workflow-recovery-finalizer.ts';
type Db = Database;

type OrphanKbFailureRow = {
  cause_seq: number;
  stream_kind: string;
  stream_id: string;
};

type FailedWorkflowCompletionWithoutCauseRefRow = {
  seq: number;
  workflow_id: string;
};

type FailedWorkflowParentTerminalWithoutWorkflowCompletionCauseRow = {
  terminal_seq: number;
  job_id: string;
};

type FailedJobTerminalWithoutCauseRefRow = {
  seq: number;
  job_id: string;
};

const ORPHAN_KB_OPERATION_FAILURES_SQL = `
  SELECT p.seq AS cause_seq, p.stream_kind, p.stream_id
    FROM events p
   WHERE p.type = 'job.progress.emitted'
     AND json_extract(CAST(p.body AS TEXT), '$.kind') = 'domain'
     AND json_extract(CAST(p.body AS TEXT), '$.stage') = 'kb_operation_failed'
     AND NOT EXISTS (
           SELECT 1
             FROM events t
            WHERE t.stream_kind = p.stream_kind
              AND t.stream_id = p.stream_id
              AND t.type = 'job.terminal.recorded'
              AND json_extract(CAST(t.body AS TEXT), '$.terminal.outcome.kind') = 'failed'
         )
   ORDER BY p.seq ASC
`;

const FAILED_WORKFLOW_COMPLETIONS_WITHOUT_CAUSE_REF_SQL = `
  SELECT seq, stream_id AS workflow_id
    FROM events
   WHERE type = 'workflow.completed'
     AND stream_kind = 'workflow'
     AND json_extract(CAST(body AS TEXT), '$.outcome') = 'failed'
     AND json_type(CAST(body AS TEXT), '$.causeRef') IS NULL
   ORDER BY seq ASC
`;

const FAILED_WORKFLOW_PARENT_TERMINALS_WITHOUT_WORKFLOW_COMPLETION_CAUSE_SQL = `
  SELECT t.seq AS terminal_seq, t.stream_id AS job_id
    FROM events t
   WHERE t.type = 'job.terminal.recorded'
     AND json_extract(CAST(t.body AS TEXT), '$.terminal.outcome.kind') = 'failed'
     AND EXISTS (
           SELECT 1
             FROM events launch
            WHERE launch.stream_kind = 'job'
              AND launch.stream_id = t.stream_id
              AND launch.type = 'job.launch.requested'
              AND json_extract(CAST(launch.body AS TEXT), '$.jobKind') = 'workflow'
         )
     AND NOT EXISTS (
           SELECT 1
             FROM events completed
            WHERE completed.stream_kind = 'workflow'
              AND completed.stream_id = t.stream_id
              AND completed.type = 'workflow.completed'
              AND completed.seq = CAST(json_extract(CAST(t.body AS TEXT), '$.terminal.outcome.causeRef.seq') AS INTEGER)
         )
   ORDER BY t.seq ASC
`;

const FAILED_JOB_TERMINALS_WITHOUT_CAUSE_REF_SQL = `
  SELECT seq, stream_id AS job_id
    FROM events
   WHERE type = 'job.terminal.recorded'
     AND stream_kind = 'job'
     AND json_extract(CAST(body AS TEXT), '$.terminal.outcome.kind') = 'failed'
     AND (
           json_type(CAST(body AS TEXT), '$.terminal.outcome.causeRef') IS NULL
           OR json_type(CAST(body AS TEXT), '$.terminal.outcome.causeRef') = 'null'
         )
   ORDER BY seq ASC
`;

function createDb(): Db {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db);
  return db;
}

function scanTerminalCausingKbOperationFailureOrphans(db: Db): OrphanKbFailureRow[] {
  return db.prepare(ORPHAN_KB_OPERATION_FAILURES_SQL).all() as OrphanKbFailureRow[];
}

function scanFailedWorkflowCompletionsWithoutCauseRef(db: Db): FailedWorkflowCompletionWithoutCauseRefRow[] {
  return db
    .prepare(FAILED_WORKFLOW_COMPLETIONS_WITHOUT_CAUSE_REF_SQL)
    .all() as FailedWorkflowCompletionWithoutCauseRefRow[];
}

function scanFailedWorkflowParentTerminalsWithoutWorkflowCompletionCause(
  db: Db,
): FailedWorkflowParentTerminalWithoutWorkflowCompletionCauseRow[] {
  return db
    .prepare(FAILED_WORKFLOW_PARENT_TERMINALS_WITHOUT_WORKFLOW_COMPLETION_CAUSE_SQL)
    .all() as FailedWorkflowParentTerminalWithoutWorkflowCompletionCauseRow[];
}

function scanFailedJobTerminalsWithoutCauseRef(db: Db): FailedJobTerminalWithoutCauseRefRow[] {
  return db.prepare(FAILED_JOB_TERMINALS_WITHOUT_CAUSE_REF_SQL).all() as FailedJobTerminalWithoutCauseRefRow[];
}

function assertNoTerminalCausingKbOperationFailureOrphans(db: Db): void {
  const orphans = scanTerminalCausingKbOperationFailureOrphans(db);
  if (orphans.length > 0) {
    throw new Error(`orphan terminal-causing kb_operation_failed rows: ${JSON.stringify(orphans)}`);
  }
}

function assertNoWorkflowAtomicityOrphans(db: Db): void {
  const missingWorkflowCauses = scanFailedWorkflowCompletionsWithoutCauseRef(db);
  if (missingWorkflowCauses.length > 0) {
    throw new Error(`failed workflow.completed rows without direct causeRef: ${JSON.stringify(missingWorkflowCauses)}`);
  }

  const missingParentLinks = scanFailedWorkflowParentTerminalsWithoutWorkflowCompletionCause(db);
  if (missingParentLinks.length > 0) {
    throw new Error(
      `failed workflow parent terminals without workflow.completed causeRef: ${JSON.stringify(missingParentLinks)}`,
    );
  }

  const missingTerminalCauses = scanFailedJobTerminalsWithoutCauseRef(db);
  if (missingTerminalCauses.length > 0) {
    throw new Error(`failed job.terminal.recorded rows without causeRef: ${JSON.stringify(missingTerminalCauses)}`);
  }
}

function insertOrphanKbOperationFailure(db: Db): void {
  db.prepare(
    `INSERT INTO events (ts, type, stream_kind, stream_id, namespace, project, refs, body_version, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    NOW,
    'job.progress.emitted',
    'job',
    'job-orphan',
    'test-ns',
    '/workspace/orphan',
    JSON.stringify({ jobId: 'job-orphan' }),
    1,
    encodeEventBody({
      kind: 'domain',
      stage: 'kb_operation_failed',
      message: 'KB reindex failed: index unavailable',
      detail: { operation: 'reindex', cause: { message: 'index unavailable' } },
      ts: NOW,
    }),
  );
}

function insertFailedWorkflowCompletedWithoutCauseRef(db: Db): void {
  db.prepare(
    `INSERT INTO events (ts, type, stream_kind, stream_id, namespace, project, refs, body_version, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    NOW,
    'workflow.completed',
    'workflow',
    'workflow-orphan',
    'test-ns',
    '/workspace/orphan',
    JSON.stringify({ workflowId: 'workflow-orphan' }),
    1,
    encodeEventBody({
      outcome: 'failed',
      stepDetails: [],
    }),
  );
}

function insertFailedWorkflowParentTerminalWithoutWorkflowCompletionCause(db: Db): void {
  const insert = db.prepare(
    `INSERT INTO events (seq, ts, type, stream_kind, stream_id, namespace, project, refs, body_version, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    1,
    NOW,
    'job.launch.requested',
    'job',
    'workflow-parent-orphan',
    'test-ns',
    '/workspace/orphan',
    JSON.stringify({ jobId: 'workflow-parent-orphan', sessionId: 'session-orphan' }),
    1,
    encodeEventBody({
      sessionId: 'session-orphan',
      provider: 'codex',
      projectRoot: '/workspace/orphan',
      backendNamespace: 'test-ns',
      jobKind: 'workflow',
      providerCredentials: TEST_PROVIDER_CREDENTIALS,
      pool: 'default',
      enqueueSequence: 1,
      providerAction: 'exec',
      request: {
        prompt: '',
        cwd: '/workspace/orphan',
        bypassPermissions: false,
        coralEnv: {},
      },
      createdAt: NOW,
    }),
  );
  insert.run(
    2,
    NOW,
    'job.terminal.recorded',
    'job',
    'workflow-parent-orphan',
    'test-ns',
    '/workspace/orphan',
    JSON.stringify({ jobId: 'workflow-parent-orphan', sessionId: 'session-orphan' }),
    1,
    encodeEventBody({
      terminal: {
        content: '',
        durationMs: 0,
        outcome: {
          kind: 'failed',
          causeRef: { stream: { kind: 'job', id: 'not-workflow-completed' }, seq: 99 },
        },
      },
      continuity: null,
    }),
  );
}

function insertFailedJobTerminalWithoutCauseRef(db: Db): void {
  db.prepare(
    `INSERT INTO events (ts, type, stream_kind, stream_id, namespace, project, refs, body_version, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    NOW,
    'job.terminal.recorded',
    'job',
    'job-terminal-without-cause',
    TEST_NAMESPACE,
    PROJECT_ROOT,
    JSON.stringify({ jobId: 'job-terminal-without-cause' }),
    1,
    encodeEventBody({
      terminal: {
        content: '',
        durationMs: 0,
        outcome: {
          kind: 'failed',
        },
      },
      continuity: null,
    }),
  );
}

function createWorkflowProgressStore(db: Db, runtime: SimulationRuntime): JobStore {
  return new JobStore(TEST_NAMESPACE, runtime, createEventBodyCodec(), {
    db,
    reducers: composeReducers(jobsRegistry, workflowRegistry),
    providers: permissiveProviderLookupPort,
  });
}

function initWorkflowJob(progressStore: JobStore, jobId: string): void {
  initTestJob(progressStore, {
    jobId,
    sessionId: `${jobId}-session`,
    provider: 'codex',
    projectRoot: PROJECT_ROOT,
    backendNamespace: TEST_NAMESPACE,
    jobKind: 'workflow',
    providerCredentials: TEST_PROVIDER_CREDENTIALS,
    initialPhase: 'running',
  });
}

type WorkflowRecoveryHarness = {
  db: Db;
  runtime: SimulationRuntime;
  progressStore: JobStore;
  workflowId: string;
  plan: WorkflowPlan;
  executionSvc: WorkflowExecutionPort & {
    dispatches: Array<{ providerName: string; coralName: string; jobId: string; workflowSlotId?: string }>;
    waitRequests: WaitStreamRequest[];
  };
};

type WaitTerminalEvent = Extract<WaitStreamEvent, { type: 'terminal' }>;
type WaitTerminalOutcome = WaitTerminalEvent['result']['outcome'];

async function* emitWaitEvents(events: WaitStreamEvent[]): AsyncGenerator<WaitStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

function createWorkflowExecutionPort(
  options: {
    terminalContentByJob?: ReadonlyMap<string, string>;
    terminalOutcomeByJob?: ReadonlyMap<string, WaitTerminalOutcome>;
  } = {},
): WorkflowRecoveryHarness['executionSvc'] {
  const dispatches: WorkflowRecoveryHarness['executionSvc']['dispatches'] = [];
  const waitRequests: WaitStreamRequest[] = [];

  return {
    dispatches,
    waitRequests,
    coralDispatch: async (providerName, coralName, input) => {
      const jobId = String(input.jobId ?? `${coralName}-job`);
      dispatches.push({ providerName, coralName, jobId, workflowSlotId: input.workflowSlotId });
      return {
        status: 'running',
        job: jobId,
        session: `${jobId}-session`,
      };
    },
    resume: async (_providerName, input) => ({
      status: 'running',
      job: input.jobId ?? 'resumed-job',
      session: input.sessionId,
    }),
    recordContinuationLease: async () => {},
    claimContinuationLease: async () => true,
    clearContinuationLease: async () => true,
    abort: (jobIds) => ({ aborted: [...jobIds], notFound: [] }),
    awaitLaunch: async () => 'ready',
    waitStream: (req) => {
      waitRequests.push({
        ...req,
        jobIds: [...req.jobIds],
        ...(req.cursor === undefined ? {} : { cursor: { afterSeq: req.cursor.afterSeq } }),
      });
      const baseSeq = Math.max(req.cursor?.afterSeq ?? 0, 100);
      return emitWaitEvents(
        req.jobIds.map((jobId, index): WaitStreamEvent => {
          const outcome = options.terminalOutcomeByJob?.get(jobId) ?? { kind: 'completed' };
          return {
            type: 'terminal',
            jobId,
            seq: baseSeq + index + 1,
            remainingJobIds: req.jobIds.slice(index + 1),
            resultPath: `/tmp/coral-exports/jobs/${jobId}/result.md`,
            result: {
              content: options.terminalContentByJob?.get(jobId) ?? `result:${jobId}`,
              outcome,
            },
          };
        }),
      );
    },
    waitForJobTerminal: async () => {},
  };
}

function createWorkflowRecoveryHarness(db: Db, workflowId: string, expression = 'architect'): WorkflowRecoveryHarness {
  const runtime = new SimulationRuntime();
  const progressStore = createWorkflowProgressStore(db, runtime);
  const plan = buildWorkflowPlan(workflowId, parseExpression(expression), {
    defaultProvider: 'codex',
  });
  initWorkflowJob(progressStore, workflowId);
  progressStore.commit((c) => {
    c.append(workflowPlanDeclaredEvent(workflowId, plan));
    return undefined;
  });

  return {
    db,
    runtime,
    progressStore,
    workflowId,
    plan,
    executionSvc: createWorkflowExecutionPort(),
  };
}

function slotSessionId(slot: PlanSlot): string {
  return `${slot.slotId}-session`;
}

function initWorkflowSlotJob(harness: WorkflowRecoveryHarness, slot: PlanSlot): void {
  seedTestSessionProjection(harness.db, {
    sessionId: slotSessionId(slot),
    provider: slot.provider,
    projectRoot: PROJECT_ROOT,
    backendNamespace: TEST_NAMESPACE,
  });
  harness.progressStore.appendLaunchRequested(slot.slotId, {
    jobId: slot.slotId,
    sessionId: slotSessionId(slot),
    provider: slot.provider,
    projectRoot: PROJECT_ROOT,
    backendNamespace: TEST_NAMESPACE,
    jobKind: 'provider',
    pool: 'default',
    enqueueSequence: harness.progressStore.nextEnqueueSequence(),
    providerAction: 'exec',
    parentWorkflowJobId: harness.workflowId,
    workflowSlotId: slot.slotId,
    request: {
      prompt: '',
      cwd: PROJECT_ROOT,
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: NOW,
  });
  harness.progressStore.appendRuntimeStarted(slot.slotId, {
    transport: 'durable-cli',
    pid: 1,
    stdoutPath: `/tmp/${slot.slotId}.stdout`,
    stderrPath: `/tmp/${slot.slotId}.stderr`,
    startTime: NOW,
  });
}

function appendWorkflowSlotTerminal(
  harness: WorkflowRecoveryHarness,
  slot: PlanSlot,
  terminal: { content: string; outcome: WaitTerminalOutcome; durationMs?: number },
): void {
  harness.progressStore.commit((c) => {
    appendJobTerminalRecorded(c, {
      jobId: slot.slotId,
      sessionId: slotSessionId(slot),
      namespace: TEST_NAMESPACE,
      project: PROJECT_ROOT,
      parentJobId: harness.workflowId,
      workflowSlotId: slot.slotId,
      terminal,
      continuity: null,
    });
    return undefined;
  });
}

function createRecoveryInvocationContext(projectRoot: string): InvocationContext {
  return {
    projectRoot,
    pluginRoot: '/workspace/coral-plugin',
    coralEnv: {},
    principal: testProjectPrincipal(projectRoot),
  };
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

async function resumeRecoveryHarness(
  harness: WorkflowRecoveryHarness,
  finalizeWorkflow: (intent: WorkflowFinalizationIntent) => void,
  executionSvc: WorkflowExecutionPort = harness.executionSvc,
): Promise<string[]> {
  return resumeAll({
    db: harness.db,
    progressStore: harness.progressStore,
    loadJobDetails: loadJobProjectionDetails,
    getExecutionService: () => executionSvc,
    createInvocationContext: createRecoveryInvocationContext,
    finalizeWorkflow,
    time: harness.runtime.time,
  });
}

function exerciseLaunchedWorkflowFailurePath(db: Db): void {
  const runtime = new SimulationRuntime();
  const progressStore = createWorkflowProgressStore(db, runtime);
  const jobId = 'workflow-executor-path';
  initWorkflowJob(progressStore, jobId);

  const service = new WorkflowExecutionService({
    runtime,
    progressStore,
    backendNamespace: 'test-ns',
    bundleHash: 'bundle-a',
    providerRegistry: { get: () => null, getAll: () => [] } as never,
    coordinatorCommit: (cb) => progressStore.commit(cb),
    sessionManager: {
      setNonResumable() {},
      releaseJob() {},
    } as never,
    abortRegistry: {
      remove() {},
    } as never,
    launchOrchestrator: {
      markJobRunning() {},
    } as never,
    executionPort: {} as never,
  });

  (
    service as unknown as {
      handleWorkflowError(error: unknown, sessionId: string, jobId: string): void;
    }
  ).handleWorkflowError(new Error('wrapper exploded'), `${jobId}-session`, jobId);
}

function readSource(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
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
        projectRoot: '/workspace/coral',
        operation: 'kb.reindex',
        request: {},
      });
      recorder.appendOperationFailureWithTerminal({
        jobId,
        projectRoot: '/workspace/coral',
        operation: 'reindex',
        message: 'KB reindex failed: index unavailable',
        detail: { operation: 'reindex', cause: { message: 'index unavailable' } },
        startedAtMs,
      });

      expect(scanTerminalCausingKbOperationFailureOrphans(db)).toEqual([]);
      assertNoTerminalCausingKbOperationFailureOrphans(db);

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

  it('fails the persisted-state scan for a manually inserted orphan KB operation failure', () => {
    const db = createDb();
    try {
      insertOrphanKbOperationFailure(db);

      expect(scanTerminalCausingKbOperationFailureOrphans(db)).toEqual([
        { cause_seq: 1, stream_kind: 'job', stream_id: 'job-orphan' },
      ]);
      expect(() => assertNoTerminalCausingKbOperationFailureOrphans(db)).toThrow(
        /orphan terminal-causing kb_operation_failed rows/u,
      );
    } finally {
      db.close();
    }
  });

  it('fails the workflow persisted-state scan for a manually inserted failed job terminal without causeRef', () => {
    const db = createDb();
    try {
      insertFailedJobTerminalWithoutCauseRef(db);

      expect(scanFailedJobTerminalsWithoutCauseRef(db)).toEqual([{ seq: 1, job_id: 'job-terminal-without-cause' }]);
      expect(() => assertNoWorkflowAtomicityOrphans(db)).toThrow(
        /failed job\.terminal\.recorded rows without causeRef/u,
      );
    } finally {
      db.close();
    }
  });

  it('drives resumeAll through final-step completion recovery and emits the completion intent', async () => {
    const db = createDb();
    try {
      const harness = createWorkflowRecoveryHarness(db, 'workflow-recover-final-step');
      const [slot] = harness.plan.slots;
      if (slot === undefined) throw new Error('Expected a workflow slot.');
      initWorkflowSlotJob(harness, slot);
      appendWorkflowSlotTerminal(harness, slot, {
        content: 'ARCH_DONE',
        outcome: { kind: 'completed' },
      });
      const captured = captureWorkflowIntents();

      await expect(resumeRecoveryHarness(harness, captured.finalizeWorkflow)).resolves.toEqual([harness.workflowId]);

      expect(harness.executionSvc.dispatches).toEqual([]);
      expect(captured.intents).toEqual([
        {
          outcome: 'completed',
          workflowJobId: harness.workflowId,
          finalOutput: 'ARCH_DONE',
          stepDetails: [
            {
              stepIndex: 0,
              atomIndex: 0,
              label: 'architect',
              output: 'ARCH_DONE',
            },
          ],
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('drives resumeAll through missing-projection relaunch recovery and emits the completion intent', async () => {
    const db = createDb();
    try {
      const harness = createWorkflowRecoveryHarness(db, 'workflow-recover-relaunch');
      const [slot] = harness.plan.slots;
      if (slot === undefined) throw new Error('Expected a workflow slot.');
      const executionSvc = createWorkflowExecutionPort({
        terminalContentByJob: new Map([[slot.slotId, 'ARCH_RELAUNCHED']]),
      });
      const captured = captureWorkflowIntents();

      await expect(resumeRecoveryHarness(harness, captured.finalizeWorkflow, executionSvc)).resolves.toEqual([
        harness.workflowId,
      ]);

      expect(executionSvc.dispatches).toEqual([
        {
          providerName: 'codex',
          coralName: 'architect',
          jobId: slot.slotId,
          workflowSlotId: slot.slotId,
        },
      ]);
      expect(executionSvc.waitRequests.map((request) => request.jobIds)).toEqual([[slot.slotId]]);
      expect(captured.intents).toEqual([
        {
          outcome: 'completed',
          workflowJobId: harness.workflowId,
          finalOutput: 'ARCH_RELAUNCHED',
          stepDetails: [
            {
              stepIndex: 0,
              atomIndex: 0,
              label: 'architect',
              output: 'ARCH_RELAUNCHED',
            },
          ],
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('drives resumeAll through active-step wait recovery and emits the completion intent', async () => {
    const db = createDb();
    try {
      const harness = createWorkflowRecoveryHarness(db, 'workflow-recover-active');
      const [slot] = harness.plan.slots;
      if (slot === undefined) throw new Error('Expected a workflow slot.');
      initWorkflowSlotJob(harness, slot);
      const executionSvc = createWorkflowExecutionPort({
        terminalContentByJob: new Map([[slot.slotId, 'ARCH_FROM_WAIT']]),
      });
      const captured = captureWorkflowIntents();

      await expect(resumeRecoveryHarness(harness, captured.finalizeWorkflow, executionSvc)).resolves.toEqual([
        harness.workflowId,
      ]);

      expect(executionSvc.dispatches).toEqual([]);
      expect(executionSvc.waitRequests.map((request) => request.jobIds)).toEqual([[slot.slotId]]);
      expect(captured.intents).toEqual([
        {
          outcome: 'completed',
          workflowJobId: harness.workflowId,
          finalOutput: 'ARCH_FROM_WAIT',
          stepDetails: [
            {
              stepIndex: 0,
              atomIndex: 0,
              label: 'architect',
              output: 'ARCH_FROM_WAIT',
            },
          ],
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('drives resumeAll through failure recovery with the real finalizer and persists causal rows', async () => {
    const db = createDb();
    try {
      exerciseLaunchedWorkflowFailurePath(db);
      const harness = createWorkflowRecoveryHarness(db, 'workflow-recover-path', '(architect, critic)');
      const [failedSlot, pendingSlot] = harness.plan.slots;
      if (failedSlot === undefined || pendingSlot === undefined) throw new Error('Expected two workflow slots.');
      initWorkflowSlotJob(harness, failedSlot);
      appendWorkflowSlotTerminal(harness, failedSlot, {
        content: '',
        outcome: { kind: 'provider_exit', code: 1 },
      });
      initWorkflowSlotJob(harness, pendingSlot);
      const realFinalizer = createWorkflowRecoveryFinalizer({
        runtime: harness.runtime,
        progressStore: harness.progressStore,
        coordinatorCommit: (cb) => harness.progressStore.commit(cb),
        log: () => {},
      });
      const captured = captureWorkflowIntents(realFinalizer);
      const message = "Step 0, atom 'architect' failed: exited with code 1";

      await expect(resumeRecoveryHarness(harness, captured.finalizeWorkflow)).rejects.toThrow(message);

      expect(captured.intents).toEqual([
        {
          outcome: 'failed',
          workflowJobId: harness.workflowId,
          lifecycleFault: {
            kind: 'recovery_failed',
            message,
          },
          stepDetails: [],
          failureLocation: {
            slotId: failedSlot.slotId,
            stepIndex: 0,
            atomLabel: 'architect',
            jobId: failedSlot.slotId,
          },
        },
      ]);
      expect(scanFailedWorkflowCompletionsWithoutCauseRef(db)).toEqual([]);
      expect(scanFailedWorkflowParentTerminalsWithoutWorkflowCompletionCause(db)).toEqual([]);
      expect(scanFailedJobTerminalsWithoutCauseRef(db)).toEqual([]);
      assertNoWorkflowAtomicityOrphans(db);

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
        stepDetails: [],
        failureLocation: {
          slotId: failedSlot.slotId,
          stepIndex: 0,
          atomLabel: 'architect',
          jobId: failedSlot.slotId,
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
        continuity: null,
      });
      expect(completed.seq).toBe(lifecycleFault.seq + 1);
      expect(terminal.seq).toBe(completed.seq + 1);
    } finally {
      db.close();
    }
  });

  it('fails the workflow persisted-state scan for manually inserted orphan workflow rows', () => {
    const missingCompletionCauseDb = createDb();
    try {
      insertFailedWorkflowCompletedWithoutCauseRef(missingCompletionCauseDb);
      expect(scanFailedWorkflowCompletionsWithoutCauseRef(missingCompletionCauseDb)).toEqual([
        { seq: 1, workflow_id: 'workflow-orphan' },
      ]);
      expect(() => assertNoWorkflowAtomicityOrphans(missingCompletionCauseDb)).toThrow(
        /failed workflow\.completed rows without direct causeRef/u,
      );
    } finally {
      missingCompletionCauseDb.close();
    }

    const missingParentLinkDb = createDb();
    try {
      insertFailedWorkflowParentTerminalWithoutWorkflowCompletionCause(missingParentLinkDb);
      expect(scanFailedWorkflowParentTerminalsWithoutWorkflowCompletionCause(missingParentLinkDb)).toEqual([
        { terminal_seq: 2, job_id: 'workflow-parent-orphan' },
      ]);
      expect(() => assertNoWorkflowAtomicityOrphans(missingParentLinkDb)).toThrow(
        /failed workflow parent terminals without workflow\.completed causeRef/u,
      );
    } finally {
      missingParentLinkDb.close();
    }
  });

  it('keeps the KB producer structurally collapsed to one commit closure with no caller-side seq handoff', () => {
    const recorderSource = readSource(KB_RECORDER_PATH);
    const shellSource = readSource(KB_SHELL_PATH);
    const sourceImportSource = readSource(KB_SOURCE_IMPORT_SERVICE_PATH);
    const reindexSource = readSource(KB_REINDEX_SERVICE_PATH);
    const migratedCallers = `${sourceImportSource}\n${reindexSource}`;
    const failureMethodStart = recorderSource.indexOf('appendOperationFailureWithTerminal');
    const nextMethodStart = recorderSource.indexOf('appendHostedKbOperationFailure', failureMethodStart);
    const failureMethodSource = recorderSource.slice(failureMethodStart, nextMethodStart);

    expect(recorderSource).toContain('appendOperationFailureWithTerminal');
    expect(failureMethodSource.match(/this\.deps\.progressStore\.commit\(\(c\) =>/gu) ?? []).toHaveLength(1);
    expect(failureMethodSource).toMatch(
      /const cause = c\.append\(causeEvent\);[\s\S]*appendJobTerminalRecorded\(c,[\s\S]*failedTerminalOutcome\(cause\)/u,
    );
    expect(recorderSource).not.toContain('appendKbOperationFailureCause');
    expect(recorderSource).not.toContain('appendFailed');
    expect(recorderSource).not.toContain('append' + 'EventsWithResult');

    expect(shellSource).toContain('appendOperationFailureWithTerminal');
    expect(migratedCallers).not.toContain('appendOperationFailureWithTerminal');
    expect(migratedCallers).not.toContain('appendKbOperationFailureCause');
    expect(migratedCallers).not.toContain('appendFailed');
    expect(migratedCallers).not.toMatch(/\bcauseRef\b|\bseq\b/u);
  });

  it('keeps workflow completion producers structurally collapsed to coordinator commit closures', () => {
    const executorSource = readSource(WORKFLOW_EXECUTOR_PATH);
    const recoverSource = readSource(WORKFLOW_RECOVER_PATH);
    const serviceSource = readSource(WORKFLOW_EXECUTION_SERVICE_PATH);
    const helperSource = readSource(WORKFLOW_FINALIZATION_HELPER_PATH);
    const recoveryFinalizerSource = readSource(WORKFLOW_RECOVERY_FINALIZER_PATH);

    expect(executorSource).not.toContain('workflowCompletedEvent');
    expect(recoverSource).not.toContain('append' + 'WorkflowEvents');
    expect(recoverSource).not.toContain('workflowCompletedEvent');
    expect(serviceSource).toContain('this.deps.coordinatorCommit((c) =>');
    expect(serviceSource).toContain('composeWorkflowFinalization(c, jobId, intent');
    expect(recoveryFinalizerSource).toContain('options.coordinatorCommit((c) =>');
    expect(recoveryFinalizerSource).toContain('composeWorkflowFinalization(c, intent.workflowJobId, intent');
    expect(helperSource).toMatch(
      /workflowLifecycleFaultEvent\(workflowJobId,[\s\S]*workflowCompletedEvent\(workflowJobId,[\s\S]*appendJobTerminalRecorded\(c,/u,
    );
  });
});
import { initTestJob, seedTestSessionProjection } from '#tests/helpers/session.js';
