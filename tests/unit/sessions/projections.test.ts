import { currentCoralStoreFormat } from '#src/store-format.js';
import { describe, expect, it } from 'vitest';

import { newRawDatabase } from '#tests/helpers/test-db.js';

import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { composeReducers } from '#src/store/reducers.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import type { AppendedEvent } from '#src/store/append.js';
import type { CoralEventInput } from '#src/store/envelope.js';
import { CoralSetupError } from '#src/runtime/errors.js';
import type { ProviderSession } from '#src/sessions/entry.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import {
  TEST_CLAUDE_BINDING,
  TEST_CODEX_BINDING,
  withTestBindingLocation,
} from '#tests/helpers/provider-credentials.js';
import {
  listProjectionSessionEntries,
  readProjectionSession,
  readProjectionSessionEntriesById,
  readProjectionProviderSession,
} from '#src/sessions/projections.js';

const NOW = new Date('2026-06-11T00:00:00.000Z');

function sessionEntry(overrides: Partial<ProviderSession> & Pick<ProviderSession, 'sessionId'>): ProviderSession {
  return {
    sessionId: overrides.sessionId,
    binding: overrides.binding ?? TEST_CODEX_BINDING,
    name: overrides.name ?? overrides.sessionId,
    state: overrides.state ?? 'pending',
    retention: overrides.retention ?? 'retain',
    artifactHandles: overrides.artifactHandles ?? [],
    retentionDiscard: overrides.retentionDiscard ?? { attempts: [] },
    cwd: overrides.cwd ?? '/tmp/project',
    projectRoot: overrides.projectRoot ?? '/tmp/project',
    backendNamespace: overrides.backendNamespace ?? 'ns-a',
    providerContinuity: overrides.providerContinuity ?? null,
    createdAt: overrides.createdAt ?? NOW.toISOString(),
    lastUsedAt: overrides.lastUsedAt ?? NOW.toISOString(),
    version: overrides.version ?? 1,
    ...(overrides.activeJobId === undefined ? {} : { activeJobId: overrides.activeJobId }),
    ...(overrides.conversationRef === undefined ? {} : { conversationRef: overrides.conversationRef }),
    ...(overrides.controllerProfile === undefined ? {} : { controllerProfile: overrides.controllerProfile }),
  };
}

type Harness = {
  db: Database;
  commit: (inputs: readonly CoralEventInput[]) => AppendedEvent[];
  close: () => void;
};

function newHarness(): Harness {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  const reducers = composeReducers(sessionsRegistry);
  const bodyCodec = createEventBodyCodec();
  return {
    db,
    commit: (inputs) =>
      commitInputs(db, inputs, { now: () => NOW, reducers, bodyCodec, providers: permissiveProviderLookupPort }),
    close: () => db.close(),
  };
}

function sessionStream(sessionId: string): CoralEventInput['stream'] {
  return { kind: 'session', id: sessionId };
}

function openedInput(entry: ProviderSession, scopeKey: string): CoralEventInput {
  return {
    type: 'session.opened',
    stream: sessionStream(entry.sessionId),
    refs: { sessionId: entry.sessionId },
    body: { entry, controller: 'default', scope_key: scopeKey },
  };
}

function checkpointedInput(
  entry: ProviderSession,
  snapshot: { conversationRef: string | null; resumable: boolean },
): CoralEventInput {
  return {
    type: 'session.continuity.checkpointed',
    stream: sessionStream(entry.sessionId),
    refs: { sessionId: entry.sessionId },
    body: { entry, snapshot: { ...snapshot, providerContinuity: null } },
  };
}

function discardEventInput(
  type:
    | 'session.retention.discard.requested'
    | 'session.retention.discard.completed'
    | 'session.retention.discard.failed',
  sessionId: string,
  attempt: number,
  extra: Record<string, unknown> = {},
): CoralEventInput {
  return {
    type,
    stream: sessionStream(sessionId),
    refs: { sessionId },
    body: { sessionId, attempt, handles: ['/tmp/handle.jsonl'], ...extra },
  };
}

function expectSetupError(run: () => void, code: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CoralSetupError);
  expect((caught as CoralSetupError).code).toBe(code);
}

