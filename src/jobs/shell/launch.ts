import {
  bindProviderRunner,
  type DurableContainmentOperatorControl,
  type DurableProcessPublicationDisposition,
  type ProviderDurableSpawner,
} from '../../providers/cli-runner.js';
import type {
  HostRef,
  ProviderEventBody,
  ProviderRequest,
  ProviderRuntime,
  ProviderStopCause,
} from '../../providers/contract.js';
import type {
  BoundProvider,
  BoundProviderAppServerExecutionRuntime,
  BoundProviderPreparedExecution,
} from '../../providers/bound-provider-contract.js';

type BoundProviderExecutionRuntimeCommon = Omit<
  BoundProviderAppServerExecutionRuntime,
  'transport' | 'onAppServerWaiting' | 'onHostRef'
>;
import { errorMessage } from '../../infra/error-format.js';
import { nowIsoString } from '../../infra/time.js';
import { backendLog } from '../../infra/backend-log.js';
import { type ProviderSessionLaunchDecision, refuseLaunch } from '../launch.js';
import { isTerminalPhase, type JobPhase } from '../phase.js';
import type { JobLaunch, JobTerminalInput } from '../records.js';
import type { RetentionPolicy, ProviderSession } from '../../sessions/entry.js';
import { type AbortReason, type JobAbortedBody, type JobLaunchRejected } from '../outcome.js';
import type { JobQueueAdmittedBody, JobQueueQueuedBody } from '../event-bodies.js';
import { type AbortRegistry } from './abort-registry.js';
import { CliBusyError } from '../../runtime/cli-busy.js';
import { isAbortError } from '../../runtime/abort.js';
import type {
  AcceptedAdmission,
  AdmissionResult,
  JobAdmissionPort,
  LaunchPermit,
  LaunchPool,
  QueuedHandle,
  SettlementRefusal,
  SettlementRefusalRecorder,
} from '../contracts/admission.js';
import type { ExecutionOwner } from '../../runtime/execution-owner.js';
import type { DiscussionRunDescriptor } from '../discussion-run.js';
import type { JobProgressStore, TerminalWriteOptions } from '../contracts/job-store.js';
import type {
  DurableCliProcessSubject,
  DurableContainmentStatus,
  DurableProvisionalProcessSubject,
  Runtime,
} from '../../runtime/ports.js';
import type { SessionInitialLaunchPort, SessionJobClaimPort } from '../../sessions/contracts.js';
import type { CoralEventInput } from '../../store/envelope.js';
import type { CommitEventsFn } from '../../store/append.js';
import { consumeJobStream } from './continuity-consumer.js';
import { appendJobTerminalRecorded, failedTerminalOutcome } from '../terminal/recording.js';
import { SessionClaimError } from '../../sessions/claim-error.js';
import type { ProviderContinuityBlob } from '../../sessions/continuity.js';
import { toProviderRequest } from '../provider-request.js';
import { TerminalWriteError } from '../terminal/write-error.js';
import { buildJobEventRefs } from '../refs.js';
import { resolveEquippedTools } from '../../expansion/equipped-tools.js';
import { applyInjectBundle } from '../../providers/inject.js';
import { ProviderBindingRuntimeError } from '../../providers/contracts/binding.js';
import { ProviderHostUnserviceableError } from '../../providers/host-admission.js';
import type { ProviderBindingCatalog } from '../../providers/catalog.js';
import { jobLaunchRequestedEvent } from '../store.js';
import {
  deleteDurableCliContainmentStatus,
  writeDurableCliContainmentStatus,
  writeDurableCliProcessRuntimeMeta,
} from '../runtime-meta-store.js';
import type { AppServerProxyRoute } from '../contracts/app-server-proxy-route.js';
import type {
  ProviderOperationBindingPort,
  ProviderOperationChildAuthorization,
  ProviderOperationCleanupIdentity,
  ProviderOperationCleanupOwner,
  ProviderOperationEnvironmentInput,
  ProviderOperationProtectedEnvironment,
} from '../contracts/provider-operation-lifecycle.js';
import { readProviderOperationJobLaunchEventSeq } from '../provider-operation-state.js';

const QUEUE_FULL_MESSAGE = 'All slots and queue are full. Try again later.';
type LauncherJobEventBody = JobQueueAdmittedBody | JobQueueQueuedBody | JobAbortedBody;
type JobExecutionDisposition = 'settled' | 'suspended' | 'handed-off' | 'proxied' | 'terminalized' | SettlementRefusal;
type QueuedPermitOutcome = Readonly<{ kind: 'admitted'; permit: LaunchPermit }> | Readonly<{ kind: 'aborted' }>;

function releasesLaunchPermit(disposition: JobExecutionDisposition): boolean {
  switch (disposition) {
    case 'settled':
    case 'suspended':
    case 'terminalized':
      return true;
    case 'handed-off':
    case 'proxied':
      return false;
  }
  switch (disposition.cause) {
    case 'terminal-persist-failed':
    case 'claim-release-failed':
    case 'claim-already-reassigned':
      return true;
  }
}

function providerOperationEnvironment(input?: ProviderOperationEnvironmentInput): Readonly<{
  env: Readonly<Record<string, string>>;
  childAuthorization?: ProviderOperationChildAuthorization;
}> {
  if (
    input !== undefined &&
    typeof input.env === 'object' &&
    input.env !== null &&
    typeof input.childAuthorization === 'object' &&
    input.childAuthorization !== null
  ) {
    return input as ProviderOperationProtectedEnvironment;
  }
  return { env: (input ?? {}) as Readonly<Record<string, string>> };
}

