import { progressVisitFromDetails } from '#tests/helpers/wait-progress.js';
import { it, expect } from 'vitest';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { historicalSourceReader, seedHistoricalEpoch } from '#src/jobs/historical-reader.js';
import { waitEpochToken, waitJobHash } from '#src/jobs/wait/cursor.js';
import { buildJobEventRefs } from '#src/jobs/refs.js';
import { currentCoralStoreFormat } from '#src/store-format.js';

it('historical: a 501-row window with a non-message row hides later progress', () => {
  const f = createTerminalExportFixture('provider', true);
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
    seedHistoricalEpoch(
      f.runtime,
      f.index,
      f.epoch,
      f.epochKey,
      currentCoralStoreFormat().fingerprint,
      f.runtime.paths.coral.exports.jobsRoot,
      f.runtime.storage,
      [],
      true,
    );
    const owner = f.store.getResultExportOwner();
    const addressing = new JobAddressing(
      f.index.readOnlyView(),
      {
        visitProgress: progressVisitFromDetails(() => null),
        epochKey: () => 'other-active',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'decided',
      historicalSourceReader(f.index),
      (id) => owner.observeResultAvailability(id),
      () => {},
      () => false,
    );
    const cursor = {
      jobs: [
        { hash: waitJobHash(f.jobId), epoch: waitEpochToken(f.epochKey), seq: launchSeq, lineOffset: 0, flags: 0 },
      ],
    };
    const snap = addressing.snapshot({ jobIds: [f.jobId], cursor });
    // A 499-row page and its lookahead row spend one poll's 500-row allowance; the fault row is one of those 499.
    expect(snap.jobs[0].progress).toEqual(Array.from({ length: 498 }, (_, index) => `line ${index}`));
    expect(snap.remainingJobIds).toEqual([f.jobId]);
    const next = addressing.snapshot({ jobIds: [f.jobId], cursor: snap.cursor });
    expect(next.jobs[0].progress).toEqual(Array.from({ length: 102 }, (_, index) => `line ${index + 498}`));
    expect(next.remainingJobIds).toEqual([]);
  } finally {
    f.close();
  }
});
