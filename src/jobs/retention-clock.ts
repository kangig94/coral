import type { Runtime } from '../runtime/ports.js';
import type { TimePort } from '../infra/port-types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOCK_JUMP_TOLERANCE_MS = 1000;
const clocks = new WeakMap<TimePort, { wall: number; monotonic: bigint; untrustedUntil: bigint }>();

export function resolveJobRetentionMs(raw: string | undefined): number {
  const days = raw === undefined ? NaN : Number(raw);
  return (Number.isSafeInteger(days) && days > 0 ? days : 14) * DAY_MS;
}

/** All owners share the wall/monotonic guard, including indexes outside the scheduler. */
export function trustedJobRetentionCutoff(runtime: Pick<Runtime, 'time' | 'env'>): number | null {
  const wall = runtime.time.now();
  const monotonic = runtime.time.monotonicNow();
  const previous = clocks.get(runtime.time);
  let untrustedUntil = previous?.untrustedUntil ?? 0n;
  if (previous && wall - previous.wall - Number(monotonic - previous.monotonic) > CLOCK_JUMP_TOLERANCE_MS)
    untrustedUntil = monotonic + BigInt(CLOCK_JUMP_TOLERANCE_MS);
  clocks.set(runtime.time, { wall, monotonic, untrustedUntil });
  return Number.isFinite(wall) && monotonic >= untrustedUntil
    ? wall - resolveJobRetentionMs(runtime.env.get('CORAL_JOBS_RETENTION_DAYS'))
    : null;
}
