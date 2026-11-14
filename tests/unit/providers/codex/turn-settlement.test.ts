import { expect, it } from 'vitest';
import { observeCodexTurnSettlement } from '#src/providers/codex/turn-settlement.js';

async function scenario(
  backstep: number,
  status: 'inProgress' | 'unknown' | 'hung' | 'wrong-turn' | 'completed' | 'slow-read' = 'inProgress',
  confirmation: 'notification' | 'read' | 'unknown-notification' | null = null,
  readDelayMs = 2_500,
) {
  let elapsed = 0;
  let offset = 0;
  let ordinal = 0;
  const timers = new Map<number, { deadline: number; callback: () => void }>();
  let reads = 0;
  let interrupts = 0;
  let interruptedAt: number | null = null;
  let notify: (message: unknown) => void = () => {};
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
    subscribe: (listener: (message: unknown) => void) => {
      notify = listener;
      return () => {};
    },
    rpc: async () => {
      reads++;
      if (status === 'hung') return new Promise<never>(() => {});
      if (status === 'unknown') return {};
      if (status === 'slow-read') {
        if (reads > 1) return new Promise<never>(() => {});
        return new Promise((resolve) => {
          time.setTimeout(() => {
            resolve({ thread: { id: 'thread-1', turns: [{ id: 'turn-1', status: 'inProgress' }] } });
          }, readDelayMs);
        });
      }
      return {
        thread: {
          id: 'thread-1',
          turns: [
            {
              id: status === 'wrong-turn' ? 'other-turn' : 'turn-1',
              status:
                status === 'wrong-turn'
                  ? 'completed'
                  : confirmation === 'read' && interruptedAt !== null && elapsed - interruptedAt >= 14_000
                    ? 'interrupted'
                    : status,
            },
          ],
        },
      };
    },
    interrupt: async () => {
      interrupts++;
      interruptedAt = elapsed;
      return { kind: 'accepted' as const };
    },
  };
  const settlement = observeCodexTurnSettlement(lease as never, time as never, 'thread-1', 'turn-1');
  let finishedAt: number | null = null;
  let evidence: unknown = null;
  const observation = settlement.settle();
  let laterObservation: ReturnType<typeof settlement.settle> | null = null;
  const pending = observation.then((result) => {
    evidence = result;
    finishedAt = elapsed;
  });
  offset = -backstep;
  for (let step = 0; step < 260 && finishedAt === null; step++) {
    elapsed += 250;
    if (elapsed === 10_000) laterObservation = settlement.settle();
    if (confirmation === 'unknown-notification' && elapsed === 5_000) {
      notify({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
      });
    }
    if (confirmation === 'notification' && interruptedAt !== null && elapsed - interruptedAt === 14_000) {
      notify({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } },
      });
    }
    for (const [id, timer] of [...timers]) {
      if (timer.deadline <= elapsed) {
        timers.delete(id);
        timer.callback();
      }
    }
    for (let microtask = 0; microtask < 30; microtask++) await Promise.resolve();
  }
  await pending;
  if (laterObservation !== null) expect(await laterObservation).toEqual(evidence);
  settlement.close();
  return {
    backstep,
    interruptedAt,
    finishedAt,
    reads,
    interrupts,
    evidence,
    timers: timers.size,
  };
}
it.each([0, 60_000, -60_000])('bounds settlement across a wall-clock correction of %s ms', async (backstep) => {
  const result = await scenario(backstep);
  expect(result.finishedAt).toBeLessThanOrEqual(33_000);
  expect(result.interrupts).toBe(1);
});

it.each(['unknown', 'hung', 'wrong-turn'] as const)(
  'bounds %s reads without authorizing an interrupt',
  async (status) => {
    const result = await scenario(60_000, status);
    expect(result.finishedAt).toBeGreaterThanOrEqual(30_000);
    expect(result.finishedAt).toBeLessThanOrEqual(33_000);
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

it.each(['notification', 'read'] as const)(
  'waits for a running command interrupt confirmed after 14 seconds by %s',
  async (confirmation) => {
    const result = await scenario(0, 'inProgress', confirmation);
    expect(result.evidence).toEqual({
      kind: 'provider-turn-terminal',
      providerTurnId: 'turn-1',
      status: 'interrupted',
    });
    expect(result.finishedAt! - result.interruptedAt!).toBeGreaterThanOrEqual(14_000);
    expect(result.interrupts).toBe(1);
    expect(result.timers).toBe(0);
  },
);

it('does not renew the observation budget when settlement is called later', async () => {
  const result = await scenario(0);
  expect(result.finishedAt).toBeGreaterThanOrEqual(30_000);
  expect(result.finishedAt).toBeLessThanOrEqual(33_000);
  expect(result.evidence).toBeNull();
  expect(result.interrupts).toBe(1);
  expect(result.timers).toBe(0);
});

it('accepts an exact terminal notification after initially inconclusive reads', async () => {
  const result = await scenario(0, 'unknown', 'unknown-notification');
  expect(result.finishedAt).toBe(5_000);
  expect(result.evidence).toEqual({ kind: 'provider-turn-terminal', providerTurnId: 'turn-1', status: 'completed' });
  expect(result.interrupts).toBe(0);
  expect(result.timers).toBe(0);
});

it('keeps only one thread read in flight while the connection remains open', async () => {
  const result = await scenario(0, 'hung');
  expect(result.reads).toBe(1);
  expect(result.finishedAt).toBeGreaterThanOrEqual(32_000);
  expect(result.finishedAt).toBeLessThanOrEqual(33_000);
  expect(result.evidence).toBeNull();
  expect(result.interrupts).toBe(0);
  expect(result.timers).toBe(0);
});

it('accepts an exact terminal notification while the only thread read remains pending', async () => {
  const result = await scenario(0, 'hung', 'unknown-notification');
  expect(result.reads).toBe(1);
  expect(result.finishedAt).toBe(5_000);
  expect(result.evidence).toEqual({ kind: 'provider-turn-terminal', providerTurnId: 'turn-1', status: 'completed' });
  expect(result.interrupts).toBe(0);
  expect(result.timers).toBe(0);
});

it('gives an interrupt authorized by a late read its own terminal-confirmation window', async () => {
  const result = await scenario(0, 'slow-read', 'notification', 25_000);
  expect(result.interrupts).toBe(1);
  expect(result.interruptedAt).toBeGreaterThanOrEqual(25_000);
  expect(result.finishedAt! - result.interruptedAt!).toBeGreaterThanOrEqual(14_000);
  expect(result.finishedAt).toBeLessThanOrEqual(62_000);
  expect(result.evidence).toEqual({ kind: 'provider-turn-terminal', providerTurnId: 'turn-1', status: 'interrupted' });
  expect(result.timers).toBe(0);
});

it('exhausts a late interrupt confirmation window without renewing the initial observation budget', async () => {
  const result = await scenario(0, 'slow-read', null, 25_000);
  expect(result.interrupts).toBe(1);
  expect(result.finishedAt! - result.interruptedAt!).toBeGreaterThanOrEqual(30_000);
  expect(result.finishedAt).toBeLessThanOrEqual(62_000);
  expect(result.evidence).toBeNull();
  expect(result.timers).toBe(0);
});
