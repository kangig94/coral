import { expect, it, vi } from 'vitest';

import { observeDatabaseReads } from '#src/recovery/read-observation.js';
import { prepareCached } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

it('counts returned storage rows on repeated cached reads and only consumed iterator rows', () => {
  const db = newRawDatabase(':memory:');
  const record = vi.fn();
  const observed = observeDatabaseReads(db, { record }, 'inputs');
  try {
    observed.exec('CREATE TABLE inputs (id INTEGER PRIMARY KEY, value TEXT)');
    observed.prepare('INSERT INTO inputs VALUES (?, ?)').run(1, 'one');
    observed.prepare('INSERT INTO inputs VALUES (?, ?)').run(2, 'two');
    expect(record).not.toHaveBeenCalled();
    const read = prepareCached<[number], { value: string }>(observed, 'SELECT value FROM inputs WHERE id = ?');
    expect(read.get(1)).toEqual({ value: 'one' });
    expect(read.get(1)).toEqual({ value: 'one' });
    expect(read.get(3)).toBeUndefined();
    expect(observed.prepare('SELECT * FROM inputs').all()).toHaveLength(2);
    for (const row of observed.prepare<[], { id: number }>('SELECT id FROM inputs ORDER BY id').iterate()) {
      expect(row.id).toBe(1);
      break;
    }
    expect(record.mock.calls).toEqual([
      ['inputs', { reads: 1 }],
      ['inputs', { reads: 1 }],
      ['inputs', { reads: 0 }],
      ['inputs', { reads: 2 }],
      ['inputs', { reads: 1 }],
    ]);
  } finally {
    db.close();
  }
});
