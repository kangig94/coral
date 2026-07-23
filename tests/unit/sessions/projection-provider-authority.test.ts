import { currentCoralStoreFormat } from '#src/store-format.js';
import { describe, expect, it } from 'vitest';

import { applyBundledStoreSchema } from '#src/store/db.js';
import type { ProviderLookupPort } from '#src/providers/catalog.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import type { ProviderSession } from '#src/sessions/entry.js';
import { createProjectionSessionLookup } from '#src/sessions/lookup.js';
import { listProjectionSessionEntries, readProjectionSession } from '#src/sessions/projections.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { commit } from '#src/store/append.js';
import type { CoralEventInput } from '#src/store/envelope.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { TEST_CLAUDE_BINDING, TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';

const NOW = '2026-07-22T00:00:00.000Z';

function session(sessionId: string, binding: ProviderSession['binding']): ProviderSession {
  return {
    sessionId,
    binding,
    name: sessionId,
    state: 'pending',
    retention: 'retain',
    artifactHandles: [],
    retentionDiscard: { attempts: [] },
    providerContinuity: null,
    cwd: '/tmp/project',
    projectRoot: '/tmp/project',
    backendNamespace: 'test',
    createdAt: NOW,
    lastUsedAt: NOW,
    version: 1,
  };
}

function openSession(
  db: ReturnType<typeof newRawDatabase>,
  entry: ProviderSession,
  providers: ProviderLookupPort,
): void {
  commitInputs(
    db,
    [
      {
        type: 'session.opened',
        stream: { kind: 'session', id: entry.sessionId },
        refs: { sessionId: entry.sessionId },
        body: { entry, controller: 'default', scope_key: 'test-scope' },
      },
    ],
    {
      now: () => new Date(NOW),
      reducers: composeReducers(sessionsRegistry),
      bodyCodec: createEventBodyCodec(),
      providers,
    },
  );
}

function rawCommit(
  db: ReturnType<typeof newRawDatabase>,
  inputs: readonly CoralEventInput[],
  providers: ProviderLookupPort = permissiveProviderLookupPort,
): void {
  commit(
    db,
    (c) => {
      for (const input of inputs) c.append(input as Parameters<typeof c.append>[0]);
      return undefined;
    },
    {
      now: () => new Date(NOW),
      reducers: composeReducers(sessionsRegistry),
      bodyCodec: createEventBodyCodec(),
      providers,
    },
  );
}

