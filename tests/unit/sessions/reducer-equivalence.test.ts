import { createHash } from 'node:crypto';

import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { composeReducers } from '#src/store/reducers.js';
import { rebuildProjections } from '#tests/helpers/rebuild-projections.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import type { SessionEntry } from '#src/sessions/entry.js';
import { providerArtifactIdentityKey } from '#src/providers/artifact-identity.js';
import { readProjectionSessionEntry } from '#src/sessions/projections.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';

const NOW = new Date('2026-04-19T00:00:00.000Z');

function sessionEntry(overrides: Partial<SessionEntry> & Pick<SessionEntry, 'sessionId' | 'provider'>): SessionEntry {
  return {
    sessionId: overrides.sessionId,
    provider: overrides.provider,
    sessionAuthority: overrides.sessionAuthority ?? { kind: 'orchestration' },
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
    ...(overrides.model === undefined ? {} : { model: overrides.model }),
    ...(overrides.agentName === undefined ? {} : { agentName: overrides.agentName }),
    ...(overrides.instruction === undefined ? {} : { instruction: overrides.instruction }),
    ...(overrides.bypassPermissions === undefined ? {} : { bypassPermissions: overrides.bypassPermissions }),
    ...(overrides.systemPrompt === undefined ? {} : { systemPrompt: overrides.systemPrompt }),
    ...(overrides.controllerProfile === undefined ? {} : { controllerProfile: overrides.controllerProfile }),
  };
}

