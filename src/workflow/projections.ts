import type BetterSqlite3 from 'better-sqlite3';

import { appendEvents, type AppendEventsFn } from '../store/append.js';
import { createEmptyRegistry, type CoralEventInput } from '../store/envelope.js';
import { composeReducers } from '../store/reducers.js';
import { workflowRegistry } from './events.js';
import { workflowPlanSchema, type WorkflowPlan } from './plan.js';

const workflowReducers = composeReducers(workflowRegistry);
const upcasters = createEmptyRegistry();

export type WorkflowProjectionRow = {
  workflowId: string;
  plan: WorkflowPlan;
  lastSeq: number;
};

export type ProjectedJobState = {
  phase: string;
  lastSeq: number;
};

export type WorkflowJournal = {
  append(inputs: readonly CoralEventInput[]): void;
};

export function appendWorkflowEvents(db: BetterSqlite3.Database, inputs: readonly CoralEventInput[]): void {
  appendEvents(db, inputs, {
    now: () => new Date(),
    reducers: workflowReducers,
    upcasters,
  });
}

export function createWorkflowJournal(options: { appendEvents: AppendEventsFn }): WorkflowJournal {
  return {
    append(inputs) {
      options.appendEvents(inputs);
    },
  };
}

export function readWorkflowProjection(db: BetterSqlite3.Database, workflowId: string): WorkflowProjectionRow | null {
  const row = db
    .prepare(
      `SELECT workflow_id, plan, last_seq
         FROM projection_workflows
        WHERE workflow_id = ?`,
    )
    .get(workflowId) as { workflow_id: string; plan: string; last_seq: number } | undefined;

  if (!row) {
    return null;
  }

  return {
    workflowId: row.workflow_id,
    plan: workflowPlanSchema.parse(JSON.parse(row.plan)),
    lastSeq: row.last_seq,
  };
}

export function listWorkflowProjections(db: BetterSqlite3.Database): WorkflowProjectionRow[] {
  const rows = db
    .prepare(`SELECT workflow_id, plan, last_seq FROM projection_workflows ORDER BY workflow_id`)
    .all() as Array<{ workflow_id: string; plan: string; last_seq: number }>;

  return rows.map((row) => ({
    workflowId: row.workflow_id,
    plan: workflowPlanSchema.parse(JSON.parse(row.plan)),
    lastSeq: row.last_seq,
  }));
}

export function readProjectionJob(db: BetterSqlite3.Database, jobId: string): ProjectedJobState | null {
  const row = db
    .prepare(
      `SELECT phase, last_seq
         FROM projection_jobs
        WHERE job_id = ?`,
    )
    .get(jobId) as { phase: string; last_seq: number } | undefined;

  if (!row) {
    return null;
  }

  return {
    phase: row.phase,
    lastSeq: row.last_seq,
  };
}
