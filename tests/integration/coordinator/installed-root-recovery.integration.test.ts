import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { strictBundleManifestSchema } from '#src/infra/bundle-manifest.js';
import { withValidatedHandoffTarget } from '#src/infra/handoff-target.js';
import {
  controllerRecoveryTarget,
  settleWithRetainedExecutor,
} from '#src/coordinator/services/retained-epoch-executor.js';
import { recordControllerOpen } from '#src/coordinator/succession/controller-open.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { encodeResolvedStoreEpoch, resolvedStoreEpoch } from '#src/store/epoch/index.js';
import { openSettledTestStoreDb } from '#tests/helpers/store-db.js';
import { createPluginFixture } from '#tests/integration/coordinator/helpers.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

it.each(['installed', 'legacy-recorded-root', 'missing', 'modified'] as const)(
  'probes and settles a crashed controller only through its recorded %s root',
  (availability) => {
    const home = mkdtempSync(join(tmpdir(), 'coral-installed-recovery-'));
    roots.push(home);
    vi.stubEnv('HOME', home);
    const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
    openSettledTestStoreDb(runtime).close();
    const epochKey = encodeResolvedStoreEpoch(runtime, resolvedStoreEpoch(runtime.paths.coral.store.dbDir, '1'));
    const plugin = createPluginFixture(roots, { flavor: 'prod' });
    const manifest = strictBundleManifestSchema.parse(
      JSON.parse(readFileSync(join(plugin.root, 'bridge', 'manifest.v2.json'), 'utf8')),
    );
    const oldCopy = join(runtime.paths.coral.generation.root, 'builds', manifest.buildSetId);
    cpSync(plugin.root, oldCopy, { recursive: true });
    const pluginRoot = availability === 'legacy-recorded-root' ? oldCopy : plugin.root;
    recordControllerOpen(runtime, epochKey, 'crashed-controller', null, pluginRoot, manifest, 0);
    if (availability === 'missing') rmSync(plugin.root, { recursive: true });
    if (availability === 'modified') writeFileSync(join(plugin.root, 'bridge', 'coral-backend.cjs'), 'modified');

    const recovered = controllerRecoveryTarget(runtime, epochKey);
    if (availability === 'missing' || availability === 'modified') {
      expect(recovered).toBeNull();
      expect(settleWithRetainedExecutor(runtime, epochKey)).toMatchObject({ kind: 'no-capable-root' });
    } else {
      expect(recovered).not.toBeNull();
      expect(withValidatedHandoffTarget(recovered!).bundleDir).toBe(join(pluginRoot, 'bridge'));
      expect(settleWithRetainedExecutor(runtime, epochKey)).toEqual({ kind: 'settled' });
    }
    expect(readFileSync(join(oldCopy, 'bridge', 'coral-backend.cjs'))).toEqual(
      readFileSync('clients/build/coral-backend.cjs'),
    );
  },
);
