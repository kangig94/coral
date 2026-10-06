import { progressVisitFromDetails } from '#tests/helpers/wait-progress.js';
import { it, expect } from 'vitest';
import { rmSync } from 'node:fs';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';
import { registerPresentHistoricalEpochs, readHistoricalSource } from '#src/jobs/historical-reader.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { currentCoralStoreFormat } from '#src/store-format.js';

it('admits an unindexed historical job read-only before maintenance hydration', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    f.complete();
    rmSync(f.locationPath); // released <=0.10.15 epochs carry no location records
    const entry = {
      resolved: f.epoch,
      epochKey: f.epochKey,
      epochJson: { kind: 'valid', value: { build: { storeFormatFingerprint: currentCoralStoreFormat().fingerprint } } },
    } as never;
    registerPresentHistoricalEpochs(f.runtime, f.index, [entry], 'new-active-epoch', { remaining: 0 });

    const direct = readHistoricalSource(f.index, f.epochKey, [f.jobId]);
    expect(direct.kind === 'read' && direct.locations.get(f.jobId)?.disposition).toBe('terminal');

    const addressing = new JobAddressing(
      f.index.readOnlyView(),
      {
        visitProgress: progressVisitFromDetails(() => null),
        epochKey: () => 'new-active-epoch',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'decided',
      undefined,
      () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
    );
    const admitted = addressing.admitWait({ jobIds: [f.jobId] } as never);

    expect(admitted[0].disposition).toBe('admitted');
    expect(f.index.read(f.jobId)).toBeNull();
  } finally {
    f.close();
  }
});
