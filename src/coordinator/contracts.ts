import type { JobLaunchRequest, JobResumeRequest, LaunchDecision } from '../jobs/launch.js';
import type { LaunchCoordinatorPort } from '../jobs/contracts/admission.js';
import type { ProviderDurableSpawner } from '../providers/cli-runner.js';
import type { JobProgressStore } from '../jobs/contracts/job-store.js';
import type { JobProjectionDetail } from '../jobs/read-queries.js';
import type { JobEvent, LaunchReadiness } from '../jobs/records.js';
import type { WaitStreamEvent, WaitStreamOnceResult, WaitStreamRequest } from '../jobs/wait.js';
import type { ProviderServerLease, ProviderServerSpec } from '../providers/contract.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import type { AbortResult } from '../jobs/contracts/abort-registry.js';
import type { Runtime } from '../runtime/ports.js';
import type { SessionEntry } from '../sessions/entry.js';
import type { SessionLookup } from '../sessions/lookup.js';
import type { CommitEventsFn } from '../store/append.js';
import type { ProviderCatalog } from '../providers/catalog.js';
import type { PipelineAST } from '../workflow/ast.js';
import type { WorkflowCommand } from '../workflow/input.js';
import type { TypedEventBus } from './event-bus.js';

interface CoordinatorSessionOps {
  start(providerName: string, input: JobLaunchRequest, ctx: InvocationContext): Promise<LaunchDecision>;
  /**
   * In-process session continuation. No user-facing CLI/transport surface drives this — the
   * `-s` flag and `sessions.message` route were removed — but it is retained for in-process
   * callers: discuss participant turns, workflow steps, and recovery.
   */
  resumeBySessionId(input: JobResumeRequest, ctx: InvocationContext): Promise<LaunchDecision>;
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
  coordinatorCommit?: CommitEventsFn;
  loadJobProjectionDetail: (jobId: string) => JobProjectionDetail;
  readJobEvents: (jobId: string) => JobEvent[];
  subscribeJobEvents: (options: {
    afterSeq: number;
    jobIds: readonly string[];
    abortSignal?: AbortSignal;
  }) => AsyncIterable<JobEvent>;
  getCurrentJournalSeq: () => number;
  sessionLookup?: SessionLookup;
};
