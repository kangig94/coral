import type { Database } from '../../store/db.js';
import { isProcessAlive, probeProcessStartedAtSeconds } from '../../infra/node-process.js';
import {
  classifyCarrier,
  type CarrierEvidence,
  type CarrierObservation,
  type CarrierObservationInput,
  type JobRecoveryCoverage,
  type LocalOperationRegistryState,
} from '../../jobs/carrier-observation.js';
import type { JobProjectionDetail } from '../../jobs/read-queries.js';
import { readDurableCliProcessRuntimeMeta } from '../../jobs/runtime-meta-store.js';
import { LAUNCH_POOLS, type LaunchPool } from '../../jobs/contracts/admission.js';
import type { CarrierWaitObservation } from '../../jobs/shell/wait.js';
import { hasProviderOperationForJob, readProviderOperationForJob } from '../../store/provider-operation-journal.js';
import type { ProviderOperationRecord } from '../../store/provider-operation-record.js';
import type { LaunchCoordinator } from '../live/admission.js';
import {
  carrierStatusOperationKey,
  type CarrierStatusOutcome,
  type CarrierStatusRecord,
} from '../live/carrier-observer.js';

/**
 * The local half of carrier observation, composed here rather than in `jobs/carrier-observation.ts` because
 * every registry it reads — admission, the durable-CLI meta table, the OS process table — is coordinator-
 * owned or store-owned, not jobs-domain vocabulary. `classifyCarrier` itself stays a pure classifier; this
 * module is the imperative shell that gathers the evidence it takes as input.
 *
 * Permitted here and nowhere outside `composition/`/`read-model/` per
 * `tests/invariants/no-carrier-observation-in-action-paths.test.ts`.
 */

export type LocalCarrierRegistries = Readonly<{
  getDb: () => Database;
  loadJobProjectionDetail: (jobId: string) => JobProjectionDetail;
  platform: NodeJS.Platform;
  /** Keeps the mutation authority out of every carrier consumer while letting each job resolve durable
   *  recovery ownership only after lifecycle has published the one-way startup boundary. */
  hasStartupRecoveryPassed: () => boolean;
  isAdmittedByThisCoordinator: (jobId: string) => boolean;
  /** `LocalOperationRegistry.stateForJob` (W2.3) — `null` when this coordinator has no live entry for the
   *  job, which `evidenceFor` below maps to `'inherited'`, never to a guessed `'activated'`. */
  registryStateForJob: (jobId: string) => LocalOperationRegistryState | null;
}>;

/** True once the job is admitted (active or queued) in this coordinator process's own in-memory admission
 *  state — never persisted, so it is naturally scoped to this process and answers `false` for anything a
 *  predecessor generation admitted before a handoff. */
export function admittedByThisCoordinator(
  launchCoordinator: Pick<LaunchCoordinator, 'getActiveJobIds' | 'queuePosition'>,
  jobId: string,
): boolean {
  return (LAUNCH_POOLS as readonly LaunchPool[]).some(
    (pool) =>
      launchCoordinator.getActiveJobIds(pool).includes(jobId) || launchCoordinator.queuePosition(jobId, pool) !== null,
  );
}

/**
 * A durable CLI is the one class local evidence alone can resolve to `absent`: the recorded pid plus the
 * OS-probed start second either name the process this coordinator launched, or they don't.
 *
 * A pid mismatch between the journal's `job.runtime.started` record and the separately captured
 * `durable_cli_process.v1` meta is treated the same as no meta at all — both mean there is nothing trustworthy
 * to check the OS against, never a reason to guess.
 */
function durableCliEvidence(
  db: Database,
  jobId: string,
  journalPid: number,
  platform: NodeJS.Platform,
): CarrierEvidence {
  const meta = readDurableCliProcessRuntimeMeta(db, jobId);
  if (meta === null || meta.pid !== journalPid) {
    return { carrierClass: 'durable-cli', process: { kind: 'uncaptured' } };
  }

  const observedStartedAt = probeProcessStartedAtSeconds(meta.pid, platform);
  if (observedStartedAt === null) {
    if (isProcessAlive(meta.pid)) {
      // Alive but its start time is unreadable: cannot tell a recycled pid from the same process, so this
      // stays "nothing to check against" rather than a guess in either direction.
      return { carrierClass: 'durable-cli', process: { kind: 'uncaptured' } };
    }
    return {
      carrierClass: 'durable-cli',
      process: { kind: 'recorded', alive: false, matchesRecordedStart: false, transportEvidence: true },
    };
  }

  return {
    carrierClass: 'durable-cli',
    process: {
      kind: 'recorded',
      alive: true,
      matchesRecordedStart: observedStartedAt === meta.processStartedAtSeconds,
      transportEvidence: true,
    },
  };
}

/**
 * `app-server-acquired` reads `LocalOperationRegistry.stateForJob` (W2.3): `activated` or `attached` when this
 * coordinator generation holds a live entry for the job, and `inherited` — the registry's own `null` — for
 * an operation this coordinator never activated or attached, or for one whose operation already settled:
 * the registry deletes on settlement rather than marking it ended, so an ended operation reads the same as
 * one this coordinator never had. Either way that is locally `unknown`, never `absent`. The durable provider-
 * operation record, not runtime metadata, supplies the complete operation tuple for any later external
 * observation; `jobId` is enough for this local registry lookup because a job carries at most one live
 * operation at a time.
 */
