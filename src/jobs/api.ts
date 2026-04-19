import type { Database } from 'better-sqlite3';

import type { AbortResult } from '../shared/execution-contracts.js';
import type { ExecutionServiceLike, RecoveryCapableService } from '../coordinator/api.js';
import type { ProgressStore } from './job-store.js';
import type { RecoveryRegistry } from '../coordinator/composition/recovery-registry.js';
import type { CallerContext } from '../shared/request-context.js';
import type { JobStatusRecord } from './records.js';
import type { WaitStreamEvent, WaitStreamRequest } from './wait.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Runtime } from '../runtime/ports.js';
import type { JobLaunchRequest, JobResumeRequest, JobForkRequest } from './launch.js';
import type { RecoveryCoordinator } from './reconcile/coordinator.js';
import {
  listJobProjections as listJobProjectionsQuery,
  loadJobProjectionDetail as loadJobProjectionDetailQuery,
  readJobProgress as readJobProgressQuery,
  type JobProjectionDetail,
  type JobProgressRow,
} from '../store/queries/jobs.js';

export type JobsStartupDeps = {
  recoveryCoordinator: RecoveryCoordinator;
  namespace: string;
  bundleHash: string;
  runtime: Runtime;
  progressStore: ProgressStore;
  providerRegistry: ProviderRegistry;
  getRecoveryService: (ctx: CallerContext) => RecoveryCapableService;
  createCallerContext: (projectRoot: string) => CallerContext;
  assertStartupStillActive: () => void;
  log: (message: string) => void;
  cleanupStaleJobs: (currentBundleHash: string) => void;
};

type JobQuerySource =
  | Database
  | {
      loadJobProjectionDetail(jobId: string): JobProjectionDetail;
      readJobProgress(jobId: string): JobProgressRow[];
      listJobProjections?(): Array<{ jobId: string; status: JobStatusRecord }>;
    };

function isDatabase(value: JobQuerySource): value is Database {
  return typeof (value as Database).prepare === 'function';
}

function hasJournalQuerySurface(
  value: JobQuerySource,
): value is Extract<JobQuerySource, { loadJobProjectionDetail(jobId: string): unknown; readJobProgress(jobId: string): unknown }> {
  return (
    typeof (value as { loadJobProjectionDetail?: unknown }).loadJobProjectionDetail === 'function'
    && typeof (value as { readJobProgress?: unknown }).readJobProgress === 'function'
  );
}

function queryJobDetail(
  source: JobQuerySource,
  jobId: string,
): JobProjectionDetail {
  if (hasJournalQuerySurface(source)) {
    return source.loadJobProjectionDetail(jobId);
  }
  return loadJobProjectionDetailQuery(source, jobId);
}

function queryJobProgress(source: JobQuerySource, jobId: string): JobProgressRow[] {
  if (hasJournalQuerySurface(source)) {
    return source.readJobProgress(jobId);
  }
  return readJobProgressQuery(source, jobId);
}

export const jobsCommands = {
  start(
    service: Pick<ExecutionServiceLike, 'start'>,
    providerName: string,
    request: JobLaunchRequest,
    ctx: CallerContext,
  ): ReturnType<ExecutionServiceLike['start']> {
    return service.start(providerName, request, ctx);
  },
  resume(
    service: Pick<ExecutionServiceLike, 'resumeBySessionId'>,
    request: JobResumeRequest,
    ctx: CallerContext,
  ): ReturnType<ExecutionServiceLike['resumeBySessionId']> {
    return service.resumeBySessionId(request, ctx);
  },
  fork(
    service: Pick<ExecutionServiceLike, 'forkBySessionId'>,
    request: JobForkRequest,
    ctx: CallerContext,
  ): ReturnType<ExecutionServiceLike['forkBySessionId']> {
    return service.forkBySessionId(request, ctx);
  },
  abort(
    service: Pick<ExecutionServiceLike, 'abort'>,
    jobIds: string[],
  ): AbortResult {
    return service.abort(jobIds);
  },
} as const;

