import { describeLegacyCoralFault, type LegacyCoralFault } from '../../shared/legacy-terminal-outcome-compat.js';
import { formatError } from '../../shared/utils.js';
import { isLivePhase, readBackendNamespace, type PersistedStatusRecord, type TerminalResult } from '../../shared/types.js';
import type { ProgressStore } from '../../execution/progress-store.js';
import { materializeLegacyTerminalOutcome, planLegacyTerminalOutcome } from '../shell/legacy-ingest.js';

export function withBackendNamespace(status: PersistedStatusRecord, namespace: string): PersistedStatusRecord {
  return {
    ...status,
    backendNamespace: namespace,
  } as PersistedStatusRecord;
}

export function listLiveJobs(progressStore: ProgressStore, namespace: string): PersistedStatusRecord[] {
  const results: PersistedStatusRecord[] = [];

  for (const jobId of progressStore.listJobIds()) {
    const status = progressStore.readStatus(jobId);
    if (!status || !isLivePhase(status.phase)) continue;

    const backendNamespace = readBackendNamespace(status);
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
  status: PersistedStatusRecord,
  fault: LegacyCoralFault,
  log: (message: string) => void,
): void {
  const outcome = materializeLegacyTerminalOutcome(
    planLegacyTerminalOutcome({ kind: 'legacy_fault', fault }, { jobId: status.jobId, sessionId: status.sessionId }),
    [{ seq: 1, stream: { kind: 'job', id: status.jobId } }],
  );
  const message = describeLegacyCoralFault(fault);
  const terminalResult: TerminalResult =
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
  try {
    progressStore.appendTerminal(status.jobId, status.sessionId, terminalResult, 'error');
  } catch {
    progressStore.markTerminalStatus(status.jobId, terminalResult, 'error');
  }
}
