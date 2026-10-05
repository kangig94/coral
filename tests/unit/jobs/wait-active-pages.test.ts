import type { ProgressSource } from '#src/jobs/wait/contract.js';
import { it, expect } from 'vitest';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { WaitCoordinator } from '#src/jobs/shell/wait.js';
import { deriveLaunchReadiness } from '#src/jobs/launch-readiness.js';
import { waitEpochToken, waitJobHash } from '#src/jobs/wait/cursor.js';
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
    visitProgress: <T>(_epoch: string, read: (source: ProgressSource) => T) => ({
      kind: 'read' as const,
      value: f.store.visitProgress(read),
    }),
    sessionManager: { get: () => null } as never,
    launchQueue: { reservationFor: () => null, getActiveJobIds: () => [] } as never,
    eventBus: f.store.getEventBus(),
    time: f.runtime.time,
    loadJobProjectionDetail: (id) => f.store.loadJobProjectionDetail(id),

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
    () => false,
  );
  return { f, addressing };
}

it('a 501-row window with one non-message progress row loses rows past the window', () => {
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
    const cursor = {
      version: 'jobs.wait.v3' as const,
      jobs: [
        { hash: waitJobHash(f.jobId), epoch: waitEpochToken(f.epochKey), seq: launchSeq, lineOffset: 0, flags: 0 },
      ],
    };
    const snap = addressing.snapshot({ jobIds: [f.jobId], cursor, supportsWaitV3: true } as never);

    expect(snap.jobs[0].progress).toHaveLength(500);
    expect(snap.remainingJobIds).toEqual([f.jobId]);
    const second = addressing.snapshot({ jobIds: [f.jobId], cursor: snap.cursor, supportsWaitV3: true });
    expect(second.jobs[0].progress).toEqual(Array.from({ length: 100 }, (_, i) => `line ${i + 500}`));
    expect(second.remainingJobIds).toEqual([]);
  } finally {
    f.close();
  }
});
