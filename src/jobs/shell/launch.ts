import { bindProviderRunner, type ProviderDurableSpawner } from '../../providers/cli-runner.js';
import type {
  ProviderEventBody,
  ProviderRequest,
  ProviderRuntime,
  ProviderServerLease,
  ProviderServerSpec,
} from '../../providers/contract.js';
import type { BoundProvider, BoundProviderPreparedExecution } from '../../providers/bound-provider-contract.js';
import { errorMessage } from '../../infra/error-format.js';
import { nowIsoString } from '../../infra/time.js';
import { backendLog } from '../../infra/backend-log.js';
import { type ProviderSessionLaunchDecision, rejectLaunch } from '../launch.js';
import { isTerminalPhase, type JobPhase } from '../phase.js';
import type { JobLaunch, JobTerminalInput } from '../records.js';
import type { RetentionPolicy, ProviderSession } from '../../sessions/entry.js';
import { type AbortReason, type JobAbortedBody, type JobLaunchRejected } from '../outcome.js';
import type { JobQueueAdmittedBody, JobQueueQueuedBody } from '../event-bodies.js';
import { type AbortRegistry } from './abort-registry.js';
import { writeResultArtifact } from '../terminal/export.js';
import { CliBusyError } from '../../runtime/cli-busy.js';
import { isAbortError } from '../../runtime/abort.js';
import type {
  AcceptedAdmission,
  AdmissionResult,
  JobAdmissionPort,
  LaunchPool,
  QueuedHandle,
} from '../contracts/admission.js';
import type { ExecutionOwner } from '../../runtime/execution-owner.js';
import type { DiscussionRunDescriptor } from '../discussion-run.js';
import type { JobProgressStore, TerminalWriteOptions } from '../contracts/job-store.js';
import type { Runtime } from '../../runtime/ports.js';
import type { SessionInitialLaunchPort, SessionJobClaimPort } from '../../sessions/contracts.js';
import type { CoralEventInput } from '../../store/envelope.js';
import type { CommitEventsFn } from '../../store/append.js';
import { consumeJobStream } from './continuity-consumer.js';
import { appendJobTerminalRecorded, failedTerminalOutcome } from '../terminal/recording.js';
import { SessionClaimError } from '../../sessions/claim-error.js';
import { toProviderRequest } from '../provider-request.js';
import { TerminalWriteError } from '../terminal/write-error.js';
import { buildJobEventRefs } from '../refs.js';
import { resolveEquippedTools } from '../../expansion/equipped-tools.js';
import { applyInjectBundle } from '../../providers/inject.js';
import { ProviderBindingRuntimeError } from '../../providers/contracts/binding.js';
import type { ProviderBindingCatalog } from '../../providers/catalog.js';
import { jobLaunchRequestedEvent } from '../store.js';

const QUEUE_FULL_MESSAGE = 'All slots and queue are full. Try again later.';
type LauncherJobEventBody = JobQueueAdmittedBody | JobQueueQueuedBody | JobAbortedBody;

function missingContinuityMiddleware(method: keyof NonNullable<ProviderRuntime['continuityBridge']>): never {
  throw new Error(`runtime.continuityBridge.${method}() called without sessionContinuity() middleware.`);
}

const NOOP_CONTINUITY_BRIDGE: NonNullable<ProviderRuntime['continuityBridge']> = {
  checkpoint: () => missingContinuityMiddleware('checkpoint'),
  transportClosed: () => missingContinuityMiddleware('transportClosed'),
};

export interface LaunchOrchestratorDeps {
  abortRegistry: AbortRegistry;
  progressStore: JobProgressStore;
  sessionManager: SessionJobClaimPort & SessionInitialLaunchPort;
  launchAdmission: JobAdmissionPort;
  durableSpawner: ProviderDurableSpawner;
  providerRegistry: ProviderBindingCatalog;
  runtime: Pick<Runtime, 'time' | 'ids' | 'storage' | 'env' | 'paths'>;
  coordinatorCommit: CommitEventsFn;
  backendNamespace: string;
  bundleHash: string;
  jobPools: Map<string, LaunchPool>;
  getEventMetadata?: () => Pick<CoralEventInput, 'correlationId' | 'namespace' | 'project'> | null;
  terminalMaterializer: {
    recordProviderTerminal(
      progressStore: JobProgressStore,
      terminal: Extract<ProviderEventBody, { kind: 'terminal' }>,
      options: {
        readonly jobId: string;
        readonly sessionId: string;
        readonly namespace?: string;
        readonly project?: string;
        readonly correlationId?: string;
        readonly parentJobId?: string;
        readonly workflowSlotId?: string;
      },
    ): void;
  };
  acquireServer: (
    spec: ProviderServerSpec,
    options?: { jobId?: string; signal?: AbortSignal },
  ) => Promise<ProviderServerLease>;
}

type ProviderLaunchOptions = {
  pool?: LaunchPool;
  projectRoot?: string;
  parentWorkflowJobId?: string;
  workflowSlotId?: string;
  workflowSlotGeneration?: number;
  replacesWorkflowJobId?: string;
  retention?: RetentionPolicy;
  protectedEnv?: Record<string, string>;
  owner?: ExecutionOwner;
  discussionRun?: DiscussionRunDescriptor;
};

