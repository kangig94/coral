import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { currentBuildFlavor } from '#src/infra/paths.js';
import { readProgressLog, readStatusRecord } from '#tests/helpers/persistence-readers.js';
import { openStoreDatabase } from '#src/store/db.js';
import { ensureStoreSchemasDir } from '#src/store/schema-loader.js';
import { storePaths } from '#src/store/paths.js';
import { createRealRuntime } from '#src/runtime/real.js';

const originalHome = process.env.HOME;

let testJobId: string;
let testHomeDir: string;

const NOW = '2026-01-01T00:00:00Z';
const nodeStoreStorage = createRealRuntime().storage;

function withWritableStore(write: (db: ReturnType<typeof openStoreDatabase>) => void): void {
  const db = openStoreDatabase({
    path: storePaths(currentBuildFlavor()).dbFile,
    storage: nodeStoreStorage,
    schemasDir: ensureStoreSchemasDir(nodeStoreStorage),
  });

  try {
    write(db);
  } finally {
    db.close();
  }
}

function makeLaunchBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 's1',
    provider: 'codex',
    projectRoot: '/tmp/project',
    backendNamespace: 'ns',
    jobKind: 'provider',
    pool: 'default',
    enqueueSequence: 0,
    providerAction: 'exec',
    request: {
      prompt: 'hello',
      cwd: '/tmp/project',
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: NOW,
    ...overrides,
  };
}

function insertJobEvent(
  db: ReturnType<typeof openStoreDatabase>,
  {
    jobId = testJobId,
    type,
    body,
    ts = NOW,
  }: {
    jobId?: string;
    type: string;
    body: string | Record<string, unknown>;
    ts?: string;
  },
): number {
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf-8') : Buffer.from(JSON.stringify(body), 'utf-8');
  const result = db
    .prepare(
      `INSERT INTO events (
         ts,
         type,
         stream_kind,
         stream_id,
         namespace,
         project,
         refs,
         body_version,
         body
       ) VALUES (?, ?, 'job', ?, 'ns', '/tmp/project', ?, 1, ?)`,
    )
    .run(ts, type, jobId, JSON.stringify({ jobId }), payload);
  return Number(result.lastInsertRowid);
}

function seedJobProjection(
  options: {
    jobId?: string;
    phase?: string;
    launchBody?: string | Record<string, unknown> | null;
    events?: Array<{ type: string; body: string | Record<string, unknown>; ts?: string }>;
    sessionId?: string;
    provider?: string;
    projectRoot?: string;
    backendNamespace?: string;
    jobKind?: 'provider' | 'workflow';
    createdAt?: string;
  } = {},
): void {
  const jobId = options.jobId ?? testJobId;
  withWritableStore((db) => {
    let lastSeq = 0;
    if (options.launchBody !== null) {
      lastSeq = insertJobEvent(db, {
        jobId,
        type: 'job.launch.requested',
        body: options.launchBody ?? makeLaunchBody(),
      });
    }
    for (const event of options.events ?? []) {
      lastSeq = insertJobEvent(db, { jobId, ...event });
    }

    db.prepare(
      `INSERT INTO projection_jobs (
         job_id,
         phase,
         terminal,
         diagnostics,
         session_id,
         provider,
         project_root,
         backend_namespace,
         bundle_hash,
         job_kind,
         parent_workflow_job_id,
         workflow_slot,
         created_at,
         last_seq
       ) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?)`,
    ).run(
      jobId,
      options.phase ?? 'running',
      options.sessionId ?? 's1',
      options.provider ?? 'codex',
      options.projectRoot ?? '/tmp/project',
      options.backendNamespace ?? 'ns',
      options.jobKind === 'workflow' ? 'workflow' : 'provider',
      options.createdAt ?? NOW,
      lastSeq,
    );
  });
}

beforeEach(() => {
  testJobId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  testHomeDir = mkdtempSync(join(tmpdir(), 'coral-readers-home-'));
  process.env.HOME = testHomeDir;
});

