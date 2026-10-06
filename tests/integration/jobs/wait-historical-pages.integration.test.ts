import { progressVisitFromDetails } from '#tests/helpers/wait-progress.js';
import { it, expect } from 'vitest';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { historicalSourceReader, seedHistoricalEpoch } from '#src/jobs/historical-reader.js';
import { waitEpochToken, waitJobHash } from '#src/jobs/wait/cursor.js';
import { currentCoralStoreFormat } from '#src/store-format.js';

it('historical: no fault row; watermark before launch (reset/new member) hides later progress', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    f.store.appendProgress(f.jobId, 'session-1', 'line 0');
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
      jobs: [{ hash: waitJobHash(f.jobId), epoch: waitEpochToken(f.epochKey), seq: 0, lineOffset: 0, flags: 0 }],
    };
    const snap = addressing.snapshot({ jobIds: [f.jobId], cursor } as never);
    expect(snap.jobs[0].progress).toEqual(Array.from({ length: 500 }, (_, i) => `line ${i}`));
    expect(snap.remainingJobIds).toEqual([f.jobId]);
    const next = addressing.snapshot({ jobIds: [f.jobId], cursor: snap.cursor });
    expect(next.jobs[0].progress).toEqual(Array.from({ length: 100 }, (_, i) => `line ${i + 500}`));
    expect(next.remainingJobIds).toEqual([]);
  } finally {
    f.close();
  }
});
