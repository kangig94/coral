import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { ProgressStore } from '../../jobs/job-store.js';
import { SimulationRuntime } from '../../simulation/core/index.js';
import type { CallerContext } from '../../shared/request-context.js';
import type { JobTerminal } from '../../jobs/views.js';
import type { WaitStreamEvent, WaitStreamRequest } from '../../jobs/wait.js';
import { applyMigrations } from '../../store/migrations.js';
import { createDefaultUpcasterRegistry } from '../../store/upcasters.js';
import { parseExpression } from '../parser.js';
import { workflowPlanDeclaredEvent } from '../events.js';
import { buildWorkflowPlan, replacePlanSlot, type WorkflowPlan } from '../plan.js';
import { appendWorkflowEvents } from '../projections.js';
import { resumeAll } from '../recover.js';
import type { WorkflowExecutionPort } from '../command.js';

// NOTE: "running" and "queued" branches today share the same code path
// (both hit waitForAtoms). We retain two tests so that if phase-differentiated
// behavior is added later, the test scaffold already exists. The distinct
// third branch ("absent" -> relaunch) is the genuine divergence.

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../store/migrations');
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
    resultPath: `/tmp/coral-jobs/${jobId}/result.md`,
    result,
  };
}

async function* emit(events: WaitStreamEvent[]): AsyncGenerator<WaitStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

function createWorkflowPlan(): WorkflowPlan {
  const basePlan = buildWorkflowPlan('workflow-1', parseExpression('architect'), {
    createJobId: () => 'atom-1',
    defaultProvider: 'codex',
  });
  return replacePlanSlot(basePlan, basePlan.slots[0].slotId, {
    continuityRef: 'session-atom-1',
  });
}

function createHarness(options: {
  atomPhase: 'running' | 'queued' | null;
  projectionPhase: 'running' | 'queued' | null;
  projectionLastSeq?: number;
}) {
  const db = new Database(':memory:');
  applyMigrations({ db, storage: storageAdapter as never, migrationsDir: MIGRATIONS_DIR });

  const runtime = new SimulationRuntime();
  const progressStore = new ProgressStore(BACKEND_NAMESPACE, runtime, createDefaultUpcasterRegistry());
  const plan = createWorkflowPlan();
  appendWorkflowEvents(db, [workflowPlanDeclaredEvent(plan.workflowId, plan)]);

  progressStore.initJob({
    jobId: plan.workflowId,
    sessionId: 'workflow-session-1',
    provider: 'codex',
    projectRoot: PROJECT_ROOT,
    backendNamespace: BACKEND_NAMESPACE,
    jobKind: 'workflow',
    initialPhase: 'running',
  });

  if (options.atomPhase !== null) {
    progressStore.initJob({
      jobId: plan.slots[0].jobId,
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
         job_kind, created_at, last_seq
       )
       VALUES (?, ?, ?, ?, ?, ?, 'provider', '2026-04-20T00:00:00.000Z', ?)`,
    ).run(
      plan.slots[0].jobId,
      options.projectionPhase,
      'session-atom-1',
      'codex',
      PROJECT_ROOT,
      BACKEND_NAMESPACE,
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
        ...(req.cursor ? { cursor: { jobs: { ...req.cursor.jobs } } } : {}),
      });
      return emit(req.jobIds.map((jobId) => terminal(jobId, `result:${jobId}`)));
    }),
    waitForJobTerminal: vi.fn(async () => {}),
    cleanupWorkflowSessions: vi.fn(),
  };

  const createCallerContext = (projectRoot: string): CallerContext => ({
    projectRoot,
    pluginRoot: '/tmp/coral-workflow-plugin',
    coralEnv: {},
  });

  return { db, plan, progressStore, executionSvc, createCallerContext, waitRequests };
}

describe('workflow recovery branch rules (AC4)', () => {
  it('uses waitForAtoms only when projection_jobs.phase is running', async () => {
    const harness = createHarness({ atomPhase: 'running', projectionPhase: 'running', projectionLastSeq: 17 });
    try {
      const resumed = await resumeAll({
        db: harness.db,
        progressStore: harness.progressStore,
        getExecutionService: () => harness.executionSvc,
        createCallerContext: harness.createCallerContext,
      });

      expect(resumed).toEqual(['workflow-1']);
      expect(harness.executionSvc.coralDispatch).not.toHaveBeenCalled();
      expect(harness.executionSvc.awaitLaunch).not.toHaveBeenCalled();
      expect(harness.executionSvc.waitStream).toHaveBeenCalledTimes(1);
      expect(harness.waitRequests[0]).toEqual({
        jobIds: ['atom-1'],
        timeoutSeconds: 1,
        cursor: { jobs: { 'atom-1': 17 } },
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
        createCallerContext: harness.createCallerContext,
      });

      expect(resumed).toEqual(['workflow-1']);
      expect(harness.executionSvc.coralDispatch).not.toHaveBeenCalled();
      expect(harness.executionSvc.awaitLaunch).not.toHaveBeenCalled();
      expect(harness.executionSvc.waitStream).toHaveBeenCalledTimes(1);
      expect(harness.waitRequests[0]).toEqual({
        jobIds: ['atom-1'],
        timeoutSeconds: 1,
        cursor: { jobs: { 'atom-1': 23 } },
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
        createCallerContext: harness.createCallerContext,
      });

      expect(resumed).toEqual(['workflow-1']);
      expect(harness.executionSvc.coralDispatch).toHaveBeenCalledTimes(1);
      expect(harness.executionSvc.coralDispatch).toHaveBeenCalledWith(
        'codex',
        'architect',
        expect.objectContaining({
          jobId: 'atom-1',
          workflowSlotId: harness.plan.slots[0].slotId,
        }),
        harness.createCallerContext(PROJECT_ROOT),
      );
      expect(harness.executionSvc.awaitLaunch).toHaveBeenCalledWith('atom-1', expect.any(Number));
      expect(harness.executionSvc.waitStream).toHaveBeenCalledTimes(1);
    } finally {
      harness.db.close();
    }
  });
});