afterEach(() => {
  rmSync(testHomeDir, { recursive: true, force: true });
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

describe('readStatusRecord', () => {
  it('returns a valid status record with all required fields', () => {
    seedJobProjection({ phase: 'completed' });
    const result = readStatusRecord(testJobId);
    expect(result).not.toBeNull();
    expect(result!.jobId).toBe(testJobId);
    expect(result!.sessionId).toBe('s1');
    expect(result!.provider).toBe('codex');
    expect(result!.projectRoot).toBe('/tmp/project');
    expect(result!.backendNamespace).toBe('ns');
    expect(result!.phase).toBe('completed');
    expect(result!.updatedAt).toBe(NOW);
  });

  it('returns null when the projection store has no matching job', () => {
    expect(readStatusRecord(testJobId)).toBeNull();
  });

  it('throws when the launch event body is invalid JSON', () => {
    seedJobProjection({ launchBody: 'not json' });
    expect(() => readStatusRecord(testJobId)).toThrow();
  });

  it('throws when the launch event body has the wrong shape', () => {
    seedJobProjection({ launchBody: { jobId: 'wrong-shape' } });
    expect(() => readStatusRecord(testJobId)).toThrow();
  });

  it('returns the projection-backed status when the launch request event is absent', () => {
    seedJobProjection({ launchBody: null });
    expect(readStatusRecord(testJobId)).toEqual({
      jobId: testJobId,
      sessionId: 's1',
      provider: 'codex',
      projectRoot: '/tmp/project',
      backendNamespace: 'ns',
      jobKind: 'provider',
      phase: 'running',
      updatedAt: NOW,
      lastSeq: 0,
    });
  });

  it('throws when the launch request body contains unexpected fields under the journal schema', () => {
    seedJobProjection({ launchBody: { ...makeLaunchBody(), futureField: true } });
    expect(() => readStatusRecord(testJobId)).toThrow();
  });
});

describe('readProgressLog', () => {
  it('returns valid progress entries with all required fields', () => {
    seedJobProjection({
      phase: 'running',
      events: [{ type: 'job.progress.emitted', body: { kind: 'message', message: 'working' } }],
    });
    const result = readProgressLog(testJobId);
    expect(result).toHaveLength(1);
    expect(result[0].jobId).toBe(testJobId);
    expect(result[0].sessionId).toBe('s1');
    expect(result[0].seq).toBe(2);
    expect(result[0].type).toBe('progress');
    expect(result[0].ts).toBe(NOW);
    expect(result[0].message).toBe('working');
  });

  it('returns empty array when the projection store has no matching job', () => {
    expect(readProgressLog(testJobId)).toEqual([]);
  });

  it('throws when a progress event body is invalid JSON', () => {
    seedJobProjection({
      phase: 'running',
      events: [{ type: 'job.progress.emitted', body: 'not json' }],
    });
    expect(() => readProgressLog(testJobId)).toThrow();
  });

  it('throws when a progress event body has the wrong shape', () => {
    seedJobProjection({
      phase: 'running',
      events: [{ type: 'job.progress.emitted', body: { message: 'working' } }],
    });
    expect(() => readProgressLog(testJobId)).toThrow();
  });

  it('skips non-message job progress events that do not surface to the client', () => {
    seedJobProjection({
      phase: 'running',
      events: [{ type: 'job.progress.emitted', body: { kind: 'missing_launch_record' } }],
    });
    expect(readProgressLog(testJobId)).toEqual([]);
  });

  it('throws when a progress event body contains unexpected fields', () => {
    seedJobProjection({
      phase: 'running',
      events: [{ type: 'job.progress.emitted', body: { kind: 'message', message: 'working', futureField: 'data' } }],
    });
    expect(() => readProgressLog(testJobId)).toThrow();
  });

  it('returns terminal records from journal events when present', () => {
    seedJobProjection({
      phase: 'completed',
      events: [
        {
          type: 'job.terminal.recorded',
          body: {
            outcome: { kind: 'completed' },
            durationMs: 1,
            content: 'done',
          },
        },
      ],
    });

    expect(readProgressLog(testJobId)).toEqual([
      {
        jobId: testJobId,
        sessionId: 's1',
        seq: 2,
        type: 'terminal',
        ts: NOW,
        result: {
          content: 'done',
          durationMs: 1,
          outcome: { kind: 'completed' },
        },
        continuity: null,
      },
    ]);
  });
});
