import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { KbJobRecorder } from '#src/coordinator/services/kb-job-recorder.js';
import { WorkflowExecutionService } from '#src/coordinator/services/workflow-execution-service.js';
import { createWorkflowRecoveryFinalizer } from '#src/coordinator/services/workflow-recovery-finalizer.js';
import { JobStore } from '#src/jobs/job-store.js';
import { jobsRegistry } from '#src/jobs/events.js';
import type { StoragePort } from '#src/runtime/ports.js';
import { decodeEventBody, encodeEventBody } from '#src/store/body-codec.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { composeReducers } from '#src/store/reducers.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcasters.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

const REPO_ROOT = process.cwd();
const NOW = '2026-04-19T00:00:00.000Z';
const KB_RECORDER_PATH = 'src/coordinator/services/kb-job-recorder.ts';
const KB_SOURCE_IMPORT_SERVICE_PATH = 'src/coordinator/services/kb-source-import-service.ts';
const KB_REINDEX_SERVICE_PATH = 'src/coordinator/services/kb-reindex-service.ts';
const WORKFLOW_EXECUTOR_PATH = 'src/workflow/executor.ts';
const WORKFLOW_RECOVER_PATH = 'src/workflow/recover.ts';
const WORKFLOW_EXECUTION_SERVICE_PATH = 'src/coordinator/services/workflow-execution-service.ts';
const WORKFLOW_RECOVERY_FINALIZER_PATH = 'src/coordinator/services/workflow-recovery-finalizer.ts';

const nodeStorage: Pick<StoragePort, 'readFileSync' | 'readdirSync'> = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readdirSync: (path, options) => readdirSync(path, options),
};

type Db = InstanceType<typeof Database>;

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

