import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { acquireSharedFileLockSync } from '#src/infra/fs-lock.js';
import { createBackgroundPhaseObserver } from '#src/recovery/phase-observation.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { recordEpochClosure } from '#src/store/epoch/closure.js';
import { resolvedStoreEpoch } from '#src/store/epoch/observation.js';
import { sweepStoreEpochsPostReady } from '#src/store/epoch/post-ready-sweep.js';
import { protectStoreEpoch } from '#src/store/epoch/protection.js';
import type { Runtime } from '#src/runtime/ports.js';
import { openTestStoreDatabase } from '#tests/helpers/store-db.js';

function publishEpoch(runtime: Runtime, epoch: string): void {
  const directory = join(runtime.paths.coral.store.dbDir, `epoch-${epoch}`);
  const storeFormat = currentCoralStoreFormat();
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '.lock'), '');
  openTestStoreDatabase({ path: join(directory, 'store.db'), storage: runtime.storage, storeFormat }).close();
  writeFileSync(
    join(directory, 'epoch.json'),
    JSON.stringify({
      supersedes: null,
      classification: { kind: 'absent' },
      build: {
        version: storeFormat.productVersion,
        buildSetId: '123e4567-e89b-42d3-a456-426614174000',
        bundleHash: '0123456789abcdef',
        flavor: 'prod',
        storeFormatFingerprint: storeFormat.fingerprint,
      },
      publishedAt: `2026-10-0${epoch}T00:00:00.000Z`,
    }),
  );
}

it('reports a protected epoch lock hold once across completed sweeps and counts only its eventual removal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coral-protected-sweep-hold-'));
  const runtime = createRealRuntime('prod', { baseDir: root });
  const dbDir = runtime.paths.coral.store.dbDir;
  let release: (() => void) | undefined;
  try {
    for (const epoch of ['1', '2', '3']) publishEpoch(runtime, epoch);
    const address = protectStoreEpoch(runtime, resolvedStoreEpoch(dbDir, '1'));
    recordEpochClosure(runtime, runtime.paths.coral.generation.dataRoot, {
      version: 'v1',
      epochKey: address.epochKey,
      disposition: 'closed',
      dataOutcome: 'retained',
      executionDischarge: 'certified',
      obligations: [],
      reason: 'all owner obligations settled',
      observedAtMs: 1,
    });
    release = acquireSharedFileLockSync(join(address.protectedPath, '.lock'));
    const logs: string[] = [];
    const startPhase = createBackgroundPhaseObserver({
      time: { ...runtime.time, monotonicNow: () => 0n },
      log: (message) => logs.push(message),
      bootId: 'protected-lock',
      phase: 'store-epoch-sweep',
    });
    const sweep = async () => {
      const observation = startPhase();
      const result = await sweepStoreEpochsPostReady(runtime, resolvedStoreEpoch(dbDir, '3'), {
        resultsReleased: async () => true,
        observation,
      });
      observation.reportState(result === 'complete' ? null : JSON.stringify([address.epochKey, result]));
      observation.finish();
      return result;
    };
    for (let pass = 0; pass < 3; pass++) {
      expect(await sweep()).toBe('deletion-failed');
      expect(existsSync(address.protectedPath)).toBe(true);
      expect(logs).toHaveLength(1);
    }
    expect(logs[0]).not.toContain('sweep-protected-removals');
    release();
    release = undefined;
    expect(await sweep()).toBe('complete');
    expect(existsSync(address.protectedPath)).toBe(false);
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain('sweep-protected-removals');
    expect(logs[1]).toContain('cleared');
    expect(await sweep()).toBe('complete');
    expect(logs).toHaveLength(2);
  } finally {
    release?.();
    rmSync(root, { recursive: true, force: true });
  }
});
