import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { composeReducers } from '#src/store/reducers.js';
import { rebuildProjections } from '#tests/helpers/rebuild-projections.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import type { SessionEntry } from '#src/sessions/entry.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';

const SCHEMAS_DIR = join(process.cwd(), 'src/store/schemas');
const storageAdapter = {
  readdirSync: (path: string, opts: { withFileTypes: true }) => fs.readdirSync(path, opts),
  readFileSync: (path: string, enc: 'utf-8') => fs.readFileSync(path, enc),
};
const NOW = new Date('2026-04-19T00:00:00.000Z');

function sessionEntry(overrides: Partial<SessionEntry> & Pick<SessionEntry, 'sessionId' | 'provider'>): SessionEntry {
  return {
    sessionId: overrides.sessionId,
    provider: overrides.provider,
    name: overrides.name ?? overrides.sessionId,
    state: overrides.state ?? 'pending',
    cwd: overrides.cwd ?? '/tmp/project',
    projectRoot: overrides.projectRoot ?? '/tmp/project',
    backendNamespace: overrides.backendNamespace ?? 'ns-a',
    createdAt: overrides.createdAt ?? NOW.toISOString(),
    lastUsedAt: overrides.lastUsedAt ?? NOW.toISOString(),
    version: overrides.version ?? 1,
    ...(overrides.activeJobId === undefined ? {} : { activeJobId: overrides.activeJobId }),
    ...(overrides.conversationRef === undefined ? {} : { conversationRef: overrides.conversationRef }),
    ...(overrides.providerContinuity === undefined ? {} : { providerContinuity: overrides.providerContinuity }),
    ...(overrides.model === undefined ? {} : { model: overrides.model }),
    ...(overrides.agentName === undefined ? {} : { agentName: overrides.agentName }),
    ...(overrides.instruction === undefined ? {} : { instruction: overrides.instruction }),
    ...(overrides.bypassPermissions === undefined ? {} : { bypassPermissions: overrides.bypassPermissions }),
    ...(overrides.systemPrompt === undefined ? {} : { systemPrompt: overrides.systemPrompt }),
    ...(overrides.controllerProfile === undefined ? {} : { controllerProfile: overrides.controllerProfile }),
  };
}

