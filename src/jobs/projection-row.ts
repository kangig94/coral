import { z } from 'zod';

import { executionOwnerSchema } from '../runtime/execution-owner.js';
import type { ExecutionOwner } from '../runtime/execution-owner.js';
import { sqlPlaceholders, type Database } from '../store/db.js';
import { isTerminalPhase, LIVE_JOB_PHASES, jobPhaseSchema } from './phase.js';
import { jobKindSchema } from './records.js';
import { jobDiagnosticsSchema, jobTerminalSchema } from './terminal/result.js';

export const projectionJobStoredRowSchema = z
  .object({
    job_id: z.string().min(1),
    execution_owner: z.string(),
    phase: jobPhaseSchema,
    terminal: z.string().nullable(),
    diagnostics: z.string(),
    session_id: z.string().min(1).nullable(),
    provider: z.string().min(1).nullable(),
    project_root: z.string(),
    backend_namespace: z.string().min(1),
    bundle_hash: z.string().min(1).nullable(),
    job_kind: jobKindSchema,
    parent_workflow_job_id: z.string().min(1).nullable(),
    workflow_slot: z.string().min(1).nullable(),
    workflow_slot_generation: z.number().int().nonnegative().nullable(),
    replaces_workflow_job_id: z.string().min(1).nullable(),
    created_at: z.string().datetime(),
    last_seq: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((row, ctx) => {
    const terminalPhase = isTerminalPhase(row.phase);
    if (row.terminal !== null && !terminalPhase) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['terminal'],
        message: 'Terminal JSON may only be present for a terminal phase.',
      });
    }

    const workflowChild = row.parent_workflow_job_id !== null;
    if (workflowChild !== (row.workflow_slot !== null) || workflowChild !== (row.workflow_slot_generation !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parent_workflow_job_id'],
        message: 'Workflow parent, slot, and generation must be present or absent together.',
      });
    }
    if (row.workflow_slot_generation === 0 && row.replaces_workflow_job_id !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['replaces_workflow_job_id'],
        message: 'Workflow generation zero cannot replace another job.',
      });
    }
    if (
      row.workflow_slot_generation !== null &&
      row.workflow_slot_generation > 0 &&
      row.replaces_workflow_job_id === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['replaces_workflow_job_id'],
        message: 'A later workflow generation must name the job it replaces.',
      });
    }

    if (row.job_kind === 'provider') {
      if (row.session_id === null || row.provider === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['session_id'],
          message: 'Provider jobs must retain both their session and provider identity.',
        });
      }
    } else {
      if (row.session_id !== null || row.provider !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['session_id'],
          message: 'Workflow and KB jobs cannot retain provider-session identity.',
        });
      }
      if (workflowChild || row.replaces_workflow_job_id !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['parent_workflow_job_id'],
          message: 'Only provider jobs can occupy or replace workflow slots.',
        });
      }
    }
  })
  .describe('validate-projection-job-authority-relationships');

export type ProjectionJobStoredRow = z.infer<typeof projectionJobStoredRowSchema>;

export const projectionJobDecoderContract = {
  jsonColumns: {
    execution_owner: 'ExecutionOwner',
    terminal: 'JobTerminal|null',
    diagnostics: 'JobDiagnostics',
  },
  authority: [
    'provider-session owner id equals provider session_id',
    'workflow child owner id equals parent_workflow_job_id',
    'workflow root owner id equals job_id',
    'kb job owner kind is system-task',
    'standalone provider job owner kind is provider-session or discussion',
    'workflow and kb rows cannot retain provider session identity',
    'workflow parent slot generation replacement relationships are atomic',
    'terminal payload is present only in a terminal phase',
  ],
} as const;

export const PROJECTION_JOB_COLUMNS =
  'job_id, execution_owner, phase, terminal, diagnostics, session_id, provider, project_root, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id, workflow_slot, workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq';

function parseJson(raw: string, column: string, jobId: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new TypeError(`projection_jobs.${column} for '${jobId}' is not valid JSON.`, { cause: error });
  }
}

export function decodeProjectionJobStoredRow(raw: unknown): ProjectionJobStoredRow {
  const row = projectionJobStoredRowSchema.parse(raw);
  const owner = executionOwnerSchema.parse(parseJson(row.execution_owner, 'execution_owner', row.job_id));
  if (row.terminal !== null) jobTerminalSchema.parse(parseJson(row.terminal, 'terminal', row.job_id));
  jobDiagnosticsSchema.parse(parseJson(row.diagnostics, 'diagnostics', row.job_id));
  if (row.job_kind === 'workflow' && (owner.kind !== 'workflow' || owner.id !== row.job_id)) {
    throw new TypeError(`projection_jobs execution owner for '${row.job_id}' contradicts its workflow authority.`);
  }
  if (row.job_kind === 'kb' && owner.kind !== 'system-task') {
    throw new TypeError(`projection_jobs execution owner for '${row.job_id}' contradicts its system-task authority.`);
  }
  if (row.job_kind === 'provider') {
    if (row.parent_workflow_job_id !== null) {
      if (owner.kind !== 'workflow' || owner.id !== row.parent_workflow_job_id) {
        throw new TypeError(`projection_jobs execution owner for '${row.job_id}' contradicts its workflow authority.`);
      }
    } else if (!((owner.kind === 'provider-session' && owner.id === row.session_id) || owner.kind === 'discussion')) {
      throw new TypeError(`projection_jobs execution owner for '${row.job_id}' contradicts its provider authority.`);
    }
  }
  return row;
}

