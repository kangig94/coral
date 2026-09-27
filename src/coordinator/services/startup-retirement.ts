import { dirname, join } from 'node:path';
import { z } from 'zod';

import type { ValidatedHandoffTarget } from '../../infra/handoff-target.js';
import { observeRecordedContainment } from '../../infra/process-containment.js';
import { seedHistoricalEpoch, type HistoricalSeedResult } from '../../jobs/historical-reader.js';
import type { JobLocationIndex } from '../../jobs/location-index.js';
import type { Runtime } from '../../runtime/ports.js';
import { readCustodyLedger } from '../../store/custody-ledger.js';
import { classifyStoreFile } from '../../store/db.js';
import {
  decodeResolvedStoreEpoch,
  encodeResolvedStoreEpoch,
  inspectCurrentStore,
  listStoreEpochs,
  observeResolvedStoreEpoch,
  observeResolvedStoreEpochKey,
  retirementMintDisposition,
  type ResolvedStoreEpoch,
  type StoreMintDisposition,
  type StoreMintObservation,
} from '../../store/epoch.js';
import { observeEpochClosure, recordEpochClosure } from '../../store/epoch-closure.js';
import { readEpochKey } from '../../store/epoch-key.js';
import { observeProtectedEpoch } from '../../store/epoch-protection.js';
import type { StoreFormatDescription } from '../../store/format-fingerprint.js';
import { latestControllerOpen } from '../succession/controller-open.js';
import { readDurableCliControllerReceipts } from './durable-cli-transfer.js';
import {
  controllerRecoveryTarget,
  settleWithRetainedExecutor,
  type RetainedExecutorSettlement,
} from './retained-epoch-executor.js';

const UNOPENABLE_STARTUP_ATTEMPTS = 2;

/** A startup that observes the same unopenable epoch again after this long counts that observation as an attempt. */
export const RETIREMENT_PATIENCE_INTERVAL_MS = 5_000;

const retirementPatienceSchema = z
  .object({
    startupId: z.string(),
    attempts: z.number().int().nonnegative(),
    countedAt: z.number().int().nonnegative().optional(),
  })
  .passthrough();

type RetirementPatience = z.infer<typeof retirementPatienceSchema>;

export function prepareRetainedControllerHandoff(
  runtime: Runtime,
  index: JobLocationIndex,
  format: StoreFormatDescription,
): Readonly<{ target: ValidatedHandoffTarget; epochKey: string }> | null {
  const custody = readCustodyLedger(runtime, runtime.paths.coral.coordinator.runDir);
  const live = new Map<string, Set<string>>();
  const holding = new Set<string>();
  for (const entry of custody) {
    if (entry.kind === 'unreadable') return null;
    if (entry.kind === 'holding') {
      if (entry.intent.epochKey === undefined) return null;
      if (entry.intent.jobId !== undefined) holding.add(entry.intent.jobId);
      continue;
    }
    if (entry.kind !== 'bound') continue;
    if (entry.intent.effect === 'provider-operation-publication') continue;
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
    const lineageKey = observeResolvedStoreEpoch(runtime, location.epochKey)?.lineageKey;
    if (lineageKey === undefined) return null;
    activeLineages.add(lineageKey);
  }
  if (activeLineages.size !== 1) return null;
  const lineageKey = [...activeLineages][0];
  const liveJobIds = live.get(lineageKey) ?? new Set<string>();
  return prepareRetainedControllerHandoffForLineage(runtime, index, format, custody, lineageKey, liveJobIds, holding);
}

