import { describe, expect, it } from 'vitest';

import { ConsumerDriver } from '#src/projection-consumers/index.js';
import { REAL_CONSUMER_DRIVER_TIMERS } from '#tests/helpers/consumer-driver-defaults.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { CoralEventInput } from '#src/store/envelope.js';
import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { openStoreDatabase, type Database } from '#src/store/db.js';
import { composeReducers } from '#src/store/reducers.js';
import { applyTestCounterSchema, testCounterRegistry } from '#tests/unit/store/fixtures/test-counter-registry.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';

const CONSUMER_ID = 'journal-projection-consumer';
const EVENT_COUNT = 1_000;
const SIM_EPOCH_MS = Date.parse('2026-04-18T00:00:00.000Z');
const SIM_ROOTS = {
  jobsDir: '/tmp/sim/jobs',
  coralRoot: '/tmp/sim/coral',
} as const;

interface PlannedEvent extends CoralEventInput {
  readonly ts: string;
}

interface SequencePlan {
  readonly events: readonly PlannedEvent[];
  readonly equippedAt: string;
}

interface Snapshot {
  readonly counters: unknown[];
  readonly events: unknown[];
  readonly cursors: unknown[];
  readonly serialized: string;
}

function openMemoryDatabase(runtime: Pick<Runtime, 'storage'>): Database {
  return openStoreDatabase({
    path: ':memory:',
    storage: runtime.storage,
  });
}

function registerConsumer(driver: ConsumerDriver): void {
  driver.register({
    id: CONSUMER_ID,
    authority: 'journal',
    kind: 'apply',
    registrationKind: 'expansion',
    apply: async ({ db, fromSeq, upToSeq }) => {
      const rows = db
        .prepare('SELECT seq FROM events WHERE seq > ? AND seq <= ? ORDER BY seq')
        .all(fromSeq, upToSeq) as Array<{ seq: number }>;

      if (rows.length !== upToSeq - fromSeq) {
        throw new Error(`expected ${upToSeq - fromSeq} events, got ${rows.length}`);
      }

      if (rows[0]?.seq !== fromSeq + 1 || rows[rows.length - 1]?.seq !== upToSeq) {
        throw new Error(`unexpected event window (${fromSeq}, ${upToSeq}]`);
      }
    },
  });
}

function buildPlannedEvent(
  runtime: SimulationRuntime,
  index: number,
  streamIds: readonly string[],
  counterIds: readonly string[],
): PlannedEvent {
  return {
    type: 'test.counter.ticked',
    stream: { kind: 'job', id: streamIds[index % streamIds.length] ?? streamIds[0] },
    namespace: 'simulation',
    project: 'simulation',
    correlationId: runtime.ids.sha256(`correlation-${index % 2}`),
    bodyVersion: 1,
    body: {
      id: counterIds[index % counterIds.length] ?? counterIds[0],
      delta: (runtime.ids.randomBytes(1)[0] % 7) + 1,
    },
    ts: new Date(runtime.time.now()).toISOString(),
  };
}

function captureSnapshot(db: Database): Snapshot {
  const counters = db.prepare('SELECT id, count, last_seq FROM projection_test_counter ORDER BY id').all();
  const events = db
    .prepare(
      `SELECT seq, ts, type, stream_kind, stream_id, namespace, project, correlation_id, body_version, hex(body) AS body_hex
       FROM events
       ORDER BY seq`,
    )
    .all();
  const cursors = db
    .prepare('SELECT consumer_id, authority, cursor, registered_at FROM consumer_cursors ORDER BY consumer_id')
    .all();
  const serialized = JSON.stringify({ counters, events, cursors });

  return { counters, events, cursors, serialized };
}

