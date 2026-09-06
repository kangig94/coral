import type { AbortHoldDisposition, AbortResult, JobAbortRegistryPort } from '../contracts/abort-registry.js';
import type { IdPort } from '../../runtime/ports.js';

export class AbortRegistry implements JobAbortRegistryPort {
  private readonly ids: IdPort;
  constructor(ids: IdPort) {
    this.ids = ids;
  }

  private readonly controllers = new Map<string, AbortController>();
  private readonly holds = new Map<
    string,
    Readonly<{
      refusal: NonNullable<AbortResult['refused']>[number];
      abandon: () => AbortHoldDisposition;
    }>
  >();
  /** An abandoned job keeps its entry until its terminal phase is persisted, so a later abort must still be
   *  answered as the abandonment it already is rather than as a fresh abort that succeeded. */
  private readonly abandonments = new Map<string, NonNullable<AbortResult['abandoned']>[number]>();

  register(jobId: string = this.ids.uuid(), onAbort?: () => void): string {
    const controller = new AbortController();
    if (onAbort) {
      controller.signal.addEventListener('abort', onAbort);
    }
    this.controllers.set(jobId, controller);
    this.holds.delete(jobId);
    this.abandonments.delete(jobId);
    return jobId;
  }

  hold(jobId: string, reason: string, nextStep: string, abandon: () => AbortHoldDisposition): void {
    if (!this.controllers.has(jobId)) return;
    this.holds.set(jobId, {
      refusal: { jobId, reason, nextStep },
      abandon,
    });
  }

  releaseHold(jobId: string): void {
    this.holds.delete(jobId);
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
    const refused: NonNullable<AbortResult['refused']> = [];
    const abandoned: NonNullable<AbortResult['abandoned']> = [];
    for (const jobId of jobIds) {
      const controller = this.controllers.get(jobId);
      if (!controller) {
        notFound.push(jobId);
        continue;
      }
      const priorAbandonment = this.abandonments.get(jobId);
      if (priorAbandonment !== undefined) {
        abandoned.push(priorAbandonment);
        continue;
      }
      const heldBeforeRequest = this.holds.get(jobId);
      if (controller.signal.aborted && heldBeforeRequest !== undefined) {
        const disposition = heldBeforeRequest.abandon();
        if (disposition.kind === 'abandoned') {
          // Ownership of cleanup is what abandonment releases; the entry stays until the terminal phase is
          // persisted, because the job still has to reach one.
          this.holds.delete(jobId);
          const record = { jobId, reason: disposition.reason, nextStep: disposition.nextStep };
          this.abandonments.set(jobId, record);
          abandoned.push(record);
        } else {
          refused.push({ jobId, reason: disposition.reason, nextStep: disposition.nextStep });
        }
        continue;
      }
      controller.abort();
      const hold = this.holds.get(jobId);
      if (hold === undefined) {
        aborted.push(jobId);
      } else {
        refused.push(hold.refusal);
      }
    }
    return {
      aborted,
      notFound,
      ...(refused.length === 0 ? {} : { refused }),
      ...(abandoned.length === 0 ? {} : { abandoned }),
    };
  }

  /** Call after terminal phase is persisted. */
  remove(jobId: string): void {
    this.abandonments.delete(jobId);
    this.controllers.delete(jobId);
    this.holds.delete(jobId);
  }
}
