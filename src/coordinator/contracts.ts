import type {
  JobForkRequest,
  JobLaunchRequest,
  JobResumeRequest,
  LaunchDecision,
} from '../jobs/launch.js';
import type { JobProgressStore, TerminalWriteOptions } from '../jobs/progress-store-contract.js';
import type { JobPhase } from '../jobs/phase.js';
import type { JobProjectionDetail } from '../jobs/read-contracts.js';
import type {
  AppServerRuntime,
  JobLaunch,
  JobProgress,
  JobRuntime,
  JobTerminalInput,
} from '../jobs/records.js';
import type { LaunchReadiness } from '../jobs/launch-readiness.js';
import type { WaitStreamEvent, WaitStreamOnceResult, WaitStreamRequest } from '../jobs/wait.js';
import type {
  ProviderServerLease,
  ProviderServerSpec,
  ProviderSpec,
} from '../providers/contract.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import type { EffortLevel } from '../providers/request-policy.js';
import type { AbortResult } from '../jobs/abort-result.js';
import type { Runtime } from '../runtime/ports.js';
import type { SessionEntry } from '../sessions/entry.js';
import type { SessionLookup } from '../sessions/lookup.js';
import type { AppendEventsFn } from '../store/append.js';
import type { ProviderCatalog } from '../providers/catalog.js';
import type { PipelineAST } from '../workflow/ast.js';
import type { WorkflowCommand } from '../workflow/input.js';
import type { TypedEventBus } from './event-bus.js';

export type ExecutionLaunchPool = 'default' | 'discuss' | 'curate';

type ExecIntent = JobLaunchRequest;
type ResumeIntent = JobResumeRequest;
type ForkIntent = JobForkRequest;

interface CoordinatorSessionOps {
  start(providerName: string, input: ExecIntent, ctx: InvocationContext): Promise<LaunchDecision>;
  resumeBySessionId(input: ResumeIntent, ctx: InvocationContext): Promise<LaunchDecision>;
  forkBySessionId(input: ForkIntent, ctx: InvocationContext): Promise<LaunchDecision>;
}

interface CoordinatorJobOps {
  abort(jobIds: string[]): AbortResult;
  waitStream(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent>;
  waitStreamOnce(jobId: string, timeoutMs?: number): Promise<WaitStreamOnceResult>;
  awaitLaunch(jobId: string, timeoutMs: number): Promise<LaunchReadiness>;
  list(providerName: string): ListResult;
}

interface CoordinatorWorkflowOps {
  executeWorkflow(
    providerName: string,
    ast: PipelineAST,
    input: WorkflowCommand,
    ctx: InvocationContext,
    workDir?: string,
  ): Promise<LaunchDecision>;
}

export type ProjectRequestPort = CoordinatorSessionOps & CoordinatorJobOps & CoordinatorWorkflowOps;

export interface ListResult {
  sessions: SessionEntry[];
}

export type ExecutionQueuedHandle = {
  outcome: 'queued';
  position: number;
  type: 'queued';
  queuePosition: number;
  waitForPermit: () => Promise<void>;
  cancel: () => void;
};

export type ExecutionAdmissionResult =
  | {
      outcome: 'admitted';
      permit: { type: 'immediate' };
      type: 'immediate';
    }
  | ExecutionQueuedHandle
  | 'queue_full';

type ExecutionSpawnDurableJobOptions = {
  provider: string;
  command: string;
  args: string[];
  prompt?: string;
  cwd?: string;
  onEvent?: (line: string) => void;
  signal?: AbortSignal;
  permitGranted?: boolean;
  pool?: ExecutionLaunchPool;
  extraEnv?: Record<string, string>;
  jobDir: string;
  onRuntimeRecord?: (record: JobRuntime) => void;
};

export interface ExecutionLaunchCoordinator {
  requestLaunch(jobId: string, provider: string, pool?: ExecutionLaunchPool): ExecutionAdmissionResult;
  releaseLaunch(jobId: string, pool?: ExecutionLaunchPool): void;
  cancelQueued(jobId: string, pool?: ExecutionLaunchPool): boolean;
  queuePosition(jobId: string, pool?: ExecutionLaunchPool): number | null;
  getActiveJobIds(pool?: ExecutionLaunchPool): string[];
  bindLaunchPermit(jobId: string, signal: AbortSignal, pool?: ExecutionLaunchPool): void;
  spawnDurableJob(options: ExecutionSpawnDurableJobOptions): Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
    aborted: boolean;
  }>;
  restoreActiveLaunch(jobId: string, provider: string, pool?: ExecutionLaunchPool): void;
  restoreQueuedLaunch(jobId: string, provider: string, pool?: ExecutionLaunchPool): ExecutionQueuedHandle;
}

export interface ExecutionProviderServerAttachment {
  rpc<R = unknown>(method: string, params: Record<string, unknown>): Promise<R>;
  subscribe(handler: (msg: { method: string; params?: Record<string, unknown> }) => void): () => void;
  closed: Promise<Error | void>;
}

export interface ExecutionProviderHostManager {
  acquireServer(spec: ProviderServerSpec, options?: { signal?: AbortSignal }): Promise<ProviderServerLease>;
  borrowLiveServer(
    spec: ProviderServerSpec,
    options: { serverGeneration?: number },
  ): Promise<ExecutionProviderServerAttachment | null>;
}

export type ExecutionServiceDeps = {
  runtime: Runtime;
  progressStore: JobProgressStore;
  bundleHash?: string;
  backendNamespace: string;
  providerHostManager: ExecutionProviderHostManager;
  launchCoordinator: ExecutionLaunchCoordinator;
  eventBus: TypedEventBus;
  providerRegistry: ProviderCatalog;
  pluginRegistry: {
    discoverPluginRoot: (namespace: string) => string | null;
  };
  appendEvents?: AppendEventsFn;
  loadJobProjectionDetail: (jobId: string) => JobProjectionDetail;
  readJobProgress: (jobId: string) => JobProgress[];
  subscribeJobEvents: (options: {
    afterSeq: number;
    jobIds: readonly string[];
    abortSignal?: AbortSignal;
  }) => AsyncIterable<JobProgress>;
  getCurrentJournalSeq: () => number;
  sessionLookup?: SessionLookup;
};

export interface RecoveryCapableService {
  finalizeInterruptedAppServerJob(
    launchRecord: JobLaunch,
    runtimeRecord: AppServerRuntime,
    context: { reason: 'restart' | 'handoff' },
  ): Promise<void>;
  adoptRunningJob(launchRecord: JobLaunch, runtimeRecord: JobRuntime): { cleanup: () => void };
  recoverQueuedJob(launchRecord: JobLaunch): string;
  interruptAppServerJob(launchRecord: JobLaunch, runtimeRecord: AppServerRuntime): Promise<void>;
  completeRecoveredJob(
    jobId: string,
    sessionId: string,
    result: JobTerminalInput,
    phase: JobPhase,
    options?: TerminalWriteOptions,
  ): void;
}

export type { EffortLevel };
export type { ProviderSpec };