function prepareRetainedControllerHandoffForLineage(
  runtime: Runtime,
  index: JobLocationIndex,
  format: StoreFormatDescription,
  custody: ReturnType<typeof readCustodyLedger>,
  lineageKey: string,
  liveJobIds: ReadonlySet<string>,
  holdingJobIds: ReadonlySet<string>,
): Readonly<{ target: ValidatedHandoffTarget; epochKey: string }> | null {
  const current = inspectCurrentStore(runtime);
  const currentEpoch =
    current.kind === 'current' && readEpochKey(runtime, current.epoch) === lineageKey ? current.epoch : null;
  let epoch: ResolvedStoreEpoch | null;
  try {
    epoch =
      currentEpoch ??
      observeProtectedEpoch(runtime, runtime.storage.realpathSync(runtime.paths.coral.store.dbDir), lineageKey);
  } catch {
    return null;
  }
  if (epoch === null) return null;
  let classification: ReturnType<typeof classifyStoreFile>;
  try {
    classification = classifyStoreFile(epoch.path, runtime.storage, format);
  } catch {
    return null;
  }
  if (classification.kind !== 'older-incompatible' && classification.kind !== 'newer-incompatible') return null;
  const epochKey = observeResolvedStoreEpochKey(runtime, epoch);
  if (epochKey === null || observeResolvedStoreEpoch(runtime, epochKey)?.lineageKey !== lineageKey) return null;
  const unresolved = index.locationsFor(epochKey).filter((location) => location.disposition !== 'terminal');
  if (
    unresolved.length === 0 ||
    [...liveJobIds].some((jobId) => !unresolved.some((location) => location.jobId === jobId)) ||
    custody.some((entry) => entry.kind === 'holding' && entry.intent.epochKey !== lineageKey)
  )
    return null;
  const { receipts, unreadable } = readDurableCliControllerReceipts(runtime, runtime.paths.coral.coordinator.runDir);
  if (unreadable.length > 0) return null;
  let selectedController: Readonly<{ instanceId: string; buildSetId: string; controlGeneration: number }> | null = null;
  for (const location of unresolved) {
    const jobReceipts = receipts
      .filter((receipt) => receipt.jobId === location.jobId && receipt.epochKey === epochKey)
      .sort(
        (left, right) =>
          right.controlGeneration - left.controlGeneration || right.acknowledgedAtMs - left.acknowledgedAtMs,
      );
    const latest = jobReceipts[0];
    const tied = jobReceipts[1];
    if (
      latest !== undefined &&
      tied !== undefined &&
      latest.controlGeneration === tied.controlGeneration &&
      latest.acknowledgedAtMs === tied.acknowledgedAtMs &&
      JSON.stringify(latest) !== JSON.stringify(tied)
    )
      return null;
    const controller =
      latest === undefined
        ? location.controller
        : {
            instanceId: latest.controllerInstanceId,
            buildSetId: latest.controllerBuildSetId,
            controlGeneration: latest.controlGeneration,
          };
    if (controller === undefined) return null;
    const observation = latestControllerOpen(runtime, epochKey, controller.instanceId);
    const opened = observation.latest;
    if (
      observation.unreadable.length > 0 ||
      opened === null ||
      opened.build.buildSetId !== controller.buildSetId ||
      opened.controlGeneration !== controller.controlGeneration ||
      (selectedController !== null &&
        (selectedController.instanceId !== controller.instanceId ||
          selectedController.buildSetId !== controller.buildSetId ||
          selectedController.controlGeneration !== controller.controlGeneration))
    )
      return null;
    selectedController = controller;
    if (holdingJobIds.has(location.jobId) && !liveJobIds.has(location.jobId)) continue;
    if (!liveJobIds.has(location.jobId)) {
      if (location.detail.kind !== 'recorded' || location.detail.value.status.phase !== 'queued') return null;
      continue;
    }
    let bound = false;
    for (const entry of custody) {
      if (
        entry.kind !== 'bound' ||
        entry.intent.epochKey !== lineageKey ||
        (entry.intent.jobId ?? entry.intent.operationId) !== location.jobId ||
        entry.binding.process === null ||
        (latest !== undefined && entry.intent.id !== latest.custodyIntentId)
      )
        continue;
      const process = entry.binding.process;
      if (
        latest !== undefined &&
        (process.pid !== latest.runtimeMeta.pid ||
          process.incarnation !== latest.runtimeMeta.incarnation ||
          process.processGroupId !== latest.runtimeMeta.processGroupId)
      )
        continue;
      const observation = observeRecordedContainment(
        {
          pid: process.pid,
          incarnation: process.incarnation,
          processGroupId: process.processGroupId,
          childRoot: null,
        },
        {
          process: runtime.process,
          platform: runtime.env.platform() as NodeJS.Platform,
          readProcessIncarnation: (pid, platform) => runtime.process.readProcessIncarnation(pid, platform),
        },
      );
      if (observation.kind === 'unobservable') return null;
      if (observation.kind === 'alive') {
        bound = true;
        break;
      }
    }
    if (!bound) return null;
  }
  let target: ValidatedHandoffTarget | null;
  try {
    target =
      selectedController === null ? null : controllerRecoveryTarget(runtime, epochKey, selectedController.instanceId);
  } catch {
    return null;
  }
  return target === null ? null : { target, epochKey };
}

