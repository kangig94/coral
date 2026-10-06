import type { WaitCursor } from '#src/jobs/wait/contract.js';
import { waitJobHash } from '#src/jobs/wait/cursor.js';
import type { JobDetailResponse, JobEvent } from '#src/jobs/records.js';
import type { WaitAdmission, WaitSession } from '#src/jobs/wait/session.js';
import type { ProgressVisit, WaitProgressRow } from '#src/jobs/wait/contract.js';
import { selectWaitSnapshot as snapshot } from '#src/jobs/wait/snapshot.js';

const observed = new Map<string, readonly JobEvent[]>();
export function observeWaitRead(read: () => WaitAdmission[]): () => WaitAdmission[] {
  return () => {
    const jobs = read();
    for (const job of jobs) {
      const detail = job.detail as JobDetailResponse | undefined;
      observed.set(job.jobId, detail?.events ?? []);
    }
    return jobs;
  };
}

export function progressVisitFromEvents(read: (jobId: string) => readonly JobEvent[]): ProgressVisit {
  return (_epoch, visit) => {
    const rows = (id: string): WaitProgressRow[] =>
      read(id).flatMap((event) =>
        event.type === 'progress' ? [{ seq: event.seq, message: event.message, timing: event.timing }] : [],
      );
    return {
      kind: 'read',
      value: visit({
        after: (id, after, limit) =>
          rows(id)
            .filter((row) => row.seq > after)
            .slice(0, limit),
        newest: (id, limit) => rows(id).slice(-limit),
      }),
    };
  };
}
export const testProgressVisit = progressVisitFromEvents((id) => observed.get(id) ?? []);
export function progressVisitFromDetails(read: (jobId: string) => JobDetailResponse | null): ProgressVisit {
  return progressVisitFromEvents((id) => read(id)?.events ?? []);
}
export function selectTestProgress(session: WaitSession, limit = Infinity) {
  observeWaitRead(() => session.admissions)();
  return session.withProgress(testProgressVisit, (sources) => {
    const selected = session.select(sources, { lines: limit, bytes: Infinity }, null);
    session.commit(selected);
    return selected.rows;
  });
}
export function selectWaitSnapshot(session: WaitSession, lines = 20) {
  observeWaitRead(() => session.admissions)();
  return snapshot(session, lines, testProgressVisit);
}

/** A cursor positioning every located job at its origin; an unlocated job has no entry and reads its tail. */
export function prefixCursor(jobs: readonly WaitAdmission[]): WaitCursor {
  return { jobs: jobs.filter((job) => job.epochKey).map((job) => ({ hash: waitJobHash(job.jobId), seq: 0 })) };
}
