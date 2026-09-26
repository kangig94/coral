import { join } from 'node:path';

import { probeCoordinator } from '../../infra/backend-discovery.js';
import { resolveStrictBundleIdentity, type StrictBundleManifest } from '../../infra/bundle-manifest.js';
import { createForeignTargetValidator, type ValidatedHandoffTarget } from '../../infra/handoff-target.js';
import { retainedBuildRoot } from '../../infra/retained-build-root.js';
import { seedHistoricalEpoch } from '../../jobs/historical-reader.js';
import { JobLocationIndex } from '../../jobs/location-index.js';
import type { Runtime } from '../../runtime/ports.js';
import { decodeResolvedStoreEpoch, encodeResolvedStoreEpoch, observeResolvedStoreEpoch } from '../../store/epoch.js';
import { readEpochKey } from '../../store/epoch-key.js';
import { openReadOnlyStoreDatabase } from '../../store/read-port.js';
import type { StoreFormatDescription } from '../../store/format-fingerprint.js';
import { latestControllerOpen, type ControllerOpen } from '../succession/controller-open.js';

// Shipped retained builds answer these flags and exit codes; a change needs a new flag, never a new meaning.
const PROBE_FLAG = '--probe-retained-epoch';
const RECOVER_FLAG = '--recover-retained-epoch';
const RETAINED_EPOCH_EXIT = {
  settled: 0,
  identityUnavailable: 70,
  controllerMismatch: 71,
  epochUnsettled: 72,
  coordinatorLive: 73,
} as const;
const RETAINED_EPOCH_TIMEOUT_MS = 20_000;

export type RetainedEpochCommand =
  | Readonly<{ kind: 'probe'; epochKey: string; instanceId: string }>
  | Readonly<{ kind: 'recover'; epochKey: string }>;

export type RetainedExecutorSettlement =
  | Readonly<{ kind: 'settled' }>
  | Readonly<{ kind: 'transient-failure'; status: number | null }>
  | Readonly<{ kind: 'no-capable-root'; reason: string }>;

export function parseRetainedEpochArgv(argv: readonly string[]): RetainedEpochCommand | null {
  if (argv.length === 4 && argv[2] === RECOVER_FLAG) return { kind: 'recover', epochKey: argv[3] };
  if (argv.length === 5 && argv[2] === PROBE_FLAG) return { kind: 'probe', epochKey: argv[3], instanceId: argv[4] };
  return null;
}

export function runRetainedEpochCommand(
  command: RetainedEpochCommand,
  createRuntime: (flavor: StrictBundleManifest['flavor']) => Runtime,
  storeFormat: StoreFormatDescription,
): number {
  const identity = resolveStrictBundleIdentity();
  if (!identity.ok) return RETAINED_EPOCH_EXIT.identityUnavailable;
  const runtime = createRuntime(identity.manifest.flavor);
  return command.kind === 'probe'
    ? probeRetainedEpochOpen(runtime, identity.manifest, command.epochKey, storeFormat, command.instanceId)
    : recoverRetainedEpoch(runtime, identity.manifest, command.epochKey);
}

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

function probeRetainedEpochOpen(
  runtime: Runtime,
  manifest: StrictBundleManifest,
  epochKey: string,
  storeFormat: StoreFormatDescription,
  instanceId: string,
): number {
  if (manifest.storeFormatFingerprint !== storeFormat.fingerprint) return RETAINED_EPOCH_EXIT.identityUnavailable;
  const opened = latestControllerOpen(runtime, epochKey, instanceId).latest;
  const epoch = observeResolvedStoreEpoch(runtime, epochKey);
  if (opened === null || epoch === undefined || opened.build.buildSetId !== manifest.buildSetId)
    return RETAINED_EPOCH_EXIT.controllerMismatch;
  try {
    if (epoch.lineageKey === undefined || readEpochKey(runtime, epoch) !== epoch.lineageKey)
      return RETAINED_EPOCH_EXIT.epochUnsettled;
    const db = openReadOnlyStoreDatabase(runtime, {
      storeFormat,
      resolved: { path: epoch.path, epoch, epochCandidate: true },
    });
    db.close();
    process.stdout.write(retainedEpochOpenProof(epochKey, opened));
    return RETAINED_EPOCH_EXIT.settled;
  } catch {
    return RETAINED_EPOCH_EXIT.epochUnsettled;
  }
}

