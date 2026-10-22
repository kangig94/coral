import type { RecoveryObservation } from '../../../recovery/phase-observation.js';
import { ZodError } from 'zod';

import { errorMessage } from '../../../infra/error-format.js';
import { StoreDecodeError } from '../../../store/body-codec.js';
import { elapsedDurationMs } from '../../../jobs/duration.js';
import { isTerminalPhase } from '../../../jobs/phase.js';
import type { JobTerminalInput } from '../../../jobs/records.js';
import { appendJobExecutionOutcomeAccepted } from '../../../jobs/terminal/recording.js';
import type { JobLifecycleFault, JobProgressFault } from '../../../jobs/outcome.js';
import type { JobStore } from '../../../jobs/store.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { JobEventBus } from '../../../jobs/event-bus.js';
import type { CommitEventsFn } from '../../../store/append.js';
import type {
  RecoveryDisposition,
  RecoveryFault,
  RecoveryReport,
  RecoverySettlementFact,
  RecoverySource,
} from '../../../recovery/containment.js';
import type { RecoveryQuarantineStore } from '../../../recovery/quarantine.js';
import type { RecoveryRetryPolicy } from '../../../recovery/source-registry.js';
import { COORDINATOR_JOB_RECOVERY_BOUNDARY } from '../../../recovery/source-registry.js';
import { COORDINATOR_TERMINAL_OBLIGATION } from './actions.js';
import type { RawCoordinatorJobRecoveryEnvelope } from './coordinator-job-source.js';
import { hydrateCoordinatorRecoveryItem, type CoordinatorRecoveryItem } from './snapshot.js';
import { runCoordinatorJobRecovery } from './startup-recovery.js';
import { InterruptedRecoveryCommitError, RecoveryOwnershipReleaseError } from './interrupted-finalizer.js';
import { appendJobRecoveryFaultTerminalInCommit } from '../terminal-materializer.js';

export type CoordinatorRecoveryControls = {
  report(message: string): void;
  setProcessLocalCleanup(cleanup: () => void): void;
  clearProcessLocalCleanup(): void;
};

export type CoordinatorWalkOptions = {
  observation?: RecoveryObservation;
  subjectKey?: string;
  signal: AbortSignal;
  coordinatorCommit: CommitEventsFn;
  summary: string;
  settle(
    item: CoordinatorRecoveryItem,
    controls: CoordinatorRecoveryControls,
  ): RecoveryDisposition | Promise<RecoveryDisposition>;
  settleFailure?(
    item: CoordinatorRecoveryItem,
    error: unknown,
    controls: CoordinatorRecoveryControls,
  ): RecoveryDisposition | Promise<RecoveryDisposition>;
};

export type CoordinatorTerminalSettlement =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'fault'; fault: JobLifecycleFault | JobProgressFault; content: string }>
  | Readonly<{ kind: 'terminal'; terminal: JobTerminalInput }>;

export type CoordinatorSettlementOptions = Readonly<{
  jobId: string;
  terminal: CoordinatorTerminalSettlement;
  coordinatorCommit: CommitEventsFn;
  nowMs: number;
}>;

class CoordinatorRecoveryCommitError extends Error {
  constructor(jobId: string, cause: unknown) {
    super(`Coordinator recovery settlement commit failed for ${jobId}.`, { cause });
    this.name = 'CoordinatorRecoveryCommitError';
  }
}

export type CoordinatorRecoveryStatus = NonNullable<CoordinatorRecoveryItem['detail']>['status'];

export type CoordinatorSettlementProvenance = Readonly<{
  fault(status: CoordinatorRecoveryStatus): Readonly<{ namespace: string }>;
  terminal(status: CoordinatorRecoveryStatus): Readonly<{ namespace: string }>;
}>;

