import { describe, expect, it } from 'vitest';

import { RecoveryContainment, type RecoveryReceipt, type RecoverySource } from '#src/recovery/containment.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
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
import { staleJobCleanupSource } from '#src/jobs/stale-job-cleanup-recovery-source.js';
import { coordinatorJobRecoverySource } from '#src/coordinator/services/recovery/coordinator-job-source.js';
import type { ProviderSession } from '#src/sessions/entry.js';
import type { EventsRow } from '#src/store/schema.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

const REVISION_TIME = { now: () => Date.parse('2026-08-03T00:00:00.000Z') };

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
       project_root, work_dir, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
       workflow_slot, workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobId,
    JSON.stringify({ kind: 'provider-session', id: sessionId }),
    'running',
    null,
    '{"progressFaults":[]}',
    sessionId,
    'codex',
    '/coordinator',
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

  it('re-attempts a composite after its persisted session revision changes', async () => {
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
    } finally {
      db.close();
    }
  });
});

function createLifecycleRevisionDb() {
  const runtime = new SimulationRuntime();
  const db = openTestStoreDb(runtime, ':memory:');
  const insertProjection = db.prepare(
    `INSERT INTO projection_jobs (
       job_id, execution_owner, phase, terminal, diagnostics, session_id, provider,
       project_root, work_dir, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
       workflow_slot, workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  return db;
}

describe('AC13 lifecycle recovery source revisions', () => {
  it('re-attempts stale artifact cleanup when its terminal phase changes', async () => {
    const db = createLifecycleRevisionDb();
    try {
      const quarantine = new RecoveryQuarantineStore(db, REVISION_TIME);
      let settlements = 0;
      const run = () => quarantineRawSource(staleJobCleanupSource(db), quarantine, () => (settlements += 1));
      await run();
      expect(settlements).toBe(1);
      expect((await run()).skipped).toBe(1);
      db.prepare(`UPDATE projection_jobs SET phase = 'aborted' WHERE job_id = 'revision-stale-job'`).run();
      await run();
      expect(settlements).toBe(2);
      expect((await run()).skipped).toBe(1);
      expect(settlements).toBe(2);
    } finally {
      db.close();
    }
  });
});
