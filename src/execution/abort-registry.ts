import { randomUUID } from 'node:crypto';

export type AbortResult = {
  aborted: string[];
  notFound: string[];
};

export class AbortRegistry {
  private readonly controllers = new Map<string, AbortController>();

  register(jobId: string = randomUUID(), onAbort?: () => void): string {
    const controller = new AbortController();
    if (onAbort) {
      controller.signal.addEventListener('abort', onAbort);
    }
    this.controllers.set(jobId, controller);
    return jobId;
  }

  getSignal(jobId: string): AbortSignal | null {
    return this.controllers.get(jobId)?.signal ?? null;
  }

  has(jobId: string): boolean {
    return this.controllers.has(jobId);
  }

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
