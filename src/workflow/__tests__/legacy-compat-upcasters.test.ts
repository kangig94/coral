import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { appendEvents } from '../../store/append.js';
import { decodeEventBody } from '../../store/body-codec.js';
import { applyMigrations } from '../../store/migrations.js';
import { composeReducers } from '../../store/reducers.js';
import { createDefaultUpcasterRegistry } from '../../store/upcasters.js';
import { workflowRegistry } from '../events.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../store/migrations');
const storageAdapter = {
  readdirSync: (path: string, opts: { withFileTypes: true }) => fs.readdirSync(path, opts),
  readFileSync: (path: string, enc: 'utf-8') => fs.readFileSync(path, enc),
};
const NOW = new Date('2026-04-22T00:00:00.000Z');

describe('workflow legacy compat upcasters (AC3.2, AC3.6)', () => {
  it.each([
    ['workflow_aborted', { kind: 'workflow_aborted' }, { outcome: 'aborted' }],
    [
      'workflow_atom_failed',
      {
        kind: 'workflow_atom_failed',
        step: 1,
        atom: 'resolver',
        cause: { message: 'tool failed' },
      },
      { outcome: 'failed' },
    ],
  ] as const)('upcasts legacy %s bodies on workflow.completed', (_label, legacyBody, expectedBody) => {
    const db = new Database(':memory:');
    try {
      applyMigrations({ db, storage: storageAdapter as never, migrationsDir: MIGRATIONS_DIR });
      const reducers = composeReducers(workflowRegistry);
      const upcasters = createDefaultUpcasterRegistry();

      const [appended] = appendEvents(
        db,
        [
          {
            type: 'workflow.completed',
            stream: { kind: 'workflow', id: 'workflow-legacy' },
            refs: { workflowId: 'workflow-legacy' },
            bodyVersion: 1,
            body: legacyBody,
          },
        ],
        { now: () => NOW, reducers, upcasters },
      );

      expect(appended?.body).toEqual(expectedBody);

      const stored = db.prepare(
        `SELECT body_version, body
           FROM events
          WHERE stream_kind = 'workflow'
            AND stream_id = ?
            AND type = 'workflow.completed'
          LIMIT 1`,
      ).get('workflow-legacy') as { body_version: number; body: Uint8Array | Buffer } | undefined;

      expect(stored?.body_version).toBe(1);
      expect(decodeEventBody(stored!.body)).toEqual(legacyBody);
    } finally {
      db.close();
    }
  });
});
