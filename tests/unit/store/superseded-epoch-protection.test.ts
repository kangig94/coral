import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';
import * as epochProtection from '#src/store/epoch-protection.js';
import {
  discardCurrentStoreEpoch,
  epochDirectory,
  listStoreEpochs,
  retirementMintDisposition,
  settleStoreEpoch,
  sweepStoreEpochsPostReady,
} from '#src/store/epoch.js';
import { createSharedFileLockSync } from '#src/infra/fs-lock.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { authorizeFixtureStoreMint } from '#tests/helpers/store-db.js';

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

describe('superseded epoch protection', () => {
  it('should protect an epoch that will not open before publishing its successor when nothing holds it', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-superseded-protection-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: root });
    const settled = settleStoreEpoch(runtime, { storeFormat: format, build, authorizeMint: authorizeFixtureStoreMint });
    settled.db.close();
    const dbDir = realpathSync(runtime.paths.coral.store.dbDir);
    const unopenable = join(epochDirectory(dbDir, '1'), 'store.db');
    chmodSync(unopenable, 0o000);

    const successor = settleStoreEpoch(runtime, {
      storeFormat: format,
      build,
      startupBusyTimeoutMs: 1,
      authorizeMint: ({ incumbent, observedEpochCount }) =>
        incumbent === null && observedEpochCount > 0 ? retirementMintDisposition('unopenable', null) : null,
    });
    successor.db.close();

    expect(successor.store.epoch).toBe('2');
    expect(existsSync(epochDirectory(dbDir, '1'))).toBe(false);
    expect(listStoreEpochs(runtime)).toContainEqual(expect.objectContaining({ epoch: '1', role: 'protected' }));
  });

  it('should publish past a superseded epoch its opener keeps holding, list it as pending, and protect it once released', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-superseded-protection-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: root });
    const settled = settleStoreEpoch(runtime, { storeFormat: format, build, authorizeMint: authorizeFixtureStoreMint });
    settled.db.close();
    const dbDir = realpathSync(runtime.paths.coral.store.dbDir);
    chmodSync(join(epochDirectory(dbDir, '1'), 'store.db'), 0o000);
    const opener = createSharedFileLockSync(join(epochDirectory(dbDir, '1'), '.lock'));
    let successor: ReturnType<typeof settleStoreEpoch>;
    try {
      successor = settleStoreEpoch(runtime, {
        storeFormat: format,
        build,
        startupBusyTimeoutMs: 1,
        authorizeMint: ({ incumbent, observedEpochCount }) =>
          incumbent === null && observedEpochCount > 0 ? retirementMintDisposition('unopenable', null) : null,
      });
      successor.db.close();

      expect(successor.store.epoch).toBe('2');
      expect(existsSync(epochDirectory(dbDir, '1'))).toBe(true);
      expect(listStoreEpochs(runtime)).toContainEqual(
        expect.objectContaining({ epoch: '1', protectionPending: expect.stringContaining('opener') as unknown }),
      );
    } finally {
      opener();
    }

    await sweepStoreEpochsPostReady(runtime, successor.store);

    expect(existsSync(epochDirectory(dbDir, '1'))).toBe(false);
    const listed = listStoreEpochs(runtime).find((entry) => entry.epoch === '1');
    expect(listed).toMatchObject({ role: 'protected' });
    expect(listed?.protectionPending).toBeUndefined();
  });

  describe('an epoch awaiting protection when a later mint meets it', () => {
    const protect = epochProtection.protectStoreEpoch;

    /** Epoch 1 stays at its canonical address, recorded as pending, behind a current epoch 2. */
    function pendingBehindCurrent(): Readonly<{ runtime: ReturnType<typeof createRealRuntime>; dbDir: string }> {
      const root = mkdtempSync(join(tmpdir(), 'coral-superseded-protection-'));
      roots.push(root);
      const runtime = createRealRuntime('prod', { baseDir: root });
      settleStoreEpoch(runtime, { storeFormat: format, build, authorizeMint: authorizeFixtureStoreMint }).db.close();
      const dbDir = realpathSync(runtime.paths.coral.store.dbDir);
      const held = vi.spyOn(epochProtection, 'protectStoreEpoch').mockImplementation((_runtime, epoch) => {
        throw new epochProtection.StoreEpochOpenerHeldError(`lineage:${epoch.epoch}`);
      });
      discardCurrentStoreEpoch(runtime, { storeFormat: format, build }).db.close();
      held.mockRestore();
      expect(listStoreEpochs(runtime)).toContainEqual(
        expect.objectContaining({ epoch: '1', protectionPending: expect.any(String) as unknown }),
      );
      return { runtime, dbDir };
    }

    it('should publish past it when another process protected it after this mint observed it', () => {
      const { runtime, dbDir } = pendingBehindCurrent();
      vi.spyOn(epochProtection, 'protectStoreEpoch').mockImplementation((...args) => {
        const [, epoch] = args;
        // The incumbent's pending-protection retry moves the epoch first.
        if (epoch.epoch === '1' && existsSync(epochDirectory(dbDir, '1'))) protect(...args);
        return protect(...args);
      });

      const minted = discardCurrentStoreEpoch(runtime, { storeFormat: format, build });
      minted.db.close();

      expect(minted.store.epoch).toBe('3');
      expect(listStoreEpochs(runtime).find((entry) => entry.epoch === '1')).toMatchObject({ role: 'protected' });
    });

    it('should publish past it when its protection keeps failing for another reason', () => {
      const { runtime } = pendingBehindCurrent();
      vi.spyOn(epochProtection, 'protectStoreEpoch').mockImplementation((...args) => {
        if (args[1].epoch === '1') throw new Error('lineage marker is unreadable');
        return protect(...args);
      });

      const minted = discardCurrentStoreEpoch(runtime, { storeFormat: format, build });
      minted.db.close();

      expect(minted.store.epoch).toBe('3');
      expect(listStoreEpochs(runtime)).toContainEqual(
        expect.objectContaining({ epoch: '1', protectionPending: 'lineage marker is unreadable' }),
      );
    });
  });
});
