import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import {
  encodeResolvedStoreEpoch,
  epochDirectory,
  inspectCurrentStore,
  mintRetiredStoreEpoch,
  settleStoreEpoch,
} from '#src/store/epoch/index.js';
import { protectStoreEpoch } from '#src/store/epoch/index.js';
import {
  joinSuccessionWriterGeneration,
  observeSuccessionWriterGeneration,
  refuseSuccessionAttempt,
} from '#src/store/succession-writer-generation.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { authorizeFixtureStoreMint } from '#tests/helpers/store-db.js';
// @ts-expect-error -- JavaScript hook reader intentionally has no TypeScript declaration.
import { resolveCurrentStoreDbPath } from '../../../clients/hooks/lib/store-epoch.mjs';

const roots: string[] = [];
const format = currentCoralStoreFormat();
const build = {
  version: format.productVersion,
  buildSetId: '00000000-0000-4000-8000-000000000001',
  flavor: 'prod' as const,
  storeFormatFingerprint: format.fingerprint,
  bundleHash: '0123456789abcdef',
  cliBundleHash: '0123456789abcdef',
  claudeAppserverBundleHash: '0123456789abcdef',
  durableWrapperBundleHash: '0123456789abcdef',
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Epoch 1 was reclaimed to its canonical address after the retirement attempt that minted epoch 2 failed. */
function storeWithUnservedMint(): Readonly<{ runtime: Runtime; dbDir: string }> {
  const root = mkdtempSync(join(tmpdir(), 'coral-unserved-mint-'));
  roots.push(root);
  const runtime = createRealRuntime('prod', { baseDir: root });
  const settled = settleStoreEpoch(runtime, { storeFormat: format, build, authorizeMint: authorizeFixtureStoreMint });
  settled.db.close();
  joinSuccessionWriterGeneration(runtime, settled.store);
  const dbDir = realpathSync(runtime.paths.coral.store.dbDir);
  cpSync(epochDirectory(dbDir, '1'), epochDirectory(dbDir, '2'), { recursive: true });
  writeFileSync(
    join(epochDirectory(dbDir, '2'), '.retirement-attempt.v1.json'),
    `${JSON.stringify({ version: 'v1', attemptId: 'failed-attempt' })}\n`,
  );
  return { runtime, dbDir };
}

describe('unserved retirement mint', () => {
  it('should avoid publishing an already rejected mint and discard one refused during transfer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-unserved-mint-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: root });
    const settled = settleStoreEpoch(runtime, { storeFormat: format, build, authorizeMint: authorizeFixtureStoreMint });
    settled.db.close();
    const expected = joinSuccessionWriterGeneration(runtime, settled.store).generation;
    const epochKey = encodeResolvedStoreEpoch(runtime, settled.store);
    const dbDir = realpathSync(runtime.paths.coral.store.dbDir);
    protectStoreEpoch(runtime, settled.store);
    refuseSuccessionAttempt(runtime, 'refused-before-mint');
    const newerFormat = {
      ...format,
      productVersion: '0.11.0',
      fingerprint: `sha256:${'0'.repeat(64)}` as const,
    };
    const rename = runtime.storage.renameSync;
    let published = false;
    vi.spyOn(runtime.storage, 'renameSync').mockImplementation((from, to) => {
      if (to === epochDirectory(dbDir, '2')) published = true;
      return rename(from, to);
    });

    await expect(
      mintRetiredStoreEpoch(
        runtime,
        { storeFormat: newerFormat, build },
        epochKey,
        'refused-before-mint',
        expected,
        () => {},
      ),
    ).rejects.toThrow();
    expect(published).toBe(false);
    expect(existsSync(epochDirectory(dbDir, '2'))).toBe(false);

    await expect(
      mintRetiredStoreEpoch(
        runtime,
        { storeFormat: newerFormat, build },
        epochKey,
        'refused-during-transfer',
        expected,
        () => {
          refuseSuccessionAttempt(runtime, 'refused-during-transfer');
        },
      ),
    ).rejects.toThrow();
    expect(published).toBe(true);
    expect(existsSync(epochDirectory(dbDir, '2'))).toBe(false);
  });

  it('should never be selected as the current epoch while its predecessor is back at its canonical address', () => {
    const { runtime, dbDir } = storeWithUnservedMint();

    expect(inspectCurrentStore(runtime)).toMatchObject({ kind: 'current', epoch: { epoch: '1' } });
    expect(resolveCurrentStoreDbPath(dbDir)).toBe(join(epochDirectory(dbDir, '1'), 'store.db'));
  });

  it('should leave startup on its predecessor without moving the writer generation onto it', () => {
    const { runtime, dbDir } = storeWithUnservedMint();

    const settled = settleStoreEpoch(runtime, { storeFormat: format, build, authorizeMint: authorizeFixtureStoreMint });
    settled.db.close();

    expect(settled.store.epoch).toBe('1');
    expect(observeSuccessionWriterGeneration(runtime)).toMatchObject({ storeRoot: dbDir, epoch: '1' });
  });

  it('should be the current epoch once its predecessor has left the store root', () => {
    const { runtime, dbDir } = storeWithUnservedMint();
    rmSync(epochDirectory(dbDir, '1'), { recursive: true, force: true });

    expect(inspectCurrentStore(runtime)).toMatchObject({ kind: 'current', epoch: { epoch: '2' } });
    expect(resolveCurrentStoreDbPath(dbDir)).toBe(join(epochDirectory(dbDir, '2'), 'store.db'));
  });
});
