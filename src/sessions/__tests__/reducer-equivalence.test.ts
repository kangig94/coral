import * as fs from 'node:fs';
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
        shard_dir: join(sessionBase(), 'legacy'),
        last_seq: appended.at(-1)?.seq,
      });

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
});