export class LaunchOrchestrator {
  // Tracks jobs whose runtime has called `acquireServer` (i.e. app-server
  // transport). Quiesce-for-handoff acts on this set: any active CLI/durable
  // jobs not in the set keep the existing handoff preservation behavior.
  private readonly appServerJobs = new Set<string>();
  // Set when shutdown is in handoff mode. Captured callbacks for matched job
  // IDs short-circuit so the dying daemon does not write a terminal record,
  // result artifact, release admission, remove abort registry entries,
  // delete job-pool entries, or release session continuity/claim.
  private readonly quiescedAppServerJobs = new Set<string>();

  private readonly deps: LaunchOrchestratorDeps;
  constructor(deps: LaunchOrchestratorDeps) {
    this.deps = deps;
  }

  /**
   * Synchronously detach durable terminal/completion side effects for active
   * app-server jobs so a subsequent provider-host drain cannot mutate state.
   *
   * No awaits-that-can-hang: the function flips an in-memory flag for matching
   * job IDs and returns immediately. Continuity checkpoints up to this call
   * have already committed; subsequent stream events on the orphaned consumer
   * loop fall on no-op callbacks.
   */
  quiesceAppServerJobsForHandoff(_signal: AbortSignal): Promise<void> {
    for (const jobId of this.appServerJobs) {
      this.quiescedAppServerJobs.add(jobId);
    }
    return Promise.resolve();
  }

  private resolveEventMetadata(
    jobId: string,
    projectRoot?: string,
  ): Pick<CoralEventInput, 'correlationId' | 'namespace' | 'project'> {
    const caller = this.deps.getEventMetadata?.() ?? null;
    if (caller) {
      return caller;
    }

    const launch = this.deps.progressStore.readLaunchProjection(jobId);
    const status = this.deps.progressStore.readStatus(jobId);
    return {
      namespace: launch?.backendNamespace ?? status?.backendNamespace ?? this.deps.backendNamespace,
      project: launch?.projectRoot ?? status?.projectRoot ?? projectRoot,
      correlationId: undefined,
    };
  }

  private appendJobEvent(
    jobId: string,
    sessionId: string,
    type: CoralEventInput['type'],
    body: LauncherJobEventBody,
    options: {
      parentJobId?: string;
      workflowSlotId?: string;
      projectRoot?: string;
    } = {},
  ): void {
    const metadata = this.resolveEventMetadata(jobId, options.projectRoot);
    this.deps.progressStore.commit((c) => {
      c.append({
        type,
        stream: { kind: 'job', id: jobId },
        namespace: metadata.namespace,
        project: metadata.project,
        correlationId: metadata.correlationId,
        refs: buildJobEventRefs({
          jobId,
          sessionId,
          parentJobId: options.parentJobId,
          workflowSlotId: options.workflowSlotId,
        }),
        bodyVersion: 1,
        body,
      });
      return undefined;
    });
  }

  private appendProgressEvent(jobId: string, sessionId: string, message: string): void {
    this.deps.progressStore.appendProgress(jobId, sessionId, message);
  }

  private appendLaunchRejectedTerminal(
    jobId: string,
    sessionId: string,
    body: JobLaunchRejected,
    options: {
      parentJobId?: string;
      workflowSlotId?: string;
      projectRoot?: string;
    } = {},
  ): void {
    const metadata = this.resolveEventMetadata(jobId, options.projectRoot);
    // Spec §6.1 line 813: workflow children carry `refs.workflowId` pointing at
    // the workflow stream. Convention: parentJobId === workflowId for children.
    const workflowId = options.parentJobId;
    try {
      this.deps.progressStore.commit((c) => {
        const cause = c.append({
          type: 'job.launch.rejected',
          stream: { kind: 'job', id: jobId },
          namespace: metadata.namespace,
          project: metadata.project,
          correlationId: metadata.correlationId,
          refs: buildJobEventRefs({
            jobId,
            sessionId,
            parentJobId: options.parentJobId,
            workflowId,
            workflowSlotId: options.workflowSlotId,
          }),
          bodyVersion: 1,
          body,
        });
        appendJobTerminalRecorded(c, {
          jobId,
          sessionId,
          namespace: metadata.namespace,
          project: metadata.project,
          correlationId: metadata.correlationId,
          parentJobId: options.parentJobId,
          workflowId,
          workflowSlotId: options.workflowSlotId,
          terminal: {
            content: '',
            outcome: failedTerminalOutcome(cause),
            durationMs: 0,
          },
        });
        return undefined;
      });
    } catch (error: unknown) {
      throw new TerminalWriteError(jobId, error);
    }
  }