describe('projection session provider authority', () => {
  it('rejects session.opened snapshots that already carry a job claim', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const entry: ProviderSession = {
        ...session('claimed-at-open', TEST_CODEX_BINDING),
        activeJobId: 'injected-job',
      };

      expect(() =>
        rawCommit(db, [
          {
            type: 'session.opened',
            stream: { kind: 'session', id: entry.sessionId },
            refs: { sessionId: entry.sessionId },
            body: { entry, controller: 'default', scope_key: 'test-scope' },
          },
        ]),
      ).toThrowError('A newly opened provider session must have empty pending continuity and no active job.');
      expect((db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count).toBe(0);
    } finally {
      db.close();
    }
  });

  it('rejects continuity checkpoints that inject or clear a job claim', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const base = session('checkpoint-claim-authority', TEST_CODEX_BINDING);
      rawCommit(db, [
        {
          type: 'session.opened',
          stream: { kind: 'session', id: base.sessionId },
          refs: { sessionId: base.sessionId },
          body: { entry: base, controller: 'default', scope_key: 'test-scope' },
        },
      ]);

      const snapshot = { conversationRef: null, resumable: false, providerContinuity: null };
      expect(() =>
        rawCommit(db, [
          {
            type: 'session.continuity.checkpointed',
            stream: { kind: 'session', id: base.sessionId },
            refs: { sessionId: base.sessionId },
            body: { entry: { ...base, activeJobId: 'injected-job', version: 2 }, snapshot },
          },
        ]),
      ).toThrowError(expect.objectContaining({ code: 'provider_session_claim_transition_invalid' }));

      const claimed: ProviderSession = { ...base, activeJobId: 'claimed-job', version: 2 };
      rawCommit(db, [
        {
          type: 'session.claimed',
          stream: { kind: 'session', id: base.sessionId },
          refs: { sessionId: base.sessionId, jobId: 'claimed-job' },
          body: { entry: claimed, jobId: 'claimed-job' },
        },
      ]);
      const { activeJobId: _activeJobId, ...withoutClaim } = claimed;
      expect(() =>
        rawCommit(db, [
          {
            type: 'session.continuity.checkpointed',
            stream: { kind: 'session', id: base.sessionId },
            refs: { sessionId: base.sessionId },
            body: { entry: { ...withoutClaim, version: 3 }, snapshot },
          },
        ]),
      ).toThrowError(expect.objectContaining({ code: 'provider_session_claim_transition_invalid' }));

      expect((db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count).toBe(2);
      expect(readProjectionSession(db, base.sessionId)?.entry.activeJobId).toBe('claimed-job');
    } finally {
      db.close();
    }
  });

  it('rejects corrupt claim snapshots atomically', () => {
    const base = session('claim-invariants', TEST_CODEX_BINDING);
    const validClaim: ProviderSession = {
      ...base,
      activeJobId: 'job-1',
      lastUsedAt: '2026-07-22T00:00:01.000Z',
      version: 2,
    };
    const corruptClaims: ProviderSession[] = [
      { ...validClaim, activeJobId: 'other-job' },
      { ...validClaim, state: 'ready' },
      { ...validClaim, cwd: '/other-project' },
      { ...validClaim, version: 3 },
    ];

    for (const entry of corruptClaims) {
      const db = newRawDatabase(':memory:');
      try {
        applyBundledStoreSchema(db, currentCoralStoreFormat());
        openSession(db, base, permissiveProviderLookupPort);
        expect(() =>
          commitInputs(
            db,
            [
              {
                type: 'session.claimed',
                stream: { kind: 'session', id: base.sessionId },
                refs: { sessionId: base.sessionId, jobId: 'job-1' },
                body: { entry, jobId: 'job-1' },
              },
            ],
            {
              now: () => new Date(NOW),
              reducers: composeReducers(sessionsRegistry),
              bodyCodec: createEventBodyCodec(),
              providers: permissiveProviderLookupPort,
            },
          ),
        ).toThrowError(expect.objectContaining({ code: 'provider_session_claim_transition_invalid' }));
        expect((db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count).toBe(1);
      } finally {
        db.close();
      }
    }
  });

  it('rejects corrupt claim release snapshots atomically', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const base = session('release-invariants', TEST_CODEX_BINDING);
      const claimed: ProviderSession = { ...base, activeJobId: 'job-1', version: 2 };
      openSession(db, base, permissiveProviderLookupPort);
      const appendContext = {
        now: () => new Date(NOW),
        reducers: composeReducers(sessionsRegistry),
        bodyCodec: createEventBodyCodec(),
        providers: permissiveProviderLookupPort,
      };
      commitInputs(
        db,
        [
          {
            type: 'session.claimed',
            stream: { kind: 'session', id: base.sessionId },
            refs: { sessionId: base.sessionId, jobId: 'job-1' },
            body: { entry: claimed, jobId: 'job-1' },
          },
        ],
        appendContext,
      );

      const corruptRelease: ProviderSession = {
        ...base,
        state: 'ready',
        version: 3,
      };
      expect(() =>
        commitInputs(
          db,
          [
            {
              type: 'session.claim.released',
              stream: { kind: 'session', id: base.sessionId },
              refs: { sessionId: base.sessionId, jobId: 'job-1' },
              body: { entry: corruptRelease, jobId: 'job-1' },
            },
          ],
          appendContext,
        ),
      ).toThrowError(expect.objectContaining({ code: 'provider_session_claim_transition_invalid' }));
      expect((db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count).toBe(2);
    } finally {
      db.close();
    }
  });

  it('requires session.opened to name a registered provider whose codec accepts the binding', () => {
    const cases: Array<{ providers: ProviderLookupPort; code: string }> = [
      {
        providers: {
          hasProvider: () => false,
          validatePersistedBinding: () => ({ ok: false, message: 'unregistered' }),
          validatePersistedScope: () => ({ ok: false, message: 'unregistered' }),
        },
        code: 'provider_session_provider_unregistered',
      },
      {
        providers: {
          hasProvider: () => true,
          validatePersistedBinding: () => ({ ok: false, message: 'provider codec rejected fixture' }),
          validatePersistedScope: () => ({ ok: false, message: 'provider codec rejected fixture' }),
        },
        code: 'provider_session_binding_invalid',
      },
    ];

    for (const testCase of cases) {
      const db = newRawDatabase(':memory:');
      try {
        applyBundledStoreSchema(db, currentCoralStoreFormat());
        expect(() => openSession(db, session('rejected-session', TEST_CODEX_BINDING), testCase.providers)).toThrowError(
          expect.objectContaining({ code: testCase.code }),
        );
        expect((db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count).toBe(0);
        expect((db.prepare('SELECT COUNT(*) AS count FROM projection_sessions').get() as { count: number }).count).toBe(
          0,
        );
      } finally {
        db.close();
      }
    }
  });

  it('accepts session.opened only after the provider binding codec boundary succeeds', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      openSession(db, session('accepted-session', TEST_CODEX_BINDING), permissiveProviderLookupPort);
      expect(readProjectionSession(db, 'accepted-session')?.provider).toBe('codex');
    } finally {
      db.close();
    }
  });

  it('derives provider reads and filtering solely from ProviderSession.binding', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const insert = db.prepare(
        `INSERT INTO projection_sessions (
           session_id, controller, resumable, conversation_ref, scope_key, entry, last_seq
         ) VALUES (?, 'default', 0, NULL, 'scope', ?, 1)`,
      );
      insert.run('session-codex', JSON.stringify(session('session-codex', TEST_CODEX_BINDING)));
      insert.run('session-claude', JSON.stringify(session('session-claude', TEST_CLAUDE_BINDING)));

      const columns = db.prepare('PRAGMA table_info(projection_sessions)').all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toContain('provider');

      expect(readProjectionSession(db, 'session-codex')?.provider).toBe('codex');
      expect(readProjectionSession(db, 'session-claude')?.provider).toBe('claude');
      expect(listProjectionSessionEntries(db, 'codex').map((entry) => entry.sessionId)).toEqual(['session-codex']);
      expect(listProjectionSessionEntries(db, 'claude').map((entry) => entry.sessionId)).toEqual(['session-claude']);
      expect(createProjectionSessionLookup(db).listSessionRefs()).toEqual([
        { sessionId: 'session-claude', provider: 'claude' },
        { sessionId: 'session-codex', provider: 'codex' },
      ]);
    } finally {
      db.close();
    }
  });
});
