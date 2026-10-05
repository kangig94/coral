import type { Runtime } from '../runtime/ports.js';
import type { TimePort } from '../infra/port-types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOCK_JUMP_TOLERANCE_MS = 60_000;
const CLOCK_DRIFT_RATIO = 0.12;
const CLOCK_SETTLE_MS = 5 * 60_000;
const clocks = new WeakMap<TimePort, { wall: number; monotonic: bigint; untrusted: boolean }>();

export function resolveJobRetentionMs(raw: string | undefined): number {
  const days = raw === undefined ? NaN : Number(raw);
  return (Number.isSafeInteger(days) && days > 0 ? days : 14) * DAY_MS;
}

/** Compare against the last trusted observation; idle periods retain that baseline. */
export function trustedJobRetentionCutoff(runtime: Pick<Runtime, 'time' | 'env'>): number | null {
  const wall = runtime.time.now();
  const monotonic = runtime.time.monotonicNow();
  if (!Number.isFinite(wall)) return null;
  let baseline = clocks.get(runtime.time);
  if (!baseline) {
    baseline = { wall, monotonic, untrusted: false };
    clocks.set(runtime.time, baseline);
  }
  const elapsed = Number(monotonic - baseline.monotonic);
  const offsetChange = wall - baseline.wall - elapsed;
  if (elapsed < 0 || Math.abs(offsetChange) > CLOCK_JUMP_TOLERANCE_MS + Math.max(0, elapsed) * CLOCK_DRIFT_RATIO) {
    clocks.set(runtime.time, { wall, monotonic, untrusted: true });
    return null;
  }
  if (baseline.untrusted && elapsed < CLOCK_SETTLE_MS) return null;
  clocks.set(runtime.time, { wall, monotonic, untrusted: false });
  return wall - resolveJobRetentionMs(runtime.env.get('CORAL_JOBS_RETENTION_DAYS')) - CLOCK_JUMP_TOLERANCE_MS;
}
