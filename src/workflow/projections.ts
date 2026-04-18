import { mkdirSync as nodeMkdirSync, readFileSync as nodeReadFileSync, readdirSync as nodeReaddirSync } from 'node:fs';

import type BetterSqlite3 from 'better-sqlite3';

import { currentBuildFlavor } from '../infra/paths.js';
import { CoralStore } from '../store/index.js';
import { openStoreDatabase } from '../store/db.js';
import { appendEvents } from '../store/append.js';
import { createEmptyRegistry, type CoralEventInput } from '../store/envelope.js';
import { composeReducers } from '../store/reducers.js';
import { storePaths } from '../store/paths.js';
import type { RuntimeStoragePort } from '../runtime/ports.js';
import { workflowCompletedBodySchema, workflowDrainEnteredBodySchema, workflowRegistry } from './events.js';
import { workflowPlanSchema, type WorkflowPlan } from './plan.js';

const workflowReducers = composeReducers(workflowRegistry);
const upcasters = createEmptyRegistry();
const inMemoryJournalByStorage = new WeakMap<RuntimeStoragePort, BetterSqlite3.Database>();
const migrationStorage = {
  mkdirSync: nodeMkdirSync,
  readFileSync: nodeReadFileSync,
  readdirSync: nodeReaddirSync,
} as unknown as RuntimeStoragePort;

export type WorkflowProjectionRow = {
  workflowId: string;
  plan: WorkflowPlan;
  lastSeq: number;
};

export type ProjectionJobRow = {
  phase: string;
  lastSeq: number;
};

function storeDbPath(): string {
  return storePaths(currentBuildFlavor()).dbFile;
}

function isInMemoryStorage(storage: RuntimeStoragePort): boolean {
  return storage.constructor?.name === 'InMemoryStorage';
}

function openWorkflowDatabase(storage: RuntimeStoragePort): { db: BetterSqlite3.Database; persistent: boolean } {
  if (isInMemoryStorage(storage)) {
    const cached = inMemoryJournalByStorage.get(storage);
    if (cached) {
      return { db: cached, persistent: true };
    }

    const created = openStoreDatabase({
      path: ':memory:',
      storage: migrationStorage,
    });
    inMemoryJournalByStorage.set(storage, created);
    return { db: created, persistent: true };
  }

  return {
    db: openStoreDatabase({
      path: storeDbPath(),
      storage: migrationStorage,
    }),
    persistent: false,
  };
}

function withWorkflowDatabase<T>(storage: RuntimeStoragePort, fn: (db: BetterSqlite3.Database) => T): T {
  const { db, persistent } = openWorkflowDatabase(storage);
  try {
    return fn(db);
  } finally {
    if (!persistent) {
      db.close();
    }
  }
}

export type WorkflowJournal = {
  append(inputs: readonly CoralEventInput[]): void;
  describeCauseRef(ref: { stream: { kind: 'job' | 'session' | 'discuss' | 'workflow'; id: string }; seq: number }): string;
};

export function appendWorkflowEvents(db: BetterSqlite3.Database, inputs: readonly CoralEventInput[]): void {
  appendEvents(db, inputs, {
    now: () => new Date(),
    reducers: workflowReducers,
    upcasters,
  });
}

export function createWorkflowJournal(storage: RuntimeStoragePort): WorkflowJournal {
  return {
    append(inputs) {
      withWorkflowDatabase(storage, (db) => {
        appendWorkflowEvents(db, inputs);
      });
    },
    describeCauseRef(ref) {
      return withWorkflowDatabase(storage, (db) => {
        const store = new CoralStore(db);
        return store.getEvent(ref.stream, ref.seq) ? store.getEvent(ref.stream, ref.seq)?.type ?? `${ref.stream.kind}/${ref.stream.id}` : `${ref.stream.kind}/${ref.stream.id}#${ref.seq}`;
      });
    },
  };
}

export function readWorkflowProjection(db: BetterSqlite3.Database, workflowId: string): WorkflowProjectionRow | null {
  const row = db
    .prepare(
      `SELECT workflow_id, plan, last_seq
         FROM projection_workflows
        WHERE workflow_id = ?`,
    )
    .get(workflowId) as { workflow_id: string; plan: string; last_seq: number } | undefined;

  if (!row) {
    return null;
  }

  return {
    workflowId: row.workflow_id,
    plan: workflowPlanSchema.parse(JSON.parse(row.plan)),
    lastSeq: row.last_seq,
  };
}

export function listWorkflowProjections(db: BetterSqlite3.Database): WorkflowProjectionRow[] {
  const rows = db
    .prepare(`SELECT workflow_id, plan, last_seq FROM projection_workflows ORDER BY workflow_id`)
    .all() as Array<{ workflow_id: string; plan: string; last_seq: number }>;

  return rows.map((row) => ({
    workflowId: row.workflow_id,
    plan: workflowPlanSchema.parse(JSON.parse(row.plan)),
    lastSeq: row.last_seq,
  }));
}

export function readLatestWorkflowDrain(
  db: BetterSqlite3.Database,
  workflowId: string,
): { firstFailureSlotId: string; drainDeadline: number } | null {
  const row = db
    .prepare(
      `SELECT body
         FROM events
        WHERE stream_kind = 'workflow' AND stream_id = ? AND type = 'workflow.drain.entered'
        ORDER BY seq DESC
        LIMIT 1`,
    )
    .get(workflowId) as { body: Uint8Array | Buffer } | undefined;

  if (!row) {
    return null;
  }

  return workflowDrainEnteredBodySchema.parse(JSON.parse(new TextDecoder().decode(row.body)));
}

export function readLatestWorkflowCompletion(
  db: BetterSqlite3.Database,
  workflowId: string,
): { outcome: 'completed' | 'failed' | 'aborted'; causeRef?: { stream: { kind: 'job' | 'session' | 'discuss' | 'workflow'; id: string }; seq: number } } | null {
  const row = db
    .prepare(
      `SELECT body
         FROM events
        WHERE stream_kind = 'workflow' AND stream_id = ? AND type = 'workflow.completed'
        ORDER BY seq DESC
        LIMIT 1`,
    )
    .get(workflowId) as { body: Uint8Array | Buffer } | undefined;

  if (!row) {
    return null;
  }

  return workflowCompletedBodySchema.parse(JSON.parse(new TextDecoder().decode(row.body)));
}

export function readProjectionJob(db: BetterSqlite3.Database, jobId: string): ProjectionJobRow | null {
  const row = db
    .prepare(
      `SELECT phase, last_seq
         FROM projection_jobs
        WHERE job_id = ?`,
    )
    .get(jobId) as { phase: string; last_seq: number } | undefined;

  if (!row) {
    return null;
  }

  return {
    phase: row.phase,
    lastSeq: row.last_seq,
  };
}