  launchInitialProviderJob(
    provider: BoundProvider,
    preparedSession: ProviderSession,
    request: ProviderRequest,
    opts: Omit<ProviderLaunchOptions, 'protectedEnv'> & {
      owner: ExecutionOwner;
      requestedJobId?: string;
      mintProtectedEnv: (jobId: string) => Record<string, string>;
    },
  ): ProviderSessionLaunchDecision {
    const { jobPools } = this.deps;
    const pool = opts.pool ?? 'default';
    const jobId = opts.requestedJobId ?? this.deps.runtime.ids.uuid();
    const admission = this.reserveAdmission(jobId, provider.name, opts.owner, pool);
    if (admission === 'queue_full') {
      jobPools.delete(jobId);
      return rejectLaunch('busy', QUEUE_FULL_MESSAGE);
    }

    const { hostedRequest, launch, projectRoot } = this.buildProviderLaunch(
      provider,
      preparedSession.sessionId,
      jobId,
      request,
      opts,
    );
    const metadata = this.resolveEventMetadata(jobId, projectRoot);

    try {
      this.deps.coordinatorCommit((commit) => {
        this.deps.sessionManager.appendPreparedClaim(commit, preparedSession, jobId);
        commit.append(jobLaunchRequestedEvent(jobId, launch));
        commit.append({
          type: admission.type === 'queued' ? 'job.queue.queued' : 'job.queue.admitted',
          stream: { kind: 'job', id: jobId },
          namespace: metadata.namespace,
          project: metadata.project,
          correlationId: metadata.correlationId,
          refs: buildJobEventRefs({ jobId, sessionId: preparedSession.sessionId }),
          bodyVersion: 1,
          body:
            admission.type === 'queued'
              ? { queuePosition: admission.queuePosition, runningJobIds: [] }
              : { queuePosition: 0 },
        });
        return undefined;
      });
    } catch (error: unknown) {
      this.releaseAdmissionReservation(jobId, admission, pool);
      jobPools.delete(jobId);
      throw error;
    }

    this.activateCommittedProviderLaunch({
      provider,
      sessionId: preparedSession.sessionId,
      jobId,
      request: hostedRequest,
      admission,
      pool,
      mintProtectedEnv: opts.mintProtectedEnv,
    });
    return {
      kind: 'provider-session',
      status: admission.type === 'queued' ? 'queued' : 'running',
      jobId,
      sessionId: preparedSession.sessionId,
    };
  }

  private reserveAdmission(jobId: string, provider: string, owner: ExecutionOwner, pool: LaunchPool): AdmissionResult {
    const admission = this.deps.launchAdmission.requestLaunch(jobId, provider, owner, pool);
    if (admission !== 'queue_full') {
      this.deps.jobPools.set(jobId, pool);
    }
    return admission;
  }

  private releaseAdmissionReservation(jobId: string, admission: AcceptedAdmission, pool: LaunchPool): void {
    if (admission.type === 'queued') {
      const waitForPermit = admission.waitForPermit();
      const canceled = admission.cancel();
      void waitForPermit.catch((cleanupError: unknown) => {
        backendLog.warn(`Queued permit cleanup failed for ${jobId}: ${errorMessage(cleanupError)}`);
      });
      if (!canceled) {
        // The queue may have admitted this exact reservation during a synchronous
        // setup callback. In that case it is active and must be released.
        this.deps.launchAdmission.releaseLaunch(jobId, pool);
      }
      return;
    }
    this.deps.launchAdmission.releaseLaunch(jobId, pool);
  }

  private buildProviderLaunch(
    provider: BoundProvider,
    sessionId: string,
    jobId: string,
    request: ProviderRequest,
    opts: ProviderLaunchOptions,
  ): { hostedRequest: ProviderRequest; launch: JobLaunch; pool: LaunchPool; projectRoot: string } {
    const pool = opts.pool ?? 'default';
    const projectRoot = opts.projectRoot ?? request.cwd ?? '';
    const hostedRequest: ProviderRequest = {
      ...request,
      coralEnv: {
        ...request.coralEnv,
        CORAL_JOB_ID: jobId,
        CORAL_SESSION_ID: sessionId,
      },
    };
    return {
      hostedRequest,
      pool,
      projectRoot,
      launch: {
        jobId,
        owner: opts.owner ?? { kind: 'provider-session', id: sessionId },
        ...(opts.discussionRun === undefined ? {} : { discussionRun: opts.discussionRun }),
        sessionId,
        provider: provider.name,
        providerAction: request.action,
        projectRoot,
        backendNamespace: this.deps.backendNamespace,
        bundleHash: this.deps.bundleHash,
        jobKind: 'provider',
        pool,
        enqueueSequence: this.deps.progressStore.nextEnqueueSequence(),
        request: {
          prompt: hostedRequest.prompt,
          name: hostedRequest.name,
          model: hostedRequest.model,
          cwd: hostedRequest.cwd ?? '',
          effort: hostedRequest.effort,
          bypassPermissions: hostedRequest.bypassPermissions,
          systemPrompt: hostedRequest.systemPrompt,
          instruction: hostedRequest.instruction,
          ...(opts.retention !== undefined ? { retention: opts.retention } : {}),
          coralEnv: hostedRequest.coralEnv,
        },
        parentWorkflowJobId: opts.parentWorkflowJobId,
        workflowSlotId: opts.workflowSlotId,
        workflowSlotGeneration: opts.workflowSlotGeneration,
        replacesWorkflowJobId: opts.replacesWorkflowJobId,
        createdAt: nowIsoString(this.deps.runtime.time),
      },
    };
  }