function isRecoveredLegacyWorkflowSlotJob(launch: JobLaunch): boolean {
  return (
    launch.jobKind === 'provider' &&
    launch.owner.kind === 'workflow' &&
    launch.parentWorkflowJobId === launch.owner.id &&
    launch.workflowSlotId !== undefined &&
    launch.jobId === launch.workflowSlotId
  );
}

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
  providerOperationBinding: ProviderOperationBindingPort;
  durableSpawner: ProviderDurableSpawner;
  providerRegistry: ProviderBindingCatalog;
  runtime: Pick<Runtime, 'time' | 'ids' | 'storage' | 'env' | 'paths'>;
  coordinatorCommit: CommitEventsFn;
  backendNamespace: string;
  bundleHash: string;
  settlementRefusalRecorder: SettlementRefusalRecorder;
  getEventMetadata?: () => Pick<CoralEventInput, 'correlationId' | 'namespace' | 'project'> | null;
  /**
   * Tries to hand an app-server operation to a live, detached provider proxy set before running it in this
   * process (W2.3). Compositions without this optional port select local placement directly.
   */
  appServerProxyRoute?: AppServerProxyRoute;
  /**
   * The placement owner's abort-side capability. It is registered before local versus proxy ownership is
   * known so publication can durably record a stop before a live registry entry exists, while local execution
   * continues to observe the same signal directly. Compositions without proxy placement may omit it.
   */
  operations?: { stop(jobId: string, cause: ProviderStopCause): void };
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
}

type ProviderLaunchOptions = {
  pool?: LaunchPool;
  parentWorkflowJobId?: string;
  workflowSlotId?: string;
  workflowSlotGeneration?: number;
  replacesWorkflowJobId?: string;
  retention?: RetentionPolicy;
  protectedEnv?: Record<string, string>;
  owner?: ExecutionOwner;
  discussionRun?: DiscussionRunDescriptor;
};

export class LaunchOrchestrator implements ProviderOperationCleanupOwner {
  // Tracks every admitted app-server job before its first asynchronous
  // preparation boundary. Quiesce-for-handoff acts on this set; CLI/durable
  // jobs not in the set keep the existing handoff preservation behavior.
  private readonly appServerJobs = new Set<string>();
  // Once handoff quiesces a job, the dying generation must perform no
  // terminalization or local-ownership cleanup for it.
  private readonly quiescedAppServerJobs = new Set<string>();
  private readonly appServerHandoffAborts = new Map<string, AbortController>();
  private readonly inFlightAppServerWrites = new Map<string, Set<Promise<unknown>>>();
  private appServerHandoffQuiesced = false;

  private readonly deps: LaunchOrchestratorDeps;
  constructor(deps: LaunchOrchestratorDeps) {
    this.deps = deps;
  }

  releaseProviderOperationLocalState(identity: ProviderOperationCleanupIdentity): boolean {
    const { jobId } = identity;
    const ownsLocalState =
      this.deps.abortRegistry.getSignal(jobId) !== null ||
      this.appServerJobs.has(jobId) ||
      this.appServerHandoffAborts.has(jobId);
    if (!ownsLocalState) return false;

    switch (identity.kind) {
      case 'proxy-binding': {
        const settlement = this.deps.providerOperationBinding.settleProviderOperationBinding({
          jobId,
          operationId: identity.operationId,
        });
        if (settlement.kind === 'refused') return false;
        break;
      }
      case 'job-local':
        break;
    }
    this.deps.abortRegistry.remove(jobId);
    this.appServerJobs.delete(jobId);
    this.appServerHandoffAborts.delete(jobId);
    return true;
  }

  async quiesceAppServerJobsForHandoff(): Promise<void> {
    this.appServerHandoffQuiesced = true;
    for (const jobId of this.appServerJobs) {
      this.quiescedAppServerJobs.add(jobId);
      this.appServerHandoffAborts.get(jobId)?.abort(new Error('App-server execution quiesced for daemon handoff.'));
    }
    const writes = [...this.quiescedAppServerJobs].flatMap((jobId) => [
      ...(this.inFlightAppServerWrites.get(jobId) ?? []),
    ]);
    await Promise.allSettled(writes);
  }

