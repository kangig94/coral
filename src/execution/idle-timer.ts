import { parsePositiveInt } from './engine.js';

export const IDLE_TIMEOUT_MS = parsePositiveInt(process.env.CORAL_BACKEND_IDLE_MS, 21_600_000);

const IDLE_CHECK_INTERVAL_MS = 1_000;

export class IdleTimer {
  private inflight = 0;

  private lastActiveAt = Date.now();

  private interval: NodeJS.Timeout | null = null;

  private idleTriggered = false;

  beginRequest(): void {
    this.inflight += 1;
    this.lastActiveAt = Date.now();
    this.idleTriggered = false;
  }

  endRequest(): void {
    if (this.inflight > 0) this.inflight -= 1;
    if (this.inflight !== 0) return;
    this.lastActiveAt = Date.now();
  }

  get inflightRequests(): number {
    return this.inflight;
  }

  startWatching(checkIdle: () => boolean, onIdle: () => void): void {
    this.stopWatching();
    this.idleTriggered = false;

    this.interval = setInterval(() => {
      if (this.idleTriggered) return;
      if (this.inflight !== 0) return;
      if (Date.now() - this.lastActiveAt <= IDLE_TIMEOUT_MS) return;
      if (!checkIdle()) return;

      this.idleTriggered = true;
      onIdle();
    }, IDLE_CHECK_INTERVAL_MS);
    this.interval.unref?.();
  }

  stopWatching(): void {
    if (this.interval === null) return;
    clearInterval(this.interval);
    this.interval = null;
  }
}