  launchResumedProviderJob(
    provider: BoundProvider,
    session: ProviderSession,
    request: ProviderRequest,
    opts: ProviderLaunchOptions & {
      owner: ExecutionOwner;
      expectedVersion: number;
      sessionBusyMessage: string;
      requestedJobId?: string;
      mintProtectedEnv: (jobId: string) => Record<string, string>;
    },
  ): ProviderSessionLaunchDecision {
    const { jobPools } = this.deps;
    const pool = opts.pool ?? 'default';
    const jobId = opts.requestedJobId ?? this.deps.runtime.ids.uuid();
    const admission = this.reserveAdmission(jobId, provider.name, opts.owner, pool);
    if (admission === 'queue_full') {
      jobPools.delete(jobId);
      return rejectLaunch('busy', QUEUE_FULL_MESSAGE);
    }

    const built = this.buildProviderLaunch(provider, session.sessionId, jobId, request, opts);
    const metadata = this.resolveEventMetadata(jobId, built.projectRoot);
    let claimedSession: ProviderSession | undefined;
    try {
      this.deps.coordinatorCommit((commit) => {
        claimedSession = this.deps.sessionManager.appendJobClaim(commit, {
          sessionId: session.sessionId,
          jobId,
          expectedVersion: opts.expectedVersion,
        });
        commit.append(jobLaunchRequestedEvent(jobId, built.launch));
        commit.append({
          type: admission.type === 'queued' ? 'job.queue.queued' : 'job.queue.admitted',
          stream: { kind: 'job', id: jobId },
          namespace: metadata.namespace,
          project: metadata.project,
          correlationId: metadata.correlationId,
          refs: buildJobEventRefs({
            jobId,
            sessionId: session.sessionId,
            parentJobId: opts.parentWorkflowJobId,
            workflowId: opts.parentWorkflowJobId,
            workflowSlotId: opts.workflowSlotId,
          }),
          bodyVersion: 1,
          body:
            admission.type === 'queued'
              ? { queuePosition: admission.queuePosition, runningJobIds: [] }
              : { queuePosition: 0 },
        });
        return undefined;
      });
    } catch (error: unknown) {
      this.releaseAdmissionReservation(jobId, admission, pool);
      jobPools.delete(jobId);

      if (error instanceof SessionClaimError) {
        return rejectLaunch('session_busy', opts.sessionBusyMessage);
      }
      throw error;
    }
    if (claimedSession === undefined) {
      const error = new Error(`Resume transaction produced no session claim for job ${jobId}.`);
      this.finalizeCommittedLaunchSetupFailure(jobId, session.sessionId, admission, pool, error);
      throw error;
    }
    this.activateCommittedProviderLaunch({
      provider,
      sessionId: session.sessionId,
      jobId,
      request: built.hostedRequest,
      admission,
      pool,
      committedSession: claimedSession,
      mintProtectedEnv: opts.mintProtectedEnv,
    });
    return {
      kind: 'provider-session',
      status: admission.type === 'queued' ? 'queued' : 'running',
      jobId,
      sessionId: session.sessionId,
    };
  }

  launchWorkflowReplacement(
    provider: BoundProvider,
    session: ProviderSession,
    request: ProviderRequest,
    opts: {
      owner: Extract<ExecutionOwner, { kind: 'workflow' }>;
      parentWorkflowJobId: string;
      workflowSlotId: string;
      workflowSlotGeneration: number;
      replacesWorkflowJobId: string;
      pool?: LaunchPool;
      projectRoot: string;
      mintProtectedEnv: (jobId: string) => Record<string, string>;
    },
  ): ProviderSessionLaunchDecision {
    const pool = opts.pool ?? 'default';
    const jobId = this.deps.runtime.ids.uuid();
    const admission = this.reserveAdmission(jobId, provider.name, opts.owner, pool);
    if (admission === 'queue_full') {
      this.deps.jobPools.delete(jobId);
      return rejectLaunch('busy', QUEUE_FULL_MESSAGE);
    }
    const built = this.buildProviderLaunch(provider, session.sessionId, jobId, request, {
      ...opts,
      pool,
    });
    const metadata = this.resolveEventMetadata(jobId, opts.projectRoot);
    let claimedSession: ProviderSession | undefined;
    try {
      this.deps.coordinatorCommit((commit) => {
        claimedSession = this.deps.sessionManager.appendContinuationReplacementClaim(commit, {
          sessionId: session.sessionId,
          staleJobId: opts.replacesWorkflowJobId,
          resumedJobId: jobId,
          workflowId: opts.parentWorkflowJobId,
          workflowSlotId: opts.workflowSlotId,
          replacementGeneration: opts.workflowSlotGeneration,
          expectedVersion: session.version,
        });
        commit.append(jobLaunchRequestedEvent(jobId, built.launch));
        commit.append({
          type: admission.type === 'queued' ? 'job.queue.queued' : 'job.queue.admitted',
          stream: { kind: 'job', id: jobId },
          namespace: metadata.namespace,
          project: metadata.project,
          correlationId: metadata.correlationId,
          refs: buildJobEventRefs({
            jobId,
            sessionId: session.sessionId,
            parentJobId: opts.parentWorkflowJobId,
            workflowId: opts.parentWorkflowJobId,
            workflowSlotId: opts.workflowSlotId,
          }),
          bodyVersion: 1,
          body:
            admission.type === 'queued'
              ? { queuePosition: admission.queuePosition, runningJobIds: [] }
              : { queuePosition: 0 },
        });
        return undefined;
      });
    } catch (error: unknown) {
      this.releaseAdmissionReservation(jobId, admission, pool);
      this.deps.jobPools.delete(jobId);
      throw error;
    }
    if (claimedSession === undefined) {
      const error = new Error(`Workflow replacement transaction produced no session claim for job ${jobId}.`);
      this.finalizeCommittedLaunchSetupFailure(jobId, session.sessionId, admission, pool, error);
      throw error;
    }
    this.activateCommittedProviderLaunch({
      provider,
      sessionId: session.sessionId,
      jobId,
      request: built.hostedRequest,
      admission,
      pool,
      committedSession: claimedSession,
      mintProtectedEnv: opts.mintProtectedEnv,
    });
    return {
      kind: 'provider-session',
      status: admission.type === 'queued' ? 'queued' : 'running',
      jobId,
      sessionId: session.sessionId,
    };
  }

