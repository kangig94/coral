import { describe, expect, it } from 'vitest';

import {
  RecoveryContainment,
  defineRecoverySource,
  type RecoveryReceipt,
  type RecoverySource,
} from '#src/recovery/containment.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { discussionCandidateRecoverySource } from '#src/discuss/shell/discussion-candidate-recovery-source.js';
import { discussionSourceRecoverySource } from '#src/discuss/shell/discussion-source-recovery-source.js';
import {
  sessionProjectionRecoverySource,
  type RawSessionProjectionEnvelope,
  type SessionProjectionComponent,
} from '#src/sessions/projection-recovery-source.js';
import {
  sessionContinuationLeaseRecoverySource,
  type RawPendingContinuationLeaseRow,
  type SessionContinuationLeaseComponent,
} from '#src/sessions/continuation-lease-recovery-source.js';
import {
  terminalRetentionOutcomeRecoverySource,
  type RawTerminalRetentionOutcomeRow,
  type TerminalRetentionOutcomeComponent,
} from '#src/sessions/terminal-retention-outcome-recovery-source.js';
import {
  retentionReleasePairComponentSource,
  type RawRetentionReleaseAndTerminalRow,
  type RetentionReleasePairComponent,
} from '#src/sessions/retention-release-pair-recovery-source.js';
import {
  retentionWorkItemRecoverySource,
  type P4RetentionComponent,
} from '#src/sessions/retention-work-item-recovery-source.js';
import { workflowRecoverySource } from '#src/workflow/recovery-source.js';
import { staleJobCleanupSource } from '#src/jobs/stale-job-cleanup-recovery-source.js';
import { crashedJobTerminalizationSource } from '#src/jobs/crashed-job-terminalization-recovery-source.js';
import { coordinatorJobRecoverySource } from '#src/coordinator/services/recovery/coordinator-job-source.js';
import type { ProviderSession } from '#src/sessions/entry.js';
import type { EventsRow } from '#src/store/schema.js';
import { providerOperationRecordKeyPrefix } from '#src/store/provider-operation-journal.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

const REVISION_TIME = { now: () => Date.parse('2026-08-03T00:00:00.000Z') };

