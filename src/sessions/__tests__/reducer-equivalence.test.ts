import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { appendEvents } from '../../store/append.js';
import { createDefaultUpcasterRegistry } from '../../store/upcasters.js';
import { applyMigrations } from '../../store/migrations.js';
import { composeReducers } from '../../store/reducers.js';
import { rebuildProjections } from '../../store/rebuild.js';
import { sessionBase } from '../../infra/paths.js';
import { sessionsRegistry } from '../events.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../store/migrations');
const storageAdapter = {
  readdirSync: (path: string, opts: { withFileTypes: true }) => fs.readdirSync(path, opts),
  readFileSync: (path: string, enc: 'utf-8') => fs.readFileSync(path, enc),
};
const NOW = new Date('2026-04-19T00:00:00.000Z');

describe('sessions reducer equivalence (AC2)', () => {
  it('rebuilds projection_sessions rows byte-identically from a historical event sequence', () => {
    const db = new Database(':memory:');
    try {
      applyMigrations({ db, storage: storageAdapter as never, migrationsDir: MIGRATIONS_DIR });
      const reducers = composeReducers(sessionsRegistry);
      const upcasters = createDefaultUpcasterRegistry();

      const appended = appendEvents(
        db,
        [
          {
            type: 'session.opened',
            stream: { kind: 'session', id: 'session-1' },
            refs: { sessionId: 'session-1' },
            bodyVersion: 1,
            body: {
              controller: 'team-a',
              provider: 'codex',
            },
          },
          {
            type: 'session.continuity.checkpointed',
            stream: { kind: 'session', id: 'session-1' },
            refs: { sessionId: 'session-1' },
            bodyVersion: 1,
            body: {
              conversationRef: 'thread-1',
              resumable: true,
              providerContinuity: { threadId: 'thread-1', turnId: 'turn-1' },
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
              conversationRef: null,
              resumable: false,
              providerContinuity: { threadId: 'thread-1' },
            },
          },
          {
            type: 'session.closed',
            stream: { kind: 'session', id: 'session-1' },
            refs: { sessionId: 'session-1' },
            bodyVersion: 1,
            body: {
              reason: 'non_resumable',
            },
          },
        ],
        { now: () => NOW, reducers, upcasters },
      );

      const v1OpenEvent = db.prepare(
        `SELECT body_version
           FROM events
          WHERE stream_kind = 'session'
            AND stream_id = ?
            AND type = 'session.opened'
          ORDER BY seq ASC
          LIMIT 1`,
      ).get('session-1') as { body_version: number } | undefined;

      const before = db.prepare(
        `SELECT session_id, controller, provider, resumable, conversation_ref, shard_dir, last_seq
           FROM projection_sessions
          WHERE session_id = ?
          LIMIT 1`,
      ).get('session-1');

      expect(before).toEqual({
        session_id: 'session-1',
        controller: 'team-a',
        provider: 'codex',
        resumable: 0,
        conversation_ref: null,
        shard_dir: join(sessionBase(), createHash('sha1').update('session-1').digest('hex').slice(0, 12)),
        last_seq: appended.at(-1)?.seq,
      });
      expect(v1OpenEvent?.body_version).toBe(1);

      rebuildProjections({
        db,
        cutoffSeq: appended.at(-1)?.seq ?? 0,
        reducers,
        upcasters,
      });

      const after = db.prepare(
        `SELECT session_id, controller, provider, resumable, conversation_ref, shard_dir, last_seq
           FROM projection_sessions
          WHERE session_id = ?
          LIMIT 1`,
      ).get('session-1');

      expect(after).toStrictEqual(before);
    } finally {
      db.close();
    }
  });

  it('round-trips v2 session.opened rows without rewriting shard_dir or body_version', () => {
    const db = new Database(':memory:');
    try {
      applyMigrations({ db, storage: storageAdapter as never, migrationsDir: MIGRATIONS_DIR });
      const reducers = composeReducers(sessionsRegistry);
      const upcasters = createDefaultUpcasterRegistry();
      const shardDir = join(sessionBase(), 'v2-shard');

      const appended = appendEvents(
        db,
        [
          {
            type: 'session.opened',
            stream: { kind: 'session', id: 'session-2' },
            refs: { sessionId: 'session-2' },
            bodyVersion: 2,
            body: {
              controller: 'team-b',
              provider: 'claude',
              shard_dir: shardDir,
            },
          },
          {
            type: 'session.continuity.checkpointed',
            stream: { kind: 'session', id: 'session-2' },
            refs: { sessionId: 'session-2' },
            bodyVersion: 1,
            body: {
              conversationRef: 'thread-2',
              resumable: true,
              providerContinuity: null,
            },
          },
        ],
        { now: () => NOW, reducers, upcasters },
      );

      const v2OpenEvent = db.prepare(
        `SELECT body_version
           FROM events
          WHERE stream_kind = 'session'
            AND stream_id = ?
            AND type = 'session.opened'
          ORDER BY seq ASC
          LIMIT 1`,
      ).get('session-2') as { body_version: number } | undefined;

      const before = db.prepare(
        `SELECT session_id, controller, provider, resumable, conversation_ref, shard_dir, last_seq
           FROM projection_sessions
          WHERE session_id = ?
          LIMIT 1`,
      ).get('session-2');

      expect(before).toEqual({
        session_id: 'session-2',
        controller: 'team-b',
        provider: 'claude',
        resumable: 1,
        conversation_ref: 'thread-2',
        shard_dir: shardDir,
        last_seq: appended.at(-1)?.seq,
      });
      expect(v2OpenEvent?.body_version).toBe(2);

      rebuildProjections({
        db,
        cutoffSeq: appended.at(-1)?.seq ?? 0,
        reducers,
        upcasters,
      });

      const after = db.prepare(
        `SELECT session_id, controller, provider, resumable, conversation_ref, shard_dir, last_seq
           FROM projection_sessions
          WHERE session_id = ?
          LIMIT 1`,
      ).get('session-2');

      expect(after).toStrictEqual(before);
    } finally {
      db.close();
    }
  });
});