describe('sessions reducer equivalence', () => {
  it('projects session.opened retention and recorded artifact handles through entry JSON', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db);
      const reducers = composeReducers(sessionsRegistry);
      const bodyCodec = createEventBodyCodec();
      const openedEntry = sessionEntry({
        sessionId: 'session-artifact',
        provider: 'codex',
        retention: 'discard_provider_artifacts_on_terminal',
      });
      const artifactEntry = sessionEntry({
        ...openedEntry,
        version: 2,
        artifactHandles: [
          {
            provider: 'codex',
            handle: '/tmp/codex/rollout.jsonl',
            identity: { kind: 'codex-rollout', threadId: 'thread-artifact' },
            identityKey: providerArtifactIdentityKey('codex', {
              kind: 'codex-rollout',
              threadId: 'thread-artifact',
            }),
            sourceJobId: 'job-artifact',
            recordedAt: NOW.toISOString(),
          },
        ],
      });

      commitInputs(
        db,
        [
          {
            type: 'session.opened',
            stream: { kind: 'session', id: 'session-artifact' },
            refs: { sessionId: 'session-artifact' },
            bodyVersion: 1,
            body: {
              entry: openedEntry,
              controller: 'default',
              provider: 'codex',
              scope_key: 'scope-artifact',
            },
          },
          {
            type: 'session.artifact.handle.recorded',
            stream: { kind: 'session', id: 'session-artifact' },
            refs: { sessionId: 'session-artifact', jobId: 'job-artifact' },
            bodyVersion: 1,
            body: {
              entry: artifactEntry,
              provider: 'codex',
              handle: '/tmp/codex/rollout.jsonl',
              sourceJobId: 'job-artifact',
            },
          },
        ],
        { now: () => NOW, reducers, bodyCodec, providers: permissiveProviderLookupPort },
      );

      const row = db
        .prepare(
          `SELECT entry
             FROM projection_sessions
            WHERE session_id = ?
            LIMIT 1`,
        )
        .get('session-artifact') as { entry: string } | undefined;
      if (!row) {
        throw new Error('Expected session projection row');
      }
      const projected = JSON.parse(row.entry) as SessionEntry;

      expect(projected).toMatchObject({
        sessionId: 'session-artifact',
        retention: 'discard_provider_artifacts_on_terminal',
        artifactHandles: [
          {
            provider: 'codex',
            handle: '/tmp/codex/rollout.jsonl',
            sourceJobId: 'job-artifact',
            recordedAt: NOW.toISOString(),
          },
        ],
        version: 2,
      });
    } finally {
      db.close();
    }
  });

  it('projects retention discard outbox events through entry JSON and rebuilds the same state', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db);
      const reducers = composeReducers(sessionsRegistry);
      const bodyCodec = createEventBodyCodec();
      const openedEntry = sessionEntry({
        sessionId: 'session-retention-discard',
        provider: 'codex',
        retention: 'discard_provider_artifacts_on_terminal',
      });
      const handles = ['/tmp/codex/rollout-retention.jsonl'];

      const appended = commitInputs(
        db,
        [
          {
            type: 'session.opened',
            stream: { kind: 'session', id: openedEntry.sessionId },
            refs: { sessionId: openedEntry.sessionId },
            bodyVersion: 1,
            body: {
              entry: openedEntry,
              controller: 'default',
              provider: 'codex',
              scope_key: 'scope-retention-discard',
            },
          },
          {
            type: 'session.retention.discard.requested',
            stream: { kind: 'session', id: openedEntry.sessionId },
            refs: { sessionId: openedEntry.sessionId },
            bodyVersion: 1,
            body: {
              sessionId: openedEntry.sessionId,
              attempt: 1,
              handles,
            },
          },
          {
            type: 'session.retention.discard.completed',
            stream: { kind: 'session', id: openedEntry.sessionId },
            refs: { sessionId: openedEntry.sessionId },
            bodyVersion: 1,
            body: {
              sessionId: openedEntry.sessionId,
              attempt: 1,
              handles,
              outcome: 'discarded',
            },
          },
        ],
        { now: () => NOW, reducers, bodyCodec, providers: permissiveProviderLookupPort },
      );

      const before = readProjectionSessionEntry(db, openedEntry.sessionId);
      expect(before?.retentionDiscard).toEqual({
        attempts: [
          {
            attempt: 1,
            handles,
            status: 'completed',
            outcome: 'discarded',
          },
        ],
      });

      rebuildProjections({
        db,
        cutoffSeq: appended.at(-1)?.seq ?? 0,
        reducers,
        bodyCodec,
      });

      expect(readProjectionSessionEntry(db, openedEntry.sessionId)?.retentionDiscard).toEqual(before?.retentionDiscard);
    } finally {
      db.close();
    }
  });

  it('parses pre-feature projection_sessions.entry JSON with retention defaults', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db);
      const retiredEntry = {
        sessionId: 'session-retired-row',
        provider: 'codex',
        sessionAuthority: { kind: 'orchestration' as const },
        name: 'retired',
        state: 'pending',
        cwd: '/tmp/project',
        projectRoot: '/tmp/project',
        backendNamespace: 'ns-a',
        providerContinuity: null,
        createdAt: NOW.toISOString(),
        lastUsedAt: NOW.toISOString(),
        version: 1,
      };

      db.prepare(
        `INSERT INTO projection_sessions (
           session_id, controller, provider, resumable, conversation_ref, scope_key, entry, last_seq
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('session-retired-row', 'default', 'codex', 0, null, 'retired-scope', JSON.stringify(retiredEntry), 1);

      expect(readProjectionSessionEntry(db, 'session-retired-row')).toMatchObject({
        sessionId: 'session-retired-row',
        retention: 'retain',
        artifactHandles: [],
        retentionDiscard: { attempts: [] },
      });
    } finally {
      db.close();
    }
  });

  it('parses reducer-written projection_sessions.entry JSON with retention discard state', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db);
      const projectedEntry = {
        sessionId: 'session-reducer-written-row',
        provider: 'codex',
        sessionAuthority: { kind: 'orchestration' as const },
        name: 'reducer written',
        state: 'pending',
        retention: 'discard_provider_artifacts_on_terminal',
        artifactHandles: [],
        retentionDiscard: {
          attempts: [
            {
              attempt: 1,
              handles: ['/tmp/reducer-written.jsonl'],
              status: 'completed',
              outcome: 'discarded',
            },
          ],
        },
        cwd: '/tmp/project',
        projectRoot: '/tmp/project',
        backendNamespace: 'ns-a',
        providerContinuity: null,
        createdAt: NOW.toISOString(),
        lastUsedAt: NOW.toISOString(),
        version: 1,
      };

      db.prepare(
        `INSERT INTO projection_sessions (
           session_id, controller, provider, resumable, conversation_ref, scope_key, entry, last_seq
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'session-reducer-written-row',
        'default',
        'codex',
        0,
        null,
        'reducer-written-scope',
        JSON.stringify(projectedEntry),
        1,
      );

      expect(readProjectionSessionEntry(db, 'session-reducer-written-row')?.retentionDiscard).toEqual(
        projectedEntry.retentionDiscard,
      );
    } finally {
      db.close();
    }
  });

  it('replays pre-feature session.opened events with retention defaults', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db);
      const reducers = composeReducers(sessionsRegistry);
      const bodyCodec = createEventBodyCodec();
      const retiredEntry = {
        sessionId: 'session-retired-opened',
        provider: 'claude',
        sessionAuthority: { kind: 'orchestration' as const },
        name: 'retired opened',
        state: 'pending',
        cwd: '/tmp/project',
        projectRoot: '/tmp/project',
        backendNamespace: 'ns-a',
        providerContinuity: null,
        createdAt: NOW.toISOString(),
        lastUsedAt: NOW.toISOString(),
        version: 1,
      };

      const appended = commitInputs(
        db,
        [
          {
            type: 'session.opened',
            stream: { kind: 'session', id: 'session-retired-opened' },
            refs: { sessionId: 'session-retired-opened' },
            bodyVersion: 1,
            body: {
              entry: retiredEntry,
              controller: 'default',
              provider: 'claude',
              scope_key: 'retired-scope',
            },
          },
        ],
        { now: () => NOW, reducers, bodyCodec, providers: permissiveProviderLookupPort },
      );

      rebuildProjections({
        db,
        cutoffSeq: appended.at(-1)?.seq ?? 0,
        reducers,
        bodyCodec,
      });

      expect(readProjectionSessionEntry(db, 'session-retired-opened')).toMatchObject({
        sessionId: 'session-retired-opened',
        retention: 'retain',
        artifactHandles: [],
        retentionDiscard: { attempts: [] },
      });
    } finally {
      db.close();
    }
  });

  it('rebuilds projection_sessions rows byte-identically from a historical event sequence', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db);
      const reducers = composeReducers(sessionsRegistry);
      const bodyCodec = createEventBodyCodec();
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
        { now: () => NOW, reducers, bodyCodec, providers: permissiveProviderLookupPort },
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
        bodyCodec,
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
      applyBundledStoreSchema(db);
      const reducers = composeReducers(sessionsRegistry);
      const bodyCodec = createEventBodyCodec();
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
        { now: () => NOW, reducers, bodyCodec, providers: permissiveProviderLookupPort },
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
        bodyCodec,
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