export function decodeProjectionJobTerminal(row: Pick<ProjectionJobStoredRow, 'job_id' | 'terminal'>) {
  return row.terminal === null ? null : jobTerminalSchema.parse(parseJson(row.terminal, 'terminal', row.job_id));
}

export function decodeProjectionJobExecutionOwner(
  row: Pick<ProjectionJobStoredRow, 'job_id' | 'execution_owner'>,
): ExecutionOwner {
  return executionOwnerSchema.parse(parseJson(row.execution_owner, 'execution_owner', row.job_id));
}

export function readProjectionJobRows(db: Database): ProjectionJobStoredRow[] {
  return db
    .prepare(`SELECT ${PROJECTION_JOB_COLUMNS} FROM projection_jobs ORDER BY job_id ASC`)
    .all()
    .map(decodeProjectionJobStoredRow);
}

export function readWorkflowChildProjectionRows(
  db: Database,
  parentWorkflowJobId: string,
  workflowSlotId?: string,
): ProjectionJobStoredRow[] {
  const slotFilter = workflowSlotId === undefined ? '' : ' AND workflow_slot = ?';
  const parameters = workflowSlotId === undefined ? [parentWorkflowJobId] : [parentWorkflowJobId, workflowSlotId];
  return db
    .prepare(
      `SELECT ${PROJECTION_JOB_COLUMNS}
         FROM projection_jobs
        WHERE parent_workflow_job_id = ?${slotFilter}
        ORDER BY job_id ASC`,
    )
    .all(...parameters)
    .map(decodeProjectionJobStoredRow);
}

const auditedProjectionJobDatabases = new WeakSet<Database>();

/**
 * Full current-format audit paid once per handle. Subsequent operational
 * queries may use indexes because every Coral writer validates a complete row
 * before upsert; another connection changes PRAGMA data_version and forces a
 * new audit.
 */
const auditedProjectionJobDataVersion = new WeakMap<Database, number>();

export function assertProjectionJobTableIntegrity(db: Database): void {
  const dataVersion = db.prepare<[], { data_version: number }>('PRAGMA data_version').get()?.data_version ?? -1;
  if (auditedProjectionJobDatabases.has(db) && auditedProjectionJobDataVersion.get(db) === dataVersion) return;
  readProjectionJobRows(db);
  auditedProjectionJobDatabases.add(db);
  auditedProjectionJobDataVersion.set(db, dataVersion);
}

export function countProjectedLiveJobRows(db: Database, excludedJobIds: readonly string[] = []): number {
  assertProjectionJobTableIntegrity(db);
  const clauses = [`phase IN (${sqlPlaceholders(LIVE_JOB_PHASES.length)})`];
  const parameters: unknown[] = [...LIVE_JOB_PHASES];
  if (excludedJobIds.length > 0) {
    clauses.push(`job_id NOT IN (${excludedJobIds.map(() => '?').join(', ')})`);
    parameters.push(...excludedJobIds);
  }
  return (
    db
      .prepare<
        unknown[],
        { count: number }
      >(`SELECT COUNT(*) AS count FROM projection_jobs WHERE ${clauses.join(' AND ')}`)
      .get(...parameters)?.count ?? 0
  );
}

/**
 * Lists only the projection rows whose stored phase is nonterminal. `INDEXED BY` pins this operational read
 * to the phase/namespace index instead of turning carrier observation into a scan over historical jobs.
 */
export function readStoredNonterminalProjectionJobIds(db: Database): string[] {
  return db
    .prepare<unknown[], { job_id: string }>(
      `SELECT job_id FROM projection_jobs INDEXED BY projection_jobs_phase_namespace WHERE phase IN (${sqlPlaceholders(LIVE_JOB_PHASES.length)}) ORDER BY job_id ASC`,
    )
    .all(...LIVE_JOB_PHASES)
    .map(({ job_id }) => {
      if (typeof job_id !== 'string' || job_id.length === 0) {
        throw new TypeError('projection_jobs.job_id for a stored-nonterminal row is invalid.');
      }
      return job_id;
    });
}

export function readProjectionJobRow(db: Database, jobId: string): ProjectionJobStoredRow | null {
  const raw = db.prepare(`SELECT ${PROJECTION_JOB_COLUMNS} FROM projection_jobs WHERE job_id = ?`).get(jobId);
  return raw === undefined ? null : decodeProjectionJobStoredRow(raw);
}
