import type { WaitCursor } from '#src/jobs/wait/contract.js';
import { waitJobHash, waitEpochToken } from '#src/jobs/wait/cursor.js';
import type { JobDetailResponse, JobEvent } from '#src/jobs/records.js';
import type { WaitAdmission, WaitSession } from '#src/jobs/wait/session.js';
import type { ProgressVisit } from '#src/jobs/wait/contract.js';
import { progressPage, progressTail } from '#src/jobs/wait/progress-page.js';
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

export function progressVisitFromEvents(
  read: (jobId: string) => readonly JobEvent[],
  frontier?: () => number,
): ProgressVisit {
  return (_epoch, visit) => {
    const raw = (id: string) =>
      read(id)
        .filter((event) => event.type === 'progress')
        .map((event) => ({
          seq: event.seq,
          ...(event.type === 'progress'
            ? { progress: { seq: event.seq, message: event.message, timing: event.timing } }
            : {}),
        }));
    const max = (id: string) => frontier?.() ?? read(id).reduce((seq, event) => Math.max(seq, event.seq), 0);
    return {
      kind: 'read',
      value: visit({
        after: (id, after, rows) =>
          progressPage(
            raw(id)
              .filter((row) => row.seq > after)
              .slice(0, rows + 1),
            rows,
            max(id),
          ),
        before: (id, before, rows) =>
          progressTail(
            raw(id)
              .filter((row) => before === null || row.seq < before)
              .reverse()
              .slice(0, rows + 1),
            rows,
            max(id),
          ),
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
    session.position(sources, null, 500, 65536);
    const selected = session.select(sources, limit, Infinity);
    session.advanceSilently(selected.advances);
    return selected.lines;
  });
}
export function selectWaitSnapshot(session: WaitSession, lines = 20) {
  observeWaitRead(() => session.admissions)();
  return snapshot(session, lines, testProgressVisit);
}

export function prefixCursor(jobs: readonly WaitAdmission[]): WaitCursor {
  return {
    jobs: jobs.map((job) => ({
      hash: waitJobHash(job.jobId),
      epoch: job.epochKey ? waitEpochToken(job.epochKey) : null,
      seq: 0,
      lineOffset: 0,
      flags: job.epochKey ? 0 : 4,
    })),
  };
}
