import { localProviderHostRoot } from '../../infra/bundle-manifest.js';
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

type PreparedProviderLaunchContext = Readonly<{
  provider: BoundProvider;
  runtime: BoundProviderExecutionRuntimeCommon;
  jobId: string;
  signal: AbortSignal;
  permit: LaunchPermit;
  requestForRoute: ProviderRequest;
  persistedContinuity: ProviderContinuityBlob | undefined;
  operationEnvironment: Readonly<{
    env: Readonly<Record<string, string>>;
    childAuthorization?: ProviderOperationChildAuthorization;
  }>;
  execution: number;
  forceLocalAppServerPlacement: boolean;
}>;

type PreparedProviderExecutionResult =
  | Readonly<{ kind: 'local'; stream: AsyncIterable<ProviderEventBody> }>
  | Readonly<{ kind: 'proxied'; operationId: string }>
  | Readonly<{ kind: 'terminalized' }>
  | Readonly<{ kind: 'cancelled' }>;

type DurableContainmentPublication = Readonly<{
  persist(): void;
  persistenceFailure: string;
  onPersistenceFailure?(reason: string): void;
  afterPersistence?(): void;
  progress: string;
  progressFailure: string;
}>;
import { errorMessage } from '../../infra/error-format.js';
import { nowIsoString } from '../../infra/time.js';
import { backendLog } from '../../infra/backend-log.js';
import { type ProviderJobLaunchDecision, refuseLaunch } from '../launch.js';
import { isTerminalPhase, type JobPhase } from '../phase.js';
import type { JobLaunch, JobTerminalInput } from '../records.js';
import type { RetentionPolicy, JobConversation } from '../conversation/entry.js';
import { type AbortReason, type JobAbortedBody, type JobLaunchRejected } from '../outcome.js';
import type { JobQueueAdmittedBody, JobQueueQueuedBody } from '../event-bodies.js';
import { type AbortRegistry } from './abort-registry.js';
import { CliBusyError } from '../../runtime/cli-busy.js';
import { isAbortError } from '../../runtime/abort.js';
import {
  SuccessionAdmissionPausedError,
  type AcceptedAdmission,
  type AdmissionResult,
  type JobAdmissionPort,
  type LaunchPermit,
  type LaunchPool,
  type QueuedHandle,
  type SettlementRefusal,
  type SettlementRefusalRecorder,
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
import type { ConversationInitialLaunchPort, ConversationContinuityPort } from '../conversation/contracts.js';
import type { CoralEventInput } from '../../store/envelope.js';
import type { ExecutionFinisher } from '../finishing.js';
import type { CommitEventsFn } from '../../store/append.js';
import { SuccessionWriterParkedError } from '../../store/db.js';
import { consumeJobStream } from './continuity-consumer.js';
import { appendJobExecutionOutcomeAccepted, failedTerminalOutcome } from '../terminal/recording.js';
import type { ProviderContinuityBlob } from '../conversation/continuity.js';
import { toProviderRequest } from '../provider-request.js';
import { TerminalWriteError } from '../terminal/write-error.js';
import { buildJobEventRefs } from '../refs.js';
import { resolveEquippedTools } from '../../expansion/equipped-tools.js';
import { applyInjectBundle } from '../../providers/inject.js';
import { ProviderBindingRuntimeError } from '../../providers/contracts/binding.js';
import { ProviderHostUnserviceableError } from '../../providers/host-admission.js';
import type { ProviderBindingCatalog } from '../../providers/catalog.js';
import { jobExecutionRequestedBodySchema, jobOpenedBodySchema } from '../launch.js';
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
type LauncherJobEventBody =
  | Omit<JobQueueAdmittedBody, 'execution'>
  | Omit<JobQueueQueuedBody, 'execution'>
  | Omit<JobAbortedBody, 'execution'>;
type JobExecutionDisposition =
  | 'settled'
  | 'suspended'
  | 'handed-off'
  | 'proxied'
  | 'terminalized'
  | 'recovery-held'
  | SettlementRefusal;
type QueuedPermitOutcome = Readonly<{ kind: 'admitted'; permit: LaunchPermit }> | Readonly<{ kind: 'aborted' }>;

function releasesLaunchPermit(disposition: JobExecutionDisposition): boolean {
  switch (disposition) {
    case 'settled':
    case 'suspended':
    case 'terminalized':
      return true;
    case 'handed-off':
    case 'proxied':
    case 'recovery-held':
      return false;
  }
  switch (disposition.cause) {
    case 'terminal-persist-failed':
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
  executionFinisher: ExecutionFinisher;
  progressStore: JobProgressStore;
  conversationManager: ConversationContinuityPort & ConversationInitialLaunchPort;
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
      finisher: ExecutionFinisher,
      terminal: Extract<ProviderEventBody, { kind: 'terminal' }>,
      options: {
        readonly jobId: string;
        readonly execution: number;
        readonly namespace?: string;
        readonly project?: string;
        readonly correlationId?: string;
      },
    ): Promise<unknown>;
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

function executionKey(jobId: string, execution: number): string { return `${jobId}:${execution}`; }

export class LaunchOrchestrator implements ProviderOperationCleanupOwner {
  // Tracks every admitted app-server job before its first asynchronous
  // preparation boundary. Quiesce-for-handoff acts on this set; CLI/durable
  // jobs not in the set keep the existing handoff preservation behavior.
  private readonly runTasks = new Set<string>();
  private readonly appServerJobs = new Set<string>();
  private readonly localAppServerExecutions = new Set<string>();
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

  holdsLocalAppServerExecution(jobId: string, execution: number): boolean {
    return this.localAppServerExecutions.has(executionKey(jobId, execution)) && !this.quiescedAppServerJobs.has(executionKey(jobId, execution));
  }

  releaseProviderOperationLocalState(identity: ProviderOperationCleanupIdentity): boolean {
    const { jobId, execution } = identity;
    const ownsLocalState =
      this.deps.abortRegistry.getSignal(jobId, execution) !== null ||
      this.appServerJobs.has(executionKey(jobId, execution)) ||
      this.appServerHandoffAborts.has(executionKey(jobId, execution));
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
    this.deps.abortRegistry.remove(jobId, execution);
    this.appServerJobs.delete(executionKey(jobId, execution));
    this.localAppServerExecutions.delete(executionKey(jobId, execution));
    this.appServerHandoffAborts.delete(executionKey(jobId, execution));
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

  private trackAppServerWrite<T>(jobId: string, execution: number, operation: () => Promise<T>): Promise<T> {
    // Install the fence entry before invoking any persistence code. The
    // operation may synchronously trigger observers that begin handoff.
    const write = Promise.resolve().then(operation);
    const writes = this.inFlightAppServerWrites.get(executionKey(jobId, execution)) ?? new Set<Promise<unknown>>();
    this.inFlightAppServerWrites.set(executionKey(jobId, execution), writes);
    writes.add(write);
    void write
      .finally(() => {
        writes.delete(write);
        if (writes.size === 0) this.inFlightAppServerWrites.delete(executionKey(jobId, execution));
      })
      .catch(() => undefined);
    return write;
  }

  private preserveAppServerJobForHandoff(provider: BoundProvider, jobId: string, execution: number): boolean {
    if (!this.appServerHandoffQuiesced || provider.appServer === undefined) return false;
    this.quiescedAppServerJobs.add(executionKey(jobId, execution));
    return true;
  }

  private registerAppServerJob(provider: BoundProvider, jobId: string, execution: number, jobSignal: AbortSignal): AbortSignal {
    if (provider.appServer === undefined) return jobSignal;
    this.appServerJobs.add(executionKey(jobId, execution));
    const handoffAbort = new AbortController();
    this.appServerHandoffAborts.set(executionKey(jobId, execution), handoffAbort);
    if (this.appServerHandoffQuiesced) {
      this.quiescedAppServerJobs.add(executionKey(jobId, execution));
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
    conversationJobId: string,
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
          parentJobId: options.parentJobId,
          workflowSlotId: options.workflowSlotId,
        }),
        body: { ...body, execution: this.requireExecution(jobId) },
      });
      return undefined;
    });
  }

  private appendProgressEvent(jobId: string, conversationJobId: string, message: string): void {
    this.deps.progressStore.appendProgress(jobId, conversationJobId, message);
  }

  private requireExecution(jobId: string): number {
    const status = this.deps.progressStore.readStatus(jobId);
    if (status === null || status.execution === null) throw new Error(`Job '${jobId}' has no execution to accept an outcome for.`);
    return status.execution;
  }

  private async appendLaunchRejectedTerminal(
    jobId: string,
    conversationJobId: string,
    body: JobLaunchRejected,
    options: {
      parentJobId?: string;
      workflowSlotId?: string;
      projectRoot?: string;
    } = {},
  ): Promise<void> {
    const metadata = this.resolveEventMetadata(jobId, options.projectRoot);
    const workflowId = options.parentJobId;
    const execution = this.requireExecution(jobId);
    await this.deps.executionFinisher.accept({ jobId, execution }, (c) => {
      const cause = c.append({
        type: 'job.provider_failed',
        stream: { kind: 'job', id: jobId },
        namespace: metadata.namespace,
        project: metadata.project,
        correlationId: metadata.correlationId,
        refs: buildJobEventRefs({
          jobId,
          parentJobId: options.parentJobId,
          workflowId,
          workflowSlotId: options.workflowSlotId,
        }),
        body: { execution, provider: body.provider, reason: 'request_failed', message: body.message },
      });
      appendJobExecutionOutcomeAccepted(c, {
        jobId,
        execution,
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
  }

  launchExecution(
    provider: BoundProvider,
    conversation: JobConversation,
    request: ProviderRequest,
    opts: ProviderLaunchOptions & {
      owner: ExecutionOwner;
      mintProtectedEnv: (jobId: string, execution: number) => ProviderOperationEnvironmentInput;
    },
  ): ProviderJobLaunchDecision {
    const jobId = conversation.jobId;
    const execution = conversation.execution + 1;
    if (this.runTasks.has(executionKey(jobId, conversation.execution)))
      return refuseLaunch('execution_finishing', `Execution #${conversation.execution} of ${jobId} is still completing cleanup. Wait for it to finish.`);
    const pool = opts.pool ?? 'default';
    const admission = this.reserveAdmission(jobId, provider.name, opts.owner, pool,
      opts.owner.kind === 'workflow' || opts.owner.kind === 'discussion');
    if (admission === 'queue_full') return refuseLaunch('busy', QUEUE_FULL_MESSAGE);
    if (admission instanceof SuccessionAdmissionPausedError) {
      return refuseLaunch('succession_admission_paused', admission.message);
    }
    try {
      const metadata = this.resolveEventMetadata(jobId, conversation.projectRoot);
      const hostedRequest = {
        ...request,
        jobId,
        coralEnv: { ...request.coralEnv, CORAL_JOB_ID: jobId },
      };
      this.deps.progressStore.withExecutionAdmission(jobId, execution, {
        projectRoot: conversation.projectRoot, workDir: conversation.cwd, jobKind: 'provider',
      }, () => {
      this.deps.coordinatorCommit(commit => {
        const current = this.deps.conversationManager.readById(jobId, { forceFresh: true });
        if (conversation.execution === 0 ? current !== null
          : current === null || current.open || current.execution !== conversation.execution) {
          throw new Error(`Job ${jobId} no longer admits execution #${execution}.`);
        }
        const refs = buildJobEventRefs({ jobId, parentJobId: opts.parentWorkflowJobId,
          workflowId: opts.parentWorkflowJobId, workflowSlotId: opts.workflowSlotId });
        if (execution === 1) {
          const { provider: providerName, binding, cwd, name, model, effort, agent, instruction,
            bypassPermissions, systemPrompt, retention, controllerProfile } = conversation;
          commit.append({
            type: 'job.opened', stream: { kind: 'job', id: jobId }, ...metadata, refs,
            body: jobOpenedBodySchema.parse({
              jobKind: 'provider', owner: opts.owner, projectRoot: conversation.projectRoot,
              createdAt: conversation.createdAt, workflowSlotId: opts.workflowSlotId,
              conversation: { provider: providerName, binding, cwd, name, model, effort, agent, instruction,
                bypassPermissions, systemPrompt, retention, controllerProfile },
            }),
          });
        }
        commit.append({
          type: 'job.execution.requested', stream: { kind: 'job', id: jobId }, ...metadata, refs,
          body: jobExecutionRequestedBodySchema.parse({
            execution, input: hostedRequest.prompt, action: hostedRequest.action, pool,
            enqueueSequence: this.deps.progressStore.nextEnqueueSequence(),
            coralEnv: hostedRequest.coralEnv, createdAt: nowIsoString(this.deps.runtime.time),
            backendNamespace: this.deps.backendNamespace, bundleHash: this.deps.bundleHash,
            discussionRun: opts.discussionRun,
          }),
        });
        commit.append({
          type: admission.type === 'queued' ? 'job.execution.queued' : 'job.execution.admitted',
          stream: { kind: 'job', id: jobId }, ...metadata, refs,
          body: admission.type === 'queued'
            ? { execution, queuePosition: admission.queuePosition, runningJobIds: [] }
            : { execution, queuePosition: 0 },
        });
        return undefined;
      });
      });
      this.activateCommittedProviderLaunch({ provider, conversationJobId: jobId, jobId,
        execution, request: hostedRequest, admission, pool, mintProtectedEnv: opts.mintProtectedEnv });
    } catch (error) {
      this.releaseAdmissionReservation(admission);
      throw error;
    }
    return { kind: 'provider-session', status: admission.type === 'queued' ? 'queued' : 'running', jobId };
  }

  private reserveAdmission(
    jobId: string,
    provider: string,
    owner: ExecutionOwner,
    pool: LaunchPool,
    acceptedWork = false,
  ): AdmissionResult | SuccessionAdmissionPausedError {
    try {
      return this.deps.launchAdmission.requestLaunch(jobId, provider, owner, pool, acceptedWork);
    } catch (error: unknown) {
      if (error instanceof SuccessionAdmissionPausedError) return error;
      throw error;
    }
  }

  private releaseAdmissionReservation(admission: AcceptedAdmission): void {
    if (admission.type === 'queued') {
      const cancellation = admission.cancel();
      if (cancellation.kind === 'admitted') void this.deps.launchAdmission.releaseLaunch(cancellation.permit);
      return;
    }
    void this.deps.launchAdmission.releaseLaunch(admission.permit);
  }

  private activateCommittedProviderLaunch(input: {
    provider: BoundProvider;
    conversationJobId: string;
    jobId: string;
    request: ProviderRequest;
    admission: AcceptedAdmission;
    pool: LaunchPool;
    execution: number;
    mintProtectedEnv: (jobId: string, execution: number) => ProviderOperationEnvironmentInput;
  }): void {
    try {
      // Registered before placement so the same signal governs either owner. Local execution observes the
      // signal directly; durable publication rechecks an already-aborted signal at insertion and records later
      // stops in the saga before the proxy can act on them.
      this.registerLaunchAbort(input.jobId, input.execution, input.admission);
      if (this.deps.abortRegistry.getSignal(input.jobId, input.execution) === null) {
        throw new Error(`Abort registration produced no signal for committed job ${input.jobId}.`);
      }
      this.deps.runtime.storage.mkdirSync(this.deps.progressStore.jobDir(input.jobId), { recursive: true });
      if (input.admission.type === 'queued') {
        this.appendProgressEvent(input.jobId, input.conversationJobId, `queued (position ${input.admission.queuePosition})`);
      }
      const protectedEnv = input.mintProtectedEnv(input.jobId, input.execution);
      this.runAsync(
        input.provider,
        input.conversationJobId,
        input.jobId,
        input.request,
        input.admission,
        input.pool,
        protectedEnv,
      );
    } catch (error: unknown) {
      void this.finalizeCommittedLaunchSetupFailure(input.jobId, input.conversationJobId, input.admission, error);
      throw error;
    }
  }

  private async finalizeCommittedLaunchSetupFailure(
    jobId: string,
    conversationJobId: string,
    admission: AcceptedAdmission,
    error: unknown,
  ): Promise<void> {
    const execution = this.requireExecution(jobId);
    const signal = this.deps.abortRegistry.getSignal(jobId, execution) ?? new AbortController().signal;
    let disposition: JobExecutionDisposition = 'terminalized';
    try {
      disposition = await this.handleProviderJobErrorOnceWritable(jobId, conversationJobId, signal, error);
    } catch (finalizationError: unknown) {
      backendLog.error(
        `Failed to terminalize committed provider launch ${jobId}: ${errorMessage(finalizationError)}`,
        finalizationError,
      );
      return;
    }

    if (disposition === 'recovery-held') return;

    this.deps.abortRegistry.remove(jobId, execution);
    this.releaseAdmissionReservation(admission);
  }

  runAsync(
    provider: BoundProvider,
    conversationJobId: string,
    jobId: string,
    request: ProviderRequest,
    admission: AcceptedAdmission,
    pool: LaunchPool,
    protectedEnv?: ProviderOperationEnvironmentInput,
  ): void {
    const { abortRegistry, launchAdmission } = this.deps;
    const execution = this.requireExecution(jobId);
    const signal = abortRegistry.getSignal(jobId, execution);
    if (!signal) {
      this.releaseAdmissionReservation(admission);
      return;
    }

    const executionSignal = this.registerAppServerJob(provider, jobId, execution, signal);

    this.runTasks.add(executionKey(jobId, execution));
    void (async () => {
      let permit = admission.type === 'immediate' ? admission.permit : null;
      let disposition: JobExecutionDisposition = 'terminalized';

      try {
        if (this.preserveAppServerJobForHandoff(provider, jobId, execution)) {
          disposition = 'handed-off';
          return;
        }
        if (admission.type === 'queued') {
          const queueOutcome = await this.waitForQueuedPermit(admission, signal);
          if (queueOutcome.kind === 'aborted') {
            await this.finishQueuedAbort(jobId, conversationJobId, 'queue_shutdown');
            return;
          }

          permit = queueOutcome.permit;
          if (this.preserveAppServerJobForHandoff(provider, jobId, execution)) {
            disposition = 'handed-off';
            return;
          }
          this.appendJobEvent(jobId, conversationJobId, 'job.execution.admitted', {});
          this.appendProgressEvent(jobId, conversationJobId, 'dequeued, launching');
        }
        if (permit === null || permit.pool !== pool) {
          throw new Error(`Launch permit for ${jobId} does not match its admitted pool.`);
        }

        disposition = await this.executeJob(provider, request, jobId, execution, conversationJobId, executionSignal, permit, protectedEnv);
      } catch (error: unknown) {
        if (error instanceof TerminalWriteError) {
          backendLog.error(error.message, error.cause);
          return;
        }
        if (this.quiescedAppServerJobs.has(executionKey(jobId, execution))) {
          disposition = 'handed-off';
          return;
        }
        try {
          disposition = await this.handleProviderJobErrorOnceWritable(jobId, conversationJobId, signal, error);
        } catch (finalizeError: unknown) {
          if (finalizeError instanceof TerminalWriteError) {
            backendLog.error(finalizeError.message, finalizeError.cause);
            return;
          }
          throw finalizeError;
        }
      } finally {
        if (permit !== null && releasesLaunchPermit(disposition)) void launchAdmission.releaseLaunch(permit);
        this.appServerJobs.delete(executionKey(jobId, execution));
        this.localAppServerExecutions.delete(executionKey(jobId, execution));
        this.quiescedAppServerJobs.delete(executionKey(jobId, execution));
        this.appServerHandoffAborts.delete(executionKey(jobId, execution));
        this.runTasks.delete(executionKey(jobId, execution));
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
    const conversationJobId = launchRecord.jobId;
    const forceLocalAppServerPlacement = isRecoveredLegacyWorkflowSlotJob(launchRecord);
    if (conversationJobId === null) {
      throw new Error(`Recovered queued job ${jobId} requires a provider session id.`);
    }
    const execution = launchRecord.execution;
    this.registerLaunchAbort(jobId, execution, admission);
    const signal = abortRegistry.getSignal(jobId, execution);
    if (!signal) {
      this.releaseAdmissionReservation(admission);
      return;
    }

    const executionSignal = this.registerAppServerJob(provider, jobId, execution, signal);

    this.runTasks.add(executionKey(jobId, execution));
    void (async () => {
      let permit: LaunchPermit | null = null;
      let disposition: JobExecutionDisposition = 'terminalized';
      try {
        if (this.preserveAppServerJobForHandoff(provider, jobId, execution)) {
          disposition = 'handed-off';
          return;
        }
        const queueOutcome = await this.waitForQueuedPermit(admission, signal);
        if (queueOutcome.kind === 'aborted') {
          await this.finishQueuedAbort(jobId, conversationJobId, 'queue_shutdown');
          return;
        }

        permit = queueOutcome.permit;
        if (this.preserveAppServerJobForHandoff(provider, jobId, execution)) {
          disposition = 'handed-off';
          return;
        }
        this.appendJobEvent(jobId, conversationJobId, 'job.execution.admitted', {});
        this.appendProgressEvent(jobId, conversationJobId, 'dequeued, launching');
        if (forceLocalAppServerPlacement) {
          this.appendProgressEvent(jobId, conversationJobId, 'pre-upgrade workflow child recovered with local placement');
        }
        if (permit.pool !== pool) {
          throw new Error(`Recovered launch permit for ${jobId} does not match its admitted pool.`);
        }

        const session = this.deps.conversationManager.get(provider.name, conversationJobId);
        if (session === null) {
          throw new Error(`Recovered queued job ${jobId} has no provider session snapshot.`);
        }
        disposition = await this.executeJob(
          provider,
          toProviderRequest(launchRecord, session.conversationRef),
          jobId,
          execution,
          conversationJobId,
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
        if (this.quiescedAppServerJobs.has(executionKey(jobId, execution))) {
          disposition = 'handed-off';
          return;
        }
        try {
          disposition = await this.handleProviderJobErrorOnceWritable(jobId, conversationJobId, signal, error);
        } catch (finalizeError: unknown) {
          if (finalizeError instanceof TerminalWriteError) {
            backendLog.error(finalizeError.message, finalizeError.cause);
            return;
          }
          throw finalizeError;
        }
      } finally {
        if (permit !== null && releasesLaunchPermit(disposition)) void launchAdmission.releaseLaunch(permit);
        this.appServerJobs.delete(executionKey(jobId, execution));
        this.localAppServerExecutions.delete(executionKey(jobId, execution));
        this.quiescedAppServerJobs.delete(executionKey(jobId, execution));
        this.appServerHandoffAborts.delete(executionKey(jobId, execution));
        this.runTasks.delete(executionKey(jobId, execution));
      }
    })();
  }

  private async finishQueuedAbort(jobId: string, conversationJobId: string, reason: AbortReason): Promise<void> {
    await this.finishAbortedJob(jobId, conversationJobId, reason);
  }

  async failJob(jobId: string, conversationJobId: string, terminal: JobTerminalInput): Promise<void> {
    const execution = this.requireExecution(jobId);
    await this.writeJobTerminal(jobId, conversationJobId, terminal, 'error');
    this.releaseTerminalJob(jobId, execution);
  }

  private releaseTerminalJob(jobId: string, execution: number): void {
    const { abortRegistry } = this.deps;
    abortRegistry.remove(jobId, execution);
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

  async writeJobTerminal(
    jobId: string,
    _conversationJobId: string,
    result: JobTerminalInput,
    _phase: JobPhase,
    options: TerminalWriteOptions = {},
  ): Promise<number> {
    for (;;) {
      try {
        const status = this.deps.progressStore.readStatus(jobId);
        const execution = this.requireExecution(jobId);
        const accepted = await this.deps.executionFinisher.accept({ jobId, execution }, (c) => {
          appendJobExecutionOutcomeAccepted(c, {
            jobId,
            execution,
            namespace: status?.backendNamespace ?? this.deps.backendNamespace,
            project: status?.projectRoot,
            terminal: result,
            diagnostics: options.diagnostics,
          });
          return undefined;
        });
        return accepted.seq;
      } catch {
        await this.deps.runtime.time.sleep(500);
      }
    }
  }

  private async executeJob(
    provider: BoundProvider,
    request: ProviderRequest,
    jobId: string,
    execution: number,
    conversationJobId: string,
    signal: AbortSignal,
    permit: LaunchPermit,
    protectedEnv?: ProviderOperationEnvironmentInput,
    options: { forceLocalAppServerPlacement?: boolean } = {},
  ): Promise<JobExecutionDisposition> {
    const session = this.deps.conversationManager.get(provider.name, conversationJobId);
    if (!session) {
      throw new ProviderBindingRuntimeError(
        { reason: 'invalid-persisted-binding', provider: provider.name },
        `Provider session ${conversationJobId} has no binding.`,
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
    this.readExecutionOrdinal(provider.name, conversationJobId, jobId, execution);
    const readiness = await provider.readiness('launch', this.deps.runtime.storage);
    if (this.preserveAppServerJobForHandoff(provider, jobId, execution)) return 'handed-off';
    if (!readiness.ok) {
      throw new ProviderBindingRuntimeError(
        readiness.failure,
        this.deps.providerRegistry.renderBindingFailure(readiness.failure),
      );
    }
    const equippedTools = resolveEquippedTools(this.deps.runtime);
    const requestWithInject = applyInjectBundle(request, {
      storage: this.deps.runtime.storage,
      equippedTools,
      ...(request.cwd
        ? {
            coralProjects: this.deps.runtime.paths.projectData(request.cwd),
          }
        : {}),
    });
    const operationEnvironment = providerOperationEnvironment(protectedEnv);
    const hostRoot =
      options.forceLocalAppServerPlacement === true
        ? localProviderHostRoot()
        : (this.deps.appServerProxyRoute?.hostRoot() ?? localProviderHostRoot());
    const prepared = provider.prepareExecution({
      hostRoot,
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
      conversationJobId,
      jobId,
      signal,
      continuity.value,
      equippedTools,
    );
    try {
      const providerStream = await this.executePreparedProvider(prepared, {
        provider,
        runtime,
        jobId,
        signal,
        permit,
        requestForRoute: requestWithInject,
        persistedContinuity: continuity.value,
        operationEnvironment,
        execution: execution,
        forceLocalAppServerPlacement: options.forceLocalAppServerPlacement === true,
      });
      if (providerStream.kind === 'cancelled') {
        signal.throwIfAborted();
        throw new Error('App-server placement was cancelled without an aborted launch signal.');
      }
      if (providerStream.kind === 'terminalized') {
        this.releaseTerminalJob(jobId, execution);
        return 'terminalized';
      }
      if (providerStream.kind === 'proxied') {
        return 'proxied';
      }
      const consumed = await consumeJobStream({
        jobId,
        execution,
        decodeContinuity: (rawContinuity) => provider.decodeContinuity(rawContinuity),
        stream: providerStream.stream,
        sessionApi: {
          checkpointJobContinuityAtomic: async (claimedSessionId, options) => {
            if (this.quiescedAppServerJobs.has(executionKey(jobId, execution))) {
              return { ok: false as const };
            }
            const result = await this.trackAppServerWrite(jobId, execution, () =>
              this.deps.conversationManager.checkpointJobContinuityAtomic(claimedSessionId, options),
            );
            if (this.quiescedAppServerJobs.has(executionKey(jobId, execution))) return { ok: false as const };
            return result;
          },
          recordArtifactHandleAtomic: async (claimedSessionId, options) => {
            if (this.quiescedAppServerJobs.has(executionKey(jobId, execution))) {
              return { ok: false as const };
            }
            const result = await this.trackAppServerWrite(jobId, execution, () =>
              this.deps.conversationManager.recordArtifactHandleAtomic(claimedSessionId, options),
            );
            if (this.quiescedAppServerJobs.has(executionKey(jobId, execution))) return { ok: false as const };
            return result;
          },
        },
        appendProgress: (message) => {
          if (this.quiescedAppServerJobs.has(executionKey(jobId, execution))) return;
          this.appendProgressEvent(jobId, conversationJobId, message);
        },
      });
      if (this.quiescedAppServerJobs.has(executionKey(jobId, execution))) return 'handed-off';
      if (consumed.kind === 'suspended') return 'suspended';
      const completion = this.trackAppServerWrite(jobId, execution, () =>
        this.completeConsumedJob({
          conversationJobId,
          jobId,
          projectRoot: request.cwd,
          event: consumed.event,
          execution: consumed.execution,
        }),
      );
      return await completion;
    } finally {
      this.inFlightAppServerWrites.delete(executionKey(jobId, execution));
    }
  }

  private async completeConsumedJob(options: {
    conversationJobId: string;
    jobId: string;
    projectRoot: string | undefined;
    event: Extract<ProviderEventBody, { kind: 'terminal' }>;
    execution: number;
  }): Promise<'settled' | SettlementRefusal> {
    const { conversationJobId, jobId, projectRoot, event, execution } = options;

    await this.appendProviderTerminal(jobId, conversationJobId, projectRoot, event);

    this.deps.abortRegistry.remove(jobId, execution);
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

  private async handleProviderJobErrorOnceWritable(
    jobId: string,
    conversationJobId: string,
    signal: AbortSignal,
    error: unknown,
  ): Promise<JobExecutionDisposition> {
    for (;;) {
      try {
        return await this.handleProviderJobError(jobId, conversationJobId, signal, error);
      } catch (finalizeError: unknown) {
        if (finalizeError instanceof SuccessionWriterParkedError) await finalizeError.unparked;
        else await this.deps.runtime.time.sleep(500);
      }
    }
  }


  private async handleProviderJobError(
    jobId: string,
    conversationJobId: string,
    signal: AbortSignal,
    error: unknown,
  ): Promise<JobExecutionDisposition> {
    const execution = this.requireExecution(jobId);
    const currentStatus = this.deps.progressStore.readStatus(jobId);
    if (!currentStatus || isTerminalPhase(currentStatus.phase)) {
      return 'terminalized';
    }

    if (error instanceof CliBusyError) {
      await this.appendLaunchRejectedTerminal(jobId, conversationJobId, {
        reason: 'busy',
        message: error.message,
        provider: error.detail.provider,
        globalActive: error.detail.globalActive,
        globalLimit: error.detail.globalLimit,
      });
      this.releaseTerminalJob(jobId, execution);
      return 'terminalized';
    }

    if (error instanceof ProviderHostUnserviceableError) {
      const durationMs = this.elapsedJobDurationMs(jobId);
      try {
        await this.deps.executionFinisher.accept({ jobId, execution: currentStatus.execution }, (commit) => {
          const cause = commit.append({
            type: 'job.execution.progress',
            stream: { kind: 'job', id: jobId },
            namespace: currentStatus.backendNamespace,
            project: currentStatus.projectRoot,
            refs: buildJobEventRefs({ jobId, }),
            body: {
              execution: currentStatus.execution,
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
          appendJobExecutionOutcomeAccepted(commit, {
            jobId,
            execution: currentStatus.execution,
            namespace: currentStatus.backendNamespace,
            project: currentStatus.projectRoot,
            terminal: { content: '', durationMs, outcome: failedTerminalOutcome(cause) },
          });
          return undefined;
        });
      } catch (terminalError: unknown) {
        throw new TerminalWriteError(jobId, terminalError);
      }
      this.releaseTerminalJob(jobId, execution);
      return 'terminalized';
    }

    if (signal.aborted || isAbortError(error)) {
      await this.finishAbortedJob(jobId, conversationJobId, 'signal_abort');
      return 'terminalized';
    }

    if (error instanceof ProviderBindingRuntimeError) {
      await this.failJob(jobId, conversationJobId, {
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
      return 'terminalized';
    }

    await this.failJob(jobId, conversationJobId, {
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
    return 'terminalized';
  }

  private markJobQueued(jobId: string, conversationJobId: string, queuePosition: number): void {
    this.appendJobEvent(jobId, conversationJobId, 'job.execution.queued', {
      queuePosition,
      runningJobIds: [],
    });
    this.appendProgressEvent(jobId, conversationJobId, `queued (position ${queuePosition})`);
  }

  private createProviderRuntime(
    provider: BoundProvider,
    request: ProviderRequest,
    conversationJobId: string,
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
    prepared: BoundProviderPreparedExecution,
    launch: PreparedProviderLaunchContext,
  ): Promise<PreparedProviderExecutionResult> {
    if (prepared.kind === 'app-server') {
      if (launch.signal.aborted) return { kind: 'cancelled' };
      const proxyPlacement = await this.activateAppServerProxyPlacement(prepared, launch);
      if (proxyPlacement !== undefined) return proxyPlacement;
      const localPrepared = launch.provider.prepareExecution({
        hostRoot: localProviderHostRoot(),
        request: launch.requestForRoute,
        persistedContinuity: launch.persistedContinuity,
        baseEnv: this.deps.runtime.env.fullSnapshot(),
        protectedEnv: launch.operationEnvironment.env,
        platform: this.deps.runtime.env.platform(),
        storage: this.deps.runtime.storage,
      });
      if (localPrepared.kind !== 'app-server') throw new Error('Local placement requires an app-server provider.');
      return this.executeLocalAppServerPlacement(localPrepared, launch);
    }
    return this.executeStandalonePlacement(prepared, launch);
  }

  private async activateAppServerProxyPlacement(
    prepared: Extract<BoundProviderPreparedExecution, { kind: 'app-server' }>,
    launch: PreparedProviderLaunchContext,
  ): Promise<Exclude<PreparedProviderExecutionResult, { kind: 'local' }> | undefined> {
    const {
      provider,
      jobId,
      signal,
      permit,
      requestForRoute,
      persistedContinuity,
      operationEnvironment,
      execution,
      forceLocalAppServerPlacement,
    } = launch;
    const route = forceLocalAppServerPlacement ? undefined : this.deps.appServerProxyRoute;
    if (route === undefined) return undefined;
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
      throw new Error('Provider operation binding preparation failed: the new operation identity is already bound.');
    }

    let activation: Awaited<ReturnType<AppServerProxyRoute['activate']>>;
    try {
      activation = await route.activate(
        {
          jobId,
          operationId,
          jobLaunchEventSeq,
          execution,
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
      this.appServerJobs.delete(executionKey(jobId, execution));
      this.appServerHandoffAborts.delete(executionKey(jobId, execution));
      return { kind: 'proxied', operationId };
    }
    if (activation.kind === 'terminalized' || activation.kind === 'rekey-refused-contained') {
      return { kind: 'terminalized' };
    }
    const cancellation = this.deps.providerOperationBinding.cancelProviderOperationBinding(permit, operationIdentity);
    if (cancellation.kind === 'refused') {
      throw new Error(`Provider operation binding cancellation failed: ${cancellation.reason}.`);
    }
    return undefined;
  }

  private executeLocalAppServerPlacement(
    prepared: Extract<BoundProviderPreparedExecution, { kind: 'app-server' }>,
    launch: PreparedProviderLaunchContext,
  ): Extract<PreparedProviderExecutionResult, { kind: 'local' }> {
    const { runtime, jobId, execution } = launch;
    const ownsExecution = () => {
      const status = this.deps.progressStore.readStatus(jobId);
      return status?.execution === execution && status.finishing !== true && !isTerminalPhase(status.phase);
    };
    this.localAppServerExecutions.add(executionKey(jobId, execution));
    return {
      kind: 'local',
      stream: prepared.execute({
        ...runtime,
        transport: 'app-server',
        onAppServerWaiting: ({ provider: observedProvider }) => {
          if (!ownsExecution()) return;
          if (this.appServerHandoffQuiesced) {
            this.quiescedAppServerJobs.add(executionKey(jobId, execution));
            return;
          }
          this.deps.progressStore.appendRuntimeStarted(jobId, {
            transport: 'app-server',
            startTime: nowIsoString(this.deps.runtime.time.now()),
            providerMeta: { provider: observedProvider, leaseState: 'waiting' },
          });
        },
        onHostRef: (hostRef: HostRef) => {
          if (!ownsExecution()) return;
          if (this.appServerHandoffQuiesced || this.quiescedAppServerJobs.has(executionKey(jobId, execution))) return;
          this.deps.progressStore.appendRuntimeStarted(jobId, {
            transport: 'app-server',
            startTime: nowIsoString(this.deps.runtime.time.now()),
            providerMeta: { provider: hostRef.provider, leaseState: 'acquired', hostRef },
          });
        },
      }),
    };
  }

  private executeStandalonePlacement(
    prepared: Extract<BoundProviderPreparedExecution, { kind: 'standalone' }>,
    launch: PreparedProviderLaunchContext,
  ): Extract<PreparedProviderExecutionResult, { kind: 'local' }> {
    const { runtime } = launch;
    const runCli = this.createStandalonePlacementRunner(launch);
    return {
      kind: 'local',
      stream: prepared.execute({
        ...runtime,
        transport: 'standalone',
        runCli: (request) => runCli(prepared.prepareCliRequest(request)),
      }),
    };
  }

  private createStandalonePlacementRunner(
    launch: PreparedProviderLaunchContext,
  ): ReturnType<typeof bindProviderRunner> {
    const { provider, jobId, execution, signal, permit } = launch;

    return bindProviderRunner(
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
                `Run coral-cli jobs abort ${jobId} again to abandon job ownership without proving process absence or sending another signal.`,
                control.abandon,
                execution,
              );
            }
            return this.publishDurableContainmentDisposition(launch, {
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
                        `Run coral-cli jobs abort ${jobId} again to retry durable abandonment without sending another signal.`,
                        control.abandon,
                        execution,
                      ),
                  }),
              progress:
                `Durable containment pid=${identity.pid} is held (${containmentStatus.reason}). ` +
                `Cleanup retries every ${containmentStatus.retryIntervalMs}ms. Run coral-cli jobs abort ${jobId} to ` +
                'abandon the hold; abandonment releases job ownership without proving process absence or terminating the process.',
              progressFailure: 'hold progress',
            });
          }
          case 'absence-confirmed': {
            return this.publishDurableContainmentDisposition(launch, {
              persist: () => deleteDurableCliContainmentStatus(this.deps.progressStore.getDb(), jobId),
              persistenceFailure: 'durable containment absence publication failed',
              afterPersistence: () => this.deps.abortRegistry.releaseHold(jobId, execution),
              progress: `Durable containment pid=${identity.pid} is absent.`,
              progressFailure: 'absence progress',
            });
          }
          case 'operator-abandoned': {
            return this.publishDurableContainmentDisposition(launch, {
              persist: () =>
                writeDurableCliContainmentStatus(this.deps.progressStore.getDb(), {
                  jobId,
                  evidence,
                  disposition: containmentStatus,
                }),
              persistenceFailure: 'durable containment abandonment publication failed',
              afterPersistence: () => this.deps.abortRegistry.releaseHold(jobId, execution),
              progress: `Durable containment pid=${identity.pid} was abandoned without proof of process absence or termination.`,
              progressFailure: 'abandonment progress',
            });
          }
        }
      },
      jobId,
      { permit, abortHoldOwner: {
        hold: (id, reason, nextStep, abandon) => this.deps.abortRegistry.hold(id, reason, nextStep, abandon, execution),
        releaseHold: (id) => this.deps.abortRegistry.releaseHold(id, execution),
      } },
    );
  }

  private publishDurableContainmentDisposition(
    launch: PreparedProviderLaunchContext,
    publication: DurableContainmentPublication,
  ): DurableProcessPublicationDisposition {
    const { jobId, requestForRoute } = launch;
    try {
      publication.persist();
    } catch (error: unknown) {
      const reason = `${publication.persistenceFailure}: ${errorMessage(error)}`;
      publication.onPersistenceFailure?.(reason);
      return { kind: 'retained', reason };
    }
    publication.afterPersistence?.();
    try {
      this.appendProgressEvent(jobId, requestForRoute.jobId, publication.progress);
    } catch (error: unknown) {
      backendLog.warn(
        `Failed to append durable containment ${publication.progressFailure} for ${jobId}: ${errorMessage(error)}`,
      );
    }
    return { kind: 'published' };
  }

  private async appendProviderTerminal(
    jobId: string,
    _conversationJobId: string,
    projectRoot: string | undefined,
    event: Extract<ProviderEventBody, { kind: 'terminal' }>,
  ): Promise<void> {
    for (;;) {
      try {
        const metadata = this.resolveEventMetadata(jobId, projectRoot);
        const execution = this.requireExecution(jobId);
        await this.deps.terminalMaterializer.recordProviderTerminal(this.deps.executionFinisher, event, {
          jobId,
          execution,
          ...metadata,
        });
        return;
      } catch {
        await this.deps.runtime.time.sleep(500);
      }
    }
  }

  private readExecutionOrdinal(providerName: string, conversationJobId: string, jobId: string, execution: number): number {
    const session = this.deps.conversationManager.get(providerName, conversationJobId);
    if (!session || !session.open || session.jobId !== jobId || session.execution !== execution) {
      throw new Error(`Expected open execution of ${conversationJobId} for job ${jobId}.`);
    }
    return session.execution;
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

  private registerLaunchAbort(jobId: string, execution: number, admission: AcceptedAdmission): void {
    this.deps.abortRegistry.register(
      jobId,
      execution,
      () => this.deps.operations?.stop(jobId, 'signal_abort'),
      () => this.releaseAdmissionReservation(admission),
    );
  }

  private async finishAbortedJob(jobId: string, conversationJobId: string, reason: AbortReason): Promise<void> {
    const execution = this.requireExecution(jobId);
    for (;;) {
      try {
        const durationMs = this.elapsedJobDurationMs(jobId);
        await this.deps.executionFinisher.accept({ jobId, execution }, (c) => {
          c.append({ type: 'job.execution.aborted', stream: { kind: 'job', id: jobId }, body: { execution, reason } });
          appendJobExecutionOutcomeAccepted(c, {
            jobId,
            execution,
            terminal: { content: '', outcome: { kind: 'aborted', reason }, durationMs },
          });
          return undefined;
        });
        this.releaseTerminalJob(jobId, execution);
        return;
      } catch {
        await this.deps.runtime.time.sleep(500);
      }
    }
  }
}