export function settleCoordinatorRecoveryItemWithProvenance(
  item: CoordinatorRecoveryItem,
  options: CoordinatorSettlementOptions,
  provenance: CoordinatorSettlementProvenance,
): readonly RecoverySettlementFact[] {
  const { detail } = item;
  const status = detail?.status.jobId === options.jobId ? detail.status : null;
  const terminalRequired = options.terminal.kind !== 'none' && status !== null && !isTerminalPhase(status.phase);

  if (terminalRequired) {
    try {
      options.coordinatorCommit((commit) => {
        if (terminalRequired && status !== null) {
          if (options.terminal.kind === 'fault') {
            const launchCreatedAt = detail?.launch?.createdAt;
            const durationMs =
              launchCreatedAt === undefined
                ? options.terminal.fault.kind === 'missing_launch_record'
                  ? 0
                  : (() => {
                      throw new Error(
                        `Cannot record recovery terminal for ${options.jobId} without its launch record.`,
                      );
                    })()
                : elapsedDurationMs(launchCreatedAt, options.nowMs, `job ${options.jobId}`);
            appendJobRecoveryFaultTerminalInCommit(
              commit,
              options.terminal.fault,
              {
                jobId: options.jobId,
                execution: status.execution,
                namespace: provenance.fault(status).namespace,
                project: status.projectRoot,
              },
              { content: options.terminal.content, durationMs },
            );
          } else if (options.terminal.kind === 'terminal') {
            appendJobExecutionOutcomeAccepted(commit, {
              jobId: options.jobId,
              execution: status.execution,
              namespace: provenance.terminal(status).namespace,
              project: status.projectRoot,
              terminal: options.terminal.terminal,
            });
          }
        }
        return undefined;
      });
    } catch (error: unknown) {
      throw new CoordinatorRecoveryCommitError(options.jobId, error);
    }
  }

  return Object.freeze([
    Object.freeze({
      obligation: COORDINATOR_TERMINAL_OBLIGATION,
      outcome: terminalRequired ? ('done' as const) : ('not-applicable' as const),
      ...(terminalRequired ? { authorityRef: `job:${options.jobId}:terminal` } : {}),
    }),

  ]);
}

