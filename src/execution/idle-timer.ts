import { parsePositiveInt } from './engine.js';

export const IDLE_TIMEOUT_MS = parsePositiveInt(process.env.CORAL_BACKEND_IDLE_MS, 21_600_000);

const IDLE_CHECK_INTERVAL_MS = 60_000;

export class IdleTimer {
  private inflight = 0;

  private lastActiveAt = Date.now();

  private interval: NodeJS.Timeout | null = null;

  private idleTriggered = false;

  private drainReason: string | null = null;

  private checkIdle: (() => boolean) | null = null;

  private onIdle: ((reason: string) => void) | null = null;

  beginRequest(): void {
    this.inflight += 1;
    this.lastActiveAt = Date.now();
    this.idleTriggered = false;
  }

  endRequest(): void {
    if (this.inflight > 0) this.inflight -= 1;
    if (this.inflight !== 0) return;
    this.lastActiveAt = Date.now();
    this.tryDrain();
  }

  get inflightRequests(): number {
    return this.inflight;
  }

  get isDraining(): boolean {
    return this.drainReason !== null;
  }

  /** Drain as soon as idle — skip the normal timeout wait. */
  requestDrain(reason: string): void {
    this.drainReason = reason;
    this.tryDrain();
  }

  startWatching(checkIdle: () => boolean, onIdle: (reason: string) => void): void {
    this.stopWatching();
    this.idleTriggered = false;
    this.checkIdle = checkIdle;
    this.onIdle = onIdle;

    this.interval = setInterval(() => {
      if (this.idleTriggered) return;
      if (this.inflight !== 0) return;
      if (this.drainReason === null && Date.now() - this.lastActiveAt <= IDLE_TIMEOUT_MS) return;
      if (!this.checkIdle?.()) return;

      this.idleTriggered = true;
      this.onIdle?.(this.drainReason ?? 'idle');
    }, IDLE_CHECK_INTERVAL_MS);
    this.interval.unref?.();
  }

  stopWatching(): void {
    if (this.interval === null) return;
    clearInterval(this.interval);
    this.interval = null;
    this.checkIdle = null;
    this.onIdle = null;
  }

  private tryDrain(): void {
    if (this.drainReason === null || this.idleTriggered) return;
    if (this.inflight !== 0) return;
    if (!this.checkIdle?.()) return;

    this.idleTriggered = true;
    this.onIdle?.(this.drainReason);
  }
}
