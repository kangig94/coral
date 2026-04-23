import * as fs from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { appendEvents } from '#src/store/append.js';
import { decodeEventBody } from '#src/store/body-codec.js';
import { applyMigrations } from '#src/store/migrations.js';
import { composeReducers } from '#src/store/reducers.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcasters.js';
import { sessionsRegistry } from '#src/sessions/events.js';

const MIGRATIONS_DIR = join(process.cwd(), 'src/store/migrations');
const storageAdapter = {
  readdirSync: (path: string, opts: { withFileTypes: true }) => fs.readdirSync(path, opts),
  readFileSync: (path: string, enc: 'utf-8') => fs.readFileSync(path, enc),
};
const NOW = new Date('2026-04-22T00:00:00.000Z');

function readStoredEvent(
  db: InstanceType<typeof Database>,
  sessionId: string,
  type: string,
  seq: number,
): { body_version: number; body: Uint8Array | Buffer } | undefined {
  return db
    .prepare(
      `SELECT body_version, body
       FROM events
      WHERE stream_kind = 'session'
        AND stream_id = ?
        AND type = ?
        AND seq = ?
      LIMIT 1`,
    )
    .get(sessionId, type, seq) as { body_version: number; body: Uint8Array | Buffer } | undefined;
}

describe('sessions legacy compat upcasters (AC3.2, AC3.6)', () => {
  it('upcasts legacy session fault bodies into canonical session event shapes', () => {
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
            stream: { kind: 'session', id: 'session-legacy' },
            refs: { sessionId: 'session-legacy' },
            bodyVersion: 1,
            body: {
              controller: 'team-a',
              provider: 'claude',
            },
          },
          {
            type: 'session.interrupted',
            stream: { kind: 'session', id: 'session-legacy' },
            refs: { sessionId: 'session-legacy' },
            bodyVersion: 1,
            body: {
              kind: 'app_server_interrupted',
              trigger: 'handoff',
              continuity: 'pre_checkpoint_preserved',
            },
          },
          {
            type: 'session.adapter_unparseable',
            stream: { kind: 'session', id: 'session-legacy' },
            refs: { sessionId: 'session-legacy' },
            bodyVersion: 1,
            body: {
              kind: 'adapter_output_unparseable',
              provider: 'claude',
              exitCode: 19,
              stdout: 'partial stdout',
              stderr: 'partial stderr',
              parseError: 'bad json',
            },
          },
          {
            type: 'session.provider_failed',
            stream: { kind: 'session', id: 'session-legacy' },
            refs: { sessionId: 'session-legacy' },
            bodyVersion: 1,
            body: {
              kind: 'provider_session_unavailable',
              provider: 'claude',
              note: 'thread missing',
            },
          },
          {
            type: 'session.provider_failed',
            stream: { kind: 'session', id: 'session-legacy' },
            refs: { sessionId: 'session-legacy' },
            bodyVersion: 1,
            body: {
              kind: 'provider_request_failed',
              provider: 'codex',
              message: 'transport reset',
            },
          },
        ],
        { now: () => NOW, reducers, upcasters },
      );

      expect(appended[1]?.body).toEqual({
        trigger: 'handoff',
        continuity: 'pre_checkpoint_preserved',
      });
      expect(appended[2]?.body).toEqual({
        provider: 'claude',
        exitCode: 19,
        stdout: 'partial stdout',
        stderr: 'partial stderr',
        parseError: 'bad json',
      });
      expect(appended[3]?.body).toEqual({
        provider: 'claude',
        reason: 'session_unavailable',
        message: 'thread missing',
      });
      expect(appended[4]?.body).toEqual({
        provider: 'codex',
        reason: 'request_failed',
        message: 'transport reset',
      });

      expect(readStoredEvent(db, 'session-legacy', 'session.interrupted', appended[1].seq)).toMatchObject({
        body_version: 1,
      });
      expect(
        decodeEventBody(readStoredEvent(db, 'session-legacy', 'session.interrupted', appended[1].seq)!.body),
      ).toEqual({
        kind: 'app_server_interrupted',
        trigger: 'handoff',
        continuity: 'pre_checkpoint_preserved',
      });
      expect(
        decodeEventBody(readStoredEvent(db, 'session-legacy', 'session.adapter_unparseable', appended[2].seq)!.body),
      ).toEqual({
        kind: 'adapter_output_unparseable',
        provider: 'claude',
        exitCode: 19,
        stdout: 'partial stdout',
        stderr: 'partial stderr',
        parseError: 'bad json',
      });
      expect(
        decodeEventBody(readStoredEvent(db, 'session-legacy', 'session.provider_failed', appended[3].seq)!.body),
      ).toEqual({
        kind: 'provider_session_unavailable',
        provider: 'claude',
        note: 'thread missing',
      });
      expect(
        decodeEventBody(readStoredEvent(db, 'session-legacy', 'session.provider_failed', appended[4].seq)!.body),
      ).toEqual({
        kind: 'provider_request_failed',
        provider: 'codex',
        message: 'transport reset',
      });

      const projection = db
        .prepare(
          `SELECT session_id, provider, last_seq
           FROM projection_sessions
          WHERE session_id = ?
          LIMIT 1`,
        )
        .get('session-legacy');

      expect(projection).toEqual({
        session_id: 'session-legacy',
        provider: 'codex',
        last_seq: appended[4]?.seq,
      });
    } finally {
      db.close();
    }
  });
});