  private trackAppServerWrite<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
    // Install the fence entry before invoking any persistence code. The
    // operation may synchronously trigger observers that begin handoff.
    const write = Promise.resolve().then(operation);
    const writes = this.inFlightAppServerWrites.get(jobId) ?? new Set<Promise<unknown>>();
    this.inFlightAppServerWrites.set(jobId, writes);
    writes.add(write);
    void write
      .finally(() => {
        writes.delete(write);
        if (writes.size === 0) this.inFlightAppServerWrites.delete(jobId);
      })
      .catch(() => undefined);
    return write;
  }

  private preserveAppServerJobForHandoff(provider: BoundProvider, jobId: string): boolean {
    if (!this.appServerHandoffQuiesced || provider.appServer === undefined) return false;
    this.quiescedAppServerJobs.add(jobId);
    return true;
  }

  private registerAppServerJob(provider: BoundProvider, jobId: string, jobSignal: AbortSignal): AbortSignal {
    if (provider.appServer === undefined) return jobSignal;
    this.appServerJobs.add(jobId);
    const handoffAbort = new AbortController();
    this.appServerHandoffAborts.set(jobId, handoffAbort);
    if (this.appServerHandoffQuiesced) {
      this.quiescedAppServerJobs.add(jobId);
      handoffAbort.abort(new Error('App-server execution quiesced for daemon handoff.'));
    }
    return AbortSignal.any([jobSignal, handoffAbort.signal]);
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
      mintProtectedEnv: (jobId: string) => ProviderOperationEnvironmentInput;
    },
  ): ProviderSessionLaunchDecision {
    const pool = opts.pool ?? 'default';
    const jobId = opts.requestedJobId ?? this.deps.runtime.ids.uuid();
    const admission = this.reserveAdmission(jobId, provider.name, opts.owner, pool);
    if (admission === 'queue_full') {
      return refuseLaunch('busy', QUEUE_FULL_MESSAGE);
    }

    try {
      const { hostedRequest, launch, projectRoot } = this.buildProviderLaunch(
        provider,
        preparedSession,
        jobId,
        request,
        opts,
      );
      const metadata = this.resolveEventMetadata(jobId, projectRoot);
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
          body:
            admission.type === 'queued'
              ? { queuePosition: admission.queuePosition, runningJobIds: [] }
              : { queuePosition: 0 },
        });
        return undefined;
      });

      this.activateCommittedProviderLaunch({
        provider,
        sessionId: preparedSession.sessionId,
        jobId,
        request: hostedRequest,
        admission,
        pool,
        mintProtectedEnv: opts.mintProtectedEnv,
      });
    } catch (error: unknown) {
      this.releaseAdmissionReservation(admission);
      throw error;
    }

    return {
      kind: 'provider-session',
      status: admission.type === 'queued' ? 'queued' : 'running',
      jobId,
      sessionId: preparedSession.sessionId,
    };
  }

  private reserveAdmission(jobId: string, provider: string, owner: ExecutionOwner, pool: LaunchPool): AdmissionResult {
    return this.deps.launchAdmission.requestLaunch(jobId, provider, owner, pool);
  }

  private releaseAdmissionReservation(admission: AcceptedAdmission): void {
    if (admission.type === 'queued') {
      const cancellation = admission.cancel();
      if (cancellation.kind === 'admitted') void this.deps.launchAdmission.releaseLaunch(cancellation.permit);
      return;
    }
    void this.deps.launchAdmission.releaseLaunch(admission.permit);
  }

  private buildProviderLaunch(
    provider: BoundProvider,
    session: ProviderSession,
    jobId: string,
    request: ProviderRequest,
    opts: ProviderLaunchOptions,
  ): { hostedRequest: ProviderRequest; launch: JobLaunch; pool: LaunchPool; projectRoot: string } {
    const pool = opts.pool ?? 'default';
    const projectRoot = session.projectRoot;
    const hostedRequest: ProviderRequest = {
      ...request,
      coralEnv: {
        ...request.coralEnv,
        CORAL_JOB_ID: jobId,
        CORAL_SESSION_ID: session.sessionId,
      },
    };
    return {
      hostedRequest,
      pool,
      projectRoot,
      launch: {
        jobId,
        owner: opts.owner ?? { kind: 'provider-session', id: session.sessionId },
        ...(opts.discussionRun === undefined ? {} : { discussionRun: opts.discussionRun }),
        sessionId: session.sessionId,
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
          cwd: hostedRequest.cwd,
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
      mintProtectedEnv: (jobId: string) => ProviderOperationEnvironmentInput;
    },
  ): ProviderSessionLaunchDecision {
    const pool = opts.pool ?? 'default';
    const jobId = opts.requestedJobId ?? this.deps.runtime.ids.uuid();
    const admission = this.reserveAdmission(jobId, provider.name, opts.owner, pool);
    if (admission === 'queue_full') {
      return refuseLaunch('busy', QUEUE_FULL_MESSAGE);
    }

    let claimedSession: ProviderSession | undefined;
    try {
      const built = this.buildProviderLaunch(provider, session, jobId, request, opts);
      const metadata = this.resolveEventMetadata(jobId, built.projectRoot);
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
          body:
            admission.type === 'queued'
              ? { queuePosition: admission.queuePosition, runningJobIds: [] }
              : { queuePosition: 0 },
        });
        return undefined;
      });

      if (claimedSession === undefined) {
        const error = new Error(`Resume transaction produced no session claim for job ${jobId}.`);
        this.finalizeCommittedLaunchSetupFailure(jobId, session.sessionId, admission, error);
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
    } catch (error: unknown) {
      this.releaseAdmissionReservation(admission);

      if (error instanceof SessionClaimError) {
        return refuseLaunch('session_busy', opts.sessionBusyMessage);
      }
      throw error;
    }
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
      mintProtectedEnv: (jobId: string) => ProviderOperationEnvironmentInput;
    },
  ): ProviderSessionLaunchDecision {
    const pool = opts.pool ?? 'default';
    const jobId = this.deps.runtime.ids.uuid();
    const admission = this.reserveAdmission(jobId, provider.name, opts.owner, pool);
    if (admission === 'queue_full') {
      return refuseLaunch('busy', QUEUE_FULL_MESSAGE);
    }
    let claimedSession: ProviderSession | undefined;
    try {
      const built = this.buildProviderLaunch(provider, session, jobId, request, {
        ...opts,
        pool,
      });
      const metadata = this.resolveEventMetadata(jobId, built.projectRoot);
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
          body:
            admission.type === 'queued'
              ? { queuePosition: admission.queuePosition, runningJobIds: [] }
              : { queuePosition: 0 },
        });
        return undefined;
      });

      if (claimedSession === undefined) {
        const error = new Error(`Workflow replacement transaction produced no session claim for job ${jobId}.`);
        this.finalizeCommittedLaunchSetupFailure(jobId, session.sessionId, admission, error);
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
    } catch (error: unknown) {
      this.releaseAdmissionReservation(admission);
      throw error;
    }
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
    mintProtectedEnv: (jobId: string) => ProviderOperationEnvironmentInput;
  }): void {
    try {
      if (input.committedSession !== undefined) {
        this.deps.sessionManager.observeCommittedEntry(input.committedSession);
      }
      // Registered before placement so the same signal governs either owner. Local execution observes the
      // signal directly; durable publication rechecks an already-aborted signal at insertion and records later
      // stops in the saga before the proxy can act on them.
      this.registerLaunchAbort(input.jobId, input.admission);
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
      this.finalizeCommittedLaunchSetupFailure(input.jobId, input.sessionId, input.admission, error);
      throw error;
    }
  }

  private finalizeCommittedLaunchSetupFailure(
    jobId: string,
    sessionId: string,
    admission: AcceptedAdmission,
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

    // Every cleanup is deliberately idempotent.
    this.deps.abortRegistry.remove(jobId);
    try {
      void this.deps.sessionManager.releaseJob(sessionId, jobId);
    } catch (cleanupError: unknown) {
      backendLog.error(`Failed to release session claim for setup-failed job ${jobId}: ${errorMessage(cleanupError)}`);
    }
    this.releaseAdmissionReservation(admission);
  }

  runAsync(
    provider: BoundProvider,
    sessionId: string,
    jobId: string,
    request: ProviderRequest,
    admission: AcceptedAdmission,
    pool: LaunchPool,
    protectedEnv?: ProviderOperationEnvironmentInput,
  ): void {
    const { abortRegistry, launchAdmission } = this.deps;
    const signal = abortRegistry.getSignal(jobId);
    if (!signal) {
      this.releaseAdmissionReservation(admission);
      return;
    }

    const executionSignal = this.registerAppServerJob(provider, jobId, signal);

    void (async () => {
      let permit = admission.type === 'immediate' ? admission.permit : null;
      let disposition: JobExecutionDisposition = 'terminalized';

      try {
        if (this.preserveAppServerJobForHandoff(provider, jobId)) {
          disposition = 'handed-off';
          return;
        }
        if (admission.type === 'queued') {
          const queueOutcome = await this.waitForQueuedPermit(admission, signal);
          if (queueOutcome.kind === 'aborted') {
            this.finishQueuedAbort(jobId, sessionId, 'queue_shutdown');
            return;
          }

          permit = queueOutcome.permit;
          if (this.preserveAppServerJobForHandoff(provider, jobId)) {
            disposition = 'handed-off';
            return;
          }
          this.appendJobEvent(jobId, sessionId, 'job.queue.admitted', {});
          this.appendProgressEvent(jobId, sessionId, 'dequeued, launching');
        }
        if (permit === null || permit.pool !== pool) {
          throw new Error(`Launch permit for ${jobId} does not match its admitted pool.`);
        }

        disposition = await this.executeJob(provider, request, jobId, sessionId, executionSignal, permit, protectedEnv);
      } catch (error: unknown) {
        if (error instanceof TerminalWriteError) {
          backendLog.error(error.message, error.cause);
          return;
        }
        if (this.quiescedAppServerJobs.has(jobId)) {
          disposition = 'handed-off';
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
        if (permit !== null && releasesLaunchPermit(disposition)) void launchAdmission.releaseLaunch(permit);
        this.appServerJobs.delete(jobId);
        this.quiescedAppServerJobs.delete(jobId);
        this.appServerHandoffAborts.delete(jobId);
      }
    })();
  }

  runRecoveredQueuedJob(
    provider: BoundProvider,
    launchRecord: JobLaunch,
    admission: QueuedHandle,
    pool: LaunchPool,
    protectedEnv: ProviderOperationEnvironmentInput,
  ): void {
    const { abortRegistry, launchAdmission } = this.deps;
    const jobId = launchRecord.jobId;
    const sessionId = launchRecord.sessionId;
    const forceLocalAppServerPlacement = isRecoveredLegacyWorkflowSlotJob(launchRecord);
    if (sessionId === null) {
      throw new Error(`Recovered queued job ${jobId} requires a provider session id.`);
    }
    this.registerLaunchAbort(jobId, admission);
    const signal = abortRegistry.getSignal(jobId);
    if (!signal) {
      this.releaseAdmissionReservation(admission);
      return;
    }

    const executionSignal = this.registerAppServerJob(provider, jobId, signal);

    void (async () => {
      let permit: LaunchPermit | null = null;
      let disposition: JobExecutionDisposition = 'terminalized';
      try {
        if (this.preserveAppServerJobForHandoff(provider, jobId)) {
          disposition = 'handed-off';
          return;
        }
        const queueOutcome = await this.waitForQueuedPermit(admission, signal);
        if (queueOutcome.kind === 'aborted') {
          this.finishQueuedAbort(jobId, sessionId, 'queue_shutdown');
          return;
        }

        permit = queueOutcome.permit;
        if (this.preserveAppServerJobForHandoff(provider, jobId)) {
          disposition = 'handed-off';
          return;
        }
        this.appendJobEvent(jobId, sessionId, 'job.queue.admitted', {});
        this.appendProgressEvent(jobId, sessionId, 'dequeued, launching');
        if (forceLocalAppServerPlacement) {
          this.appendProgressEvent(jobId, sessionId, 'pre-upgrade workflow child recovered with local placement');
        }
        if (permit.pool !== pool) {
          throw new Error(`Recovered launch permit for ${jobId} does not match its admitted pool.`);
        }

        const session = this.deps.sessionManager.get(provider.name, sessionId);
        if (session === null) {
          throw new Error(`Recovered queued job ${jobId} has no provider session snapshot.`);
        }
        disposition = await this.executeJob(
          provider,
          toProviderRequest(launchRecord, session.conversationRef),
          jobId,
          sessionId,
          executionSignal,
          permit,
          protectedEnv,
          { forceLocalAppServerPlacement },
        );
      } catch (error: unknown) {
        if (error instanceof TerminalWriteError) {
          backendLog.error(error.message, error.cause);
          return;
        }
        if (this.quiescedAppServerJobs.has(jobId)) {
          disposition = 'handed-off';
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
        if (permit !== null && releasesLaunchPermit(disposition)) void launchAdmission.releaseLaunch(permit);
        this.appServerJobs.delete(jobId);
        this.quiescedAppServerJobs.delete(jobId);
        this.appServerHandoffAborts.delete(jobId);
      }
    })();
  }

  private finishQueuedAbort(jobId: string, sessionId: string, reason: AbortReason): void {
    this.finishAbortedJob(jobId, sessionId, reason);
  }

  failJob(jobId: string, sessionId: string, terminal: JobTerminalInput): void {
    this.writeJobTerminal(jobId, sessionId, terminal, 'error');
    this.releaseTerminalJob(jobId, sessionId);
  }

  private releaseTerminalJob(jobId: string, sessionId: string): void {
    const { abortRegistry, sessionManager } = this.deps;
    abortRegistry.remove(jobId);
    void sessionManager.releaseJob(sessionId, jobId);
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
    permit: LaunchPermit,
    protectedEnv?: ProviderOperationEnvironmentInput,
    options: { forceLocalAppServerPlacement?: boolean } = {},
  ): Promise<JobExecutionDisposition> {
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
    const continuity = provider.decodeContinuity(session.providerContinuity);
    if (!continuity.ok) {
      throw new ProviderBindingRuntimeError(
        continuity.failure,
        this.deps.providerRegistry.renderBindingFailure(continuity.failure),
      );
    }
    const readiness = await provider.readiness('launch', this.deps.runtime.storage);
    if (this.preserveAppServerJobForHandoff(provider, jobId)) return 'handed-off';
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
    const operationEnvironment = providerOperationEnvironment(protectedEnv);
    const prepared = provider.prepareExecution({
      request: requestWithInject,
      persistedContinuity: continuity.value,
      baseEnv: this.deps.runtime.env.fullSnapshot(),
      protectedEnv: operationEnvironment.env,
      platform: this.deps.runtime.env.platform(),
      storage: this.deps.runtime.storage,
    });
    const runtime = this.createProviderRuntime(
      provider,
      requestWithInject,
      sessionId,
      jobId,
      signal,
      continuity.value,
      equippedTools,
    );
    const initialVersion = this.readClaimVersion(provider.name, sessionId, jobId);
    try {
      const providerStream = await this.executePreparedProvider(
        provider,
        prepared,
        runtime,
        jobId,
        signal,
        permit,
        requestWithInject,
        continuity.value,
        operationEnvironment,
        initialVersion,
        options.forceLocalAppServerPlacement === true,
      );
      if (providerStream.kind === 'cancelled') {
        signal.throwIfAborted();
        throw new Error('App-server placement was cancelled without an aborted launch signal.');
      }
      if (providerStream.kind === 'terminalized') {
        this.releaseTerminalJob(jobId, sessionId);
        return 'terminalized';
      }
      if (providerStream.kind === 'proxied') {
        return 'proxied';
      }
      const consumed = await consumeJobStream({
        jobId,
        sessionId,
        initialVersion,
        decodeContinuity: (rawContinuity) => provider.decodeContinuity(rawContinuity),
        stream: providerStream.stream,
        sessionApi: {
          checkpointJobContinuityAtomic: async (claimedSessionId, options) => {
            if (this.quiescedAppServerJobs.has(jobId)) {
              return { ok: false as const };
            }
            const result = await this.trackAppServerWrite(jobId, () =>
              this.deps.sessionManager.checkpointJobContinuityAtomic(claimedSessionId, options),
            );
            if (this.quiescedAppServerJobs.has(jobId)) return { ok: false as const };
            return result;
          },
          recordArtifactHandleAtomic: async (claimedSessionId, options) => {
            if (this.quiescedAppServerJobs.has(jobId)) {
              return { ok: false as const };
            }
            const result = await this.trackAppServerWrite(jobId, () =>
              this.deps.sessionManager.recordArtifactHandleAtomic(claimedSessionId, options),
            );
            if (this.quiescedAppServerJobs.has(jobId)) return { ok: false as const };
            return result;
          },
        },
        appendProgress: (message) => {
          if (this.quiescedAppServerJobs.has(jobId)) return;
          this.appendProgressEvent(jobId, sessionId, message);
        },
      });
      if (this.quiescedAppServerJobs.has(jobId)) return 'handed-off';
      if (consumed.kind === 'suspended') return 'suspended';
      const completion = this.trackAppServerWrite(jobId, () =>
        this.completeConsumedJob({
          sessionId,
          jobId,
          projectRoot: request.cwd,
          event: consumed.event,
          expectedClaimVersion: consumed.claimVersion,
        }),
      );
      return await completion;
    } finally {
      this.inFlightAppServerWrites.delete(jobId);
    }
  }

  private async completeConsumedJob(options: {
    sessionId: string;
    jobId: string;
    projectRoot: string | undefined;
    event: Extract<ProviderEventBody, { kind: 'terminal' }>;
    expectedClaimVersion: number;
  }): Promise<'settled' | SettlementRefusal> {
    const { sessionId, jobId, projectRoot, event, expectedClaimVersion } = options;

    try {
      this.appendProviderTerminal(jobId, sessionId, projectRoot, event);
    } catch (error: unknown) {
      backendLog.error(`Failed to persist provider terminal for ${jobId}: ${errorMessage(error)}`, error);
      return await this.recordSettlementRefusal(jobId, 'terminal-persist-failed', error);
    }

    let claimRefusal: Readonly<{ cause: SettlementRefusal['cause']; error: unknown }> | null = null;
    try {
      const released = await this.deps.sessionManager.releaseJobClaimAtomic(sessionId, {
        expectedActiveJobId: jobId,
        expectedVersion: expectedClaimVersion,
      });
      if (!released) {
        const error = new Error(`The session claim for terminal job ${jobId} is owned by another job.`);
        backendLog.warn(`Failed to release claimed session ${sessionId} for terminal job ${jobId}.`);
        claimRefusal = { cause: 'claim-already-reassigned', error };
      }
    } catch (error: unknown) {
      backendLog.error(
        `Failed to release claimed session ${sessionId} for terminal job ${jobId}: ${errorMessage(error)}`,
        error,
      );
      claimRefusal = { cause: 'claim-release-failed', error };
    }

    try {
      this.deps.progressStore.ensureResultArtifact(jobId);
    } catch (error: unknown) {
      backendLog.warn(`Writing terminal artifacts failed for ${jobId}: ${errorMessage(error)}`);
    }

    this.deps.abortRegistry.remove(jobId);
    if (claimRefusal !== null) {
      return await this.recordSettlementRefusal(jobId, claimRefusal.cause, claimRefusal.error);
    }
    return 'settled';
  }

  private async recordSettlementRefusal(
    jobId: string,
    cause: SettlementRefusal['cause'],
    error: unknown,
  ): Promise<SettlementRefusal> {
    try {
      const recorded = await this.deps.settlementRefusalRecorder.record({
        jobId,
        cause,
        failure: errorMessage(error),
      });
      if (!recorded) throw new Error('The recovery quarantine write did not persist.');
      return { kind: 'settlement-refused', cause, quarantine: 'recorded' };
    } catch (recordingError: unknown) {
      backendLog.error(
        `Failed to record settlement refusal for ${jobId}: ${errorMessage(recordingError)}`,
        recordingError,
      );
      return { kind: 'settlement-refused', cause, quarantine: 'recording-failed' };
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

    if (error instanceof ProviderHostUnserviceableError) {
      const durationMs = this.elapsedJobDurationMs(jobId);
      try {
        this.deps.progressStore.commit((commit) => {
          const cause = commit.append({
            type: 'job.progress.emitted',
            stream: { kind: 'job', id: jobId },
            namespace: currentStatus.backendNamespace,
            project: currentStatus.projectRoot,
            refs: buildJobEventRefs({ jobId, sessionId }),
            body: {
              kind: 'domain',
              stage: 'provider_operation_failed',
              message: error.message,
              detail: {
                code: error.code,
                hostRef: error.hostRef,
                remediation: error.remediation,
              },
            },
          });
          appendJobTerminalRecorded(commit, {
            jobId,
            sessionId,
            namespace: currentStatus.backendNamespace,
            project: currentStatus.projectRoot,
            terminal: { content: '', durationMs, outcome: failedTerminalOutcome(cause) },
          });
          return undefined;
        });
      } catch (terminalError: unknown) {
        throw new TerminalWriteError(jobId, terminalError);
      }
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
    request: ProviderRequest,
    sessionId: string,
    jobId: string,
    signal: AbortSignal,
    persistedContinuity: ProviderContinuityBlob | undefined,
    equippedTools: ReturnType<typeof resolveEquippedTools>,
  ): BoundProviderExecutionRuntimeCommon {
    return {
      signal,
      time: this.deps.runtime.time,
      storage: this.deps.runtime.storage,
      env: this.deps.runtime.env,
      ids: this.deps.runtime.ids,
      jobId,
      persistedContinuity,
      continuityBridge: NOOP_CONTINUITY_BRIDGE,
      onProviderTurnTerminal: () => {},
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

  private async executePreparedProvider(
    provider: BoundProvider,
    prepared: BoundProviderPreparedExecution,
    runtime: BoundProviderExecutionRuntimeCommon,
    jobId: string,
    signal: AbortSignal,
    permit: LaunchPermit,
    requestForRoute: ProviderRequest,
    persistedContinuity: ProviderContinuityBlob | undefined,
    operationEnvironment: Readonly<{
      env: Readonly<Record<string, string>>;
      childAuthorization?: ProviderOperationChildAuthorization;
    }>,
    sessionVersion: number,
    forceLocalAppServerPlacement: boolean,
  ): Promise<
    | Readonly<{ kind: 'local'; stream: AsyncIterable<ProviderEventBody> }>
    | Readonly<{ kind: 'proxied'; operationId: string }>
    | Readonly<{ kind: 'terminalized' }>
    | Readonly<{ kind: 'cancelled' }>
  > {
    if (prepared.kind === 'app-server') {
      const route = forceLocalAppServerPlacement ? undefined : this.deps.appServerProxyRoute;
      if (signal.aborted) return { kind: 'cancelled' };
      if (route !== undefined) {
        if (operationEnvironment.childAuthorization === undefined) {
          throw new Error('Provider operation child authorization is unavailable for durable publication.');
        }
        const operationId = this.deps.runtime.ids.uuid();
        const operationIdentity = { jobId, operationId };
        const jobLaunchEventSeq = readProviderOperationJobLaunchEventSeq(this.deps.progressStore.getDb(), jobId);
        const binding = this.deps.providerOperationBinding.prepareProviderOperationBinding(permit, operationIdentity);
        if (binding.kind === 'already-settled') return { kind: 'terminalized' };
        if (binding.kind === 'refused') {
          throw new Error(`Provider operation binding preparation failed: ${binding.reason}.`);
        }
        if (binding.kind === 'bound') {
          throw new Error(
            'Provider operation binding preparation failed: the new operation identity is already bound.',
          );
        }

        let activation: Awaited<ReturnType<AppServerProxyRoute['activate']>>;
        try {
          activation = await route.activate(
            {
              jobId,
              operationId,
              jobLaunchEventSeq,
              sessionId: requestForRoute.sessionId,
              sessionVersion,
              childAuthorization: operationEnvironment.childAuthorization,
              hostSpec: prepared.hostSpec,
              provider: provider.name,
              binding: provider.envelope,
              request: requestForRoute,
              persistedContinuity: persistedContinuity ?? null,
              baseEnv: this.deps.runtime.env.fullSnapshot(),
              protectedEnv: operationEnvironment.env,
              platform: this.deps.runtime.env.platform(),
            },
            signal,
          );
        } catch (error: unknown) {
          void this.deps.providerOperationBinding.cancelProviderOperationBinding(permit, operationIdentity);
          throw error;
        }
        if (activation.kind === 'remote-executing') {
          this.appServerJobs.delete(jobId);
          this.appServerHandoffAborts.delete(jobId);
          return { kind: 'proxied', operationId };
        }
        if (activation.kind === 'terminalized' || activation.kind === 'rekey-refused-contained') {
          return { kind: 'terminalized' };
        }
        const cancellation = this.deps.providerOperationBinding.cancelProviderOperationBinding(
          permit,
          operationIdentity,
        );
        if (cancellation.kind === 'refused') {
          throw new Error(`Provider operation binding cancellation failed: ${cancellation.reason}.`);
        }
      }
      return {
        kind: 'local',
        stream: prepared.execute({
          ...runtime,
          transport: 'app-server',
          onAppServerWaiting: ({ provider: observedProvider }) => {
            if (this.appServerHandoffQuiesced) {
              this.quiescedAppServerJobs.add(jobId);
              return;
            }
            this.deps.progressStore.appendRuntimeStarted(jobId, {
              transport: 'app-server',
              startTime: nowIsoString(this.deps.runtime.time.now()),
              providerMeta: { provider: observedProvider, leaseState: 'waiting' },
            });
          },
          onHostRef: (hostRef: HostRef) => {
            if (this.appServerHandoffQuiesced || this.quiescedAppServerJobs.has(jobId)) return;
            this.deps.progressStore.appendRuntimeStarted(jobId, {
              transport: 'app-server',
              startTime: nowIsoString(this.deps.runtime.time.now()),
              providerMeta: { provider: hostRef.provider, leaseState: 'acquired', hostRef },
            });
          },
        }),
      };
    }

    const publishDurableContainmentDisposition = (publication: {
      persist(): void;
      persistenceFailure: string;
      onPersistenceFailure?(reason: string): void;
      afterPersistence?(): void;
      progress: string;
      progressFailure: string;
    }): DurableProcessPublicationDisposition => {
      try {
        publication.persist();
      } catch (error: unknown) {
        const reason = `${publication.persistenceFailure}: ${errorMessage(error)}`;
        publication.onPersistenceFailure?.(reason);
        return { kind: 'retained', reason };
      }
      publication.afterPersistence?.();
      try {
        this.appendProgressEvent(jobId, requestForRoute.sessionId, publication.progress);
      } catch (error: unknown) {
        backendLog.warn(
          `Failed to append durable containment ${publication.progressFailure} for ${jobId}: ${errorMessage(error)}`,
        );
      }
      return { kind: 'published' };
    };

    const runCli = bindProviderRunner(
      this.deps.durableSpawner,
      provider.name,
      signal,
      permit.pool,
      this.deps.progressStore.jobDir(jobId),
      (record, provisionalIdentity) => {
        this.deps.progressStore.appendRuntimeStarted(
          jobId,
          record,
          provisionalIdentity === undefined
            ? undefined
            : {
                pid: provisionalIdentity.pid,
                incarnation: provisionalIdentity.incarnation,
                processGroupId: provisionalIdentity.processGroupId,
              },
        );
      },
      (
        identity: DurableCliProcessSubject | DurableProvisionalProcessSubject,
        containmentStatus?: DurableContainmentStatus,
        control?: DurableContainmentOperatorControl,
      ) => {
        const provisional = 'kind' in identity;
        if (containmentStatus === undefined) {
          if (!provisional) {
            writeDurableCliProcessRuntimeMeta(this.deps.progressStore.getDb(), {
              jobId,
              ...identity,
            });
          }
          return { kind: 'published' };
        }
        const evidence = provisional
          ? { kind: 'unavailable' as const, reason: 'missing' as const }
          : ({ kind: 'current' as const, record: { jobId, ...identity } } as const);
        switch (containmentStatus.kind) {
          case 'held': {
            if (control !== undefined) {
              this.deps.abortRegistry.hold(
                jobId,
                containmentStatus.reason,
                `Run coral-cli abort jobs ${jobId} again to abandon job ownership without proving process absence or sending another signal.`,
                control.abandon,
              );
            }
            return publishDurableContainmentDisposition({
              persist: () =>
                writeDurableCliContainmentStatus(this.deps.progressStore.getDb(), {
                  jobId,
                  evidence,
                  disposition: containmentStatus,
                }),
              persistenceFailure: 'durable containment hold persistence failed',
              ...(control === undefined
                ? {}
                : {
                    onPersistenceFailure: (reason: string) =>
                      this.deps.abortRegistry.hold(
                        jobId,
                        reason,
                        `Run coral-cli abort jobs ${jobId} again to retry durable abandonment without sending another signal.`,
                        control.abandon,
                      ),
                  }),
              progress:
                `Durable containment pid=${identity.pid} is held (${containmentStatus.reason}). ` +
                `Cleanup retries every ${containmentStatus.retryIntervalMs}ms. Run coral-cli abort jobs ${jobId} to ` +
                'abandon the hold; abandonment releases job ownership without proving process absence or terminating the process.',
              progressFailure: 'hold progress',
            });
          }
          case 'absence-confirmed': {
            return publishDurableContainmentDisposition({
              persist: () => deleteDurableCliContainmentStatus(this.deps.progressStore.getDb(), jobId),
              persistenceFailure: 'durable containment absence publication failed',
              afterPersistence: () => this.deps.abortRegistry.releaseHold(jobId),
              progress: `Durable containment pid=${identity.pid} is absent.`,
              progressFailure: 'absence progress',
            });
          }
          case 'operator-abandoned': {
            return publishDurableContainmentDisposition({
              persist: () =>
                writeDurableCliContainmentStatus(this.deps.progressStore.getDb(), {
                  jobId,
                  evidence,
                  disposition: containmentStatus,
                }),
              persistenceFailure: 'durable containment abandonment publication failed',
              afterPersistence: () => this.deps.abortRegistry.releaseHold(jobId),
              progress: `Durable containment pid=${identity.pid} was abandoned without proof of process absence or termination.`,
              progressFailure: 'abandonment progress',
            });
          }
        }
      },
      jobId,
      { permit, abortHoldOwner: this.deps.abortRegistry },
    );
    return {
      kind: 'local',
      stream: prepared.execute({
        ...runtime,
        transport: 'standalone',
        runCli: (request) => runCli(prepared.prepareCliRequest(request)),
      }),
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

  private async waitForQueuedPermit(admission: QueuedHandle, signal: AbortSignal): Promise<QueuedPermitOutcome> {
    return new Promise<QueuedPermitOutcome>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
      };

      const onAbort = () => {
        if (settled) return;
        settled = true;
        const cancellation = admission.cancel();
        if (cancellation.kind === 'admitted') void this.deps.launchAdmission.releaseLaunch(cancellation.permit);
        cleanup();
        resolve({ kind: 'aborted' });
      };

      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener('abort', onAbort, { once: true });
      admission
        .waitForPermit()
        .then((permit) => {
          if (settled) {
            void this.deps.launchAdmission.releaseLaunch(permit);
            return;
          }
          settled = true;
          cleanup();
          resolve({ kind: 'admitted', permit });
        })
        .catch((error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private registerLaunchAbort(jobId: string, admission: AcceptedAdmission): void {
    this.deps.abortRegistry.register(
      jobId,
      () => this.deps.operations?.stop(jobId, 'signal_abort'),
      () => this.releaseAdmissionReservation(admission),
    );
  }

  private finishAbortedJob(jobId: string, sessionId: string, reason: AbortReason): void {
    const { abortRegistry, sessionManager } = this.deps;
    this.appendJobEvent(jobId, sessionId, 'job.aborted', { reason });
    this.writeJobTerminal(
      jobId,
      sessionId,
      { content: '', outcome: { kind: 'aborted', reason }, durationMs: this.elapsedJobDurationMs(jobId) },
      'aborted',
    );
    abortRegistry.remove(jobId);
    void sessionManager.releaseJob(sessionId, jobId);
  }
}
