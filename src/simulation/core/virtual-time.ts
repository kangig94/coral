import type { RuntimeTimerHandle, TimePort } from '../../runtime/ports.js';

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

class TimerHeap {
  private readonly records: TimerRecord[] = [];

  push(record: TimerRecord): void {
    this.records.push(record);
    this.bubbleUp(this.records.length - 1);
  }

  peek(): TimerRecord | undefined {
    return this.records[0];
  }

  pop(): TimerRecord | undefined {
    const first = this.records[0];
    const last = this.records.pop();
    if (last && this.records.length > 0) {
      this.records[0] = last;
      this.bubbleDown(0);
    }
    return first;
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareTimers(this.records[parent], this.records[index]) <= 0) {
        return;
      }
      [this.records[parent], this.records[index]] = [this.records[index], this.records[parent]];
      index = parent;
    }
  }

  private bubbleDown(index: number): void {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.records.length && compareTimers(this.records[left], this.records[smallest]) < 0) {
        smallest = left;
      }
      if (right < this.records.length && compareTimers(this.records[right], this.records[smallest]) < 0) {
        smallest = right;
      }
      if (smallest === index) {
        return;
      }
      [this.records[index], this.records[smallest]] = [this.records[smallest], this.records[index]];
      index = smallest;
    }
  }
}

function compareTimers(left: TimerRecord, right: TimerRecord): number {
  return left.deadline - right.deadline || left.order - right.order;
}

export class VirtualTimerHandle implements RuntimeTimerHandle {
  constructor(readonly id: number) {}

  unref(): void {}
}

export class VirtualTime implements TimePort {
  private currentTime: number;
  private readonly timers = new Map<number, TimerRecord>();
  private readonly timerHeap = new TimerHeap();
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
        this.timerHeap.push(next);
      } else {
        this.timers.delete(next.handle.id);
      }
    }
  }

  private schedule(fn: () => void, ms: number, intervalMs: number | null): RuntimeTimerHandle {
    const delay = Math.max(1, Math.floor(ms));
    const handle = new VirtualTimerHandle(this.nextId++);
    const record = {
      handle,
      deadline: this.currentTime + delay,
      fn,
      intervalMs,
      order: this.nextOrder++,
      active: true,
    };
    this.timers.set(handle.id, record);
    this.timerHeap.push(record);
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
    while (true) {
      const next = this.timerHeap.peek();
      if (!next) {
        return null;
      }
      if (!next.active) {
        this.timerHeap.pop();
        this.timers.delete(next.handle.id);
        continue;
      }
      if (next.deadline > target) {
        return null;
      }
      return this.timerHeap.pop() ?? null;
    }
  }
}

export function flushMicrotasks(rounds = 4): Promise<void> {
  let chain = Promise.resolve();
  for (let index = 0; index < rounds; index += 1) {
    chain = chain.then(() => undefined);
  }
  return chain;
}
