import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { CoralStore } from '#src/read-model/coral-store.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers, defineDomainEvent } from '#src/store/reducers.js';
import { createCauseRefRenderer } from '#src/causality/render.js';
import { defaultEventDescribers } from '#src/read-model/event-describers.js';
import { resultPathFor } from '#src/jobs/terminal/export.js';
import { JobStore } from '#src/jobs/store.js';
import { jobTerminalRecordedBodySchema } from '#src/jobs/terminal/result.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { z } from 'zod';

const renderer = createCauseRefRenderer(defaultEventDescribers);

const NOW = new Date('2026-04-19T00:00:00.000Z');
const causeFixtureBodySchema = z.object({}).passthrough();
const causeFixtureRegistry = composeReducers(
  {
    streamKind: 'job',
    entries: [
      defineDomainEvent({ type: 'job.progress.emitted', schema: causeFixtureBodySchema }),
      defineDomainEvent({ type: 'job.terminal.recorded', schema: jobTerminalRecordedBodySchema }),
    ],
  },
  {
    streamKind: 'session',
    entries: ['session.provider_failed', 'session.interrupted'].map((type) =>
      defineDomainEvent({ type, schema: causeFixtureBodySchema }),
    ),
  },
  {
    streamKind: 'workflow',
    entries: ['workflow.lifecycle_fault', 'workflow.completed'].map((type) =>
      defineDomainEvent({ type, schema: causeFixtureBodySchema }),
    ),
  },
);

function createStore(runtime = new SimulationRuntime()): { db: Database; store: CoralStore; jobStore: JobStore } {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  const bodyCodec = createEventBodyCodec();
  const store = new CoralStore(db, {
    schemas: causeFixtureRegistry.schemas,
    streamKinds: causeFixtureRegistry.streamKinds,
    bodyCodec,
  });
  return {
    db,
    store,
    jobStore: new JobStore('cause-ref-test', runtime, bodyCodec, {
      db,
      reducers: causeFixtureRegistry,
      providers: permissiveProviderLookupPort,
      describeCauseRef: (ref) => renderer.describe(ref, store),
    }),
  };
}

function insertEvent(
  db: Database,
  input: {
    seq: number;
    type: string;
    stream: { kind: 'job' | 'session' | 'workflow' | 'discuss'; id: string };
    body: unknown;
  },
): void {
  db.prepare(
    `INSERT INTO events (
      seq, ts, type, stream_kind, stream_id, namespace, project, correlation_id, causation_seq, refs, body
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)`,
  ).run(
    input.seq,
    NOW.toISOString(),
    input.type,
    input.stream.kind,
    input.stream.id,
    Buffer.from(JSON.stringify(input.body), 'utf-8'),
  );
}

describe('describeCauseRef', () => {
  it('materializes empty failures with canonical session, workflow, missing-link, and cycle descriptions', () => {
    const runtime = new SimulationRuntime();
    const { db, jobStore } = createStore(runtime);
    const insertTerminal = (seq: number, jobId: string, causeRef: unknown) => {
      insertEvent(db, {
        seq,
        type: 'job.terminal.recorded',
        stream: { kind: 'job', id: jobId },
        body: {
          terminal: { content: '', durationMs: 10, outcome: { kind: 'failed', causeRef } },
        },
      });
    };
    const materialize = (jobId: string) => {
      jobStore.materializeResultArtifact(jobId);
      return runtime.storage.readFileSync(resultPathFor(runtime.paths.coral.exports.jobsRoot, jobId), 'utf-8');
    };

    try {
      insertEvent(db, {
        seq: 1,
        type: 'session.interrupted',
        stream: { kind: 'session', id: 'session-interrupted' },
        body: { trigger: 'restart', continuity: 'pre_checkpoint_preserved' },
      });
      insertTerminal(2, 'job-session', { stream: { kind: 'session', id: 'session-interrupted' }, seq: 1 });

      insertEvent(db, {
        seq: 3,
        type: 'workflow.lifecycle_fault',
        stream: { kind: 'workflow', id: 'workflow-failed' },
        body: { kind: 'wrapper_crashed', message: 'executor broke', stack: 'STACK: workflow executor' },
      });
      insertEvent(db, {
        seq: 4,
        type: 'workflow.completed',
        stream: { kind: 'workflow', id: 'workflow-failed' },
        body: {
          outcome: 'failed',
          causeRef: { stream: { kind: 'workflow', id: 'workflow-failed' }, seq: 3 },
          failureLocation: { stepIndex: 2, atomLabel: 'critic', slotId: 'workflow-failed:2:0' },
          stepDetails: [],
        },
      });
      insertTerminal(5, 'job-workflow', { stream: { kind: 'workflow', id: 'workflow-failed' }, seq: 4 });

      insertTerminal(6, 'job-missing', { stream: { kind: 'session', id: 'missing-session' }, seq: 999 });

      insertEvent(db, {
        seq: 7,
        type: 'job.progress.emitted',
        stream: { kind: 'job', id: 'cycle-a' },
        body: {
          kind: 'message',
          message: 'cycle a',
          causeRef: { stream: { kind: 'session', id: 'cycle-b' }, seq: 8 },
        },
      });
      insertEvent(db, {
        seq: 8,
        type: 'session.provider_failed',
        stream: { kind: 'session', id: 'cycle-b' },
        body: {
          provider: 'codex',
          reason: 'request_failed',
          message: 'cycle b',
          causeRef: { stream: { kind: 'job', id: 'cycle-a' }, seq: 7 },
        },
      });
      insertTerminal(9, 'job-cycle', { stream: { kind: 'job', id: 'cycle-a' }, seq: 7 });

      expect(materialize('job-session')).toContain(
        'App-server restarted during the turn; existing conversation reference was preserved.',
      );
      const workflow = materialize('job-workflow');
      expect(workflow).toContain("Workflow failed. Failure at step 2, atom 'critic', slot workflow-failed:2:0.");
      expect(workflow).toContain('STACK: workflow executor');
      expect(materialize('job-missing')).toContain('<missing session/missing-session/999>');
      expect(materialize('job-cycle')).toContain('<cycle detected at job/cycle-a/7>');
    } finally {
      db.close();
    }
  });

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

      const result = renderer.describeDetailed(
        {
          stream: { kind: 'job', id: 'job-missing-link' },
          seq: 3,
        },
        store,
      );

      expect(result.description).toContain('<missing session/session-missing-link/2>');
      expect(result.missing).toEqual({
        stream: { kind: 'session', id: 'session-missing-link' },
        seq: 2,
        path: ['Failed: session/session-missing-link#2'],
      });
    } finally {
      db.close();
    }
  });
});
