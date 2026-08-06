const monotonicClockBrand: unique symbol = Symbol('coral.monotonic-clock');
const monotonicInstantBrand: unique symbol = Symbol('coral.monotonic-instant');

type MonotonicInstantRecord = {
  readonly scope: symbol;
  readonly milliseconds: bigint;
};

const monotonicInstantRecords = new WeakMap<object, MonotonicInstantRecord>();

/** A process-local instant that cannot be serialized or compared outside its owning clock. */
export type MonotonicInstant<Scope extends symbol> = Readonly<{
  [monotonicInstantBrand]: Scope;
  [Symbol.toPrimitive](): never;
  toJSON(): never;
}>;

/** Arbitrary-origin non-decreasing elapsed time with deliberately unspecified suspend behavior. */
export type MonotonicClock<Scope extends symbol> = Readonly<{
  [monotonicClockBrand]: Scope;
  now(): MonotonicInstant<Scope>;
  sleep(milliseconds: number): Promise<void>;
  shiftMilliseconds(instant: MonotonicInstant<Scope>, milliseconds: number): MonotonicInstant<Scope>;
  earlier(left: MonotonicInstant<Scope>, right: MonotonicInstant<Scope>): MonotonicInstant<Scope>;
  compare(left: MonotonicInstant<Scope>, right: MonotonicInstant<Scope>): -1 | 0 | 1;
  millisecondsBetween(from: MonotonicInstant<Scope>, to: MonotonicInstant<Scope>): number;
}>;

function defaultReadMilliseconds(): bigint {
  return process.hrtime.bigint() / 1_000_000n;
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function assertSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${field} must be a safe integer.`);
  }
}

function createInstant<Scope extends symbol>(scope: Scope, milliseconds: bigint): MonotonicInstant<Scope> {
  const instant = Object.create(null) as MonotonicInstant<Scope>;
  Object.defineProperties(instant, {
    [Symbol.toPrimitive]: {
      value: (): never => {
        throw new Error('A monotonic instant cannot be converted to a primitive value.');
      },
    },
    toJSON: {
      value: (): never => {
        throw new Error('A monotonic instant cannot be serialized.');
      },
    },
  });
  monotonicInstantRecords.set(instant, { scope, milliseconds });
  return Object.freeze(instant);
}

export function createMonotonicClock<Scope extends symbol>(
  scope: Scope,
  options: {
    readonly readMilliseconds?: () => bigint;
    readonly sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): MonotonicClock<Scope> {
  const readMilliseconds = options.readMilliseconds ?? defaultReadMilliseconds;
  const sleep = options.sleep ?? defaultSleep;
  let lastRead: bigint | null = null;

  const ownedMilliseconds = (instant: MonotonicInstant<Scope>): bigint => {
    const record = monotonicInstantRecords.get(instant);
    if (record === undefined || record.scope !== scope) {
      throw new Error('A monotonic instant belongs to a different clock.');
    }
    return record.milliseconds;
  };

  const clock = {
    now: (): MonotonicInstant<Scope> => {
      const milliseconds = readMilliseconds();
      if (lastRead !== null && milliseconds < lastRead) {
        throw new Error('A monotonic clock cannot move backward.');
      }
      lastRead = milliseconds;
      return createInstant(scope, milliseconds);
    },
    sleep: async (milliseconds: number): Promise<void> => {
      assertSafeInteger(milliseconds, 'Monotonic sleep duration');
      if (milliseconds < 0) throw new Error('Monotonic sleep duration must not be negative.');
      await sleep(milliseconds);
    },
    shiftMilliseconds: (instant: MonotonicInstant<Scope>, milliseconds: number): MonotonicInstant<Scope> => {
      assertSafeInteger(milliseconds, 'Monotonic duration');
      return createInstant(scope, ownedMilliseconds(instant) + BigInt(milliseconds));
    },
    earlier: (left: MonotonicInstant<Scope>, right: MonotonicInstant<Scope>): MonotonicInstant<Scope> =>
      ownedMilliseconds(left) <= ownedMilliseconds(right) ? left : right,
    compare: (left: MonotonicInstant<Scope>, right: MonotonicInstant<Scope>): -1 | 0 | 1 => {
      const leftMilliseconds = ownedMilliseconds(left);
      const rightMilliseconds = ownedMilliseconds(right);
      if (leftMilliseconds < rightMilliseconds) return -1;
      if (leftMilliseconds > rightMilliseconds) return 1;
      return 0;
    },
    millisecondsBetween: (from: MonotonicInstant<Scope>, to: MonotonicInstant<Scope>): number => {
      const difference = ownedMilliseconds(to) - ownedMilliseconds(from);
      const milliseconds = Number(difference);
      assertSafeInteger(milliseconds, 'Monotonic elapsed duration');
      return milliseconds;
    },
  };

  Object.defineProperty(clock, monotonicClockBrand, { value: scope });
  return Object.freeze(clock) as MonotonicClock<Scope>;
}
