import { dirname, join } from 'node:path';
import { z } from 'zod';

import type { ValidatedHandoffTarget } from '../../infra/handoff-target.js';
import { observeRecordedContainment } from '../../infra/process-containment.js';
import { seedHistoricalEpoch, type HistoricalSeedResult } from '../../jobs/historical-reader.js';
import type { JobLocationIndex } from '../../jobs/location-index.js';
import type { Runtime } from '../../runtime/ports.js';
import { readCustodyLedger } from '../../store/custody-ledger.js';
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
import { recordEpochClosure } from '../../store/epoch-closure.js';
import { readEpochKey } from '../../store/epoch-key.js';
import { observeProtectedEpoch } from '../../store/epoch-protection.js';
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

function seedUnprovenIncumbentJobs(
  runtime: Runtime,
  index: JobLocationIndex,
  incumbent: ResolvedStoreEpoch,
  epochKey: string,
): string {
  let db: ReturnType<Runtime['storage']['openSqliteDatabaseSync']> | null = null;
  try {
    db = runtime.storage.openSqliteDatabaseSync(incumbent.path, { readOnly: true });
    const projections = db.prepare('SELECT job_id, project_root, job_kind FROM projection_jobs').all();
    const launches = db
      .prepare("SELECT stream_id, body FROM events WHERE stream_kind = 'job' AND type = 'job.launch.requested'")
      .all();
    const subjects = new Map<
      string,
      { projectRoot: string; workDir: string | null; jobKind: 'provider' | 'workflow' | 'kb' }
    >();
    for (const row of projections) {
      const parsed = z
        .object({
          job_id: z.string().min(1),
          project_root: z.string().min(1),
          job_kind: z.enum(['provider', 'workflow', 'kb']),
        })
        .parse(row);
      subjects.set(parsed.job_id, {
        projectRoot: parsed.project_root,
        workDir: parsed.job_kind === 'kb' ? null : parsed.project_root,
        jobKind: parsed.job_kind,
      });
    }
    for (const row of launches) {
      const parsed = z.object({ stream_id: z.string().min(1), body: z.instanceof(Uint8Array) }).parse(row);
      const body = z
        .object({
          projectRoot: z.string().min(1),
          jobKind: z.enum(['provider', 'workflow', 'kb']),
          request: z
            .object({ cwd: z.string().min(1).optional() })
            .passthrough()
            .optional(),
        })
        .parse(JSON.parse(Buffer.from(parsed.body).toString('utf8')) as unknown);
      subjects.set(parsed.stream_id, {
        projectRoot: body.projectRoot,
        workDir: body.jobKind === 'kb' ? null : (body.request?.cwd ?? body.projectRoot),
        jobKind: body.jobKind,
      });
    }
    for (const [jobId, subject] of subjects) {
      index.register(jobId, epochKey, subject);
      index.markUnresolved(jobId);
    }
    const fingerprint = z
      .object({ value: z.string() })
      .safeParse(db.prepare("SELECT value FROM meta WHERE key = 'store_format_fingerprint'").get());
    return fingerprint.success ? fingerprint.data.value : '';
  } catch (error: unknown) {
    index.holdUnknownLocations(epochKey, error instanceof Error ? error.message : String(error));
    return '';
  } finally {
    db?.close();
  }
}

export function prepareRetainedControllerHandoff(
  runtime: Runtime,
  index: JobLocationIndex,
): Readonly<{ target: ValidatedHandoffTarget; epochKey: string }> | null {
  const custody = readCustodyLedger(runtime, runtime.paths.coral.coordinator.runDir);
  const live = new Map<string, Set<string>>();
  const absent = new Map<string, Set<string>>();
  const holding = new Map<string, Set<string>>();
  for (const entry of custody) {
    if (entry.kind === 'unreadable') return null;
    if (entry.kind === 'holding') {
      if (entry.intent.epochKey === undefined) return null;
      if (entry.intent.jobId !== undefined) {
        const jobs = holding.get(entry.intent.epochKey) ?? new Set<string>();
        jobs.add(entry.intent.jobId);
        holding.set(entry.intent.epochKey, jobs);
      }
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
    if (entry.intent.epochKey === undefined) return null;
    const byLineage = observation.kind === 'alive' ? live : absent;
    const jobs = byLineage.get(entry.intent.epochKey) ?? new Set<string>();
    jobs.add(entry.intent.jobId ?? entry.intent.operationId);
    byLineage.set(entry.intent.epochKey, jobs);
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
  return prepareRetainedControllerHandoffForLineage(
    runtime,
    index,
    custody,
    lineageKey,
    liveJobIds,
    absent.get(lineageKey) ?? new Set<string>(),
    holding.get(lineageKey) ?? new Set<string>(),
  );
}

function prepareRetainedControllerHandoffForLineage(
  runtime: Runtime,
  index: JobLocationIndex,
  custody: ReturnType<typeof readCustodyLedger>,
  lineageKey: string,
  liveJobIds: ReadonlySet<string>,
  absentJobIds: ReadonlySet<string>,
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
  const epochKey = observeResolvedStoreEpochKey(runtime, epoch);
  if (epochKey === null || observeResolvedStoreEpoch(runtime, epochKey)?.lineageKey !== lineageKey) return null;
  const unresolved = index.locationsFor(epochKey).filter((location) => location.disposition !== 'terminal');
  if (
    unresolved.length === 0 ||
    [...liveJobIds].some((jobId) => !unresolved.some((location) => location.jobId === jobId))
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
      if (
        (location.detail.kind !== 'recorded' || location.detail.value.status.phase !== 'queued') &&
        !absentJobIds.has(location.jobId)
      )
        return null;
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
    const epochKey = observation.incumbentEpochKey;
    if (epochKey === null) return null;
    const lineageKey = decodeResolvedStoreEpoch(runtime, epochKey)?.lineageKey;
    if (lineageKey === undefined) return null;
    const unprovenIncumbent = observation.classification.kind === 'absent';
    const recoveredFingerprint = unprovenIncumbent
      ? seedUnprovenIncumbentJobs(runtime, index, incumbent, epochKey)
      : '';
    const incumbentMetadata = listStoreEpochs(runtime).find(
      (entry) => entry.resolved?.path === incumbent.path,
    )?.epochJson;
    const fingerprint =
      'storedFingerprint' in observation.classification &&
      typeof observation.classification.storedFingerprint === 'string'
        ? observation.classification.storedFingerprint
        : recoveredFingerprint ||
          (incumbentMetadata?.kind === 'valid' ? incumbentMetadata.value.build.storeFormatFingerprint : '');
    const knownLocations = index.locationsFor(epochKey);
    const knownJobs = knownLocations.map((location) => ({
      jobId: location.jobId,
      subject: location.subject,
    }));
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
      index.unknownLocationHold(epochKey) === null &&
      !custodyNamesEpoch &&
      !controllerReceiptsMayNameEpoch(runtime, epochKey, lineageKey);
    if (!holdsNoWork && attempts < UNOPENABLE_STARTUP_ATTEMPTS) return null;
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
