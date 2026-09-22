import type {
  AbortAbandonment,
  AbortDecision,
  AbortHold,
  AbortRefusal,
  AbortResult,
  JobAbortRegistryPort,
} from '../../jobs/contracts/abort-registry.js';
import type { ProjectRequestPort } from '../contracts.js';
import type { LifecycleController } from '../lifecycle.js';
import type { JobStore } from '../../jobs/store.js';
import type { CoordinatorWorld } from './world.js';
import type { CanonicalWorkDir } from '../../runtime/canonical-work-dir.js';
import { jobInCallerScope, type JobScopeRelation, type ScopeCheckResult } from '../../jobs/scope.js';
import type { ShutdownReason } from '../../infra/shutdown-contract.js';
import type { ProviderStopCause } from '../../providers/contract.js';
import type { ProviderStopDecision } from '../services/provider-operation-reconciler.js';

type CreateBackendControlDeps = {
  world: CoordinatorWorld;
  listExecutionServices: () => ProjectRequestPort[];
  getLifecycleController: () => LifecycleController | null;
  getProgressStore: () => JobStore;
  internalJobAbortRegistry: JobAbortRegistryPort;
  requestStops: (jobIds: readonly string[], cause: ProviderStopCause) => ProviderStopDecision;
};

export function createCoordinatorControl({
  world,
  listExecutionServices,
  getLifecycleController,
  getProgressStore,
  internalJobAbortRegistry,
  requestStops,
}: CreateBackendControlDeps): {
  abortJobs: (jobIds: string[]) => AbortDecision;
  scopeCheckJobs: (jobIds: string[], callerRoot: CanonicalWorkDir, relation: JobScopeRelation) => ScopeCheckResult;
  isDrainRequested: () => boolean;
  requestDrain: (reason: ShutdownReason) => void;
} {
  function abortJobs(jobIds: string[]): AbortDecision {
    const pending = new Set(jobIds);
    const aborted: string[] = [];
    const refused: AbortRefusal[] = [];
    const held: AbortHold[] = [];
    const abandoned: AbortAbandonment[] = [];
    const providerStops = requestStops(jobIds, 'signal_abort');
    if (providerStops.kind === 'admission-closed') {
      return { kind: 'successor-owned', jobIds: providerStops.jobIds };
    }
    const recorded = new Set<string>();
    for (const [jobId, outcome] of providerStops.outcomes) {
      if (outcome.kind === 'recorded') {
        recorded.add(jobId);
      } else if (outcome.kind === 'unrecorded') {
        pending.delete(jobId);
        refused.push({
          jobId,
          reason: outcome.reason,
          nextStep:
            "The stop could not be recorded, so this job was not aborted and may still be running. Retry the abort. If the same refusal repeats, this coordinator cannot read the job's provider-operation record.",
        });
      }
    }

    const retainRefusals = (result: AbortResult): void => {
      for (const refusal of result.refused ?? []) {
        if (!pending.has(refusal.jobId)) continue;
        pending.delete(refusal.jobId);
        refused.push(refusal);
      }
    };

    const retainHolds = (result: AbortResult): void => {
      for (const hold of result.held ?? []) {
        if (!pending.has(hold.jobId)) continue;
        pending.delete(hold.jobId);
        held.push(hold);
      }
    };

    const retainAbandonments = (result: AbortResult): void => {
      for (const abandonment of result.abandoned ?? []) {
        if (!pending.has(abandonment.jobId)) continue;
        pending.delete(abandonment.jobId);
        abandoned.push(abandonment);
      }
    };

    const recoveryRegistry = getLifecycleController()?.getRecoveryRegistry();
    if (recoveryRegistry && recoveryRegistry.size > 0) {
      const registryJobIds: string[] = [];
      for (const jobId of pending) {
        if (recoveryRegistry.has(jobId)) {
          registryJobIds.push(jobId);
        }
      }
      if (registryJobIds.length > 0) {
        const result = recoveryRegistry.abort(registryJobIds);
        for (const jobId of result.aborted) {
          pending.delete(jobId);
          aborted.push(jobId);
        }
        retainRefusals(result);
        retainHolds(result);
        retainAbandonments(result);
      }
    }

    for (const service of listExecutionServices()) {
      if (pending.size === 0) break;
      const result = service.abort([...pending]);
      for (const jobId of result.aborted) {
        if (!pending.has(jobId)) continue;
        // Adopted recovery jobs are removed from registry entries, but the
        // registry object stays alive while the recovery death poller owns them.
        if (recoveryRegistry !== null && recoveryRegistry !== undefined) {
          recoveryRegistry.markCancelled(jobId);
        }
        pending.delete(jobId);
        aborted.push(jobId);
      }
      retainRefusals(result);
      retainHolds(result);
      retainAbandonments(result);
    }

    if (pending.size > 0) {
      const result = internalJobAbortRegistry.abort([...pending]);
      for (const jobId of result.aborted) {
        if (!pending.has(jobId)) continue;
        pending.delete(jobId);
        aborted.push(jobId);
      }
      retainRefusals(result);
      retainHolds(result);
      retainAbandonments(result);
    }

    for (const jobId of recorded) {
      if (!pending.delete(jobId)) continue;
      aborted.push(jobId);
    }

    return {
      kind: 'answered',
      result: {
        aborted,
        notFound: [...pending],
        ...(refused.length === 0 ? {} : { refused }),
        ...(held.length === 0 ? {} : { held }),
        ...(abandoned.length === 0 ? {} : { abandoned }),
      },
    };
  }

  function scopeCheckJobs(
    jobIds: string[],
    callerRoot: CanonicalWorkDir,
    relation: JobScopeRelation,
  ): ScopeCheckResult {
    const valid: string[] = [];
    const missing: string[] = [];
    const mismatch: string[] = [];
    const progressStore = getProgressStore();

    for (const jobId of jobIds) {
      const status = progressStore.readStatus(jobId);
      if (!status) {
        valid.push(jobId);
        missing.push(jobId);
        continue;
      }

      if (!jobInCallerScope(status, callerRoot, relation)) {
        mismatch.push(jobId);
        continue;
      }

      valid.push(jobId);
    }

    return { valid, missing, mismatch };
  }

  let drainRequested = false;

  const isDrainRequested = () => drainRequested;
  const requestDrain = (reason: ShutdownReason) => {
    drainRequested = true;
    world.idleTimer.requestDrain(reason);
  };

  return {
    abortJobs,
    scopeCheckJobs,
    isDrainRequested,
    requestDrain,
  };
}
