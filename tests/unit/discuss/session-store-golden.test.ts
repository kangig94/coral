import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { CoralEvent } from '#src/store/envelope.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { reduceDiscussProjection } from '#src/discuss/projections.js';
import { toJournalInput } from '#src/discuss/store-registry.js';
import type { DiscussDomainEvent } from '#src/discuss/events.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE_JSON = join(FIXTURE_DIR, 'session-store-golden.json');
const FIXTURE_EVENTS = join(FIXTURE_DIR, 'session-store-golden.events.jsonl');
const SCHEMAS_DIR = join(process.cwd(), 'src/store/schemas');
const storageAdapter = {
  readdirSync: (path: string, opts: { withFileTypes: true }) => fs.readdirSync(path, opts),
  readFileSync: (path: string, enc: 'utf-8') => fs.readFileSync(path, enc),
};

function loadFixtureEvents(): DiscussDomainEvent[] {
  return fs
    .readFileSync(FIXTURE_EVENTS, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as DiscussDomainEvent);
}

describe('discuss session-store golden master (AC3)', () => {
  it('replays the normalized fixture through projection_discuss byte-identically', () => {
    const expectedState = fs.readFileSync(FIXTURE_JSON, 'utf8');
    const events = loadFixtureEvents();
    const db = new Database(':memory:');

    try {
      applyStoreSchemas({ db, storage: storageAdapter as never, schemasDir: SCHEMAS_DIR });

      for (const [index, domainEvent] of events.entries()) {
        const input = toJournalInput(domainEvent);
        const event: CoralEvent<Record<string, unknown> & { sourceSeq: number }> = {
          seq: index + 1,
          ts: input.tsOverride ?? '<ts>',
          type: input.type,
          stream: input.stream,
          namespace: input.namespace,
          project: input.project,
          correlationId: input.correlationId,
          causationSeq: input.causationSeq,
          refs: input.refs,
          bodyVersion: input.bodyVersion,
          body: input.body,
        };
        reduceDiscussProjection(db, event);
      }

      const row = db
        .prepare(
          `SELECT state, last_seq
             FROM projection_discuss
            WHERE discuss_id = ?`,
        )
        .get(events[0]?.sessionId) as
        | {
            state: string;
            last_seq: number;
          }
        | undefined;

      expect(row).toBeDefined();
      expect(row?.state).toBe(expectedState);
      expect(row?.last_seq).toBe(events.length);
    } finally {
      db.close();
    }
  });
});
