import type { Database } from 'better-sqlite3';

import type { AbortResult } from '../shared/execution-contracts.js';
import type { ExecutionServiceLike } from '../execution/backend-contracts.js';
import { createReplayCursor, type ProgressStore } from '../execution/progress-store.js';
import type { RecoveryRegistry } from '../execution/recovery-registry.js';
import type { CallerContext } from '../shared/request-context.js';
import type {
  JobPhase,
  JobStatusRecord,
  JobTerminalRecord,
  ProviderAction,
  ProviderInstruction,
  ProviderContinuityBlob,
  WaitStreamEvent,
  WaitStreamRequest,
  WorkflowResultMeta,
  UsageSummary,
} from '../shared/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Runtime } from '../runtime/ports.js';
import type { RecoveryCapableService } from '../execution/service.js';
import type { JobLaunchRequest, JobResumeRequest, JobForkRequest } from './launch.js';
import type { TerminalOutcome } from './outcome.js';
import type { RecoveryCoordinator } from './reconcile/coordinator.js';
import { loadJobProjectionDetail as loadJobProjectionDetailQuery, readJobProgress as readJobProgressQuery } from '../store/queries/jobs.js';

export type JobStatusRow = {
  jobId: string;
  phase: JobPhase;
  terminalJson: string | null;
  diagnosticsJson: string | null;
  parentJobId: string | null;
  workflowSlot: string | null;
  lastSeq: number;
};

// Phase 6: can diverge from JobLaunchRecord.
export type JobLaunchRow = {
  jobId: string;
  sessionId: string;
  provider: string;
  projectRoot: string;
  backendNamespace: string;
  bundleHash?: string;
  jobKind?: 'provider' | 'workflow';
  pool: string;
  enqueueSequence: number;
  providerAction: ProviderAction;
  request: {
    prompt: string;
    name?: string;
    model?: string;
    cwd: string;
    effort?: string;
    bypassPermissions: boolean;
    systemPrompt?: string;
    conversationRef?: string;
    instruction?: ProviderInstruction;
    coralEnv: Record<string, string>;
  };
  parentWorkflowJobId?: string;
  createdAt: string;
};

export type JobProgressRow = {
  jobId: string;
  sessionId: string;
  eventId: number;
  type: 'progress' | 'terminal';
  ts: string;
  message?: string;
  result?: JobTerminalRecord;
};

export type JobCliRuntimeRow = {
  transport?: 'durable-cli';
  pid: number;
  stdoutPath: string;
  stderrPath: string;
  startTime: string;
  providerMeta?: Record<string, unknown>;
  tailWatermark?: number;
};

export type JobAppServerRuntimeRow = {
  transport: 'app-server';
  startTime: string;
  providerMeta: {
    provider: string;
    leaseState: 'waiting' | 'acquired';
    serverGeneration?: number;
    providerContinuity?: ProviderContinuityBlob;
    recoveryPolicy: 'session_continuity_only';
  };
};

export type JobRuntimeRow = JobCliRuntimeRow | JobAppServerRuntimeRow | null;
export type JobExitRow = {
  outcome: TerminalOutcome;
  content: string;
  durationMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  nonResumable?: boolean;
  warnings?: string[];
  usage?: UsageSummary;
  workflow?: WorkflowResultMeta;
};

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
  | ProgressStore
  | Database
  | {
      loadJobProjectionDetail(jobId: string): {
        status: JobStatusRecord | null;
        launch: JobLaunchRow | null;
        runtime: JobRuntimeRow;
        exit: JobExitRow | null;
      };
      readJobProgress(jobId: string): JobProgressRow[];
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
): {
  status: JobStatusRecord | null;
  launch: JobLaunchRow | null;
  runtime: JobRuntimeRow;
  exit: JobExitRow | null;
} {
  if (hasJournalQuerySurface(source)) {
    return source.loadJobProjectionDetail(jobId);
  }
  if (isDatabase(source)) {
    return loadJobProjectionDetailQuery(source, jobId);
  }

  const status = source.readStatus(jobId);
  const launch = source.readLaunchRecord(jobId);
  const runtime = source.readRuntimeRecord(jobId);
  const exit = source.readTerminalPayload(jobId);
  return {
    status,
    launch:
      launch === null
        ? null
        : {
            ...launch,
            request: {
              ...launch.request,
              coralEnv: { ...launch.request.coralEnv },
              ...(launch.request.instruction ? { instruction: { ...launch.request.instruction } } : {}),
            },
          },
    runtime:
      runtime === null
        ? null
        : runtime.transport === 'app-server'
          ? {
              ...runtime,
              providerMeta: {
                ...runtime.providerMeta,
                ...(runtime.providerMeta.providerContinuity
                  ? { providerContinuity: { ...runtime.providerMeta.providerContinuity } }
                  : {}),
              },
            }
          : {
              ...runtime,
              ...(runtime.providerMeta ? { providerMeta: { ...runtime.providerMeta } } : {}),
            },
    exit:
      exit === null
        ? null
        : {
            outcome: exit.outcome,
            content: exit.content,
            durationMs: exit.durationMs,
            exitCode: exit.exitCode,
            nonResumable: exit.nonResumable,
            warnings: exit.warnings,
            usage: exit.usage ? { ...exit.usage } : undefined,
            workflow:
              exit.workflow === undefined
                ? undefined
                : {
                    steps: exit.workflow.steps.map((step) => ({ ...step })),
                  },
          },
  };
}

function queryJobProgress(source: JobQuerySource, jobId: string): JobProgressRow[] {
  if (hasJournalQuerySurface(source)) {
    return source.readJobProgress(jobId);
  }
  if (isDatabase(source)) {
    return readJobProgressQuery(source, jobId);
  }

  return source
    .replayFrom(jobId, 0, createReplayCursor())
    .filter((record): record is JobProgressRow => record.type === 'progress' || record.type === 'terminal')
    .map((record) => ({
      ...record,
      ...(record.result ? { result: { ...record.result } } : {}),
    }));
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
  list(progressStore: ProgressStore): Array<{ jobId: string; status: JobStatusRecord }> {
    return progressStore.listJobIds().flatMap((jobId) => {
      const status = progressStore.readStatus(jobId);
      return status ? [{ jobId, status }] : [];
    });
  },
  detail(source: JobQuerySource, jobId: string): {
    status: JobStatusRecord | null;
    launch: JobLaunchRow | null;
    runtime: JobRuntimeRow;
    exit: JobExitRow | null;
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
  adoptRunning<T>(fn: () => T): T {
    return fn();
  },
  recoverQueued<T>(fn: () => T): T {
    return fn();
  },
} as const;
