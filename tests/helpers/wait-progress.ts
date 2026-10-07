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

/** The frontier covers every event of each job this visit has read, as the journal's highest seq would. */
export function progressVisitFromEvents(read: (jobId: string) => readonly JobEvent[]): ProgressVisit {
  return (_epoch, visit) => {
    const seen = new Set<string>();
    const rows = (id: string): WaitProgressRow[] => {
      seen.add(id);
      return read(id).flatMap((event) =>
        event.type === 'progress' ? [{ seq: event.seq, message: event.message, timing: event.timing }] : [],
      );
    };
    return {
      kind: 'read',
      value: visit({
        frontier: () => Math.max(0, ...[...seen].flatMap((id) => read(id).map((event) => event.seq))),
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
