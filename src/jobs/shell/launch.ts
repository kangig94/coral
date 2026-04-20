import type { ProviderCliRunner } from '../../providers/runner-port.js';
import type {
  ProviderExecutor,
  ProviderRecoveryMeta,
  ProviderRuntime,
  ProviderServerLease,
  ProviderServerSpec,
} from '../../providers/provider-contracts.js';
import { errorMessage, nowIsoString } from '../../shared/utils.js';
import { backendLog } from '../../shared/backend-log.js';
import { getCallerContext } from '../../coordinator/caller-context.js';
import type { LaunchDecision } from '../launch.js';
import { isTerminalPhase } from '../phase.js';
import type { JobPhase } from '../phase.js';
import type { JobLaunch, JobRuntime, JobStatus, JobTerminal, LaunchState } from '../views.js';
import type { ProviderEventBody, ProviderRequest, ProviderTerminalEventBody } from '../../providers/protocol.js';
import type { SessionEntry } from '../../sessions/entry.js';
import { phaseForOutcome, type AbortReason, type CauseRef, type JobLaunchRejected, type TerminalOutcome } from '../outcome.js';
import { type AbortRegistry } from './abort-registry.js';
import { writeWorkflowResult } from './result-artifact.js';
import { CliBusyError } from '../../coordinator/live/admission.js';
import type {
  ExecutionLaunchCoordinator as LaunchCoordinator,
  ExecutionLaunchPool as LaunchPool,
  ExecutionQueuedHandle as QueuedHandle,
} from '../../coordinator/contracts.js';
import { type ProgressStore } from '../job-store.js';
import type { Runtime } from '../../runtime/ports.js';
import { type SessionManager } from '../../sessions/shell/store.js';
import type { AppendEventsFn } from '../../store/append.js';
import type { CoralEventInput } from '../../store/envelope.js';
import { materializeProviderTerminal } from '../reconcile/job-helpers.js';
import {
  SessionClaimError,
  rejectLaunch,
  toProviderRequest,
  type AcceptedAdmission,
  type ClaimJobOptions,
} from './contracts.js';

const QUEUE_FULL_MESSAGE = 'All slots and queue are full. Try again later.';

function bindProviderRunner(
  launchCoordinator: LaunchCoordinator,
  provider: string,
  signal: AbortSignal,
  pool: LaunchPool,
  jobDir: string,
  onRuntimeRecord?: (record: JobRuntime) => void,
): ProviderCliRunner {
  return (request) =>
    launchCoordinator.spawnDurableJob({
      provider,
      signal,
      permitGranted: true,
      pool,
      jobDir,
      command: request.command,
      args: request.args,
      prompt: request.prompt,
      cwd: request.cwd,
      extraEnv: request.extraEnv,
      onEvent: request.onEvent,
      onRuntimeRecord,
    });
}

