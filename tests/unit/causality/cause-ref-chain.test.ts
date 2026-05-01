import * as fs from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { StoreReadContext } from '#src/store/body-codec.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { CoralStore } from '#src/read-model/coral-store.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { createCauseRefRenderer } from '#src/causality/render.js';
import { defaultEventDescribers } from '#src/read-model/event-describers.js';

const renderer = createCauseRefRenderer(defaultEventDescribers);

const SCHEMAS_DIR = join(process.cwd(), 'src/store/schemas');
const storageAdapter = {
  readdirSync: (path: string, opts: { withFileTypes: true }) => fs.readdirSync(path, opts),
  readFileSync: (path: string, enc: 'utf-8') => fs.readFileSync(path, enc),
};
const NOW = new Date('2026-04-19T00:00:00.000Z');
const RAW_EVENT_READ_CTX: StoreReadContext = {
  schemas: new Map(),
  upcasters: createDefaultUpcasterRegistry(),
};

function createStore(): { db: InstanceType<typeof Database>; store: CoralStore } {
  const db = new Database(':memory:');
  applyStoreSchemas({ db, storage: storageAdapter as never, schemasDir: SCHEMAS_DIR });
  return { db, store: new CoralStore(db, RAW_EVENT_READ_CTX) };
}

function insertEvent(
  db: InstanceType<typeof Database>,
  input: {
    seq: number;
    type: string;
    stream: { kind: 'job' | 'session' | 'workflow' | 'discuss'; id: string };
    body: unknown;
  },
): void {
  db.prepare(
    `INSERT INTO events (
      seq, ts, type, stream_kind, stream_id, namespace, project, correlation_id, causation_seq, refs, body_version, body
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(
    input.seq,
    NOW.toISOString(),
    input.type,
    input.stream.kind,
    input.stream.id,
    1,
    Buffer.from(JSON.stringify(input.body), 'utf-8'),
  );
}

describe('describeCauseRef', () => {
  it('walks a four-link jobs -> session -> jobs -> workflow chain', () => {
    const { db, store } = createStore();
    try {
      insertEvent(db, {
        seq: 1,
        type: 'workflow.lifecycle_fault',
        stream: { kind: 'workflow', id: 'workflow-1' },
        body: { kind: 'unknown', message: 'workflow cause recorded' },
      });
      insertEvent(db, {
        seq: 2,
        type: 'workflow.completed',
        stream: { kind: 'workflow', id: 'workflow-1' },
        body: {
          outcome: 'failed',
          causeRef: { stream: { kind: 'workflow', id: 'workflow-1' }, seq: 1 },
          stepDetails: [],
        },
      });
      insertEvent(db, {
        seq: 3,
        type: 'job.progress.emitted',
        stream: { kind: 'job', id: 'job-2' },
        body: {
          kind: 'message',
          message: 'Recovered child job checkpoint.',
          causeRef: {
            stream: { kind: 'workflow', id: 'workflow-1' },
            seq: 2,
          },
        },
      });
      insertEvent(db, {
        seq: 4,
        type: 'session.provider_failed',
        stream: { kind: 'session', id: 'session-1' },
        body: {
          provider: 'codex',
          reason: 'request_failed',
          message: 'transport reset',
          causeRef: {
            stream: { kind: 'job', id: 'job-2' },
            seq: 3,
          },
        },
      });
      insertEvent(db, {
        seq: 5,
        type: 'job.terminal.recorded',
        stream: { kind: 'job', id: 'job-1' },
        body: {
          terminal: {
            outcome: {
              kind: 'failed',
              causeRef: {
                stream: { kind: 'session', id: 'session-1' },
                seq: 4,
              },
            },
            content: '',
            durationMs: 500,
          },
        },
      });

      const description = renderer.describe(
        {
          stream: { kind: 'job', id: 'job-1' },
          seq: 5,
        },
        store,
      );

      expect(description).toContain('Failed: session/session-1#4');
      expect(description).toContain('codex turn failed: transport reset.');
      expect(description).toContain('Recovered child job checkpoint.');
      expect(description).toContain('Workflow failed.');
    } finally {
      db.close();
    }
  });

  it('terminates on cycles and exposes the cycle marker', () => {
    const { db, store } = createStore();
    try {
      insertEvent(db, {
        seq: 1,
        type: 'job.progress.emitted',
        stream: { kind: 'job', id: 'job-cycle' },
        body: {
          kind: 'message',
          message: 'loop a',
          causeRef: {
            stream: { kind: 'session', id: 'session-cycle' },
            seq: 2,
          },
        },
      });
      insertEvent(db, {
        seq: 2,
        type: 'session.provider_failed',
        stream: { kind: 'session', id: 'session-cycle' },
        body: {
          provider: 'codex',
          reason: 'request_failed',
          message: 'loop b',
          causeRef: {
            stream: { kind: 'job', id: 'job-cycle' },
            seq: 1,
          },
        },
      });

      const result = renderer.describeDetailed(
        {
          stream: { kind: 'job', id: 'job-cycle' },
          seq: 1,
        },
        store,
      );

      expect(result.description).toContain('<cycle detected at job/job-cycle/1>');
      expect(result.cycle).toEqual({
        key: 'job:job-cycle:1',
        stream: { kind: 'job', id: 'job-cycle' },
        seq: 1,
        path: ['loop a', 'codex turn failed: loop b.'],
      });
    } finally {
      db.close();
    }
  });

  it('renders the missing marker when a non-root causeRef link cannot be loaded', () => {
    const { db, store } = createStore();
    try {
      insertEvent(db, {
        seq: 1,
        type: 'workflow.lifecycle_fault',
        stream: { kind: 'workflow', id: 'workflow-root' },
        body: { kind: 'unknown', message: 'workflow root cause' },
      });
      insertEvent(db, {
        seq: 2,
        type: 'workflow.completed',
        stream: { kind: 'workflow', id: 'workflow-root' },
        body: {
          outcome: 'failed',
          causeRef: { stream: { kind: 'workflow', id: 'workflow-root' }, seq: 1 },
          stepDetails: [],
        },
      });
      insertEvent(db, {
        seq: 3,
        type: 'job.terminal.recorded',
        stream: { kind: 'job', id: 'job-missing-link' },
        body: {
          terminal: {
            outcome: {
              kind: 'failed',
              causeRef: {
                stream: { kind: 'session', id: 'session-missing-link' },
                seq: 2,
              },
            },
            content: '',
            durationMs: 10,
          },
        },
      });

      const description = renderer.describe(
        {
          stream: { kind: 'job', id: 'job-missing-link' },
          seq: 3,
        },
        store,
      );

      expect(description).toContain('<missing session/session-missing-link/2>');
    } finally {
      db.close();
    }
  });
});