function createDiscussionEnvelopeDb() {
  const runtime = new SimulationRuntime();
  const db = openTestStoreDb(runtime, ':memory:');
  db.prepare(`INSERT INTO projection_discuss (discuss_id, state, last_seq) VALUES (?, ?, ?)`).run(
    'revision-discussion',
    '{"snapshot":"v1"}',
    10,
  );
  const insertEvent = db.prepare(
    `INSERT INTO events (
       seq, ts, type, stream_kind, stream_id, namespace, project,
       correlation_id, causation_seq, refs, body
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertEvent.run(
    1,
    '2026-08-03T00:00:00.000Z',
    'discuss.session.created',
    'discuss',
    'revision-discussion',
    'revision-namespace',
    '/revision/project',
    null,
    null,
    null,
    Buffer.from('{"sourceSeq":1}'),
  );
  db.prepare(
    `INSERT INTO projection_jobs (
       job_id, execution_owner, phase, terminal, diagnostics, session_id, provider,
       project_root, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
       workflow_slot, workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'revision-owned-job',
    JSON.stringify({ kind: 'discussion', id: 'revision-discussion' }),
    'running',
    null,
    '{}',
    'revision-provider-session',
    'codex',
    '/revision/project',
    'revision-namespace',
    'revision-bundle',
    'provider',
    null,
    null,
    null,
    null,
    '2026-08-03T00:00:01.000Z',
    2,
  );
  insertEvent.run(
    2,
    '2026-08-03T00:00:01.000Z',
    'job.launch.requested',
    'job',
    'revision-owned-job',
    'revision-namespace',
    '/revision/project',
    null,
    null,
    null,
    Buffer.from('{"jobKind":"provider"}'),
  );
  return db;
}

describe('discussion recovery source revisions', () => {
  it('skips an unchanged source row and re-attempts each changed encoded field', async () => {
    const db = createDiscussionEnvelopeDb();
    try {
      const quarantine = new RecoveryQuarantineStore(db, REVISION_TIME);
      let settlements = 0;
      const run = () =>
        RecoveryContainment.each(discussionSourceRecoverySource(db), {
          signal: new AbortController().signal,
          quarantine,
          processLocalCleanup: { kind: 'not-required' as const },
          hydrate: (raw) => raw,
          requiredObligations: () => [],
          settle: () => {
            settlements += 1;
            return { kind: 'quarantine' as const, detail: 'retain source revision' };
          },
          onFault: ({ error }) => ({ kind: 'fatal' as const, error }),
        });

      await run();
      expect(settlements).toBe(1);
      expect((await run()).skipped).toBe(1);
      expect(settlements).toBe(1);

      db.prepare(`UPDATE projection_discuss SET state = ? WHERE discuss_id = ?`).run(
        '{"snapshot":"v2"}',
        'revision-discussion',
      );
      await run();
      expect(settlements).toBe(2);
      expect((await run()).skipped).toBe(1);
      expect(settlements).toBe(2);

      db.prepare(`UPDATE projection_discuss SET last_seq = last_seq + 1 WHERE discuss_id = ?`).run(
        'revision-discussion',
      );
      await run();
      expect(settlements).toBe(3);
      expect((await run()).skipped).toBe(1);
      expect(settlements).toBe(3);
    } finally {
      db.close();
    }
  });

  const candidateMutations: ReadonlyArray<{
    name: string;
    mutate(db: ReturnType<typeof createDiscussionEnvelopeDb>): void;
  }> = [
    {
      name: 'discussion snapshot',
      mutate: (db) => {
        db.prepare(`UPDATE projection_discuss SET state = ? WHERE discuss_id = ?`).run(
          '{"snapshot":"changed"}',
          'revision-discussion',
        );
      },
    },
    {
      name: 'discussion projection sequence',
      mutate: (db) => {
        db.prepare(`UPDATE projection_discuss SET last_seq = last_seq + 1 WHERE discuss_id = ?`).run(
          'revision-discussion',
        );
      },
    },
    {
      name: 'discussion event body',
      mutate: (db) => {
        db.prepare(`UPDATE events SET body = ? WHERE seq = 1`).run(Buffer.from('{"sourceSeq":11}'));
      },
    },
    {
      name: 'discussion event refs',
      mutate: (db) => {
        db.prepare(`UPDATE events SET refs = ? WHERE seq = 1`).run('{"discussId":"revision-discussion"}');
      },
    },
    {
      name: 'discussion event sequence',
      mutate: (db) => {
        db.prepare(`UPDATE events SET seq = 11 WHERE seq = 1`).run();
      },
    },
    {
      name: 'owned-job projection',
      mutate: (db) => {
        db.prepare(`UPDATE projection_jobs SET diagnostics = ? WHERE job_id = ?`).run(
          '{"warning":"changed"}',
          'revision-owned-job',
        );
      },
    },
    {
      name: 'owned-job projection sequence',
      mutate: (db) => {
        db.prepare(`UPDATE projection_jobs SET last_seq = last_seq + 1 WHERE job_id = ?`).run('revision-owned-job');
      },
    },
    {
      name: 'owned-job event body',
      mutate: (db) => {
        db.prepare(`UPDATE events SET body = ? WHERE seq = 2`).run(
          Buffer.from('{"jobKind":"provider","changed":true}'),
        );
      },
    },
    {
      name: 'owned-job event refs',
      mutate: (db) => {
        db.prepare(`UPDATE events SET refs = ? WHERE seq = 2`).run('{"jobId":"revision-owned-job"}');
      },
    },
    {
      name: 'owned-job event sequence',
      mutate: (db) => {
        db.prepare(`UPDATE events SET seq = 12 WHERE seq = 2`).run();
      },
    },
    {
      name: 'discussion continuation payload',
      mutate: (db) => {
        db.prepare(
          `UPDATE recovery_quarantine
              SET state = 'continuation',
                  continuation_kind = 'discussion-resume.v1',
                  continuation_key = '{"completedObligationIds":[]}'
            WHERE boundary_id = 'discussion-candidate'
              AND subject_key = 'revision-discussion'`,
        ).run();
      },
    },
  ];

  for (const mutation of candidateMutations) {
    it(`re-attempts a candidate when its ${mutation.name} changes`, async () => {
      const db = createDiscussionEnvelopeDb();
      try {
        const quarantine = new RecoveryQuarantineStore(db, REVISION_TIME);
        let settlements = 0;
        const run = () =>
          RecoveryContainment.each(discussionCandidateRecoverySource(db), {
            signal: new AbortController().signal,
            quarantine,
            processLocalCleanup: { kind: 'not-required' as const },
            hydrate: (raw) => raw,
            requiredObligations: () => [],
            settle: (raw) => {
              settlements += 1;
              const continuation = rawContinuationToken(raw);
              if (continuation !== null) {
                return { kind: 'deferred' as const, continuation, detail: 'retain candidate continuation' };
              }
              return { kind: 'quarantine' as const, detail: 'retain candidate revision' };
            },
            onFault: ({ error }) => ({ kind: 'fatal' as const, error }),
          });

        await run();
        expect(settlements).toBe(1);
        expect((await run()).skipped).toBe(1);
        expect(settlements).toBe(1);

        mutation.mutate(db);
        await run();
        expect(settlements).toBe(2);
        expect((await run()).skipped).toBe(1);
        expect(settlements).toBe(2);
      } finally {
        db.close();
      }
    });
  }
});

const P4_NOW = '2026-08-03T00:00:00.000Z';

function p4Entry(overrides: Partial<ProviderSession> = {}): ProviderSession {
  return {
    sessionId: 'p4-session',
    binding: TEST_CODEX_BINDING,
    name: 'p4-session',
    state: 'pending',
    retention: 'discard_provider_artifacts_on_terminal',
    artifactHandles: [
      {
        handle: '/tmp/p4-artifact.jsonl',
        identity: { kind: 'fixture' },
        identityKey: 'fixture:p4-artifact',
        sourceJobId: 'p4-job',
        recordedAt: P4_NOW,
      },
    ],
    retentionDiscard: { attempts: [] },
    cwd: '/p4',
    projectRoot: '/p4',
    backendNamespace: 'p4-ns',
    providerContinuity: null,
    createdAt: P4_NOW,
    lastUsedAt: P4_NOW,
    version: 3,
    ...overrides,
  };
}

function createCoordinatorRevisionDb() {
  const runtime = new SimulationRuntime();
  const db = openTestStoreDb(runtime, ':memory:');
  const jobId = 'revision-coordinator-job';
  const sessionId = 'revision-coordinator-session';
  db.prepare(
    `INSERT INTO projection_jobs (
       job_id, execution_owner, phase, terminal, diagnostics, session_id, provider,
       project_root, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
       workflow_slot, workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobId,
    JSON.stringify({ kind: 'provider-session', id: sessionId }),
    'running',
    null,
    '{"progressFaults":[]}',
    sessionId,
    'codex',
    '/coordinator',
    'coordinator-ns',
    'coordinator-bundle',
    'provider',
    null,
    null,
    null,
    null,
    P4_NOW,
    3,
  );
  db.prepare(
    `INSERT INTO projection_sessions (
       session_id, controller, resumable, conversation_ref, scope_key, entry, last_seq
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    'default',
    0,
    null,
    'coordinator-scope',
    JSON.stringify(
      p4Entry({
        sessionId,
        name: sessionId,
        activeJobId: jobId,
        projectRoot: '/coordinator',
        cwd: '/coordinator',
        backendNamespace: 'coordinator-ns',
      }),
    ),
    4,
  );
  const insertCoordinatorEvent = db.prepare(
    `INSERT INTO events (
       seq, ts, type, stream_kind, stream_id, namespace, project,
       correlation_id, causation_seq, refs, body
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertCoordinatorEvent.run(
    1,
    P4_NOW,
    'job.launch.requested',
    'job',
    jobId,
    'coordinator-ns',
    '/coordinator',
    'coordinator-correlation',
    null,
    JSON.stringify({ jobId, sessionId }),
    Buffer.from('{"launch":"v1"}'),
  );
  insertCoordinatorEvent.run(
    2,
    '2026-08-03T00:00:01.000Z',
    'job.launch.rejected',
    'job',
    jobId,
    'coordinator-ns',
    '/coordinator',
    'coordinator-correlation',
    1,
    JSON.stringify({ jobId, sessionId }),
    Buffer.from('{"rejection":"v1"}'),
  );
  insertCoordinatorEvent.run(
    3,
    '2026-08-03T00:00:02.000Z',
    'job.runtime.started',
    'job',
    jobId,
    'coordinator-ns',
    '/coordinator',
    'coordinator-correlation',
    2,
    JSON.stringify({ jobId, sessionId }),
    Buffer.from('{"runtime":"v1"}'),
  );
  insertCoordinatorEvent.run(
    4,
    '2026-08-03T00:00:03.000Z',
    'job.terminal.recorded',
    'job',
    jobId,
    'coordinator-ns',
    '/coordinator',
    'coordinator-correlation',
    3,
    JSON.stringify({ jobId, sessionId }),
    Buffer.from('{"terminal":"v1"}'),
  );
  return db;
}

describe('coordinator job recovery source revisions', () => {
  it('treats a raw row with no stable job subject as a source-wide fatal fault', async () => {
    const db = createCoordinatorRevisionDb();
    try {
      db.prepare(`UPDATE projection_jobs SET job_id = '' WHERE job_id = 'revision-coordinator-job'`).run();
      await expect(
        quarantineRawSource(coordinatorJobRecoverySource(db), new RecoveryQuarantineStore(db, REVISION_TIME), () => {}),
      ).rejects.toThrow('Recovery revision key must be a non-empty string');
    } finally {
      db.close();
    }
  });

  const mutations: ReadonlyArray<{
    readonly name: string;
    mutate(db: ReturnType<typeof createCoordinatorRevisionDb>): void;
  }> = [
    {
      name: 'complete job projection',
      mutate: (db) =>
        db
          .prepare(`UPDATE projection_jobs SET diagnostics = ? WHERE job_id = 'revision-coordinator-job'`)
          .run('{"progressFaults":[],"changed":true}'),
    },
    {
      name: 'job projection sequence',
      mutate: (db) =>
        db
          .prepare(`UPDATE projection_jobs SET last_seq = last_seq + 1 WHERE job_id = 'revision-coordinator-job'`)
          .run(),
    },
    {
      name: 'raw status event refs',
      mutate: (db) =>
        db
          .prepare(`UPDATE events SET refs = ? WHERE seq = 1`)
          .run('{"jobId":"revision-coordinator-job","changed":true}'),
    },
    {
      name: 'raw launch event body',
      mutate: (db) => db.prepare(`UPDATE events SET body = ? WHERE seq = 1`).run(Buffer.from('{"launch":"v2"}')),
    },
    {
      name: 'raw rejection event body',
      mutate: (db) => db.prepare(`UPDATE events SET body = ? WHERE seq = 2`).run(Buffer.from('{"rejection":"v2"}')),
    },
    {
      name: 'raw runtime event body',
      mutate: (db) => db.prepare(`UPDATE events SET body = ? WHERE seq = 3`).run(Buffer.from('{"runtime":"v2"}')),
    },
    {
      name: 'raw terminal event body',
      mutate: (db) => db.prepare(`UPDATE events SET body = ? WHERE seq = 4`).run(Buffer.from('{"terminal":"v2"}')),
    },
    {
      name: 'raw status event sequence',
      mutate: (db) => db.prepare(`UPDATE events SET seq = 11 WHERE seq = 1`).run(),
    },
    {
      name: 'claimed-session projection column',
      mutate: (db) =>
        db
          .prepare(`UPDATE projection_sessions SET scope_key = ? WHERE session_id = ?`)
          .run('coordinator-scope-changed', 'revision-coordinator-session'),
    },
    {
      name: 'claimed-session controller',
      mutate: (db) =>
        db
          .prepare(`UPDATE projection_sessions SET controller = ? WHERE session_id = ?`)
          .run('coordinator-controller-changed', 'revision-coordinator-session'),
    },
    {
      name: 'claimed-session resumability',
      mutate: (db) =>
        db
          .prepare(`UPDATE projection_sessions SET resumable = 1 WHERE session_id = ?`)
          .run('revision-coordinator-session'),
    },
    {
      name: 'claimed-session conversation ref',
      mutate: (db) =>
        db
          .prepare(`UPDATE projection_sessions SET conversation_ref = ? WHERE session_id = ?`)
          .run('coordinator-conversation-changed', 'revision-coordinator-session'),
    },
    {
      name: 'claimed-session active job',
      mutate: (db) =>
        db
          .prepare(
            `UPDATE projection_sessions
              SET entry = json_remove(entry, '$.activeJobId')
            WHERE session_id = 'revision-coordinator-session'`,
          )
          .run(),
    },
    {
      name: 'claimed-session continuation lease',
      mutate: (db) =>
        db
          .prepare(
            `UPDATE projection_sessions
              SET entry = json_set(entry, '$.continuationLease', json('{"status":"pending"}'))
            WHERE session_id = 'revision-coordinator-session'`,
          )
          .run(),
    },
    {
      name: 'claimed-session version',
      mutate: (db) =>
        db
          .prepare(
            `UPDATE projection_sessions
              SET entry = json_set(entry, '$.version', 4)
            WHERE session_id = 'revision-coordinator-session'`,
          )
          .run(),
    },
    {
      name: 'claimed-session projection sequence',
      mutate: (db) =>
        db
          .prepare(
            `UPDATE projection_sessions
              SET last_seq = last_seq + 1
            WHERE session_id = 'revision-coordinator-session'`,
          )
          .run(),
    },
    {
      name: 'claimed-session presence',
      mutate: (db) =>
        db.prepare(`DELETE FROM projection_sessions WHERE session_id = 'revision-coordinator-session'`).run(),
    },
    {
      name: 'provider operation locator presence',
      mutate: (db) =>
        db
          .prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`)
          .run(`${providerOperationRecordKeyPrefix('revision-coordinator-job')}operation:proxy:build`, '{"saga":"v1"}'),
    },
  ];

  for (const mutation of mutations) {
    it(`re-attempts when the ${mutation.name} changes`, async () => {
      const db = createCoordinatorRevisionDb();
      try {
        const quarantine = new RecoveryQuarantineStore(db, REVISION_TIME);
        let settlements = 0;
        const run = () => quarantineRawSource(coordinatorJobRecoverySource(db), quarantine, () => (settlements += 1));
        await run();
        expect(settlements).toBe(1);
        expect((await run()).skipped).toBe(1);
        mutation.mutate(db);
        await run();
        expect(settlements).toBe(2);
        expect((await run()).skipped).toBe(1);
        expect(settlements).toBe(2);
      } finally {
        db.close();
      }
    });
  }
});

