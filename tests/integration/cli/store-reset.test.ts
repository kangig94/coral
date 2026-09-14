import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { discardCurrentStoreEpoch, epochPath, settleStoreEpoch } from '#src/store/epoch.js';
import { releaseStoreReset } from '#src/store/operator-store-reset.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { openTestStoreDatabase } from '#tests/helpers/store-db.js';

const roots: string[] = [];
const storeFormat = currentCoralStoreFormat();
const build: StrictBundleManifest = {
  version: storeFormat.productVersion,
  buildSetId: '123e4567-e89b-42d3-a456-426614174000',
  bundleHash: '0123456789abcdef',
  cliBundleHash: '123456789abcdef0',
  claudeAppserverBundleHash: '23456789abcdef01',
  durableWrapperBundleHash: '3456789abcdef012',
  flavor: 'prod',
  storeFormatFingerprint: storeFormat.fingerprint,
};

function harness() {
  const baseDir = mkdtempSync(join(tmpdir(), 'coral-store-reset-cli-'));
  roots.push(baseDir);
  return createRealRuntime('prod', { baseDir });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('store-reset operator epochs', () => {
  it('refuses only the current epoch', async () => {
    const runtime = harness();
    const opened = settleStoreEpoch(runtime, { storeFormat, build });
    opened.db.close();

    await expect(releaseStoreReset({ target: 'gen2', runtime, epoch: 0 })).resolves.toMatchObject({
      kind: 'current',
      epoch: 0,
    });
  });

  it('releases a preserved epoch and reports an absent epoch', async () => {
    const runtime = harness();
    const flat = epochPath(runtime.paths.coral.store.dbDir, 0);
    openTestStoreDatabase({ path: flat, storage: runtime.storage, storeFormat }).close();
    const discarded = discardCurrentStoreEpoch(runtime, { storeFormat, build });
    discarded.db.close();

    await expect(releaseStoreReset({ target: 'gen2', runtime, epoch: 0 })).resolves.toMatchObject({
      kind: 'released',
      epoch: 0,
    });
    await expect(releaseStoreReset({ target: 'gen2', runtime, epoch: 99 })).resolves.toMatchObject({
      kind: 'absent',
      epoch: 99,
    });
  });
});
