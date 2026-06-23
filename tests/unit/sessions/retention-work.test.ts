import { describe, expect, it } from 'vitest';

import { newRawDatabase } from '#tests/helpers/test-db.js';

import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { composeReducers } from '#src/store/reducers.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import type { CoralEventInput } from '#src/store/envelope.js';
import type { RetentionPolicy, SessionEntry } from '#src/sessions/entry.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { readProjectionSessionEntry } from '#src/sessions/projections.js';
import {
  readSessionRetentionWorkForEntries,
  readSessionRetentionWorkForPairs,
  readSessionRetentionWorkForSessionIds,
  sessionRetentionWorkKey,
} from '#src/sessions/retention-work.js';

const NOW = new Date('2026-06-11T00:00:00.000Z');
const DISCARD: RetentionPolicy = 'discard_provider_artifacts_on_terminal';

function sessionEntry(sessionId: string, retention: RetentionPolicy = DISCARD): SessionEntry {
  return {
    sessionId,
    provider: 'codex',
    name: sessionId,
    state: 'pending',
    retention,
    artifactHandles: [],
    retentionDiscard: { attempts: [] },
    cwd: '/tmp/project',
    projectRoot: '/tmp/project',
    backendNamespace: 'ns-a',
    providerContinuity: null,
    createdAt: NOW.toISOString(),
    lastUsedAt: NOW.toISOString(),
    version: 1,
  };
}

type Harness = {
  db: Database;
  commit: (inputs: readonly CoralEventInput[]) => void;
  close: () => void;
};

function newHarness(): Harness {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db);
  const reducers = composeReducers(sessionsRegistry);
  const upcasters = createDefaultUpcasterRegistry();
  return {
    db,
    commit: (inputs) => {
      commitInputs(db, inputs, { now: () => NOW, reducers, upcasters, providers: permissiveProviderLookupPort });
    },
    close: () => db.close(),
  };
}

function openedInput(entry: SessionEntry): CoralEventInput {
  return {
    type: 'session.opened',
    stream: { kind: 'session', id: entry.sessionId },
    refs: { sessionId: entry.sessionId },
    bodyVersion: 1,
    body: { entry, controller: 'default', provider: entry.provider, scope_key: `scope-${entry.sessionId}` },
  };
}

function claimReleasedInput(entry: SessionEntry, jobId: string): CoralEventInput {
  return {
    type: 'session.claim.released',
    stream: { kind: 'session', id: entry.sessionId },
    refs: { sessionId: entry.sessionId, jobId },
    bodyVersion: 1,
    body: { entry, jobId },
  };
}

// `job.terminal.recorded` belongs to the jobs domain; only its refs matter to
// retention-work queries, so the body stays minimal and unregistered here.
function jobTerminalInput(jobId: string, sessionId: string): CoralEventInput {
  return {
    type: 'job.terminal.recorded',
    stream: { kind: 'job', id: jobId },
    refs: { jobId, sessionId },
    bodyVersion: 1,
    body: { jobId },
  };
}

function discardOutcomeInputs(sessionId: string, outcome: 'completed' | 'failed'): CoralEventInput[] {
  const base = { sessionId, attempt: 1, handles: [] as string[] };
  return [
    {
      type: 'session.retention.discard.requested',
      stream: { kind: 'session', id: sessionId },
      refs: { sessionId },
      bodyVersion: 1,
      body: base,
    },
    outcome === 'completed'
      ? {
          type: 'session.retention.discard.completed',
          stream: { kind: 'session', id: sessionId },
          refs: { sessionId },
          bodyVersion: 1,
          body: { ...base, outcome: 'discarded' },
        }
      : {
          type: 'session.retention.discard.failed',
          stream: { kind: 'session', id: sessionId },
          refs: { sessionId },
          bodyVersion: 1,
          body: { ...base, reason: 'provider unreachable' },
        },
  ];
}

function continuationLeaseRecordedInput(entry: SessionEntry, expiresAt: string): CoralEventInput {
  const lease = {
    status: 'pending' as const,
    staleJobId: 'job-stale',
    reason: 'stale_recovery' as const,
    expiresAt,
    recordedAt: NOW.toISOString(),
  };
  const nextEntry: SessionEntry = {
    ...entry,
    continuationLease: lease,
    version: entry.version + 1,
  };
  return {
    type: 'session.continuation_lease.recorded',
    stream: { kind: 'session', id: entry.sessionId },
    refs: { sessionId: entry.sessionId, jobId: 'job-stale' },
    bodyVersion: 1,
    body: { entry: nextEntry, sessionId: entry.sessionId, lease },
  };
}

/** Open a retained session, release `jobIds` claims, and record their terminals. */
function seedRetainedSession(h: Harness, sessionId: string, jobIds: readonly string[]): SessionEntry {
  const entry = sessionEntry(sessionId);
  h.commit([
    openedInput(entry),
    ...jobIds.flatMap((jobId) => [claimReleasedInput(entry, jobId), jobTerminalInput(jobId, sessionId)]),
  ]);
  return entry;
}

