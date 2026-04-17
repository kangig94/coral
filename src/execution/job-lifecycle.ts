import type { ProviderCliRunner } from '../providers/runner-port.js';
import type {
  ProviderExecutor,
  ProviderRecoveryMeta,
  ProviderRuntime,
  ProviderServerLease,
  ProviderServerSpec,
} from '../providers/types.js';
import { errorMessage, nowIsoString } from '../shared/utils.js';
import { backendLog } from '../shared/backend-log.js';
import {
  isTerminalPhase,
  type JobPhase,
  type LaunchDecision,
  type LaunchState,
  type PersistedLaunchRecord,
  type PersistedStatusRecord,
  type ProviderProgressEvent,
  type ProviderRequest,
  type ProviderResult,
  type SessionEntry,
  type TerminalResult,
  type WaitRequest,
  type WaitStreamEvent,
} from '../shared/types.js';
import { type AbortRegistry } from './abort-controller-registry.js';
import { CliBusyError, type LaunchCoordinator, type LaunchPool, type QueuedHandle } from './engine.js';
import { type TypedEventBus } from './event-bus.js';
import { type ProgressStore, createReplayCursor } from './progress-store.js';
import type { Runtime, RuntimeTimePort } from './runtime.js';
import { type SessionManager } from './session-manager.js';
import {
  QUEUED_ABORT_MESSAGE,
  SessionClaimError,
  WAIT_FOR_JOB_TERMINAL_TIMEOUT_MS,
  rejectLaunch,
  toProviderRequest,
  type AcceptedAdmission,
  type ClaimJobOptions,
} from './job-lifecycle-contracts.js';

const QUEUE_FULL_MESSAGE = 'All slots and queue are full. Try again later.';
const JOB_TERMINAL_RELEASE_POLL_MS = 10;

function bindProviderRunner(
  launchCoordinator: LaunchCoordinator,
  provider: string,
  signal: AbortSignal,
  pool: LaunchPool,
  jobDir: string,
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
    });
}

function canAdvanceLaunchState(status: PersistedStatusRecord | null): status is PersistedStatusRecord {
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
  runtime: Pick<Runtime, 'time' | 'ids'>;
  backendNamespace: string;
  bundleHash: string;
  jobPools: Map<string, LaunchPool>;
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
    result: ProviderResult,
  ) => Promise<void>;
}