export const jobsQueries = {
  list(source: JobQuerySource): Array<{ jobId: string; status: JobStatusRecord }> {
    if (hasJournalQuerySurface(source) && typeof source.listJobProjections === 'function') {
      return source.listJobProjections();
    }
    if (isDatabase(source)) {
      return listJobProjectionsQuery(source);
    }
    return [];
  },
  detail(source: JobQuerySource, jobId: string): {
    status: JobStatusRecord | null;
    launch: JobProjectionDetail['launch'];
    runtime: JobProjectionDetail['runtime'];
    exit: JobProjectionDetail['exit'];
  } {
    return queryJobDetail(source, jobId);
  },
  scopeCheck(
    source: JobQuerySource,
    jobId: string,
    projectRoot: string,
    namespace: string,
    recoveryRegistry?: Pick<RecoveryRegistry, 'has'> | null,
  ): boolean {
    const status = queryJobDetail(source, jobId).status;
    if (!status) {
      return recoveryRegistry?.has(jobId) ?? false;
    }
    return status.projectRoot === projectRoot && status.backendNamespace === namespace;
  },
  awaitLaunch(service: Pick<ExecutionServiceLike, 'waitStream'>, jobId: string): AsyncGenerator<WaitStreamEvent> {
    return service.waitStream({ jobIds: [jobId], timeoutSeconds: 1 });
  },
  waitForTerminal(
    service: Pick<ExecutionServiceLike, 'waitStream'>,
    request: WaitStreamRequest,
  ): ReturnType<ExecutionServiceLike['waitStream']> {
    return service.waitStream(request);
  },
  progress(source: JobQuerySource, jobId: string): JobProgressRow[] {
    return queryJobProgress(source, jobId);
  },
} as const;

export const jobsReconcile = {
  async runStartup({
    recoveryCoordinator,
    ...deps
  }: JobsStartupDeps): Promise<void> {
    await recoveryCoordinator.runStartupRecovery(deps);
  },
} as const;

export { isLivePhase, isTerminalPhase, jobPhaseSchema } from './phase.js';
export { belongsToNamespace, isAppServerRuntime } from './records.js';
export type { ProgressStore } from './job-store.js';
export { AbortRegistry } from './shell/abort-registry.js';
export type { JobEvent } from './shell/event-subscription.js';
export { buildCoralInstruction } from './shell/instruction.js';
export { writeWorkflowResult } from './shell/result-artifact.js';
export {
  parseAgentMeta,
  parseAgentRef,
  resolveAgent,
  stripAgentMetadata,
  AgentNotFoundError,
  AgentNamespaceNotFoundError,
  InvalidAgentRefError,
} from './shell/agent-resolution.js';
export { createRecoveryCoordinator } from './reconcile/coordinator.js';
export type { RecoveryCoordinator } from './reconcile/coordinator.js';
export { createReplacementBackendOwnershipChecker } from './reconcile/ownership-checker.js';
export { listLiveJobs, markJobAsError } from './reconcile/job-helpers.js';
export { adoptOrphanedCrossNamespaceJobs } from './reconcile/cross-namespace-adoption.js';
export { StartupInterruptedError } from './reconcile/errors.js';
export type { AgentResolutionContext } from './shell/agent-resolution.js';
export type { JobProjectionDetail, JobProgressRow } from '../store/queries/jobs.js';
export type { JobLaunchRequest, JobResumeRequest, JobForkRequest, LaunchDecision } from './launch.js';
export type { JobPhase } from './phase.js';
export type {
  AppServerRuntimeRecord,
  JobLaunchRecord,
  JobProgressRecord,
  JobRuntimeRecord,
  JobStatusRecord,
  JobTerminalRecord,
  LaunchState,
  WorkflowResultMeta,
} from './records.js';
export type { WaitCursor, WaitStreamEvent, WaitStreamRequest } from './wait.js';
export type { AbortReason, TerminalOutcome } from './outcome.js';