describe('sessions projections', () => {
  it('should project session.opened into a fresh projection row', () => {
    const h = newHarness();
    try {
      const entry = sessionEntry({ sessionId: 'session-open' });
      const appended = h.commit([openedInput(entry, 'scope-open')]);

      const row = readProjectionSession(h.db, 'session-open');
      expect(row).not.toBeNull();
      expect(row).toMatchObject({
        controller: 'default',
        provider: 'codex',
        resumable: false,
        conversationRef: null,
        scopeKey: 'scope-open',
        lastSeq: appended.at(-1)?.seq,
      });
      expect(row?.entry).toMatchObject({ sessionId: 'session-open', state: 'pending', version: 1 });
    } finally {
      h.close();
    }
  });

  it('rejects unknown controller profile fields instead of normalizing persisted data', () => {
    const h = newHarness();
    try {
      const entry = {
        ...sessionEntry({ sessionId: 'session-stale-transport' }),
        controllerProfile: { owner: 'team-a', claudeTransport: 'print' },
      } as unknown as ProviderSession;

      expect(() => h.commit([openedInput(entry, 'scope-stale-transport')])).toThrow();
      expect(readProjectionSession(h.db, 'session-stale-transport')).toBeNull();
    } finally {
      h.close();
    }
  });

  it('should update resumable and conversation ref from continuity checkpoint snapshots', () => {
    const h = newHarness();
    try {
      const opened = sessionEntry({ sessionId: 'session-ckpt' });
      const ready = sessionEntry({ ...opened, state: 'ready', conversationRef: 'thread-1', version: 2 });
      h.commit([
        openedInput(opened, 'scope-ckpt'),
        checkpointedInput(ready, { conversationRef: 'thread-1', resumable: true }),
      ]);

      expect(readProjectionSession(h.db, 'session-ckpt')).toMatchObject({
        resumable: true,
        conversationRef: 'thread-1',
      });

      const sealed = sessionEntry({ ...opened, state: 'non_resumable', version: 3 });
      h.commit([checkpointedInput(sealed, { conversationRef: null, resumable: false })]);

      expect(readProjectionSession(h.db, 'session-ckpt')).toMatchObject({
        resumable: false,
        conversationRef: null,
        entry: { state: 'non_resumable', version: 3 },
      });
    } finally {
      h.close();
    }
  });

  it('rejects a replay event that changes the persisted provider binding', () => {
    const h = newHarness();
    try {
      const opened = sessionEntry({
        sessionId: 'session-binding-immutable',
        binding: TEST_CODEX_BINDING,
      });
      h.commit([openedInput(opened, 'scope-binding-immutable')]);
      const changed = sessionEntry({
        ...opened,
        version: 2,
        binding: withTestBindingLocation(TEST_CODEX_BINDING, '/accounts/codex-b'),
      });

      expectSetupError(
        () => h.commit([checkpointedInput(changed, { conversationRef: null, resumable: false })]),
        'provider_session_binding_mismatch',
      );
      expect(readProjectionProviderSession(h.db, opened.sessionId)?.binding).toEqual(opened.binding);
    } finally {
      h.close();
    }
  });

  it('should replace the entry while preserving projection columns for claim events', () => {
    const h = newHarness();
    try {
      const opened = sessionEntry({ sessionId: 'session-claim' });
      const ready = sessionEntry({ ...opened, state: 'ready', conversationRef: 'thread-c', version: 2 });
      h.commit([
        openedInput(opened, 'scope-claim'),
        checkpointedInput(ready, { conversationRef: 'thread-c', resumable: true }),
      ]);

      const claimed = sessionEntry({ ...ready, activeJobId: 'job-1', version: 3 });
      h.commit([
        {
          type: 'session.claimed',
          stream: sessionStream('session-claim'),
          refs: { sessionId: 'session-claim', jobId: 'job-1' },
          body: { entry: claimed, jobId: 'job-1' },
        },
      ]);

      const afterClaim = readProjectionSession(h.db, 'session-claim');
      expect(afterClaim).toMatchObject({ resumable: true, conversationRef: 'thread-c', scopeKey: 'scope-claim' });
      expect(afterClaim?.entry.activeJobId).toBe('job-1');

      const released = sessionEntry({ ...ready, version: 4 });
      h.commit([
        {
          type: 'session.claim.released',
          stream: sessionStream('session-claim'),
          refs: { sessionId: 'session-claim', jobId: 'job-1' },
          body: { entry: released, jobId: 'job-1' },
        },
      ]);

      const afterRelease = readProjectionSession(h.db, 'session-claim');
      expect(afterRelease?.entry.activeJobId).toBeUndefined();
      expect(afterRelease?.entry.version).toBe(4);
      expect(afterRelease).toMatchObject({ resumable: true, conversationRef: 'thread-c' });
    } finally {
      h.close();
    }
  });

  it('should track retention discard attempts sorted by attempt with per-attempt replacement', () => {
    const h = newHarness();
    try {
      const entry = sessionEntry({
        sessionId: 'session-discard',
        retention: 'discard_provider_artifacts_on_terminal',
      });
      const causeRef = { stream: { kind: 'job', id: 'job-cause' }, seq: 1 } as const;
      h.commit([openedInput(entry, 'scope-discard')]);
      h.commit([discardEventInput('session.retention.discard.requested', 'session-discard', 1)]);

      const afterFirstRequest = readProjectionProviderSession(h.db, 'session-discard');
      expect(afterFirstRequest?.version).toBe(entry.version + 1);
      expect(afterFirstRequest?.retentionDiscard.attempts).toEqual([
        { attempt: 1, handles: ['/tmp/handle.jsonl'], status: 'requested' },
      ]);

      h.commit([discardEventInput('session.retention.discard.requested', 'session-discard', 2)]);
      h.commit([
        discardEventInput('session.retention.discard.completed', 'session-discard', 1, { outcome: 'discarded' }),
      ]);
      h.commit([
        discardEventInput('session.retention.discard.failed', 'session-discard', 2, {
          reason: 'provider unreachable',
          causeRef,
        }),
      ]);

      expect(readProjectionProviderSession(h.db, 'session-discard')?.retentionDiscard.attempts).toEqual([
        { attempt: 1, handles: ['/tmp/handle.jsonl'], status: 'completed', outcome: 'discarded' },
        { attempt: 2, handles: ['/tmp/handle.jsonl'], status: 'failed', reason: 'provider unreachable', causeRef },
      ]);
    } finally {
      h.close();
    }
  });

  it('should reject non-opened events arriving before session.opened', () => {
    const h = newHarness();
    try {
      const entry = sessionEntry({ sessionId: 'session-premature' });
      expectSetupError(
        () => h.commit([checkpointedInput(entry, { conversationRef: null, resumable: false })]),
        'provider_session_missing',
      );
      expectSetupError(
        () =>
          h.commit([
            {
              type: 'session.provider_failed',
              stream: sessionStream('session-premature'),
              refs: { sessionId: 'session-premature' },
              body: { provider: 'codex', reason: 'request_failed', message: 'transport reset' },
            },
          ]),
        'projection_sessions_premature_event',
      );
      expectSetupError(
        () => h.commit([discardEventInput('session.retention.discard.requested', 'session-premature', 1)]),
        'projection_sessions_premature_event',
      );
      expect(readProjectionSession(h.db, 'session-premature')).toBeNull();
    } finally {
      h.close();
    }
  });

  it('should reject session events whose entry does not match the stream id', () => {
    const h = newHarness();
    try {
      const entry = sessionEntry({ sessionId: 'session-other' });
      expectSetupError(
        () =>
          h.commit([
            {
              type: 'session.opened',
              stream: sessionStream('session-mismatch'),
              refs: { sessionId: 'session-mismatch' },
              body: { entry, controller: 'default', scope_key: 'scope-mismatch' },
            },
          ]),
        'provider_session_stream_mismatch',
      );
    } finally {
      h.close();
    }
  });

  it('keeps the derived provider bound to ProviderSession.binding across fault events', () => {
    const h = newHarness();
    try {
      const entry = sessionEntry({ sessionId: 'session-fault' });
      h.commit([openedInput(entry, 'scope-fault')]);
      h.commit([
        {
          type: 'session.provider_failed',
          stream: sessionStream('session-fault'),
          refs: { sessionId: 'session-fault' },
          body: { provider: 'codex-alt', reason: 'session_unavailable', message: 'gone' },
        },
      ]);

      const afterFailed = readProjectionSession(h.db, 'session-fault');
      expect(afterFailed?.provider).toBe('codex');
      expect(afterFailed?.entry.binding.provider).toBe('codex');

      h.commit([
        {
          type: 'session.adapter_unparseable',
          stream: sessionStream('session-fault'),
          refs: { sessionId: 'session-fault' },
          body: { provider: 'codex-raw', exitCode: null, stdout: '', stderr: '', parseError: 'unexpected EOF' },
        },
      ]);

      expect(readProjectionSession(h.db, 'session-fault')?.provider).toBe('codex');
    } finally {
      h.close();
    }
  });

  it('should keep the stored entry for session.interrupted faults', () => {
    const h = newHarness();
    try {
      const entry = sessionEntry({ sessionId: 'session-interrupt' });
      h.commit([openedInput(entry, 'scope-interrupt')]);
      h.commit([
        {
          type: 'session.interrupted',
          stream: sessionStream('session-interrupt'),
          refs: { sessionId: 'session-interrupt' },
          body: { trigger: 'handoff', continuity: 'pre_checkpoint_preserved' },
        },
      ]);

      expect(readProjectionProviderSession(h.db, 'session-interrupt')?.version).toBe(1);
    } finally {
      h.close();
    }
  });

  it('should return null for unknown session ids', () => {
    const h = newHarness();
    try {
      expect(readProjectionSession(h.db, 'missing')).toBeNull();
      expect(readProjectionProviderSession(h.db, 'missing')).toBeNull();
    } finally {
      h.close();
    }
  });

  it('should throw a setup error for corrupt or mismatched stored entry JSON', () => {
    const h = newHarness();
    try {
      const insert = h.db.prepare(
        `INSERT INTO projection_sessions (
           session_id, controller, resumable, conversation_ref, scope_key, entry, last_seq
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run('session-corrupt', 'default', 0, null, 'scope', 'not json', 1);
      insert.run('session-bad-shape', 'default', 0, null, 'scope', '{}', 1);
      insert.run(
        'session-id-mismatch',
        'default',
        0,
        null,
        'scope',
        JSON.stringify(sessionEntry({ sessionId: 'someone-else' })),
        1,
      );

      expectSetupError(() => readProjectionSession(h.db, 'session-corrupt'), 'projection_sessions_invalid_entry');
      expectSetupError(() => readProjectionSession(h.db, 'session-bad-shape'), 'projection_sessions_invalid_entry');
      expectSetupError(() => readProjectionSession(h.db, 'session-id-mismatch'), 'projection_sessions_invalid_entry');
    } finally {
      h.close();
    }
  });

  it('should read entries by id with duplicates collapsed and missing ids skipped', () => {
    const h = newHarness();
    try {
      h.commit([openedInput(sessionEntry({ sessionId: 'session-a' }), 'scope-a')]);

      expect(readProjectionSessionEntriesById(h.db, []).size).toBe(0);

      const missingSessionIds = Array.from({ length: 33_000 }, (_, index) => `missing-${index}`);
      const entries = readProjectionSessionEntriesById(h.db, ['session-a', ...missingSessionIds, 'session-a']);
      expect([...entries.keys()]).toEqual(['session-a']);
      expect(entries.get('session-a')?.sessionId).toBe('session-a');
    } finally {
      h.close();
    }
  });

  it('should list entries ordered by session id and filtered by provider and scope key', () => {
    const h = newHarness();
    try {
      h.commit([
        openedInput(sessionEntry({ sessionId: 'session-1' }), 'scope-x'),
        openedInput(sessionEntry({ sessionId: 'session-2', binding: TEST_CLAUDE_BINDING }), 'scope-x'),
        openedInput(sessionEntry({ sessionId: 'session-3' }), 'scope-y'),
      ]);

      expect(listProjectionSessionEntries(h.db).map((entry) => entry.sessionId)).toEqual([
        'session-1',
        'session-2',
        'session-3',
      ]);
      expect(listProjectionSessionEntries(h.db, 'codex').map((entry) => entry.sessionId)).toEqual([
        'session-1',
        'session-3',
      ]);
      expect(listProjectionSessionEntries(h.db, undefined, 'scope-x').map((entry) => entry.sessionId)).toEqual([
        'session-1',
        'session-2',
      ]);
      expect(listProjectionSessionEntries(h.db, 'codex', 'scope-y').map((entry) => entry.sessionId)).toEqual([
        'session-3',
      ]);
      expect(listProjectionSessionEntries(h.db, 'gemini')).toEqual([]);
    } finally {
      h.close();
    }
  });
});
