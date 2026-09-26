import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createStartupMintAuthorizer } from '#src/coordinator/services/startup-retirement.js';
import { recordControllerOpen } from '#src/coordinator/succession/controller-open.js';
import { CURRENT_STRICT_BUNDLE_MANIFEST_FILE } from '#src/infra/bundle-manifest-address.js';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { retainedBuildRoot } from '#src/infra/retained-build-root.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import {
  encodeResolvedStoreEpoch,
  settleStoreEpoch,
  type StoreMintDisposition,
  type StoreMintObservation,
} from '#src/store/epoch.js';
import { openSettledTestStoreDb } from '#tests/helpers/store-db.js';
import { assertBuildArtifactsAvailable, createPluginFixture } from '#tests/integration/coordinator/helpers.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

const homes: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function unreadableEpochRuntime(): Runtime {
  const home = mkdtempSync(join(tmpdir(), 'coral-startup-retirement-'));
  homes.push(home);
  const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
  const db = openSettledTestStoreDb(runtime);
  const path = db.location();
  db.close();
  if (path === null) throw new Error('Settled test store has no path.');
  const unreadable = newRawDatabase(path);
  unreadable.exec(`UPDATE meta SET value = 'sha256:${'0'.repeat(64)}' WHERE key = 'store_format_fingerprint'`);
  unreadable.close();
  return runtime;
}

function startUp(
  runtime: Runtime,
  index: JobLocationIndex,
  startupId: string,
  beforeAuthorize: (observation: StoreMintObservation) => void = () => {},
): StoreMintDisposition | null {
  const authorize = createStartupMintAuthorizer(runtime, index, startupId);
  let disposition: StoreMintDisposition | null = null;
  const storeFormat = currentCoralStoreFormat();
  try {
    settleStoreEpoch(runtime, {
      storeFormat,
      build: {
        version: storeFormat.productVersion,
        buildSetId: '123e4567-e89b-42d3-a456-426614174000',
        bundleHash: '0123456789abcdef',
        cliBundleHash: '0123456789abcdef',
        claudeAppserverBundleHash: '0123456789abcdef',
        durableWrapperBundleHash: '0123456789abcdef',
        flavor: runtime.flavor,
        storeFormatFingerprint: storeFormat.fingerprint,
      },
      authorizeMint: (observation) => {
        beforeAuthorize(observation);
        disposition = authorize(observation);
        return disposition;
      },
    }).db.close();
  } catch {
    // A refused mint leaves the startup unserved; the disposition it was refused on is what is asserted.
  }
  return disposition;
}

describe('startup mint authorizer', () => {
  it('should mint over an unreadable epoch on the first startup when nothing records work against it', () => {
    const runtime = unreadableEpochRuntime();
    const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);

    expect(startUp(runtime, index, 'startup-1')).toMatchObject({ kind: 'unopenable' });
  });

  it('should keep two-startup patience when a job location names the unreadable epoch', () => {
    const runtime = unreadableEpochRuntime();
    const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
    const registerJob = (observation: StoreMintObservation): void => {
      if (observation.incumbent === null) throw new Error('Expected the unreadable epoch as incumbent.');
      index.register('job-in-unreadable-epoch', encodeResolvedStoreEpoch(runtime, observation.incumbent), {
        projectRoot: '/workspace/project',
        workDir: '/workspace/project',
        jobKind: 'provider',
      });
    };

    expect(startUp(runtime, index, 'startup-1', registerJob)).toBeNull();
    expect(startUp(runtime, index, 'startup-2')).toMatchObject({ kind: 'unopenable' });
  });

  it.each([
    ['a transient executor failure waits out bounded patience', 73, [null, 'unopenable']],
    ['an executor that cannot identify as the controller mints at once', 71, ['unopenable']],
  ] as const)('should treat %s', (_label, executorExit, dispositions) => {
    assertBuildArtifactsAvailable();
    const runtime = unreadableEpochRuntime();
    const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
    const fixture = createPluginFixture(homes, { flavor: 'prod' });
    const manifest = JSON.parse(
      readFileSync(join(fixture.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8'),
    ) as StrictBundleManifest;
    cpSync(fixture.root, retainedBuildRoot(runtime, manifest.buildSetId), { recursive: true });
    vi.spyOn(runtime.process, 'execSync').mockReturnValue({ status: executorExit, stdout: '', stderr: '' });
    const liveJobUnderRetainedController = (observation: StoreMintObservation): void => {
      if (observation.incumbent === null) throw new Error('Expected the unreadable epoch as incumbent.');
      const epochKey = encodeResolvedStoreEpoch(runtime, observation.incumbent);
      index.register('live-job', epochKey, {
        projectRoot: '/workspace/project',
        workDir: '/workspace/project',
        jobKind: 'provider',
      });
      recordControllerOpen(runtime, epochKey, 'retained-instance', null, fixture.root, manifest, 1);
    };

    expect(startUp(runtime, index, 'startup-1', liveJobUnderRetainedController)?.kind ?? null).toBe(dispositions[0]);
    if (dispositions.length > 1) {
      expect(startUp(runtime, index, 'startup-2')?.kind ?? null).toBe(dispositions[1]);
    }
  });
});
