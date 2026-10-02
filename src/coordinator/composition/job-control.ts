import type { AbortDecision, JobAbortRegistryPort } from '../../jobs/contracts/abort-registry.js';
import type { ProjectRequestPort } from '../contracts.js';
import type { LifecycleController } from '../lifecycle.js';
import type { JobStore } from '../../jobs/store.js';
import type { CoordinatorWorld } from './world.js';
import type { CanonicalWorkDir } from '../../runtime/canonical-work-dir.js';
import { jobInCallerScope, type JobScopeRelation, type ScopeCheckResult } from '../../jobs/scope.js';
import type { ShutdownReason } from '../../infra/shutdown-contract.js';
import type { ProviderStopCause } from '../../providers/contract.js';
import type { ProviderStopDecision } from '../services/provider-operation-reconciler.js';
import { abortCoordinatorJobs } from './job-abort.js';

export type CreateBackendControlDeps = {
  world: CoordinatorWorld;
  listExecutionServices: () => ProjectRequestPort[];
  getLifecycleController: () => LifecycleController | null;
  isLifecycleRunning: () => boolean;
  getProgressStore: () => JobStore;
  internalJobAbortRegistry: JobAbortRegistryPort;
  requestStops: (jobIds: readonly string[], cause: ProviderStopCause) => ProviderStopDecision;
};

export function createCoordinatorControl(deps: CreateBackendControlDeps): {
  abortJobs: (jobIds: string[]) => AbortDecision;
  scopeCheckJobs: (jobIds: string[], callerRoot: CanonicalWorkDir, relation: JobScopeRelation) => ScopeCheckResult;
  isDrainRequested: () => boolean;
  decideLegacyShutdown: () => { code: 'shutdown_unauthorized'; message: string };
  requestDrain: (reason: ShutdownReason) => void;
} {
  const { world, getProgressStore } = deps;
  const abortJobs = (jobIds: string[]): AbortDecision => abortCoordinatorJobs(jobIds, deps);

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
    const running = deps.isLifecycleRunning();
    world.idleTimer.requestDrain(reason);
    if (!running) {
      void deps
        .getLifecycleController()
        ?.shutdown(reason)
        .catch(() => {});
    }
  };

  return {
    abortJobs,
    scopeCheckJobs,
    isDrainRequested,
    decideLegacyShutdown: () => ({
      code: 'shutdown_unauthorized',
      message: 'Shutdown refused: the incumbent keeps serving, and the upgrade is deferred to automatic succession.',
    }),
    requestDrain,
  };
}
