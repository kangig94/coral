import { dirname, join } from 'node:path';

import type { ValidatedHandoffTarget } from '../../infra/handoff-target.js';
import { observeRecordedContainment } from '../../infra/process-containment.js';
import { seedHistoricalEpoch } from '../../jobs/historical-reader.js';
import type { JobLocationIndex } from '../../jobs/location-index.js';
import type { Runtime } from '../../runtime/ports.js';
import { readCustodyLedger } from '../../store/custody-ledger.js';
import { classifyStoreFile } from '../../store/db.js';
import {
  decodeResolvedStoreEpoch, encodeResolvedStoreEpoch, inspectCurrentStore, listStoreEpochs,
  type StoreMintDisposition, type StoreMintObservation,
} from '../../store/epoch.js';
import { readEpochClosure, recordEpochClosure } from '../../store/epoch-closure.js';
import type { StoreFormatDescription } from '../../store/format-fingerprint.js';
import { latestControllerOpen } from './controller-open.js';
import { readDurableCliControllerReceipts } from './durable-cli-transfer.js';
import { controllerRecoveryTarget, settleWithRetainedExecutor } from './retained-epoch-executor.js';

const UNOPENABLE_STARTUP_ATTEMPTS = 2;

export function prepareRetainedControllerHandoff(
  runtime: Runtime,
  index: JobLocationIndex,
  format: StoreFormatDescription,
): Readonly<{ target: ValidatedHandoffTarget; epochKey: string; compatible: boolean }> | null {
  const observed = inspectCurrentStore(runtime);
  const protectedEpochs = observed.kind === 'current' ? [] : listStoreEpochs(runtime)
    .filter((entry) => entry.role === 'protected' && entry.resolved !== null)
    .sort((left, right) => {
      const leftEpoch = BigInt(left.epoch);
      const rightEpoch = BigInt(right.epoch);
      return leftEpoch < rightEpoch ? 1 : leftEpoch > rightEpoch ? -1 : 0;
    });
  const epoch = observed.kind === 'current' ? observed.epoch : protectedEpochs[0]?.resolved;
  if (epoch === undefined || epoch === null) return null;
  if (protectedEpochs.length > 1 && protectedEpochs[0]?.epoch === protectedEpochs[1]?.epoch) return null;
  const classification = classifyStoreFile(epoch.path, runtime.storage, format);
  if (classification.kind !== 'compatible' && classification.kind !== 'older-incompatible' &&
      classification.kind !== 'newer-incompatible') return null;
  const epochKey = encodeResolvedStoreEpoch(epoch);
  const lineageKey = decodeResolvedStoreEpoch(epochKey)?.lineageKey;
  if (lineageKey === undefined) return null;
  const seeded = seedHistoricalEpoch(index, epoch, epochKey, classification.storedFingerprint,
    runtime.paths.coral.exports.jobsRoot, runtime.storage, [], false);
  if (seeded.kind !== 'uncertified') return null;
  const unresolved = index.locationsFor(epochKey).filter((location) => location.disposition !== 'terminal');
  if (unresolved.length === 0) return null;
  const controller = latestControllerOpen(runtime, epochKey);
  const receipts = readDurableCliControllerReceipts(runtime.paths.coral.coordinator.runDir);
  if (controller === null || receipts === null) return null;
  const custody = readCustodyLedger(runtime.paths.coral.coordinator.runDir);
  const allControlled = unresolved.every((location) => {
    const latest = receipts.filter((receipt) => receipt.jobId === location.jobId &&
      receipt.epochKey === epochKey).sort((left, right) =>
      right.controlGeneration - left.controlGeneration || right.acknowledgedAtMs - left.acknowledgedAtMs)[0];
    const controlled = latest === undefined
      ? location.controller?.buildSetId === controller.build.buildSetId &&
        location.controller.instanceId === controller.instanceId &&
        location.controller.controlGeneration <= controller.controlGeneration
      : latest.controllerBuildSetId === controller.build.buildSetId &&
        latest.controllerInstanceId === controller.instanceId &&
        latest.controlGeneration === controller.controlGeneration;
    if (!controlled) return false;
    return custody.some((entry) => {
      if (entry.kind !== 'bound' || entry.intent.epochKey !== lineageKey ||
          (entry.intent.jobId ?? entry.intent.operationId) !== location.jobId ||
          entry.binding.process === null) return false;
      const process = entry.binding.process;
      return observeRecordedContainment(
        { pid: process.pid, incarnation: process.incarnation, processGroupId: process.processGroupId, childRoot: null },
        {
          process: runtime.process,
          platform: runtime.env.platform() as NodeJS.Platform,
          readProcessIncarnation: (pid, platform) => runtime.process.readProcessIncarnation(pid, platform),
        },
      ).kind === 'alive';
    });
  });
  const target = allControlled ? controllerRecoveryTarget(runtime, epochKey) : null;
  return target === null ? null : { target, epochKey, compatible: classification.kind === 'compatible' };
}