export class LaunchOrchestrator {
  constructor(private readonly deps: LaunchOrchestratorDeps) {}

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
  ): Promise<{ jobId: string; admission: AcceptedAdmission } | LaunchDecision> {
    const { jobPools, launchCoordinator } = this.deps;
    const jobId = this.deps.runtime.ids.uuid();
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
    opts: { pool?: LaunchPool; projectRoot?: string; parentWorkflowJobId?: string } = {},
  ): LaunchDecision {
    const { abortRegistry, backendNamespace, bundleHash, progressStore } = this.deps;
    const pool = opts.pool ?? 'default';

    abortRegistry.register(jobId);
    progressStore.writeLaunchRecord(jobId, {
      jobId,
      sessionId,
      provider: provider.name,
      projectRoot: opts.projectRoot ?? request.cwd ?? '',
      backendNamespace,
      bundleHash,
      pool,
      enqueueSequence: progressStore.nextEnqueueSequence(),
      providerAction: request.action,
      request: {
        prompt: request.prompt,
        name: request.name,
        model: request.model,
        cwd: request.cwd,
        effort: request.effort,
        bypassPermissions: request.bypassPermissions,
        systemPrompt: request.systemPrompt,
        conversationRef: request.conversationRef,
        instruction: request.instruction,
        coralEnv: request.coralEnv,
      },
      parentWorkflowJobId: opts.parentWorkflowJobId,
      createdAt: nowIsoString(this.deps.runtime.time),
    });

    const decisionStatus = admission.type === 'queued' ? 'queued' : 'running';
    if (admission.type === 'queued') {
      this.markJobQueued(jobId, sessionId, admission.queuePosition);
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
            this.finishQueuedAbort(jobId, sessionId, QUEUED_ABORT_MESSAGE);
            return;
          }

          permitAcquired = true;
          this.markJobLaunching(jobId);
          this.deps.progressStore.appendProgress(jobId, sessionId, 'dequeued, launching');
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
    launchRecord: PersistedLaunchRecord,
    admission: QueuedHandle,
    pool: LaunchPool,
  ): void {
    const { abortRegistry, launchCoordinator, progressStore } = this.deps;
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
          this.finishQueuedAbort(jobId, sessionId, QUEUED_ABORT_MESSAGE);
          return;
        }

        this.markJobLaunching(jobId);
        progressStore.appendProgress(jobId, sessionId, 'dequeued, launching');

        launchCoordinator.bindLaunchPermit(jobId, signal, pool);
        await this.executeJob(provider, toProviderRequest(launchRecord), jobId, sessionId, signal, pool);
      } catch (error: unknown) {
        this.handleProviderJobError(jobId, sessionId, signal, error);
      } finally {
        launchCoordinator.releaseLaunch(jobId, pool);
      }
    })();
  }

  finishQueuedAbort(jobId: string, sessionId: string, message: string): void {
    this.finishAbortedJob(jobId, sessionId, message);
  }

  failJob(jobId: string, sessionId: string, launchState: LaunchState, message: string): void {
    const { abortRegistry, jobPools, progressStore, sessionManager } = this.deps;
    progressStore.updateLaunchState(jobId, launchState, message);
    this.writeTerminalResult(jobId, sessionId, { content: '', notice: message }, 'error');
    abortRegistry.remove(jobId);
    jobPools.delete(jobId);
    sessionManager.releaseJob(sessionId, jobId);
  }

  markJobRunning(jobId: string): void {
    this.markJobReady(jobId);
    this.deps.progressStore.updatePhase(jobId, 'running');
  }

  writeTerminalResult(jobId: string, sessionId: string, result: TerminalResult, phase: JobPhase): void {
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
    const onEvent = (event: ProviderProgressEvent): void => {
      const currentStatus = this.deps.progressStore.readStatus(jobId);
      if (canAdvanceLaunchState(currentStatus)) {
        this.markJobRunning(jobId);
      }
      this.deps.progressStore.appendProgress(jobId, sessionId, event.message);
    };

    try {
      const runtime = this.createProviderRuntime(provider.name, sessionId, jobId, signal, pool, onEvent);
      const result = await provider.execute(request, runtime);
      await this.handleJobCompletion(provider.name, request, sessionId, jobId, result);
    } catch (error: unknown) {
      this.handleProviderJobError(jobId, sessionId, signal, error);
    }
  }

  private async handleJobCompletion(
    providerName: string,
    request: ProviderRequest,
    sessionId: string,
    jobId: string,
    result: ProviderResult,
  ): Promise<void> {
    const { abortRegistry, jobPools, progressStore } = this.deps;
    if (canAdvanceLaunchState(progressStore.readStatus(jobId))) {
      this.markJobReady(jobId);
    }

    const phase: JobPhase = result.aborted ? 'aborted' : 'completed';
    const terminalResult: TerminalResult = {
      content: result.content,
      durationMs: result.durationMs,
      aborted: result.aborted,
      nonResumable: result.nonResumable,
      exitCode: result.exitCode,
      notice: result.notice,
      errors: result.errors,
      warnings: result.warnings,
      usage: result.usage,
    };

    const currentStatus = progressStore.readStatus(jobId);
    if (currentStatus && isTerminalPhase(currentStatus.phase)) {
      return;
    }

    this.writeTerminalResult(jobId, sessionId, terminalResult, phase);
    progressStore.writeResultMd(jobId, result.content);
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
      this.failJob(jobId, sessionId, 'busy', error.message);
      return;
    }

    const message = errorMessage(error);
    if (signal.aborted || isAbortError(error)) {
      this.finishAbortedJob(jobId, sessionId, message);
      return;
    }

    this.failJob(jobId, sessionId, 'error', message);
  }

  private markJobQueued(jobId: string, sessionId: string, queuePosition: number): void {
    this.deps.progressStore.updateLaunchState(jobId, 'queued');
    this.deps.progressStore.appendProgress(jobId, sessionId, `queued (position ${queuePosition})`);
  }

  private createProviderRuntime(
    providerName: string,
    sessionId: string,
    jobId: string,
    signal: AbortSignal,
    pool: LaunchPool,
    onEvent: (event: ProviderProgressEvent) => void,
  ): ProviderRuntime {
    return {
      signal,
      onEvent,
      runCli: bindProviderRunner(
        this.deps.launchCoordinator,
        providerName,
        signal,
        pool,
        this.deps.progressStore.jobDir(jobId),
      ),
      acquireServer: (spec) => this.deps.acquireServer(spec, { jobId, signal }),
      persistedContinuity: this.deps.sessionManager.get(providerName, sessionId)?.providerContinuity,
      checkpointRecovery: (update) => {
        this.deps.checkpointRecovery(jobId, update);
      },
    };
  }

  private markJobLaunching(jobId: string): void {
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
    this.deps.progressStore.updateLaunchState(jobId, 'ready');
  }

  private finishAbortedJob(jobId: string, sessionId: string, message: string): void {
    const { abortRegistry, jobPools, progressStore, sessionManager } = this.deps;
    progressStore.updateLaunchState(jobId, 'error', message);
    this.writeTerminalResult(jobId, sessionId, { content: '', aborted: true, notice: message }, 'aborted');
    abortRegistry.remove(jobId);
    jobPools.delete(jobId);
    sessionManager.releaseJob(sessionId, jobId);
  }
}

