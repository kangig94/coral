import { currentCoralStoreFormat } from '#src/store-format.js';
import { describe, expect, it } from 'vitest';

import { newRawDatabase } from '#tests/helpers/test-db.js';

import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { composeReducers, defineDomainEvent, type DomainEventRegistry } from '#src/store/reducers.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import type { StoreReadContext } from '#src/store/body-codec.js';
import type { CoralEventInput } from '#src/store/envelope.js';
import type { RetentionPolicy, ProviderSession } from '#src/sessions/entry.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { z } from 'zod';
import { readProjectionProviderSession } from '#src/sessions/projections.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import {
  readSessionRetentionWorkForEntries,
  readSessionRetentionWorkForPairs,
  readSessionRetentionWorkForSessionIds,
  sessionRetentionWorkKey,
} from '#src/sessions/retention-work.js';

const NOW = new Date('2026-06-11T00:00:00.000Z');
const DISCARD: RetentionPolicy = 'discard_provider_artifacts_on_terminal';
const retentionQueryEventRegistry: DomainEventRegistry = {
  streamKind: 'job',
  entries: [
    defineDomainEvent({
      type: 'job.terminal.recorded',
      schema: z.object({ jobId: z.string() }).strict(),
    }),
  ],
};

function sessionEntry(sessionId: string, retention: RetentionPolicy = DISCARD): ProviderSession {
  return {
    sessionId,
    binding: TEST_CODEX_BINDING,
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
  readCtx: StoreReadContext;
  commit: (inputs: readonly CoralEventInput[]) => void;
  close: () => void;
};

function newHarness(): Harness {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  const reducers = composeReducers(retentionQueryEventRegistry, sessionsRegistry);
  const bodyCodec = createEventBodyCodec();
  return {
    db,
    readCtx: { schemas: reducers.schemas, streamKinds: reducers.streamKinds, bodyCodec },
    commit: (inputs) => {
      commitInputs(db, inputs, { now: () => NOW, reducers, bodyCodec, providers: permissiveProviderLookupPort });
    },
    close: () => db.close(),
  };
}

function openedInput(entry: ProviderSession): CoralEventInput {
  return {
    type: 'session.opened',
    stream: { kind: 'session', id: entry.sessionId },
    refs: { sessionId: entry.sessionId },
    body: { entry, controller: 'default', scope_key: `scope-${entry.sessionId}` },
  };
}

function claimedEntry(entry: ProviderSession, jobId: string): ProviderSession {
  return {
    ...entry,
    activeJobId: jobId,
    lastUsedAt: NOW.toISOString(),
    version: entry.version + 1,
  };
}

function claimInput(entry: ProviderSession, jobId: string): CoralEventInput {
  const nextEntry = claimedEntry(entry, jobId);
  return {
    type: 'session.claimed',
    stream: { kind: 'session', id: entry.sessionId },
    refs: { sessionId: entry.sessionId, jobId },
    body: { entry: nextEntry, jobId },
  };
}

function releasedEntry(entry: ProviderSession, jobId: string): ProviderSession {
  if (entry.activeJobId !== jobId) {
    throw new Error(`Cannot release '${jobId}' from session '${entry.sessionId}' claimed by '${entry.activeJobId}'.`);
  }
  const { activeJobId: _activeJobId, ...withoutActiveJob } = entry;
  return {
    ...withoutActiveJob,
    lastUsedAt: NOW.toISOString(),
    version: entry.version + 1,
  };
}

function claimReleasedInput(entry: ProviderSession, jobId: string): CoralEventInput {
  const nextEntry = releasedEntry(entry, jobId);
  return {
    type: 'session.claim.released',
    stream: { kind: 'session', id: entry.sessionId },
    refs: { sessionId: entry.sessionId, jobId },
    body: { entry: nextEntry, jobId },
  };
}

// This query fixture registers the minimal body contract it writes explicitly.
function jobTerminalInput(jobId: string, sessionId: string): CoralEventInput {
  return {
    type: 'job.terminal.recorded',
    stream: { kind: 'job', id: jobId },
    refs: { jobId, sessionId },
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
      body: base,
    },
    outcome === 'completed'
      ? {
          type: 'session.retention.discard.completed',
          stream: { kind: 'session', id: sessionId },
          refs: { sessionId },
          body: { ...base, outcome: 'discarded' },
        }
      : {
          type: 'session.retention.discard.failed',
          stream: { kind: 'session', id: sessionId },
          refs: { sessionId },
          body: { ...base, reason: 'provider unreachable' },
        },
  ];
}

