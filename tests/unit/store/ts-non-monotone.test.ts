
import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { commit, type AppendContext } from '#src/store/append.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { composeReducers } from '#src/store/reducers.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import type { SessionEntry } from '#src/sessions/entry.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';

// S5: `ts` is informational only; producers (notably discuss restoration) may
// emit `tsOverride` values earlier than MAX(ts). `seq` remains strictly
// monotone via coordinator reservation. Spec §4.1.

const NOW = new Date('2026-04-19T00:00:00.000Z');

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db);
  return db;
}

function ctx(): AppendContext {
  return {
    now: () => NOW,
    reducers: composeReducers(sessionsRegistry),
    upcasters: createDefaultUpcasterRegistry(),
    providers: permissiveProviderLookupPort,
  };
}

function sessionEntry(sessionId: string): SessionEntry {
  return {
    sessionId,
    provider: 'codex',
    name: sessionId,
    state: 'pending',
    cwd: `/workspace/${sessionId}`,
    projectRoot: `/workspace/${sessionId}`,
    backendNamespace: 'tests',
    providerContinuity: null,
    createdAt: NOW.toISOString(),
    lastUsedAt: NOW.toISOString(),
    version: 1,
  };
}

describe('ts non-monotone policy (S5)', () => {
  it('accepts tsOverride earlier than the previous event ts and preserves strict seq monotonicity', () => {
    const db = createDb();
    try {
      const past = '2026-04-10T08:00:00.000Z';

      const appended = commit(
        db,
        (c) => {
          c.append({
            type: 'session.opened',
            stream: { kind: 'session', id: 'session-live' },
            refs: { sessionId: 'session-live' },
            bodyVersion: 1,
            body: {
              entry: sessionEntry('session-live'),
              controller: 'default',
              provider: 'codex',
              scope_key: 'tests',
            },
          });
          // Restoration replays a historical session AFTER the live one,
          // overriding ts to a value earlier than the previous event.
          c.append({
            type: 'session.opened',
            stream: { kind: 'session', id: 'session-archived' },
            refs: { sessionId: 'session-archived' },
            bodyVersion: 1,
            tsOverride: past,
            body: {
              entry: sessionEntry('session-archived'),
              controller: 'default',
              provider: 'codex',
              scope_key: 'tests',
            },
          });
          return undefined;
        },
        ctx(),
      );

      expect(appended.map((event) => event.seq)).toEqual([1, 2]);
      expect(appended[0].ts).toBe(NOW.toISOString());
      expect(appended[1].ts).toBe(past);
      // ts is non-monotone here (event 2 is earlier) but seq is strictly
      // monotone — proving the documented policy.
      expect(appended[1].ts < appended[0].ts).toBe(true);
      expect(appended[1].seq).toBeGreaterThan(appended[0].seq);
    } finally {
      db.close();
    }
  });
});