describe('sessions reducer equivalence', () => {
  it('rebuilds projection_sessions rows byte-identically from a historical event sequence', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyStoreSchemas({ db, storage: storageAdapter as never, schemasDir: SCHEMAS_DIR });
      const reducers = composeReducers(sessionsRegistry);
      const upcasters = createDefaultUpcasterRegistry();
      const scopeKey = createHash('sha1').update('session-1').digest('hex').slice(0, 12);
      const openedEntry = sessionEntry({
        sessionId: 'session-1',
        provider: 'codex',
        controllerProfile: { owner: 'team-a' },
      });
      const readyEntry = sessionEntry({
        ...openedEntry,
        state: 'ready',
        conversationRef: 'thread-1',
        providerContinuity: { threadId: 'thread-1', turnId: 'turn-1' },
        version: 2,
      });
      const sealedEntry = sessionEntry({
        ...readyEntry,
        state: 'non_resumable',
        conversationRef: undefined,
        providerContinuity: { threadId: 'thread-1' },
        version: 3,
      });

      const appended = commitInputs(
        db,
        [
          {
            type: 'session.opened',
            stream: { kind: 'session', id: 'session-1' },
            refs: { sessionId: 'session-1' },
            bodyVersion: 1,
            body: {
              entry: openedEntry,
              controller: 'team-a',
              provider: 'codex',
              scope_key: scopeKey,
            },
          },
          {
            type: 'session.continuity.checkpointed',
            stream: { kind: 'session', id: 'session-1' },
            refs: { sessionId: 'session-1' },
            bodyVersion: 1,
            body: {
              entry: readyEntry,
              snapshot: {
                conversationRef: 'thread-1',
                resumable: true,
                providerContinuity: { threadId: 'thread-1', turnId: 'turn-1' },
              },
            },
          },
          {
            type: 'session.interrupted',
            stream: { kind: 'session', id: 'session-1' },
            refs: { sessionId: 'session-1' },
            bodyVersion: 1,
            body: {
              trigger: 'handoff',
              continuity: 'pre_checkpoint_preserved',
            },
          },
          {
            type: 'session.provider_failed',
            stream: { kind: 'session', id: 'session-1' },
            refs: { sessionId: 'session-1' },
            bodyVersion: 1,
            body: {
              provider: 'codex',
              reason: 'request_failed',
              message: 'transport reset',
            },
          },
          {
            type: 'session.adapter_unparseable',
            stream: { kind: 'session', id: 'session-1' },
            refs: { sessionId: 'session-1' },
            bodyVersion: 1,
            body: {
              provider: 'codex',
              exitCode: null,
              stdout: 'partial stdout',
              stderr: 'partial stderr',
              parseError: 'unexpected EOF',
            },
          },
          {
            type: 'session.continuity.checkpointed',
            stream: { kind: 'session', id: 'session-1' },
            refs: { sessionId: 'session-1' },
            bodyVersion: 1,
            body: {
              entry: sealedEntry,
              snapshot: {
                conversationRef: null,
                resumable: false,
                providerContinuity: { threadId: 'thread-1' },
              },
            },
          },
        ],
        { now: () => NOW, reducers, upcasters, providers: permissiveProviderLookupPort },
      );

      const v1OpenEvent = db
        .prepare(
          `SELECT body_version
           FROM events
          WHERE stream_kind = 'session'
            AND stream_id = ?
            AND type = 'session.opened'
          ORDER BY seq ASC
          LIMIT 1`,
        )
        .get('session-1') as { body_version: number } | undefined;

      const before = db
        .prepare(
          `SELECT session_id, controller, provider, resumable, conversation_ref, scope_key, last_seq
           FROM projection_sessions
          WHERE session_id = ?
          LIMIT 1`,
        )
        .get('session-1');

      expect(before).toEqual({
        session_id: 'session-1',
        controller: 'team-a',
        provider: 'codex',
        resumable: 0,
        conversation_ref: null,
        scope_key: scopeKey,
        last_seq: appended.at(-1)?.seq,
      });
      expect(v1OpenEvent?.body_version).toBe(1);

      rebuildProjections({
        db,
        cutoffSeq: appended.at(-1)?.seq ?? 0,
        reducers,
        upcasters,
      });

      const after = db
        .prepare(
          `SELECT session_id, controller, provider, resumable, conversation_ref, scope_key, last_seq
           FROM projection_sessions
          WHERE session_id = ?
          LIMIT 1`,
        )
        .get('session-1');

      expect(after).toStrictEqual(before);
    } finally {
      db.close();
    }
  });

  it('round-trips canonical session.opened rows without rewriting scope_key or body_version', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyStoreSchemas({ db, storage: storageAdapter as never, schemasDir: SCHEMAS_DIR });
      const reducers = composeReducers(sessionsRegistry);
      const upcasters = createDefaultUpcasterRegistry();
      const scopeKey = 'canonical-scope';
      const openedEntry = sessionEntry({
        sessionId: 'session-2',
        provider: 'claude',
        controllerProfile: { owner: 'team-b' },
        backendNamespace: 'ns-b',
      });
      const readyEntry = sessionEntry({
        ...openedEntry,
        state: 'ready',
        conversationRef: 'thread-2',
        version: 2,
      });

      const appended = commitInputs(
        db,
        [
          {
            type: 'session.opened',
            stream: { kind: 'session', id: 'session-2' },
            refs: { sessionId: 'session-2' },
            bodyVersion: 1,
            body: {
              entry: openedEntry,
              controller: 'team-b',
              provider: 'claude',
              scope_key: scopeKey,
            },
          },
          {
            type: 'session.continuity.checkpointed',
            stream: { kind: 'session', id: 'session-2' },
            refs: { sessionId: 'session-2' },
            bodyVersion: 1,
            body: {
              entry: readyEntry,
              snapshot: {
                conversationRef: 'thread-2',
                resumable: true,
                providerContinuity: null,
              },
            },
          },
        ],
        { now: () => NOW, reducers, upcasters, providers: permissiveProviderLookupPort },
      );

      const openedEvent = db
        .prepare(
          `SELECT body_version
           FROM events
          WHERE stream_kind = 'session'
            AND stream_id = ?
            AND type = 'session.opened'
          ORDER BY seq ASC
          LIMIT 1`,
        )
        .get('session-2') as { body_version: number } | undefined;

      const before = db
        .prepare(
          `SELECT session_id, controller, provider, resumable, conversation_ref, scope_key, last_seq
           FROM projection_sessions
          WHERE session_id = ?
          LIMIT 1`,
        )
        .get('session-2');

      expect(before).toEqual({
        session_id: 'session-2',
        controller: 'team-b',
        provider: 'claude',
        resumable: 1,
        conversation_ref: 'thread-2',
        scope_key: scopeKey,
        last_seq: appended.at(-1)?.seq,
      });
      expect(openedEvent?.body_version).toBe(1);

      rebuildProjections({
        db,
        cutoffSeq: appended.at(-1)?.seq ?? 0,
        reducers,
        upcasters,
      });

      const after = db
        .prepare(
          `SELECT session_id, controller, provider, resumable, conversation_ref, scope_key, last_seq
           FROM projection_sessions
          WHERE session_id = ?
          LIMIT 1`,
        )
        .get('session-2');

      expect(after).toStrictEqual(before);
    } finally {
      db.close();
    }
  });
});
