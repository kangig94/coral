import { createSuccessionReconciler } from '#src/coordinator/succession/reconciler/index.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { requestedIntent } from '#src/coordinator/succession/intent-transitions.js';
import { failedAttemptRetry } from '#src/coordinator/succession/attempt-retry.js';
import { compareAndSwapUpgradeIntent, readUpgradeIntent } from '#src/infra/upgrade-intent.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import * as nodeFs from 'node:fs';
import * as bundleManifest from '#src/infra/bundle-manifest.js';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { revalidateUpgradeIntentTarget, type UpgradeIntent } from '#src/infra/upgrade-intent.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { CURRENT_STRICT_BUNDLE_MANIFEST_FILE } from '#src/infra/bundle-manifest-address.js';
import {
  createForeignTargetValidator,
  createForeignTargetObserver,
  withValidatedHandoffTarget,
} from '#src/infra/handoff-target.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof nodeFs>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync), openSync: vi.fn(actual.openSync) };
});

const roots: string[] = [];
const backendBundle = 'foreign backend fixture';
const cliBundle = 'foreign cli fixture';
const claudeAppserverBundle = 'foreign claude appserver fixture';
const durableWrapperBundle = 'foreign durable wrapper fixture';
const manifest: StrictBundleManifest = {
  version: '2.1.0',
  buildSetId: '123e4567-e89b-42d3-a456-426614174000',
  bundleHash: createHash('sha256').update(backendBundle).digest('hex').slice(0, 16),
  cliBundleHash: createHash('sha256').update(cliBundle).digest('hex').slice(0, 16),
  claudeAppserverBundleHash: createHash('sha256').update(claudeAppserverBundle).digest('hex').slice(0, 16),
  durableWrapperBundleHash: createHash('sha256').update(durableWrapperBundle).digest('hex').slice(0, 16),
  flavor: 'prod',
  storeFormatFingerprint: `sha256:${'a'.repeat(64)}`,
};

function createBundle(): string {
  const parent = mkdtempSync(join(tmpdir(), 'coral-handoff-target-'));
  roots.push(parent);
  const root = join(parent, 'bridge');
  mkdirSync(root);
  writeFileSync(join(root, 'coral-backend.cjs'), backendBundle, 'utf8');
  writeFileSync(join(root, 'coral-cli'), cliBundle, 'utf8');
  writeFileSync(join(root, 'coral-claude-appserver.cjs'), claudeAppserverBundle, 'utf8');
  writeFileSync(join(root, 'coral-durable-wrapper.cjs'), durableWrapperBundle, 'utf8');
  writeFileSync(join(root, CURRENT_STRICT_BUNDLE_MANIFEST_FILE), JSON.stringify(manifest), 'utf8');
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('handoff-target', () => {
  it.each([CURRENT_STRICT_BUNDLE_MANIFEST_FILE, 'coral-cli'])(
    'makes cutover unavailable when required artifact %s is missing from an existing bridge',
    async (file) => {
      const bundleDir = createBundle();
      const time = new VirtualTime();
      const runtime = { ...createRealRuntime('prod', { baseDir: join(dirname(bundleDir), 'coral') }), time };
      const runDir = runtime.paths.coral.coordinator.runDir;
      const incumbent = {
        instanceId: 'incumbent',
        pid: process.pid,
        incarnation: null,
        version: '0.10.25',
        bundleHash: 'old',
        flavor: 'prod' as const,
      };
      const target = { pluginRootLabel: dirname(bundleDir), build: manifest };
      const seeded = await compareAndSwapUpgradeIntent(
        runDir,
        null,
        requestedIntent({ requestId: 'upgrade', target }, incumbent, null),
      );
      if (seeded.kind !== 'written') throw new Error(seeded.kind);
      let intent = seeded.intent;
      for (let i = 0; i < 2; i++)
        intent = {
          ...intent,
          ...failedAttemptRetry(
            intent,
            { kind: 'transient', retryAfterMs: 1000, servingDeadline: true },
            'changed',
            time.now(),
          ),
        };
      expect((await compareAndSwapUpgradeIntent(runDir, intent.revision, intent)).kind).toBe('written');
      rmSync(join(bundleDir, file));
      const retire = vi.fn();
      const reconciler = createSuccessionReconciler({
        runtime,
        runDir,
        incumbent: () => incumbent,
        owners: [],
        epochKey: () => 'epoch',
        admissionRevision: () => 0,
        commitAvailable: true,
        liveJobIds: () => [],
        retireForCutover: retire,
      });
      try {
        await reconciler.reconcile();
        expect(readUpgradeIntent(runDir)).toMatchObject({ intent: { servingDeadline: { outcome: 'unavailable' } } });
        expect(retire).not.toHaveBeenCalled();
      } finally {
        reconciler.dispose();
      }
    },
  );

  it('reports a permission failure as unobservable and validates when access returns', () => {
    const bundleDir = createBundle();
    const intent = { target: { pluginRootLabel: dirname(bundleDir), build: manifest } } as UpgradeIntent;
    vi.mocked(nodeFs.lstatSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    expect(revalidateUpgradeIntentTarget(intent)).toMatchObject({
      kind: 'unobservable',
      evidence: { failure: 'bundle-dir-unavailable' },
    });
    expect(revalidateUpgradeIntentTarget(intent).kind).toBe('validated');
  });

  it.each(['EACCES', 'EIO'] as const)('keeps a bundle-open %s failure unobservable', async (code) => {
    const actual = await vi.importActual<typeof nodeFs>('node:fs');
    const bundleDir = createBundle();
    vi.mocked(nodeFs.openSync)
      .mockImplementationOnce(actual.openSync)
      .mockImplementationOnce((path) => {
        expect(path).toBe(join(bundleDir, 'coral-backend.cjs'));
        throw Object.assign(new Error(code), { code });
      });
    expect(createForeignTargetObserver()(bundleDir, manifest).kind).toBe('unobservable');
    expect(createForeignTargetObserver()(bundleDir, manifest).kind).toBe('validated');
  });

  it('reports readable mismatched bytes as conclusively invalid', () => {
    const bundleDir = createBundle();
    writeFileSync(join(bundleDir, 'coral-cli'), 'different bytes');
    expect(createForeignTargetObserver()(bundleDir, manifest)).toMatchObject({
      kind: 'invalid',
      evidence: { failure: 'adjacent-bundle-mismatch' },
    });
  });

  it('keeps a confirmed byte mismatch decisive before a later bundle becomes unreadable', () => {
    const bundleDir = createBundle();
    writeFileSync(join(bundleDir, 'coral-backend.cjs'), 'mismatched bytes');
    const observe = bundleManifest.observeStableAdjacentBundle;
    vi.spyOn(bundleManifest, 'observeStableAdjacentBundle').mockImplementation((dir, file) =>
      file === 'coral-cli' ? { kind: 'unobservable' } : observe(dir, file),
    );
    expect(createForeignTargetObserver()(bundleDir, manifest).kind).toBe('invalid');
  });

  it('should reject a byte mismatch at the final re-hash', () => {
    const bundleDir = createBundle();
    const result = createForeignTargetValidator()(bundleDir, manifest);
    expect(result.kind).toBe('validated');
    if (result.kind !== 'validated') return;
    writeFileSync(join(bundleDir, 'coral-cli'), 'changed after validation', 'utf8');

    const execution = withValidatedHandoffTarget(result.target);
    expect(() => execution.assertExecutable()).toThrow('bytes changed before execution');
  });
});