export function createRecoveryWalk(
  deps: Readonly<{
    progressStore: JobStore;
    runtime: Runtime;
    eventBus: JobEventBus;
    log(message: string): void;
    quarantine: RecoveryQuarantineStore;
    source(
      options: Readonly<{ subjectKey?: string; observation?: RecoveryObservation }>,
    ): RecoverySource<RawCoordinatorJobRecoveryEnvelope>;
    settleCoordinatorRecoveryItem(
      item: CoordinatorRecoveryItem,
      options: CoordinatorSettlementOptions,
    ): readonly RecoverySettlementFact[];
  }>,
) {
  const { progressStore, runtime, log, quarantine, source, settleCoordinatorRecoveryItem } = deps;

  const reportCoordinatorRecovery = (
    summary: string,
    report: RecoveryReport<CoordinatorRecoveryItem>,
    messages: readonly string[],
  ): void => {
    try {
      for (const message of messages) log(message);
      if (report.quarantined > 0) {
        log(`${summary}: quarantined ${report.quarantined} item(s); unaffected jobs continued.\n`);
      }
    } catch {
      // Reporting is derived output and never selects the recovery disposition.
    }
  };

  const faultDisposition = (
    fault: RecoveryFault<RawCoordinatorJobRecoveryEnvelope, CoordinatorRecoveryItem>,
  ): RecoveryDisposition => {
    if (fault.stage === 'scan' || fault.error instanceof RecoveryOwnershipReleaseError) {
      return { kind: 'fatal', error: fault.error };
    }
    return {
      kind: 'quarantine',
      detail: `${fault.stage} failed for coordinator job recovery: ${errorMessage(fault.error)}`,
    };
  };

  const createCoordinatorJobRecoveryPolicy = (
    options: CoordinatorWalkOptions,
    messages: string[],
  ): RecoveryRetryPolicy<RawCoordinatorJobRecoveryEnvelope, CoordinatorRecoveryItem> => {
    let processLocalCleanup: (() => void) | null = null;
    return {
      processLocalCleanup: {
        kind: 'boundary-required',
        release: () => {
          try {
            processLocalCleanup?.();
            return { kind: 'released' as const };
          } catch (error: unknown) {
            return { kind: 'incomplete' as const, error };
          } finally {
            processLocalCleanup = null;
          }
        },
      },
      hydrate: (raw) => hydrateCoordinatorRecoveryItem(raw, progressStore),
      requiredObligations: () => [COORDINATOR_TERMINAL_OBLIGATION],
      settle: async (item) => {
        const controls: CoordinatorRecoveryControls = {
          report: (message: string) => messages.push(message),
          setProcessLocalCleanup: (cleanup: () => void) => {
            processLocalCleanup = cleanup;
          },
          clearProcessLocalCleanup: () => {
            processLocalCleanup = null;
          },
        };
        try {
          return await options.settle(item, controls);
        } catch (error: unknown) {
          if (
            options.signal.aborted ||
            options.settleFailure === undefined ||
            error instanceof CoordinatorRecoveryCommitError ||
            error instanceof InterruptedRecoveryCommitError ||
            error instanceof RecoveryOwnershipReleaseError
          ) {
            throw error;
          }
          return options.settleFailure(item, error, controls);
        }
      },
      onFault: faultDisposition,
    };
  };

  const runCoordinatorWalk = async (
    options: CoordinatorWalkOptions,
  ): Promise<RecoveryReport<CoordinatorRecoveryItem>> => {
    const messages: string[] = [];
    const report = await runCoordinatorJobRecovery({
      source: source({
        observation: options.observation,
        ...(options.subjectKey === undefined ? {} : { subjectKey: options.subjectKey }),
      }),
      policy: {
        signal: options.signal,
        quarantine,
        ...createCoordinatorJobRecoveryPolicy(options, messages),
      },
    });
    reportCoordinatorRecovery(options.summary, report, messages);
    return report;
  };

  const deleteCoordinatorRecoveryQuarantine = (jobId: string): boolean => {
    const record = quarantine.read(COORDINATOR_JOB_RECOVERY_BOUNDARY, jobId);
    if (record === null) return true;
    return quarantine.delete({ boundary: COORDINATOR_JOB_RECOVERY_BOUNDARY, subject: record.subject });
  };

  const settleFault = (
    item: CoordinatorRecoveryItem,
    jobId: string,
    fault: JobLifecycleFault | JobProgressFault,
    coordinatorCommit: CommitEventsFn,
    content = '',
  ): readonly RecoverySettlementFact[] =>
    settleCoordinatorRecoveryItem(item, {
      jobId,
      terminal: { kind: 'fault', fault, content },
      coordinatorCommit,
      nowMs: runtime.time.now(),
    });

  const isUninterpretableRecord = (error: unknown): boolean =>
    error instanceof StoreDecodeError || error instanceof ZodError;

  const settleUnexpectedRecoveryFailure = (
    item: CoordinatorRecoveryItem,
    jobId: string,
    summary: string,
    error: unknown,
    coordinatorCommit: CommitEventsFn,
    report: (message: string) => void,
  ): RecoveryDisposition => {
    if (isUninterpretableRecord(error)) {
      report(`${summary} for ${jobId}: ${errorMessage(error)}. Left for a build that can read it.\n`);
      return { kind: 'quarantine', detail: `${summary}: record unreadable by this build` };
    }

    const facts = settleFault(
      item,
      jobId,
      {
        kind: 'recovery_parse_failed',
        cause: {
          message: `${summary}: ${errorMessage(error)}`,
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        },
      },
      coordinatorCommit,
    );
    report(`${summary} for ${jobId}: ${errorMessage(error)}.\n`);
    return { kind: 'advanced', outcome: 'settled', facts, detail: summary };
  };

  return {
    createCoordinatorJobRecoveryPolicy,
    deleteCoordinatorRecoveryQuarantine,
    runCoordinatorWalk,
    settleCoordinatorRecoveryItem,
    settleFault,
    settleUnexpectedRecoveryFailure,
  };
}
