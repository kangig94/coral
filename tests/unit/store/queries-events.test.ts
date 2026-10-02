import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CoralEventInput } from '#src/store/envelope.js';
import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { getEvent, getEventsSince } from '#src/store/event-queries.js';
import {
  applyTestCounterSchema,
  TEST_COUNTER_SCHEMA,
  testCounterRegistry,
} from '#tests/unit/store/fixtures/test-counter-registry.js';
import { decodeBody, type StoreReadContext } from '#src/store/body-codec.js';
import { composeReducers, defineDomainEvent, type DomainEventRegistry } from '#src/store/reducers.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { z } from 'zod';
import type { EventsRow } from '#src/store/schema.js';

const sessionQueryRegistry: DomainEventRegistry = {
  streamKind: 'session',
  entries: [defineDomainEvent({ type: 'test.counter.reset', schema: TEST_COUNTER_SCHEMA })],
};

const discussQueryRegistry: DomainEventRegistry = {
  streamKind: 'discuss',
  entries: [defineDomainEvent({ type: 'discuss.message.recorded', schema: TEST_COUNTER_SCHEMA })],
};

const workflowQueryRegistry: DomainEventRegistry = {
  streamKind: 'workflow',
  entries: [defineDomainEvent({ type: 'workflow.step.completed', schema: TEST_COUNTER_SCHEMA })],
};

const queryReducers = composeReducers(
  testCounterRegistry,
  sessionQueryRegistry,
  discussQueryRegistry,
  workflowQueryRegistry,
);

describe('events queries', () => {
  let db: Database;
  let readCtx: StoreReadContext;

  beforeEach(() => {
    db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    applyTestCounterSchema(db);

    const inputs: CoralEventInput[] = [
      {
        type: 'test.counter.ticked',
        stream: { kind: 'job', id: 'job-0' },
        namespace: 'tests',
        project: 'coral',
        correlationId: 'cor-a',
        body: { id: 'x', delta: 1 },
      },
      {
        type: 'test.counter.ticked',
        stream: { kind: 'job', id: 'job-1' },
        namespace: 'tests',
        project: 'coral',
        correlationId: 'cor-b',
        body: { id: 'x', delta: 1 },
      },
      {
        type: 'test.counter.reset',
        stream: { kind: 'session', id: 'session-2' },
        namespace: 'tests',
        project: 'coral',
        correlationId: 'cor-a',
        body: { id: 'x', delta: 1 },
      },
      {
        type: 'discuss.message.recorded',
        stream: { kind: 'discuss', id: 'discuss-1' },
        namespace: 'tests',
        project: 'coral',
        correlationId: 'cor-c',
        body: { id: 'x', delta: 1 },
      },
      {
        type: 'workflow.step.completed',
        stream: { kind: 'workflow', id: 'workflow-1' },
        namespace: 'tests',
        project: 'coral',
        correlationId: 'cor-a',
        body: { id: 'x', delta: 1 },
      },
      {
        type: 'test.counter.ticked',
        stream: { kind: 'job', id: 'job-0' },
        namespace: 'tests',
        project: 'coral',
        correlationId: 'cor-a',
        body: { id: 'x', delta: 1 },
      },
    ];

    commitInputs(db, inputs, {
      now: () => new Date(Date.UTC(2026, 3, 18, 0, 0, 0)),
      reducers: queryReducers,
      bodyCodec: createEventBodyCodec(),
      providers: permissiveProviderLookupPort,
    });
    readCtx = {
      schemas: queryReducers.schemas,
      streamKinds: queryReducers.streamKinds,
      bodyCodec: createEventBodyCodec(),
    };
  });

  afterEach(() => {
    db.close();
  });

  it('rejects a stored event type outside the current codec registry', () => {
    db.prepare(
      `INSERT INTO events (
         seq, ts, type, stream_kind, stream_id, body
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(7, '2026-04-18T00:00:01.000Z', 'test.unknown', 'job', 'job-unknown', Buffer.from('{}'));

    expect(() => getEvent(db, { kind: 'job', id: 'job-unknown' }, 7, readCtx)).toThrow(
      "No registered event body codec for stored type 'test.unknown'",
    );
  });

  it('rejects a registered stored event body that violates the current codec', () => {
    db.prepare('UPDATE events SET body = ? WHERE seq = 1').run(Buffer.from(JSON.stringify({ id: 'x', delta: 'bad' })));

    expect(() => getEvent(db, { kind: 'job', id: 'job-0' }, 1, readCtx)).toThrow(
      "Current codec rejected stored event type 'test.counter.ticked'",
    );
  });

  it('rejects a registered event type stored under a different valid stream kind', () => {
    db.prepare("UPDATE events SET stream_kind = 'session' WHERE seq = 1").run();

    expect(() => getEvent(db, { kind: 'session', id: 'job-0' }, 1, readCtx)).toThrow(
      "Stored event type 'test.counter.ticked' belongs to stream kind 'job', not 'session'",
    );
    expect(() => getEventsSince(db, 0, {}, 1000, readCtx)).toThrow(
      "Stored event type 'test.counter.ticked' belongs to stream kind 'job', not 'session'",
    );
  });

  it.each([
    ['ts', 'not-an-iso-timestamp'],
    ['stream_id', ''],
    ['causation_seq', -1],
  ] as const)('rejects a corrupted persisted envelope scalar %s', (column, value) => {
    db.prepare(`UPDATE events SET ${column} = ? WHERE seq = 1`).run(value);

    expect(() => getEvent(db, { kind: 'job', id: 'job-0' }, 1, readCtx)).toThrow();
    expect(() => getEventsSince(db, 0, {}, 1000, readCtx)).toThrow();
  });

  it('does not let a stream-kind filter hide a corrupted physical stream kind', () => {
    db.prepare("UPDATE events SET stream_kind = 'job' WHERE seq = 3").run();

    expect(() => getEventsSince(db, 0, { streamKind: 'session' }, 1000, readCtx)).toThrow(
      "Stored event type 'test.counter.reset' belongs to stream kind 'session', not 'job'",
    );
  });

  it('rejects a read schema that differs from the registered current codec', () => {
    const row = db.prepare<[], EventsRow>('SELECT * FROM events WHERE seq = 1').get();
    if (row === undefined) throw new Error('Expected seeded event row.');

    expect(() => decodeBody(row, z.object({}).passthrough(), readCtx)).toThrow(
      "Read schema for stored event type 'test.counter.ticked' is not its registered current codec",
    );
  });
});
