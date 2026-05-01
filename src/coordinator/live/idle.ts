import type { TimePort } from '../../runtime/ports.js';
import { parsePositiveInt } from './worker-limits.js';

export const DEFAULT_IDLE_TIMEOUT_MS = 21_600_000;
const IDLE_CHECK_INTERVAL_MS = 60_000;

export function resolveIdleTimeoutMs(raw: string | undefined): number {
  return parsePositiveInt(raw, DEFAULT_IDLE_TIMEOUT_MS);
}

export class IdleTimer {
  private readonly time: TimePort;
  private readonly idleTimeoutMs: number;
  private inflight = 0;
  private lastActiveAt: number;
  private interval: ReturnType<TimePort['setInterval']> | null = null;
  private idleTriggered = false;
  private drainReason: string | null = null;
  private checkIdle: (() => boolean) | null = null;
  private onIdle: ((reason: string) => void) | null = null;

  constructor(options: { time: TimePort; timeoutMs?: number }) {
    this.time = options.time;
    this.idleTimeoutMs = options.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.lastActiveAt = this.time.now();
  }

  beginRequest(): void {
    this.inflight += 1;
    this.lastActiveAt = this.time.now();
    this.idleTriggered = false;
  }

  endRequest(): void {
    if (this.inflight > 0) this.inflight -= 1;
    if (this.inflight !== 0) return;
    this.lastActiveAt = this.time.now();
    this.tryDrain();
  }

  get inflightRequests(): number {
    return this.inflight;
  }

  get isDraining(): boolean {
    return this.drainReason !== null;
  }

  requestDrain(reason: string): void {
    this.drainReason = reason;
    this.tryDrain();
  }

  startWatching(checkIdle: () => boolean, onIdle: (reason: string) => void): void {
    this.stopWatching();
    this.idleTriggered = false;
    this.checkIdle = checkIdle;
    this.onIdle = onIdle;

    this.interval = this.time.setInterval(() => {
      if (this.idleTriggered) return;
      if (this.inflight !== 0) return;
      if (this.drainReason === null && this.time.now() - this.lastActiveAt <= this.idleTimeoutMs) return;
      if (!this.checkIdle?.()) return;

      this.idleTriggered = true;
      this.onIdle?.(this.drainReason ?? 'idle');
    }, IDLE_CHECK_INTERVAL_MS);
    this.interval.unref?.();
    this.tryDrain();
  }

  stopWatching(): void {
    if (this.interval === null) return;
    this.time.clearInterval(this.interval);
    this.interval = null;
    this.checkIdle = null;
    this.onIdle = null;
  }

  private tryDrain(): void {
    if (this.drainReason === null || this.idleTriggered) return;
    if (this.inflight !== 0) return;

    // Explicit drain requests should not wait on the passive idle predicate.
    this.idleTriggered = true;
    this.onIdle?.(this.drainReason);
  }
}
