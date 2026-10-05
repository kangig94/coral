import { progressVisitFromDetails } from '#tests/helpers/wait-progress.js';
import { it, expect } from 'vitest';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';
import {
  registerPresentHistoricalEpochs,
  retryUnknownHistoricalEpochs,
  refreshHistoricalEpochs,
} from '#src/jobs/historical-reader.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { currentCoralStoreFormat } from '#src/store-format.js';

it('a transient registration failure leaves a fallback-keyed retry hold that nothing clears', async () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    f.complete();
    const lineage = join(f.epochDir, '.coral-lineage.v1.json');
    const saved = readFileSync(lineage);
    renameSync(lineage, lineage + '.aside');
    const entry = {
      resolved: f.epoch,
      epochKey: null,
      epochJson: { kind: 'valid', value: { build: { storeFormatFingerprint: currentCoralStoreFormat().fingerprint } } },
    } as never;
    registerPresentHistoricalEpochs(f.runtime, f.index, [entry], 'some-other-active-epoch', { remaining: 0 });

    writeFileSync(lineage, saved);
    const entry2 = { ...(entry as object), epochKey: f.epochKey } as never;
    for (let tick = 0; tick < 6; tick++) {
      const budget = { remaining: 0 };
      registerPresentHistoricalEpochs(f.runtime, f.index, [entry2], 'some-other-active-epoch', budget);
      await retryUnknownHistoricalEpochs(f.index, budget);
      await refreshHistoricalEpochs(f.index, budget);
    }
    const holds = f.index.unknownLocationHolds();

    const addressing = new JobAddressing(
      f.index.readOnlyView(),
      {
        visitProgress: progressVisitFromDetails(() => null),
        epochKey: () => 'some-other-active-epoch',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'decided',
      undefined,
      () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
    );

    expect(holds).toEqual([]);
    expect(addressing.unknownJobDisposition()).toBe('not-found');
    expect(addressing.admitWait({ jobIds: ['typo-id'], supportsWaitV3: true })[0].disposition).toBe('missing');
  } finally {
    f.close();
  }
});
