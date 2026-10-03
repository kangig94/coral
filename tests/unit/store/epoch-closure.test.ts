import type * as MockedFsLockModule from '#src/infra/fs-lock.js';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { recordEpochClosure, observeEpochClosure } from '#src/store/epoch/index.js';
import { readOrCreateEpochKey } from '#src/store/epoch/index.js';
import {
  encodeResolvedStoreEpoch,
  epochDirectory,
  epochPath,
  resolvedStoreEpoch,
  storeEpochLockPath,
  sweepStoreEpochsPostReady,
} from '#src/store/epoch/index.js';
import { openTestStoreDatabase } from '#tests/helpers/store-db.js';

vi.mock('#src/infra/fs-lock.js', async (loadOriginal) => ({
  ...(await loadOriginal<typeof MockedFsLockModule>()),
  attemptExclusiveFileLockSync: vi.fn(() => ({ kind: 'acquired', lease: vi.fn() })),
}));

const roots: string[] = [];
const storeFormat = currentCoralStoreFormat();
const build = {
  version: storeFormat.productVersion,
  buildSetId: '123e4567-e89b-42d3-a456-426614174000',
  bundleHash: '0123456789abcdef',
  cliBundleHash: '0123456789abcdef',
  claudeAppserverBundleHash: '0123456789abcdef',
  durableWrapperBundleHash: '0123456789abcdef',
  flavor: 'prod' as const,
  storeFormatFingerprint: storeFormat.fingerprint,
};

function harness(): Runtime {
  const baseDir = mkdtempSync(join(tmpdir(), 'coral-epoch-closure-'));
  roots.push(baseDir);
  return createRealRuntime('prod', { baseDir });
}

function publish(runtime: Runtime, epoch: string, publishedAt = '2026-09-25T00:00:00.000Z'): void {
  const root = runtime.paths.coral.store.dbDir;
  const directory = epochDirectory(root, epoch);
  mkdirSync(directory, { recursive: true });
  writeFileSync(storeEpochLockPath(root, epoch), '');
  openTestStoreDatabase({ path: epochPath(root, epoch), storage: runtime.storage, storeFormat }).close();
  writeFileSync(
    join(directory, 'epoch.json'),
    JSON.stringify({
      supersedes: null,
      classification: { kind: 'absent' },
      build,
      publishedAt,
    }),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('epoch closure reclamation', () => {
  it('retains an uncertified epoch even after historical results are released', async () => {
    const runtime = harness();
    const root = runtime.paths.coral.store.dbDir;
    for (const epoch of ['1', '2', '3']) publish(runtime, epoch);

    await sweepStoreEpochsPostReady(runtime, resolvedStoreEpoch(root, '3'), { resultsReleased: () => true });

    expect(existsSync(epochDirectory(root, '1'))).toBe(true);
    expect(existsSync(epochDirectory(root, '3'))).toBe(true);
  });

  it('reclaims a certified closed epoch with released historical results', async () => {
    const runtime = harness();
    const root = runtime.paths.coral.store.dbDir;
    for (const epoch of ['1', '2', '3']) publish(runtime, epoch);
    const old = resolvedStoreEpoch(root, '1');
    const key = readOrCreateEpochKey(runtime, old);
    const jobKey = encodeResolvedStoreEpoch(runtime, old);
    const stateRoot = runtime.paths.coral.generation.dataRoot;
    recordEpochClosure(runtime, stateRoot, {
      version: 'v1',
      epochKey: key,
      disposition: 'closed',
      dataOutcome: 'retained',
      executionDischarge: 'certified',
      obligations: [],
      reason: 'all obligations settled',
      observedAtMs: 1,
    });

    await sweepStoreEpochsPostReady(runtime, resolvedStoreEpoch(root, '3'), {
      resultsReleased: (epochKey) => epochKey === jobKey,
    });

    expect(existsSync(epochDirectory(root, '1'))).toBe(false);
    expect(existsSync(epochDirectory(root, '3'))).toBe(true);
    expect(existsSync(join(stateRoot, 'epoch-closure.v1'))).toBe(true);
  });
});

it('retains an unsafe closure timestamp as unreadable', () => {
  const runtime = harness();
  const stateRoot = runtime.paths.coral.generation.dataRoot;
  const evidence = {
    version: 'v1' as const,
    epochKey: 'lineage:1',
    disposition: 'closed' as const,
    dataOutcome: 'retained' as const,
    executionDischarge: 'certified' as const,
    obligations: [],
    reason: 'settled',
    observedAtMs: 1,
  };
  recordEpochClosure(runtime, stateRoot, evidence);
  const path = join(stateRoot, 'epoch-closure.v1', `${runtime.ids.sha256(evidence.epochKey)}.json`);
  writeFileSync(path, JSON.stringify({ ...evidence, observedAtMs: Number.MAX_SAFE_INTEGER + 1 }));
  expect(observeEpochClosure(runtime, stateRoot, evidence.epochKey).kind).toBe('unreadable');
});
