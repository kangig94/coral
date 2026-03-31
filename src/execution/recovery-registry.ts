import { isDurableCliRuntime, type PersistedLaunchRecord, type PersistedRuntimeRecord } from '../shared/types.js';
import type { AbortResult } from './abort-registry.js';

export interface RecoveryEntry {
  launchRecord: PersistedLaunchRecord;
  runtimeRecord?: PersistedRuntimeRecord;
}

/**
 * Temporary registry for recoverable jobs during the post-listen, pre-adoption window.
 * Installed at startup after listen(), dissolved after all entries are migrated to ExecutionService.
 *
 * Provides scope visibility so wait/list/detail/abort succeed before namespace rebinding completes.
 */
export class RecoveryRegistry {
  private readonly entries = new Map<string, RecoveryEntry>();
  private readonly abortHandlers = new Map<string, () => void>();

  register(
    jobId: string,
    launchRecord: PersistedLaunchRecord,
    runtimeRecord?: PersistedRuntimeRecord,
    abortHandler?: () => void,
  ): void {
    this.entries.set(jobId, { launchRecord, runtimeRecord });

    if (abortHandler) {
      this.abortHandlers.set(jobId, abortHandler);
      return;
    }

    // Install abort delegate: queued → noop (cancel handled by service after adoption),
    // running → kill PID from runtimeRecord
    if (isDurableCliRuntime(runtimeRecord)) {
      const pid = runtimeRecord.pid;
      this.abortHandlers.set(jobId, () => {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* pid already exited */
        }
      });
    }
  }

  has(jobId: string): boolean {
    return this.entries.has(jobId);
  }

  get(jobId: string): RecoveryEntry | undefined {
    return this.entries.get(jobId);
  }

  abort(jobIds: string[]): AbortResult {
    const aborted: string[] = [];
    const notFound: string[] = [];
    for (const jobId of jobIds) {
      if (!this.entries.has(jobId)) {
        notFound.push(jobId);
        continue;
      }
      const handler = this.abortHandlers.get(jobId);
      if (handler) handler();
      aborted.push(jobId);
    }
    return { aborted, notFound };
  }

  remove(jobId: string): void {
    this.entries.delete(jobId);
    this.abortHandlers.delete(jobId);
  }

  [Symbol.iterator](): IterableIterator<[string, RecoveryEntry]> {
    return this.entries.entries();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Get all entries grouped by projectRoot. */
  entriesByProject(): Map<string, RecoveryEntry[]> {
    const byProject = new Map<string, RecoveryEntry[]>();
    for (const [, entry] of this.entries) {
      const key = entry.launchRecord.projectRoot;
      const list = byProject.get(key) ?? [];
      list.push(entry);
      byProject.set(key, list);
    }
    return byProject;
  }
}