function recoverRetainedEpoch(runtime: Runtime, manifest: StrictBundleManifest, epochKey: string): number {
  const coordinator = probeCoordinator(runtime);
  if (
    coordinator.kind !== 'absent' &&
    (coordinator.kind !== 'unobservable' || coordinator.reason !== 'recorded-process-absent')
  )
    return RETAINED_EPOCH_EXIT.coordinatorLive;
  const opened = latestControllerOpen(runtime, epochKey).latest;
  const epoch = decodeResolvedStoreEpoch(runtime, epochKey);
  if (
    opened === null ||
    epoch === undefined ||
    opened.build.buildSetId !== manifest.buildSetId ||
    opened.build.bundleHash !== manifest.bundleHash ||
    opened.build.storeFormatFingerprint !== manifest.storeFormatFingerprint ||
    encodeResolvedStoreEpoch(runtime, epoch) !== epochKey
  )
    return RETAINED_EPOCH_EXIT.controllerMismatch;
  const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
  const seeded = seedHistoricalEpoch(
    runtime,
    index,
    epoch,
    epochKey,
    manifest.storeFormatFingerprint,
    runtime.paths.coral.exports.jobsRoot,
    runtime.storage,
    index.locationsFor(epochKey).map((location) => ({ jobId: location.jobId, subject: location.subject })),
    true,
  );
  return seeded.kind === 'complete' && index.resultsReleased(epochKey)
    ? RETAINED_EPOCH_EXIT.settled
    : RETAINED_EPOCH_EXIT.epochUnsettled;
}

/** The target is proven only while no unreadable open record could name a later controller. */
export function controllerRecoveryTarget(
  runtime: Runtime,
  epochKey: string,
  instanceId?: string,
): ValidatedHandoffTarget | null {
  const observation = latestControllerOpen(runtime, epochKey, instanceId);
  const opened = observation.latest;
  if (opened === null || observation.unreadable.length > 0) return null;
  const root = retainedBuildRoot(runtime, opened.build.buildSetId);
  const validated = createForeignTargetValidator()(join(root, 'bridge'), opened.build);
  if (validated.kind !== 'validated') return null;
  const probe = runtime.process.execSync(
    process.execPath,
    [join(root, 'bridge', 'coral-backend.cjs'), PROBE_FLAG, epochKey, opened.instanceId],
    { timeout: RETAINED_EPOCH_TIMEOUT_MS, encoding: 'utf-8', inheritEnv: true },
  );
  return probe.status === RETAINED_EPOCH_EXIT.settled && probe.stdout === retainedEpochOpenProof(epochKey, opened)
    ? validated.target
    : null;
}

/**
 * Only an executor that cannot identify itself as the epoch's controller is `no-capable-root`; a live coordinator,
 * a timeout, or an unsettled seeding may pass on a later startup and must stay under bounded patience.
 */
export function settleWithRetainedExecutor(runtime: Runtime, epochKey: string): RetainedExecutorSettlement {
  const opened = latestControllerOpen(runtime, epochKey).latest;
  if (opened === null) return { kind: 'no-capable-root', reason: 'no readable controller open names the epoch' };
  const root = retainedBuildRoot(runtime, opened.build.buildSetId);
  const validated = createForeignTargetValidator()(join(root, 'bridge'), opened.build);
  if (validated.kind !== 'validated')
    return { kind: 'no-capable-root', reason: 'retained build root does not validate' };
  const result = runtime.process.execSync(
    process.execPath,
    [join(root, 'bridge', 'coral-backend.cjs'), RECOVER_FLAG, epochKey],
    { timeout: RETAINED_EPOCH_TIMEOUT_MS, inheritEnv: true },
  );
  switch (result.status) {
    case RETAINED_EPOCH_EXIT.settled:
      return { kind: 'settled' };
    case RETAINED_EPOCH_EXIT.identityUnavailable:
    case RETAINED_EPOCH_EXIT.controllerMismatch:
      return { kind: 'no-capable-root', reason: `retained executor refused with exit ${result.status}` };
    default:
      return { kind: 'transient-failure', status: result.status };
  }
}
