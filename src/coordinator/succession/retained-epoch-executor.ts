import { join } from 'node:path';

import { resolveStrictBundleIdentity } from '../../infra/bundle-manifest.js';
import { createForeignTargetValidator, type ValidatedHandoffTarget } from '../../infra/handoff-target.js';
import { retainedBuildRoot } from '../../infra/retained-build-root.js';
import { createRealRuntime } from '../../runtime/real.js';
import type { Runtime } from '../../runtime/ports.js';
import { observeResolvedStoreEpoch } from '../../store/epoch.js';
import { readEpochKey } from '../../store/epoch-key.js';
import { openReadOnlyStoreDatabase } from '../../store/read-port.js';
import type { StoreFormatDescription } from '../../store/format-fingerprint.js';
import { latestControllerOpen, type ControllerOpen } from './controller-open.js';

function retainedEpochOpenProof(epochKey: string, opened: ControllerOpen): string {
  return `${JSON.stringify({
    kind: 'retained-epoch-open',
    version: 'v1',
    epochKey,
    instanceId: opened.instanceId,
    buildSetId: opened.build.buildSetId,
    bundleHash: opened.build.bundleHash,
  })}\n`;
}

export function probeRetainedEpochOpen(
  epochKey: string,
  storeFormat: StoreFormatDescription,
  instanceId?: string,
): number {
  const identity = resolveStrictBundleIdentity();
  if (!identity.ok || identity.manifest.storeFormatFingerprint !== storeFormat.fingerprint) return 70;
  const runtime = createRealRuntime(identity.manifest.flavor);
  const opened = latestControllerOpen(runtime, epochKey, instanceId);
  const epoch = observeResolvedStoreEpoch(runtime, epochKey);
  if (opened === null || epoch === undefined || opened.build.buildSetId !== identity.manifest.buildSetId) return 71;
  try {
    if (epoch.lineageKey === undefined || readEpochKey(runtime, epoch) !== epoch.lineageKey) return 72;
    const db = openReadOnlyStoreDatabase(runtime, {
      storeFormat,
      resolved: { path: epoch.path, epoch, epochCandidate: true },
    });
    db.close();
    process.stdout.write(retainedEpochOpenProof(epochKey, opened));
    return 0;
  } catch {
    return 72;
  }
}

export function controllerRecoveryTarget(
  runtime: Runtime,
  epochKey: string,
  instanceId?: string,
): ValidatedHandoffTarget | null {
  const opened = latestControllerOpen(runtime, epochKey, instanceId);
  if (opened === null) return null;
  const root = retainedBuildRoot(runtime, opened.build.buildSetId);
  const validated = createForeignTargetValidator()(join(root, 'bridge'), opened.build);
  if (validated.kind !== 'validated') return null;
  const probe = runtime.process.execSync(
    process.execPath,
    [join(root, 'bridge', 'coral-backend.cjs'), '--probe-retained-epoch', epochKey, opened.instanceId],
    { timeout: 20_000, encoding: 'utf-8', inheritEnv: true },
  );
  return probe.status === 0 && probe.stdout === retainedEpochOpenProof(epochKey, opened) ? validated.target : null;
}

export function settleWithRetainedExecutor(runtime: Runtime, epochKey: string): boolean {
  const opened = latestControllerOpen(runtime, epochKey);
  if (opened === null) return false;
  const root = retainedBuildRoot(runtime, opened.build.buildSetId);
  const validated = createForeignTargetValidator()(join(root, 'bridge'), opened.build);
  if (validated.kind !== 'validated') return false;
  const result = runtime.process.execSync(
    process.execPath,
    [join(root, 'bridge', 'coral-backend.cjs'), '--recover-retained-epoch', epochKey],
    { timeout: 20_000, inheritEnv: true },
  );
  return result.status === 0;
}