async function runSimulationSequence(): Promise<Snapshot> {
  const runtime = new SimulationRuntime({ epochMs: SIM_EPOCH_MS, roots: { ...SIM_ROOTS } });
  const db = openMemoryDatabase(runtime);
  const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: () => new Date(runtime.time.now()) });
  const reducers = composeReducers(testCounterRegistry);
  const upcasters = createDefaultUpcasterRegistry();
  const streamIds = Array.from({ length: 3 }, () => runtime.ids.uuid());
  const counterIds = Array.from({ length: 5 }, () => runtime.ids.uuid());

  try {
    applyTestCounterSchema(db);
    registerConsumer(driver);

    let lastSeq = 0;

    for (let index = 0; index < EVENT_COUNT; index += 1) {
      const { ts: expectedTs, ...input } = buildPlannedEvent(runtime, index, streamIds, counterIds);
      const appended = commitInputs(db, [input], {
        now: () => new Date(runtime.time.now()),
        reducers,
        upcasters,
        providers: permissiveProviderLookupPort,
      });

      expect(appended).toHaveLength(1);
      expect(appended[0]?.ts).toBe(expectedTs);
      lastSeq = appended[0]?.seq ?? lastSeq;

      runtime.time.tick(1);
    }

    driver.notify('journal', lastSeq);
    await driver.drainAll();

    return captureSnapshot(db);
  } finally {
    await driver.shutdown();
    db.close();
  }
}

function createSequencePlan(): SequencePlan {
  const runtime = new SimulationRuntime({ epochMs: SIM_EPOCH_MS, roots: { ...SIM_ROOTS } });
  const streamIds = Array.from({ length: 3 }, () => runtime.ids.uuid());
  const counterIds = Array.from({ length: 5 }, () => runtime.ids.uuid());
  const events: PlannedEvent[] = [];

  for (let index = 0; index < EVENT_COUNT; index += 1) {
    events.push(buildPlannedEvent(runtime, index, streamIds, counterIds));
    runtime.time.tick(1);
  }

  return {
    events,
    equippedAt: new Date(SIM_EPOCH_MS).toISOString(),
  };
}

async function runPlannedSequence(runtime: Pick<Runtime, 'storage'>, plan: SequencePlan): Promise<Snapshot> {
  const db = openMemoryDatabase(runtime);
  const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: () => new Date(plan.equippedAt) });
  const reducers = composeReducers(testCounterRegistry);
  const upcasters = createDefaultUpcasterRegistry();

  try {
    applyTestCounterSchema(db);
    registerConsumer(driver);

    let lastSeq = 0;

    for (const event of plan.events) {
      const { ts, ...input } = event;
      const appended = commitInputs(db, [{ ...input, tsOverride: ts }], {
        now: () => new Date(0),
        reducers,
        upcasters,
        providers: permissiveProviderLookupPort,
      });

      lastSeq = appended[0]?.seq ?? lastSeq;
    }

    driver.notify('journal', lastSeq);
    await driver.drainAll();

    return captureSnapshot(db);
  } finally {
    await driver.shutdown();
    db.close();
  }
}

describe('SimulationRuntime determinism', () => {
  it('produces byte-identical snapshots across three same-seed simulation runs', async () => {
    const first = await runSimulationSequence();
    const second = await runSimulationSequence();
    const third = await runSimulationSequence();

    expect(first.events).toHaveLength(EVENT_COUNT);
    expect(first.serialized).toBe(second.serialized);
    expect(first.serialized).toBe(third.serialized);
    expect(first.cursors).toEqual([
      {
        consumer_id: CONSUMER_ID,
        authority: 'journal',
        cursor: EVENT_COUNT,
        registered_at: new Date(SIM_EPOCH_MS).toISOString(),
      },
    ]);
  });

  it('matches createRealRuntime on the same deterministic event plan', async () => {
    const plan = createSequencePlan();
    const simulated = await runPlannedSequence(
      new SimulationRuntime({ epochMs: SIM_EPOCH_MS, roots: { ...SIM_ROOTS } }),
      plan,
    );
    const production = await runPlannedSequence(createRealRuntime('prod'), plan);

    expect(simulated.serialized).toBe(production.serialized);
  });
});
