import type { JobLaunch, JobRuntime } from '../records.js';
import { isDurableCliRuntime } from '../../runtime/durable-runtime.js';
import type { AbortResult } from '../contracts/abort-registry.js';
import type { ProcessPort } from '../../runtime/ports.js';

export interface RecoveryEntry {
  launchRecord: JobLaunch;
  runtimeRecord?: JobRuntime;
}

export class RecoveryRegistry {
  private readonly entries = new Map<string, RecoveryEntry>();
  private readonly abortHandlers = new Map<string, () => void>();

  constructor(private readonly runtimeProcess?: Pick<ProcessPort, 'kill'>) {}

  register(
    jobId: string,
    launchRecord: JobLaunch,
    runtimeRecord?: JobRuntime,
    abortHandler?: () => void,
  ): void {
    this.entries.set(jobId, { launchRecord, runtimeRecord });

    if (abortHandler) {
      this.abortHandlers.set(jobId, abortHandler);
      return;
    }

    if (!isDurableCliRuntime(runtimeRecord)) return;

    const pid = runtimeRecord.pid;
    this.abortHandlers.set(jobId, () => {
      this.runtimeProcess?.kill(pid, 'SIGTERM');
    });
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
      this.abortHandlers.get(jobId)?.();
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
