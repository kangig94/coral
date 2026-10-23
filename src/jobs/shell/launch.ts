import { EXECUTION_RETRY_MS } from '../finishing.js';
import { raceWithSignal } from '../../infra/promise-signal.js';
import { executionKey } from '../execution-address.js';
import { matchesContinuationEnvelope, matchesContinuationTarget, type JobSendTarget } from '../send-target.js';
import {
  committedExecutionRequest,
  committedProviderLaunchDecision,
  findCommittedExecutionRequest,
} from '../execution-journal.js';
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
import {
  type ProviderJobLaunchDecision,
  type RefusedLaunchDecision,
  type AcceptedProviderJobLaunchDecision,
  refuseLaunch,
  undeterminedLaunch,
} from '../launch.js';
import { isTerminalPhase, type JobPhase } from '../phase.js';
import type { JobLaunch, JobStatus, JobTerminal } from '../records.js';
import {
  hasUnterminalRetentionDiscardRequest,
  type RetentionPolicy,
  type JobConversation,
} from '../conversation/entry.js';
import { collectArtifactHandles } from '../conversation/artifact-discard.js';
import {
  publishConversationRestore,
  verifyConversationRestore,
  type ConversationRestoreVerification,
} from '../conversation/provider-artifact-archive.js';
import { withJobArtifactGuard } from '../conversation/artifact-guard.js';
import { hasProviderOperationForJob } from '../../store/provider-operation-journal.js';
import { decodeEventBody } from '../../store/body-codec.js';
import { jobExecutionEndedBodySchema } from '../terminal/result.js';
import type { EventsRow } from '../../store/schema.js';
import { jobArtifactRecordedBodySchema, jobRuntimeStartedBodySchema } from '../event-bodies.js';
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
  type JobQueueReadPort,
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
import type {
  ConversationInitialLaunchPort,
  ConversationContinuityPort,
  ConversationWriteResult,
} from '../conversation/contracts.js';
import type { CoralEventInput } from '../../store/envelope.js';
import type { ExecutionFinisher } from '../finishing.js';
import type { CommitContext, CommitEventsFn } from '../../store/append.js';
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
import type { DurableCliProcessRuntimeEvidence } from '../runtime-meta.js';
import { readProviderOperationJobLaunchEventSeq } from '../provider-operation-state.js';

type ExecutionRequestCommitOutcome =
  | { kind: 'committed' }
  | { kind: 'replayed'; decision: AcceptedProviderJobLaunchDecision }
  | { kind: 'refused'; decision: RefusedLaunchDecision }
  | { kind: 'uncertain'; error: unknown; clientMessageId: string };

class ExecutionRequestNotCommitted extends Error {
  readonly outcome: Extract<ExecutionRequestCommitOutcome, { kind: 'replayed' | 'refused' }>;

  constructor(outcome: Extract<ExecutionRequestCommitOutcome, { kind: 'replayed' | 'refused' }>) {
    super('Execution request was not committed.');
    this.outcome = outcome;
  }
}

type UncertainAdmission = Readonly<{
  jobId: string;
  execution: number;
  input: string;
  clientMessageId: string;
  admission: AcceptedAdmission;
  error: unknown;
}>;

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
  launchAdmission: JobAdmissionPort & Pick<JobQueueReadPort, 'reservationFor'>;
  providerOperationBinding: ProviderOperationBindingPort;
  durableSpawner: ProviderDurableSpawner;
  providerRegistry: ProviderBindingCatalog;
  runtime: Pick<Runtime, 'time' | 'ids' | 'storage' | 'env' | 'paths' | 'process'>;
  coordinatorCommit: CommitEventsFn;
  currentJobEpochKey?: () => string | null;
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
    appendProviderTerminalInCommit<Scope>(
      commit: CommitContext<Scope>,
      terminal: Extract<ProviderEventBody, { kind: 'terminal' }>,
      options: {
        readonly jobId: string;
        readonly execution: number;
        readonly namespace?: string;
        readonly project?: string;
        readonly correlationId?: string;
      },
    ): void;
  };
}

type ProviderLaunchOptions = {
  pool?: LaunchPool;
  parentWorkflowJobId?: string;
  workflowSlotId?: string;
  retention?: RetentionPolicy;
  protectedEnv?: Record<string, string>;
  owner?: ExecutionOwner;
  discussionRun?: DiscussionRunDescriptor;
  originatingClientMessageId?: string;
  continuationTarget?: JobSendTarget;
};

type ProviderExecutionAdmission = Readonly<{
  conversation: JobConversation;
  request: ProviderRequest;
  options: ProviderLaunchOptions & {
    owner: ExecutionOwner;
    mintProtectedEnv: (jobId: string, execution: number) => ProviderOperationEnvironmentInput;
  };
  admission: AcceptedAdmission;
  metadata: Pick<CoralEventInput, 'correlationId' | 'namespace' | 'project'>;
  pool: LaunchPool;
}>;

type ExecutionRequestResolution =
  | { kind: 'append' }
  | Extract<ExecutionRequestCommitOutcome, { kind: 'replayed' | 'refused' }>;

function providerJobOpenedBody({ conversation, options }: ProviderExecutionAdmission) {
  return jobOpenedBodySchema.parse({
    jobKind: 'provider',
    owner: options.owner,
    projectRoot: conversation.projectRoot,
    createdAt: conversation.createdAt,
    workflowSlotId: options.workflowSlotId,
    conversation: {
      provider: conversation.provider,
      binding: conversation.binding,
      cwd: conversation.cwd,
      name: conversation.name,
      model: conversation.model,
      effort: conversation.effort,
      agent: conversation.agent,
      instruction: conversation.instruction,
      bypassPermissions: conversation.bypassPermissions,
      systemPrompt: conversation.systemPrompt,
      retention: conversation.retention,
      controllerProfile: conversation.controllerProfile,
    },
  });
}

export class LaunchOrchestrator implements ProviderOperationCleanupOwner {
  // Tracks every admitted app-server job before its first asynchronous
  // preparation boundary. Quiesce-for-handoff acts on this set; CLI/durable
  // jobs not in the set keep the existing handoff preservation behavior.
  private readonly runTasks = new Set<string>();
  private readonly launching = new Set<string>();
  private readonly uncertainAdmissions = new Map<string, Promise<void>>();
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
    return (
      this.localAppServerExecutions.has(executionKey(jobId, execution)) &&
      !this.quiescedAppServerJobs.has(executionKey(jobId, execution))
    );
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

