import { bindProviderRunner, type ProviderDurableSpawner } from '../../providers/cli-runner.js';
import type {
  ProviderEventBody,
  ProviderRequest,
  ProviderRuntime,
  ProviderSpec,
  ProviderServerLease,
  ProviderServerSpec,
} from '../../providers/contract.js';
import { errorMessage } from '../../infra/error-format.js';
import { nowIsoString } from '../../infra/time.js';
import { backendLog } from '../../infra/backend-log.js';
import type { LaunchDecision } from '../launch.js';
import { isTerminalPhase } from '../phase.js';
import type { JobPhase } from '../phase.js';
import type { JobLaunch, JobTerminalInput } from '../records.js';
import type { SessionEntry } from '../../sessions/entry.js';
import { type AbortReason, type JobAbortedBody, type JobLaunchRejected } from '../outcome.js';
import type { JobProgressBody, JobQueueAdmittedBody, JobQueueQueuedBody } from '../event-bodies.js';
import { type AbortRegistry } from './abort-registry.js';
import { writeResultArtifact } from '../terminal/export.js';
import { CliBusyError } from '../../runtime/cli-busy.js';
import type { AcceptedAdmission, JobAdmissionPort, LaunchPool, QueuedHandle } from '../contracts/admission.js';
import type { JobProgressStore, TerminalWriteOptions } from '../contracts/job-store.js';
import type { Runtime } from '../../runtime/ports.js';
import type { SessionJobClaimPort } from '../../sessions/contracts.js';
import type { CoralEventInput } from '../../store/envelope.js';
import type { JobContinuitySnapshot } from '../continuity.js';
import { consumeJobStream } from './continuity-consumer.js';
import { appendJobTerminalRecorded, failedTerminalOutcome } from '../terminal/recording.js';
import { SessionClaimError, type ClaimJobOptions } from '../session-claim.js';
import { rejectLaunch } from '../launch.js';
import { toProviderRequest } from '../provider-request.js';
import { TerminalWriteError } from '../terminal/write-error.js';

const QUEUE_FULL_MESSAGE = 'All slots and queue are full. Try again later.';
type LauncherJobEventBody = JobProgressBody | JobQueueAdmittedBody | JobQueueQueuedBody | JobAbortedBody;

function missingContinuityMiddleware(method: keyof NonNullable<ProviderRuntime['continuityBridge']>): never {
  throw new Error(`runtime.continuityBridge.${method}() called without sessionContinuity() middleware.`);
}

const NOOP_CONTINUITY_BRIDGE: NonNullable<ProviderRuntime['continuityBridge']> = {
  checkpoint: () => missingContinuityMiddleware('checkpoint'),
  transportClosed: () => missingContinuityMiddleware('transportClosed'),
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function runProviderExecution(
  provider: ProviderSpec,
  request: ProviderRequest,
  runtime: ProviderRuntime,
): AsyncIterable<ProviderEventBody> {
  return provider.run(request, runtime);
}

export interface LaunchOrchestratorDeps {
  abortRegistry: AbortRegistry;
  progressStore: JobProgressStore;
  sessionManager: SessionJobClaimPort;
  launchAdmission: JobAdmissionPort;
  durableSpawner: ProviderDurableSpawner;
  runtime: Pick<Runtime, 'time' | 'ids' | 'storage' | 'env' | 'paths'>;
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
      record?: {
        readonly continuity?: JobContinuitySnapshot | null;
      },
    ): void;
  };
  acquireServer: (
    spec: ProviderServerSpec,
    options?: { jobId?: string; signal?: AbortSignal },
  ) => Promise<ProviderServerLease>;
}

