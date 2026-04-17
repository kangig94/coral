import { join } from 'node:path';
import { formatError, isNoEntryError, isRecord } from '../../shared/utils.js';
import { isLivePhase, readBackendNamespace, type PersistedStatusRecord, type TerminalResult } from '../../shared/types.js';
import type { ProgressStore } from '../progress-store.js';
import type { Runtime } from '../runtime.js';

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

export function readSessionRefs(
  shardDir: string,
  storage: Pick<Runtime['storage'], 'readdirSync' | 'readFileSync'>,
): Array<{ sessionId: string; provider: string }> {
  try {
    return storage
      .readdirSync(shardDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .flatMap((entry) => {
        try {
          const raw = storage.readFileSync(join(shardDir, entry.name), 'utf-8');
          const parsed: unknown = JSON.parse(raw);
          if (!isRecord(parsed)) return [];
          if (typeof parsed.sessionId !== 'string' || typeof parsed.provider !== 'string') return [];
          return [{ sessionId: parsed.sessionId, provider: parsed.provider }];
        } catch (error: unknown) {
          if (isNoEntryError(error) || error instanceof SyntaxError) return [];
          throw error;
        }
      });
  } catch (error: unknown) {
    if (isNoEntryError(error)) return [];
    throw error;
  }
}

export function markJobAsError(
  progressStore: ProgressStore,
  status: PersistedStatusRecord,
  notice: string,
  log: (message: string) => void,
): void {
  const terminalResult: TerminalResult =
    status.jobKind === 'workflow' ? { content: '', notice, workflow: { steps: [] } } : { content: '', notice };
  progressStore.updateLaunchState(status.jobId, 'error', notice);
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
