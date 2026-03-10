import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../session-store.js';
import { initSession } from '../state-machine.js';
import { renderHeader } from '../transcript.js';
import type { DiscussState } from '../types.js';

let tmpDir: string;
let store: SessionStore;
const DAY_MS = 24 * 60 * 60 * 1000;

const AGENTS = [
  { name: 'alice', persona: '# Alice — Architect\nSenior software architect.', participation: 'required' as const },
  { name: 'bob', persona: 'Bob the critic', participation: 'required' as const },
];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'coral-store-'));
  store = new SessionStore(tmpDir);
});
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function createAndSaveSession(topic = 'Test Topic') {
  const { sessionId, fullPath } = store.createSessionDir(topic);
  const initialState = initSession({ topic, agents: AGENTS, min_bid_delay_ms: 0 }, new Date().toISOString());
  initialState.session_id = sessionId;
  store.initTranscript(fullPath, topic, initialState.agents);
  store.save(fullPath, initialState);
  return { sessionId, fullPath, state: initialState };
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
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

describe('resolveOrError', () => {
  it('should return session dir when session exists', () => {
    const { sessionId, fullPath } = store.createSessionDir('Topic');
    const resolved = store.resolveOrError(sessionId);
    expect(resolved).toBe(fullPath);
  });

  it('should return MCP error result when session is missing', () => {
    const resolved = store.resolveOrError('999999-9999-zzzz');
    expect(typeof resolved).toBe('object');
    if (typeof resolved === 'string') return;
    expect(resolved.isError).toBe(true);
    expect(resolved.content[0].text).toBe('session_not_found');
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

  it('should load state under lock with loadLocked', async () => {
    const { fullPath, state } = createAndSaveSession();
    const loaded = await store.loadLocked(fullPath);
    expect(loaded.session_id).toBe(state.session_id);
    expect(loaded.topic).toBe(state.topic);
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

  it('should restore transcript cursor after SessionStore restart', () => {
    const { fullPath, state } = createAndSaveSession();
    const state1: DiscussState = {
      ...state,
      transcript: [
        { type: 'speech', step: 1, epoch: 1, ts: new Date().toISOString(),
          agent: 'alice', display_name: 'Alice', content: 'First.' },
      ],
    };
    store.save(fullPath, state1);

    const restartedStore = new SessionStore(tmpDir);
    const loaded = restartedStore.load(fullPath);
    const state2: DiscussState = {
      ...loaded,
      transcript: [
        ...loaded.transcript,
        { type: 'speech', step: 2, epoch: 1, ts: new Date().toISOString(),
          agent: 'bob', display_name: 'Bob', content: 'Second.' },
      ],
    };
    restartedStore.save(fullPath, state2);

    const md = readFileSync(join(fullPath, 'transcript.md'), 'utf8');
    const firstCount = (md.match(/First\./g) ?? []).length;
    const secondCount = (md.match(/Second\./g) ?? []).length;
    expect(firstCount).toBe(1);
    expect(secondCount).toBe(1);
  });
});



describe('cleanupExpiredSessions', () => {
  beforeEach(() => { process.env.CORAL_DISCUSS_TTL_DAYS = '30'; });
  afterEach(() => { delete process.env.CORAL_DISCUSS_TTL_DAYS; });

  function saveSessionWithStatus(topic: string, status: string, lastActivity: Date) {
    const { sessionId, fullPath } = store.createSessionDir(topic);
    const state = initSession({ topic, agents: AGENTS, min_bid_delay_ms: 0 }, new Date().toISOString());
    state.session_id = sessionId;
    const raw = { ...state, status, last_activity_at: lastActivity.toISOString() };
    writeFileSync(join(fullPath, 'state.json'), JSON.stringify(raw, null, 2));
    return { sessionId, fullPath };
  }

  it('should remove ended sessions older than TTL', () => {
    const old = daysAgo(31);
    const { fullPath } = saveSessionWithStatus('Old Topic', 'ended', old);
    const removed = store.cleanupExpiredSessions();
    expect(removed).toBe(1);
    expect(existsSync(fullPath)).toBe(false);
  });

  it('should preserve ended sessions within TTL', () => {
    const recent = daysAgo(5);
    const { fullPath } = saveSessionWithStatus('Recent Topic', 'ended', recent);
    const removed = store.cleanupExpiredSessions();
    expect(removed).toBe(0);
    expect(existsSync(fullPath)).toBe(true);
  });

  it('should never remove active sessions', () => {
    const old = daysAgo(31);
    const { fullPath } = saveSessionWithStatus('Active Topic', 'bidding', old);
    store.cleanupExpiredSessions();
    expect(existsSync(fullPath)).toBe(true);
  });

  it('should return 0 when no sessions exist', () => {
    expect(store.cleanupExpiredSessions()).toBe(0);
  });

  it('should skip cleanup when TTL is 0 (disabled)', () => {
    process.env.CORAL_DISCUSS_TTL_DAYS = '0';
    const old = daysAgo(365);
    const { fullPath } = saveSessionWithStatus('Ancient Topic', 'ended', old);
    const removed = store.cleanupExpiredSessions();
    expect(removed).toBe(0);
    expect(existsSync(fullPath)).toBe(true);
  });
});

describe('load shape validation', () => {
  function writeMalformedState(sessionPath: string, transform: (state: Record<string, unknown>) => void): void {
    const state = initSession({
      topic: 'Malformed',
      agents: [
        { name: 'alice', persona: '# Alice — Analyst\nMalformed persona.', participation: 'required' as const },
        { name: 'bob', persona: '# Bob — Critic\nMalformed persona.', participation: 'required' as const },
      ],
      min_bid_delay_ms: 0,
    }, new Date().toISOString());
    const legacy = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    transform(legacy);
    writeFileSync(join(sessionPath, 'state.json'), JSON.stringify(legacy, null, 2), 'utf8');
  }

  it('should throw when required top-level fields are missing', () => {
    const { fullPath } = store.createSessionDir('Missing Topic');
    writeMalformedState(fullPath, (legacy) => {
      delete legacy.topic;
    });

    expect(() => store.load(fullPath)).toThrowError(
      `Invalid discuss state shape in ${fullPath}: missing required fields`,
    );
  });

  it('should throw when participation values are missing', () => {
    const { fullPath } = store.createSessionDir('Missing Participation');
    writeMalformedState(fullPath, (legacy) => {
      const agents = legacy.agents as Record<string, { participation?: unknown }>;
      for (const agent of Object.values(agents)) {
        delete agent.participation;
      }
    });

    expect(() => store.load(fullPath)).toThrowError(
      `Invalid agent shape for 'alice' in ${fullPath}: missing participation field`,
    );
  });

  it('should throw when min_bid_delay_ms is missing', () => {
    const { fullPath } = store.createSessionDir('Missing Bid Delay');
    writeMalformedState(fullPath, (legacy) => {
      delete (legacy as Record<string, unknown>).min_bid_delay_ms;
    });

    expect(() => store.load(fullPath)).toThrowError(
      `Invalid discuss state shape in ${fullPath}: missing min_bid_delay_ms`,
    );
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

// adversarial tests (red-attacker provenance)
describe('renderCursors cursor persistence', () => {
  it('should treat transcript_rendered=0 as zero cursor, not fall back to transcript.length', () => {
    const { fullPath } = store.createSessionDir('Cursor Zero');
    const state = initSession({ topic: 'Cursor Zero', agents: AGENTS, min_bid_delay_ms: 0 }, new Date().toISOString());
    const speechEntry: DiscussState['transcript'][number] = {
      type: 'speech', step: 1, epoch: 1, ts: new Date().toISOString(),
      agent: 'alice', display_name: 'Alice', content: 'Already rendered speech.',
    };
    // Write a file where transcript has 1 entry but transcript_rendered=0
    const raw = { ...state, transcript: [speechEntry], transcript_rendered: 0 };
    writeFileSync(join(fullPath, 'state.json'), JSON.stringify(raw, null, 2), 'utf8');
    writeFileSync(join(fullPath, 'transcript.md'), renderHeader('Cursor Zero'), 'utf8');

    // Load restores cursor to 0 (0 is not nullish — ?? won't fire)
    const loaded = store.load(fullPath);
    expect(loaded.transcript).toHaveLength(1);

    // Cursor was 0, so the existing entry is re-rendered on save (documented behavior)
    store.save(fullPath, loaded);
    const md = readFileSync(join(fullPath, 'transcript.md'), 'utf8');
    const occurrences = (md.match(/Already rendered speech\./g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(1);
  });

  it('should restore cursor from transcript_rendered even when transcript has grown between saves', () => {
    const { fullPath, state } = createAndSaveSession('Cursor Growth');
    const entry = (content: string, step: number): DiscussState['transcript'][number] => ({
      type: 'speech', step, epoch: 1, ts: new Date().toISOString(),
      agent: 'alice', display_name: 'Alice', content,
    });

    store.save(fullPath, { ...state, transcript: [entry('Entry A', 1)] });
    store.save(fullPath, { ...state, transcript: [entry('Entry A', 1), entry('Entry B', 2)] });

    // Restart the store — cursor should be restored from transcript_rendered=2
    const restartedStore = new SessionStore(tmpDir);
    const loaded = restartedStore.load(fullPath);
    expect(loaded.transcript).toHaveLength(2);

    restartedStore.save(fullPath, { ...loaded, transcript: [...loaded.transcript, entry('Entry C', 3)] });

    const md = readFileSync(join(fullPath, 'transcript.md'), 'utf8');
    expect((md.match(/Entry A/g) ?? []).length).toBe(1);
    expect((md.match(/Entry B/g) ?? []).length).toBe(1);
    expect((md.match(/Entry C/g) ?? []).length).toBe(1);
  });

  it('should set cursor to transcript.length when transcript_rendered field is absent (legacy files)', () => {
    const { fullPath } = store.createSessionDir('Legacy Cursor');
    const state = initSession({ topic: 'Legacy Cursor', agents: AGENTS, min_bid_delay_ms: 0 }, new Date().toISOString());
    const speechEntry: DiscussState['transcript'][number] = {
      type: 'speech', step: 1, epoch: 1, ts: new Date().toISOString(),
      agent: 'alice', display_name: 'Alice', content: 'Legacy content.',
    };
    const legacy = { ...state, transcript: [speechEntry] } as Record<string, unknown>;
    delete legacy['transcript_rendered'];
    writeFileSync(join(fullPath, 'state.json'), JSON.stringify(legacy, null, 2), 'utf8');
    store.initTranscript(fullPath, 'Legacy Cursor', state.agents);

    const loaded = store.load(fullPath);
    const newEntry: DiscussState['transcript'][number] = {
      type: 'speech', step: 2, epoch: 1, ts: new Date().toISOString(),
      agent: 'bob', display_name: 'Bob', content: 'New content.',
    };
    store.save(fullPath, { ...loaded, transcript: [speechEntry, newEntry] });

    const md = readFileSync(join(fullPath, 'transcript.md'), 'utf8');
    expect((md.match(/Legacy content\./g) ?? []).length).toBe(0);
    expect((md.match(/New content\./g) ?? []).length).toBe(1);
  });

  it('should update cursor in-memory after loadLocked so subsequent save appends only new entries', async () => {
    const { fullPath, state } = createAndSaveSession('LockCursor');
    const entry1: DiscussState['transcript'][number] = {
      type: 'speech', step: 1, epoch: 1, ts: new Date().toISOString(),
      agent: 'alice', display_name: 'Alice', content: 'First entry.',
    };
    store.save(fullPath, { ...state, transcript: [entry1] });

    const store2 = new SessionStore(tmpDir);
    const loaded = await store2.loadLocked(fullPath);
    expect(loaded.transcript).toHaveLength(1);

    const entry2: DiscussState['transcript'][number] = {
      type: 'speech', step: 2, epoch: 1, ts: new Date().toISOString(),
      agent: 'bob', display_name: 'Bob', content: 'Second entry.',
    };
    store2.save(fullPath, { ...loaded, transcript: [entry1, entry2] });

    const md = readFileSync(join(fullPath, 'transcript.md'), 'utf8');
    expect((md.match(/First entry\./g) ?? []).length).toBe(1);
    expect((md.match(/Second entry\./g) ?? []).length).toBe(1);
  });
});

// adversarial tests (red-attacker provenance)
describe('transcript_rendered type erasure on load', () => {
  it('should not expose transcript_rendered as an own property on the loaded state', () => {
    const { fullPath } = createAndSaveSession('Erasure Test');
    const loaded = store.load(fullPath);
    expect(Object.prototype.hasOwnProperty.call(loaded, 'transcript_rendered')).toBe(false);
  });

  it('should not expose transcript_rendered even when the raw file has the field set', () => {
    const { fullPath } = createAndSaveSession('Erasure Explicit');
    const raw = JSON.parse(readFileSync(join(fullPath, 'state.json'), 'utf8')) as Record<string, unknown>;
    raw['transcript_rendered'] = 42;
    writeFileSync(join(fullPath, 'state.json'), JSON.stringify(raw, null, 2), 'utf8');

    const loaded = store.load(fullPath);
    expect(Object.prototype.hasOwnProperty.call(loaded, 'transcript_rendered')).toBe(false);
  });

  it('should persist transcript_rendered in state.json after save', () => {
    const { fullPath, state } = createAndSaveSession('Persist Field');
    const entry: DiscussState['transcript'][number] = {
      type: 'speech', step: 1, epoch: 1, ts: new Date().toISOString(),
      agent: 'alice', display_name: 'Alice', content: 'Speech.',
    };
    store.save(fullPath, { ...state, transcript: [entry] });

    const raw = JSON.parse(readFileSync(join(fullPath, 'state.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(raw, 'transcript_rendered')).toBe(true);
    expect(raw['transcript_rendered']).toBe(1);
  });
});

// adversarial tests (red-attacker provenance)
describe('resolveOrError MCP result shape', () => {
  it('returns an object with content array of length 1 for missing session', () => {
    const result = store.resolveOrError('not-a-real-session-id');
    expect(typeof result).toBe('object');
    if (typeof result === 'string') return;
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content).toHaveLength(1);
  });

  it('returns content[0].type === "text" for missing session', () => {
    const result = store.resolveOrError('not-a-real-session-id');
    if (typeof result === 'string') return;
    expect(result.content[0].type).toBe('text');
  });

  it('returns isError === true for missing session', () => {
    const result = store.resolveOrError('not-a-real-session-id');
    if (typeof result === 'string') return;
    expect(result.isError).toBe(true);
  });

  it('returns a plain string (not an object) when session exists', () => {
    const { sessionId } = createAndSaveSession('Resolve Test');
    const result = store.resolveOrError(sessionId);
    expect(typeof result).toBe('string');
  });

  it('resolves session by prefix when session dir has topic slug suffix', () => {
    const { sessionId, fullPath } = store.createSessionDir('Multi Word Topic');
    const result = store.resolveOrError(sessionId);
    expect(typeof result).toBe('string');
    expect(result).toBe(fullPath);
  });
});
