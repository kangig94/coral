import type { JobLaunchRequest, JobResumeRequest, LaunchDecision } from '../jobs/launch.js';
import type { LaunchCoordinatorPort } from '../jobs/contracts/admission.js';
import type { ProviderDurableSpawner } from '../providers/cli-runner.js';
import type { JobProgressStore } from '../jobs/contracts/job-store.js';
import type { JobProjectionDetail } from '../jobs/read-queries.js';
import type { JobEvent, LaunchReadiness } from '../jobs/records.js';
import type { WaitStreamEvent, WaitStreamOnceResult, WaitStreamRequest } from '../jobs/wait.js';
import type { ProviderServerLease, ProviderServerSpec, UsageSummary } from '../providers/contract.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import type { AbortResult } from '../jobs/contracts/abort-registry.js';
import type { Runtime } from '../runtime/ports.js';
import type { SessionEntry } from '../sessions/entry.js';
import type { CommitEventsFn } from '../store/append.js';
import type { ProviderCatalog } from '../providers/catalog.js';
import type { PipelineAST } from '../workflow/ast.js';
import type { WorkflowCommand } from '../workflow/input.js';
import type { TypedEventBus } from './event-bus.js';
import type { ChildPrincipalRegistry } from './child-principal-registry.js';
import type { ProviderCredentialSourceAvailabilityPort } from '../infra/provider-credential-sources.js';

interface CoordinatorSessionOps {
  start(providerName: string, input: JobLaunchRequest, ctx: InvocationContext): Promise<LaunchDecision>;
  resume(providerName: string, input: JobResumeRequest, ctx: InvocationContext): Promise<LaunchDecision>;
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

type CoordinatorLaunchCoordinator = LaunchCoordinatorPort & ProviderDurableSpawner;

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
  childPrincipalRegistry: ChildPrincipalRegistry;
  providerCredentialSourceAvailability: ProviderCredentialSourceAvailabilityPort;
  pluginRegistry: {
    discoverPluginRoot: (namespace: string) => string | null;
  };
  coordinatorCommit?: CommitEventsFn;
  loadJobProjectionDetail: (jobId: string) => JobProjectionDetail;
  readJobEvents: (jobId: string) => JobEvent[];
  aggregateWorkflowUsage: (workflowJobId: string) => UsageSummary | undefined;
  subscribeJobEvents: (options: {
    afterSeq: number;
    jobIds: readonly string[];
    abortSignal?: AbortSignal;
  }) => AsyncIterable<JobEvent>;
  getCurrentJournalSeq: () => number;
};
