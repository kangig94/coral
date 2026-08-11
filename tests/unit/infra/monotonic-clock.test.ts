import { describe, expect, expectTypeOf, it } from 'vitest';

import { createMonotonicClock, type MonotonicClock, type MonotonicInstant } from '#src/infra/monotonic-clock.js';
import type { TimePort } from '#src/infra/port-types.js';

describe('monotonic clock', () => {
  it('keeps instants opaque while exposing exact elapsed arithmetic', () => {
    const scope = Symbol('exact-clock');
    let elapsedMs = 1_000n;
    const clock = createMonotonicClock(scope, { readMilliseconds: () => elapsedMs });
    const start = clock.now();
    elapsedMs = 1_125n;
    const end = clock.now();

    expect(clock.millisecondsBetween(start, end)).toBe(125);
    expect(clock.compare(clock.shiftMilliseconds(start, 125), end)).toBe(0);
    expect(clock.earlier(end, start)).toBe(start);
    expect(() => JSON.stringify({ start })).toThrow('cannot be serialized');
    expect(() => Number(start)).toThrow('cannot be converted');
  });

  it('rejects a regressing injected source', () => {
    const scope = Symbol('regressing-clock');
    let elapsedMs = 2n;
    const clock = createMonotonicClock(scope, { readMilliseconds: () => elapsedMs });

    clock.now();
    elapsedMs = 1n;

    expect(() => clock.now()).toThrow('cannot move backward');
  });

  it('rejects arithmetic across independently scoped process clocks', () => {
    const guardianScope = Symbol('guardian-clock');
    const reaperScope = Symbol('reaper-clock');
    const guardianClock = createMonotonicClock(guardianScope, { readMilliseconds: () => 100n });
    const reaperClock = createMonotonicClock(reaperScope, { readMilliseconds: () => 100n });
    const guardianNow = guardianClock.now();
    const reaperNow = reaperClock.now();

    expectTypeOf(guardianNow).not.toMatchTypeOf(reaperNow);
    expect(() =>
      guardianClock.compare(guardianNow, reaperNow as unknown as MonotonicInstant<typeof guardianScope>),
    ).toThrow('different clock');
  });

  it('cannot be substituted with the wall-clock TimePort shape', () => {
    expectTypeOf<Pick<TimePort, 'now'>>().not.toMatchTypeOf<MonotonicClock<symbol>>();
  });
});
