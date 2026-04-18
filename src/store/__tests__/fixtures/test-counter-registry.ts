import { z } from 'zod';

import type { DomainEventRegistry, Reducer } from '../../reducers.js';

export const TEST_COUNTER_SCHEMA = z.object({
  id: z.string(),
  delta: z.number().int(),
});

const reducer: Reducer<z.infer<typeof TEST_COUNTER_SCHEMA>> = (db, event) => {
  db.prepare(
    `INSERT INTO projection_test_counter (id, count, last_seq) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET count = count + excluded.count, last_seq = excluded.last_seq`,
  ).run(event.body.id, event.body.delta, event.seq);
};

export const testCounterRegistry: DomainEventRegistry = {
  types: ['test.counter.ticked'],
  reducers: { 'test.counter.ticked': reducer as Reducer<unknown> },
  schemas: { 'test.counter.ticked': TEST_COUNTER_SCHEMA },
};

export function applyTestCounterMigration(db: import('better-sqlite3').Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS projection_test_counter (
    id       TEXT PRIMARY KEY,
    count    INTEGER NOT NULL DEFAULT 0,
    last_seq INTEGER NOT NULL DEFAULT 0
  );`);
}
