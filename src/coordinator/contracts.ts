import type { LaunchDecision } from '../jobs/launch.js';
import type { JobPhase } from '../jobs/phase.js';
import type { JobProjectionDetail } from '../jobs/read-contracts.js';
import type {
  AppServerRuntime,
  JobLaunch,
  JobProgress,
  JobRuntime,
  JobTerminal,
  LaunchState,
} from '../jobs/views.js';
import type { WaitStreamEvent, WaitStreamRequest } from '../jobs/wait.js';
import type { ProviderInstruction } from '../providers/protocol.js';
import type { ProviderServerLease, ProviderServerSpec } from '../providers/provider-contracts.js';
import type { CallerContext } from '../shared/request-context.js';
import type { EffortLevel, WorkflowCommand } from '../shared/schemas.js';
import type { AbortResult } from '../shared/execution-contracts.js';
import type { ProgressStore } from '../jobs/api.js';
import type { Runtime } from '../runtime/ports.js';
import type { SessionEntry } from '../sessions/entry.js';
import type { SessionLookup } from '../sessions/lookup.js';
import type { AppendEventsFn } from '../store/append.js';
import type { ProviderRegistry } from '../providers/api.js';
import type { PipelineAST } from '../workflow/ast.js';
import type { TypedEventBus } from './event-bus.js';

export type ExecutionLaunchPool = 'default' | 'discuss' | 'curate';

type LaunchIntentBase = {
  prompt: string;
  name?: string;
  model?: string;
  cwd?: string;
  jobId?: string;
  workflowSlotId?: string;
  effort?: string;
  bypassPermissions?: boolean;
  systemPrompt?: string;
  instruction?: ProviderInstruction;
  parentWorkflowJobId?: string;
};

type ExecIntent = LaunchIntentBase & { agent?: string; pool?: ExecutionLaunchPool };
type ResumeIntent = LaunchIntentBase & {
  sessionId: string;
  provider?: string;
  agent?: string;
  pool?: ExecutionLaunchPool;
};
type ForkIntent = Omit<LaunchIntentBase, 'prompt'> & {
  sessionId: string;
  provider?: string;
  prompt?: string;
};

interface CoordinatorSessionOps {
  start(providerName: string, input: ExecIntent, ctx: CallerContext): Promise<LaunchDecision>;
  resumeBySessionId(input: ResumeIntent, ctx: CallerContext): Promise<LaunchDecision>;
  forkBySessionId(input: ForkIntent, ctx: CallerContext): Promise<LaunchDecision>;
}

interface CoordinatorJobOps {
  abort(jobIds: string[]): AbortResult;
  waitStream(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent>;
  waitStreamOnce(jobId: string, timeoutMs?: number): Promise<{ content: string; nonResumable: boolean }>;
  awaitLaunch(jobId: string, timeoutMs: number): Promise<LaunchState>;
  list(providerName: string): ListResult;
}

interface CoordinatorWorkflowOps {
  executeWorkflow(
    providerName: string,
    ast: PipelineAST,
    input: WorkflowCommand,
    ctx: CallerContext,
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
  progressStore: ProgressStore;
  bundleHash?: string;
  backendNamespace: string;
  providerHostManager: ExecutionProviderHostManager;
  launchCoordinator: ExecutionLaunchCoordinator;
  eventBus: TypedEventBus;
  providerRegistry: ProviderRegistry;
  pluginRegistry: {
    discoverPluginRoot: (namespace: string) => string | null;
  };
  appendEvents?: AppendEventsFn;
  loadJobProjectionDetail?: (jobId: string) => JobProjectionDetail;
  readJobProgress?: (jobId: string) => JobProgress[];
  subscribeJobEvents?: (options: {
    afterSeq: number;
    jobIds: readonly string[];
    abortSignal?: AbortSignal;
  }) => AsyncIterable<JobProgress>;
  getCurrentJournalSeq?: () => number;
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
    result: JobTerminal,
    phase: JobPhase,
    options?: { conversationRef?: string; nonResumable?: boolean },
  ): void;
}

export type { EffortLevel };
