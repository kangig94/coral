import { expect, it } from 'vitest';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';
import { buildJobEventRefs } from '#src/jobs/refs.js';
import { readJobProgressPage } from '#src/jobs/read-queries.js';
import { readHistoricalProgressPage } from '#src/jobs/historical-reader.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { initTestJob } from '#tests/helpers/session.js';
import type { SqliteDatabasePort } from '#src/infra/port-types.js';

it.each(['active', 'historical'] as const)(
  '%s SQL pages count raw progress and preserve each ordered window',
  (mode) => {
    const f = createTerminalExportFixture();
    const historical = newRawDatabase(':memory:');
    try {
      initTestJob(f.store, {
        jobId: 'sibling',
        sessionId: 'sibling-session',
        provider: 'claude',
        projectRoot: f.root,
        backendNamespace: 'fixture',
      });
      for (let index = 0; index < 7; index++) {
        f.store.appendProgress(f.jobId, 'session-1', `message-${index}`);
        f.store.appendProgress('sibling', 'sibling-session', `unrelated-${index}`);
        if (index < 3)
          f.store.commit((c) => {
            c.append({
              type: 'job.progress.emitted',
              stream: { kind: 'job', id: f.jobId },
              namespace: 'fixture',
              project: f.root,
              refs: buildJobEventRefs({ jobId: f.jobId, sessionId: 'session-1' }),
              body: { kind: 'domain', stage: 'hosted_kb_operation_failed', message: 'fault', detail: {} },
            });
            return undefined;
          });
      }
      f.complete();
      historical.exec(
        'CREATE TABLE events(seq INTEGER PRIMARY KEY, ts TEXT, type TEXT, body BLOB, stream_kind TEXT, stream_id TEXT); CREATE INDEX events_logical_stream ON events(type, stream_id, seq)',
      );
      const insert = historical.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)');
      for (const row of f.db.prepare('SELECT seq, ts, type, body, stream_kind, stream_id FROM events').all()) {
        const value = row as {
          seq: number;
          ts: string;
          type: string;
          body: Uint8Array;
          stream_kind: string;
          stream_id: string;
        };
        insert.run(value.seq, value.ts, value.type, value.body, value.stream_kind, value.stream_id);
      }
      const frontier = (f.db.prepare('SELECT MAX(seq) AS seq FROM events').get() as { seq: number }).seq;
      const pages = [];
      let after = 0;
      for (let count = 0; count < 10; count++) {
        const page =
          mode === 'active'
            ? readJobProgressPage(f.db, f.jobId, f.store, after, 2, frontier)
            : readHistoricalProgressPage(historical as SqliteDatabasePort, f.jobId, after, 2, frontier);
        pages.push(page);
        expect(page.through).toBeGreaterThan(after);
        after = page.through;
        if (page.exhausted) break;
      }
      expect(pages).toHaveLength(5);
      expect(pages.slice(0, -1).every((page) => !page.exhausted)).toBe(true);
      expect(pages.at(-1)).toMatchObject({ through: frontier, exhausted: true });
      expect(pages.flatMap((page) => page.rows.map((row) => row.message))).toEqual(
        Array.from({ length: 7 }, (_, index) => `message-${index}`),
      );
      const plan = JSON.stringify(
        (mode === 'active' ? f.db : historical)
          .prepare(
            "EXPLAIN QUERY PLAN SELECT * FROM events WHERE type = 'job.progress.emitted' AND stream_id = ? AND seq > ? ORDER BY seq LIMIT ?",
          )
          .all(f.jobId, 0, 3),
      );
      expect(plan).toContain('events_logical_stream');
      expect(plan).not.toContain('TEMP B-TREE');
    } finally {
      historical.close();
      f.close();
    }
  },
);
