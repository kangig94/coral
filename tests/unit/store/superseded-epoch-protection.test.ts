import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';
import {
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
});