  private registerAppServerJob(
    provider: BoundProvider,
    jobId: string,
    execution: number,
    jobSignal: AbortSignal,
  ): AbortSignal {
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
    execution: number,
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
        body: { ...body, execution },
      });
      return undefined;
    });
  }

  private appendProgressEvent(jobId: string, message: string): void {
    this.deps.progressStore.appendProgress(jobId, message);
  }

  private appendLaunchRejectedOutcome<Scope>(
    c: CommitContext<Scope>,
    jobId: string,
    execution: number,
    body: JobLaunchRejected,
    options: {
      parentJobId?: string;
      workflowSlotId?: string;
      projectRoot?: string;
    } = {},
  ): void {
    const metadata = this.resolveEventMetadata(jobId, options.projectRoot);
    const workflowId = options.parentJobId;
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
  }

  async launchExecution(
    provider: BoundProvider,
    conversation: JobConversation,
    request: ProviderRequest,
    opts: ProviderLaunchOptions & {
      owner: ExecutionOwner;
      mintProtectedEnv: (jobId: string, execution: number) => ProviderOperationEnvironmentInput;
    },
  ): Promise<ProviderJobLaunchDecision> {
    if (
      opts.continuationTarget !== undefined &&
      !this.continuationTargetMatches(conversation.jobId, opts.continuationTarget)
    )
      return refuseLaunch(
        'continuation_target_changed',
        'The bound predecessor is no longer the latest ended execution.',
      );
    if (this.launching.has(conversation.jobId) || this.uncertainAdmissions.has(conversation.jobId))
      return refuseLaunch(
        'execution_admission_in_flight',
        'Another execution admission is in progress. Wait for its decision.',
      );
    this.launching.add(conversation.jobId);
    try {
      const settled = await this.settlePredecessor(conversation);
      if ('status' in settled) return settled;
      return await this.launchVerifiedExecution(provider, settled, request, opts);
    } finally {
      this.launching.delete(conversation.jobId);
    }
  }

  private async settlePredecessor(conversation: JobConversation): Promise<JobConversation | RefusedLaunchDecision> {
    let current = conversation;
    for (let attempt = 0; current.execution > 0; attempt++) {
      const prior = { jobId: current.jobId, execution: current.execution };
      if (!this.predecessorNeedsSettlement(current)) break;
      if (current.open && !current.finishing)
        return refuseLaunch(
          'session_busy',
          `Execution #${prior.execution} of ${prior.jobId} is running. Wait for it to end before continuing.`,
        );
      if (attempt >= 10 || this.deps.executionFinisher.status(prior)?.kind === 'blocked')
        return refuseLaunch(
          'execution_finishing',
          `Execution #${prior.execution} of ${prior.jobId} is finishing; successor=execution finalizer. Wait for it to end before continuing.`,
        );
      const stopped = await this.waitForExecutionFinisher();
      if (stopped)
        return refuseLaunch(
          'execution_finishing',
          `Execution #${prior.execution} of ${prior.jobId} is finishing during shutdown. Wait for it to end before continuing.`,
        );
      const refreshed = this.deps.conversationManager.readById(current.jobId);
      if (refreshed === null || refreshed.execution !== conversation.execution)
        return refuseLaunch(
          'execution_superseded',
          `The execution changed while awaiting finishing of ${current.jobId}.`,
        );
      current = refreshed;
    }
    return current;
  }

  private predecessorNeedsSettlement(conversation: JobConversation): boolean {
    return (
      conversation.open ||
      hasUnterminalRetentionDiscardRequest(conversation) ||
      this.runTasks.has(executionKey(conversation.jobId, conversation.execution)) ||
      this.deps.launchAdmission.reservationFor(conversation.jobId) !== null ||
      hasProviderOperationForJob(this.deps.progressStore.getDb(), conversation.jobId)
    );
  }

  private waitForExecutionFinisher(): Promise<boolean> {
    return raceWithSignal(
      this.deps.runtime.time
        .sleep(EXECUTION_RETRY_MS, { signal: this.deps.executionFinisher.signal })
        .then(() => false),
      this.deps.executionFinisher.signal,
      () => true,
    ).catch((error: unknown) => {
      if (this.deps.executionFinisher.signal.aborted) return true;
      throw error;
    });
  }

  private async launchVerifiedExecution(
    provider: BoundProvider,
    conversation: JobConversation,
    request: ProviderRequest,
    opts: ProviderExecutionAdmission['options'],
  ): Promise<ProviderJobLaunchDecision> {
    const jobId = conversation.jobId;
    const verification = await this.verifyExecutionConversation(provider, conversation);
    if (verification !== null && 'status' in verification) return verification;
    const metadata = this.resolveEventMetadata(jobId, conversation.projectRoot);
    const pool = opts.pool ?? 'default';
    const admission = this.reserveAdmission(
      jobId,
      provider.name,
      opts.owner,
      pool,
      opts.owner.kind === 'workflow' || opts.owner.kind === 'discussion',
    );
    if (admission === 'queue_full') return refuseLaunch('busy', QUEUE_FULL_MESSAGE);
    if (admission instanceof SuccessionAdmissionPausedError) {
      return refuseLaunch('succession_admission_paused', admission.message);
    }
    const input: ProviderExecutionAdmission = {
      conversation,
      request: { ...request, jobId, coralEnv: { ...request.coralEnv, CORAL_JOB_ID: jobId } },
      options: opts,
      admission,
      metadata,
      pool,
    };
    const outcome = await withJobArtifactGuard(this.deps.runtime, jobId, () =>
      this.commitProviderExecutionRequest(input),
    ).catch((error: unknown) => {
      this.releaseAdmissionReservation(admission);
      throw error;
    });
    const decision = this.resolveProviderExecutionCommit(input, outcome);
    if (decision !== null) return decision;
    return this.activateProviderExecution(provider, input);
  }

  private resolveProviderExecutionCommit(
    input: ProviderExecutionAdmission,
    outcome: ExecutionRequestCommitOutcome,
  ): ProviderJobLaunchDecision | null {
    const { conversation, request, admission } = input;
    const jobId = conversation.jobId;
    const execution = conversation.execution + 1;
    switch (outcome.kind) {
      case 'refused':
      case 'replayed':
        this.releaseAdmissionReservation(admission);
        return outcome.decision;
      case 'uncertain':
        this.scheduleUncertainAdmission({
          jobId,
          execution,
          input: request.prompt,
          clientMessageId: outcome.clientMessageId,
          admission,
          error: outcome.error,
        });
        return undeterminedLaunch(
          'continuation_commit_uncertain',
          `Request commit evidence is unreadable; successor=continuation admission recovery for ${jobId}#${execution}. No relaunch will be attempted.`,
        );
      case 'committed':
        return null;
    }
  }

  private async activateProviderExecution(
    provider: BoundProvider,
    input: ProviderExecutionAdmission,
  ): Promise<AcceptedProviderJobLaunchDecision> {
    const { conversation, request, admission, pool, options } = input;
    const jobId = conversation.jobId;
    const execution = conversation.execution + 1;
    try {
      this.activateCommittedProviderLaunch({
        provider,
        jobId,
        execution,
        request,
        admission,
        pool,
        mintProtectedEnv: options.mintProtectedEnv,
      });
    } catch (error) {
      await this.finalizeCommittedLaunchSetupFailure(jobId, execution, admission, error);
    }
    return this.committedProviderExecutionLaunch(input);
  }

  private committedProviderExecutionLaunch(input: ProviderExecutionAdmission): AcceptedProviderJobLaunchDecision {
    const jobId = input.conversation.jobId;
    return {
      kind: 'provider-session',
      status: input.admission.type === 'queued' ? 'queued' : 'running',
      jobId,
      epochKey: this.currentJobEpochKey(),
      ...committedExecutionRequest(this.deps.progressStore.getDb(), jobId, input.conversation.execution + 1),
    };
  }

  private async verifyExecutionConversation(
    provider: BoundProvider,
    conversation: JobConversation,
  ): Promise<ConversationRestoreVerification | RefusedLaunchDecision | null> {
    const refusal = this.validateExecutionCompletion(provider, conversation);
    if (refusal !== null) return refusal;
    if (conversation.execution === 0 || provider.artifacts.kind !== 'managed') return null;
    return this.verifyManagedConversationRestore(provider, conversation);
  }

  private validateExecutionCompletion(
    provider: BoundProvider,
    conversation: JobConversation,
  ): RefusedLaunchDecision | null {
    const jobId = conversation.jobId;
    if (this.runTasks.has(executionKey(jobId, conversation.execution)))
      return refuseLaunch(
        'execution_finishing',
        `Execution #${conversation.execution} of ${jobId} is still completing cleanup; successor=execution finalizer. Wait for it to end before continuing.`,
      );
    if (conversation.execution === 0) return null;
    const end = this.deps.progressStore
      .getDb()
      .prepare<
        [string],
        EventsRow
      >("SELECT * FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.execution.ended' ORDER BY seq DESC LIMIT 1")
      .get(jobId);
    if (
      conversation.open ||
      hasUnterminalRetentionDiscardRequest(conversation) ||
      this.deps.launchAdmission.reservationFor(jobId) !== null ||
      hasProviderOperationForJob(this.deps.progressStore.getDb(), jobId) ||
      end === undefined ||
      jobExecutionEndedBodySchema.parse(decodeEventBody(end.body)).execution !== conversation.execution
    ) {
      return refuseLaunch(
        'execution_finishing',
        `Execution #${conversation.execution} of ${jobId} has not completed finishing; successor=execution finalizer. Wait for it to end before continuing.`,
      );
    }
    const identity = provider.compareIdentity(conversation.binding);
    if (!identity.ok)
      return refuseLaunch('profile_mismatch', "Continue with the conversation's original provider profile.");
    return null;
  }

  private async verifyManagedConversationRestore(
    provider: BoundProvider,
    conversation: JobConversation,
  ): Promise<ConversationRestoreVerification | RefusedLaunchDecision> {
    const jobId = conversation.jobId;
    try {
      const handles = collectArtifactHandles(conversation, provider, this.deps.runtime);
      const runs = this.deps.progressStore
        .getDb()
        .prepare<[string], EventsRow>(
          `SELECT * FROM events WHERE stream_kind = 'job' AND stream_id = ?
          AND type IN ('job.execution.started', 'job.artifact.recorded') ORDER BY seq`,
        )
        .all(jobId);
      const minimumExecution = runs.reduce((latest, row) => {
        const body = decodeEventBody(row.body);
        return Math.max(
          latest,
          (row.type === 'job.execution.started'
            ? jobRuntimeStartedBodySchema.parse(body)
            : jobArtifactRecordedBodySchema.parse(body)
          ).execution,
        );
      }, 1);
      const verification = await verifyConversationRestore({
        runtime: this.deps.runtime,
        conversation,
        nativeHandle: handles.at(-1) ?? null,
        minimumExecution,
      });
      return verification.kind === 'unrestorable'
        ? refuseLaunch(verification.reason, verification.message)
        : verification;
    } catch (error: unknown) {
      return refuseLaunch('native_unobservable', `Cannot verify native conversation: ${errorMessage(error)}`);
    }
  }

  private commitProviderExecutionRequest(input: ProviderExecutionAdmission): ExecutionRequestCommitOutcome {
    const { conversation, request, options } = input;
    const jobId = conversation.jobId;
    const execution = conversation.execution + 1;
    return this.commitExecutionRequest(jobId, execution, request.prompt, options.originatingClientMessageId, () => {
      this.deps.progressStore.withExecutionAdmission(
        jobId,
        execution,
        { projectRoot: conversation.projectRoot, workDir: conversation.cwd, jobKind: 'provider' },
        () => {
          this.deps.coordinatorCommit(
            (commit) => {
              const resolution = this.resolveProviderExecutionRequest(input);
              if (resolution.kind !== 'append') throw new ExecutionRequestNotCommitted(resolution);
              this.appendProviderExecutionEvents(commit, input);
              return undefined;
            },
            { admittingJobs: [jobId] },
          );
        },
      );
      return { kind: 'committed' };
    });
  }

  private resolveProviderExecutionRequest(input: ProviderExecutionAdmission): ExecutionRequestResolution {
    const replay = this.resolveProviderExecutionReplay(input);
    if (replay !== null) return replay;
    const { conversation, options } = input;
    const jobId = conversation.jobId;
    if (options.continuationTarget !== undefined && !this.continuationTargetMatches(jobId, options.continuationTarget))
      return {
        kind: 'refused',
        decision: refuseLaunch(
          'continuation_target_changed',
          'The bound predecessor is no longer the latest ended execution.',
        ),
      };
    const current = this.deps.conversationManager.readById(jobId);
    if (
      conversation.execution === 0
        ? current !== null
        : current === null || current.open || current.execution !== conversation.execution
    )
      throw new Error(`Job ${jobId} no longer admits execution #${conversation.execution + 1}.`);
    return { kind: 'append' };
  }

  private resolveProviderExecutionReplay(
    input: ProviderExecutionAdmission,
  ): Extract<ExecutionRequestResolution, { kind: 'replayed' | 'refused' }> | null {
    const { conversation, request, options } = input;
    const db = this.deps.progressStore.getDb();
    const epochKey = this.currentJobEpochKey();
    if (options.originatingClientMessageId === undefined) return null;
    const replay = findCommittedExecutionRequest(db, conversation.jobId, options.originatingClientMessageId);
    if (replay === null) return null;
    const sameEnvelope =
      options.continuationTarget === undefined
        ? replay.request.execution === conversation.execution + 1 && replay.request.input === request.prompt
        : matchesContinuationEnvelope(
            db,
            { target: options.continuationTarget, input: request.prompt },
            replay,
            epochKey,
          );
    return sameEnvelope
      ? { kind: 'replayed', decision: committedProviderLaunchDecision(db, replay, epochKey) }
      : {
          kind: 'refused',
          decision: refuseLaunch(
            'continuation_target_changed',
            'This message identity belongs to a different continuation envelope.',
          ),
        };
  }

  private appendProviderExecutionEvents<Scope>(commit: CommitContext<Scope>, input: ProviderExecutionAdmission): void {
    const { conversation, request, options, metadata, pool, admission } = input;
    const execution = conversation.execution + 1;
    const event = {
      stream: { kind: 'job' as const, id: conversation.jobId },
      ...metadata,
      refs: buildJobEventRefs({
        jobId: conversation.jobId,
        parentJobId: options.parentWorkflowJobId,
        workflowId: options.parentWorkflowJobId,
        workflowSlotId: options.workflowSlotId,
      }),
    };
    if (execution === 1) commit.append({ ...event, type: 'job.opened', body: providerJobOpenedBody(input) });
    commit.append({
      ...event,
      type: 'job.execution.requested',
      body: jobExecutionRequestedBodySchema.parse({
        execution,
        input: request.prompt,
        action: request.action,
        pool,
        enqueueSequence: this.deps.progressStore.nextEnqueueSequence(),
        coralEnv: request.coralEnv,
        createdAt: nowIsoString(this.deps.runtime.time),
        backendNamespace: this.deps.backendNamespace,
        bundleHash: this.deps.bundleHash,
        discussionRun: options.discussionRun,
        originatingClientMessageId: options.originatingClientMessageId,
      }),
    });
    commit.append({
      ...event,
      type: admission.type === 'queued' ? 'job.execution.queued' : 'job.execution.admitted',
      body:
        admission.type === 'queued'
          ? { execution, queuePosition: admission.queuePosition, runningJobIds: [] }
          : { execution, queuePosition: 0 },
    });
  }

  currentJobEpochKey(): string {
    return this.deps.currentJobEpochKey?.() ?? ':memory:';
  }

  private continuationTargetMatches(jobId: string, target: JobSendTarget): boolean {
    const current = this.deps.conversationManager.readById(jobId);
    return matchesContinuationTarget(target, {
      execution: current?.execution ?? null,
      open: current?.open ?? true,
      requestedSeq:
        current === null
          ? null
          : committedExecutionRequest(this.deps.progressStore.getDb(), jobId, current.execution).requestedSeq,
      sourceEpoch: this.currentJobEpochKey(),
    });
  }

  private readCommitEvidence(
    jobId: string,
    execution: number,
    input: string,
    clientMessageId: string,
  ): ExecutionRequestCommitOutcome | null {
    const evidence = findCommittedExecutionRequest(this.deps.progressStore.getDb(), jobId, clientMessageId);
    if (evidence === null) return null;
    if (evidence.request.execution !== execution || evidence.request.input !== input)
      return {
        kind: 'refused',
        decision: refuseLaunch(
          'continuation_target_changed',
          'The committed continuation does not match this attempt.',
        ),
      };
    return { kind: 'committed' };
  }

  private commitExecutionRequest(
    jobId: string,
    execution: number,
    input: string,
    clientMessageId: string | undefined,
    write: () => ExecutionRequestCommitOutcome,
  ): ExecutionRequestCommitOutcome {
    try {
      return write();
    } catch (error: unknown) {
      if (error instanceof ExecutionRequestNotCommitted) return error.outcome;
      if (clientMessageId === undefined) throw error;
      let evidence: ExecutionRequestCommitOutcome | null;
      try {
        evidence = this.readCommitEvidence(jobId, execution, input, clientMessageId);
      } catch {
        return { kind: 'uncertain', error, clientMessageId };
      }
      if (evidence === null) throw error;
      return evidence;
    }
  }

  private scheduleUncertainAdmission(context: UncertainAdmission): void {
    const address = { jobId: context.jobId, execution: context.execution };
    const successor = this.deps.executionFinisher.adoptAdmission(address, () => this.settleUncertainAdmission(context));
    const task = successor.completion;
    this.uncertainAdmissions.set(context.jobId, task);
    const releaseHold = () => this.uncertainAdmissions.delete(context.jobId);
    void task.then(releaseHold, releaseHold);
  }

  private async settleUncertainAdmission(context: UncertainAdmission): Promise<void> {
    const { jobId, execution, input, clientMessageId, admission, error } = context;
    const evidence = this.readCommitEvidence(jobId, execution, input, clientMessageId);
    if (evidence?.kind === 'committed') await this.finalizeCommittedLaunchAttempt(jobId, execution, admission, error);
    else this.releaseAdmissionReservation(admission);
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
    jobId: string;
    request: ProviderRequest;
    admission: AcceptedAdmission;
    pool: LaunchPool;
    execution: number;
    mintProtectedEnv: (jobId: string, execution: number) => ProviderOperationEnvironmentInput;
  }): void {
    // The abort signal must be registered before placement, so either owner observes the same stop.
    this.registerLaunchAbort(input.jobId, input.execution, input.admission);
    if (this.deps.abortRegistry.getSignal(input.jobId, input.execution) === null) {
      throw new Error(`Abort registration produced no signal for committed job ${input.jobId}.`);
    }
    this.deps.runtime.storage.mkdirSync(this.deps.progressStore.jobDir(input.jobId), { recursive: true });
    if (input.admission.type === 'queued') {
      this.appendProgressEvent(input.jobId, `queued (position ${input.admission.queuePosition})`);
    }
    const protectedEnv = input.mintProtectedEnv(input.jobId, input.execution);
    this.runAsync(
      input.provider,
      input.jobId,
      input.execution,
      input.request,
      input.admission,
      input.pool,
      protectedEnv,
    );
  }

  private async finalizeCommittedLaunchSetupFailure(
    jobId: string,
    execution: number,
    admission: AcceptedAdmission,
    error: unknown,
  ): Promise<void> {
    const successor = this.deps.executionFinisher.adoptAdmission({ jobId, execution }, () =>
      this.finalizeCommittedLaunchAttempt(jobId, execution, admission, error),
    );
    await successor.completion;
  }

  private async finalizeCommittedLaunchAttempt(
    jobId: string,
    execution: number,
    admission: AcceptedAdmission,
    error: unknown,
  ): Promise<void> {
    const signal = this.deps.abortRegistry.getSignal(jobId, execution) ?? new AbortController().signal;
    const disposition = await this.handleProviderJobError(jobId, execution, signal, error);
    if (!releasesLaunchPermit(disposition))
      throw new Error(`Committed launch cleanup for ${jobId}#${execution} is awaiting authoritative release.`);
    this.deps.abortRegistry.remove(jobId, execution);
    this.releaseAdmissionReservation(admission);
  }

  runAsync(
    provider: BoundProvider,
    jobId: string,
    execution: number,
    request: ProviderRequest,
    admission: AcceptedAdmission,
    pool: LaunchPool,
    protectedEnv?: ProviderOperationEnvironmentInput,
  ): void {
    const { abortRegistry } = this.deps;
    const signal = abortRegistry.getSignal(jobId, execution);
    if (!signal) {
      this.releaseAdmissionReservation(admission);
      return;
    }

    const executionSignal = this.registerAppServerJob(provider, jobId, execution, signal);

    this.runTasks.add(executionKey(jobId, execution));
    void this.runAdmittedExecution(
      provider,
      jobId,
      execution,
      request,
      admission,
      pool,
      signal,
      executionSignal,
      protectedEnv,
    );
  }

  runRecoveredQueuedJob(
    provider: BoundProvider,
    launchRecord: JobLaunch,
    admission: QueuedHandle,
    pool: LaunchPool,
    protectedEnv: ProviderOperationEnvironmentInput,
  ): void {
    const { abortRegistry } = this.deps;
    const jobId = launchRecord.jobId;
    const execution = launchRecord.execution;
    this.registerLaunchAbort(jobId, execution, admission);
    const signal = abortRegistry.getSignal(jobId, execution);
    if (!signal) {
      this.releaseAdmissionReservation(admission);
      return;
    }

    const executionSignal = this.registerAppServerJob(provider, jobId, execution, signal);

    this.runTasks.add(executionKey(jobId, execution));
    void this.runRecoveredQueuedExecution(
      provider,
      launchRecord,
      admission,
      pool,
      signal,
      executionSignal,
      protectedEnv,
    );
  }

  private async runAdmittedExecution(
    provider: BoundProvider,
    jobId: string,
    execution: number,
    request: ProviderRequest,
    admission: AcceptedAdmission,
    pool: LaunchPool,
    signal: AbortSignal,
    executionSignal: AbortSignal,
    protectedEnv: ProviderOperationEnvironmentInput | undefined,
  ): Promise<void> {
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
          await this.finishQueuedAbort(jobId, execution, 'queue_shutdown');
          return;
        }

        permit = queueOutcome.permit;
        if (this.preserveAppServerJobForHandoff(provider, jobId, execution)) {
          disposition = 'handed-off';
          return;
        }
        this.appendJobEvent(jobId, execution, 'job.execution.admitted', {});
        this.appendProgressEvent(jobId, 'dequeued, launching');
      }
      if (permit === null || permit.pool !== pool) {
        throw new Error(`Launch permit for ${jobId} does not match its admitted pool.`);
      }

      disposition = await this.executeJob(provider, request, jobId, execution, executionSignal, permit, protectedEnv);
    } catch (error: unknown) {
      const failure = this.resolveLaunchTaskFailure(jobId, execution, signal, error);
      disposition = typeof failure === 'string' ? failure : await failure;
    } finally {
      this.releaseLaunchTask(jobId, execution, permit, disposition);
    }
  }

  private async runRecoveredQueuedExecution(
    provider: BoundProvider,
    launchRecord: JobLaunch,
    admission: QueuedHandle,
    pool: LaunchPool,
    signal: AbortSignal,
    executionSignal: AbortSignal,
    protectedEnv: ProviderOperationEnvironmentInput,
  ): Promise<void> {
    const { jobId, execution } = launchRecord;
    let permit: LaunchPermit | null = null;
    let disposition: JobExecutionDisposition = 'terminalized';
    try {
      if (this.preserveAppServerJobForHandoff(provider, jobId, execution)) {
        disposition = 'handed-off';
        return;
      }
      const queueOutcome = await this.waitForQueuedPermit(admission, signal);
      if (queueOutcome.kind === 'aborted') {
        await this.finishQueuedAbort(jobId, execution, 'queue_shutdown');
        return;
      }

      permit = queueOutcome.permit;
      if (this.preserveAppServerJobForHandoff(provider, jobId, execution)) {
        disposition = 'handed-off';
        return;
      }
      this.appendJobEvent(jobId, execution, 'job.execution.admitted', {});
      this.appendProgressEvent(jobId, 'dequeued, launching');
      disposition = await this.executeRecoveredQueuedJob(
        provider,
        launchRecord,
        executionSignal,
        permit,
        pool,
        protectedEnv,
      );
    } catch (error: unknown) {
      const failure = this.resolveLaunchTaskFailure(jobId, execution, signal, error);
      disposition = typeof failure === 'string' ? failure : await failure;
    } finally {
      this.releaseLaunchTask(jobId, execution, permit, disposition);
    }
  }

  private executeRecoveredQueuedJob(
    provider: BoundProvider,
    launchRecord: JobLaunch,
    signal: AbortSignal,
    permit: LaunchPermit,
    pool: LaunchPool,
    protectedEnv: ProviderOperationEnvironmentInput,
  ): Promise<JobExecutionDisposition> {
    const { jobId, execution } = launchRecord;
    if (permit.pool !== pool) {
      throw new Error(`Recovered launch permit for ${jobId} does not match its admitted pool.`);
    }

    const session = this.deps.conversationManager.get(provider.name, jobId);
    if (session === null) {
      throw new Error(`Recovered queued job ${jobId} has no provider conversation snapshot.`);
    }
    return this.executeJob(
      provider,
      toProviderRequest(launchRecord, session.conversationRef),
      jobId,
      execution,
      signal,
      permit,
      protectedEnv,
    );
  }

  private resolveLaunchTaskFailure(
    jobId: string,
    execution: number,
    signal: AbortSignal,
    error: unknown,
  ): 'terminalized' | 'handed-off' | Promise<JobExecutionDisposition> {
    if (error instanceof TerminalWriteError) {
      backendLog.error(error.message, error.cause);
      return 'terminalized';
    }
    if (this.quiescedAppServerJobs.has(executionKey(jobId, execution))) {
      return 'handed-off';
    }
    return this.finalizeLaunchTaskFailure(jobId, execution, signal, error);
  }

  private async finalizeLaunchTaskFailure(
    jobId: string,
    execution: number,
    signal: AbortSignal,
    error: unknown,
  ): Promise<JobExecutionDisposition> {
    try {
      return await this.handleProviderJobError(jobId, execution, signal, error);
    } catch (finalizeError: unknown) {
      if (finalizeError instanceof TerminalWriteError) {
        backendLog.error(finalizeError.message, finalizeError.cause);
        return 'terminalized';
      }
      throw finalizeError;
    }
  }

  private releaseLaunchTask(
    jobId: string,
    execution: number,
    permit: LaunchPermit | null,
    disposition: JobExecutionDisposition,
  ): void {
    if (permit !== null && releasesLaunchPermit(disposition)) void this.deps.launchAdmission.releaseLaunch(permit);
    this.appServerJobs.delete(executionKey(jobId, execution));
    this.localAppServerExecutions.delete(executionKey(jobId, execution));
    this.quiescedAppServerJobs.delete(executionKey(jobId, execution));
    this.appServerHandoffAborts.delete(executionKey(jobId, execution));
    this.runTasks.delete(executionKey(jobId, execution));
  }

  private async finishQueuedAbort(jobId: string, execution: number, reason: AbortReason): Promise<void> {
    await this.finishAbortedJob(jobId, execution, reason);
  }

  async failJob(jobId: string, execution: number, terminal: JobTerminal): Promise<void> {
    await this.writeJobTerminal(jobId, execution, terminal, 'error');
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
    execution: number,
    result: JobTerminal,
    _phase: JobPhase,
    options: TerminalWriteOptions = {},
  ): Promise<number> {
    const accepted = await this.deps.executionFinisher.accept({ jobId, execution }, (c) => {
      const status = this.deps.progressStore.readStatus(jobId);
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
  }

  private async executeJob(
    provider: BoundProvider,
    request: ProviderRequest,
    jobId: string,
    execution: number,
    signal: AbortSignal,
    permit: LaunchPermit,
    protectedEnv?: ProviderOperationEnvironmentInput,
  ): Promise<JobExecutionDisposition> {
    await this.restoreCommittedConversation(provider, jobId, execution);
    const persistedContinuity = this.readProviderContinuity(provider, jobId);
    this.readExecutionOrdinal(provider.name, jobId, execution);
    const readiness = await provider.readiness('launch', this.deps.runtime.storage);
    if (this.preserveAppServerJobForHandoff(provider, jobId, execution)) return 'handed-off';
    if (!readiness.ok) {
      throw new ProviderBindingRuntimeError(
        readiness.failure,
        this.deps.providerRegistry.renderBindingFailure(readiness.failure),
      );
    }
    const { prepared, launch } = this.prepareProviderJob(
      provider,
      request,
      jobId,
      execution,
      signal,
      permit,
      persistedContinuity,
      protectedEnv,
    );
    try {
      const providerStream = await this.executePreparedProvider(prepared, launch);
      return await this.consumePreparedProviderResult(providerStream, launch, request);
    } finally {
      this.inFlightAppServerWrites.delete(executionKey(jobId, execution));
    }
  }

  private async restoreCommittedConversation(provider: BoundProvider, jobId: string, execution: number): Promise<void> {
    if (execution === 1 || provider.artifacts.kind !== 'managed') return;
    const conversation = this.deps.conversationManager.get(provider.name, jobId);
    if (conversation === null || conversation.execution !== execution)
      throw new Error(`Committed execution ${jobId}#${execution} has no current provider conversation.`);
    const verification = await this.verifyManagedConversationRestore(provider, conversation);
    if ('status' in verification) throw new Error(`Committed conversation restore failed: ${verification.message}`);
    const restored = await publishConversationRestore({
      runtime: this.deps.runtime,
      jobId,
      execution,
      verification,
    });
    if (restored.kind === 'unrestorable') throw new Error(`Committed conversation restore failed: ${restored.message}`);
  }

  private readProviderContinuity(provider: BoundProvider, jobId: string): ProviderContinuityBlob | undefined {
    const session = this.deps.conversationManager.get(provider.name, jobId);
    if (!session) {
      throw new ProviderBindingRuntimeError(
        { reason: 'invalid-persisted-binding', provider: provider.name },
        `Provider conversation ${jobId} has no binding.`,
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
    return continuity.value;
  }

  private prepareProviderJob(
    provider: BoundProvider,
    request: ProviderRequest,
    jobId: string,
    execution: number,
    signal: AbortSignal,
    permit: LaunchPermit,
    persistedContinuity: ProviderContinuityBlob | undefined,
    protectedEnv?: ProviderOperationEnvironmentInput,
  ): { prepared: BoundProviderPreparedExecution; launch: PreparedProviderLaunchContext } {
    const equippedTools = resolveEquippedTools(this.deps.runtime);
    const requestWithInject = this.injectProviderRequest(request, equippedTools);
    const operationEnvironment = providerOperationEnvironment(protectedEnv);
    const hostRoot = this.deps.appServerProxyRoute?.hostRoot() ?? localProviderHostRoot();
    const prepared = provider.prepareExecution({
      hostRoot,
      request: requestWithInject,
      persistedContinuity,
      baseEnv: this.deps.runtime.env.fullSnapshot(),
      protectedEnv: operationEnvironment.env,
      platform: this.deps.runtime.env.platform(),
      storage: this.deps.runtime.storage,
    });
    const runtime = this.createProviderRuntime(
      provider,
      requestWithInject,
      jobId,
      signal,
      persistedContinuity,
      equippedTools,
    );
    return {
      prepared,
      launch: {
        provider,
        runtime,
        jobId,
        signal,
        permit,
        requestForRoute: requestWithInject,
        persistedContinuity,
        operationEnvironment,
        execution,
      },
    };
  }

  private injectProviderRequest(
    request: ProviderRequest,
    equippedTools: ReturnType<typeof resolveEquippedTools>,
  ): ProviderRequest {
    return applyInjectBundle(request, {
      storage: this.deps.runtime.storage,
      equippedTools,
      ...(request.cwd
        ? {
            coralProjects: this.deps.runtime.paths.projectData(request.cwd),
          }
        : {}),
    });
  }

  private async consumePreparedProviderResult(
    providerStream: PreparedProviderExecutionResult,
    launch: PreparedProviderLaunchContext,
    request: ProviderRequest,
  ): Promise<JobExecutionDisposition> {
    const { provider, jobId, execution, signal } = launch;
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
      conversationApi: this.executionConversationApi(jobId, execution),
      appendProgress: (message) => {
        if (this.quiescedAppServerJobs.has(executionKey(jobId, execution))) return;
        this.appendProgressEvent(jobId, message);
      },
    });
    if (this.quiescedAppServerJobs.has(executionKey(jobId, execution))) return 'handed-off';
    if (consumed.kind === 'suspended') return 'suspended';
    const completion = this.trackAppServerWrite(jobId, execution, () =>
      this.completeConsumedJob({
        jobId,
        projectRoot: request.cwd,
        event: consumed.event,
        execution: consumed.execution,
      }),
    );
    return completion;
  }

  private executionConversationApi(
    jobId: string,
    execution: number,
  ): Pick<ConversationContinuityPort, 'checkpointJobContinuityAtomic' | 'recordArtifactHandleAtomic'> {
    const persist = async (write: () => Promise<ConversationWriteResult>): Promise<ConversationWriteResult> => {
      let reported = false;
      for (;;) {
        if (this.quiescedAppServerJobs.has(executionKey(jobId, execution))) {
          return { ok: false as const };
        }
        try {
          const result = await this.trackAppServerWrite(jobId, execution, write);
          if (this.quiescedAppServerJobs.has(executionKey(jobId, execution))) return { ok: false as const };
          return result;
        } catch (error: unknown) {
          if (this.quiescedAppServerJobs.has(executionKey(jobId, execution))) return { ok: false as const };
          if (!reported) {
            backendLog.warn(
              `Conversation write failed for job ${jobId} execution #${execution}; retaining local stream ownership and retrying: ${errorMessage(error)}`,
            );
            reported = true;
          }
          const signal = this.deps.executionFinisher.signal;
          await raceWithSignal(
            error instanceof SuccessionWriterParkedError
              ? error.unparked
              : this.deps.runtime.time.sleep(EXECUTION_RETRY_MS, { signal }),
            signal,
            () => {
              throw signal.reason;
            },
          );
        }
      }
    };
    return {
      checkpointJobContinuityAtomic: (claimedJobId, options) =>
        persist(() => this.deps.conversationManager.checkpointJobContinuityAtomic(claimedJobId, options)),
      recordArtifactHandleAtomic: (claimedJobId, options) =>
        persist(() => this.deps.conversationManager.recordArtifactHandleAtomic(claimedJobId, options)),
    };
  }

  private async completeConsumedJob(options: {
    jobId: string;
    projectRoot: string | undefined;
    event: Extract<ProviderEventBody, { kind: 'terminal' }>;
    execution: number;
  }): Promise<'settled' | SettlementRefusal> {
    const { jobId, projectRoot, event, execution } = options;

    await this.appendProviderTerminal(jobId, execution, projectRoot, event);

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

  private async handleProviderJobError(
    jobId: string,
    execution: number,
    signal: AbortSignal,
    error: unknown,
  ): Promise<JobExecutionDisposition> {
    const aborted = signal.aborted || isAbortError(error);
    await this.deps.executionFinisher.accept({ jobId, execution }, (commit) => {
      const status = this.deps.progressStore.readStatus(jobId);
      if (error instanceof CliBusyError) {
        this.appendLaunchRejectedOutcome(commit, jobId, execution, {
          reason: 'busy',
          message: error.message,
          provider: error.detail.provider,
          globalActive: error.detail.globalActive,
          globalLimit: error.detail.globalLimit,
        });
      } else if (error instanceof ProviderHostUnserviceableError) {
        this.appendUnserviceableProviderHostOutcome(commit, jobId, execution, status, error);
      } else if (aborted) {
        this.appendAbortedOutcome(commit, jobId, execution, 'signal_abort');
      } else {
        appendJobExecutionOutcomeAccepted(commit, {
          jobId,
          execution,
          namespace: status?.backendNamespace ?? this.deps.backendNamespace,
          project: status?.projectRoot,
          terminal: {
            content: '',
            durationMs: this.elapsedJobDurationMs(jobId),
            outcome: this.providerJobFailureOutcome(error),
          },
        });
      }
      return undefined;
    });
    this.releaseTerminalJob(jobId, execution);
    return 'terminalized';
  }

  private appendUnserviceableProviderHostOutcome<Scope>(
    commit: CommitContext<Scope>,
    jobId: string,
    execution: number,
    currentStatus: JobStatus | null,
    error: ProviderHostUnserviceableError,
  ): void {
    const durationMs = this.elapsedJobDurationMs(jobId);
    const cause = commit.append({
      type: 'job.execution.progress',
      stream: { kind: 'job', id: jobId },
      namespace: currentStatus?.backendNamespace ?? this.deps.backendNamespace,
      project: currentStatus?.projectRoot,
      refs: buildJobEventRefs({ jobId }),
      body: {
        execution,
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
      execution,
      namespace: currentStatus?.backendNamespace ?? this.deps.backendNamespace,
      project: currentStatus?.projectRoot,
      terminal: { content: '', durationMs, outcome: failedTerminalOutcome(cause) },
    });
  }

  private providerJobFailureOutcome(error: unknown): JobTerminal['outcome'] {
    if (error instanceof ProviderBindingRuntimeError) {
      return {
        kind: 'job_fault',
        fault: {
          kind: 'provider_binding',
          provider: error.failure.provider,
          reason: error.failure.reason,
          message: error.message,
        },
      };
    }
    return {
      kind: 'job_fault',
      fault: {
        kind: 'wrapper_crashed',
        cause: { message: errorMessage(error) },
      },
    };
  }

  private markJobQueued(jobId: string, execution: number, queuePosition: number): void {
    this.appendJobEvent(jobId, execution, 'job.execution.queued', {
      queuePosition,
      runningJobIds: [],
    });
    this.appendProgressEvent(jobId, `queued (position ${queuePosition})`);
  }

  private createProviderRuntime(
    provider: BoundProvider,
    request: ProviderRequest,
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
    const { provider, jobId, signal, permit, requestForRoute, persistedContinuity, operationEnvironment, execution } =
      launch;
    const route = this.deps.appServerProxyRoute;
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
      (identity, containmentStatus, control) =>
        this.publishDurableProcessIdentity(launch, identity, containmentStatus, control),
      jobId,
      {
        permit,
        abortHoldOwner: {
          hold: (id, reason, nextStep, abandon) =>
            this.deps.abortRegistry.hold(id, reason, nextStep, abandon, execution),
          releaseHold: (id) => this.deps.abortRegistry.releaseHold(id, execution),
        },
      },
    );
  }

  private publishDurableProcessIdentity(
    launch: PreparedProviderLaunchContext,
    identity: DurableCliProcessSubject | DurableProvisionalProcessSubject,
    containmentStatus?: DurableContainmentStatus,
    control?: DurableContainmentOperatorControl,
  ): DurableProcessPublicationDisposition {
    const { jobId, execution } = launch;
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
      case 'held':
        return this.publishDurableContainmentHold(launch, identity, evidence, containmentStatus, control);
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
  }

  private publishDurableContainmentHold(
    launch: PreparedProviderLaunchContext,
    identity: DurableCliProcessSubject | DurableProvisionalProcessSubject,
    evidence: DurableCliProcessRuntimeEvidence,
    containmentStatus: Extract<DurableContainmentStatus, { kind: 'held' }>,
    control: DurableContainmentOperatorControl | undefined,
  ): DurableProcessPublicationDisposition {
    const { jobId, execution } = launch;
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

  private publishDurableContainmentDisposition(
    launch: PreparedProviderLaunchContext,
    publication: DurableContainmentPublication,
  ): DurableProcessPublicationDisposition {
    const { jobId } = launch;
    try {
      publication.persist();
    } catch (error: unknown) {
      const reason = `${publication.persistenceFailure}: ${errorMessage(error)}`;
      publication.onPersistenceFailure?.(reason);
      return { kind: 'retained', reason };
    }
    publication.afterPersistence?.();
    try {
      this.appendProgressEvent(jobId, publication.progress);
    } catch (error: unknown) {
      backendLog.warn(
        `Failed to append durable containment ${publication.progressFailure} for ${jobId}: ${errorMessage(error)}`,
      );
    }
    return { kind: 'published' };
  }

  private async appendProviderTerminal(
    jobId: string,
    execution: number,
    projectRoot: string | undefined,
    event: Extract<ProviderEventBody, { kind: 'terminal' }>,
  ): Promise<void> {
    await this.deps.executionFinisher.accept({ jobId, execution }, (commit) => {
      const metadata = this.resolveEventMetadata(jobId, projectRoot);
      this.deps.terminalMaterializer.appendProviderTerminalInCommit(commit, event, {
        jobId,
        execution,
        ...metadata,
      });
      return undefined;
    });
  }

  private readExecutionOrdinal(providerName: string, jobId: string, execution: number): number {
    const session = this.deps.conversationManager.get(providerName, jobId);
    if (!session || !session.open || session.jobId !== jobId || session.execution !== execution) {
      throw new Error(`Expected open execution of ${jobId} for job ${jobId}.`);
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

  private async finishAbortedJob(jobId: string, execution: number, reason: AbortReason): Promise<void> {
    await this.deps.executionFinisher.accept({ jobId, execution }, (commit) => {
      this.appendAbortedOutcome(commit, jobId, execution, reason);
      return undefined;
    });
    this.releaseTerminalJob(jobId, execution);
  }

  private appendAbortedOutcome<Scope>(
    commit: CommitContext<Scope>,
    jobId: string,
    execution: number,
    reason: AbortReason,
  ): void {
    const durationMs = this.elapsedJobDurationMs(jobId);
    commit.append({ type: 'job.execution.aborted', stream: { kind: 'job', id: jobId }, body: { execution, reason } });
    appendJobExecutionOutcomeAccepted(commit, {
      jobId,
      execution,
      terminal: { content: '', outcome: { kind: 'aborted', reason }, durationMs },
    });
  }
}
