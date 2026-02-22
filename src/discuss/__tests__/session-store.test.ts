
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../session-store.js';
import { initSession } from '../state-machine.js';
import type { DiscussState } from '../types.js';

let tmpDir: string;
let store: SessionStore;

const AGENTS = [
  { name: 'alice', persona: '# Alice — Architect\nSenior software architect.' },
  { name: 'bob', persona: 'Bob the critic' },
];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'coral-store-'));
  store = new SessionStore(tmpDir);
});
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function createAndSaveSession(topic = 'Test Topic') {
  const { sessionId, fullPath } = store.createSessionDir(topic);
  const state = initSession({ topic, agents: AGENTS }, new Date().toISOString());
  state.session_id = sessionId;
  state.session_dir = fullPath;
  state.team_name = `coral-dc-${sessionId}`;
  store.initTranscript(fullPath, topic);
  store.save(fullPath, state);
  return { sessionId, fullPath, state };
}


describe('createSessionDir', () => {
  it('should create directory with session ID format', () => {
    const { sessionId, fullPath } = store.createSessionDir('My Topic');
    expect(sessionId).toMatch(/^\d{6}-\d{4}-[a-z0-9]{4}$/);
    expect(existsSync(fullPath)).toBe(true);
  });

  it('should include topic slug in directory name', () => {
    const { fullPath } = store.createSessionDir('Microservices vs Monolith');
    expect(fullPath).toContain('microservices');
  });
});


describe('resolveDir', () => {
  it('should find session dir by session_id prefix', () => {
    const { sessionId, fullPath } = store.createSessionDir('Topic');
    const resolved = store.resolveDir(sessionId);
    expect(resolved).toBe(fullPath);
  });

  it('should return null for unknown session', () => {
    const resolved = store.resolveDir('999999-9999-zzzz');
    expect(resolved).toBeNull();
  });
});


describe('save and load', () => {
  it('should round-trip state through save/load', () => {
    const { fullPath, state } = createAndSaveSession();
    const loaded = store.load(fullPath);
    expect(loaded.session_id).toBe(state.session_id);
    expect(loaded.topic).toBe('Test Topic');
    expect(loaded.agents['alice'].display_name).toBe('Alice');
  });

  it('should write atomic: .tmp file not visible after save', () => {
    const { fullPath } = createAndSaveSession();
    expect(existsSync(join(fullPath, 'state.json.tmp'))).toBe(false);
    expect(existsSync(join(fullPath, 'state.json'))).toBe(true);
  });

  it('should append new transcript entries to transcript.md on save', () => {
    const { fullPath, state } = createAndSaveSession();

    const updated: DiscussState = {
      ...state,
      transcript: [
        ...state.transcript,
        { type: 'speech', step: 1, epoch: 1, ts: new Date().toISOString(),
          agent: 'alice', display_name: 'Alice', content: 'Hello world.' },
      ],
    };
    store.save(fullPath, updated);

    const md = readFileSync(join(fullPath, 'transcript.md'), 'utf8');
    expect(md).toContain('Hello world.');
  });

  it('should only append NEW entries (transcript_rendered cursor)', () => {
    const { fullPath, state } = createAndSaveSession();

    const state1: DiscussState = {
      ...state,
      transcript: [
        { type: 'speech', step: 1, epoch: 1, ts: new Date().toISOString(),
          agent: 'alice', display_name: 'Alice', content: 'First.' },
      ],
    };
    store.save(fullPath, state1);
    const loaded1 = store.load(fullPath);
    expect(loaded1.transcript_rendered).toBe(1);

    const state2: DiscussState = {
      ...loaded1,
      transcript: [
        ...loaded1.transcript,
        { type: 'speech', step: 2, epoch: 1, ts: new Date().toISOString(),
          agent: 'bob', display_name: 'Bob', content: 'Second.' },
      ],
    };
    store.save(fullPath, state2);

    const md = readFileSync(join(fullPath, 'transcript.md'), 'utf8');
    const firstCount = (md.match(/First\./g) ?? []).length;
    const secondCount = (md.match(/Second\./g) ?? []).length;
    expect(firstCount).toBe(1); // not duplicated
    expect(secondCount).toBe(1);
  });
});



describe('cleanupExpiredSessions', () => {
  function saveSessionWithStatus(topic: string, status: string, lastActivity: Date) {
    const { sessionId, fullPath } = store.createSessionDir(topic);
    const state = initSession({ topic, agents: AGENTS }, new Date().toISOString());
    state.session_id = sessionId;
    state.session_dir = fullPath;
    state.team_name = `coral-dc-${sessionId}`;
    const raw = { ...state, status, last_activity_at: lastActivity.toISOString() };
    writeFileSync(join(fullPath, 'state.json'), JSON.stringify(raw, null, 2));
    return { sessionId, fullPath };
  }

  it('should remove ended sessions older than TTL', () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000); // 31 days ago
    const { fullPath } = saveSessionWithStatus('Old Topic', 'ended', old);
    const removed = store.cleanupExpiredSessions();
    expect(removed).toBe(1);
    expect(existsSync(fullPath)).toBe(false);
  });

  it('should preserve ended sessions within TTL', () => {
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days ago
    const { fullPath } = saveSessionWithStatus('Recent Topic', 'ended', recent);
    const removed = store.cleanupExpiredSessions();
    expect(removed).toBe(0);
    expect(existsSync(fullPath)).toBe(true);
  });

  it('should never remove active sessions', () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const { fullPath } = saveSessionWithStatus('Active Topic', 'bidding', old);
    store.cleanupExpiredSessions();
    expect(existsSync(fullPath)).toBe(true);
  });

  it('should return 0 when no sessions exist', () => {
    expect(store.cleanupExpiredSessions()).toBe(0);
  });
});

describe('withLock', () => {
  it('should serialize concurrent access', async () => {
    const { fullPath } = createAndSaveSession();
    const results: number[] = [];

    await Promise.all([
      store.withLock(fullPath, async () => { results.push(1); await new Promise((r) => setTimeout(r, 20)); results.push(2); }),
      store.withLock(fullPath, async () => { results.push(3); }),
    ]);

    const idx1 = results.indexOf(1);
    const idx2 = results.indexOf(2);
    const idx3 = results.indexOf(3);
    expect(idx2).toBeGreaterThan(idx1); // 2 always after 1
    expect(Math.abs(idx2 - idx3)).not.toBe(0); // 2 and 3 not adjacent mid-lock
  });
});
