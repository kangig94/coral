import { randomUUID } from 'node:crypto';

export type AbortResult = {
  aborted: string[];
  notFound: string[];
};

export class AbortRegistry {
  private readonly controllers = new Map<string, AbortController>();

  /** Register a new job and return its AbortSignal. */
  register(jobId: string = randomUUID()): string {
    this.controllers.set(jobId, new AbortController());
    return jobId;
  }

  /** Get signal for a job. Returns null if not registered. */
  getSignal(jobId: string): AbortSignal | null {
    return this.controllers.get(jobId)?.signal ?? null;
  }

  /** Returns true if the job is registered (in-flight). */
  has(jobId: string): boolean {
    return this.controllers.has(jobId);
  }

  /** Abort specific jobs. Returns which were found and aborted vs not found. */
  abort(jobIds: string[]): AbortResult {
    const aborted: string[] = [];
    const notFound: string[] = [];
    for (const jobId of jobIds) {
      const controller = this.controllers.get(jobId);
      if (!controller) {
        notFound.push(jobId);
        continue;
      }
      controller.abort();
      aborted.push(jobId);
    }
    return { aborted, notFound };
  }

  /** Remove a completed job. Call after terminal phase is persisted. */
  remove(jobId: string): void {
    this.controllers.delete(jobId);
  }
}
