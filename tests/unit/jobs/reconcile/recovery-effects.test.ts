import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it, vi } from 'vitest';

import { markJobAsError } from '#src/jobs/reconcile/recovery-effects.js';
import { JobStore } from '#src/jobs/store.js';
import type { JobStatus } from '#src/jobs/records.js';
import { decodeEventBody } from '#src/store/body-codec.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';
import { SessionManager } from '#src/sessions/shell.js';
import { createRealRuntime } from '#src/runtime/real.js';

const NOW = new Date('2026-04-28T00:00:00.000Z');

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return db;
}

function createProgressStore(db: Database): JobStore {
  return new JobStore(
    'tests',
    {
      time: { now: () => NOW.getTime() },
    } as never,
    createEventBodyCodec(),
    { db, providers: permissiveProviderLookupPort },
  );
}

function recoveryStatus(): JobStatus {
  return {
    jobId: 'job-recovery-synthetic-launch',
    owner: { kind: 'provider-session', id: 'session-recovery-synthetic-launch' },
    sessionId: 'session-recovery-synthetic-launch',
    provider: 'codex',
    projectRoot: '/workspace/recovery-synthetic-launch',
    backendNamespace: 'tests',
    jobKind: 'provider',
    phase: 'running',
    updatedAt: NOW.toISOString(),
  };
}

function readEvents(db: Database): Array<{ seq: number; type: string; body: unknown }> {
  const rows = db.prepare('SELECT seq, type, body FROM events ORDER BY seq ASC').all() as Array<{
    seq: number;
    type: string;
    body: Buffer;
  }>;
  return rows.map((row) => ({
    seq: row.seq,
    type: row.type,
    body: decodeEventBody(row.body),
  }));
}

describe('recovery effects', () => {
  it('records a recovery terminal without fabricating launch authority when the launch event is missing', () => {
    const db = createDb();
    try {
      const progressStore = createProgressStore(db);
      const commitSpy = vi.spyOn(progressStore, 'commit');
      const status = recoveryStatus();
      const session = seedTestSessionProjection(db, {
        sessionId: status.sessionId ?? '',
        provider: status.provider ?? 'codex',
        projectRoot: status.projectRoot,
        backendNamespace: status.backendNamespace,
      });
      if (status.sessionId === null || status.provider === null) throw new Error('provider status required');
      const sessionId = status.sessionId;
      const provider = status.provider;
      const sessionManager = new SessionManager(
        status.projectRoot,
        createRealRuntime('prod'),
        undefined,
        undefined,
        db,
        permissiveProviderLookupPort,
      );
      expect(sessionManager.claimForJobSync(sessionId, status.jobId)).toBe(true);
      expect(sessionManager.readById(sessionId, { forceFresh: true })?.version).toBe(session.version + 1);
      progressStore.commit((c) => {
        c.append({
          type: 'job.launch.requested',
          stream: { kind: 'job', id: status.jobId },
          namespace: status.backendNamespace,
          project: status.projectRoot,
          refs: { jobId: status.jobId, sessionId },
          body: {
            owner: { kind: 'provider-session', id: sessionId },
            sessionId,
            provider,
            projectRoot: status.projectRoot,
            backendNamespace: status.backendNamespace,
            jobKind: 'provider',
            pool: 'default',
            enqueueSequence: 0,
            providerAction: 'exec',
            request: { prompt: '', cwd: status.projectRoot, bypassPermissions: false, coralEnv: {} },
            createdAt: status.updatedAt,
          },
        });
        return undefined;
      });
      db.prepare(
        "DELETE FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.launch.requested'",
      ).run(status.jobId);
      expect(progressStore.readLaunchProjection(status.jobId)).toBeNull();
      commitSpy.mockClear();

      expect(() =>
        markJobAsError(progressStore, status, { kind: 'missing_launch_record' }, NOW.getTime(), () => {}),
      ).not.toThrow();

      expect(commitSpy).toHaveBeenCalledOnce();
      expect(readEvents(db)).toEqual([
        expect.objectContaining({
          seq: 1,
          type: 'session.claimed',
          body: expect.objectContaining({
            jobId: status.jobId,
            entry: expect.objectContaining({ activeJobId: status.jobId }),
          }),
        }),
        expect.objectContaining({
          type: 'job.progress.emitted',
          body: { kind: 'missing_launch_record' },
        }),
        expect.objectContaining({
          type: 'job.terminal.recorded',
          body: expect.objectContaining({
            terminal: expect.objectContaining({ durationMs: 0, outcome: expect.objectContaining({ kind: 'failed' }) }),
          }),
        }),
      ]);

      const detail = progressStore.loadJobProjectionDetail(status.jobId);
      expect(detail.launch).toBeNull();
      expect(detail.status).toMatchObject({ phase: 'error', result: { outcome: { kind: 'failed' } } });
    } finally {
      db.close();
    }
  });
});
