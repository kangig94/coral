import type { Database } from '../store/db.js';

import type { CauseRef } from '../causality/cause-ref.js';
import type { JobPhase } from '../jobs/phase.js';
import { jobTerminalSchema } from '../jobs/terminal/result.js';
import { workflowCompletedBodySchema } from './events.js';
import { workflowPlanSchema, type WorkflowPlan } from './plan.js';
import { decodeBody, type StoreReadContext } from '../store/body-codec.js';

export type WorkflowProjectionRow = {
  workflowId: string;
  plan: WorkflowPlan;
  lastSeq: number;
};

export type WorkflowOutcome = 'running' | 'completed' | 'failed' | 'aborted';

export type WorkflowSlotOutcome = {
  jobId: string | null;
  phase: JobPhase | null;
  causeRef: CauseRef | null;
  lastSeq: number | null;
};

export type WorkflowView = {
  workflowId: string;
  plan: WorkflowPlan;
  slotOutcomes: Record<string, WorkflowSlotOutcome>;
  outcome: WorkflowOutcome;
  causeRef: CauseRef | null;
  lastSeq: number;
};

export type ProjectedJobState = {
  phase: string;
  lastSeq: number;
};

type WorkflowCompletionRow = {
  seq: number;
  type: string;
  body_version: number;
  body: Uint8Array | Buffer;
};

type WorkflowChildJobRow = {
  job_id: string;
  phase: JobPhase;
  terminal: string | null;
  workflow_slot: string;
  last_seq: number;
};

export function readWorkflowProjection(db: Database, workflowId: string): WorkflowProjectionRow | null {
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

export function listWorkflowProjections(db: Database): WorkflowProjectionRow[] {
  const rows = db
    .prepare(`SELECT workflow_id, plan, last_seq FROM projection_workflows ORDER BY workflow_id`)
    .all() as Array<{ workflow_id: string; plan: string; last_seq: number }>;

  return rows.map((row) => ({
    workflowId: row.workflow_id,
    plan: workflowPlanSchema.parse(JSON.parse(row.plan)),
    lastSeq: row.last_seq,
  }));
}

export function readWorkflowView(db: Database, workflowId: string, ctx: StoreReadContext): WorkflowView | null {
  const projection = readWorkflowProjection(db, workflowId);
  if (!projection) {
    return null;
  }

  const completionRow = readWorkflowCompletionRow(db, workflowId);
  const completion = completionRow ? decodeBody(completionRow, workflowCompletedBodySchema, ctx) : null;
  const childRows = readWorkflowChildJobRows(db, workflowId);
  const childBySlot = selectChildRowsBySlot(projection.plan, childRows);
  const slotOutcomes: Record<string, WorkflowSlotOutcome> = {};
  let lastSeq = Math.max(projection.lastSeq, completionRow?.seq ?? 0);

  for (const slot of projection.plan.slots) {
    const child = childBySlot.get(slot.slotId) ?? null;
    if (!child) {
      slotOutcomes[slot.slotId] = {
        jobId: null,
        phase: null,
        causeRef: null,
        lastSeq: null,
      };
      continue;
    }

    lastSeq = Math.max(lastSeq, child.last_seq);
    const terminal = child.terminal === null ? null : jobTerminalSchema.parse(JSON.parse(child.terminal));
    slotOutcomes[slot.slotId] = {
      jobId: child.job_id,
      phase: child.phase,
      causeRef: terminal?.outcome.kind === 'failed' ? terminal.outcome.causeRef : null,
      lastSeq: child.last_seq,
    };
  }

  return {
    workflowId,
    plan: projection.plan,
    slotOutcomes,
    outcome: completion?.outcome ?? 'running',
    causeRef: completion?.outcome === 'failed' ? completion.causeRef : null,
    lastSeq,
  };
}

export function readProjectionJob(db: Database, jobId: string): ProjectedJobState | null {
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

function readWorkflowCompletionRow(db: Database, workflowId: string): WorkflowCompletionRow | null {
  const row = db
    .prepare(
      `SELECT seq, type, body_version, body
         FROM events
        WHERE stream_kind = 'workflow'
          AND stream_id = ?
          AND type = 'workflow.completed'
        ORDER BY seq DESC
        LIMIT 1`,
    )
    .get(workflowId) as WorkflowCompletionRow | undefined;

  return row ?? null;
}

function readWorkflowChildJobRows(db: Database, workflowId: string): WorkflowChildJobRow[] {
  return db
    .prepare(
      `SELECT job_id, phase, terminal, workflow_slot, last_seq
         FROM projection_jobs
        WHERE parent_workflow_job_id = ?
          AND workflow_slot IS NOT NULL
        ORDER BY workflow_slot ASC, last_seq DESC`,
    )
    .all(workflowId) as WorkflowChildJobRow[];
}

function selectChildRowsBySlot(
  plan: WorkflowPlan,
  rows: readonly WorkflowChildJobRow[],
): Map<string, WorkflowChildJobRow> {
  const slotIds = new Set(plan.slots.map((slot) => slot.slotId));
  const selected = new Map<string, WorkflowChildJobRow>();

  for (const row of rows) {
    if (slotIds.has(row.workflow_slot) && !selected.has(row.workflow_slot)) {
      selected.set(row.workflow_slot, row);
    }
  }

  return selected;
}
