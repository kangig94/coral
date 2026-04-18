import { readFileSync, readdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendEvents, type AppendInput } from '../append.js';
import { applyMigrations } from '../migrations.js';
import { getEvent, getEventsSince } from '../queries/events.js';
import { applyTestCounterMigration, testCounterRegistry } from './fixtures/test-counter-registry.js';
import type { StoragePort } from '../../runtime/ports.js';

const nodeStorage: Pick<StoragePort, 'readFileSync' | 'readdirSync'> = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readdirSync: (path, options) => readdirSync(path, options),
};

describe('events queries', () => {
  let db: Database.Database;
  let appended: ReturnType<typeof appendEvents>;

  beforeEach(() => {
    db = new Database(':memory:');
    applyMigrations({ db, storage: nodeStorage });
    applyTestCounterMigration(db);

    const inputs: AppendInput[] = [
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

    appended = appendEvents(db, inputs, {
      now: () => Date.UTC(2026, 3, 18, 0, 0, 0),
      reducers: { ...testCounterRegistry.reducers },
    });
  });

  afterEach(() => {
    db.close();
  });

  it('returns all events in seq order when querying from zero', () => {
    const page = getEventsSince(db, 0);

    expect(page.events.map((event) => event.seq)).toEqual(appended.map((event) => event.seq));
    expect(page.events).toEqual(appended);
    expect(page.events.map((event) => event.body)).toEqual(
      appended.map(() => ({ id: 'x', delta: 1 })),
    );
    expect(page.nextCursor).toBe(appended[appended.length - 1]!.seq);
  });

  it('returns only events with seq greater than afterSeq', () => {
    const page = getEventsSince(db, 3);

    expect(page.events.map((event) => event.seq)).toEqual([4, 5, 6]);
    expect(page.nextCursor).toBe(6);
  });

  it('filters by stream kind', () => {
    const page = getEventsSince(db, 0, { streamKind: 'session' });

    expect(page.events.map((event) => event.seq)).toEqual([1, 3, 6]);
    expect(page.events.map((event) => event.stream.kind)).toEqual(['session', 'session', 'session']);
    expect(page.nextCursor).toBe(6);
  });

  it('filters by type', () => {
    const page = getEventsSince(db, 0, { type: 'test.counter.ticked' });

    expect(page.events.map((event) => event.seq)).toEqual([1, 2, 6]);
    expect(page.events.map((event) => event.type)).toEqual([
      'test.counter.ticked',
      'test.counter.ticked',
      'test.counter.ticked',
    ]);
    expect(page.nextCursor).toBe(6);
  });

  it('filters by correlationId', () => {
    const page = getEventsSince(db, 0, { correlationId: 'cor-a' });

    expect(page.events.map((event) => event.seq)).toEqual([1, 3, 5, 6]);
    expect(page.events.map((event) => event.correlationId)).toEqual(['cor-a', 'cor-a', 'cor-a', 'cor-a']);
    expect(page.nextCursor).toBe(6);
  });

  it('returns afterSeq as nextCursor when the result is empty', () => {
    const page = getEventsSince(db, appended[appended.length - 1]!.seq);

    expect(page.events).toEqual([]);
    expect(page.nextCursor).toBe(appended[appended.length - 1]!.seq);
  });

  it('returns the last returned seq as nextCursor when non-empty', () => {
    const page = getEventsSince(db, 1, {}, 2);

    expect(page.events.map((event) => event.seq)).toEqual([2, 3]);
    expect(page.nextCursor).toBe(3);
  });

  it('looks up a single event by stream and seq or returns undefined', () => {
    expect(getEvent(db, { kind: 'session', id: 'session-1' }, 1)).toEqual(appended[0]);
    expect(getEvent(db, { kind: 'session', id: 'session-1' }, 99)).toBeUndefined();
  });
});
