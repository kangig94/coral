import type { RuntimeTimerHandle, RuntimeTime } from '../../runtime.js';

export const DEFAULT_EPOCH_MS = 1_000_000;

function assertFiniteNonNegative(ms: number, label: string): void {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError(`${label} must be a finite non-negative number, got ${ms}`);
  }
}

type TimerRecord = {
  handle: VirtualTimerHandle;
  deadline: number;
  fn: () => void;
  intervalMs: number | null;
  order: number;
  active: boolean;
};

export class VirtualTimerHandle implements RuntimeTimerHandle {
  constructor(readonly id: number) {}

  unref(): void {}
}

export class VirtualTime implements RuntimeTime {
  private currentTime: number;
  private readonly timers = new Map<number, TimerRecord>();
  private nextId = 1;
  private nextOrder = 1;

  constructor(epochMs = DEFAULT_EPOCH_MS) {
    this.currentTime = epochMs;
  }

  now(): number {
    return this.currentTime;
  }

  sleep(ms: number): Promise<void> {
    assertFiniteNonNegative(ms, 'sleep(ms)');
    return new Promise<void>((resolve) => {
      this.setTimeout(resolve, ms);
    });
  }

  setTimeout(fn: () => void, ms: number): RuntimeTimerHandle {
    assertFiniteNonNegative(ms, 'setTimeout(ms)');
    return this.schedule(fn, ms, null);
  }

  clearTimeout(handle: RuntimeTimerHandle | null): void {
    this.clear(handle);
  }

  setInterval(fn: () => void, ms: number): RuntimeTimerHandle {
    assertFiniteNonNegative(ms, 'setInterval(ms)');
    const delay = Math.max(1, Math.floor(ms));
    return this.schedule(fn, delay, delay);
  }

  clearInterval(handle: RuntimeTimerHandle | null): void {
    this.clear(handle);
  }

  tick(ms: number): void {
    assertFiniteNonNegative(ms, 'tick(ms)');
    const delta = Math.max(0, Math.floor(ms));
    const target = this.currentTime + delta;
    let capturedError: unknown;
    let hasCapturedError = false;

    while (true) {
      const next = this.nextDueTimer(target);
      if (!next) {
        this.currentTime = target;
        if (hasCapturedError) {
          throw capturedError;
        }
        return;
      }

      this.currentTime = next.deadline;
      if (!next.active) {
        this.timers.delete(next.handle.id);
        continue;
      }

      if (next.intervalMs === null) {
        next.active = false;
        this.timers.delete(next.handle.id);
      }

      try {
        next.fn();
      } catch (error) {
        if (!hasCapturedError) {
          capturedError = error;
          hasCapturedError = true;
        }
      }

      if (next.intervalMs !== null && next.active) {
        next.deadline += next.intervalMs;
        next.order = this.nextOrder++;
      } else {
        this.timers.delete(next.handle.id);
      }
    }
  }

  private schedule(fn: () => void, ms: number, intervalMs: number | null): RuntimeTimerHandle {
    const delay = Math.max(1, Math.floor(ms));
    const handle = new VirtualTimerHandle(this.nextId++);
    this.timers.set(handle.id, {
      handle,
      deadline: this.currentTime + delay,
      fn,
      intervalMs,
      order: this.nextOrder++,
      active: true,
    });
    return handle;
  }

  private clear(handle: RuntimeTimerHandle | null): void {
    if (!(handle instanceof VirtualTimerHandle)) {
      return;
    }
    const record = this.timers.get(handle.id);
    if (!record) {
      return;
    }
    record.active = false;
    this.timers.delete(handle.id);
  }

  private nextDueTimer(target: number): TimerRecord | null {
    let next: TimerRecord | null = null;
    for (const record of this.timers.values()) {
      if (!record.active || record.deadline > target) {
        continue;
      }
      if (
        next === null ||
        record.deadline < next.deadline ||
        (record.deadline === next.deadline && record.order < next.order)
      ) {
        next = record;
      }
    }
    return next;
  }
}

export function flushMicrotasks(rounds = 4): Promise<void> {
  let chain = Promise.resolve();
  for (let index = 0; index < rounds; index += 1) {
    chain = chain.then(() => undefined);
  }
  return chain;
}