export interface WaitCoordinatorDeps {
  progressStore: ProgressStore;
  sessionManager: SessionManager;
  launchCoordinator: LaunchCoordinator;
  eventBus: TypedEventBus;
  jobPools: ReadonlyMap<string, LaunchPool>;
  time: RuntimeTimePort;
}

export class WaitCoordinator {
  constructor(private readonly deps: WaitCoordinatorDeps) {}

  async waitForJobTerminal(jobId: string, timeoutMs = WAIT_FOR_JOB_TERMINAL_TIMEOUT_MS): Promise<void> {
    const initialStatus = this.readStatusOrThrow(jobId);
    const owner = {
      provider: initialStatus.provider,
      sessionId: initialStatus.sessionId,
    };
    const timeoutError = new Error(
      `Timed out waiting for job ${jobId} to reach a terminal state and release its session`,
    );

    if (this.isTerminalAndReleased(jobId, owner.provider, owner.sessionId, initialStatus)) {
      return;
    }

    const startedAt = this.deps.time.now();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let releasePollTimer: ReturnType<RuntimeTimePort['setTimeout']> | undefined;

      const remainingMs = timeoutMs - (this.deps.time.now() - startedAt);
      if (remainingMs <= 0) {
        reject(timeoutError);
        return;
      }

      const timer = this.deps.time.setTimeout(() => {
        finish(() => reject(timeoutError));
      }, remainingMs);

      const cleanup = (): void => {
        this.deps.eventBus.off('job:completed', onJobCompleted);
        this.deps.eventBus.off('job:phase_changed', onJobPhaseChanged);
        this.deps.eventBus.off('job:progress', onJobProgress);
        this.deps.time.clearTimeout(releasePollTimer ?? null);
        this.deps.time.clearTimeout(timer);
      };

      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callback();
      };

      const recheck = (): void => {
        try {
          const status = this.readStatusOrThrow(jobId);
          if (!isTerminalPhase(status.phase)) {
            return;
          }
          if (!this.isTerminalAndReleased(jobId, owner.provider, owner.sessionId, status)) {
            scheduleReleasePoll();
            return;
          }
          finish(resolve);
        } catch (error: unknown) {
          finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        }
      };

      const scheduleReleasePoll = (): void => {
        if (settled || releasePollTimer) {
          return;
        }
        releasePollTimer = this.deps.time.setTimeout(() => {
          releasePollTimer = undefined;
          recheck();
        }, JOB_TERMINAL_RELEASE_POLL_MS);
      };

      const onJobCompleted = ({ jobId: completedJobId }: { jobId: string }): void => {
        if (completedJobId === jobId) {
          recheck();
        }
      };

      const onJobPhaseChanged = ({ jobId: changedJobId }: { jobId: string }): void => {
        if (changedJobId === jobId) {
          recheck();
        }
      };

      const onJobProgress = ({ jobId: progressedJobId }: { jobId: string }): void => {
        if (progressedJobId === jobId) {
          recheck();
        }
      };

      this.deps.eventBus.on('job:completed', onJobCompleted);
      this.deps.eventBus.on('job:phase_changed', onJobPhaseChanged);
      this.deps.eventBus.on('job:progress', onJobProgress);

