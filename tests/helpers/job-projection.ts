import { hashToken } from '#src/infra/hash.js';
import type { ProjectionJobStoredRow } from '#src/jobs/projection-row.js';
import type { Database } from '#src/store/db.js';
import { fixtureCanonicalWorkDir } from './canonical-work-dir.js';
import { testConversationFacet } from './session.js';

export function insertTestJobProjection(
  db: Database,
  input: Pick<ProjectionJobStoredRow, 'job_id' | 'project_root'> & Partial<ProjectionJobStoredRow>,
): void {
  const row: ProjectionJobStoredRow = {
    execution_owner: JSON.stringify({ kind: 'provider-session', id: input.job_id }),
    phase: 'running',
    terminal: null,
    diagnostics: JSON.stringify({ progressFaults: [] }),
    execution: 1,
    finishing: 0,
    controller: 'default',
    resumable: 0,
    conversation_ref: null,
    scope_key: hashToken(input.project_root, 12),
    facet: JSON.stringify(testConversationFacet('codex', input.project_root)),
    provider: 'codex',
    work_dir: fixtureCanonicalWorkDir(input.project_root),
    backend_namespace: 'tests',
    bundle_hash: null,
    job_kind: 'provider',
    parent_workflow_job_id: null,
    workflow_slot: null,
    created_at: '2026-08-05T00:00:00.000Z',
    last_seq: 0,
    ...input,
  };
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO projection_jobs (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(
    ...Object.values(row),
  );
}