  private activateCommittedProviderLaunch(input: {
    provider: BoundProvider;
    sessionId: string;
    jobId: string;
    request: ProviderRequest;
    admission: AcceptedAdmission;
    pool: LaunchPool;
    committedSession?: ProviderSession;
    mintProtectedEnv: (jobId: string) => Record<string, string>;
  }): void {
    try {
      if (input.committedSession !== undefined) {
        this.deps.sessionManager.observeCommittedEntry(input.committedSession);
      }
      this.deps.abortRegistry.register(input.jobId);
      if (this.deps.abortRegistry.getSignal(input.jobId) === null) {
        throw new Error(`Abort registration produced no signal for committed job ${input.jobId}.`);
      }
      this.deps.runtime.storage.mkdirSync(this.deps.progressStore.jobDir(input.jobId), { recursive: true });
      if (input.admission.type === 'queued') {
        this.appendProgressEvent(input.jobId, input.sessionId, `queued (position ${input.admission.queuePosition})`);
      }
      const protectedEnv = input.mintProtectedEnv(input.jobId);
      this.runAsync(
        input.provider,
        input.sessionId,
        input.jobId,
        input.request,
        input.admission,
        input.pool,
        protectedEnv,
      );
    } catch (error: unknown) {
      this.finalizeCommittedLaunchSetupFailure(input.jobId, input.sessionId, input.admission, input.pool, error);
      throw error;
    }
  }

  private finalizeCommittedLaunchSetupFailure(
    jobId: string,
    sessionId: string,
    admission: AcceptedAdmission,
    pool: LaunchPool,
    error: unknown,
  ): void {
    const signal = this.deps.abortRegistry.getSignal(jobId) ?? new AbortController().signal;
    try {
      this.handleProviderJobError(jobId, sessionId, signal, error);
    } catch (finalizationError: unknown) {
      backendLog.error(
        `Failed to terminalize committed provider launch ${jobId}: ${errorMessage(finalizationError)}`,
        finalizationError,
      );
    }

    // Every cleanup is deliberately idempotent: successful terminalization has
    // already performed the first three, while a failed terminal write has not.
    this.deps.abortRegistry.remove(jobId);
    this.deps.jobPools.delete(jobId);
    try {
      this.deps.sessionManager.releaseJob(sessionId, jobId);
    } catch (cleanupError: unknown) {
      backendLog.error(`Failed to release session claim for setup-failed job ${jobId}: ${errorMessage(cleanupError)}`);
    }
    this.releaseAdmissionReservation(jobId, admission, pool);
  }

  runAsync(
    provider: BoundProvider,
    sessionId: string,
    jobId: string,
    request: ProviderRequest,
    admission: AcceptedAdmission,
    pool: LaunchPool,
    protectedEnv?: Record<string, string>,
  ): void {
    const { abortRegistry, launchAdmission } = this.deps;
    const signal = abortRegistry.getSignal(jobId);
    if (!signal) {
      if (admission.type === 'queued') {
        admission.cancel();
      } else {
        launchAdmission.releaseLaunch(jobId, pool);
      }
      return;
    }

    void (async () => {
      let permitAcquired = admission.type === 'immediate';

      try {
        if (admission.type === 'queued') {
          const queueOutcome = await this.waitForQueuedPermit(admission, signal);
          if (queueOutcome === 'aborted') {
            this.finishQueuedAbort(jobId, sessionId, 'queue_shutdown');
            return;
          }

          permitAcquired = true;
          this.appendJobEvent(jobId, sessionId, 'job.queue.admitted', {});
          this.appendProgressEvent(jobId, sessionId, 'dequeued, launching');
        }

        await this.executeJob(provider, request, jobId, sessionId, signal, pool, protectedEnv);
      } catch (error: unknown) {
        if (error instanceof TerminalWriteError) {
          backendLog.error(error.message, error.cause);
          return;
        }
        if (this.quiescedAppServerJobs.has(jobId)) {
          return;
        }
        try {
          this.handleProviderJobError(jobId, sessionId, signal, error);
        } catch (finalizeError: unknown) {
          if (finalizeError instanceof TerminalWriteError) {
            backendLog.error(finalizeError.message, finalizeError.cause);
            return;
          }
          throw finalizeError;
        }
      } finally {
        if (permitAcquired && !this.quiescedAppServerJobs.has(jobId)) {
          launchAdmission.releaseLaunch(jobId, pool);
        }
      }
    })();
  }

