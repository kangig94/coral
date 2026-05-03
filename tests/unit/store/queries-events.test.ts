import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CoralEventInput } from '#src/store/envelope.js';
import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { getEvent, getEventsSince } from '#src/store/event-queries.js';
import { applyTestCounterSchema, testCounterRegistry } from '#tests/unit/store/fixtures/test-counter-registry.js';
import type { StoreReadContext } from '#src/store/body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
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
        stream: { kind: 'session', id: 'session-1' },
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
        stream: { kind: 'session', id: 'session-1' },
        namespace: 'tests',
        project: 'coral',
        correlationId: 'cor-a',
        bodyVersion: 1,
        body: { id: 'x', delta: 1 },
      },
    ];

    appended = commitInputs(db, inputs, {
      now: () => new Date(Date.UTC(2026, 3, 18, 0, 0, 0)),
      reducers: composeReducers(testCounterRegistry),
      upcasters: createDefaultUpcasterRegistry(),
      providers: permissiveProviderLookupPort,
    });
    readCtx = {
      schemas: composeReducers(testCounterRegistry).schemas,
      upcasters: createDefaultUpcasterRegistry(),
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

    expect(page.events.map((event) => event.seq)).toEqual([1, 3, 6]);
    expect(page.events.map((event) => event.stream.kind)).toEqual(['session', 'session', 'session']);
    expect(page.nextCursor).toBe(6);
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
    expect(getEvent(db, { kind: 'session', id: 'session-1' }, 1, readCtx)).toEqual(appended[0]);
    expect(getEvent(db, { kind: 'session', id: 'session-1' }, 99, readCtx)).toBeUndefined();
  });
});