describe('sessions retention-work', () => {
  describe('sessionRetentionWorkKey', () => {
    it('should join session and job ids with a NUL separator', () => {
      expect(sessionRetentionWorkKey('session-1', 'job-1')).toBe('session-1\u0000job-1');
    });
  });

  describe('readSessionRetentionWorkForSessionIds', () => {
    it('should return empty work for an empty session id batch', () => {
      const h = newHarness();
      try {
        expect(readSessionRetentionWorkForSessionIds(h.db, [])).toEqual([]);
      } finally {
        h.close();
      }
    });

    it('should return one work item per released terminal job for a retained session', () => {
      const h = newHarness();
      try {
        seedRetainedSession(h, 'session-1', ['job-1']);

        const work = readSessionRetentionWorkForSessionIds(h.db, ['session-1']);
        expect(work).toHaveLength(1);
        expect(work[0]).toMatchObject({ sessionId: 'session-1', jobId: 'job-1' });
        expect(work[0].entry).toEqual(readProjectionSessionEntry(h.db, 'session-1'));
      } finally {
        h.close();
      }
    });

    it('should deduplicate repeated session ids in the batch', () => {
      const h = newHarness();
      try {
        seedRetainedSession(h, 'session-1', ['job-1']);

        expect(readSessionRetentionWorkForSessionIds(h.db, ['session-1', 'session-1'])).toHaveLength(1);
      } finally {
        h.close();
      }
    });

    it('should skip session ids without projection rows', () => {
      const h = newHarness();
      try {
        seedRetainedSession(h, 'session-1', ['job-1']);

        const work = readSessionRetentionWorkForSessionIds(h.db, ['missing', 'session-1']);
        expect(work.map((item) => item.sessionId)).toEqual(['session-1']);
      } finally {
        h.close();
      }
    });

    it('should exclude sessions whose retention policy is retain', () => {
      const h = newHarness();
      try {
        const entry = sessionEntry('session-retain', 'retain');
        h.commit([openedInput(entry), claimReleasedInput(entry, 'job-1'), jobTerminalInput('job-1', 'session-retain')]);

        expect(readSessionRetentionWorkForSessionIds(h.db, ['session-retain'])).toEqual([]);
      } finally {
        h.close();
      }
    });

    it.each(['completed', 'failed'] as const)(
      'should exclude sessions that already recorded a %s discard outcome',
      (outcome) => {
        const h = newHarness();
        try {
          seedRetainedSession(h, 'session-done', ['job-1']);
          h.commit(discardOutcomeInputs('session-done', outcome));

          expect(readSessionRetentionWorkForSessionIds(h.db, ['session-done'])).toEqual([]);
        } finally {
          h.close();
        }
      },
    );

    it('should exclude sessions whose terminal jobs were never claim-released', () => {
      const h = newHarness();
      try {
        const entry = sessionEntry('session-unreleased');
        h.commit([openedInput(entry), jobTerminalInput('job-1', 'session-unreleased')]);

        expect(readSessionRetentionWorkForSessionIds(h.db, ['session-unreleased'])).toEqual([]);
      } finally {
        h.close();
      }
    });

    it('should exclude sessions with active jobs, protective leases, or in-flight discard requests', () => {
      const h = newHarness();
      try {
        const active = sessionEntry('session-active');
        const activeWithJob = { ...active, activeJobId: 'job-active' };
        h.commit([
          openedInput(activeWithJob),
          claimReleasedInput(activeWithJob, 'job-active'),
          jobTerminalInput('job-active', 'session-active'),
        ]);

        const leased = seedRetainedSession(h, 'session-leased', ['job-1']);
        h.commit([continuationLeaseRecordedInput(leased, new Date(NOW.getTime() + 60_000).toISOString())]);

        seedRetainedSession(h, 'session-requested', ['job-r']);
        h.commit([
          {
            type: 'session.retention.discard.requested',
            stream: { kind: 'session', id: 'session-requested' },
            refs: { sessionId: 'session-requested' },
            bodyVersion: 1,
            body: { sessionId: 'session-requested', attempt: 1, handles: [] },
          },
        ]);

        expect(
          readSessionRetentionWorkForSessionIds(h.db, ['session-active', 'session-leased', 'session-requested'], {
            nowMs: NOW.getTime(),
          }),
        ).toEqual([]);
      } finally {
        h.close();
      }
    });

    it('should include sessions after a pending continuation lease expires', () => {
      const h = newHarness();
      try {
        const leased = seedRetainedSession(h, 'session-expired-lease', ['job-1']);
        h.commit([continuationLeaseRecordedInput(leased, new Date(NOW.getTime() + 60_000).toISOString())]);

        expect(
          readSessionRetentionWorkForSessionIds(h.db, ['session-expired-lease'], {
            nowMs: NOW.getTime() + 60_001,
          }).map((item) => item.sessionId),
        ).toEqual(['session-expired-lease']);
      } finally {
        h.close();
      }
    });

    it('should exclude sessions whose released jobs never recorded a terminal', () => {
      const h = newHarness();
      try {
        const entry = sessionEntry('session-running');
        h.commit([openedInput(entry), claimReleasedInput(entry, 'job-1')]);

        expect(readSessionRetentionWorkForSessionIds(h.db, ['session-running'])).toEqual([]);
      } finally {
        h.close();
      }
    });

    it('should return one work item per job for sessions with multiple released terminal jobs', () => {
      const h = newHarness();
      try {
        seedRetainedSession(h, 'session-multi', ['job-a', 'job-b']);

        const work = readSessionRetentionWorkForSessionIds(h.db, ['session-multi']);
        expect(work.map((item) => item.jobId).sort()).toEqual(['job-a', 'job-b']);
        expect(work.every((item) => item.sessionId === 'session-multi')).toBe(true);
      } finally {
        h.close();
      }
    });
  });

  describe('readSessionRetentionWorkForEntries', () => {
    it('should filter non-retained entries and deduplicate repeated session ids', () => {
      const h = newHarness();
      try {
        const retained = seedRetainedSession(h, 'session-1', ['job-1']);
        const retain = sessionEntry('session-retain', 'retain');
        h.commit([
          openedInput(retain),
          claimReleasedInput(retain, 'job-r'),
          jobTerminalInput('job-r', 'session-retain'),
        ]);

        const work = readSessionRetentionWorkForEntries(h.db, [retain, retained, retained]);
        expect(work).toHaveLength(1);
        expect(work[0]).toMatchObject({ sessionId: 'session-1', jobId: 'job-1' });
      } finally {
        h.close();
      }
    });

    it('should return empty work when no entry is retained for discard', () => {
      const h = newHarness();
      try {
        expect(readSessionRetentionWorkForEntries(h.db, [sessionEntry('session-x', 'retain')])).toEqual([]);
        expect(readSessionRetentionWorkForEntries(h.db, [])).toEqual([]);
      } finally {
        h.close();
      }
    });
  });

  describe('readSessionRetentionWorkForPairs', () => {
    it('should return an empty map for empty pairs', () => {
      const h = newHarness();
      try {
        expect(readSessionRetentionWorkForPairs(h.db, []).size).toBe(0);
      } finally {
        h.close();
      }
    });

    it('should key matched pairs by the session/job work key', () => {
      const h = newHarness();
      try {
        seedRetainedSession(h, 'session-1', ['job-1']);

        const work = readSessionRetentionWorkForPairs(h.db, [{ sessionId: 'session-1', jobId: 'job-1' }]);
        expect(work.size).toBe(1);
        const item = work.get(sessionRetentionWorkKey('session-1', 'job-1'));
        expect(item).toMatchObject({ sessionId: 'session-1', jobId: 'job-1' });
        expect(item?.entry).toEqual(readProjectionSessionEntry(h.db, 'session-1'));
      } finally {
        h.close();
      }
    });

    it('should exclude pairs whose job was not released for the session', () => {
      const h = newHarness();
      try {
        seedRetainedSession(h, 'session-1', ['job-1']);

        expect(readSessionRetentionWorkForPairs(h.db, [{ sessionId: 'session-1', jobId: 'job-other' }]).size).toBe(0);
      } finally {
        h.close();
      }
    });

    it('should exclude pairs for unknown, retain-policy, or already-discarded sessions', () => {
      const h = newHarness();
      try {
        const retain = sessionEntry('session-retain', 'retain');
        h.commit([
          openedInput(retain),
          claimReleasedInput(retain, 'job-r'),
          jobTerminalInput('job-r', 'session-retain'),
        ]);
        seedRetainedSession(h, 'session-done', ['job-d']);
        h.commit(discardOutcomeInputs('session-done', 'completed'));

        const work = readSessionRetentionWorkForPairs(h.db, [
          { sessionId: 'missing', jobId: 'job-x' },
          { sessionId: 'session-retain', jobId: 'job-r' },
          { sessionId: 'session-done', jobId: 'job-d' },
        ]);
        expect(work.size).toBe(0);
      } finally {
        h.close();
      }
    });

    it('should match only the released pairs when a session has multiple jobs', () => {
      const h = newHarness();
      try {
        seedRetainedSession(h, 'session-multi', ['job-a', 'job-b']);

        const work = readSessionRetentionWorkForPairs(h.db, [
          { sessionId: 'session-multi', jobId: 'job-a' },
          { sessionId: 'session-multi', jobId: 'job-missing' },
        ]);
        expect([...work.keys()]).toEqual([sessionRetentionWorkKey('session-multi', 'job-a')]);
      } finally {
        h.close();
      }
    });
  });
});