  runRecoveredQueuedJob(
    provider: BoundProvider,
    launchRecord: JobLaunch,
    admission: QueuedHandle,
    pool: LaunchPool,
    protectedEnv: Readonly<Record<string, string>>,
  ): void {
    const { abortRegistry, launchAdmission } = this.deps;
    const jobId = launchRecord.jobId;
    const sessionId = launchRecord.sessionId;
    if (sessionId === null) {
      throw new Error(`Recovered queued job ${jobId} requires a provider session id.`);
    }
    const signal = abortRegistry.getSignal(jobId);
    if (!signal) {
      admission.cancel();
      return;
    }

    void (async () => {
      try {
        const queueOutcome = await this.waitForQueuedPermit(admission, signal);
        if (queueOutcome === 'aborted') {
          this.finishQueuedAbort(jobId, sessionId, 'queue_shutdown');
          return;
        }

        this.appendJobEvent(jobId, sessionId, 'job.queue.admitted', {});
        this.appendProgressEvent(jobId, sessionId, 'dequeued, launching');

        const session = this.deps.sessionManager.get(provider.name, sessionId);
        if (session === null) {
          throw new Error(`Recovered queued job ${jobId} has no provider session snapshot.`);
        }
        await this.executeJob(
          provider,
          toProviderRequest(launchRecord, session.conversationRef),
          jobId,
          sessionId,
          signal,
          pool,
          {
            ...protectedEnv,
          },
        );
      } catch (error: unknown) {
        if (error instanceof TerminalWriteError) {
          backendLog.error(error.message, error.cause);
          return;
        }
        if (this.quiescedAppServerJobs.has(jobId)) {
          return;
        }
        try {
          this.handleProviderJobError(jobId, sessionId, signal, error);
        } catch (finalizeError: unknown) {
          if (finalizeError instanceof TerminalWriteError) {
            backendLog.error(finalizeError.message, finalizeError.cause);
            return;
          }
          throw finalizeError;
        }
      } finally {
        if (!this.quiescedAppServerJobs.has(jobId)) {
          launchAdmission.releaseLaunch(jobId, pool);
        }
      }
    })();
  }

  finishQueuedAbort(jobId: string, sessionId: string, reason: AbortReason): void {
    this.finishAbortedJob(jobId, sessionId, reason);
  }

  failJob(jobId: string, sessionId: string, terminal: JobTerminalInput): void {
    this.writeJobTerminal(jobId, sessionId, terminal, 'error');
    this.releaseTerminalJob(jobId, sessionId);
  }

  private releaseTerminalJob(jobId: string, sessionId: string): void {
    const { abortRegistry, jobPools, sessionManager } = this.deps;
    abortRegistry.remove(jobId);
    jobPools.delete(jobId);
    sessionManager.releaseJob(sessionId, jobId);
  }

  private elapsedJobDurationMs(jobId: string): number {
    const launch = this.deps.progressStore.readLaunchProjection(jobId);
    if (launch === null) {
      throw new Error(`Job '${jobId}' has no launch timestamp for terminal duration.`);
    }
    const startedAt = Date.parse(launch.createdAt);
    if (!Number.isFinite(startedAt)) {
      throw new Error(`Job '${jobId}' has an invalid launch timestamp.`);
    }
    return Math.max(0, this.deps.runtime.time.now() - startedAt);
  }

  markJobRunning(_jobId: string): void {
    // Runtime state is projected from job.runtime.started.
  }

  writeJobTerminal(
    jobId: string,
    sessionId: string,
    result: JobTerminalInput,
    _phase: JobPhase,
    options: TerminalWriteOptions = {},
  ): number {
    const { progressStore } = this.deps;
    try {
      const status = progressStore.readStatus(jobId);
      const [appended] = progressStore.commit((c) => {
        appendJobTerminalRecorded(c, {
          jobId,
          sessionId,
          namespace: status?.backendNamespace ?? this.deps.backendNamespace,
          project: status?.projectRoot,
          terminal: result,
          diagnostics: options.diagnostics,
        });
        return undefined;
      });
      return appended?.seq ?? 0;
    } catch (error: unknown) {
      throw new TerminalWriteError(jobId, error);
    }
  }

