import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { latestControllerOpen, recordControllerOpen } from '#src/coordinator/succession/controller-open.js';
import {
  controllerRecoveryTarget,
  parseRetainedEpochArgv,
  runRetainedEpochCommand,
  settleWithRetainedExecutor,
} from '#src/coordinator/services/retained-epoch-executor.js';
import { CURRENT_STRICT_BUNDLE_MANIFEST_FILE } from '#src/infra/bundle-manifest-address.js';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { retainedBuildRoot } from '#src/infra/retained-build-root.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Runtime } from '#src/runtime/ports.js';
import { assertBuildArtifactsAvailable, createPluginFixture } from '#tests/integration/coordinator/helpers.js';

const EPOCH_KEY = '00000000-0000-4000-8000-000000000007:7';
const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

function retainedController(): Runtime {
  assertBuildArtifactsAvailable();
  const home = mkdtempSync(join(tmpdir(), 'coral-retained-executor-'));
  tempRoots.push(home);
  const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
  const fixture = createPluginFixture(tempRoots, { flavor: 'prod' });
  const manifest = JSON.parse(
    readFileSync(join(fixture.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8'),
  ) as StrictBundleManifest;
  cpSync(fixture.root, retainedBuildRoot(runtime, manifest.buildSetId), { recursive: true });
  recordControllerOpen(runtime, EPOCH_KEY, 'retained-instance', null, fixture.root, manifest, 1);
  return runtime;
}

describe('retained-epoch executor', () => {
  it('should parse only the two retained-epoch argv shapes', () => {
    expect(parseRetainedEpochArgv(['node', 'backend', '--recover-retained-epoch', EPOCH_KEY])).toEqual({
      kind: 'recover',
      epochKey: EPOCH_KEY,
    });
    expect(parseRetainedEpochArgv(['node', 'backend', '--probe-retained-epoch', EPOCH_KEY, 'instance'])).toEqual({
      kind: 'probe',
      epochKey: EPOCH_KEY,
      instanceId: 'instance',
    });
    expect(parseRetainedEpochArgv(['node', 'backend', '--probe-retained-epoch', EPOCH_KEY])).toBeNull();
  });

  it('should report no capable root when no controller open names the epoch', () => {
    const home = mkdtempSync(join(tmpdir(), 'coral-retained-executor-'));
    tempRoots.push(home);
    const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });

    expect(settleWithRetainedExecutor(runtime, EPOCH_KEY)).toMatchObject({ kind: 'no-capable-root' });
  });

  it.each([
    [0, { kind: 'settled' }],
    [70, { kind: 'no-capable-root' }],
    [71, { kind: 'no-capable-root' }],
    [72, { kind: 'transient-failure', status: 72 }],
    [73, { kind: 'transient-failure', status: 73 }],
    [null, { kind: 'transient-failure', status: null }],
  ] as const)('should classify retained executor exit %s', (status, expected) => {
    const runtime = retainedController();
    vi.spyOn(runtime.process, 'execSync').mockReturnValue({ status, stdout: '', stderr: '' });

    expect(settleWithRetainedExecutor(runtime, EPOCH_KEY)).toMatchObject(expected);
  });

  it('should refuse as identity-unavailable in a build that cannot prove its own identity', () => {
    const createRuntime = vi.fn();
    expect(
      runRetainedEpochCommand({ kind: 'recover', epochKey: EPOCH_KEY }, createRuntime, currentCoralStoreFormat()),
    ).toBe(70);
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'the exact open proof', status: 0, proof: 'exact', target: true },
    { name: 'a proof naming another open', status: 0, proof: 'other', target: false },
    { name: 'a settled exit with no proof', status: 0, proof: 'none', target: false },
    { name: 'an unsettled epoch', status: 72, proof: 'exact', target: false },
    { name: 'no exit status', status: null, proof: 'exact', target: false },
  ] as const)('should prove a recovery target only for $name', ({ status, proof, target }) => {
    const runtime = retainedController();
    const opened = latestControllerOpen(runtime, EPOCH_KEY).latest;
    if (opened === null) throw new Error('fixture recorded no controller open');
    const exact = `${JSON.stringify({
      kind: 'retained-epoch-open',
      version: 'v1',
      epochKey: EPOCH_KEY,
      instanceId: opened.instanceId,
      buildSetId: opened.build.buildSetId,
      bundleHash: opened.build.bundleHash,
    })}\n`;
    const stdout = proof === 'exact' ? exact : proof === 'other' ? exact.replace(opened.instanceId, 'other') : '';
    vi.spyOn(runtime.process, 'execSync').mockReturnValue({ status, stdout, stderr: '' });

    const recovered = controllerRecoveryTarget(runtime, EPOCH_KEY);
    if (target) expect(recovered).not.toBeNull();
    else expect(recovered).toBeNull();
  });

  it('should not probe while an unreadable open record could name a later controller', () => {
    const runtime = retainedController();
    const directory = join(
      runtime.paths.coral.coordinator.runDir,
      'controller-opens.v1',
      runtime.ids.sha256(EPOCH_KEY),
    );
    writeFileSync(join(directory, '9999999999999-corrupt.json'), '{"version":');
    const execSync = vi.spyOn(runtime.process, 'execSync');

    expect(controllerRecoveryTarget(runtime, EPOCH_KEY)).toBeNull();
    expect(execSync).not.toHaveBeenCalled();
  });
});
