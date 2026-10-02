import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const roots: string[] = [];
let runtime: Runtime;

beforeEach(() => {
  const baseDir = mkdtempSync(join(tmpdir(), 'coral-retained-executor-'));
  roots.push(baseDir);
  runtime = createRealRuntime('prod', { baseDir });
  vi.mocked(latestControllerOpen).mockReturnValue({ latest: opened, unreadable: [] });
  vi.mocked(createForeignTargetValidator).mockReturnValue(() => ({ kind: 'validated', target }));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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

    it.each([
      [['node', 'backend']],
      [['node', 'backend', '--recover-retained-epoch']],
      [['node', 'backend', '--recover-retained-epoch', EPOCH_KEY, 'extra']],
      [['node', 'backend', '--probe-retained-epoch', EPOCH_KEY]],
      [['node', 'backend', '--probe-retained-epoch', EPOCH_KEY, 'instance', 'extra']],
      [['node', 'backend', '--retained-epoch', EPOCH_KEY]],
    ])('should refuse %j instead of guessing a command', (argv) => {
      expect(parseRetainedEpochArgv(argv)).toBeNull();
    });
  });

  describe('settleWithRetainedExecutor', () => {
    it.each([
      [0, { kind: 'settled' }],
      [70, { kind: 'no-capable-root', reason: 'retained executor refused with exit 70' }],
      [71, { kind: 'no-capable-root', reason: 'retained executor refused with exit 71' }],
      [72, { kind: 'transient-failure', status: 72 }],
      [73, { kind: 'transient-failure', status: 73 }],
      [null, { kind: 'transient-failure', status: null }],
    ] as const)('should read executor exit %s as %j', (status, settlement) => {
      const execSync = vi.spyOn(runtime.process, 'execSync').mockReturnValue({ status, stdout: '', stderr: '' });

      expect(settleWithRetainedExecutor(runtime, EPOCH_KEY)).toEqual(settlement);
      expect(execSync.mock.calls[0]?.[1]).toEqual([
        expect.stringMatching(/coral-backend\.cjs$/u) as unknown,
        '--recover-retained-epoch',
        EPOCH_KEY,
      ]);
    });
  });

  describe('controllerRecoveryTarget', () => {
    it('should prove the target only when the probe returns the exact open proof', () => {
      vi.spyOn(runtime.process, 'execSync').mockReturnValue({ status: 0, stdout: openProof, stderr: '' });

      expect(controllerRecoveryTarget(runtime, EPOCH_KEY)).toBe(target);
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