  private async executeJob(
    provider: BoundProvider,
    request: ProviderRequest,
    jobId: string,
    sessionId: string,
    signal: AbortSignal,
    pool: LaunchPool,
    protectedEnv?: Record<string, string>,
  ): Promise<void> {
    const session = this.deps.sessionManager.get(provider.name, sessionId);
    if (!session) {
      throw new ProviderBindingRuntimeError(
        { reason: 'invalid-persisted-binding', provider: provider.name },
        `Provider session ${sessionId} has no binding.`,
      );
    }
    const identity = provider.compareIdentity(session.binding);
    if (!identity.ok) {
      const failure = identity.failure;
      throw new ProviderBindingRuntimeError(failure, this.deps.providerRegistry.renderBindingFailure(failure));
    }
    const readiness = await provider.readiness('launch', this.deps.runtime.storage);
    if (!readiness.ok) {
      throw new ProviderBindingRuntimeError(
        readiness.failure,
        this.deps.providerRegistry.renderBindingFailure(readiness.failure),
      );
    }
    const equippedTools = resolveEquippedTools(this.deps.runtime);
    const requestWithInject = applyInjectBundle(request, {
      storage: this.deps.runtime.storage,
      kbRoot: this.deps.runtime.paths.coral.corpus.kbRoot,
      equippedTools,
      ...(request.cwd
        ? {
            coralProjects: this.deps.runtime.paths.projectData(request.cwd),
            projectSource: this.deps.runtime.paths.projectSource(request.cwd),
          }
        : {}),
    });
    const prepared = provider.prepareExecution({
      request: requestWithInject,
      baseEnv: this.deps.runtime.env.fullSnapshot(),
      protectedEnv,
      platform: this.deps.runtime.env.platform(),
    });
    const runtime = this.createProviderRuntime(
      provider,
      prepared,
      requestWithInject,
      sessionId,
      jobId,
      signal,
      pool,
      equippedTools,
    );
    const initialVersion = this.readClaimVersion(provider.name, sessionId, jobId);
    const consumed = await consumeJobStream({
      jobId,
      sessionId,
      initialVersion,
      stream: prepared.execute(runtime),
      sessionApi: {
        checkpointJobContinuityAtomic: async (claimedSessionId, options) => {
          if (this.quiescedAppServerJobs.has(jobId)) {
            // After quiesce: short-circuit so the dying daemon does not mutate
            // session continuity. The replacement daemon's startup recovery
            // probes the latest checkpoint that committed before quiesce.
            return { ok: false as const };
          }
          const result = await this.deps.sessionManager.checkpointJobContinuityAtomic(claimedSessionId, options);
          return result;
        },
        recordArtifactHandleAtomic: async (claimedSessionId, options) => {
          if (this.quiescedAppServerJobs.has(jobId)) {
            return { ok: false as const };
          }
          return this.deps.sessionManager.recordArtifactHandleAtomic(claimedSessionId, options);
        },
      },
      appendProgress: (message) => {
        if (this.quiescedAppServerJobs.has(jobId)) return;
        this.appendProgressEvent(jobId, sessionId, message);
      },
      recordTerminal: (event) => {
        if (this.quiescedAppServerJobs.has(jobId)) return;
        this.appendProviderTerminal(jobId, sessionId, request.cwd, event);
      },
    });
    if (this.quiescedAppServerJobs.has(jobId)) return;
    await this.handleConsumedJobCompletion(provider.name, sessionId, jobId, consumed.terminal.content);
  }

  private async handleConsumedJobCompletion(
    providerName: string,
    sessionId: string,
    jobId: string,
    content: string,
  ): Promise<void> {
    const { abortRegistry, jobPools } = this.deps;
    try {
      writeResultArtifact(this.deps.runtime.storage, this.deps.runtime.paths.coral.exports.jobsRoot, jobId, content);
    } catch (error: unknown) {
      backendLog.warn(`Writing terminal artifacts failed for ${jobId}: ${errorMessage(error)}`);
    } finally {
      abortRegistry.remove(jobId);
      jobPools.delete(jobId);

      const released = await this.deps.sessionManager.releaseJobClaimAtomic(sessionId, {
        expectedActiveJobId: jobId,
        expectedVersion: this.readClaimVersion(providerName, sessionId, jobId),
      });
      if (!released) {
        backendLog.warn(`Failed to release claimed session ${sessionId} for terminal job ${jobId}.`);
      }
    }
  }

