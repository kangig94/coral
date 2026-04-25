import {
  type JobLifecycleFault,
  type JobProgressFault,
  type TerminalOutcome,
} from '../outcome.js';
import { isLivePhase } from '../phase.js';
import type { JobLaunch, JobStatus, JobTerminalDiagnostics, JobTerminalInput } from '../records.js';
import type { ProgressStore } from '../job-store.js';
import type { ProviderTerminalEventBody } from '../../providers/contract.js';
import {
  jobRecoveryNeedsDomainEvent,
  materializeJobRecoveryFault,
  materializeProviderFailureCause,
  type RuntimeIngestOptions,
} from '../shell/fault-materializer.js';

type JobRecoveryError = JobLifecycleFault | JobProgressFault;

export function withBackendNamespace(status: JobStatus, namespace: string): JobStatus {
  return {
    ...status,
    backendNamespace: namespace,
  } as JobStatus;
}

export function listLiveJobs(progressStore: ProgressStore, namespace: string): JobStatus[] {
  const results: JobStatus[] = [];

  for (const jobId of progressStore.listJobIds()) {
    const status = progressStore.readStatus(jobId);
    if (!status || !isLivePhase(status.phase)) continue;

    const backendNamespace =
      typeof status.backendNamespace === 'string' && status.backendNamespace.length > 0
        ? status.backendNamespace
        : null;
    if (backendNamespace === namespace) {
      results.push(status);
    }
  }

  return results;
}

export function markJobAsError(
  progressStore: Pick<
    ProgressStore,
    'appendEventsWithResult' | 'appendTerminal' | 'readLaunchProjection' | 'readStatus' | 'appendLaunchRequested'
  >,
  status: JobStatus,
  fault: JobRecoveryError,
  _log: (message: string) => void,
): void {
  if (
    status.jobKind !== 'kb' &&
    jobRecoveryNeedsDomainEvent(fault) &&
    progressStore.readLaunchProjection(status.jobId) === null
  ) {
    progressStore.appendLaunchRequested(status.jobId, syntheticLaunchRecord(status));
  }

  const outcome = materializeJobRecoveryFault(progressStore, fault, {
    jobId: status.jobId,
    sessionId: status.sessionId,
  });
  const terminalResult: JobTerminalInput = { content: '', outcome };
  progressStore.appendTerminal(status.jobId, status.sessionId, terminalResult, 'error');
}

function syntheticLaunchRecord(status: JobStatus): JobLaunch {
  return {
    jobId: status.jobId,
    sessionId: status.sessionId,
    provider: status.provider,
    projectRoot: status.projectRoot,
    backendNamespace: status.backendNamespace,
    ...(status.bundleHash === undefined ? {} : { bundleHash: status.bundleHash }),
    jobKind: status.jobKind,
    pool: 'default',
    enqueueSequence: 0,
    providerAction: 'exec',
    request: {
      prompt: '',
      cwd: status.projectRoot,
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: status.updatedAt,
  };
}

export type MaterializedProviderTerminal = {
  terminal: JobTerminalInput;
  diagnostics: JobTerminalDiagnostics;
};

export function materializeProviderTerminal(
  progressStore: Pick<ProgressStore, 'appendEventsWithResult'>,
  terminal: ProviderTerminalEventBody,
  options: RuntimeIngestOptions,
): MaterializedProviderTerminal {
  const warnings = [
    ...(terminal.terminal.warnings ?? []),
    ...(terminal.diagnostics.warnings ?? []),
  ];
  return {
    terminal: {
      content: terminal.terminal.content,
      ...(terminal.terminal.durationMs === undefined ? {} : { durationMs: terminal.terminal.durationMs }),
      outcome: materializeProviderOutcome(progressStore, terminal, options),
    },
    diagnostics: {
      ...(warnings.length === 0 ? {} : { warnings }),
      ...(terminal.terminal.usage === undefined ? {} : { usage: terminal.terminal.usage }),
      ...(terminal.terminal.exitCode === undefined
        ? {}
        : { processExit: { exitCode: terminal.terminal.exitCode, signal: null } }),
    },
  };
}

function materializeProviderOutcome(
  progressStore: Pick<ProgressStore, 'appendEventsWithResult'>,
  terminal: ProviderTerminalEventBody,
  options: RuntimeIngestOptions,
): TerminalOutcome {
  const { outcome } = terminal.terminal;
  switch (outcome.kind) {
    case 'completed':
      return { kind: 'completed' };
    case 'aborted':
      return { kind: 'aborted', reason: outcome.reason };
    case 'failed':
      if (terminal.failureCause === undefined) {
        throw new Error('Provider terminal failed without a canonical failureCause.');
      }
      return materializeProviderFailureCause(progressStore, terminal.failureCause, options);
  }
}