function createDb(): Db {
  const db = new Database(':memory:');
  applyStoreSchemas({ db, storage: nodeStorage });
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

function createWorkflowProgressStore(db: Db, runtime: SimulationRuntime): JobStore {
  return new JobStore('test-ns', runtime, createDefaultUpcasterRegistry(), {
    db,
    reducers: composeReducers(jobsRegistry, workflowRegistry),
  });
}

function initWorkflowJob(progressStore: JobStore, jobId: string): void {
  progressStore.initJob({
    jobId,
    sessionId: `${jobId}-session`,
    provider: 'codex',
    projectRoot: '/workspace/coral',
    backendNamespace: 'test-ns',
    jobKind: 'workflow',
    initialPhase: 'running',
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
    executionPort: {
      cleanupWorkflowSessions() {},
    } as never,
  });

  (
    service as unknown as {
      handleWorkflowError(error: unknown, sessionId: string, jobId: string): void;
    }
  ).handleWorkflowError(new Error('wrapper exploded'), `${jobId}-session`, jobId);
}

function exerciseRecoveredWorkflowFailurePath(db: Db): void {
  const runtime = new SimulationRuntime();
  const progressStore = createWorkflowProgressStore(db, runtime);
  const jobId = 'workflow-recover-path';
  initWorkflowJob(progressStore, jobId);

  const finalizeWorkflow = createWorkflowRecoveryFinalizer({
    runtime,
    progressStore,
    coordinatorCommit: (cb) => progressStore.commit(cb),
  });
  finalizeWorkflow({
    outcome: 'failed',
    workflowJobId: jobId,
    lifecycleFault: {
      kind: 'recovery_failed',
      message: 'recovery exploded',
    },
    stepDetails: [],
  });
}

function readSource(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

describe('journal commit atomicity invariant', () => {
  it('finds no orphan terminal-causing KB operation failure after the migrated recorder path', () => {
    const db = createDb();
    try {
      const runtime = new SimulationRuntime();
      const progressStore = new JobStore('test-ns', runtime, createDefaultUpcasterRegistry(), { db });
      const recorder = new KbJobRecorder({
        runtime,
        progressStore,
        backendNamespace: 'test-ns',
        bundleHash: 'bundle-a',
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
        throw new Error('Expected migrated KB recorder to append progress and terminal rows.');
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

  it('finds no workflow atomicity orphans after launched and recovered workflow finalization paths', () => {
    const db = createDb();
    try {
      exerciseLaunchedWorkflowFailurePath(db);
      exerciseRecoveredWorkflowFailurePath(db);

      expect(scanFailedWorkflowCompletionsWithoutCauseRef(db)).toEqual([]);
      expect(scanFailedWorkflowParentTerminalsWithoutWorkflowCompletionCause(db)).toEqual([]);
      assertNoWorkflowAtomicityOrphans(db);

      const rows = db
        .prepare(
          `SELECT seq, type, stream_kind, stream_id, body
             FROM events
            WHERE stream_id IN ('workflow-executor-path', 'workflow-recover-path')
            ORDER BY seq ASC`,
        )
        .all() as Array<{ seq: number; type: string; stream_kind: string; stream_id: string; body: Buffer }>;

      for (const workflowId of ['workflow-executor-path', 'workflow-recover-path']) {
        const completed = rows.find(
          (row) => row.stream_kind === 'workflow' && row.stream_id === workflowId && row.type === 'workflow.completed',
        );
        const terminal = rows.find(
          (row) => row.stream_kind === 'job' && row.stream_id === workflowId && row.type === 'job.terminal.recorded',
        );
        expect(completed).toBeDefined();
        expect(terminal).toBeDefined();
        if (!completed || !terminal) {
          throw new Error(`Expected workflow completion and parent terminal for ${workflowId}`);
        }

        const completedBody = decodeEventBody(completed.body);
        const terminalBody = decodeEventBody(terminal.body);
        expect(completedBody).toMatchObject({
          outcome: 'failed',
          causeRef: expect.any(Object),
          stepDetails: [],
        });
        expect(terminalBody).toMatchObject({
          terminal: {
            outcome: {
              kind: 'failed',
              causeRef: { stream: { kind: 'workflow', id: workflowId }, seq: completed.seq },
            },
          },
        });
        expect(terminal.seq).toBe(completed.seq + 1);
      }
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

    expect(migratedCallers).toContain('appendOperationFailureWithTerminal');
    expect(migratedCallers).not.toContain('appendKbOperationFailureCause');
    expect(migratedCallers).not.toContain('appendFailed');
    expect(migratedCallers).not.toMatch(/\bcauseRef\b|\bseq\b/u);
  });

  it('keeps workflow completion producers structurally collapsed to coordinator commit closures', () => {
    const executorSource = readSource(WORKFLOW_EXECUTOR_PATH);
    const recoverSource = readSource(WORKFLOW_RECOVER_PATH);
    const serviceSource = readSource(WORKFLOW_EXECUTION_SERVICE_PATH);
    const recoveryFinalizerSource = readSource(WORKFLOW_RECOVERY_FINALIZER_PATH);

    expect(executorSource).not.toContain('workflowCompletedEvent');
    expect(recoverSource).not.toContain('append' + 'WorkflowEvents');
    expect(recoverSource).not.toContain('workflowCompletedEvent');
    expect(serviceSource).toContain('this.deps.coordinatorCommit((c) =>');
    expect(serviceSource).toMatch(
      /workflowLifecycleFaultEvent\(jobId,[\s\S]*workflowCompletedEvent\(jobId,[\s\S]*appendJobTerminalRecorded\(c,/u,
    );
    expect(recoveryFinalizerSource).toContain('options.coordinatorCommit((c) =>');
    expect(recoveryFinalizerSource).toMatch(
      /workflowLifecycleFaultEvent\(intent\.workflowJobId,[\s\S]*workflowCompletedEvent\(intent\.workflowJobId,[\s\S]*appendJobTerminalRecorded\(c,/u,
    );
  });
});