function continuationLeaseRecordedInput(entry: ProviderSession, expiresAt: string): CoralEventInput {
  const lease = {
    status: 'pending' as const,
    staleJobId: 'job-stale',
    workflowId: 'workflow-1',
    workflowSlotId: 'workflow-1:0:0',
    replacementGeneration: 1,
    reason: 'stale_recovery' as const,
    expiresAt,
    recordedAt: NOW.toISOString(),
  };
  const nextEntry: ProviderSession = {
    ...entry,
    continuationLease: lease,
    version: entry.version + 1,
  };
  return {
    type: 'session.continuation_lease.recorded',
    stream: { kind: 'session', id: entry.sessionId },
    refs: { sessionId: entry.sessionId, jobId: 'job-stale' },
    body: { entry: nextEntry, sessionId: entry.sessionId, lease },
  };
}

/** Open a retained session, release `jobIds` claims, and record their terminals. */
function seedRetainedSession(h: Harness, sessionId: string, jobIds: readonly string[]): ProviderSession {
  const opened = sessionEntry(sessionId);
  const inputs: CoralEventInput[] = [openedInput(opened)];
  let entry = opened;
  for (const jobId of jobIds) {
    const claimed = claimedEntry(entry, jobId);
    inputs.push(claimInput(entry, jobId), claimReleasedInput(claimed, jobId), jobTerminalInput(jobId, sessionId));
    entry = releasedEntry(claimed, jobId);
  }
  h.commit(inputs);
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
        expect(readSessionRetentionWorkForSessionIds(h.db, h.readCtx, [])).toEqual([]);
      } finally {
        h.close();
      }
    });

    it('should return one work item per released terminal job for a retained session', () => {
      const h = newHarness();
      try {
        seedRetainedSession(h, 'session-1', ['job-1']);

        const work = readSessionRetentionWorkForSessionIds(h.db, h.readCtx, ['session-1']);
        expect(work).toHaveLength(1);
        expect(work[0]).toMatchObject({ sessionId: 'session-1', jobId: 'job-1' });
        expect(work[0].entry).toEqual(readProjectionProviderSession(h.db, 'session-1'));
      } finally {
        h.close();
      }
    });

    it('should deduplicate repeated session ids in the batch', () => {
      const h = newHarness();
      try {
        seedRetainedSession(h, 'session-1', ['job-1']);

        expect(readSessionRetentionWorkForSessionIds(h.db, h.readCtx, ['session-1', 'session-1'])).toHaveLength(1);
      } finally {
        h.close();
      }
    });

    it('should skip session ids without projection rows', () => {
      const h = newHarness();
      try {
        seedRetainedSession(h, 'session-1', ['job-1']);

        const work = readSessionRetentionWorkForSessionIds(h.db, h.readCtx, ['missing', 'session-1']);
        expect(work.map((item) => item.sessionId)).toEqual(['session-1']);
      } finally {
        h.close();
      }
    });

    it('should exclude sessions whose retention policy is retain', () => {
      const h = newHarness();
      try {
        const entry = sessionEntry('session-retain', 'retain');
        const claimed = claimedEntry(entry, 'job-1');
        h.commit([
          openedInput(entry),
          claimInput(entry, 'job-1'),
          claimReleasedInput(claimed, 'job-1'),
          jobTerminalInput('job-1', 'session-retain'),
        ]);

        expect(readSessionRetentionWorkForSessionIds(h.db, h.readCtx, ['session-retain'])).toEqual([]);
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

          expect(readSessionRetentionWorkForSessionIds(h.db, h.readCtx, ['session-done'])).toEqual([]);
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

        expect(readSessionRetentionWorkForSessionIds(h.db, h.readCtx, ['session-unreleased'])).toEqual([]);
      } finally {
        h.close();
      }
    });

    it('should exclude sessions with active jobs, protective leases, or in-flight discard requests', () => {
      const h = newHarness();
      try {
        const active = seedRetainedSession(h, 'session-active', ['job-released']);
        h.commit([claimInput(active, 'job-active')]);

        const leased = seedRetainedSession(h, 'session-leased', ['job-1']);
        h.commit([continuationLeaseRecordedInput(leased, new Date(NOW.getTime() + 60_000).toISOString())]);

        seedRetainedSession(h, 'session-requested', ['job-r']);
        h.commit([
          {
            type: 'session.retention.discard.requested',
            stream: { kind: 'session', id: 'session-requested' },
            refs: { sessionId: 'session-requested' },
            body: { sessionId: 'session-requested', attempt: 1, handles: [] },
          },
        ]);

        expect(
          readSessionRetentionWorkForSessionIds(
            h.db,
            h.readCtx,
            ['session-active', 'session-leased', 'session-requested'],
            {
              nowMs: NOW.getTime(),
            },
          ),
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
          readSessionRetentionWorkForSessionIds(h.db, h.readCtx, ['session-expired-lease'], {
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
        const claimed = claimedEntry(entry, 'job-1');
        h.commit([openedInput(entry), claimInput(entry, 'job-1'), claimReleasedInput(claimed, 'job-1')]);

        expect(readSessionRetentionWorkForSessionIds(h.db, h.readCtx, ['session-running'])).toEqual([]);
      } finally {
        h.close();
      }
    });

    it('should return one work item per job for sessions with multiple released terminal jobs', () => {
      const h = newHarness();
      try {
        seedRetainedSession(h, 'session-multi', ['job-a', 'job-b']);

        const work = readSessionRetentionWorkForSessionIds(h.db, h.readCtx, ['session-multi']);
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
        const claimedRetain = claimedEntry(retain, 'job-r');
        h.commit([
          openedInput(retain),
          claimInput(retain, 'job-r'),
          claimReleasedInput(claimedRetain, 'job-r'),
          jobTerminalInput('job-r', 'session-retain'),
        ]);

        const work = readSessionRetentionWorkForEntries(h.db, h.readCtx, [retain, retained, retained]);
        expect(work).toHaveLength(1);
        expect(work[0]).toMatchObject({ sessionId: 'session-1', jobId: 'job-1' });
      } finally {
        h.close();
      }
    });

    it('should return empty work when no entry is retained for discard', () => {
      const h = newHarness();
      try {
        expect(readSessionRetentionWorkForEntries(h.db, h.readCtx, [sessionEntry('session-x', 'retain')])).toEqual([]);
        expect(readSessionRetentionWorkForEntries(h.db, h.readCtx, [])).toEqual([]);
      } finally {
        h.close();
      }
    });
  });

  describe('readSessionRetentionWorkForPairs', () => {
    it('should return an empty map for empty pairs', () => {
      const h = newHarness();
      try {
        expect(readSessionRetentionWorkForPairs(h.db, h.readCtx, []).size).toBe(0);
      } finally {
        h.close();
      }
    });

    it('should key matched pairs by the session/job work key', () => {
      const h = newHarness();
      try {
        seedRetainedSession(h, 'session-1', ['job-1']);

        const work = readSessionRetentionWorkForPairs(h.db, h.readCtx, [{ sessionId: 'session-1', jobId: 'job-1' }]);
        expect(work.size).toBe(1);
        const item = work.get(sessionRetentionWorkKey('session-1', 'job-1'));
        expect(item).toMatchObject({ sessionId: 'session-1', jobId: 'job-1' });
        expect(item?.entry).toEqual(readProjectionProviderSession(h.db, 'session-1'));
      } finally {
        h.close();
      }
    });

    it('should exclude pairs whose job was not released for the session', () => {
      const h = newHarness();
      try {
        seedRetainedSession(h, 'session-1', ['job-1']);

        expect(
          readSessionRetentionWorkForPairs(h.db, h.readCtx, [{ sessionId: 'session-1', jobId: 'job-other' }]).size,
        ).toBe(0);
      } finally {
        h.close();
      }
    });

    it('should exclude pairs for unknown, retain-policy, or already-discarded sessions', () => {
      const h = newHarness();
      try {
        const retain = sessionEntry('session-retain', 'retain');
        const claimedRetain = claimedEntry(retain, 'job-r');
        h.commit([
          openedInput(retain),
          claimInput(retain, 'job-r'),
          claimReleasedInput(claimedRetain, 'job-r'),
          jobTerminalInput('job-r', 'session-retain'),
        ]);
        seedRetainedSession(h, 'session-done', ['job-d']);
        h.commit(discardOutcomeInputs('session-done', 'completed'));

        const work = readSessionRetentionWorkForPairs(h.db, h.readCtx, [
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

        const work = readSessionRetentionWorkForPairs(h.db, h.readCtx, [
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
