import { formatError } from '../../shared/utils.js';
import {
  describeJobProgressFault,
  describeTerminalOutcome,
  type JobLifecycleFault,
  type JobProgressFault,
  type TerminalOutcome,
} from '../outcome.js';
import { isLivePhase } from '../phase.js';
import type { JobLaunch, JobStatus, JobTerminal } from '../views.js';
import type { ProgressStore } from '../job-store.js';
import type { ProviderTerminalEventBody } from '../../providers/contract.js';
import {
  jobRecoveryNeedsDomainEvent,
  materializeJobRecoveryFault,
  materializeProviderFault,
  type RuntimeIngestOptions,
} from '../shell/legacy-ingest.js';

type JobRecoveryError = JobLifecycleFault | JobProgressFault;

function describeJobRecoveryError(fault: JobRecoveryError): string {
  switch (fault.kind) {
    case 'stale_status_schema':
    case 'recovery_parse_failed':
      return describeJobProgressFault(fault);
    case 'ghost_launch':
    case 'wrapper_lost':
    case 'wrapper_crashed':
      return describeTerminalOutcome({ kind: 'job_fault', fault });
  }
}

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
    if (backendNamespace === null) {
      const rewritten = withBackendNamespace(status, namespace);
      progressStore.writeStatus(jobId, rewritten);
      results.push(rewritten);
      continue;
    }

    if (backendNamespace === namespace) {
      results.push(status);
    }
  }

  return results;
}

export function markJobAsError(
  progressStore: Pick<
    ProgressStore,
    'appendEventsWithResult' | 'appendTerminal' | 'hasLaunchRecord' | 'markTerminalStatus' | 'readStatus'
    | 'updateLaunchState' | 'writeLaunchRecord' | 'writeStatus' | 'writeWorkflowResultMdOrThrow'
  >,
  status: JobStatus,
  fault: JobRecoveryError,
  log: (message: string) => void,
): void {
  if (jobRecoveryNeedsDomainEvent(fault) && !progressStore.hasLaunchRecord(status.jobId)) {
    progressStore.writeLaunchRecord(status.jobId, syntheticLaunchRecord(status));
  }

  const outcome = materializeJobRecoveryFault(progressStore, fault, {
    jobId: status.jobId,
    sessionId: status.sessionId,
  });
  const message = describeJobRecoveryError(fault);
  const terminalResult: JobTerminal =
    status.jobKind === 'workflow'
      ? { content: '', workflow: { steps: [] }, outcome }
      : { content: '', outcome };
  progressStore.updateLaunchState(status.jobId, 'error', message);
  if (status.jobKind === 'workflow') {
    try {
      progressStore.writeWorkflowResultMdOrThrow(status.jobId, '');
    } catch (err) {
      log(`Failed to write workflow result for ${status.jobId}: ${formatError(err)}\n`);
    }
  }
  if (!progressStore.hasLaunchRecord(status.jobId)) {
    progressStore.updateLaunchState(status.jobId, 'error', message);
    const current = progressStore.readStatus(status.jobId) ?? status;
    progressStore.writeStatus(status.jobId, {
      ...current,
      phase: 'error',
      result: terminalResult,
    });
    return;
  }
  try {
    progressStore.appendTerminal(status.jobId, status.sessionId, terminalResult, 'error');
  } catch {
    progressStore.markTerminalStatus(status.jobId, terminalResult, 'error');
  }
}

function syntheticLaunchRecord(status: JobStatus): JobLaunch {
  return {
    jobId: status.jobId,
    sessionId: status.sessionId,
    provider: status.provider,
    projectRoot: status.projectRoot,
    backendNamespace: status.backendNamespace,
    ...(status.bundleHash === undefined ? {} : { bundleHash: status.bundleHash }),
    jobKind: status.jobKind ?? 'provider',
    pool: 'default',
    enqueueSequence: 0,
    providerAction: 'exec',
    request: {
      prompt: '',
      cwd: status.projectRoot,
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: status.launch.updatedAt,
  };
}

export function materializeProviderTerminal(
  progressStore: Pick<ProgressStore, 'appendEventsWithResult'>,
  terminal: ProviderTerminalEventBody,
  options: RuntimeIngestOptions,
): JobTerminal {
  return {
    content: terminal.terminal.content,
    ...(terminal.terminal.durationMs === undefined ? {} : { durationMs: terminal.terminal.durationMs }),
    ...(terminal.terminal.exitCode === undefined ? {} : { exitCode: terminal.terminal.exitCode }),
    ...(terminal.terminal.warnings === undefined ? {} : { warnings: terminal.terminal.warnings }),
    ...(terminal.terminal.usage === undefined ? {} : { usage: terminal.terminal.usage }),
    outcome: materializeProviderOutcome(progressStore, terminal.terminal.outcome, options),
  };
}

function materializeProviderOutcome(
  progressStore: Pick<ProgressStore, 'appendEventsWithResult'>,
  outcome: ProviderTerminalEventBody['terminal']['outcome'],
  options: RuntimeIngestOptions,
): TerminalOutcome {
  switch (outcome.kind) {
    case 'completed':
      return { kind: 'completed' };
    case 'aborted':
      return { kind: 'aborted', reason: outcome.reason };
    case 'failed':
      return materializeProviderFault(progressStore, outcome.fault, options);
  }
}
