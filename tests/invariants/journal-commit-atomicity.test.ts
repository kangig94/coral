import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { KbJobRecorder } from '#src/coordinator/services/kb-job-recorder.js';
import { JobStore } from '#src/jobs/job-store.js';
import type { StoragePort } from '#src/runtime/ports.js';
import { decodeEventBody, encodeEventBody } from '#src/store/body-codec.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcasters.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

const REPO_ROOT = process.cwd();
const NOW = '2026-04-19T00:00:00.000Z';
const KB_RECORDER_PATH = 'src/coordinator/services/kb-job-recorder.ts';
const KB_SOURCE_IMPORT_SERVICE_PATH = 'src/coordinator/services/kb-source-import-service.ts';
const KB_REINDEX_SERVICE_PATH = 'src/coordinator/services/kb-reindex-service.ts';

const nodeStorage: Pick<StoragePort, 'readFileSync' | 'readdirSync'> = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readdirSync: (path, options) => readdirSync(path, options),
};

type Db = InstanceType<typeof Database>;

type OrphanKbFailureRow = {
  cause_seq: number;
  stream_kind: string;
  stream_id: string;
};

const ORPHAN_KB_OPERATION_FAILURES_SQL = `
  SELECT p.seq AS cause_seq, p.stream_kind, p.stream_id
    FROM events p
   WHERE p.type = 'job.progress.emitted'
     AND json_extract(CAST(p.body AS TEXT), '$.kind') = 'domain'
     AND json_extract(CAST(p.body AS TEXT), '$.stage') = 'kb_operation_failed'
     AND NOT EXISTS (
           SELECT 1
             FROM events t
            WHERE t.stream_kind = p.stream_kind
              AND t.stream_id = p.stream_id
              AND t.type = 'job.terminal.recorded'
              AND json_extract(CAST(t.body AS TEXT), '$.terminal.outcome.kind') = 'failed'
         )
   ORDER BY p.seq ASC
`;

function createDb(): Db {
  const db = new Database(':memory:');
  applyStoreSchemas({ db, storage: nodeStorage });
  return db;
}

function scanTerminalCausingKbOperationFailureOrphans(db: Db): OrphanKbFailureRow[] {
  return db.prepare(ORPHAN_KB_OPERATION_FAILURES_SQL).all() as OrphanKbFailureRow[];
}

function assertNoTerminalCausingKbOperationFailureOrphans(db: Db): void {
  const orphans = scanTerminalCausingKbOperationFailureOrphans(db);
  if (orphans.length > 0) {
    throw new Error(`orphan terminal-causing kb_operation_failed rows: ${JSON.stringify(orphans)}`);
  }
}

function insertOrphanKbOperationFailure(db: Db): void {
  db.prepare(
    `INSERT INTO events (ts, type, stream_kind, stream_id, namespace, project, refs, body_version, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    NOW,
    'job.progress.emitted',
    'job',
    'job-orphan',
    'test-ns',
    '/workspace/orphan',
    JSON.stringify({ jobId: 'job-orphan' }),
    1,
    encodeEventBody({
      kind: 'domain',
      stage: 'kb_operation_failed',
      message: 'KB reindex failed: index unavailable',
      detail: { operation: 'reindex', cause: { message: 'index unavailable' } },
      ts: NOW,
    }),
  );
}

function readSource(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

describe('journal commit atomicity invariant', () => {
  it('finds no orphan terminal-causing KB operation failure after the migrated recorder path', () => {
    const db = createDb();
    try {
      const runtime = new SimulationRuntime();
      const progressStore = new JobStore('test-ns', runtime, createDefaultUpcasterRegistry(), { db });
      const recorder = new KbJobRecorder({
        runtime,
        progressStore,
        backendNamespace: 'test-ns',
        bundleHash: 'bundle-a',
      });

      const { jobId, startedAtMs } = recorder.startInternalJob({
        projectRoot: '/workspace/coral',
        operation: 'kb.reindex',
        request: {},
      });
      recorder.appendOperationFailureWithTerminal({
        jobId,
        projectRoot: '/workspace/coral',
        operation: 'reindex',
        message: 'KB reindex failed: index unavailable',
        detail: { operation: 'reindex', cause: { message: 'index unavailable' } },
        startedAtMs,
      });

      expect(scanTerminalCausingKbOperationFailureOrphans(db)).toEqual([]);
      assertNoTerminalCausingKbOperationFailureOrphans(db);

      const rows = db
        .prepare(
          `SELECT seq, type, body
             FROM events
            WHERE stream_kind = 'job'
              AND stream_id = ?
            ORDER BY seq ASC`,
        )
        .all(jobId) as Array<{ seq: number; type: string; body: Buffer }>;
      expect(rows.map((row) => row.type)).toEqual([
        'job.launch.requested',
        'job.runtime.started',
        'job.progress.emitted',
        'job.terminal.recorded',
      ]);

      const progress = rows[2];
      const terminal = rows[3];
      expect(progress).toBeDefined();
      expect(terminal).toBeDefined();
      if (progress === undefined || terminal === undefined) {
        throw new Error('Expected migrated KB recorder to append progress and terminal rows.');
      }
      const progressBody = decodeEventBody(progress.body);
      const terminalBody = decodeEventBody(terminal.body);

      expect(progressBody).toMatchObject({
        kind: 'domain',
        stage: 'kb_operation_failed',
      });
      expect(terminalBody).toMatchObject({
        terminal: {
          outcome: {
            kind: 'failed',
            causeRef: { stream: { kind: 'job', id: jobId }, seq: progress.seq },
          },
        },
      });
      expect(terminal.seq).toBe(progress.seq + 1);
    } finally {
      db.close();
    }
  });

  it('fails the persisted-state scan for a manually inserted orphan KB operation failure', () => {
    const db = createDb();
    try {
      insertOrphanKbOperationFailure(db);

      expect(scanTerminalCausingKbOperationFailureOrphans(db)).toEqual([
        { cause_seq: 1, stream_kind: 'job', stream_id: 'job-orphan' },
      ]);
      expect(() => assertNoTerminalCausingKbOperationFailureOrphans(db)).toThrow(
        /orphan terminal-causing kb_operation_failed rows/u,
      );
    } finally {
      db.close();
    }
  });

  it('keeps the KB producer structurally collapsed to one commit closure with no caller-side seq handoff', () => {
    const recorderSource = readSource(KB_RECORDER_PATH);
    const sourceImportSource = readSource(KB_SOURCE_IMPORT_SERVICE_PATH);
    const reindexSource = readSource(KB_REINDEX_SERVICE_PATH);
    const migratedCallers = `${sourceImportSource}\n${reindexSource}`;

    expect(recorderSource).toContain('appendOperationFailureWithTerminal');
    expect(recorderSource.match(/this\.deps\.progressStore\.commit\(\(c\) =>/gu) ?? []).toHaveLength(1);
    expect(recorderSource).toMatch(/const cause = c\.append\(causeEvent\);[\s\S]*causeRef: cause/u);
    expect(recorderSource).not.toContain('appendKbOperationFailureCause');
    expect(recorderSource).not.toContain('appendFailed');
    expect(recorderSource).not.toContain('appendEventsWithResult');

    expect(migratedCallers).toContain('appendOperationFailureWithTerminal');
    expect(migratedCallers).not.toContain('appendKbOperationFailureCause');
    expect(migratedCallers).not.toContain('appendFailed');
    expect(migratedCallers).not.toMatch(/\bcauseRef\b|\bseq\b/u);
  });
});
