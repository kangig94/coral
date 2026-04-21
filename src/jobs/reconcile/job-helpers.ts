import {
  describeLegacyCoralFault,
  type LegacyCoralFault,
  type LegacyTerminalOutcome,
  type RecoveryFaultCompat,
} from '../../shared/legacy-terminal-outcome-compat.js';
import { formatError } from '../../shared/utils.js';
import { isLivePhase } from '../phase.js';
import type { JobLaunch, JobStatus, JobTerminal } from '../views.js';
import type { ProgressStore } from '../job-store.js';
import { materializeLegacyTerminalOutcome, planLegacyTerminalOutcome } from '../shell/legacy-ingest.js';
import type { LegacyIngestOptions } from '../shell/legacy-ingest.js';
import type { ProviderTerminalEventBody } from '../../providers/protocol.js';
import type { FaultPayload } from '../../providers/fault.js';
import type { TerminalOutcome } from '../outcome.js';

export function faultPayloadToLegacyFault(fault: FaultPayload): LegacyCoralFault {
  switch (fault.kind) {
    case 'adapter_output_unparseable':
      return {
        kind: 'adapter_output_unparseable' as const,
        provider: fault.provider === 'claude' ? 'claude' : 'codex',
        exitCode: fault.exitCode,
        stdout: fault.stdout,
        stderr: fault.stderr,
        parseError: fault.parseError,
      };
    case 'provider_session_unavailable':
      return {
        kind: 'provider_session_unavailable' as const,
        provider: fault.provider === 'claude' ? 'claude' : 'codex',
        note: fault.reason,
      };
    case 'provider_request_failed':
      return {
        kind: 'provider_request_failed' as const,
        provider: fault.provider === 'claude' ? 'claude' : 'codex',
        message: fault.message,
      };
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
  progressStore: ProgressStore,
  status: JobStatus,
  fault: RecoveryFaultCompat,
  log: (message: string) => void,
): void {
  const legacyOutcome: LegacyTerminalOutcome = { kind: 'legacy_fault', fault };
  const plan = planLegacyTerminalOutcome(legacyOutcome, {
    jobId: status.jobId,
    sessionId: status.sessionId,
  });
  if (plan.immediateOutcome === null && !progressStore.hasLaunchRecord(status.jobId)) {
    progressStore.writeLaunchRecord(status.jobId, syntheticLaunchRecord(status));
  }
  const outcome = materializeLegacyOutcome(progressStore, legacyOutcome, {
    jobId: status.jobId,
    sessionId: status.sessionId,
  });
  const message = describeLegacyCoralFault(fault);
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

export function materializeLegacyOutcome(
  progressStore: Pick<ProgressStore, 'appendEventsWithResult'>,
  outcome: LegacyTerminalOutcome,
  options: LegacyIngestOptions,
): TerminalOutcome {
  const plan = planLegacyTerminalOutcome(outcome, options);
  if (plan.immediateOutcome !== null) {
    return plan.immediateOutcome;
  }

  const appended = progressStore.appendEventsWithResult(plan.domainEvents);
  return materializeLegacyTerminalOutcome(plan, appended);
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
  options: LegacyIngestOptions,
): JobTerminal {
  return {
    content: terminal.content,
    durationMs: terminal.durationMs,
    nonResumable: terminal.nonResumable,
    exitCode: terminal.exitCode,
    warnings: terminal.warnings,
    usage: terminal.usage,
    outcome: materializeLegacyOutcome(progressStore, terminal.outcome, options),
  };
}
