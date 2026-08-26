import { createMonotonicClock } from '#src/infra/monotonic-clock.js';

/** The timeout bounds observation; it does not convert a final false check into success. */
export async function waitForCondition(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const clock = createMonotonicClock(Symbol('wait-for-condition'));
  const deadline = clock.shiftMilliseconds(clock.now(), timeoutMs);
  while (clock.compare(clock.now(), deadline) < 0) {
    if (check()) return;
    await clock.sleep(50);
  }
  if (check()) return;
  throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`);
}
