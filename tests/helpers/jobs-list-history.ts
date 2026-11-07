import { hashToken } from '#src/infra/hash.js';
import { createCoordinatorRpcPorts } from '#src/coordinator/composition/rpc-ports.js';
import { JobAttention } from '#src/coordinator/services/job-attention.js';
import { listJobProjections, loadJobProjectionDetail, type JobsListFilters } from '#src/jobs/read-queries.js';
import type { EventsRow } from '#src/store/schema.js';
import type { ProjectionJobStoredRow } from '#src/jobs/projection-row.js';
import { executionHarness, openedJob, requestedExecution, EXECUTION_JOB_ID } from './job-executions.js';
import { insertTestJobProjection } from './job-projection.js';

export function createJobsListHistory(count: number, resultContent = 'done') {
  const h = executionHarness();
  h.append(openedJob(), requestedExecution());
  h.complete();
  h.append(requestedExecution(2, { coralEnv: { CORAL_OWNER: 'mine' } }));
  h.complete(2);
  const template = h.db.prepare<[], ProjectionJobStoredRow>('SELECT * FROM projection_jobs').get()!;
  const evidence = h.db.prepare<[], EventsRow>('SELECT * FROM events ORDER BY seq').all();
  h.db.exec('DELETE FROM projection_jobs; DELETE FROM events; BEGIN');
  const append = h.db.prepare('INSERT INTO events(ts,type,stream_kind,stream_id,body) VALUES (?,?,?,?,?)');
  for (let n = 0; n < count + 4; n++) {
    const id = `job-${String(n).padStart(5, '0')}`;
    const terminal = n < count;
    const kb = n % 7 === 0;
    const discussion = !kb && n % 3 === 0;
    let acceptedSeq = 0;
    let lastSeq = 0;
    for (const event of evidence) {
      if (!terminal && ['job.execution.ended', 'job.execution.outcome.accepted'].includes(event.type)) continue;
      const body = JSON.parse(Buffer.from(event.body).toString().replaceAll(EXECUTION_JOB_ID, id));
      if (event.type === 'job.opened') {
        body.owner = kb
          ? { kind: 'system-task', id: 'kb.reindex' }
          : discussion
            ? { kind: 'discussion', id: 'discussion-a' }
            : { kind: 'provider-session', id };
        if (kb) {
          body.jobKind = 'kb';
          delete body.conversation;
        }
      }
      if (kb && event.type === 'job.execution.requested') body.input = { operation: 'kb.reindex', request: {} };
      if (event.type === 'job.execution.outcome.accepted') body.terminal.content = resultContent;
      if (event.type === 'job.execution.ended') body.causeRef.seq = acceptedSeq;
      lastSeq = Number(
        append.run(
          new Date(Date.parse(event.ts) + event.seq * 1000).toISOString(),
          event.type,
          'job',
          id,
          Buffer.from(JSON.stringify(body)),
        ).lastInsertRowid,
      );
      if (event.type === 'job.execution.outcome.accepted') acceptedSeq = lastSeq;
    }
    for (let j = 0; j < 30; j++) {
      lastSeq = Number(
        append.run(
          '2026-12-01T00:00:00.000Z',
          'job.execution.progress',
          'job',
          id,
          Buffer.from(JSON.stringify({ execution: 2, kind: 'message', message: 'progress' })),
        ).lastInsertRowid,
      );
    }
    insertTestJobProjection(h.db, {
      ...template,
      job_id: id,
      last_seq: lastSeq,
      phase: terminal ? 'completed' : 'launching',
      terminal: terminal ? JSON.stringify({ ...JSON.parse(template.terminal!), content: resultContent }) : null,
      execution_owner: JSON.stringify(
        kb
          ? { kind: 'system-task', id: 'kb.reindex' }
          : discussion
            ? { kind: 'discussion', id: 'discussion-a' }
            : { kind: 'provider-session', id },
      ),
      ...(!kb && n % 5 === 0 ? { project_root: '/owning-project', scope_key: hashToken('/owning-project', 12) } : {}),
      ...(kb
        ? {
            job_kind: 'kb',
            work_dir: null,
            facet: null,
            provider: null,
            controller: null,
            scope_key: null,
            resumable: null,
            conversation_ref: null,
          }
        : {}),
    });
  }
  h.db.exec('COMMIT');
  return h;
}

export function coordinatorJobs(
  h: ReturnType<typeof createJobsListHistory>,
  db = h.db,
): ReturnType<typeof createCoordinatorRpcPorts>['jobs'] {
  return createCoordinatorRpcPorts({
    services: { jobAttention: new JobAttention() },
    getProgressStore: () => ({
      listJobProjections: (filters?: JobsListFilters) => listJobProjections(db, h.readCtx, filters),
      loadJobProjectionDetail: (id: string) => loadJobProjectionDetail(db, id, h.readCtx),
    }),
  } as unknown as Parameters<typeof createCoordinatorRpcPorts>[0]).jobs;
}
