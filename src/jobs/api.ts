import type { Database } from 'better-sqlite3';
import { z } from 'zod';

import type { AbortResult } from '../shared/execution-contracts.js';
import type { ProjectRequestPort, RecoveryCapableService } from '../coordinator/contracts.js';
import type { ProgressStore } from './job-store.js';
import type { RecoveryRegistry } from '../coordinator/composition/recovery-registry.js';
import type { CallerContext } from '../shared/request-context.js';
import { providerIdentPattern } from '../shared/identifiers.js';
import type { JobProgress, JobStatus } from './views.js';
import type { WaitCursor, WaitStreamEvent, WaitStreamRequest } from './wait.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Runtime } from '../runtime/ports.js';
import type { JobLaunchRequest, JobResumeRequest, JobForkRequest } from './launch.js';
import { jobPhaseSchema } from './phase.js';
import type { RecoveryCoordinator } from './reconcile/coordinator.js';
import type { JobProjectionDetail } from './read-contracts.js';
import type { SessionLookup } from '../sessions/lookup.js';
import { isWaitCursor } from './wait.js';
import {
  listJobProjections as listJobProjectionsQuery,
  loadJobProjectionDetail as loadJobProjectionDetailQuery,
  readJobProgress as readJobProgressQuery,
} from '../store/queries/jobs.js';
import { createDefaultStoreReadContext } from '../store/read-context.js';

const projectRootSchema = z.string().min(1, 'Project root is required');
const jobIdSchema = z.string().min(1, 'Job ID is required');
const waitCursorSchema = z.custom<WaitCursor>(isWaitCursor, {
  message: 'cursor must be a valid wait cursor',
});
const providerNameSchema = z
  .string()
  .regex(providerIdentPattern, 'Provider name must be lowercase letters, digits, or hyphens');

function parseBooleanQuery(value: unknown): boolean | undefined {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  if (value === undefined || value === '') return undefined;
  return value as boolean | undefined;
}

export const jobWaitSchema = z
  .object({
    jobIds: z.array(z.string().min(1)).min(1, 'At least one job required'),
    projectRoot: projectRootSchema,
    timeoutSeconds: z.number().int().min(1).max(1200).optional(),
    cursor: waitCursorSchema.optional(),
  })
  .strict();

export const jobAbortSchema = z
  .object({
    jobs: z.array(z.string().min(1)).min(1, 'At least one job required'),
    projectRoot: projectRootSchema,
  })
  .strict();

export const jobsListRequestSchema = z
  .object({
    projectRoot: projectRootSchema.optional(),
    phase: jobPhaseSchema.optional(),
    all: z.preprocess(parseBooleanQuery, z.boolean()).optional(),
    provider: providerNameSchema.optional(),
  })
  .strict();

export const jobDetailRequestSchema = z
  .object({
    jobId: jobIdSchema,
  })
  .strict();

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
  sessionLookup: SessionLookup;
};

type JobQuerySource =
  | Database
  | {
      loadJobProjectionDetail(jobId: string): JobProjectionDetail;
      readJobProgress(jobId: string): JobProgress[];
      listJobProjections?(): Array<{ jobId: string; status: JobStatus }>;
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
  return loadJobProjectionDetailQuery(source, jobId, createDefaultStoreReadContext());
}

function queryJobProgress(source: JobQuerySource, jobId: string): JobProgress[] {
  if (hasJournalQuerySurface(source)) {
    return source.readJobProgress(jobId);
  }
  return readJobProgressQuery(source, jobId, createDefaultStoreReadContext());
}

export const jobsCommands = {
  start(
    service: Pick<ProjectRequestPort, 'start'>,
    providerName: string,
    request: JobLaunchRequest,
    ctx: CallerContext,
  ): ReturnType<ProjectRequestPort['start']> {
    return service.start(providerName, request, ctx);
  },
  resume(
    service: Pick<ProjectRequestPort, 'resumeBySessionId'>,
    request: JobResumeRequest,
    ctx: CallerContext,
  ): ReturnType<ProjectRequestPort['resumeBySessionId']> {
    return service.resumeBySessionId(request, ctx);
  },
  fork(
    service: Pick<ProjectRequestPort, 'forkBySessionId'>,
    request: JobForkRequest,
    ctx: CallerContext,
  ): ReturnType<ProjectRequestPort['forkBySessionId']> {
    return service.forkBySessionId(request, ctx);
  },
  abort(
    service: Pick<ProjectRequestPort, 'abort'>,
    jobIds: string[],
  ): AbortResult {
    return service.abort(jobIds);
  },
} as const;

export const jobsQueries = {
  list(source: JobQuerySource): Array<{ jobId: string; status: JobStatus }> {
    if (hasJournalQuerySurface(source) && typeof source.listJobProjections === 'function') {
      return source.listJobProjections();
    }
    if (isDatabase(source)) {
      return listJobProjectionsQuery(source, createDefaultStoreReadContext());
    }
    return [];
  },
  detail(source: JobQuerySource, jobId: string): {
    status: JobStatus | null;
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
  openJobStream(service: Pick<ProjectRequestPort, 'waitStream'>, jobId: string): AsyncGenerator<WaitStreamEvent> {
    return service.waitStream({ jobIds: [jobId], timeoutSeconds: 1 });
  },
  waitForTerminal(
    service: Pick<ProjectRequestPort, 'waitStream'>,
    request: WaitStreamRequest,
  ): ReturnType<ProjectRequestPort['waitStream']> {
    return service.waitStream(request);
  },
  progress(source: JobQuerySource, jobId: string): JobProgress[] {
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
export { belongsToNamespace, isAppServerRuntime } from './views.js';
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
export type { JobProjectionDetail } from './read-contracts.js';
export type { JobLaunchRequest, JobResumeRequest, JobForkRequest, LaunchDecision } from './launch.js';
export type { JobPhase } from './phase.js';
export type {
  AppServerRuntime,
  JobExit,
  JobLaunch,
  JobProgress,
  JobRuntime,
  JobStatus,
  JobTerminal,
  LaunchState,
  WorkflowResultMeta,
} from './views.js';
export { parseSerializedWaitCursor, serializeWaitCursor } from './wait.js';
export type { WaitCursor, WaitStreamEvent, WaitStreamRequest } from './wait.js';
export type { AbortReason, TerminalOutcome } from './outcome.js';