      recheck();
      if (settled) {
        return;
      }
    });
  }

  async *waitForJobs(req: WaitRequest): AsyncGenerator<WaitStreamEvent> {
    const { progressStore, launchCoordinator, jobPools } = this.deps;
    const { jobIds, timeoutSeconds = 600, cursor } = req;
    const startMs = this.deps.time.now();
    const timeoutMs = timeoutSeconds * 1000;

    const fromEventIds: Record<string, number> = cursor?.jobs ? { ...cursor.jobs } : {};
    const fileCursors = new Map(jobIds.map((jobId) => [jobId, createReplayCursor()]));
    const emittedQueued = new Set<string>();
    const pending = new Set(jobIds);

    while (pending.size > 0) {
      if (this.deps.time.now() - startMs >= timeoutMs) {
        yield { type: 'running', runningJobIds: [...pending] };
        return;
      }

      const seq = progressStore.getChangeSeq();

      for (const jobId of [...pending]) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- fileCursors initialized from same jobIds as pending
        const fileCursor = fileCursors.get(jobId)!;
        const fromEventId = fromEventIds[jobId] ?? 0;
        const status = progressStore.readStatus(jobId);
        if (!status) {
          continue;
        }

        if (status.phase === 'queued' && !emittedQueued.has(jobId)) {
          emittedQueued.add(jobId);
          const pool = jobPools.get(jobId) ?? 'default';
          yield {
            type: 'queued',
            jobId,
            sessionId: status.sessionId,
            queuePosition: launchCoordinator.queuePosition(jobId, pool) ?? 0,
            runningJobIds: launchCoordinator.getActiveJobIds(pool),
          };
        }

        const events = progressStore.replayFrom(jobId, fromEventId, fileCursor);
        for (const event of events) {
          fromEventIds[jobId] = event.eventId;

          if (event.type === 'progress') {
            yield {
              type: 'progress',
              jobId,
              sessionId: status.sessionId,
              eventId: event.eventId,
              message: event.message ?? '',
            };
            continue;
          }

          const remainingJobIds = jobIds.filter((id) => id !== jobId && pending.has(id));
          yield {
            type: 'terminal',
            completedJobId: jobId,
            sessionId: status.sessionId,
            remainingJobIds,
            resultPath: progressStore.resultPath(jobId),
            result: event.result ?? { content: '' },
          };
          pending.delete(jobId);
          break;
        }

        const currentStatus = progressStore.readStatus(jobId);
        if (pending.has(jobId) && currentStatus && isTerminalPhase(currentStatus.phase)) {
          const remainingJobIds = jobIds.filter((id) => id !== jobId && pending.has(id));
          yield {
            type: 'terminal',
            completedJobId: jobId,
            sessionId: currentStatus.sessionId,
            remainingJobIds,
            resultPath: progressStore.resultPath(jobId),
            result: currentStatus.result ?? { content: '' },
          };
          pending.delete(jobId);
        }
      }

      if (pending.size === 0) {
        return;
      }

      const remainingMs = timeoutMs - (this.deps.time.now() - startMs);
      if (remainingMs <= 0) {
        continue;
      }

      await Promise.race([
        progressStore.waitForChange(seq),
        this.deps.time.sleep(remainingMs),
      ]);
    }
  }

  async waitStreamOnce(jobId: string, timeoutMs?: number): Promise<{ content: string; nonResumable: boolean }> {
    const request: WaitRequest = { jobIds: [jobId] };
    if (timeoutMs !== undefined) {
      request.timeoutSeconds = timeoutMs / 1000;
    }

    for await (const event of this.waitForJobs(request)) {
      if (event.type === 'terminal' && event.completedJobId === jobId) {
        return {
          content: event.result.content,
          nonResumable: event.result.nonResumable ?? false,
        };
      }
      if (event.type === 'running') {
        throw new Error('Wait expired while job still running');
      }
    }

    throw new Error(`Job ${jobId} ended without a terminal result`);
  }

  private readStatusOrThrow(jobId: string): PersistedStatusRecord {
    const status = this.deps.progressStore.readStatus(jobId);
    if (!status) {
      throw new Error(`Job not found: ${jobId}`);
    }
    return status;
  }

  private isTerminalAndReleased(
    jobId: string,
    providerName: string,
    sessionId: string,
    status: PersistedStatusRecord,
  ): boolean {
    if (!isTerminalPhase(status.phase)) {
      return false;
    }

    const session = this.deps.sessionManager.get(providerName, sessionId);
    return session?.activeJobId !== jobId;
  }
}