function canAdvanceLaunchState(status: JobStatus | null): status is JobStatus {
  return status !== null && !isTerminalPhase(status.phase) && status.launch.state !== 'ready';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export interface LaunchOrchestratorDeps {
  abortRegistry: AbortRegistry;
  progressStore: ProgressStore;
  sessionManager: SessionManager;
  launchCoordinator: LaunchCoordinator;
  runtime: Pick<Runtime, 'time' | 'ids' | 'storage' | 'env'>;
  backendNamespace: string;
  bundleHash: string;
  jobPools: Map<string, LaunchPool>;
  appendEvents: AppendEventsFn;
  acquireServer: (
    spec: ProviderServerSpec,
    options?: { jobId?: string; signal?: AbortSignal },
  ) => Promise<ProviderServerLease>;
  checkpointRecovery: (jobId: string, update: { conversationRef?: string; providerMeta: ProviderRecoveryMeta }) => void;
  finalizeProviderSession: (
    providerName: string,
    request: ProviderRequest,
    sessionId: string,
    jobId: string,
    result: ProviderTerminalEventBody,
  ) => Promise<void>;
}

export class LaunchOrchestrator {
  constructor(private readonly deps: LaunchOrchestratorDeps) {}

  private resolveEventMetadata(
    jobId: string,
    projectRoot?: string,
  ): Pick<CoralEventInput, 'correlationId' | 'namespace' | 'project'> {
    const caller = getCallerContext();
    if (caller) {
      return {
        namespace: caller.namespace,
        project: caller.project,
        correlationId: caller.correlationId,
      };
    }

    const launch = this.deps.progressStore.readLaunchRecord(jobId);
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
    body: unknown,
    options: {
      parentJobId?: string;
      workflowSlotId?: string;
      projectRoot?: string;
    } = {},
  ): void {
    const metadata = this.resolveEventMetadata(jobId, options.projectRoot);
    this.deps.progressStore.appendEvent({
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
  }

  private appendProgressEvent(jobId: string, sessionId: string, message: string): void {
    this.appendJobEvent(jobId, sessionId, 'job.progress.emitted', {
      kind: 'message',
      message,
      ts: nowIsoString(this.deps.runtime.time),
    });
  }

  private appendJobFailureCause(
    jobId: string,
    sessionId: string,
    body: JobLaunchRejected,
    options: {
      parentJobId?: string;
      workflowSlotId?: string;
      projectRoot?: string;
    } = {},
  ): TerminalOutcome {
    const metadata = this.resolveEventMetadata(jobId, options.projectRoot);
    const [appended] = this.deps.progressStore.appendEventsWithResult([
      {
        type: 'job.launch.rejected',
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
      },
    ]);

    if (!appended) {
      throw new Error(`Failed to append job.launch.rejected for ${jobId}`);
    }

    return {
      kind: 'failed',
      causeRef: {
        stream: appended.stream as CauseRef['stream'],
        seq: appended.seq,
      },
    };
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
    const { jobPools, launchCoordinator } = this.deps;
    const jobId = requestedJobId ?? this.deps.runtime.ids.uuid();
    jobPools.set(jobId, pool);

    const admission = launchCoordinator.requestLaunch(jobId, providerName, pool);
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
        launchCoordinator.releaseLaunch(jobId, pool);
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
    provider: ProviderExecutor,
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

    abortRegistry.register(jobId);
    this.appendJobEvent(
      jobId,
      sessionId,
      'job.launch.requested',
      {
        sessionId,
        provider: provider.name,
        providerAction: request.action,
        projectRoot,
        backendNamespace,
        bundleHash,
        pool,
        enqueueSequence,
        request: {
          prompt: request.prompt,
          name: request.name,
          model: request.model,
          cwd: request.cwd ?? '',
          effort: request.effort,
          bypassPermissions: request.bypassPermissions,
          systemPrompt: request.systemPrompt,
          conversationRef: request.conversationRef,
          instruction: request.instruction,
          coralEnv: request.coralEnv,
        },
        parentJobId: opts.parentWorkflowJobId,
        workflowSlot: opts.workflowSlotId,
        createdAt,
      },
      {
        parentJobId: opts.parentWorkflowJobId,
        workflowSlotId: opts.workflowSlotId,
        projectRoot,
      },
    );

    const decisionStatus = admission.type === 'queued' ? 'queued' : 'running';
    if (admission.type === 'queued') {
      this.markJobQueued(jobId, sessionId, admission.queuePosition);
    } else {
      this.appendJobEvent(jobId, sessionId, 'job.queue.admitted', { queuePosition: 0 }, { projectRoot });
    }

    this.runAsync(provider, sessionId, jobId, request, admission, pool);
    return { status: decisionStatus, job: jobId, session: sessionId };
  }

  runAsync(
    provider: ProviderExecutor,
    sessionId: string,
    jobId: string,
    request: ProviderRequest,
    admission: AcceptedAdmission,
    pool: LaunchPool,
  ): void {
    const { abortRegistry, launchCoordinator } = this.deps;
    const signal = abortRegistry.getSignal(jobId);
    if (!signal) {
      if (admission.type === 'queued') {
        admission.cancel();
      } else {
        launchCoordinator.releaseLaunch(jobId, pool);
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
          this.markJobLaunching(jobId);
          this.appendJobEvent(jobId, sessionId, 'job.queue.admitted', {});
          this.appendProgressEvent(jobId, sessionId, 'dequeued, launching');
        }

        launchCoordinator.bindLaunchPermit(jobId, signal, pool);
        await this.executeJob(provider, request, jobId, sessionId, signal, pool);
      } catch (error: unknown) {
        this.handleProviderJobError(jobId, sessionId, signal, error);
      } finally {
        if (permitAcquired) {
          launchCoordinator.releaseLaunch(jobId, pool);
        }
      }
    })();
  }

  runRecoveredQueuedJob(
    provider: ProviderExecutor,
    launchRecord: JobLaunch,
    admission: QueuedHandle,
    pool: LaunchPool,
  ): void {
    const { abortRegistry, launchCoordinator } = this.deps;
    const jobId = launchRecord.jobId;
    const sessionId = launchRecord.sessionId;
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

        this.markJobLaunching(jobId);
        this.appendJobEvent(jobId, sessionId, 'job.queue.admitted', {});
        this.appendProgressEvent(jobId, sessionId, 'dequeued, launching');

        launchCoordinator.bindLaunchPermit(jobId, signal, pool);
        await this.executeJob(provider, toProviderRequest(launchRecord), jobId, sessionId, signal, pool);
      } catch (error: unknown) {
        this.handleProviderJobError(jobId, sessionId, signal, error);
      } finally {
        launchCoordinator.releaseLaunch(jobId, pool);
      }
    })();
  }

  finishQueuedAbort(jobId: string, sessionId: string, reason: AbortReason): void {
    this.finishAbortedJob(jobId, sessionId, reason);
  }

  failJob(jobId: string, sessionId: string, launchState: LaunchState, terminal: JobTerminal): void {
    const { abortRegistry, jobPools, sessionManager } = this.deps;
    void launchState;
    this.writeJobTerminal(jobId, sessionId, terminal, 'error');
    abortRegistry.remove(jobId);
    jobPools.delete(jobId);
    sessionManager.releaseJob(sessionId, jobId);
  }

  markJobRunning(jobId: string): void {
    if (this.deps.progressStore.readLaunchRecord(jobId) !== null) {
      return;
    }
    this.deps.progressStore.updateLaunchState(jobId, 'ready');
    this.deps.progressStore.updatePhase(jobId, 'running');
  }

  writeJobTerminal(jobId: string, sessionId: string, result: JobTerminal, phase: JobPhase): void {
    const { progressStore } = this.deps;
    try {
      progressStore.appendTerminal(jobId, sessionId, result, phase);
    } catch {
      try {
        progressStore.markTerminalStatus(jobId, result, phase);
      } catch {
        /* best-effort terminal write */
      }
    }
  }

  private async executeJob(
    provider: ProviderExecutor,
    request: ProviderRequest,
    jobId: string,
    sessionId: string,
    signal: AbortSignal,
    pool: LaunchPool,
  ): Promise<void> {
    try {
      const runtime = this.createProviderRuntime(provider.name, sessionId, jobId, signal, pool);
      let terminal: ProviderTerminalEventBody | null = null;

      for await (const event of provider.execute(request, runtime)) {
        if (terminal) {
          throw new Error(`Provider ${provider.name} emitted ${event.type} after launch.terminal`);
        }

        if (event.type === 'launch.progress') {
          const currentStatus = this.deps.progressStore.readStatus(jobId);
          if (canAdvanceLaunchState(currentStatus)) {
            this.markJobRunning(jobId);
          }
          this.appendProgressEvent(jobId, sessionId, event.message);
          continue;
        }

        terminal = event;
      }

      if (!terminal) {
        throw new Error(`Provider ${provider.name} completed without emitting launch.terminal`);
      }

      await this.handleJobCompletion(provider.name, request, sessionId, jobId, terminal);
    } catch (error: unknown) {
      this.handleProviderJobError(jobId, sessionId, signal, error);
    }
  }

  private async handleJobCompletion(
    providerName: string,
    request: ProviderRequest,
    sessionId: string,
    jobId: string,
    result: ProviderTerminalEventBody,
  ): Promise<void> {
    const { abortRegistry, jobPools, progressStore } = this.deps;
    if (canAdvanceLaunchState(progressStore.readStatus(jobId))) {
      this.markJobReady(jobId);
    }

    const metadata = this.resolveEventMetadata(jobId, request.cwd);
    const terminalResult = materializeProviderTerminal(progressStore, result, {
      jobId,
      sessionId,
      namespace: metadata.namespace,
      project: metadata.project,
      correlationId: metadata.correlationId,
    });
    const phase = phaseForOutcome(terminalResult.outcome);

    const currentStatus = progressStore.readStatus(jobId);
    if (currentStatus && isTerminalPhase(currentStatus.phase)) {
      return;
    }

    this.writeJobTerminal(jobId, sessionId, terminalResult, phase);
    progressStore.writeResultMd(jobId, result.content);
    writeWorkflowResult(this.deps.runtime.storage, jobId, result.content);
    abortRegistry.remove(jobId);
    jobPools.delete(jobId);
    try {
      await this.deps.finalizeProviderSession(providerName, request, sessionId, jobId, result);
    } catch (error: unknown) {
      this.deps.sessionManager.releaseJob(sessionId, jobId);
      backendLog.warn(`Provider session finalization failed for ${jobId}: ${errorMessage(error)}`);
      throw error;
    }
  }

  private handleProviderJobError(jobId: string, sessionId: string, signal: AbortSignal, error: unknown): void {
    const currentStatus = this.deps.progressStore.readStatus(jobId);
    if (!currentStatus || isTerminalPhase(currentStatus.phase)) {
      return;
    }

    if (error instanceof CliBusyError) {
      const outcome = this.appendJobFailureCause(jobId, sessionId, {
        reason: 'busy',
        message: error.message,
        provider: error.detail.provider,
        globalActive: error.detail.globalActive,
        globalLimit: error.detail.globalLimit,
      });
      this.failJob(jobId, sessionId, 'busy', { content: '', outcome });
      return;
    }

    if (signal.aborted || isAbortError(error)) {
      this.finishAbortedJob(jobId, sessionId, 'signal_abort');
      return;
    }

    this.failJob(jobId, sessionId, 'error', {
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
        this.deps.launchCoordinator,
        providerName,
        signal,
        pool,
        this.deps.progressStore.jobDir(jobId),
        (record) => {
          this.deps.progressStore.writeRuntimeRecord(jobId, record);
        },
      ),
      storage: this.deps.runtime.storage,
      env: this.deps.runtime.env,
      acquireServer: (spec) => this.deps.acquireServer(spec, { jobId, signal }),
      persistedContinuity: this.deps.sessionManager.get(providerName, sessionId)?.providerContinuity,
      checkpointRecovery: (update) => {
        this.deps.checkpointRecovery(jobId, update);
      },
    };
  }

  private markJobLaunching(jobId: string): void {
    if (this.deps.progressStore.readLaunchRecord(jobId) !== null) {
      return;
    }
    this.deps.progressStore.updatePhase(jobId, 'launching');
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

  private markJobReady(jobId: string): void {
    if (this.deps.progressStore.readLaunchRecord(jobId) !== null) {
      return;
    }
    this.deps.progressStore.updateLaunchState(jobId, 'ready');
  }

  private finishAbortedJob(jobId: string, sessionId: string, reason: AbortReason): void {
    const { abortRegistry, jobPools, progressStore, sessionManager } = this.deps;
    void progressStore;
    this.appendJobEvent(jobId, sessionId, 'job.aborted', { reason });
    this.writeJobTerminal(
      jobId,
      sessionId,
      { content: '', outcome: { kind: 'aborted', reason } },
      'aborted',
    );
    abortRegistry.remove(jobId);
    jobPools.delete(jobId);
    sessionManager.releaseJob(sessionId, jobId);
  }
}
