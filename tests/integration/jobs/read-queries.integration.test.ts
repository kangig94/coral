import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { visitJobProgress } from '#src/jobs/read-queries.js';
import { createDefaultStoreReadContext } from '#src/read-model/read-context.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { WaitSession } from '#src/jobs/wait/session.js';
import { admitted, savedCursor, testSession, TEST_EPOCH } from '#tests/helpers/wait-session.js';
import { selectWaitSnapshot } from '#src/jobs/wait/snapshot.js';
import type { ProgressVisit } from '#src/jobs/wait/contract.js';

describe('jobs/read-queries progress frontier', () => {
  it.each(['page', 'tail', 'internal'] as const)(
    'bounds a %s read by the frontier captured before a concurrent WAL append and delivers the append on resume',
    (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'coral-progress-frontier-'));
      const path = join(root, 'store.db');
      const reader = newRawDatabase(path);
      reader.exec('PRAGMA journal_mode=WAL');
      applyBundledStoreSchema(reader, currentCoralStoreFormat());
      const writer = newRawDatabase(path);
      const ctx = createDefaultStoreReadContext();
      const append = (message: string) =>
        writer
          .prepare('INSERT INTO events(ts, type, stream_kind, stream_id, refs, body) VALUES (?, ?, ?, ?, ?, ?)')
          .run(
            '2026-10-07T00:00:00Z',
            'job.progress.emitted',
            'job',
            'a',
            JSON.stringify({ jobId: 'a' }),
            Buffer.from(
              JSON.stringify({
                kind: 'message',
                message,
                timing: { origin: 'runtime', originAt: '', emittedAt: '', elapsedMs: 0 },
              }),
            ),
          );
      try {
        append('before');
        let appended = false;
        const visit: ProgressVisit = (_epoch, read) =>
          visitJobProgress(reader, ctx, (source) => {
            const appendAfterRead = <T>(rows: T): T => {
              if (!appended) {
                append('concurrent');
                appended = true;
              }
              return rows;
            };
            return read({
              ...source,
              after: (...args) => appendAfterRead(source.after(...args)),
              newest: (...args) => appendAfterRead(source.newest(...args)),
            });
          });
        const firstSession = new WaitSession(
          ['a'],
          mode === 'tail' ? undefined : savedCursor(0),
          TEST_EPOCH,
          mode === 'internal',
        );
        firstSession.reconcile([admitted('a', [], false)]);
        const first =
          mode === 'internal'
            ? firstSession.withProgress(visit, (sources) => {
                const selected = firstSession.select(sources, { lines: 500, bytes: 65536 }, null);
                firstSession.commit(selected);
                return { cursor: firstSession.cursor(), progress: selected.rows.map((row) => row.message) };
              })
            : (() => {
                const snapshot = selectWaitSnapshot(firstSession, 20, visit);
                return { cursor: snapshot.cursor, progress: snapshot.jobs[0].progress };
              })();
        expect(first).toEqual({ cursor: savedCursor(1), progress: ['before'] });
        const resumed = testSession(['a'], first.cursor!);
        resumed.reconcile([admitted('a', [], false)]);
        expect(selectWaitSnapshot(resumed, 20, visit).jobs[0].progress).toEqual(['concurrent']);

        const result = visitJobProgress(reader, ctx, (source) => {
          append('after frontier, before rows');
          return { frontier: source.frontier(), page: source.after('a', 0, 500), tail: source.newest('a', 500) };
        });
        expect(result.kind).toBe('read');
        if (result.kind !== 'read') throw new Error('expected a readable source');
        expect(result.value.frontier).toBe(2);
        expect(result.value.page.map((row) => row.message)).toEqual(['before', 'concurrent']);
        expect(result.value.tail.map((row) => row.message)).toEqual(['before', 'concurrent']);
      } finally {
        writer.close();
        reader.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
