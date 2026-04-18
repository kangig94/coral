import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { describeTerminalOutcome, type TerminalOutcome } from '../../outcome.js';
import { CoralStore } from '../../../store/index.js';
import { applyMigrations } from '../../../store/migrations.js';
import { describeCauseRef } from '../cause-ref-render.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../store/migrations');
const storageAdapter = {
  readdirSync: (path: string, opts: { withFileTypes: true }) => fs.readdirSync(path, opts),
  readFileSync: (path: string, enc: 'utf-8') => fs.readFileSync(path, enc),
};

function createStore(): { db: InstanceType<typeof Database>; store: CoralStore } {
  const db = new Database(':memory:');
  applyMigrations({ db, storage: storageAdapter as never, migrationsDir: MIGRATIONS_DIR });
  return { db, store: new CoralStore(db) };
}

describe('describeCauseRef phantom seq fallback', () => {
  it('falls back to the terminal outcome describer when the cause ref event is missing', () => {
    const { db, store } = createStore();
    try {
      const fallbackOutcome: TerminalOutcome = {
        kind: 'failed',
        causeRef: {
          stream: { kind: 'job', id: 'job-phantom' },
          seq: 1,
        },
      };

      expect(
        describeCauseRef(
          {
            stream: { kind: 'job', id: 'job-phantom' },
            seq: 1,
          },
          store,
          fallbackOutcome,
        ),
      ).toBe(describeTerminalOutcome(fallbackOutcome));
    } finally {
      db.close();
    }
  });
});
