import { progressVisitFromDetails } from '#tests/helpers/wait-progress.js';
import { it, expect } from 'vitest';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';
import {
  registerPresentHistoricalEpochs,
  retryUnknownHistoricalEpochs,
  refreshHistoricalEpochs,
} from '#src/jobs/historical-reader.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { epochHoldDirectory } from '#src/store/epoch/identity.js';

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
      () => ({ kind: 'failed', reason: 'the retained terminal does not match its source journal' }),
    );

    expect(holds).toEqual([]);
    expect(addressing.unknownJobDisposition()).toBe('not-found');
    expect(addressing.admitWait({ jobIds: ['typo-id'] })[0].disposition).toBe('missing');
  } finally {
    f.close();
  }
});

it('reads a v0.10.16-18 hold as retrying only while a registered source of a present epoch owns it', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    f.complete();
    const holdDirectory = join(f.root, 'job-locations.v1', 'epochs', epochHoldDirectory(f.epochKey));
    mkdirSync(holdDirectory, { recursive: true });
    // As a released build wrote it: no epoch key and no retry field.
    writeFileSync(
      join(holdDirectory, 'unknown-locations.v1.json'),
      JSON.stringify({ version: 'v1', reason: 'legacy hold' }),
    );
    expect(f.index.unknownLocationHolds()).toMatchObject([{ retryScheduled: false }]);
    const entry = {
      resolved: f.epoch,
      epochKey: f.epochKey,
      epochJson: { kind: 'valid', value: { build: { storeFormatFingerprint: currentCoralStoreFormat().fingerprint } } },
    } as never;
    registerPresentHistoricalEpochs(f.runtime, f.index, [entry], 'other-active', { remaining: 0 });
    expect(f.index.unknownLocationHolds()).toEqual([
      { epochKey: f.epochKey, reason: 'legacy hold', retryScheduled: true },
    ]);
    f.removeSource();
    expect(f.index.unknownLocationHolds()).toMatchObject([{ retryScheduled: false }]);
  } finally {
    f.close();
  }
});
