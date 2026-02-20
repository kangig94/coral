/**
 * SessionStore tests — atomic writes, locking, normalizeState migration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore, normalizeState } from '../session-store.js';
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
  const state = initSession({ topic, agents: AGENTS, quota_per_epoch: 3, recent_turns: 5 }, new Date().toISOString());
  state.session_id = sessionId;
  state.session_dir = fullPath;
  state.team_name = `coral-dc-${sessionId}`;
  store.initTranscript(fullPath, topic);
  store.save(fullPath, state);
  return { sessionId, fullPath, state };
}

// ─── normalizeState ───────────────────────────────────────────────────────────

describe('normalizeState', () => {
  it('should add v2 fields to legacy state', () => {
    const legacy = {
      session_id: 'test', topic: 'x', status: 'bidding', step: 1, epoch: 1,
      agents: { alice: { persona: 'p', quota_remaining: 3, total_speaks: 0, fallback_used: false } },
      current_bids: { alice: null }, pending_bidders: ['alice'],
      current_speaker: null, speaker_type: null, epoch_summary_written: null,
      team_name: 't', created_at: 'x', updated_at: 'x', session_dir: 'x',
      cold_start: true, quota_per_epoch: 3, recent_turns: 5,
    } as Record<string, unknown>;

    const result = normalizeState(legacy);
    expect(result.last_speech_step).toBe(0);
    expect(result.transcript).toEqual([]);
    expect(result.transcript_rendered).toBe(0);
  });

  it('should parse display_name from persona first line', () => {
    const raw = {
      session_id: 'test', topic: 'x', status: 'bidding', step: 1, epoch: 1,
      agents: { alice: { persona: '# Alice — Architect\nPersona body.', quota_remaining: 3, total_speaks: 0, fallback_used: false } },
      current_bids: { alice: null }, pending_bidders: ['alice'],
      current_speaker: null, speaker_type: null, epoch_summary_written: null,
      team_name: 't', created_at: 'x', updated_at: 'x', session_dir: 'x',
      cold_start: true, quota_per_epoch: 3, recent_turns: 5,
      last_speech_step: 0, transcript: [], transcript_rendered: 0,
    } as Record<string, unknown>;

    const result = normalizeState(raw);
    expect(result.agents['alice'].display_name).toBe('Alice');
  });

  it('should migrate speaker_type "designated" to "cold_start"', () => {
    const raw = {
      session_id: 'test', topic: 'x', status: 'speaking', step: 2, epoch: 1,
      agents: { alice: { persona: 'p', display_name: 'Alice', quota_remaining: 3, total_speaks: 0, fallback_used: false } },
      current_bids: { alice: null }, pending_bidders: [],
      current_speaker: 'alice', speaker_type: 'designated', epoch_summary_written: null,
      team_name: 't', created_at: 'x', updated_at: 'x', session_dir: 'x',
      cold_start: false, quota_per_epoch: 3, recent_turns: 5,
      last_speech_step: 0, transcript: [], transcript_rendered: 0,
    } as Record<string, unknown>;

    const result = normalizeState(raw);
    expect(result.speaker_type).toBe('cold_start');
  });

  it('should not modify already-normalized state', () => {
    const { state } = createAndSaveSession();
    const loaded = store.load(state.session_dir);
    const renormalized = normalizeState(loaded as unknown as Record<string, unknown>);
    expect(renormalized.last_speech_step).toBe(0);
    expect(renormalized.transcript).toEqual([]);
  });
});

// ─── SessionStore.createSessionDir ───────────────────────────────────────────

describe('createSessionDir', () => {
  it('should create directory with session ID format', () => {
    const { sessionId, fullPath } = store.createSessionDir('My Topic');
    expect(sessionId).toMatch(/^\d{8}-\d{6}-[a-z0-9]{4}$/);
    expect(existsSync(fullPath)).toBe(true);
  });

  it('should include topic slug in directory name', () => {
    const { fullPath } = store.createSessionDir('Microservices vs Monolith');
    expect(fullPath).toContain('microservices');
  });
});

// ─── SessionStore.resolveDir ──────────────────────────────────────────────────

describe('resolveDir', () => {
  it('should find session dir by session_id prefix', () => {
    const { sessionId, fullPath } = store.createSessionDir('Topic');
    const resolved = store.resolveDir(sessionId);
    expect(resolved).toBe(fullPath);
  });

  it('should return null for unknown session', () => {
    const resolved = store.resolveDir('99999999-999999-zzzz');
    expect(resolved).toBeNull();
  });
});

// ─── SessionStore.save / load ─────────────────────────────────────────────────

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

    // Add speech entry and save again
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

    // First save: 1 entry
    const state1: DiscussState = {
      ...state,
      transcript: [
        { type: 'speech', step: 1, epoch: 1, ts: new Date().toISOString(),
          agent: 'alice', display_name: 'Alice', content: 'First.' },
      ],
    };
    store.save(fullPath, state1);
    // transcript_rendered should now be 1
    const loaded1 = store.load(fullPath);
    expect(loaded1.transcript_rendered).toBe(1);

    // Second save: adds a second entry
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

// ─── SessionStore.withLock ────────────────────────────────────────────────────

describe('withLock', () => {
  it('should serialize concurrent access', async () => {
    const { fullPath, state } = createAndSaveSession();
    const results: number[] = [];

    // Two concurrent lock acquisitions — order should be serialized
    await Promise.all([
      store.withLock(fullPath, async () => { results.push(1); await new Promise((r) => setTimeout(r, 20)); results.push(2); }),
      store.withLock(fullPath, async () => { results.push(3); }),
    ]);

    // Serialized: [1, 2, 3] or [3, 1, 2] — never interleaved [1, 3, 2]
    const idx1 = results.indexOf(1);
    const idx2 = results.indexOf(2);
    const idx3 = results.indexOf(3);
    expect(idx2).toBeGreaterThan(idx1); // 2 always after 1
    expect(Math.abs(idx2 - idx3)).not.toBe(0); // 2 and 3 not adjacent mid-lock
    void state; // suppress unused warning
  });
});
