import type { AbortResult, JobAbortRegistryPort } from '../contracts/abort-registry.js';
import type { IdPort } from '../../runtime/ports.js';

export class AbortRegistry implements JobAbortRegistryPort {
  private readonly ids: IdPort;
  constructor(ids: IdPort) {
    this.ids = ids;
  }

  private readonly controllers = new Map<string, AbortController>();

  register(jobId: string = this.ids.uuid(), onAbort?: () => void): string {
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

  listActive(): string[] {
    return [...this.controllers.keys()];
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

  /** Call after terminal phase is persisted. */
  remove(jobId: string): void {
    this.controllers.delete(jobId);
  }
}
