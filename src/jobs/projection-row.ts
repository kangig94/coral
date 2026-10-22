import { z } from 'zod';

import { hashToken } from '../infra/hash.js';
import { sessionControllerFromProfile } from '../sessions/entry.js';

import { executionOwnerSchema } from '../runtime/execution-owner.js';
import type { ExecutionOwner } from '../runtime/execution-owner.js';
import { canonicalWorkDirWireSchema } from '../runtime/canonical-work-dir.js';
import type { Database } from '../store/db.js';
import { executionOrdinalSchema, jobConversationFacetSchema } from './launch.js';
import { jobPhaseSchema } from './phase.js';
import { jobKindSchema } from './records.js';
import { jobDiagnosticsSchema, jobTerminalSchema } from './terminal/result.js';

export const projectionJobStoredRowSchema = z
  .object({
    job_id: z.string().min(1),
    execution_owner: z.string(),
    phase: jobPhaseSchema,
    terminal: z.string().nullable(),
    diagnostics: z.string(),
    execution: executionOrdinalSchema.nullable(),
    finishing: z.union([z.literal(0), z.literal(1)]),
    controller: z.string().min(1).nullable(),
    resumable: z.union([z.literal(0), z.literal(1)]).nullable(),
    conversation_ref: z.string().min(1).nullable(),
    scope_key: z.string().min(1).nullable(),
    facet: z.string().nullable(),
    provider: z.string().min(1).nullable(),
    project_root: z.string(),
    work_dir: canonicalWorkDirWireSchema.nullable(),
    backend_namespace: z.string().min(1).nullable(),
    bundle_hash: z.string().min(1).nullable(),
    job_kind: jobKindSchema,
    parent_workflow_job_id: z.string().min(1).nullable(),
    workflow_slot: z.string().min(1).nullable(),
    created_at: z.string().datetime(),
    last_seq: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((row, ctx) => {
    const terminalPhase = row.phase === 'completed' || row.phase === 'error' || row.phase === 'aborted';
    if (row.terminal !== null && !terminalPhase) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['terminal'],
        message: 'Terminal JSON may only be present for a terminal phase.',
      });
    }

    if (row.finishing === 1 && (terminalPhase || row.execution === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['finishing'],
        message: 'Only an open execution can be finishing.',
      });
    }
    if ((row.execution === null) !== (row.backend_namespace === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['execution'],
        message: 'Execution and launch namespace must be present together.',
      });
    }
    const workflowChild = row.parent_workflow_job_id !== null;
    if (workflowChild !== (row.workflow_slot !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['workflow_slot'],
        message: 'Workflow parent and slot must be present together.',
      });
    }
    const conversationColumns = [row.provider, row.controller, row.resumable, row.scope_key, row.facet];
    if (row.job_kind === 'provider') {
      if (conversationColumns.some((value) => value === null)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['facet'],
          message: 'Provider jobs require a complete conversation facet.',
        });
      }
    } else if (conversationColumns.some((value) => value !== null) || row.conversation_ref !== null || workflowChild) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['facet'],
        message: 'Only provider jobs can carry conversation or workflow-slot identity.',
      });
    }
  })
  .describe('validate-projection-job-authority-relationships');

export type ProjectionJobStoredRow = z.infer<typeof projectionJobStoredRowSchema>;

export const projectionJobDecoderContract = {
  jsonColumns: {
    execution_owner: 'ExecutionOwner',
    terminal: 'JobTerminal|null',
    diagnostics: 'JobDiagnostics',
    facet: 'JobConversationFacet|null',
  },
  authority: [
    'provider-session owner id equals job_id',
    'workflow child owner id equals parent_workflow_job_id',
    'workflow root owner id equals job_id',
    'kb job owner kind is system-task',
    'standalone provider job owner kind is provider-session or discussion',
    'workflow and kb rows cannot retain a conversation facet',
    'workflow parent and slot are present together',
    'finishing requires an open execution',
    'terminal payload is present only in a terminal phase',
  ],
} as const;

export const PROJECTION_JOB_COLUMNS =
  'job_id, execution_owner, phase, terminal, diagnostics, execution, finishing, controller, resumable, conversation_ref, scope_key, facet, provider, project_root, work_dir, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id, workflow_slot, created_at, last_seq';

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
  if (row.facet !== null) {
    const facet = jobConversationFacetSchema.parse(parseJson(row.facet, 'facet', row.job_id));
    if (
      facet.provider !== row.provider ||
      facet.cwd !== row.work_dir ||
      sessionControllerFromProfile(facet.controllerProfile) !== row.controller ||
      hashToken(row.project_root, 12) !== row.scope_key
    ) {
      throw new TypeError(`projection_jobs conversation facet for '${row.job_id}' contradicts its columns.`);
    }
  }
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
    } else if (!((owner.kind === 'provider-session' && owner.id === row.job_id) || owner.kind === 'discussion')) {
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
  const clauses = ["phase IN ('queued', 'launching', 'running')"];
  const parameters: unknown[] = [];
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
    .prepare<[], { job_id: string }>(
      "SELECT job_id FROM projection_jobs INDEXED BY projection_jobs_phase_namespace WHERE phase IN ('queued', 'launching', 'running') ORDER BY job_id ASC",
    )
    .all()
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
