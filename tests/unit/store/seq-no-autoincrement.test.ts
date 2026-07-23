import { currentCoralStoreFormat } from '#src/store-format.js';
import * as fs from 'node:fs';
import { join } from 'node:path';

import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { applyBundledStoreSchema } from '#src/store/db.js';

// S3: events.seq is coordinator-reserved (MAX(seq)+1..N under BEGIN IMMEDIATE)
// — AUTOINCREMENT was bypassed by the explicit-INSERT path and would create a
// competing source of truth in `sqlite_sequence`. The schema must declare a
// plain INTEGER PRIMARY KEY and never spawn the sqlite_sequence row.

describe('events.seq schema (S3)', () => {
  it('declares INTEGER PRIMARY KEY without AUTOINCREMENT in schema.sql', () => {
    const sql = fs.readFileSync(join(process.cwd(), 'src/store/schema.sql'), 'utf-8');
    // Locate the seq column declaration line specifically.
    const seqLine = sql
      .split('\n')
      .find((line) => line.includes('seq') && line.toUpperCase().includes('INTEGER PRIMARY KEY'));
    expect(seqLine).toBeDefined();
    expect(seqLine!.toUpperCase()).not.toContain('AUTOINCREMENT');
  });

  it('does not create a sqlite_sequence row for events on an initialized journal', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      // SQLite only creates `sqlite_sequence` when at least one table uses
      // AUTOINCREMENT. Absence of the row for `events` proves the column has
      // no SQLite-side counter that could drift from coordinator-reserved seq.
      const sequenceRow = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'`)
        .get() as { name: string } | undefined;
      if (sequenceRow) {
        const eventsRow = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'events'`).get();
        expect(eventsRow).toBeUndefined();
      }
    } finally {
      db.close();
    }
  });
});
