import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRetentionFixture } from '#tests/helpers/storage-retention.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import * as historicalReaders from '#src/jobs/historical-reader.js';
import { seedHistoricalEpoch } from '#src/jobs/historical-reader.js';
import { recoverJobLocations } from '#src/jobs/location-recovery.js';
const fixtures: ReturnType<typeof createRetentionFixture>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) f.close();
});
it('a throwing historical epoch cannot fail active location recovery', () => {
  const f = createRetentionFixture();
  fixtures.push(f);
  const index = new JobLocationIndex(f.runtime, f.runtime.paths.coral.generation.dataRoot);
  const storeRoot = join(f.baseDir, 'store');
  const historical = { storeRoot, epoch: '1', path: join(storeRoot, 'epoch-1', 'store.db') };
  const historicalKey = JSON.stringify(historical);
  // A historical source whose path observation fails with a non-ENOENT error (EACCES on an ancestor, EIO, ...).
  const storage = {
    ...f.runtime.storage,
    lstatSync: (p: string, o?: unknown) => {
      if (p.startsWith(storeRoot)) throw Object.assign(new Error(`EACCES: ${p}`), { code: 'EACCES' });
      return (f.runtime.storage.lstatSync as (p: string, o?: unknown) => unknown)(p, o);
    },
  } as typeof f.runtime.storage;
  void seedHistoricalEpoch(
    f.runtime,
    index,
    historical,
    historicalKey,
    'sha256:unsupported',
    join(f.baseDir, 'exports'),
    storage,
  );
  const activeKey = JSON.stringify({ storeRoot, epoch: '2', path: join(storeRoot, 'epoch-2', 'store.db') });
  const refresh = vi.spyOn(historicalReaders, 'refreshHistoricalEpochs');
  let thrown: unknown;
  try {
    recoverJobLocations(index, activeKey, f.store);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeUndefined();
  expect(refresh).not.toHaveBeenCalled();
});

import { createTerminalExportFixture, TERMINAL_EXPORT_CUTOFF } from '#tests/helpers/terminal-export.js';

import { currentCoralStoreFormat } from '#src/store-format.js';

it.each(['recovery', 'seed', 'repair'] as const)('preserves legacy past-window discharge through %s', (owner) => {
  const f = createTerminalExportFixture('provider', true);
  try {
    const seq = f.complete({
      terminalAt: TERMINAL_EXPORT_CUTOFF - 86_400_000,
      precedingAt: TERMINAL_EXPORT_CUTOFF - 2 * 86_400_000,
    });
    const legacy = JSON.parse(readFileSync(f.locationPath, 'utf8'));
    delete legacy.terminalAge;
    writeFileSync(f.locationPath, JSON.stringify(legacy));
    rmSync(dirname(f.resultPath), { recursive: true, force: true });
    expect(f.index.certify(f.epochKey, seq)).not.toBeNull();
    expect(f.index.resultsReleased(f.epochKey)).toBe(true);
    if (owner === 'recovery') recoverJobLocations(f.index, f.epochKey, f.store);
    else if (owner === 'seed')
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
    else f.store.getResultExportOwner().ensureResultMarkdownArtifact(f.jobId);
    expect(JSON.parse(readFileSync(f.locationPath, 'utf8')).terminalAge).toMatchObject({ kind: 'known' });
    expect(f.index.certify(f.epochKey, seq)).not.toBeNull();
    expect(f.index.resultsReleased(f.epochKey)).toBe(true);
  } finally {
    f.close();
  }
});

import { trustedJobRetentionCutoff } from '#src/jobs/retention-clock.js';
it('trusted hydration records provable expiry after an untrusted post-commit capture', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    trustedJobRetentionCutoff(f.runtime);
    f.jump(2 * 86_400_000);
    const seq = f.complete({
      terminalAt: TERMINAL_EXPORT_CUTOFF - 86_400_000,
      precedingAt: TERMINAL_EXPORT_CUTOFF - 2 * 86_400_000,
    });
    expect(JSON.parse(readFileSync(f.locationPath, 'utf8')).terminalAge).toBeUndefined();
    f.advance(300_000);
    rmSync(dirname(f.resultPath), { recursive: true, force: true });
    recoverJobLocations(f.index, f.epochKey, f.store);
    expect(JSON.parse(readFileSync(f.locationPath, 'utf8')).terminalAge).toMatchObject({ kind: 'known' });
    expect(f.index.certify(f.epochKey, seq)).not.toBeNull();
    expect(f.index.resultsReleased(f.epochKey)).toBe(true);
  } finally {
    f.close();
  }
});