export function createStartupMintAuthorizer(
  runtime: Runtime,
  index: JobLocationIndex,
  startupId: string,
): (observation: StoreMintObservation) => StoreMintDisposition | null {
  return (observation) => {
    for (const historical of listStoreEpochs(runtime)) {
      if (historical.role !== 'protected' || historical.resolved === null ||
          historical.epochKey === null || historical.epochKey === undefined) continue;
      const historicalKey = encodeResolvedStoreEpoch(historical.resolved);
      if (readEpochClosure(runtime.paths.coral.generation.dataRoot, historical.epochKey)?.disposition ===
          'unrecoverable-retained') continue;
      const fingerprint = historical.epochJson.kind === 'valid'
        ? historical.epochJson.value.build.storeFormatFingerprint : '';
      seedHistoricalEpoch(index, historical.resolved, historicalKey, fingerprint,
        runtime.paths.coral.exports.jobsRoot, runtime.storage);
    }
    const incumbent = observation.incumbent;
    if (incumbent === null) {
      return observation.observedEpochCount === 0 ? { kind: 'initial', incumbentEpochKey: null } : null;
    }
    const epochKey = encodeResolvedStoreEpoch(incumbent);
    const lineageKey = decodeResolvedStoreEpoch(epochKey)?.lineageKey;
    if (lineageKey === undefined) return null;
    const fingerprint = 'storedFingerprint' in observation.classification &&
      typeof observation.classification.storedFingerprint === 'string'
      ? observation.classification.storedFingerprint : '';
    const knownJobs = index.locationsFor(epochKey).map((location) => ({
      jobId: location.jobId, subject: location.subject,
    }));
    const priorController = latestControllerOpen(runtime, epochKey);
    const needsRetainedExecutor = priorController !== null && !index.resultsReleased(epochKey);
    const executorSettled = !needsRetainedExecutor || settleWithRetainedExecutor(runtime, epochKey);
    const seeded = seedHistoricalEpoch(
      index, incumbent, epochKey, fingerprint, runtime.paths.coral.exports.jobsRoot,
      runtime.storage, knownJobs, executorSettled,
    );
    if (!executorSettled) {
      index.holdUnknownLocations(epochKey, 'retained-controller-recovery-unavailable');
      for (const location of index.locationsFor(epochKey)) index.markUncertified(location.jobId);
    }
    let custodySettled = false;
    try {
      const custody = readCustodyLedger(runtime.paths.coral.coordinator.runDir);
      const matching = custody.filter((entry) => entry.kind === 'unreadable' ||
        entry.intent.epochKey === lineageKey ||
        entry.intent.epoch === dirname(incumbent.path));
      custodySettled = matching.every((entry) => {
        if (entry.kind === 'absent') return true;
        if (entry.kind !== 'bound') return false;
        const jobId = entry.intent.jobId ?? entry.intent.operationId;
        if (entry.intent.effect === 'provider-operation-publication') {
          return index.read(jobId)?.disposition === 'terminal';
        }
        const process = entry.binding.process;
        if (process === null || (entry.intent.owner === 'durable-cli' &&
            index.read(jobId)?.disposition !== 'terminal')) return false;
        return observeRecordedContainment(
          { pid: process.pid, incarnation: process.incarnation, processGroupId: process.processGroupId, childRoot: null },
          {
            process: runtime.process,
            platform: runtime.env.platform() as NodeJS.Platform,
            readProcessIncarnation: (pid, platform) => runtime.process.readProcessIncarnation(pid, platform),
          },
        ).kind === 'absent';
      });
    } catch { custodySettled = false; }
    if (executorSettled && seeded.kind === 'complete' && custodySettled && index.resultsReleased(epochKey)) {
      return { kind: 'retired', incumbentEpochKey: epochKey };
    }
    const liveHistory = seeded.kind === 'unrecoverable-retained' &&
      seeded.reason === 'known-jobs-unresolved';
    const attemptsPath = join(
      runtime.paths.coral.coordinator.runDir, 'retirement-patience.v1',
      `${Buffer.from(epochKey).toString('base64url')}.json`,
    );
    let previous: { startupId: string; attempts: number } | null = null;
    try {
      const raw = JSON.parse(runtime.storage.readFileSync(attemptsPath, 'utf8') as string) as unknown;
      if (typeof raw === 'object' && raw !== null && 'startupId' in raw && 'attempts' in raw &&
          typeof raw.startupId === 'string' && typeof raw.attempts === 'number') {
        previous = { startupId: raw.startupId, attempts: raw.attempts };
      }
    } catch {}
    const attempts = previous?.startupId === startupId ? previous.attempts : (previous?.attempts ?? 0) + 1;
    runtime.storage.mkdirSync(dirname(attemptsPath), { recursive: true, mode: 0o700 });
    if (!runtime.storage.writeAtomicDurableSync(attemptsPath, `${JSON.stringify({ startupId, attempts })}\n`, {
      encoding: 'utf8', mode: 0o600,
    })) throw new Error('Retirement patience could not be recorded durably.');
    if (!liveHistory && attempts < UNOPENABLE_STARTUP_ATTEMPTS) return null;
    recordEpochClosure(runtime.paths.coral.generation.dataRoot, {
      version: 'v1', epochKey: lineageKey, disposition: 'unrecoverable-retained',
      dataOutcome: index.resultsReleased(epochKey) ? 'retained' : 'unreadable',
      executionDischarge: 'undecidable', obligations: [],
      reason: seeded.kind === 'unrecoverable-retained' ? seeded.reason : 'custody remains unresolved',
      observedAtMs: runtime.time.now(),
    });
    return { kind: 'unopenable', incumbentEpochKey: epochKey };
  };
}
