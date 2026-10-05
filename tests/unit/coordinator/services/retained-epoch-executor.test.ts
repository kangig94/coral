import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#src/coordinator/succession/controller-open.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return { ...original, latestControllerOpen: vi.fn() };
});

vi.mock('#src/infra/handoff-target.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return { ...original, createForeignTargetValidator: vi.fn() };
});

import {
  controllerRecoveryTarget,
  parseRetainedEpochArgv,
  settleWithRetainedExecutor,
} from '#src/coordinator/services/retained-epoch-executor.js';
import { latestControllerOpen, type ControllerOpen } from '#src/coordinator/succession/controller-open.js';
import { createForeignTargetValidator, type ValidatedHandoffTarget } from '#src/infra/handoff-target.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { InMemoryStorage } from '#tools/simulation/core/memory-storage.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';

const EPOCH_KEY = 'epoch-key';
const target = { validated: true } as unknown as ValidatedHandoffTarget;
const opened: ControllerOpen = {
  version: 'v1',
  epochKey: EPOCH_KEY,
  instanceId: 'retained-instance',
  attemptId: null,
  pluginRoot: '/retained/plugin',
  build: {
    version: '0.10.12',
    buildSetId: '123e4567-e89b-42d3-a456-426614174000',
    flavor: 'prod',
    storeFormatFingerprint: 'sha256:format',
    bundleHash: '0123456789abcdef',
    cliBundleHash: '0123456789abcdef',
    claudeAppserverBundleHash: '0123456789abcdef',
    durableWrapperBundleHash: '0123456789abcdef',
  },
  controlGeneration: 1,
  openedAtMs: 1,
};
const openProof = `${JSON.stringify({
  kind: 'retained-epoch-open',
  version: 'v1',
  epochKey: EPOCH_KEY,
  instanceId: opened.instanceId,
  buildSetId: opened.build.buildSetId,
  bundleHash: opened.build.bundleHash,
})}\n`;

let runtime: Runtime;

beforeEach(() => {
  const time = new VirtualTime();
  const real = createRealRuntime('prod', { baseDir: '/coral-retained-executor' });
  runtime = { ...real, time, storage: new InMemoryStorage(time), process: { ...real.process, execSync: vi.fn() } };
  vi.mocked(latestControllerOpen).mockReturnValue({ latest: opened, unreadable: [] });
  vi.mocked(createForeignTargetValidator).mockReturnValue(() => ({ kind: 'validated', target }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('retained-epoch-executor', () => {
  describe('parseRetainedEpochArgv', () => {
    it('should parse exactly the recover and probe shapes a shipped retained build answers', () => {
      expect(parseRetainedEpochArgv(['node', 'backend', '--recover-retained-epoch', EPOCH_KEY])).toEqual({
        kind: 'recover',
        epochKey: EPOCH_KEY,
      });
      expect(parseRetainedEpochArgv(['node', 'backend', '--probe-retained-epoch', EPOCH_KEY, 'instance'])).toEqual({
        kind: 'probe',
        epochKey: EPOCH_KEY,
        instanceId: 'instance',
      });
    });
  });

  describe('settleWithRetainedExecutor', () => {
    it.each([
      [0, { kind: 'settled' }],
      [70, { kind: 'no-capable-root', reason: 'retained executor refused with exit 70' }],
      [72, { kind: 'transient-failure', status: 72 }],
    ] as const)('should read executor exit %s as %j', (status, settlement) => {
      const execSync = vi.spyOn(runtime.process, 'execSync').mockReturnValue({ status, stdout: '', stderr: '' });

      expect(settleWithRetainedExecutor(runtime, EPOCH_KEY)).toEqual(settlement);
      expect(execSync.mock.calls[0]?.[1]).toEqual([
        `${opened.pluginRoot}/bridge/coral-backend.cjs`,
        '--recover-retained-epoch',
        EPOCH_KEY,
      ]);
    });
  });

  it.each(['/installed/plugin', '/coral-retained-executor/gen2/builds/legacy-build'])(
    'validates the recorded literal root %s without deriving a copy location',
    (pluginRoot) => {
      vi.mocked(latestControllerOpen).mockReturnValue({ latest: { ...opened, pluginRoot }, unreadable: [] });
      const validate = vi.fn(() => ({ kind: 'validated' as const, target }));
      vi.mocked(createForeignTargetValidator).mockReturnValue(validate);
      vi.mocked(runtime.process.execSync).mockReturnValue({ status: 0, stdout: openProof, stderr: '' });
      expect(controllerRecoveryTarget(runtime, EPOCH_KEY)).toBe(target);
      expect(settleWithRetainedExecutor(runtime, EPOCH_KEY)).toEqual({ kind: 'settled' });
      expect(validate.mock.calls).toEqual([
        [`${pluginRoot}/bridge`, opened.build],
        [`${pluginRoot}/bridge`, opened.build],
      ]);
    },
  );

  it('refuses recovery and settlement when the recorded install no longer validates', () => {
    vi.mocked(createForeignTargetValidator).mockReturnValue(() => ({
      kind: 'invalid',
      evidence: { bundleDir: opened.pluginRoot, expectedManifest: opened.build, failure: 'bundle-dir-unavailable' },
    }));
    expect(controllerRecoveryTarget(runtime, EPOCH_KEY)).toBeNull();
    expect(settleWithRetainedExecutor(runtime, EPOCH_KEY)).toEqual({
      kind: 'no-capable-root',
      reason: 'installed build root does not validate',
    });
    expect(runtime.process.execSync).not.toHaveBeenCalled();
  });

  describe('controllerRecoveryTarget', () => {
    it('should prove the target only when the probe returns the exact open proof', () => {
      vi.spyOn(runtime.process, 'execSync').mockReturnValue({ status: 0, stdout: openProof, stderr: '' });

      expect(controllerRecoveryTarget(runtime, EPOCH_KEY)).toBe(target);
      expect(vi.mocked(runtime.process.execSync).mock.calls[0]?.[1]).toEqual([
        `${opened.pluginRoot}/bridge/coral-backend.cjs`,
        '--probe-retained-epoch',
        EPOCH_KEY,
        opened.instanceId,
      ]);
    });

    it('should refuse a target while an unreadable open record could name a later controller', () => {
      vi.mocked(latestControllerOpen).mockReturnValue({ latest: opened, unreadable: ['controller-opens.v1/later'] });
      const execSync = vi
        .spyOn(runtime.process, 'execSync')
        .mockReturnValue({ status: 0, stdout: openProof, stderr: '' });

      expect(controllerRecoveryTarget(runtime, EPOCH_KEY)).toBeNull();
      expect(execSync).not.toHaveBeenCalled();
    });
  });
});