/** An unreadable receipt may name the epoch, so only readable receipts can rule it out. */
function controllerReceiptsMayNameEpoch(runtime: Runtime, epochKey: string, lineageKey: string): boolean {
  const { receipts, unreadable } = readDurableCliControllerReceipts(runtime, runtime.paths.coral.coordinator.runDir);
  return (
    unreadable.length > 0 ||
    receipts.some((receipt) => receipt.epochKey === epochKey || receipt.lineageEpochKey === lineageKey)
  );
}

export function createStartupMintAuthorizer(
  runtime: Runtime,
  index: JobLocationIndex,
  startupId: string,
): (observation: StoreMintObservation) => StoreMintDisposition | null {
  return (observation) => {
    for (const historical of listStoreEpochs(runtime)) {
      if (
        historical.role !== 'protected' ||
        historical.resolved === null ||
        historical.epochKey === null ||
        historical.epochKey === undefined
      )
        continue;
      const historicalKey = encodeResolvedStoreEpoch(runtime, historical.resolved);
      const closure = observeEpochClosure(runtime, runtime.paths.coral.generation.dataRoot, historical.epochKey);
      if (closure.kind === 'recorded' && closure.evidence.disposition === 'unrecoverable-retained') continue;
      const fingerprint =
        historical.epochJson.kind === 'valid' ? historical.epochJson.value.build.storeFormatFingerprint : '';
      void seedHistoricalEpoch(
        runtime,
        index,
        historical.resolved,
        historicalKey,
        fingerprint,
        runtime.paths.coral.exports.jobsRoot,
        runtime.storage,
      );
    }
    const incumbent = observation.incumbent;
    if (incumbent === null) {
      return retirementMintDisposition(observation.observedEpochCount === 0 ? 'initial' : 'unopenable', null);
    }
    const epochKey = encodeResolvedStoreEpoch(runtime, incumbent);
    const lineageKey = decodeResolvedStoreEpoch(runtime, epochKey)?.lineageKey;
    if (lineageKey === undefined) return null;
    const fingerprint =
      'storedFingerprint' in observation.classification &&
      typeof observation.classification.storedFingerprint === 'string'
        ? observation.classification.storedFingerprint
        : '';
    const knownLocations = index.locationsFor(epochKey);
    const knownJobs = knownLocations.map((location) => ({
      jobId: location.jobId,
      subject: location.subject,
    }));
    // Liveness is judged from locations known before this startup marks its own unresolved holds.
    const knownLive = knownLocations.some((location) => location.disposition !== 'terminal');
    const priorController = latestControllerOpen(runtime, epochKey);
    const needsRetainedExecutor =
      (priorController.latest !== null || priorController.unreadable.length > 0) && !index.resultsReleased(epochKey);
    const executor: RetainedExecutorSettlement = needsRetainedExecutor
      ? settleWithRetainedExecutor(runtime, epochKey)
      : { kind: 'settled' };
    const executorSettled = executor.kind === 'settled';
    const seeded = seedHistoricalEpoch(
      runtime,
      index,
      incumbent,
      epochKey,
      fingerprint,
      runtime.paths.coral.exports.jobsRoot,
      runtime.storage,
      knownJobs,
      executorSettled,
    );
    if (!executorSettled) {
      index.holdUnknownLocations(epochKey, 'retained-controller-recovery-unavailable');
      for (const location of index.locationsFor(epochKey)) index.markUncertified(location.jobId);
    }
    let custodySettled: boolean;
    let custodyNamesEpoch = true;
    try {
      const custody = readCustodyLedger(runtime, runtime.paths.coral.coordinator.runDir);
      const matching = custody.filter(
        (entry) =>
          entry.kind === 'unreadable' ||
          entry.intent.epochKey === lineageKey ||
          entry.intent.epoch === dirname(incumbent.path),
      );
      custodyNamesEpoch = matching.length > 0;
      custodySettled = true;
      for (const entry of matching) {
        if (entry.kind === 'absent') continue;
        if (entry.kind !== 'bound') {
          custodySettled = false;
          break;
        }
        const jobId = entry.intent.jobId ?? entry.intent.operationId;
        if (entry.intent.effect === 'provider-operation-publication') {
          if (index.read(jobId)?.disposition !== 'terminal') custodySettled = false;
          if (!custodySettled) break;
          continue;
        }
        const process = entry.binding.process;
        if (
          process === null ||
          (entry.intent.owner === 'durable-cli' && index.read(jobId)?.disposition !== 'terminal')
        ) {
          custodySettled = false;
          break;
        }
        const observation = observeRecordedContainment(
          {
            pid: process.pid,
            incarnation: process.incarnation,
            processGroupId: process.processGroupId,
            childRoot: null,
          },
          {
            process: runtime.process,
            platform: runtime.env.platform() as NodeJS.Platform,
            readProcessIncarnation: (pid, platform) => runtime.process.readProcessIncarnation(pid, platform),
          },
        );
        if (observation.kind !== 'absent') {
          custodySettled = false;
          break;
        }
      }
    } catch {
      custodySettled = false;
    }
    if (executorSettled && seeded.kind === 'complete' && custodySettled && index.resultsReleased(epochKey)) {
      return retirementMintDisposition('retired', epochKey);
    }
    const liveHistory =
      (seeded.kind === 'unrecoverable-retained' && seeded.reason === 'known-jobs-unresolved') ||
      (executor.kind === 'no-capable-root' && knownLive);
    const attemptsPath = join(
      runtime.paths.coral.coordinator.runDir,
      'retirement-patience.v1',
      `${runtime.ids.sha256(epochKey)}.json`,
    );
    let previous: RetirementPatience | null = null;
    try {
      const parsed = retirementPatienceSchema.safeParse(
        JSON.parse(runtime.storage.readFileSync(attemptsPath, 'utf-8')) as unknown,
      );
      if (parsed.success) previous = parsed.data;
    } catch {
      // An unreadable patience record starts a fresh observation count.
    }
    const now = runtime.time.now();
    // Startups racing each other observe the same evidence, so an observation counts once per interval, not per process.
    const repeated =
      previous !== null &&
      (previous.countedAt === undefined
        ? previous.startupId === startupId
        : now - previous.countedAt < RETIREMENT_PATIENCE_INTERVAL_MS)
        ? previous
        : null;
    const attempts = repeated?.attempts ?? (previous?.attempts ?? 0) + 1;
    const countedAt = repeated === null ? now : (repeated.countedAt ?? now);
    runtime.storage.mkdirSync(dirname(attemptsPath), { recursive: true, mode: 0o700 });
    if (
      !runtime.storage.writeAtomicDurableSync(attemptsPath, `${JSON.stringify({ startupId, attempts, countedAt })}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
    )
      throw new Error('Retirement patience could not be recorded durably.');
    const holdsNoWork =
      index.locationsFor(epochKey).length === 0 &&
      !custodyNamesEpoch &&
      !controllerReceiptsMayNameEpoch(runtime, epochKey, lineageKey);
    if (!liveHistory && !holdsNoWork && attempts < UNOPENABLE_STARTUP_ATTEMPTS) return null;
    // An unreadable closure already retains the epoch visibly, so the mint proceeds without overwriting it.
    void recordEpochClosure(runtime, runtime.paths.coral.generation.dataRoot, {
      version: 'v1',
      epochKey: lineageKey,
      disposition: 'unrecoverable-retained',
      dataOutcome: index.resultsReleased(epochKey) ? 'retained' : 'unreadable',
      executionDischarge: 'undecidable',
      obligations: [],
      reason: retirementReason(seeded, executor, priorController.unreadable),
      observedAtMs: runtime.time.now(),
    });
    return retirementMintDisposition('unopenable', epochKey);
  };
}

function retirementReason(
  seeded: HistoricalSeedResult,
  executor: RetainedExecutorSettlement,
  unreadableControllerOpens: readonly string[],
): string {
  if (seeded.kind === 'unrecoverable-retained') return seeded.reason;
  if (executor.kind === 'no-capable-root') return `retained executor unavailable: ${executor.reason}`;
  if (executor.kind === 'transient-failure')
    return `retained executor did not settle after bounded patience (exit ${executor.status ?? 'none'})`;
  if (unreadableControllerOpens.length > 0)
    return `controller-open records are unreadable: ${unreadableControllerOpens.join(', ')}`;
  return 'custody remains unresolved';
}
