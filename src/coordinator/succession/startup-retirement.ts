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
  observeResolvedStoreEpoch, observeResolvedStoreEpochKey,
  type ResolvedStoreEpoch, type StoreMintDisposition, type StoreMintObservation,
} from '../../store/epoch.js';
import { readEpochClosure, recordEpochClosure } from '../../store/epoch-closure.js';
import { readEpochKey } from '../../store/epoch-key.js';
import { observeProtectedEpoch } from '../../store/epoch-protection.js';
import type { StoreFormatDescription } from '../../store/format-fingerprint.js';
import { latestControllerOpen } from './controller-open.js';
import { readDurableCliControllerReceipts } from './durable-cli-transfer.js';
import { controllerRecoveryTarget, settleWithRetainedExecutor } from './retained-epoch-executor.js';

const UNOPENABLE_STARTUP_ATTEMPTS = 2;

export function prepareRetainedControllerHandoff(
  runtime: Runtime,
  index: JobLocationIndex,
  format: StoreFormatDescription,
): Readonly<{ target: ValidatedHandoffTarget; epochKey: string }> | null {
  const custody = readCustodyLedger(runtime.paths.coral.coordinator.runDir);
  const live = new Map<string, Set<string>>();
  for (const entry of custody) {
    if (entry.kind === 'unreadable' || entry.kind === 'holding') return null;
    if (entry.kind !== 'bound') continue;
    if (entry.binding.process === null) return null;
    const observation = observeRecordedContainment(
      { ...entry.binding.process, childRoot: null },
      {
        process: runtime.process,
        platform: runtime.env.platform() as NodeJS.Platform,
        readProcessIncarnation: (pid, platform) => runtime.process.readProcessIncarnation(pid, platform),
      },
    );
    if (observation.kind === 'unobservable') return null;
    if (observation.kind !== 'alive') continue;
    if (entry.intent.epochKey === undefined) return null;
    const jobs = live.get(entry.intent.epochKey) ?? new Set<string>();
    jobs.add(entry.intent.jobId ?? entry.intent.operationId);
    live.set(entry.intent.epochKey, jobs);
  }
  const activeLineages = new Set(live.keys());
  for (const location of index.locations()) {
    if (location.disposition !== 'active-owner') continue;
    const lineageKey = observeResolvedStoreEpoch(location.epochKey)?.lineageKey;
    if (lineageKey === undefined) return null;
    activeLineages.add(lineageKey);
  }
  if (activeLineages.size !== 1) return null;
  const lineageKey = [...activeLineages][0]!;
  const liveJobIds = live.get(lineageKey) ?? new Set<string>();
  return prepareRetainedControllerHandoffForLineage(runtime, index, format, custody, lineageKey, liveJobIds);
}

function prepareRetainedControllerHandoffForLineage(
  runtime: Runtime,
  index: JobLocationIndex,
  format: StoreFormatDescription,
  custody: ReturnType<typeof readCustodyLedger>,
  lineageKey: string,
  liveJobIds: ReadonlySet<string>,
): Readonly<{ target: ValidatedHandoffTarget; epochKey: string }> | null {
  const current = inspectCurrentStore(runtime);
  const currentEpoch = current.kind === 'current' && readEpochKey(current.epoch) === lineageKey
    ? current.epoch : null;
  let epoch: ResolvedStoreEpoch | null;
  try {
    epoch = currentEpoch ?? observeProtectedEpoch(runtime.storage.realpathSync(runtime.paths.coral.store.dbDir),
      lineageKey);
  } catch {
    return null;
  }
  if (epoch === null) return null;
  let classification: ReturnType<typeof classifyStoreFile>;
  try { classification = classifyStoreFile(epoch.path, runtime.storage, format); } catch { return null; }
  if (classification.kind !== 'older-incompatible' && classification.kind !== 'newer-incompatible') return null;
  const epochKey = observeResolvedStoreEpochKey(epoch);
  if (epochKey === null || observeResolvedStoreEpoch(epochKey)?.lineageKey !== lineageKey) return null;
  const unresolved = index.locationsFor(epochKey).filter((location) => location.disposition !== 'terminal');
  if (unresolved.length === 0 || [...liveJobIds].some((jobId) =>
    !unresolved.some((location) => location.jobId === jobId))) return null;
  const receipts = readDurableCliControllerReceipts(runtime.paths.coral.coordinator.runDir);
  if (receipts === null) return null;
  let selectedController: Readonly<{ instanceId: string; buildSetId: string; controlGeneration: number }> | null = null;
  for (const location of unresolved) {
    const jobReceipts = receipts.filter((receipt) => receipt.jobId === location.jobId &&
      receipt.epochKey === epochKey).sort((left, right) =>
      right.controlGeneration - left.controlGeneration || right.acknowledgedAtMs - left.acknowledgedAtMs);
    const latest = jobReceipts[0];
    const tied = jobReceipts[1];
    if (latest !== undefined && tied !== undefined &&
        latest.controlGeneration === tied.controlGeneration &&
        latest.acknowledgedAtMs === tied.acknowledgedAtMs &&
        JSON.stringify(latest) !== JSON.stringify(tied)) return null;
    const controller = latest === undefined ? location.controller : {
      instanceId: latest.controllerInstanceId,
      buildSetId: latest.controllerBuildSetId,
      controlGeneration: latest.controlGeneration,
    };
    if (controller === undefined) return null;
    let opened: ReturnType<typeof latestControllerOpen>;
    try { opened = latestControllerOpen(runtime, epochKey, controller.instanceId); } catch { return null; }
    if (opened === null || opened.build.buildSetId !== controller.buildSetId ||
        opened.controlGeneration !== controller.controlGeneration ||
        (selectedController !== null && (selectedController.instanceId !== controller.instanceId ||
          selectedController.buildSetId !== controller.buildSetId ||
          selectedController.controlGeneration !== controller.controlGeneration))) return null;
    selectedController = controller;
    if (!liveJobIds.has(location.jobId)) {
      if (location.detail?.status?.phase !== 'queued') return null;
      continue;
    }
    const bound = custody.some((entry) => {
      if (entry.kind !== 'bound' || entry.intent.epochKey !== lineageKey ||
          (entry.intent.jobId ?? entry.intent.operationId) !== location.jobId ||
          entry.binding.process === null ||
          (latest !== undefined && entry.intent.id !== latest.custodyIntentId)) return false;
      const process = entry.binding.process;
      if (latest !== undefined && (process.pid !== latest.runtimeMeta.pid ||
          process.incarnation !== latest.runtimeMeta.incarnation ||
          process.processGroupId !== latest.runtimeMeta.processGroupId)) return false;
      return observeRecordedContainment(
        { pid: process.pid, incarnation: process.incarnation, processGroupId: process.processGroupId, childRoot: null },
        {
          process: runtime.process,
          platform: runtime.env.platform() as NodeJS.Platform,
          readProcessIncarnation: (pid, platform) => runtime.process.readProcessIncarnation(pid, platform),
        },
      ).kind === 'alive';
    });
    if (!bound) return null;
  }
  let target: ValidatedHandoffTarget | null;
  try {
    target = selectedController === null ? null
      : controllerRecoveryTarget(runtime, epochKey, selectedController.instanceId);
  } catch { return null; }
  return target === null ? null : { target, epochKey };
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
