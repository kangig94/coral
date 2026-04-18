import type { AbortResult } from '../shared/execution-contracts.js';
import type { ExecutionServiceLike } from '../execution/backend-contracts.js';
import { createReplayCursor, type ProgressStore } from '../execution/progress-store.js';
import type { RecoveryRegistry } from '../execution/recovery-registry.js';
import type { PersistedLaunchRecord, PersistedProgressRecord, PersistedRuntimeRecord, PersistedStatusRecord, WaitStreamEvent } from '../shared/types.js';
import type { JobPhase } from './phase.js';
import type { TerminalOutcome } from './outcome.js';
import { createRecoveryCoordinator } from './reconcile/coordinator.js';

export type JobStatusRow = {
  jobId: string;
  phase: JobPhase;
  terminalJson: string | null;
  diagnosticsJson: string | null;
  parentJobId: string | null;
  workflowSlot: string | null;
  lastSeq: number;
};

export type JobLaunchRow = PersistedLaunchRecord;
export type JobProgressRow = PersistedProgressRecord;
export type JobRuntimeRow = PersistedRuntimeRecord | null;
export type JobExitRow = {
  outcome: TerminalOutcome;
  content: string;
  durationMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  nonResumable?: boolean;
};

export const jobsCommands = {
  start(service: Pick<ExecutionServiceLike, 'start'>, ...args: unknown[]): ReturnType<ExecutionServiceLike['start']> {
    return service.start(...(args as Parameters<ExecutionServiceLike['start']>));
  },
  resume(
    service: Pick<ExecutionServiceLike, 'resumeBySessionId'>,
    ...args: unknown[]
  ): ReturnType<ExecutionServiceLike['resumeBySessionId']> {
    return service.resumeBySessionId(...(args as Parameters<ExecutionServiceLike['resumeBySessionId']>));
  },
  fork(
    service: Pick<ExecutionServiceLike, 'forkBySessionId'>,
    ...args: unknown[]
  ): ReturnType<ExecutionServiceLike['forkBySessionId']> {
    return service.forkBySessionId(...(args as Parameters<ExecutionServiceLike['forkBySessionId']>));
  },
  abort(
    service: Pick<ExecutionServiceLike, 'abort'>,
    jobIds: string[],
  ): AbortResult {
    return service.abort(jobIds);
  },
} as const;

export const jobsQueries = {
  list(progressStore: ProgressStore): Array<{ jobId: string; status: PersistedStatusRecord }> {
    return progressStore.listJobIds().flatMap((jobId) => {
      const status = progressStore.readStatus(jobId);
      return status ? [{ jobId, status }] : [];
    });
  },
  detail(progressStore: ProgressStore, jobId: string): {
    status: PersistedStatusRecord | null;
    launch: PersistedLaunchRecord | null;
    runtime: PersistedRuntimeRecord | null;
    exit: JobExitRow | null;
  } {
    const status = progressStore.readStatus(jobId);
    const exit = progressStore.readTerminalPayload(jobId);
    return {
      status,
      launch: progressStore.readLaunchRecord(jobId),
      runtime: progressStore.readRuntimeRecord(jobId),
      exit:
        exit === null
          ? null
          : {
              outcome: exit.outcome,
              content: exit.content,
              durationMs: exit.durationMs,
              exitCode: exit.exitCode,
              nonResumable: exit.nonResumable,
            },
    };
  },
  scopeCheck(
    progressStore: ProgressStore,
    jobId: string,
    projectRoot: string,
    namespace: string,
    recoveryRegistry?: Pick<RecoveryRegistry, 'has'> | null,
  ): boolean {
    const status = progressStore.readStatus(jobId);
    if (!status) {
      return recoveryRegistry?.has(jobId) ?? false;
    }
    return status.projectRoot === projectRoot && status.backendNamespace === namespace;
  },
  awaitLaunch(service: Pick<ExecutionServiceLike, 'waitStream'>, jobId: string): AsyncGenerator<WaitStreamEvent> {
    return service.waitStream({ jobIds: [jobId], timeoutSeconds: 1 });
  },
  waitForTerminal(service: Pick<ExecutionServiceLike, 'waitStream'>, ...args: unknown[]): ReturnType<ExecutionServiceLike['waitStream']> {
    return service.waitStream(...(args as Parameters<ExecutionServiceLike['waitStream']>));
  },
  progress(progressStore: ProgressStore, jobId: string): JobProgressRow[] {
    return progressStore.replayFrom(jobId, 0, createReplayCursor()).filter(
      (record): record is JobProgressRow => record.type === 'progress' || record.type === 'terminal',
    );
  },
} as const;

export const jobsReconcile = {
  runStartup: createRecoveryCoordinator,
  adoptRunning<T>(fn: () => T): T {
    return fn();
  },
  recoverQueued<T>(fn: () => T): T {
    return fn();
  },
} as const;
