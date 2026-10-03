import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';
import { protectStoreEpoch, protectedStoreEpochRoot } from '#src/store/epoch/protection.js';
import { recordEpochClosure } from '#src/store/epoch/closure.js';
import { resolvedStoreEpoch } from '#src/store/epoch/observation.js';
import { sweepStoreEpochsPostReady } from '#src/store/epoch/post-ready-sweep.js';

it.each(['root', 'lineage', 'tombstone', 'ordinary'] as const)(
  'refuses symlinked %s while reclaiming ordinary residue',
  async (subject) => {
    const root = mkdtempSync(join(tmpdir(), 'coral-residue-lineage-'));
    try {
      const runtime = createRealRuntime('prod', { baseDir: join(root, '.coral') });
      const dbDir = runtime.paths.coral.store.dbDir;
      mkdirSync(runtime.paths.coral.generation.dataRoot, { recursive: true });
      const directory = join(dbDir, 'epoch-1');
      mkdirSync(directory, { recursive: true });
      new DatabaseSync(join(directory, 'store.db')).close();
      new DatabaseSync(join(directory, '.lock')).close();
      const address = protectStoreEpoch(runtime, resolvedStoreEpoch(dbDir, '1'));
      recordEpochClosure(runtime, runtime.paths.coral.generation.dataRoot, {
        version: 'v1',
        epochKey: address.epochKey,
        disposition: 'closed',
        dataOutcome: 'retained',
        executionDischarge: 'certified',
        obligations: [],
        reason: 'empty closed epoch',
        observedAtMs: 1,
      });
      const residue = join(dirname(address.protectedPath), '.reaping-epoch-1');
      renameSync(address.protectedPath, residue);
      writeFileSync(join(residue, 'sentinel'), 'preserve outside backup');
      let sentinel = join(residue, 'sentinel');
      if (subject !== 'ordinary') {
        const target =
          subject === 'root' ? protectedStoreEpochRoot(dbDir) : subject === 'lineage' ? dirname(residue) : residue;
        const backup = join(root, 'backup');
        renameSync(target, backup);
        symlinkSync(backup, target, 'dir');
        sentinel =
          subject === 'root'
            ? join(backup, address.epochKey.split(':')[0], '.reaping-epoch-1', 'sentinel')
            : subject === 'lineage'
              ? join(backup, '.reaping-epoch-1', 'sentinel')
              : join(backup, 'sentinel');
      }
      const result = await sweepStoreEpochsPostReady(runtime, resolvedStoreEpoch(dbDir, '2'), {
        resultsReleased: () => true,
      });
      expect(existsSync(sentinel)).toBe(subject !== 'ordinary');
      expect(result).toBe(subject === 'ordinary' ? 'complete' : 'unobservable-metadata');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
