import type {
  AbortHoldDisposition,
  AbortNextStep,
  AbortResult,
  AbortSettledCallback,
  JobAbortRegistryPort,
} from '../contracts/abort-registry.js';

export class AbortRegistry implements JobAbortRegistryPort {
  private readonly latest = new Map<string, number>();

  private key(jobId: string, execution = this.latest.get(jobId)): string {
    return `${jobId}:${execution}`;
  }

  private readonly controllers = new Map<string, AbortController>();
  private readonly abortSettledCallbacks = new Map<string, AbortSettledCallback>();
  private readonly holds = new Map<
    string,
    Readonly<{
      refusal: NonNullable<AbortResult['refused']>[number];
      abandon: () => AbortHoldDisposition;
    }>
  >();
  /** An abandoned job must remain addressable until its terminal phase is persisted. */
  private readonly abandonments = new Map<string, NonNullable<AbortResult['abandoned']>[number]>();

  register(jobId: string, execution: number, onAbort?: () => void, onAbortSettled?: AbortSettledCallback): string {
    const key = this.key(jobId, execution);
    this.latest.set(jobId, execution);
    const controller = new AbortController();
    if (onAbort) {
      controller.signal.addEventListener('abort', onAbort);
    }
    this.controllers.set(key, controller);
    if (onAbortSettled === undefined) this.abortSettledCallbacks.delete(key);
    else this.abortSettledCallbacks.set(key, onAbortSettled);
    this.holds.delete(key);
    this.abandonments.delete(key);
    return jobId;
  }

  hold(jobId: string, reason: string, nextStep: AbortNextStep, abandon: () => AbortHoldDisposition, execution?: number): void {
    const key = this.key(jobId, execution);
    if (!this.controllers.has(key)) return;
    this.holds.set(key, {
      refusal: { jobId, reason, nextStep },
      abandon,
    });
  }

  releaseHold(jobId: string, execution?: number): void {
    const key = this.key(jobId, execution);
    this.holds.delete(key);
    if (this.controllers.get(key)?.signal.aborted === true) this.settleAbort(key);
  }

  getSignal(jobId: string, execution?: number): AbortSignal | null {
    return this.controllers.get(this.key(jobId, execution))?.signal ?? null;
  }

  has(jobId: string, execution?: number): boolean {
    return this.controllers.has(this.key(jobId, execution));
  }

  listActive(): string[] {
    return [...this.latest.keys()];
  }

  abort(jobIds: string[]): AbortResult {
    const aborted: string[] = [];
    const notFound: string[] = [];
    const refused: NonNullable<AbortResult['refused']> = [];
    const abandoned: NonNullable<AbortResult['abandoned']> = [];
    for (const jobId of jobIds) {
      const key = this.key(jobId);
      const controller = this.controllers.get(key);
      if (!controller) {
        notFound.push(jobId);
        continue;
      }
      const priorAbandonment = this.abandonments.get(key);
      if (priorAbandonment !== undefined) {
        abandoned.push(priorAbandonment);
        continue;
      }
      const heldBeforeRequest = this.holds.get(key);
      if (controller.signal.aborted && heldBeforeRequest !== undefined) {
        const disposition = heldBeforeRequest.abandon();
        if (disposition.kind === 'abandoned') {
          // Abandonment must not remove the entry before its terminal phase is persisted.
          this.holds.delete(key);
          const record = { jobId, reason: disposition.reason, nextStep: disposition.nextStep };
          this.abandonments.set(key, record);
          abandoned.push(record);
          this.settleAbort(key);
        } else {
          refused.push({ jobId, reason: disposition.reason, nextStep: disposition.nextStep });
        }
        continue;
      }
      controller.abort();
      const hold = this.holds.get(key);
      if (hold === undefined) {
        aborted.push(jobId);
        this.settleAbort(key);
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
  remove(jobId: string, execution: number): void {
    const key = this.key(jobId, execution);
    if (this.latest.get(jobId) === execution) this.latest.delete(jobId);
    this.abandonments.delete(key);
    this.abortSettledCallbacks.delete(key);
    this.controllers.delete(key);
    this.holds.delete(key);
  }

  private settleAbort(jobId: string): void {
    const callback = this.abortSettledCallbacks.get(jobId);
    if (callback === undefined) return;
    this.abortSettledCallbacks.delete(jobId);
    callback();
  }
}
