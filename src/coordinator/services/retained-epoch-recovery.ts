import { resolveStrictBundleIdentity } from '../../infra/bundle-manifest.js';
import { probeCoordinator } from '../../infra/backend-discovery.js';
import { seedHistoricalEpoch } from '../../jobs/historical-reader.js';
import { JobLocationIndex } from '../../jobs/location-index.js';
import { createRealRuntime } from '../../runtime/real.js';
import { decodeResolvedStoreEpoch, encodeResolvedStoreEpoch } from '../../store/epoch.js';
import { latestControllerOpen } from '../succession/controller-open.js';

export function runRetainedEpochRecovery(epochKey: string): number {
  const identity = resolveStrictBundleIdentity();
  if (!identity.ok) return 70;
  const runtime = createRealRuntime(identity.manifest.flavor);
  const coordinator = probeCoordinator(runtime);
  if (
    coordinator.kind !== 'absent' &&
    (coordinator.kind !== 'unobservable' || coordinator.reason !== 'recorded-process-absent')
  )
    return 73;
  const opened = latestControllerOpen(runtime, epochKey);
  const epoch = decodeResolvedStoreEpoch(runtime, epochKey);
  if (
    opened === null ||
    epoch === undefined ||
    opened.build.buildSetId !== identity.manifest.buildSetId ||
    opened.build.bundleHash !== identity.manifest.bundleHash ||
    opened.build.storeFormatFingerprint !== identity.manifest.storeFormatFingerprint ||
    encodeResolvedStoreEpoch(runtime, epoch) !== epochKey
  )
    return 71;
  const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
  const seeded = seedHistoricalEpoch(
    runtime,
    index,
    epoch,
    epochKey,
    identity.manifest.storeFormatFingerprint,
    runtime.paths.coral.exports.jobsRoot,
    runtime.storage,
    index.locationsFor(epochKey).map((location) => ({ jobId: location.jobId, subject: location.subject })),
    true,
  );
  return seeded.kind === 'complete' && index.resultsReleased(epochKey) ? 0 : 72;
}
