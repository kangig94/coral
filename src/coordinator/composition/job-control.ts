// Bundles abort/scope job-control (lifecycleController-bound) with the drain admission gate (idleTimer-bound) as one control-plane helper. The two halves share zero state; if drain logic grows, split into drain-gate.ts rather than packing more concerns here.
import type { AbortResult, JobAbortRegistryPort } from '../../jobs/contracts/abort-registry.js';
import type { ProjectRequestPort } from '../contracts.js';
import type { LifecycleController } from '../lifecycle.js';
import type { JobStore } from '../../jobs/store.js';
import type { CoordinatorWorld } from './world.js';
import { containsWorkDir, type CanonicalWorkDir } from '../../runtime/canonical-work-dir.js';
import type { JobScopeRelation, ScopeCheckResult } from '../../transport/rpc/ports.js';

type CreateBackendControlDeps = {
  world: CoordinatorWorld;
  listExecutionServices: () => ProjectRequestPort[];
  getLifecycleController: () => LifecycleController | null;
  getProgressStore: () => JobStore;
  /** Coordinator-owned abort registry for internal KB jobs (source-import,
   * reindex). Consulted before returning `notFound` so that
   * `coral-cli abort <kb-job-id>` reaches the KB job's AbortController. */
  internalJobAbortRegistry: JobAbortRegistryPort;
};

export function createCoordinatorControl({
  world,
  listExecutionServices,
  getLifecycleController,
  getProgressStore,
  internalJobAbortRegistry,
}: CreateBackendControlDeps): {
  abortJobs: (jobIds: string[]) => AbortResult;
  scopeCheckJobs: (jobIds: string[], callerRoot: CanonicalWorkDir, relation: JobScopeRelation) => ScopeCheckResult;
  isDrainRequested: () => boolean;
  requestDrain: (reason: string) => void;
} {
  function abortJobs(jobIds: string[]): AbortResult {
    const pending = new Set(jobIds);
    const aborted: string[] = [];

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
    }

    if (pending.size > 0) {
      const result = internalJobAbortRegistry.abort([...pending]);
      for (const jobId of result.aborted) {
        if (!pending.has(jobId)) continue;
        pending.delete(jobId);
        aborted.push(jobId);
      }
    }

    return { aborted, notFound: [...pending] };
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

      const matches =
        status.jobKind === 'kb' ||
        (status.workDir !== null &&
          (relation === 'contains' ? containsWorkDir(callerRoot, status.workDir) : callerRoot === status.workDir));
      if (!matches) {
        mismatch.push(jobId);
        continue;
      }

      valid.push(jobId);
    }

    return { valid, missing, mismatch };
  }

  let drainRequested = false;

  const isDrainRequested = () => drainRequested;
  const requestDrain = (reason: string) => {
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
