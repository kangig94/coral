import type { ProgressSource } from '#src/jobs/wait/contract.js';
import { it, expect } from 'vitest';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { WaitCoordinator } from '#src/jobs/shell/wait.js';
import { deriveLaunchReadiness } from '#src/jobs/launch-readiness.js';
import { savedCursor } from '#tests/helpers/wait-session.js';
import { buildJobEventRefs } from '#src/jobs/refs.js';

function setup() {
  const f = createTerminalExportFixture('provider', false);
  const detail = (id: string) => {
    const d = f.store.loadJobProjectionDetail(id);
    return d.status
      ? { status: d.status, events: f.store.readJobEvents(id), readiness: deriveLaunchReadiness(d), exit: d.exit }
      : null;
  };
  const owner = f.store.getResultExportOwner();
  const wait = new WaitCoordinator({
    visitProgress: <T>(_epoch: string, read: (source: ProgressSource) => T) => f.store.visitProgress(read),
    sessionManager: { get: () => null } as never,
    launchQueue: { reservationFor: () => null, getActiveJobIds: () => [] } as never,
    eventBus: f.store.getEventBus(),
    time: f.runtime.time,
    loadJobWaitDetail: (id) => f.store.loadJobWaitDetail(id),
    readJobLastSeq: (id) => f.store.readJobLastSeq(id),

    aggregateWorkflowUsage: () => undefined,
    subscribeJobEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
    getCurrentJournalSeq: () =>
      f.db.prepare<[], { seq: number }>('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get()?.seq ?? 0,
    resultJobsRoot: f.runtime.paths.coral.exports.jobsRoot,
    observeResultAvailability: (id) => owner.observeResultAvailability(id),
    hintResultRepair: () => {},
  });
  const addressing = new JobAddressing(
    f.index.readOnlyView(),
    {
      visitProgress: wait.visitProgress,
      epochKey: () => f.epochKey,
      detail,
      abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      readWaitAdmissions: (ids, epochKey, session) => wait.readWaitAdmissions(ids, epochKey, session),
      readWaitAdmission: (id, epochKey, session) => wait.readWaitAdmission(id, epochKey, session),
    },
    () => false,
    () => 'decided',
    undefined,
    (id) => owner.observeResultAvailability(id),
    () => {},
  );
  return { f, addressing };
}

it('resumes after a budget cut through the active journal, skipping a fault row and losing no line', () => {
  const { f, addressing } = setup();
  try {
    const launchSeq = f.db.prepare<[], { seq: number }>('SELECT MAX(seq) AS seq FROM events').get()!.seq;
    f.store.appendProgress(f.jobId, 'session-1', 'line 0');
    f.store.commit((c) => {
      c.append({
        type: 'job.progress.emitted',
        stream: { kind: 'job', id: f.jobId },
        namespace: 'fixture',
        project: f.root,
        refs: buildJobEventRefs({ jobId: f.jobId, sessionId: 'session-1' }),
        body: { kind: 'domain', stage: 'hosted_kb_operation_failed', message: 'KB op failed', detail: {} },
      });
      return undefined;
    });
    for (let i = 1; i < 600; i++) f.store.appendProgress(f.jobId, 'session-1', `line ${i}`);
    f.complete({ terminal: { content: 'done', outcome: { kind: 'completed' }, durationMs: 1 } });
    f.store.publishTerminalResult(f.jobId);
    const cursor = savedCursor(launchSeq);
    const first = addressing.snapshot({ jobIds: [f.jobId], cursor });
    // A 500-row page holds the fault row and 499 lines; the budget cut leaves the rest for the continuation.
    expect(first.jobs[0].progress).toEqual(Array.from({ length: 499 }, (_, i) => `line ${i}`));
    expect(first.jobs[0].terminal).toMatchObject({ outcomeKind: 'completed' });
    expect(first.jobs[0].availability).toMatchObject({ kind: 'available' });
    expect(first.remainingJobIds).toEqual([f.jobId]);
    const second = addressing.snapshot({ jobIds: [f.jobId], cursor: first.cursor ?? undefined });
    const delivered = new Set([...first.jobs[0].progress, ...second.jobs[0].progress]);
    expect(delivered).toEqual(new Set(Array.from({ length: 600 }, (_, i) => `line ${i}`)));
    expect(second.jobs[0].terminal).toBeDefined();
    expect(second.remainingJobIds).toEqual([]);
  } finally {
    f.close();
  }
});
