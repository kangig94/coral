// Bundles abort/scope job-control (lifecycleController-bound) with the drain admission gate (idleTimer-bound) as one control-plane helper. The two halves share zero state; if drain logic grows beyond the current 4 lines, split into job-control.ts + drain-gate.ts rather than packing more concerns here.
import type { AbortResult, JobAbortRegistryPort } from '../../jobs/contracts/abort-registry.js';
import { belongsToNamespace } from '../../jobs/records.js';
import type { ProjectRequestPort } from '../contracts.js';
import type { LifecycleController } from '../lifecycle.js';
import type { JobStore } from '../../jobs/store.js';
import type { CoordinatorWorld } from './world.js';
import type { ScopeCheckResult } from '../../transport/rpc/ports.js';

type CreateBackendControlDeps = {
  world: CoordinatorWorld;
  listExecutionServices: () => ProjectRequestPort[];
  getLifecycleController: () => LifecycleController | null;
  backendNamespace: string;
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
  scopeCheckJobs: (jobIds: string[], projectRoot: string, currentNamespace: string) => ScopeCheckResult;
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

  function scopeCheckJobs(jobIds: string[], projectRoot: string, currentNamespace: string): ScopeCheckResult {
    const valid: string[] = [];
    const missing: string[] = [];
    const mismatch: string[] = [];
    const recoveryRegistry = getLifecycleController()?.getRecoveryRegistry();
    const progressStore = getProgressStore();

    for (const jobId of jobIds) {
      const status = progressStore.readStatus(jobId);
      if (!status) {
        valid.push(jobId);
        missing.push(jobId);
        continue;
      }

      // KB jobs run against the shared corpus and belong to no single project,
      // so they stay abortable from any project's cwd (namespace still applies).
      if (status.projectRoot !== projectRoot && status.jobKind !== 'kb') {
        mismatch.push(jobId);
        continue;
      }

      if (belongsToNamespace(status, currentNamespace)) {
        valid.push(jobId);
        continue;
      }

      if (recoveryRegistry?.has(jobId)) {
        valid.push(jobId);
        continue;
      }

      mismatch.push(jobId);
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