export class LaunchOrchestrator {
  constructor(private readonly deps: LaunchOrchestratorDeps) {}

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
        refs: {
          jobId,
          sessionId,
          ...(options.parentJobId ? { parentJobId: options.parentJobId } : {}),
          ...(options.workflowSlotId ? { workflowSlotId: options.workflowSlotId } : {}),
        },
        bodyVersion: 1,
        body,
      });
      return undefined;
    });
  }

  private appendProgressEvent(jobId: string, sessionId: string, message: string): void {
    this.appendJobEvent(jobId, sessionId, 'job.progress.emitted', {
      kind: 'message',
      message,
      ts: nowIsoString(this.deps.runtime.time),
    });
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
          refs: {
            jobId,
            sessionId,
            ...(options.parentJobId ? { parentJobId: options.parentJobId } : {}),
            ...(workflowId ? { workflowId } : {}),
            ...(options.workflowSlotId ? { workflowSlotId: options.workflowSlotId } : {}),
          },
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
          },
          continuity: null,
        });
        return undefined;
      });
    } catch (error: unknown) {
      throw new TerminalWriteError(jobId, error);
    }
  }

  async claimAndAdmitJob(
    session: SessionEntry,
    providerName: string,
    projectRoot: string,
    sessionBusyMessage: string,
    claimJobAtomic: (
      session: SessionEntry,
      jobId: string,
      providerName: string,
      projectRoot: string,
      options?: ClaimJobOptions,
    ) => Promise<SessionEntry>,
    expectedVersion: number = session.version,
    pool: LaunchPool = 'default',
    requestedJobId?: string,
  ): Promise<{ jobId: string; admission: AcceptedAdmission } | LaunchDecision> {
    const { jobPools, launchAdmission } = this.deps;
    const jobId = requestedJobId ?? this.deps.runtime.ids.uuid();
    jobPools.set(jobId, pool);

    const admission = launchAdmission.requestLaunch(jobId, providerName, pool);
    if (admission === 'queue_full') {
      jobPools.delete(jobId);
      return rejectLaunch('busy', QUEUE_FULL_MESSAGE);
    }

    const initialPhase: Extract<JobPhase, 'queued' | 'launching'> =
      admission.type === 'queued' ? 'queued' : 'launching';

    try {
      await claimJobAtomic(session, jobId, providerName, projectRoot, { expectedVersion, initialPhase });
    } catch (error: unknown) {
      if (admission.type === 'queued') {
        const waitForPermit = admission.waitForPermit();
        admission.cancel();
        void waitForPermit.catch((cleanupError: unknown) => {
          backendLog.warn(`Queued permit cleanup failed for ${jobId}: ${errorMessage(cleanupError)}`);
        });
      } else {
        launchAdmission.releaseLaunch(jobId, pool);
      }
      jobPools.delete(jobId);

      if (error instanceof SessionClaimError) {
        return rejectLaunch('session_busy', sessionBusyMessage);
      }
      throw error;
    }

    return { jobId, admission };
  }

  launchProviderJob(
    provider: ProviderSpec,
    sessionId: string,
    jobId: string,
    request: ProviderRequest,
    admission: AcceptedAdmission,
    opts: { pool?: LaunchPool; projectRoot?: string; parentWorkflowJobId?: string; workflowSlotId?: string } = {},
  ): LaunchDecision {
    const { abortRegistry, backendNamespace, bundleHash, progressStore } = this.deps;
    const pool = opts.pool ?? 'default';
    const projectRoot = opts.projectRoot ?? request.cwd ?? '';
    const enqueueSequence = progressStore.nextEnqueueSequence();
    const createdAt = nowIsoString(this.deps.runtime.time);
    const hostedRequest: ProviderRequest = {
      ...request,
      coralEnv: {
        ...request.coralEnv,
        CORAL_JOB_ID: jobId,
        CORAL_SESSION_ID: sessionId,
      },
    };

    abortRegistry.register(jobId);
    progressStore.appendLaunchRequested(jobId, {
      jobId,
      sessionId,
      provider: provider.name,
      providerAction: request.action,
      projectRoot,
      backendNamespace,
      bundleHash,
      jobKind: 'provider',
      pool,
      enqueueSequence,
      request: {
        prompt: hostedRequest.prompt,
        name: hostedRequest.name,
        model: hostedRequest.model,
        cwd: hostedRequest.cwd ?? '',
        effort: hostedRequest.effort,
        bypassPermissions: hostedRequest.bypassPermissions,
        systemPrompt: hostedRequest.systemPrompt,
        conversationRef: hostedRequest.conversationRef,
        instruction: hostedRequest.instruction,
        coralEnv: hostedRequest.coralEnv,
      },
      parentWorkflowJobId: opts.parentWorkflowJobId,
      workflowSlotId: opts.workflowSlotId,
      createdAt,
    });

    const decisionStatus = admission.type === 'queued' ? 'queued' : 'running';
    if (admission.type === 'queued') {
      this.markJobQueued(jobId, sessionId, admission.queuePosition);
    } else {
      this.appendJobEvent(jobId, sessionId, 'job.queue.admitted', { queuePosition: 0 }, { projectRoot });
    }

    this.runAsync(provider, sessionId, jobId, hostedRequest, admission, pool);
    return { status: decisionStatus, job: jobId, session: sessionId };
  }

  runAsync(
    provider: ProviderSpec,
    sessionId: string,
    jobId: string,
    request: ProviderRequest,
    admission: AcceptedAdmission,
    pool: LaunchPool,
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

        launchAdmission.bindLaunchPermit(jobId, signal, pool);
        await this.executeJob(provider, request, jobId, sessionId, signal, pool);
      } catch (error: unknown) {
        if (error instanceof TerminalWriteError) {
          backendLog.error(error.message, error.cause);
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
        if (permitAcquired) {
          launchAdmission.releaseLaunch(jobId, pool);
        }
      }
    })();
  }

  runRecoveredQueuedJob(
    provider: ProviderSpec,
    launchRecord: JobLaunch,
    admission: QueuedHandle,
    pool: LaunchPool,
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

        launchAdmission.bindLaunchPermit(jobId, signal, pool);
        await this.executeJob(provider, toProviderRequest(launchRecord), jobId, sessionId, signal, pool);
      } catch (error: unknown) {
        if (error instanceof TerminalWriteError) {
          backendLog.error(error.message, error.cause);
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
        launchAdmission.releaseLaunch(jobId, pool);
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
          continuity: options.continuity ?? null,
        });
        return undefined;
      });
      return appended?.seq ?? 0;
    } catch (error: unknown) {
      throw new TerminalWriteError(jobId, error);
    }
  }

  private async executeJob(
    provider: ProviderSpec,
    request: ProviderRequest,
    jobId: string,
    sessionId: string,
    signal: AbortSignal,
    pool: LaunchPool,
  ): Promise<void> {
    const runtime = this.createProviderRuntime(provider.name, sessionId, jobId, signal, pool);
    let latestContinuity: JobContinuitySnapshot | null = null;
    const initialVersion = this.readClaimVersion(provider.name, sessionId, jobId);
    const consumed = await consumeJobStream({
      jobId,
      sessionId,
      initialVersion,
      stream: runProviderExecution(provider, request, runtime),
      sessionApi: {
        checkpointJobContinuityAtomic: async (claimedSessionId, options) => {
          const result = await this.deps.sessionManager.checkpointJobContinuityAtomic(claimedSessionId, options);
          if (result.ok) {
            latestContinuity = {
              conversationRef: options.snapshot.conversationRef,
              resumable: options.snapshot.resumable,
              ...(options.snapshot.providerContinuity === null || options.snapshot.providerContinuity === undefined
                ? {}
                : { providerContinuity: options.snapshot.providerContinuity }),
            };
          }
          return result;
        },
      },
      appendProgress: (message) => {
        this.appendProgressEvent(jobId, sessionId, message);
      },
      recordTerminal: (event) => {
        this.appendProviderTerminal(jobId, sessionId, request.cwd, event, latestContinuity);
      },
    });
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

    this.failJob(jobId, sessionId, {
      content: '',
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
    providerName: string,
    sessionId: string,
    jobId: string,
    signal: AbortSignal,
    pool: LaunchPool,
  ): ProviderRuntime {
    return {
      signal,
      runCli: bindProviderRunner(
        this.deps.durableSpawner,
        providerName,
        signal,
        pool,
        this.deps.progressStore.jobDir(jobId),
        (record) => {
          this.deps.progressStore.appendRuntimeStarted(jobId, record);
        },
      ),
      time: this.deps.runtime.time,
      storage: this.deps.runtime.storage,
      env: this.deps.runtime.env,
      ids: this.deps.runtime.ids,
      acquireServer: (spec) => this.deps.acquireServer(spec, { jobId, signal }),
      persistedContinuity: this.deps.sessionManager.get(providerName, sessionId)?.providerContinuity,
      continuityBridge: NOOP_CONTINUITY_BRIDGE,
    };
  }

  private appendProviderTerminal(
    jobId: string,
    sessionId: string,
    projectRoot: string | undefined,
    event: Extract<ProviderEventBody, { kind: 'terminal' }>,
    continuity: JobContinuitySnapshot | null,
  ): void {
    const { progressStore } = this.deps;
    const metadata = this.resolveEventMetadata(jobId, projectRoot);
    const currentStatus = progressStore.readStatus(jobId);
    if (currentStatus && isTerminalPhase(currentStatus.phase)) {
      return;
    }

    try {
      this.deps.terminalMaterializer.recordProviderTerminal(
        progressStore,
        event,
        {
          jobId,
          sessionId,
          namespace: metadata.namespace,
          project: metadata.project,
          correlationId: metadata.correlationId,
        },
        { continuity },
      );
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
    this.writeJobTerminal(jobId, sessionId, { content: '', outcome: { kind: 'aborted', reason } }, 'aborted');
    abortRegistry.remove(jobId);
    jobPools.delete(jobId);
    sessionManager.releaseJob(sessionId, jobId);
  }
}
