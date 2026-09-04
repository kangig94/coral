import type { JobLaunch, JobRuntime } from '../records.js';
import type { AbortResult } from '../contracts/abort-registry.js';
import type { RecordedContainmentAbortResult } from '../../infra/process-containment.js';

export interface RecoveryEntry {
  launchRecord: JobLaunch;
  runtimeRecord?: JobRuntime;
}

export class RecoveryRegistry {
  private readonly entries = new Map<string, RecoveryEntry>();
  private readonly abortHandlers = new Map<string, () => RecordedContainmentAbortResult>();
  private readonly cancelledJobIds: Set<string>;

  constructor(cancelledJobIds: Set<string> = new Set()) {
    this.cancelledJobIds = cancelledJobIds;
  }

  register(
    jobId: string,
    launchRecord: JobLaunch,
    runtimeRecord?: JobRuntime,
    abortHandler?: () => RecordedContainmentAbortResult,
  ): void {
    this.entries.set(jobId, { launchRecord, runtimeRecord });

    if (abortHandler) {
      this.abortHandlers.set(jobId, abortHandler);
      return;
    }
    this.abortHandlers.delete(jobId);
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
      const entry = this.entries.get(jobId);
      if (!entry) {
        notFound.push(jobId);
        continue;
      }
      const abortHandler = this.abortHandlers.get(jobId);
      if (!abortHandler && entry.runtimeRecord !== undefined) {
        notFound.push(jobId);
        continue;
      }
      const disposition = abortHandler?.() ?? { kind: 'accepted' as const };
      if (disposition.kind === 'refused') {
        notFound.push(jobId);
        continue;
      }
      this.cancelledJobIds.add(jobId);
      this.remove(jobId);
      aborted.push(jobId);
    }
    return { aborted, notFound };
  }

  markCancelled(jobId: string): void {
    this.cancelledJobIds.add(jobId);
  }

  clearCancelled(jobId: string): void {
    this.cancelledJobIds.delete(jobId);
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

  entriesByProject(): Map<string, RecoveryEntry[]> {
    const byProject = new Map<string, RecoveryEntry[]>();
    for (const [, entry] of this.entries) {
      const key = entry.launchRecord.projectRoot;
      const existing = byProject.get(key);
      if (existing) {
        existing.push(entry);
      } else {
        byProject.set(key, [entry]);
      }
    }
    return byProject;
  }
}
