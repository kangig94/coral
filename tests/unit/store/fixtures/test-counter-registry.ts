import { z } from 'zod';
import type { Database } from '../../../../src/store/db.js';

import { defineDomainEvent, type DomainEventRegistry } from '#src/store/reducers.js';

export const TEST_COUNTER_SCHEMA = z.object({
  id: z.string(),
  delta: z.number().int(),
});

export const testCounterRegistry: DomainEventRegistry = {
  streamKind: 'job',
  entries: [
    defineDomainEvent({
      type: 'test.counter.ticked',
      schema: TEST_COUNTER_SCHEMA,
      reducer: (db, event) => {
        db.prepare(
          `INSERT INTO projection_test_counter (id, count, last_seq) VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET count = count + excluded.count, last_seq = excluded.last_seq`,
        ).run(event.body.id, event.body.delta, event.seq);
      },
      materializerContract: 'test:increment-projection-counter',
    }),
  ],
};

export function applyTestCounterSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS projection_test_counter (
    id       TEXT PRIMARY KEY,
    count    INTEGER NOT NULL DEFAULT 0,
    last_seq INTEGER NOT NULL DEFAULT 0
  );`);
}