function createP4RevisionDb() {
  const runtime = new SimulationRuntime();
  const db = openTestStoreDb(runtime, ':memory:');
  db.prepare(
    `INSERT INTO projection_sessions (
       session_id, controller, resumable, conversation_ref, scope_key, entry, last_seq
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('p4-session', 'default', 0, null, 'scope-p4', JSON.stringify({ ...p4Entry(), continuationLease: null }), 9);
  const insertEvent = db.prepare(
    `INSERT INTO events (
       seq, ts, type, stream_kind, stream_id, namespace, project,
       correlation_id, causation_seq, refs, body
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertEvent.run(
    1,
    P4_NOW,
    'session.claim.released',
    'session',
    'p4-session',
    'p4-ns',
    '/p4',
    null,
    null,
    JSON.stringify({ sessionId: 'p4-session', jobId: 'p4-job' }),
    Buffer.from('{"release":"v1"}'),
  );
  insertEvent.run(
    2,
    P4_NOW,
    'job.terminal.recorded',
    'job',
    'p4-job',
    'p4-ns',
    '/p4',
    null,
    1,
    JSON.stringify({ sessionId: 'p4-session', jobId: 'p4-job' }),
    Buffer.from('{"terminal":"v1"}'),
  );
  insertEvent.run(
    3,
    P4_NOW,
    'session.retention.discard.completed',
    'session',
    'p4-session',
    'p4-ns',
    '/p4',
    null,
    2,
    JSON.stringify({ sessionId: 'p4-session', jobId: 'p4-job' }),
    Buffer.from('{"outcome":"v1"}'),
  );
  insertEvent.run(
    4,
    '2026-08-03T00:00:01.000Z',
    'session.retention.discard.failed',
    'session',
    'p4-session',
    'p4-ns',
    '/p4',
    null,
    3,
    JSON.stringify({ sessionId: 'p4-session', jobId: 'p4-job' }),
    Buffer.from('{"cause":"v1"}'),
  );
  return db;
}

/**
 * A workflow root has no provider session, so its terminal carries no `refs.sessionId`. It is a real
 * durable shape, not corruption, and it must stay outside a boundary that pairs a session claim with the
 * terminal releasing it.
 */
function insertSessionlessWorkflowTerminal(db: ReturnType<typeof createP4RevisionDb>, seq: number): void {
  db.prepare(
    `INSERT INTO events (
       seq, ts, type, stream_kind, stream_id, namespace, project,
       correlation_id, causation_seq, refs, body
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    seq,
    P4_NOW,
    'job.terminal.recorded',
    'job',
    'p4-workflow-root',
    'p4-ns',
    '/p4',
    null,
    null,
    JSON.stringify({ jobId: 'p4-workflow-root' }),
    Buffer.from('{"terminal":"workflow"}'),
  );
}

function rawContinuationToken(raw: unknown): { readonly kind: string; readonly key: string } | null {
  if (typeof raw !== 'object' || raw === null || !('continuation' in raw)) return null;
  const continuation = raw.continuation;
  if (typeof continuation !== 'object' || continuation === null) return null;
  if (
    !('continuation_kind' in continuation) ||
    typeof continuation.continuation_kind !== 'string' ||
    !('continuation_key' in continuation) ||
    typeof continuation.continuation_key !== 'string'
  ) {
    return null;
  }
  return { kind: continuation.continuation_kind, key: continuation.continuation_key };
}

async function quarantineRawSource<Raw>(
  source: RecoverySource<Raw>,
  quarantine: RecoveryQuarantineStore,
  onSettle: () => void,
) {
  return RecoveryContainment.each(source, {
    signal: new AbortController().signal,
    quarantine,
    processLocalCleanup: { kind: 'not-required' as const },
    hydrate: (raw) => raw,
    requiredObligations: () => [],
    settle: (raw) => {
      onSettle();
      const continuation = rawContinuationToken(raw);
      if (continuation !== null) {
        return { kind: 'deferred' as const, continuation, detail: 'retain raw continuation' };
      }
      return { kind: 'quarantine' as const, detail: 'retain P4 revision' };
    },
    onFault: ({ error }) => ({ kind: 'fatal' as const, error }),
  });
}

async function issueComponentReceipts<Raw, Item>(
  source: RecoverySource<Raw>,
  quarantine: RecoveryQuarantineStore,
  hydrate: (raw: Raw) => Item,
): Promise<readonly RecoveryReceipt<Item>[]> {
  const report = await RecoveryContainment.each(source, {
    signal: new AbortController().signal,
    quarantine,
    processLocalCleanup: { kind: 'not-required' as const },
    issueReceipts: true,
    hydrate,
    requiredObligations: () => [],
    settle: () => ({ kind: 'advanced' as const, outcome: 'settled' as const, facts: [], detail: 'sealed' }),
    onFault: ({ error }) => ({ kind: 'fatal' as const, error }),
  });
  return report.receipts;
}

function eventComponent(row: EventsRow): RetentionReleasePairComponent {
  return row.type === 'session.claim.released'
    ? { kind: 'release', row, sessionId: 'p4-session', jobId: 'p4-job', entry: p4Entry() }
    : { kind: 'terminal', row, sessionId: 'p4-session', jobId: 'p4-job' };
}

type P4CompositeFixture = Readonly<{
  session: SessionProjectionComponent;
  lease: SessionContinuationLeaseComponent;
  release: Extract<RetentionReleasePairComponent, { kind: 'release' }>;
  terminal: Extract<RetentionReleasePairComponent, { kind: 'terminal' }>;
  outcome: TerminalRetentionOutcomeComponent;
  cause: TerminalRetentionOutcomeComponent;
}>;

const FIXED_P4_REVISIONS: Readonly<Record<keyof P4CompositeFixture, string>> = {
  session: '1'.repeat(64),
  lease: '2'.repeat(64),
  release: '3'.repeat(64),
  terminal: '4'.repeat(64),
  outcome: '5'.repeat(64),
  cause: '6'.repeat(64),
};

function p4CompositeFixture(db: ReturnType<typeof createP4RevisionDb>): P4CompositeFixture {
  const row = db
    .prepare<[], RawSessionProjectionEnvelope['row']>(
      `SELECT session_id, controller, resumable, conversation_ref, scope_key, entry, last_seq
         FROM projection_sessions
        WHERE session_id = 'p4-session'`,
    )
    .get();
  const events = db.prepare<[], EventsRow>(`SELECT * FROM events ORDER BY seq ASC`).all();
  const releaseRow = events.find((event) => event.seq === 1);
  const terminalRow = events.find((event) => event.seq === 2);
  const outcomeRow = events.find((event) => event.seq === 3);
  const causeRow = events.find((event) => event.seq === 4);
  if (
    row === undefined ||
    releaseRow === undefined ||
    terminalRow === undefined ||
    outcomeRow === undefined ||
    causeRow === undefined
  ) {
    throw new Error('P4 revision fixture is incomplete');
  }
  const entry = JSON.parse(row.entry) as ProviderSession;
  return {
    session: {
      kind: 'session',
      row,
      entry,
      hasContinuationLeaseField: true,
      retentionContinuations: [],
    },
    lease: {
      kind: 'lease',
      row,
      persistedEntry: entry,
      effectiveEntry: entry,
      protectsRetention: false,
      overdueLease: null,
    },
    release: {
      kind: 'release',
      row: releaseRow,
      sessionId: 'p4-session',
      jobId: 'p4-job',
      entry,
    },
    terminal: {
      kind: 'terminal',
      row: terminalRow,
      sessionId: 'p4-session',
      jobId: 'p4-job',
    },
    outcome: {
      kind: 'terminal-outcome',
      row: outcomeRow,
      sessionId: 'p4-session',
      terminal: false,
    },
    cause: {
      kind: 'terminal-outcome',
      row: causeRow,
      sessionId: 'p4-session',
      terminal: false,
    },
  };
}

async function issueFixedP4Receipt<T extends P4RetentionComponent>(
  payload: T,
  subjectKey: string,
  revision: string,
  quarantine: RecoveryQuarantineStore,
): Promise<RecoveryReceipt<T>> {
  const receipts = await issueComponentReceipts(
    defineRecoverySource<T>({
      boundary: 'test-p4-fixed-component',
      scanSubject: { key: `scan:${subjectKey}`, revision: { kind: 'until-cleared' } },
      scan: () => [payload],
      subject: () => ({ key: subjectKey, revision: { kind: 'fingerprint', value: revision } }),
    }),
    quarantine,
    (raw) => raw,
  );
  const receipt = receipts[0];
  if (receipt === undefined) throw new Error(`P4 component '${subjectKey}' did not issue a receipt`);
  return receipt;
}

async function fixedP4Receipts(
  fixture: P4CompositeFixture,
  revisions: Readonly<Record<keyof P4CompositeFixture, string>>,
  quarantine: RecoveryQuarantineStore,
): Promise<readonly RecoveryReceipt<P4RetentionComponent>[]> {
  return [
    await issueFixedP4Receipt(fixture.session, 'p4-session', revisions.session, quarantine),
    await issueFixedP4Receipt(fixture.lease, 'p4-session', revisions.lease, quarantine),
    await issueFixedP4Receipt(fixture.release, '1', revisions.release, quarantine),
    await issueFixedP4Receipt(fixture.terminal, '2', revisions.terminal, quarantine),
    await issueFixedP4Receipt(fixture.outcome, '3', revisions.outcome, quarantine),
    await issueFixedP4Receipt(fixture.cause, '4', revisions.cause, quarantine),
  ];
}

async function quarantineFixedP4Composite(
  fixture: P4CompositeFixture,
  revisions: Readonly<Record<keyof P4CompositeFixture, string>>,
  quarantine: RecoveryQuarantineStore,
  onSettle: () => void,
) {
  const receipts = await fixedP4Receipts(fixture, revisions, quarantine);
  return quarantineRawSource(retentionWorkItemRecoverySource(receipts), quarantine, onSettle);
}

describe('P4 recovery source revisions', () => {
  it('keeps a session-less workflow terminal out of the retention release pair', async () => {
    const db = createP4RevisionDb();
    try {
      insertSessionlessWorkflowTerminal(db, 5);
      const quarantine = new RecoveryQuarantineStore(db, REVISION_TIME);
      const scanned: number[] = [];

      await RecoveryContainment.each(retentionReleasePairComponentSource(db), {
        signal: new AbortController().signal,
        quarantine,
        processLocalCleanup: { kind: 'not-required' as const },
        hydrate: (raw: RawRetentionReleaseAndTerminalRow) => raw,
        requiredObligations: () => [],
        settle: (raw: RawRetentionReleaseAndTerminalRow) => {
          scanned.push(raw.seq);
          return { kind: 'advanced' as const, outcome: 'settled' as const, facts: [], detail: 'observed' };
        },
        onFault: ({ error }) => ({ kind: 'fatal' as const, error }),
      });

      expect(scanned).toEqual([1, 2]);
      expect(quarantine.list()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('re-attempts every row-granular component when its raw persisted bytes change', async () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly source: (db: ReturnType<typeof createP4RevisionDb>) => RecoverySource<unknown>;
      readonly mutate: (db: ReturnType<typeof createP4RevisionDb>) => unknown;
    }> = [
      {
        name: 'session projection metadata',
        source: sessionProjectionRecoverySource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db
            .prepare(`UPDATE projection_sessions SET scope_key = 'scope-p4-changed' WHERE session_id = 'p4-session'`)
            .run(),
      },
      {
        name: 'session controller',
        source: sessionProjectionRecoverySource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db.prepare(`UPDATE projection_sessions SET controller = 'p4-controller-changed'`).run(),
      },
      {
        name: 'session resumability',
        source: sessionProjectionRecoverySource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db.prepare(`UPDATE projection_sessions SET resumable = 1`).run(),
      },
      {
        name: 'session conversation ref',
        source: sessionProjectionRecoverySource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db.prepare(`UPDATE projection_sessions SET conversation_ref = 'p4-conversation-changed'`).run(),
      },
      {
        name: 'session active job',
        source: sessionProjectionRecoverySource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db.prepare(`UPDATE projection_sessions SET entry = json_set(entry, '$.activeJobId', 'changed-job')`).run(),
      },
      {
        name: 'session continuation lease',
        source: sessionProjectionRecoverySource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db
            .prepare(
              `UPDATE projection_sessions
                SET entry = json_set(entry, '$.continuationLease', json('{"status":"pending"}'))`,
            )
            .run(),
      },
      {
        name: 'session version',
        source: sessionProjectionRecoverySource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db.prepare(`UPDATE projection_sessions SET entry = json_set(entry, '$.version', 4)`).run(),
      },
      {
        name: 'session projection sequence',
        source: sessionProjectionRecoverySource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db.prepare(`UPDATE projection_sessions SET last_seq = last_seq + 1 WHERE session_id = 'p4-session'`).run(),
      },
      {
        name: 'continuation lease bytes',
        source: sessionContinuationLeaseRecoverySource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db
            .prepare(
              `UPDATE projection_sessions
                SET entry = json_set(entry, '$.continuationLease', json('{"status":"pending"}'))`,
            )
            .run(),
      },
      {
        name: 'continuation lease projection metadata',
        source: sessionContinuationLeaseRecoverySource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db
            .prepare(
              `UPDATE projection_sessions
                  SET scope_key = 'scope-p4-lease-changed'
                WHERE session_id = 'p4-session'`,
            )
            .run(),
      },
      {
        name: 'continuation lease controller',
        source: sessionContinuationLeaseRecoverySource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db.prepare(`UPDATE projection_sessions SET controller = 'p4-lease-controller-changed'`).run(),
      },
      {
        name: 'continuation lease resumability',
        source: sessionContinuationLeaseRecoverySource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db.prepare(`UPDATE projection_sessions SET resumable = 1`).run(),
      },
      {
        name: 'continuation lease conversation ref',
        source: sessionContinuationLeaseRecoverySource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db.prepare(`UPDATE projection_sessions SET conversation_ref = 'p4-lease-conversation-changed'`).run(),
      },
      {
        name: 'continuation lease session version',
        source: sessionContinuationLeaseRecoverySource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db.prepare(`UPDATE projection_sessions SET entry = json_set(entry, '$.version', 4)`).run(),
      },
      {
        name: 'continuation lease projection sequence',
        source: sessionContinuationLeaseRecoverySource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db.prepare(`UPDATE projection_sessions SET last_seq = last_seq + 1 WHERE session_id = 'p4-session'`).run(),
      },
      {
        name: 'terminal retention outcome body',
        source: terminalRetentionOutcomeRecoverySource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db.prepare(`UPDATE events SET body = ? WHERE seq = 3`).run(Buffer.from('{"outcome":"v2"}')),
      },
      {
        name: 'terminal retention cause body',
        source: terminalRetentionOutcomeRecoverySource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db.prepare(`UPDATE events SET body = ? WHERE seq = 4`).run(Buffer.from('{"cause":"v2"}')),
      },
      {
        name: 'terminal retention outcome refs',
        source: terminalRetentionOutcomeRecoverySource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db
            .prepare(`UPDATE events SET refs = ? WHERE seq = 3`)
            .run(JSON.stringify({ sessionId: 'p4-session', changed: true })),
      },
      {
        name: 'terminal retention outcome type',
        source: terminalRetentionOutcomeRecoverySource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db.prepare(`UPDATE events SET type = 'session.retention.discard.failed' WHERE seq = 3`).run(),
      },
      {
        name: 'terminal retention outcome stream kind',
        source: terminalRetentionOutcomeRecoverySource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db.prepare(`UPDATE events SET stream_kind = 'job' WHERE seq = 3`).run(),
      },
      {
        name: 'terminal retention outcome stream id',
        source: terminalRetentionOutcomeRecoverySource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db.prepare(`UPDATE events SET stream_id = 'p4-session-changed' WHERE seq = 3`).run(),
      },
      {
        name: 'release body',
        source: retentionReleasePairComponentSource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db.prepare(`UPDATE events SET body = ? WHERE seq = 1`).run(Buffer.from('{"release":"v2"}')),
      },
      {
        name: 'release refs',
        source: retentionReleasePairComponentSource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db
            .prepare(`UPDATE events SET refs = ? WHERE seq = 1`)
            .run(JSON.stringify({ sessionId: 'p4-session', jobId: 'p4-job', changed: true })),
      },
      {
        name: 'release type',
        source: retentionReleasePairComponentSource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db.prepare(`UPDATE events SET type = 'job.terminal.recorded' WHERE seq = 1`).run(),
      },
      {
        name: 'release stream kind',
        source: retentionReleasePairComponentSource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db.prepare(`UPDATE events SET stream_kind = 'job' WHERE seq = 1`).run(),
      },
      {
        name: 'release stream id',
        source: retentionReleasePairComponentSource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db.prepare(`UPDATE events SET stream_id = 'p4-session-changed' WHERE seq = 1`).run(),
      },
      {
        name: 'terminal body',
        source: retentionReleasePairComponentSource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db.prepare(`UPDATE events SET body = ? WHERE seq = 2`).run(Buffer.from('{"terminal":"v2"}')),
      },
      {
        name: 'terminal refs',
        source: retentionReleasePairComponentSource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db
            .prepare(`UPDATE events SET refs = ? WHERE seq = 2`)
            .run(JSON.stringify({ sessionId: 'p4-session', jobId: 'p4-job', changed: true })),
      },
      {
        name: 'terminal type',
        source: retentionReleasePairComponentSource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db.prepare(`UPDATE events SET type = 'session.claim.released' WHERE seq = 2`).run(),
      },
      {
        name: 'terminal stream kind',
        source: retentionReleasePairComponentSource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db.prepare(`UPDATE events SET stream_kind = 'session' WHERE seq = 2`).run(),
      },
      {
        name: 'terminal stream id',
        source: retentionReleasePairComponentSource,
        mutate: (db: ReturnType<typeof createP4RevisionDb>) =>
          db.prepare(`UPDATE events SET stream_id = 'p4-job-changed' WHERE seq = 2`).run(),
      },
    ] as const;

    for (const testCase of cases) {
      const db = createP4RevisionDb();
      try {
        const quarantine = new RecoveryQuarantineStore(db, REVISION_TIME);
        let settlements = 0;
        const run = () => quarantineRawSource(testCase.source(db), quarantine, () => (settlements += 1));
        await run();
        const initialSettlements = settlements;
        expect(initialSettlements, testCase.name).toBeGreaterThan(0);
        expect((await run()).skipped, testCase.name).toBe(initialSettlements);
        testCase.mutate(db);
        await run();
        expect(settlements, testCase.name).toBeGreaterThan(initialSettlements);
        const changedSettlements = settlements;
        expect((await run()).skipped, testCase.name).toBe(initialSettlements);
        expect(settlements, testCase.name).toBe(changedSettlements);
      } finally {
        db.close();
      }
    }
  });

  it('changes the composite revision for component, attempt/artifact, cause/outcome, and continuation inputs', async () => {
    const db = createP4RevisionDb();
    try {
      const quarantine = new RecoveryQuarantineStore(db, REVISION_TIME);
      let settlements = 0;
      const run = async () => {
        const sessionReceipts = await issueComponentReceipts(
          sessionProjectionRecoverySource(db),
          quarantine,
          (raw: RawSessionProjectionEnvelope): SessionProjectionComponent => ({
            kind: 'session',
            row: raw.row,
            entry: JSON.parse(raw.row.entry) as ProviderSession,
            hasContinuationLeaseField: true,
            retentionContinuations: raw.retentionContinuations,
          }),
        );
        const leaseReceipts = await issueComponentReceipts(
          sessionContinuationLeaseRecoverySource(db),
          quarantine,
          (row: RawPendingContinuationLeaseRow): SessionContinuationLeaseComponent => ({
            kind: 'lease',
            row,
            persistedEntry: JSON.parse(row.entry) as ProviderSession,
            effectiveEntry: p4Entry(),
            protectsRetention: false,
            overdueLease: null,
          }),
        );
        const outcomeReceipts = await issueComponentReceipts(
          terminalRetentionOutcomeRecoverySource(db),
          quarantine,
          (row: RawTerminalRetentionOutcomeRow): TerminalRetentionOutcomeComponent => ({
            kind: 'terminal-outcome',
            row,
            sessionId: 'p4-session',
            terminal: false,
          }),
        );
        const pairReceipts = await issueComponentReceipts(
          retentionReleasePairComponentSource(db),
          quarantine,
          (row: RawRetentionReleaseAndTerminalRow) => eventComponent(row),
        );
        const receipts: readonly RecoveryReceipt<P4RetentionComponent>[] = [
          ...sessionReceipts,
          ...leaseReceipts,
          ...outcomeReceipts,
          ...pairReceipts,
        ];
        return quarantineRawSource(retentionWorkItemRecoverySource(receipts), quarantine, () => (settlements += 1));
      };

      await run();
      expect(settlements).toBe(1);
      expect((await run()).skipped).toBe(1);

      const changedEntry = p4Entry({
        artifactHandles: [
          ...p4Entry().artifactHandles,
          {
            handle: '/tmp/p4-artifact-2.jsonl',
            identity: { kind: 'fixture-2' },
            identityKey: 'fixture:p4-artifact-2',
            sourceJobId: 'p4-job',
            recordedAt: P4_NOW,
          },
        ],
        retentionDiscard: {
          attempts: [{ status: 'completed', attempt: 1, handles: [], outcome: 'skipped_protected' }],
        },
      });
      db.prepare(`UPDATE projection_sessions SET entry = ?, last_seq = last_seq + 1 WHERE session_id = ?`).run(
        JSON.stringify({ ...changedEntry, continuationLease: null }),
        'p4-session',
      );
      await run();
      expect(settlements).toBe(2);

      db.prepare(`UPDATE events SET ts = ?, causation_seq = ? WHERE seq = 2`).run('2026-08-03T00:00:01.000Z', 99);
      await run();
      expect(settlements).toBe(3);

      db.prepare(`UPDATE events SET body = ? WHERE seq = 3`).run(Buffer.from('{"outcome":"v3"}'));
      await run();
      expect(settlements).toBe(4);

      db.prepare(
        `UPDATE recovery_quarantine
            SET state = 'continuation',
                continuation_kind = 'retention-discard.v1',
                continuation_key = '{"stage":"prepared"}'
          WHERE boundary_id = 'session-retention-work'
            AND subject_key = ?`,
      ).run('p4-session\u0000p4-job');
      await run();
      expect(settlements).toBe(5);
    } finally {
      db.close();
    }
  });

  for (const component of Object.keys(FIXED_P4_REVISIONS) as (keyof P4CompositeFixture)[]) {
    it(`re-attempts the composite when only the nested ${component} subject revision changes`, async () => {
      const db = createP4RevisionDb();
      try {
        const quarantine = new RecoveryQuarantineStore(db, REVISION_TIME);
        const fixture = p4CompositeFixture(db);
        let settlements = 0;
        const run = (revisions: Readonly<Record<keyof P4CompositeFixture, string>>) =>
          quarantineFixedP4Composite(fixture, revisions, quarantine, () => (settlements += 1));

        await run(FIXED_P4_REVISIONS);
        expect(settlements).toBe(1);
        expect((await run(FIXED_P4_REVISIONS)).skipped).toBe(1);
        expect(settlements).toBe(1);

        const changedRevisions = { ...FIXED_P4_REVISIONS, [component]: 'f'.repeat(64) };
        await run(changedRevisions);
        expect(settlements).toBe(2);
        expect((await run(changedRevisions)).skipped).toBe(1);
        expect(settlements).toBe(2);
      } finally {
        db.close();
      }
    });
  }

  const parentMutations: ReadonlyArray<{
    readonly name: string;
    mutate(fixture: P4CompositeFixture): P4CompositeFixture;
  }> = [
    {
      name: 'session bytes',
      mutate: (fixture) => ({
        ...fixture,
        session: {
          ...fixture.session,
          row: { ...fixture.session.row, scope_key: 'scope-p4-parent-changed' },
        },
      }),
    },
    {
      name: 'continuation lease bytes',
      mutate: (fixture) => ({
        ...fixture,
        lease: {
          ...fixture.lease,
          effectiveEntry: {
            ...fixture.lease.effectiveEntry,
            continuationLease: {
              status: 'pending',
              staleJobId: 'p4-stale-job',
              workflowId: 'p4-workflow',
              workflowSlotId: 'slot:0',
              replacementGeneration: 1,
              reason: 'stale_recovery',
              recordedAt: P4_NOW,
              expiresAt: '2026-08-03T00:01:00.000Z',
            },
          },
        },
      }),
    },
    {
      name: 'retention attempts',
      mutate: (fixture) => ({
        ...fixture,
        lease: {
          ...fixture.lease,
          effectiveEntry: {
            ...fixture.lease.effectiveEntry,
            retentionDiscard: {
              attempts: [{ status: 'completed', attempt: 1, handles: [], outcome: 'skipped_protected' }],
            },
          },
        },
      }),
    },
    {
      name: 'terminal outcome bytes',
      mutate: (fixture) => ({
        ...fixture,
        outcome: {
          ...fixture.outcome,
          row: { ...fixture.outcome.row, body: Buffer.from('{"outcome":"parent-v2"}') },
        },
      }),
    },
    {
      name: 'terminal cause bytes',
      mutate: (fixture) => ({
        ...fixture,
        cause: {
          ...fixture.cause,
          row: { ...fixture.cause.row, body: Buffer.from('{"cause":"parent-v2"}') },
        },
      }),
    },
    {
      name: 'release event sequence',
      mutate: (fixture) => ({
        ...fixture,
        release: {
          ...fixture.release,
          row: { ...fixture.release.row, seq: 11 },
        },
      }),
    },
    {
      name: 'terminal event sequence',
      mutate: (fixture) => ({
        ...fixture,
        terminal: {
          ...fixture.terminal,
          row: { ...fixture.terminal.row, seq: 12 },
        },
      }),
    },
    {
      name: 'outcome event sequence',
      mutate: (fixture) => ({
        ...fixture,
        outcome: {
          ...fixture.outcome,
          row: { ...fixture.outcome.row, seq: 13 },
        },
      }),
    },
    {
      name: 'cause event sequence',
      mutate: (fixture) => ({
        ...fixture,
        cause: {
          ...fixture.cause,
          row: { ...fixture.cause.row, seq: 14 },
        },
      }),
    },
    {
      name: 'persisted artifact handles',
      mutate: (fixture) => ({
        ...fixture,
        lease: {
          ...fixture.lease,
          effectiveEntry: {
            ...fixture.lease.effectiveEntry,
            artifactHandles: [
              ...fixture.lease.effectiveEntry.artifactHandles,
              {
                handle: '/tmp/p4-parent-artifact.jsonl',
                identity: { kind: 'parent-fixture' },
                identityKey: 'fixture:p4-parent-artifact',
                sourceJobId: 'p4-job',
                recordedAt: P4_NOW,
              },
            ],
          },
        },
      }),
    },
    {
      name: 'composite continuation',
      mutate: (fixture) => ({
        ...fixture,
        session: {
          ...fixture.session,
          retentionContinuations: [
            {
              subject_key: 'p4-session\u0000p4-job',
              subject_revision: '7'.repeat(64),
              continuation_kind: 'retention-discard.v1',
              continuation_key: '{"stage":"prepared"}',
            },
          ],
        },
      }),
    },
  ];

  for (const mutation of parentMutations) {
    it(`re-attempts the composite when only its ${mutation.name} change`, async () => {
      const db = createP4RevisionDb();
      try {
        const quarantine = new RecoveryQuarantineStore(db, REVISION_TIME);
        const fixture = p4CompositeFixture(db);
        let settlements = 0;
        const run = (input: P4CompositeFixture) =>
          quarantineFixedP4Composite(input, FIXED_P4_REVISIONS, quarantine, () => (settlements += 1));

        await run(fixture);
        expect(settlements).toBe(1);
        expect((await run(fixture)).skipped).toBe(1);
        expect(settlements).toBe(1);

        const changedFixture = mutation.mutate(fixture);
        await run(changedFixture);
        expect(settlements).toBe(2);
        expect((await run(changedFixture)).skipped).toBe(1);
        expect(settlements).toBe(2);
      } finally {
        db.close();
      }
    });
  }
});

function createWorkflowRevisionDb() {
  const runtime = new SimulationRuntime();
  const db = openTestStoreDb(runtime, ':memory:');
  db.prepare(
    `INSERT INTO projection_jobs (
       job_id, execution_owner, phase, terminal, diagnostics, session_id, provider,
       project_root, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
       workflow_slot, workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'revision-workflow',
    JSON.stringify({ kind: 'workflow', id: 'revision-workflow' }),
    'running',
    null,
    '{"progressFaults":[]}',
    null,
    null,
    '/workflow',
    'workflow-ns',
    'workflow-bundle',
    'workflow',
    null,
    null,
    null,
    null,
    P4_NOW,
    4,
  );
  db.prepare(
    `INSERT INTO projection_jobs (
       job_id, execution_owner, phase, terminal, diagnostics, session_id, provider,
       project_root, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
       workflow_slot, workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'revision-workflow:slot:0',
    JSON.stringify({ kind: 'workflow', id: 'revision-workflow' }),
    'running',
    null,
    '{"progressFaults":[]}',
    'revision-workflow-session',
    'codex',
    '/workflow',
    'workflow-ns',
    'workflow-bundle',
    'provider',
    'revision-workflow',
    'slot:0',
    0,
    null,
    P4_NOW,
    5,
  );
  db.prepare(
    `INSERT INTO projection_workflows (workflow_id, plan, provider_scope, lifecycle, last_seq)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('revision-workflow', '{"slots":[]}', '{"kind":"inherit"}', 'running', 3);
  db.prepare(
    `INSERT INTO projection_sessions (
       session_id, controller, resumable, conversation_ref, scope_key, entry, last_seq
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'revision-workflow-session',
    'default',
    0,
    null,
    'workflow-scope',
    '{"sessionId":"revision-workflow-session","version":1}',
    2,
  );
  const insertEvent = db.prepare(
    `INSERT INTO events (
       seq, ts, type, stream_kind, stream_id, namespace, project,
       correlation_id, causation_seq, refs, body
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertEvent.run(
    1,
    P4_NOW,
    'job.launch.requested',
    'job',
    'revision-workflow',
    null,
    null,
    null,
    null,
    null,
    Buffer.from('{"root":1}'),
  );
  insertEvent.run(
    2,
    P4_NOW,
    'workflow.plan.declared',
    'workflow',
    'revision-workflow',
    null,
    null,
    null,
    null,
    null,
    Buffer.from('{"workflow":1}'),
  );
  insertEvent.run(
    3,
    P4_NOW,
    'job.launch.requested',
    'job',
    'revision-workflow:slot:0',
    null,
    null,
    null,
    null,
    null,
    Buffer.from('{"child":1}'),
  );
  insertEvent.run(
    4,
    P4_NOW,
    'session.claimed',
    'session',
    'revision-workflow-session',
    null,
    null,
    null,
    null,
    null,
    Buffer.from('{"session":1}'),
  );
  return db;
}

describe('workflow recovery source revisions', () => {
  const mutations: ReadonlyArray<{
    readonly name: string;
    mutate(db: ReturnType<typeof createWorkflowRevisionDb>): void;
  }> = [
    {
      name: 'root job projection',
      mutate: (db) =>
        db
          .prepare(`UPDATE projection_jobs SET diagnostics = ? WHERE job_id = 'revision-workflow'`)
          .run('{"progressFaults":[],"changed":true}'),
    },
    {
      name: 'root job projection sequence',
      mutate: (db) =>
        db.prepare(`UPDATE projection_jobs SET last_seq = last_seq + 1 WHERE job_id = 'revision-workflow'`).run(),
    },
    {
      name: 'root job event',
      mutate: (db) => db.prepare(`UPDATE events SET body = ? WHERE seq = 1`).run(Buffer.from('{"root":2}')),
    },
    {
      name: 'workflow projection',
      mutate: (db) =>
        db
          .prepare(`UPDATE projection_workflows SET last_seq = last_seq + 1 WHERE workflow_id = 'revision-workflow'`)
          .run(),
    },
    {
      name: 'workflow event',
      mutate: (db) => db.prepare(`UPDATE events SET refs = ? WHERE seq = 2`).run('{"workflowId":"revision-workflow"}'),
    },
    {
      name: 'child projection',
      mutate: (db) =>
        db
          .prepare(`UPDATE projection_jobs SET last_seq = last_seq + 1 WHERE job_id = 'revision-workflow:slot:0'`)
          .run(),
    },
    {
      name: 'child projection set and stable order',
      mutate: (db) =>
        db
          .prepare(
            `INSERT INTO projection_jobs (
               job_id, execution_owner, phase, terminal, diagnostics, session_id, provider,
               project_root, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
               workflow_slot, workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'revision-workflow:slot:1',
            JSON.stringify({ kind: 'workflow', id: 'revision-workflow' }),
            'queued',
            null,
            '{"progressFaults":[]}',
            null,
            null,
            '/workflow',
            'workflow-ns',
            'workflow-bundle',
            'provider',
            'revision-workflow',
            'slot:1',
            0,
            null,
            P4_NOW,
            6,
          ),
    },
    {
      name: 'child event',
      mutate: (db) => db.prepare(`UPDATE events SET body = ? WHERE seq = 3`).run(Buffer.from('{"child":2}')),
    },
    {
      name: 'child event sequence',
      mutate: (db) => db.prepare(`UPDATE events SET seq = 13 WHERE seq = 3`).run(),
    },
    {
      name: 'provider-session projection',
      mutate: (db) =>
        db
          .prepare(
            `UPDATE projection_sessions SET scope_key = 'workflow-scope-changed' WHERE session_id = 'revision-workflow-session'`,
          )
          .run(),
    },
    {
      name: 'provider-session controller',
      mutate: (db) =>
        db
          .prepare(
            `UPDATE projection_sessions
                SET controller = 'workflow-controller-changed'
              WHERE session_id = 'revision-workflow-session'`,
          )
          .run(),
    },
    {
      name: 'provider-session resumability',
      mutate: (db) =>
        db
          .prepare(
            `UPDATE projection_sessions
                SET resumable = 1
              WHERE session_id = 'revision-workflow-session'`,
          )
          .run(),
    },
    {
      name: 'provider-session conversation ref',
      mutate: (db) =>
        db
          .prepare(
            `UPDATE projection_sessions
                SET conversation_ref = 'workflow-conversation-changed'
              WHERE session_id = 'revision-workflow-session'`,
          )
          .run(),
    },
    {
      name: 'descendant-session active job',
      mutate: (db) =>
        db
          .prepare(
            `UPDATE projection_sessions
            SET entry = json_set(entry, '$.activeJobId', 'revision-workflow:slot:0')
          WHERE session_id = 'revision-workflow-session'`,
          )
          .run(),
    },
    {
      name: 'descendant-session version',
      mutate: (db) =>
        db
          .prepare(
            `UPDATE projection_sessions
            SET entry = json_set(entry, '$.version', 2)
          WHERE session_id = 'revision-workflow-session'`,
          )
          .run(),
    },
    {
      name: 'descendant-session continuation lease',
      mutate: (db) =>
        db
          .prepare(
            `UPDATE projection_sessions
            SET entry = json_set(entry, '$.continuationLease', json('{"status":"pending"}'))
          WHERE session_id = 'revision-workflow-session'`,
          )
          .run(),
    },
    {
      name: 'descendant-session projection sequence',
      mutate: (db) =>
        db
          .prepare(
            `UPDATE projection_sessions
            SET last_seq = last_seq + 1
          WHERE session_id = 'revision-workflow-session'`,
          )
          .run(),
    },
    {
      name: 'provider session event',
      mutate: (db) => db.prepare(`UPDATE events SET body = ? WHERE seq = 4`).run(Buffer.from('{"session":2}')),
    },
    {
      name: 'workflow continuation',
      mutate: (db) =>
        db
          .prepare(
            `UPDATE recovery_quarantine
            SET state = 'continuation',
                continuation_kind = 'workflow-recovery.v1',
                continuation_key = '{"stage":"prepared"}'
          WHERE boundary_id = 'workflow-recovery'
            AND subject_key = 'revision-workflow'`,
          )
          .run(),
    },
  ];

  for (const mutation of mutations) {
    it(`re-attempts when the ${mutation.name} changes`, async () => {
      const db = createWorkflowRevisionDb();
      try {
        const quarantine = new RecoveryQuarantineStore(db, REVISION_TIME);
        let settlements = 0;
        const run = () => quarantineRawSource(workflowRecoverySource(db), quarantine, () => (settlements += 1));
        await run();
        expect(settlements).toBe(1);
        expect((await run()).skipped).toBe(1);
        mutation.mutate(db);
        await run();
        expect(settlements).toBe(2);
        expect((await run()).skipped).toBe(1);
        expect(settlements).toBe(2);
      } finally {
        db.close();
      }
    });
  }
});

function createLifecycleRevisionDb() {
  const runtime = new SimulationRuntime();
  const db = openTestStoreDb(runtime, ':memory:');
  const insertProjection = db.prepare(
    `INSERT INTO projection_jobs (
       job_id, execution_owner, phase, terminal, diagnostics, session_id, provider,
       project_root, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
       workflow_slot, workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertProjection.run(
    'revision-stale-job',
    JSON.stringify({ kind: 'provider-session', id: 'revision-stale-session' }),
    'completed',
    JSON.stringify({ content: '', outcome: { kind: 'completed' }, durationMs: 0 }),
    '{"progressFaults":[]}',
    'revision-stale-session',
    'codex',
    '/revision/stale',
    'revision-namespace',
    'old-bundle',
    'provider',
    null,
    null,
    null,
    null,
    '2026-08-03T00:00:00.000Z',
    2,
  );
  insertProjection.run(
    'revision-crashed-job',
    JSON.stringify({ kind: 'provider-session', id: 'revision-crashed-session' }),
    'running',
    null,
    '{"progressFaults":[]}',
    'revision-crashed-session',
    'codex',
    '/revision/crashed',
    'revision-namespace',
    'current-bundle',
    'provider',
    null,
    null,
    null,
    null,
    '2026-08-03T00:00:01.000Z',
    3,
  );
  const insertEvent = db.prepare(
    `INSERT INTO events (
       seq, ts, type, stream_kind, stream_id, namespace, project,
       correlation_id, causation_seq, refs, body
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertEvent.run(
    1,
    '2026-08-03T00:00:00.000Z',
    'job.terminal.recorded',
    'job',
    'revision-stale-job',
    'revision-namespace',
    '/revision/stale',
    null,
    null,
    null,
    Buffer.from('{"terminal":"v1"}'),
  );
  insertEvent.run(
    2,
    '2026-08-03T00:00:01.000Z',
    'job.launch.requested',
    'job',
    'revision-crashed-job',
    'revision-namespace',
    '/revision/crashed',
    null,
    null,
    null,
    Buffer.from('{"createdAt":"2026-08-03T00:00:01.000Z"}'),
  );
  return db;
}

describe('AC13 lifecycle recovery source revisions', () => {
  const staleMutations: ReadonlyArray<{
    readonly name: string;
    mutate(db: ReturnType<typeof createLifecycleRevisionDb>): void;
  }> = [
    {
      name: 'terminal phase',
      mutate: (db) =>
        db.prepare(`UPDATE projection_jobs SET phase = 'aborted' WHERE job_id = 'revision-stale-job'`).run(),
    },
    {
      name: 'bundle hash',
      mutate: (db) =>
        db.prepare(`UPDATE projection_jobs SET bundle_hash = 'older-bundle' WHERE job_id = 'revision-stale-job'`).run(),
    },
    {
      name: 'status update time',
      mutate: (db) => db.prepare(`UPDATE events SET ts = '2026-08-03T00:00:02.000Z' WHERE seq = 1`).run(),
    },
    {
      name: 'status event sequence',
      mutate: (db) => db.prepare(`UPDATE events SET seq = 11 WHERE seq = 1`).run(),
    },
    {
      name: 'projection fallback update time',
      mutate: (db) =>
        db
          .prepare(
            `UPDATE projection_jobs
                SET created_at = '2026-08-03T00:00:03.000Z'
              WHERE job_id = 'revision-stale-job'`,
          )
          .run(),
    },
  ];

  for (const mutation of staleMutations) {
    it(`re-attempts stale artifact cleanup when the ${mutation.name} changes`, async () => {
      const db = createLifecycleRevisionDb();
      try {
        const quarantine = new RecoveryQuarantineStore(db, REVISION_TIME);
        let settlements = 0;
        const run = () => quarantineRawSource(staleJobCleanupSource(db), quarantine, () => (settlements += 1));
        await run();
        expect(settlements).toBe(1);
        expect((await run()).skipped).toBe(1);
        mutation.mutate(db);
        await run();
        expect(settlements).toBe(2);
        expect((await run()).skipped).toBe(1);
        expect(settlements).toBe(2);
      } finally {
        db.close();
      }
    });
  }

  it('executes a new stale artifact cleanup subject when the stable job coordinate changes', async () => {
    const db = createLifecycleRevisionDb();
    try {
      const quarantine = new RecoveryQuarantineStore(db, REVISION_TIME);
      let settlements = 0;
      const run = () => quarantineRawSource(staleJobCleanupSource(db), quarantine, () => (settlements += 1));
      await run();
      expect(settlements).toBe(1);
      expect((await run()).skipped).toBe(1);

      db.prepare(`UPDATE events SET stream_id = 'revision-stale-job-v2' WHERE stream_id = 'revision-stale-job'`).run();
      db.prepare(
        `UPDATE projection_jobs SET job_id = 'revision-stale-job-v2' WHERE job_id = 'revision-stale-job'`,
      ).run();
      await run();
      expect(settlements).toBe(2);
      expect((await run()).skipped).toBe(1);
      expect(settlements).toBe(2);
    } finally {
      db.close();
    }
  });

  const crashMutations: ReadonlyArray<{
    readonly name: string;
    mutate(db: ReturnType<typeof createLifecycleRevisionDb>): void;
  }> = [
    {
      name: 'live phase',
      mutate: (db) =>
        db.prepare(`UPDATE projection_jobs SET phase = 'queued' WHERE job_id = 'revision-crashed-job'`).run(),
    },
    {
      name: 'launch time',
      mutate: (db) =>
        db
          .prepare(`UPDATE events SET body = ? WHERE seq = 2`)
          .run(Buffer.from('{"createdAt":"2026-08-03T00:00:02.000Z"}')),
    },
    {
      name: 'session',
      mutate: (db) =>
        db
          .prepare(`UPDATE projection_jobs SET session_id = 'changed-session' WHERE job_id = 'revision-crashed-job'`)
          .run(),
    },
    {
      name: 'project',
      mutate: (db) =>
        db
          .prepare(
            `UPDATE projection_jobs SET project_root = '/revision/changed' WHERE job_id = 'revision-crashed-job'`,
          )
          .run(),
    },
    {
      name: 'job kind',
      mutate: (db) =>
        db.prepare(`UPDATE projection_jobs SET job_kind = 'workflow' WHERE job_id = 'revision-crashed-job'`).run(),
    },
  ];

  for (const mutation of crashMutations) {
    it(`re-attempts crash terminalization when the ${mutation.name} changes`, async () => {
      const db = createLifecycleRevisionDb();
      try {
        const quarantine = new RecoveryQuarantineStore(db, REVISION_TIME);
        let settlements = 0;
        const run = () =>
          quarantineRawSource(crashedJobTerminalizationSource(db), quarantine, () => (settlements += 1));
        await run();
        expect(settlements).toBe(1);
        expect((await run()).skipped).toBe(1);
        mutation.mutate(db);
        await run();
        expect(settlements).toBe(2);
        expect((await run()).skipped).toBe(1);
        expect(settlements).toBe(2);
      } finally {
        db.close();
      }
    });
  }
});
