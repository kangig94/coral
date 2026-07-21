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
  let appended: ReturnType<typeof commitInputs>;
  let readCtx: StoreReadContext;

  beforeEach(() => {
    db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db);
    applyTestCounterSchema(db);

    const inputs: CoralEventInput[] = [
      {
        type: 'test.counter.ticked',
        stream: { kind: 'job', id: 'job-0' },
        namespace: 'tests',
        project: 'coral',
        correlationId: 'cor-a',
        bodyVersion: 1,
        body: { id: 'x', delta: 1 },
      },
      {
        type: 'test.counter.ticked',
        stream: { kind: 'job', id: 'job-1' },
        namespace: 'tests',
        project: 'coral',
        correlationId: 'cor-b',
        bodyVersion: 1,
        body: { id: 'x', delta: 1 },
      },
      {
        type: 'test.counter.reset',
        stream: { kind: 'session', id: 'session-2' },
        namespace: 'tests',
        project: 'coral',
        correlationId: 'cor-a',
        bodyVersion: 1,
        body: { id: 'x', delta: 1 },
      },
      {
        type: 'discuss.message.recorded',
        stream: { kind: 'discuss', id: 'discuss-1' },
        namespace: 'tests',
        project: 'coral',
        correlationId: 'cor-c',
        bodyVersion: 1,
        body: { id: 'x', delta: 1 },
      },
      {
        type: 'workflow.step.completed',
        stream: { kind: 'workflow', id: 'workflow-1' },
        namespace: 'tests',
        project: 'coral',
        correlationId: 'cor-a',
        bodyVersion: 1,
        body: { id: 'x', delta: 1 },
      },
      {
        type: 'test.counter.ticked',
        stream: { kind: 'job', id: 'job-0' },
        namespace: 'tests',
        project: 'coral',
        correlationId: 'cor-a',
        bodyVersion: 1,
        body: { id: 'x', delta: 1 },
      },
    ];

    appended = commitInputs(db, inputs, {
      now: () => new Date(Date.UTC(2026, 3, 18, 0, 0, 0)),
      reducers: queryReducers,
      bodyCodec: createEventBodyCodec(),
      providers: permissiveProviderLookupPort,
    });
    readCtx = {
      schemas: queryReducers.schemas,
      bodyCodec: createEventBodyCodec(),
    };
  });

  afterEach(() => {
    db.close();
  });

  it('returns all events in seq order when querying from zero', () => {
    const page = getEventsSince(db, 0, {}, 1000, readCtx);

    expect(page.events.map((event) => event.seq)).toEqual(appended.map((event) => event.seq));
    expect(page.events).toEqual(appended);
    expect(page.events.map((event) => event.body)).toEqual(appended.map(() => ({ id: 'x', delta: 1 })));
    expect(page.nextCursor).toBe(appended[appended.length - 1].seq);
  });

  it('returns only events with seq greater than afterSeq', () => {
    const page = getEventsSince(db, 3, {}, 1000, readCtx);

    expect(page.events.map((event) => event.seq)).toEqual([4, 5, 6]);
    expect(page.nextCursor).toBe(6);
  });

  it('filters by stream kind', () => {
    const page = getEventsSince(db, 0, { streamKind: 'session' }, 1000, readCtx);

    expect(page.events.map((event) => event.seq)).toEqual([3]);
    expect(page.events.map((event) => event.stream.kind)).toEqual(['session']);
    expect(page.nextCursor).toBe(3);
  });

  it('filters by type', () => {
    const page = getEventsSince(db, 0, { type: 'test.counter.ticked' }, 1000, readCtx);

    expect(page.events.map((event) => event.seq)).toEqual([1, 2, 6]);
    expect(page.events.map((event) => event.type)).toEqual([
      'test.counter.ticked',
      'test.counter.ticked',
      'test.counter.ticked',
    ]);
    expect(page.nextCursor).toBe(6);
  });

  it('filters by correlationId', () => {
    const page = getEventsSince(db, 0, { correlationId: 'cor-a' }, 1000, readCtx);

    expect(page.events.map((event) => event.seq)).toEqual([1, 3, 5, 6]);
    expect(page.events.map((event) => event.correlationId)).toEqual(['cor-a', 'cor-a', 'cor-a', 'cor-a']);
    expect(page.nextCursor).toBe(6);
  });

  it('returns afterSeq as nextCursor when the result is empty', () => {
    const page = getEventsSince(db, appended[appended.length - 1].seq, {}, 1000, readCtx);

    expect(page.events).toEqual([]);
    expect(page.nextCursor).toBe(appended[appended.length - 1].seq);
  });

  it('returns the last returned seq as nextCursor when non-empty', () => {
    const page = getEventsSince(db, 1, {}, 2, readCtx);

    expect(page.events.map((event) => event.seq)).toEqual([2, 3]);
    expect(page.nextCursor).toBe(3);
  });

  it('looks up a single event by stream and seq or returns undefined', () => {
    expect(getEvent(db, { kind: 'job', id: 'job-0' }, 1, readCtx)).toEqual(appended[0]);
    expect(getEvent(db, { kind: 'job', id: 'job-0' }, 99, readCtx)).toBeUndefined();
  });

  it('rejects a stored event type outside the current codec registry', () => {
    db.prepare(
      `INSERT INTO events (
         seq, ts, type, stream_kind, stream_id, body_version, body
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(7, '2026-04-18T00:00:01.000Z', 'test.unknown', 'job', 'job-unknown', 1, Buffer.from('{}'));

    expect(() => getEvent(db, { kind: 'job', id: 'job-unknown' }, 7, readCtx)).toThrow(
      "No registered event body codec for stored type 'test.unknown'",
    );
  });

  it('rejects a stored event body version outside the current codec', () => {
    db.prepare('UPDATE events SET body_version = 2 WHERE seq = 1').run();

    expect(() => getEvent(db, { kind: 'job', id: 'job-0' }, 1, readCtx)).toThrow(
      "Stored event type 'test.counter.ticked' has body_version 2; the current codec accepts only 1",
    );
  });

  it('rejects a registered stored event body that violates the current codec', () => {
    db.prepare('UPDATE events SET body = ? WHERE seq = 1').run(Buffer.from(JSON.stringify({ id: 'x', delta: 'bad' })));

    expect(() => getEvent(db, { kind: 'job', id: 'job-0' }, 1, readCtx)).toThrow(
      "Current codec rejected stored event type 'test.counter.ticked'",
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
