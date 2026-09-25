import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { resolveStrictBundleIdentity } from '../../infra/bundle-manifest.js';
import { probeCoordinator } from '../../infra/backend-discovery.js';
import { createForeignTargetValidator, type ValidatedHandoffTarget } from '../../infra/handoff-target.js';
import { retainedBuildRoot } from '../../infra/retained-build-root.js';
import { seedHistoricalEpoch } from '../../jobs/historical-reader.js';
import { JobLocationIndex } from '../../jobs/location-index.js';
import { createRealRuntime } from '../../runtime/real.js';
import type { Runtime } from '../../runtime/ports.js';
import { decodeResolvedStoreEpoch, encodeResolvedStoreEpoch, observeResolvedStoreEpoch } from '../../store/epoch.js';
import { readEpochKey } from '../../store/epoch-key.js';
import { openReadOnlyStoreDatabase } from '../../store/read-port.js';
import { currentCoralStoreFormat } from '../../store-format.js';
import { latestControllerOpen, type ControllerOpen } from './controller-open.js';

function retainedEpochOpenProof(epochKey: string, opened: ControllerOpen): string {
  return `${JSON.stringify({
    kind: 'retained-epoch-open', version: 'v1', epochKey, instanceId: opened.instanceId,
    buildSetId: opened.build.buildSetId, bundleHash: opened.build.bundleHash,
  })}\n`;
}

export function runRetainedEpochRecovery(epochKey: string): number {
  const identity = resolveStrictBundleIdentity();
  if (!identity.ok) return 70;
  const runtime = createRealRuntime(identity.manifest.flavor);
  const coordinator = probeCoordinator(runtime);
  if (coordinator.kind !== 'absent' &&
      (coordinator.kind !== 'unobservable' || coordinator.reason !== 'recorded-process-absent')) return 73;
  const opened = latestControllerOpen(runtime, epochKey);
  const epoch = decodeResolvedStoreEpoch(epochKey);
  if (opened === null || epoch === undefined ||
      opened.build.buildSetId !== identity.manifest.buildSetId ||
      opened.build.bundleHash !== identity.manifest.bundleHash ||
      opened.build.storeFormatFingerprint !== identity.manifest.storeFormatFingerprint ||
      encodeResolvedStoreEpoch(epoch) !== epochKey) return 71;
  const index = new JobLocationIndex(runtime.paths.coral.generation.dataRoot);
  const seeded = seedHistoricalEpoch(
    index, epoch, epochKey, identity.manifest.storeFormatFingerprint,
    runtime.paths.coral.exports.jobsRoot, runtime.storage,
    index.locationsFor(epochKey).map((location) => ({ jobId: location.jobId, subject: location.subject })), true,
  );
  return seeded.kind === 'complete' && index.resultsReleased(epochKey) ? 0 : 72;
}

export function probeRetainedEpochOpen(epochKey: string, instanceId?: string): number {
  const identity = resolveStrictBundleIdentity();
  if (!identity.ok || identity.manifest.storeFormatFingerprint !== currentCoralStoreFormat().fingerprint) return 70;
  const runtime = createRealRuntime(identity.manifest.flavor);
  const opened = latestControllerOpen(runtime, epochKey, instanceId);
  const epoch = observeResolvedStoreEpoch(epochKey);
  if (opened === null || epoch === undefined || opened.build.buildSetId !== identity.manifest.buildSetId) return 71;
  try {
    if (epoch.lineageKey === undefined || readEpochKey(epoch) !== epoch.lineageKey) return 72;
    const db = openReadOnlyStoreDatabase(runtime, {
      storeFormat: currentCoralStoreFormat(),
      resolved: { path: epoch.path, epoch, epochCandidate: true },
    });
    db.close();
    process.stdout.write(retainedEpochOpenProof(epochKey, opened));
    return 0;
  } catch { return 72; }
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
  const probe = spawnSync(process.execPath, [join(root, 'bridge', 'coral-backend.cjs'),
    '--probe-retained-epoch', epochKey, opened.instanceId],
  { timeout: 20_000, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return probe.status === 0 && probe.stdout === retainedEpochOpenProof(epochKey, opened)
    ? validated.target : null;
}

export function settleWithRetainedExecutor(runtime: Runtime, epochKey: string): boolean {
  const opened = latestControllerOpen(runtime, epochKey);
  if (opened === null) return false;
  const root = retainedBuildRoot(runtime, opened.build.buildSetId);
  const validated = createForeignTargetValidator()(join(root, 'bridge'), opened.build);
  if (validated.kind !== 'validated') return false;
  const result = spawnSync(process.execPath, [join(root, 'bridge', 'coral-backend.cjs'),
    '--recover-retained-epoch', epochKey], { timeout: 20_000, env: process.env, stdio: 'ignore' });
  return result.status === 0;
}