function evidenceFor(jobId: string, detail: JobProjectionDetail, registries: LocalCarrierRegistries): CarrierEvidence {
  const { runtime } = detail;
  if (runtime === null) {
    return {
      carrierClass: 'queued-or-launching',
      admittedByThisCoordinator: registries.isAdmittedByThisCoordinator(jobId),
    };
  }

  switch (runtime.transport) {
    case 'app-server':
      return runtime.providerMeta.leaseState === 'waiting'
        ? {
            carrierClass: 'app-server-waiting',
            admittedByThisCoordinator: registries.isAdmittedByThisCoordinator(jobId),
          }
        : { carrierClass: 'app-server-acquired', registryState: registries.registryStateForJob(jobId) ?? 'inherited' };
    case 'workflow':
      return { carrierClass: 'workflow', ownedByThisCoordinator: registries.isAdmittedByThisCoordinator(jobId) };
    case 'internal':
      return { carrierClass: 'internal-hosted-kb', memberOfSupervisor: registries.isAdmittedByThisCoordinator(jobId) };
    case 'durable-cli':
      return durableCliEvidence(registries.getDb(), jobId, runtime.pid, registries.platform);
  }
}

/** Retains the job key beside its full verdict so local health and idle consumers never need to reclassify. */
export type JobCarrierObservation = Readonly<{ jobId: string; observation: CarrierObservation }>;

export type LocalCarrierInput = Readonly<{
  jobId: string;
  input: CarrierObservationInput;
  providerOperation: ProviderOperationRecord | null;
}>;

export type ExternalCarrierObserver = (
  records: readonly CarrierStatusRecord[],
) => Promise<ReadonlyMap<string, CarrierStatusOutcome>>;

function recoveryCoverageFor(jobId: string, registries: LocalCarrierRegistries): JobRecoveryCoverage {
  if (!registries.hasStartupRecoveryPassed()) return 'in-progress';
  return hasProviderOperationForJob(registries.getDb(), jobId) ? 'accounted-for' : 'unaccounted';
}

/** Gathers every synchronous fact before any external observation begins. */
export function collectLocalCarrierInputs(
  jobIds: readonly string[],
  registries: LocalCarrierRegistries,
  observedMaxJournalSeq: number,
): LocalCarrierInput[] {
  const inputs: LocalCarrierInput[] = [];
  for (const jobId of jobIds) {
    const detail = registries.loadJobProjectionDetail(jobId);
    if (detail.status === null) continue;
    const evidence = evidenceFor(jobId, detail, registries);
    inputs.push({
      jobId,
      input: {
        storedPhase: detail.status.phase,
        evidence,
        observedMaxJournalSeq,
        recoveryCoverage: recoveryCoverageFor(jobId, registries),
      },
      providerOperation:
        evidence.carrierClass === 'app-server-acquired' && evidence.registryState === 'inherited'
          ? readProviderOperationForJob(registries.getDb(), jobId)
          : null,
    });
  }
  return inputs;
}

/** Adds an already-observed external answer only where local acquired evidence is inconclusive. */
export function withExternalStatus(
  input: CarrierObservationInput,
  status: CarrierStatusOutcome,
): CarrierObservationInput {
  if (input.evidence.carrierClass !== 'app-server-acquired' || input.evidence.registryState !== 'inherited') {
    return input;
  }
  return {
    ...input,
    evidence: { ...input.evidence, proxyOperationStatus: status },
  };
}

/** Classifies every named job from local registries only. Jobs with no stored status are skipped rather than
 *  reported: the caller already scoped `jobIds` to jobs it believes exist, and a row that vanished between
 *  that scope and this read has nothing local to say about it either way. */
export function classifyLocalCarriers(
  jobIds: readonly string[],
  registries: LocalCarrierRegistries,
  observedMaxJournalSeq: number,
): JobCarrierObservation[] {
  return collectLocalCarrierInputs(jobIds, registries, observedMaxJournalSeq).map(({ jobId, input }) => ({
    jobId,
    observation: classifyCarrier(input),
  }));
}

/**
 * Builds the wait stream's `observeCarriers` port. Synchronous collection completes first; then one injected
 * observer pass answers only the durable inherited operations, and the pure classifier runs on the merge.
 */
export function createObserveCarriers(
  registries: LocalCarrierRegistries,
  getCurrentJournalSeq: () => number,
  observeExternalCarriers?: ExternalCarrierObserver,
): (jobIds: readonly string[]) => Promise<CarrierWaitObservation[]> {
  return async (jobIds) => {
    const inputs = collectLocalCarrierInputs(jobIds, registries, getCurrentJournalSeq());
    const records = inputs.flatMap(({ providerOperation }) => (providerOperation === null ? [] : [providerOperation]));
    const statuses =
      records.length === 0 || observeExternalCarriers === undefined
        ? new Map<string, CarrierStatusOutcome>()
        : await observeExternalCarriers(records);

    return inputs.map(({ jobId, input, providerOperation }) => {
      const status =
        providerOperation === null
          ? 'unknown'
          : (statuses.get(carrierStatusOperationKey(providerOperation.operation)) ?? 'unknown');
      const observation = classifyCarrier(withExternalStatus(input, status));
      return {
        jobId,
        liveness: observation.liveness,
        storedPhase: observation.storedPhase,
        observedMaxJournalSeq: observation.observedMaxJournalSeq,
      };
    });
  };
}
