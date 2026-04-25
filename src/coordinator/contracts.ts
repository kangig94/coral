import type {
  JobForkRequest,
  JobLaunchRequest,
  JobResumeRequest,
  LaunchDecision,
} from '../jobs/launch.js';
import type {
  LaunchCoordinatorPort,
  LaunchPool,
} from '../jobs/contracts/admission.js';
import type { ProviderDurableSpawner } from '../providers/cli-runner.js';
import type { JobProgressStore } from '../jobs/contracts/progress-store.js';
import type { JobProjectionDetail } from '../jobs/read-contract.js';
import type {
  JobProgress,
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
import type { AbortResult } from '../jobs/contracts/abort-registry.js';
import type { Runtime } from '../runtime/ports.js';
import type { SessionEntry } from '../sessions/entry.js';
import type { SessionLookup } from '../sessions/lookup.js';
import type { AppendEventsFn } from '../store/append.js';
import type { ProviderCatalog } from '../providers/catalog.js';
import type { PipelineAST } from '../workflow/ast.js';
import type { WorkflowCommand } from '../workflow/input.js';
import type { TypedEventBus } from './event-bus.js';

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

export type CoordinatorLaunchCoordinator = LaunchCoordinatorPort & ProviderDurableSpawner;

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
  launchCoordinator: CoordinatorLaunchCoordinator;
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

export type { EffortLevel };
export type { LaunchPool };
export type { ProviderSpec };
