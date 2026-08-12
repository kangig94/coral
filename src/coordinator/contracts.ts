import type {
  JobLaunchRequest,
  JobResumeRequest,
  ProviderSessionLaunchDecision,
  WorkflowLaunchDecision,
} from '../jobs/launch.js';
import type { LaunchCoordinatorPort } from '../jobs/contracts/admission.js';
import type { ProviderDurableSpawner } from '../providers/cli-runner.js';
import type { JobProgressStore } from '../jobs/contracts/job-store.js';
import type { JobProjectionDetail } from '../jobs/read-queries.js';
import type { JobEvent, LaunchReadiness } from '../jobs/records.js';
import type { JobPhase } from '../jobs/phase.js';
import type { WaitStreamEvent, WaitStreamOnceResult, WaitStreamRequest } from '../jobs/wait.js';
import type { ProviderStopCause, UsageSummary } from '../providers/contract.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import type { AbortResult } from '../jobs/contracts/abort-registry.js';
import type { Runtime } from '../runtime/ports.js';
import type { ProviderSession } from '../sessions/entry.js';
import type { CommitEventsFn } from '../store/append.js';
import type { ProviderBindingCatalog } from '../providers/catalog.js';
import type { PipelineAST } from '../workflow/ast.js';
import type { CanonicalWorkflowCommand } from '../workflow/compile.js';
import type { CanonicalWorkDir } from '../runtime/canonical-work-dir.js';
import type { TypedEventBus } from './event-bus.js';
import type { ChildPrincipalRegistry } from './child-principal-registry.js';
import type { AppServerProxyRoute } from '../jobs/contracts/app-server-proxy-route.js';
import type { ProviderOperationCleanupRegistrar } from '../jobs/contracts/provider-operation-lifecycle.js';

interface CoordinatorSessionOps {
  start(providerName: string, input: JobLaunchRequest, ctx: InvocationContext): Promise<ProviderSessionLaunchDecision>;
  resume(providerName: string, input: JobResumeRequest, ctx: InvocationContext): Promise<ProviderSessionLaunchDecision>;
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
    input: CanonicalWorkflowCommand,
    ctx: InvocationContext,
    workDir: CanonicalWorkDir,
  ): Promise<WorkflowLaunchDecision>;
}

export type ProjectRequestPort = CoordinatorSessionOps & CoordinatorJobOps & CoordinatorWorkflowOps;

export interface ListResult {
  sessions: ProviderSession[];
}

type CoordinatorLaunchCoordinator = LaunchCoordinatorPort & ProviderDurableSpawner;

export type ExecutionServiceDeps = {
  runtime: Runtime;
  progressStore: JobProgressStore;
  bundleHash?: string;
  backendNamespace: string;
  launchCoordinator: CoordinatorLaunchCoordinator;
  eventBus: TypedEventBus;
  providerRegistry: ProviderBindingCatalog;
  childPrincipalRegistry: ChildPrincipalRegistry;
  pluginRegistry: {
    discoverPluginRoot: (namespace: string) => string | null;
  };
  coordinatorCommit: CommitEventsFn;
  loadJobProjectionDetail: (jobId: string) => JobProjectionDetail;
  readJobEvents: (jobId: string) => JobEvent[];
  aggregateWorkflowUsage: (workflowJobId: string) => UsageSummary | undefined;
  subscribeJobEvents: (options: {
    afterSeq: number;
    jobIds: readonly string[];
    abortSignal?: AbortSignal;
  }) => AsyncIterable<JobEvent>;
  getCurrentJournalSeq: () => number;
  /** Tries to route an app-server operation through a live provider proxy set (W2.3). Optional because most
   *  compositions (every test, and any coordinator with no live set) never wire it — `LaunchOrchestrator`
   *  falls back to in-process execution when absent, identically to the port returning `null`. */
  appServerProxyRoute?: AppServerProxyRoute;
  /** The registry's abort-side capability (W2.3) — see `LaunchOrchestratorDeps.operations` in
   *  `jobs/shell/launch.ts` for the full contract. Optional for the same reason `appServerProxyRoute` is. */
  operations?: { stop(jobId: string, cause: ProviderStopCause): void };
  providerOperationCleanup?: ProviderOperationCleanupRegistrar;
  /**
   * Reports what is carrying each still-pending job, local-registry classification only. Optional because a
   * wait works without it — see `WaitCoordinatorDeps.observeCarriers` in `jobs/shell/wait.ts`.
   *
   * The result shape mirrors `CarrierWaitObservation` (`jobs/shell/wait.ts`) field-for-field rather than
   * importing it: this contracts module must stay a leaf per
   * `tests/invariants/api-export-scope.test.ts`, which bans `/shell/` and `/live/` imports here outright.
   */
  observeCarriers?: (jobIds: readonly string[]) => Promise<
    Array<
      Readonly<{
        jobId: string;
        liveness: 'live' | 'absent' | 'unknown';
        storedPhase: JobPhase;
        observedMaxJournalSeq: number;
      }>
    >
  >;
};
