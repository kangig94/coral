import { expect, it } from 'vitest';
import { observeCodexTurnSettlement } from '#src/providers/codex/turn-settlement.js';

async function scenario(
  backstep: number,
  status: 'inProgress' | 'unknown' | 'hung' | 'wrong-turn' | 'completed' = 'inProgress',
) {
  let elapsed = 0;
  let offset = 0;
  let ordinal = 0;
  const timers = new Map<number, { deadline: number; callback: () => void }>();
  let reads = 0;
  let interrupts = 0;
  const time = {
    now: () => 1_000_000 + elapsed + offset,
    setTimeout(callback: () => void, ms: number) {
      const id = ++ordinal;
      timers.set(id, { deadline: elapsed + ms, callback });
      return { id };
    },
    clearTimeout(handle: { id: number }) {
      timers.delete(handle.id);
    },
  };
  const lease = {
    closed: new Promise<void>(() => {}),
    subscribe: () => () => {},
    rpc: async () => {
      reads++;
      if (status === 'hung') return new Promise<never>(() => {});
      if (status === 'unknown') return {};
      return {
        thread: {
          id: 'thread-1',
          turns: [
            {
              id: status === 'wrong-turn' ? 'other-turn' : 'turn-1',
              status: status === 'wrong-turn' ? 'completed' : status,
            },
          ],
        },
      };
    },
    interrupt: async () => {
      interrupts++;
      return { kind: 'accepted' as const };
    },
  };
  const settlement = observeCodexTurnSettlement(lease as never, time as never, 'thread-1', 'turn-1');
  let finishedAt: number | null = null;
  let evidence: unknown = null;
  const pending = settlement.settle().then((result) => {
    evidence = result;
    finishedAt = elapsed;
  });
  offset = -backstep;
  for (let step = 0; step < 260 && finishedAt === null; step++) {
    elapsed += 250;
    for (const [id, timer] of [...timers]) {
      if (timer.deadline <= elapsed) {
        timers.delete(id);
        timer.callback();
      }
    }
    for (let microtask = 0; microtask < 30; microtask++) await Promise.resolve();
  }
  await pending;
  settlement.close();
  return { backstep, finishedAt, reads, interrupts, evidence, timers: timers.size };
}
it.each([0, 60_000, -60_000])('bounds settlement across a wall-clock correction of %s ms', async (backstep) => {
  const result = await scenario(backstep);
  expect(result.finishedAt).toBeLessThanOrEqual(3500);
  expect(result.interrupts).toBe(1);
});

it.each(['unknown', 'hung', 'wrong-turn'] as const)(
  'bounds %s reads without authorizing an interrupt',
  async (status) => {
    const result = await scenario(60_000, status);
    expect(result.finishedAt).toBeLessThanOrEqual(2250);
    expect(result.interrupts).toBe(0);
    expect(result.evidence).toBeNull();
    expect(result.timers).toBe(0);
  },
);

it('releases only on exact terminal evidence', async () => {
  const result = await scenario(60_000, 'completed');
  expect(result.evidence).toEqual({ kind: 'provider-turn-terminal', providerTurnId: 'turn-1', status: 'completed' });
  expect(result.interrupts).toBe(0);
  expect(result.timers).toBe(0);
});
