// Bundles abort/scope job-control (lifecycleController-bound) with the drain admission gate (idleTimer-bound) as one control-plane helper. The two halves share zero state; if drain logic grows beyond the current 4 lines, split into job-control.ts + drain-gate.ts rather than packing more concerns here.
import type { AbortResult } from '../../shared/execution-contracts.js';
import { belongsToNamespace } from '../../jobs/records.js';
import type { ExecutionServiceLike, ScopeCheckResult } from '../api.js';
import type { LifecycleController } from '../control.js';
import type { ProgressStore } from '../../store/progress-store.js';
import type { BackendWorld } from './backend-world.js';

type CreateBackendControlDeps = {
  world: BackendWorld;
  listExecutionServices: () => ExecutionServiceLike[];
  getLifecycleController: () => LifecycleController | null;
  backendNamespace: string;
  progressStore: ProgressStore;
};

export function createBackendControl({
  world,
  listExecutionServices,
  getLifecycleController,
  progressStore,
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
      const registryJobIds = [...pending].filter((id) => recoveryRegistry.has(id));
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

    return { aborted, notFound: [...pending] };
  }

  function scopeCheckJobs(jobIds: string[], projectRoot: string, currentNamespace: string): ScopeCheckResult {
    const valid: string[] = [];
    const missing: string[] = [];
    const mismatch: string[] = [];
    const recoveryRegistry = getLifecycleController()?.getRecoveryRegistry();

    for (const jobId of jobIds) {
      const status = progressStore.readStatus(jobId);
      if (!status) {
        valid.push(jobId);
        missing.push(jobId);
        continue;
      }

      if (status.projectRoot !== projectRoot) {
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