  private handleProviderJobError(jobId: string, sessionId: string, signal: AbortSignal, error: unknown): void {
    const currentStatus = this.deps.progressStore.readStatus(jobId);
    if (!currentStatus || isTerminalPhase(currentStatus.phase)) {
      return;
    }

    if (error instanceof CliBusyError) {
      this.appendLaunchRejectedTerminal(jobId, sessionId, {
        reason: 'busy',
        message: error.message,
        provider: error.detail.provider,
        globalActive: error.detail.globalActive,
        globalLimit: error.detail.globalLimit,
      });
      this.releaseTerminalJob(jobId, sessionId);
      return;
    }

    if (signal.aborted || isAbortError(error)) {
      this.finishAbortedJob(jobId, sessionId, 'signal_abort');
      return;
    }

    if (error instanceof ProviderBindingRuntimeError) {
      this.failJob(jobId, sessionId, {
        content: '',
        durationMs: this.elapsedJobDurationMs(jobId),
        outcome: {
          kind: 'job_fault',
          fault: {
            kind: 'provider_binding',
            provider: error.failure.provider,
            reason: error.failure.reason,
            message: error.message,
          },
        },
      });
      return;
    }

    this.failJob(jobId, sessionId, {
      content: '',
      durationMs: this.elapsedJobDurationMs(jobId),
      outcome: {
        kind: 'job_fault',
        fault: {
          kind: 'wrapper_crashed',
          cause: { message: errorMessage(error) },
        },
      },
    });
  }

  private markJobQueued(jobId: string, sessionId: string, queuePosition: number): void {
    this.appendJobEvent(jobId, sessionId, 'job.queue.queued', {
      queuePosition,
      runningJobIds: [],
    });
    this.appendProgressEvent(jobId, sessionId, `queued (position ${queuePosition})`);
  }

  private createProviderRuntime(
    provider: BoundProvider,
    prepared: BoundProviderPreparedExecution,
    request: ProviderRequest,
    sessionId: string,
    jobId: string,
    signal: AbortSignal,
    pool: LaunchPool,
    equippedTools: ReturnType<typeof resolveEquippedTools>,
  ): Omit<ProviderRuntime<never>, 'providerContext'> {
    const runCli = bindProviderRunner(
      this.deps.durableSpawner,
      provider.name,
      signal,
      pool,
      this.deps.progressStore.jobDir(jobId),
      (record) => {
        this.deps.progressStore.appendRuntimeStarted(jobId, record);
      },
    );
    return {
      signal,
      runCli: (cliRequest) => runCli(prepared.prepareCliRequest(cliRequest)),
      time: this.deps.runtime.time,
      storage: this.deps.runtime.storage,
      env: this.deps.runtime.env,
      ids: this.deps.runtime.ids,
      acquireServer: (spec) => {
        this.appServerJobs.add(jobId);
        return this.deps.acquireServer(spec, { jobId, signal });
      },
      persistedContinuity: this.deps.sessionManager.get(provider.name, sessionId)?.providerContinuity ?? undefined,
      continuityBridge: NOOP_CONTINUITY_BRIDGE,
      kbRoot: this.deps.runtime.paths.coral.corpus.kbRoot,
      equippedTools,
      // Empty cwd is not a project root: treat it as absent so inject fragment
      // placeholders stay unsubstituted rather than resolving `local/` from ''.
      ...(request.cwd
        ? {
            coralProjects: this.deps.runtime.paths.projectData(request.cwd),
            projectSource: this.deps.runtime.paths.projectSource(request.cwd),
          }
        : {}),
    };
  }

  private appendProviderTerminal(
    jobId: string,
    sessionId: string,
    projectRoot: string | undefined,
    event: Extract<ProviderEventBody, { kind: 'terminal' }>,
  ): void {
    const { progressStore } = this.deps;
    const metadata = this.resolveEventMetadata(jobId, projectRoot);
    const currentStatus = progressStore.readStatus(jobId);
    if (currentStatus && isTerminalPhase(currentStatus.phase)) {
      return;
    }

    try {
      this.deps.terminalMaterializer.recordProviderTerminal(progressStore, event, {
        jobId,
        sessionId,
        namespace: metadata.namespace,
        project: metadata.project,
        correlationId: metadata.correlationId,
      });
    } catch (error: unknown) {
      throw new TerminalWriteError(jobId, error);
    }
  }

  private readClaimVersion(providerName: string, sessionId: string, jobId: string): number {
    const session = this.deps.sessionManager.get(providerName, sessionId);
    if (!session || session.activeJobId !== jobId) {
      throw new Error(`Expected claimed session ${sessionId} for job ${jobId}.`);
    }
    return session.version;
  }

  private async waitForQueuedPermit(admission: QueuedHandle, signal: AbortSignal): Promise<'granted' | 'aborted'> {
    return new Promise<'granted' | 'aborted'>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
      };

      const onAbort = () => {
        if (settled) return;
        settled = true;
        admission.cancel();
        cleanup();
        resolve('aborted');
      };

      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener('abort', onAbort, { once: true });
      admission
        .waitForPermit()
        .then(() => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve('granted');
        })
        .catch((error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private finishAbortedJob(jobId: string, sessionId: string, reason: AbortReason): void {
    const { abortRegistry, jobPools, sessionManager } = this.deps;
    this.appendJobEvent(jobId, sessionId, 'job.aborted', { reason });
    this.writeJobTerminal(
      jobId,
      sessionId,
      { content: '', outcome: { kind: 'aborted', reason }, durationMs: this.elapsedJobDurationMs(jobId) },
      'aborted',
    );
    abortRegistry.remove(jobId);
    jobPools.delete(jobId);
    sessionManager.releaseJob(sessionId, jobId);
  }
}
