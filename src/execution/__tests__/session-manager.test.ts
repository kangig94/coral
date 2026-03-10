import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

let tmpHome = '';

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

import { SessionManager } from '../session-manager.js';
import { eventBus } from '../event-bus.js';

describe('execution SessionManager', () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'coral-execution-home-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    eventBus.removeAllListeners();
    vi.restoreAllMocks();
  });

  function setup(projectName: string): { mgr: SessionManager; workDir: string } {
    const workDir = join(tmpHome, projectName);
    mkdirSync(workDir, { recursive: true });
    return { mgr: new SessionManager(workDir), workDir };
  }

  it('allocate creates an entry with state pending', () => {
    const { mgr, workDir } = setup('allocate-pending');

    const entry = mgr.allocate('codex', 'alpha', 'gpt-5', workDir);

    expect(entry.state).toBe('pending');
    expect(entry.version).toBe(1);
    expect(mgr.get('codex', entry.sessionId)).toMatchObject({
      sessionId: entry.sessionId,
      provider: 'codex',
      name: 'alpha',
      state: 'pending',
      model: 'gpt-5',
      cwd: workDir,
      version: 1,
    });
  });

  it('allocate persists projectRoot when provided', () => {
    const { mgr, workDir } = setup('alloc-with-root');

    const entry = mgr.allocate('codex', 'beta', 'gpt-5', workDir, '/my/project');

    expect(entry.projectRoot).toBe('/my/project');
    expect(mgr.get('codex', entry.sessionId)?.projectRoot).toBe('/my/project');
  });

  it('allocate omits projectRoot when not provided', () => {
    const { mgr, workDir } = setup('alloc-no-root');

    const entry = mgr.allocate('codex', 'gamma', 'gpt-5', workDir);

    expect(entry.projectRoot).toBeUndefined();
  });

  it('session:updated payload includes projectRoot when present', () => {
    const { mgr, workDir } = setup('emit-root');
    const emitted: unknown[] = [];
    eventBus.on('session:updated', (payload) => emitted.push(payload));

    mgr.allocate('codex', 'delta', 'gpt-5', workDir, '/proj/root');

    expect(emitted).toHaveLength(1);
    expect((emitted[0] as { projectRoot?: string }).projectRoot).toBe('/proj/root');
  });

  it('session:updated payload omits projectRoot when not set', () => {
    const { mgr, workDir } = setup('emit-no-root');
    const emitted: unknown[] = [];
    eventBus.on('session:updated', (payload) => emitted.push(payload));

    mgr.allocate('codex', 'epsilon', 'gpt-5', workDir);

    expect(emitted).toHaveLength(1);
    expect((emitted[0] as { projectRoot?: string }).projectRoot).toBeUndefined();
  });

  it('emits session:updated with shard hash and version on writes', () => {
    const { mgr, workDir } = setup('session-updated-event');
    const updated = vi.fn();
    eventBus.on('session:updated', updated);

    const entry = mgr.allocate('codex', 'alpha', 'gpt-5', workDir);
    const shardHash = basename(resolveSessionDir(tmpHome));

    expect(updated).toHaveBeenCalledWith({
      sessionId: entry.sessionId,
      shardHash,
      version: 1,
    });

    mgr.setConversationRef(entry.sessionId, 'thread-1');

    expect(updated).toHaveBeenLastCalledWith({
      sessionId: entry.sessionId,
      shardHash,
      version: 2,
    });
  });

  it('claimForJobSync returns false when session already has activeJobId', () => {
    const { mgr, workDir } = setup('claim-active');
    const entry = mgr.allocate('codex', 'alpha', 'gpt-5', workDir);

    expect(mgr.claimForJobSync(entry.sessionId, 'job-1')).toBe(true);
    expect(mgr.claimForJobSync(entry.sessionId, 'job-2')).toBe(false);
  });

  it('claimForJobAtomic allows only one concurrent claimant', async () => {
    const { mgr, workDir } = setup('claim-atomic');
    const entry = mgr.allocate('codex', 'alpha', 'gpt-5', workDir);

    const results = await Promise.all([
      mgr.claimForJobAtomic(entry.sessionId, 'job-1'),
      mgr.claimForJobAtomic(entry.sessionId, 'job-2'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(mgr.get('codex', entry.sessionId)?.activeJobId).toMatch(/^job-[12]$/);
  });

  it('claimForJobAtomic respects expectedVersion', async () => {
    const { mgr, workDir } = setup('claim-expected-version');
    const entry = mgr.allocate('codex', 'alpha', 'gpt-5', workDir);

    await expect(mgr.claimForJobAtomic(entry.sessionId, 'job-1', entry.version + 1)).resolves.toBe(false);
    expect(mgr.get('codex', entry.sessionId)?.version).toBe(entry.version);

    await expect(mgr.claimForJobAtomic(entry.sessionId, 'job-1', entry.version)).resolves.toBe(true);
    expect(mgr.get('codex', entry.sessionId)).toMatchObject({
      activeJobId: 'job-1',
      version: entry.version + 1,
    });
  });

  it('claimForJobAtomic removes a stale lock before claiming', async () => {
    const { mgr, workDir } = setup('claim-stale-lock');
    const entry = mgr.allocate('codex', 'alpha', 'gpt-5', workDir);
    const sessionDir = resolveSessionDir(tmpHome);
    const lockDir = join(sessionDir, `${entry.sessionId}.lock`);
    const staleAt = new Date(Date.now() - 31_000);

    mkdirSync(lockDir);
    utimesSync(lockDir, staleAt, staleAt);

    await expect(mgr.claimForJobAtomic(entry.sessionId, 'job-1')).resolves.toBe(true);
    expect(mgr.get('codex', entry.sessionId)?.activeJobId).toBe('job-1');
  });

  it('releaseJob clears activeJobId and sets lastJobId', () => {
    const { mgr, workDir } = setup('release-job');
    const entry = mgr.allocate('codex', 'alpha', 'gpt-5', workDir);
    mgr.claimForJobSync(entry.sessionId, 'job-1');

    mgr.releaseJob(entry.sessionId, 'job-1');

    const stored = mgr.get('codex', entry.sessionId);
    expect(stored?.activeJobId).toBeUndefined();
    expect(stored?.lastJobId).toBe('job-1');
  });

  it('get returns null for provider mismatch', () => {
    const { mgr, workDir } = setup('provider-mismatch');
    const entry = mgr.allocate('codex', 'alpha', 'gpt-5', workDir);

    expect(mgr.get('claude', entry.sessionId)).toBeNull();
  });

  it('setConversationRef transitions state to ready', () => {
    const { mgr, workDir } = setup('conversation-ref');
    const entry = mgr.allocate('codex', 'alpha', 'gpt-5', workDir);

    mgr.setConversationRef(entry.sessionId, 'thread-1');

    expect(mgr.get('codex', entry.sessionId)).toMatchObject({
      sessionId: entry.sessionId,
      state: 'ready',
      conversationRef: 'thread-1',
    });
  });

  it('setNonResumable transitions state to non_resumable', () => {
    const { mgr, workDir } = setup('non-resumable');
    const entry = mgr.allocate('codex', 'alpha', 'gpt-5', workDir);

    mgr.setNonResumable(entry.sessionId);

    expect(mgr.get('codex', entry.sessionId)?.state).toBe('non_resumable');
  });

  it('increments version on each write', () => {
    const { mgr, workDir } = setup('version-increments');
    const entry = mgr.allocate('codex', 'alpha', 'gpt-5', workDir);

    expect(entry.version).toBe(1);
    expect(mgr.get('codex', entry.sessionId)?.version).toBe(1);

    expect(mgr.claimForJobSync(entry.sessionId, 'job-1')).toBe(true);
    expect(mgr.get('codex', entry.sessionId)?.version).toBe(2);

    mgr.releaseJob(entry.sessionId, 'job-1');
    expect(mgr.get('codex', entry.sessionId)?.version).toBe(3);
  });

  it('openShard reads an existing shard and listShards enumerates it', () => {
    const { mgr, workDir } = setup('open-shard');
    const entry = mgr.allocate('codex', 'alpha', 'gpt-5', workDir);
    const shardDir = resolveSessionDir(tmpHome);

    expect(SessionManager.listShards()).toContain(shardDir);

    const shardMgr = SessionManager.openShard(shardDir);
    expect(shardMgr.get('codex', entry.sessionId)).toMatchObject({
      sessionId: entry.sessionId,
      provider: 'codex',
      name: 'alpha',
    });
  });
});

function resolveSessionDir(baseDir: string): string {
  const sessionDirBase = join(baseDir, '.claude', 'coral', 'execution', 'sessions');
  const entries = readdirSync(sessionDirBase, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (entries.length === 0) throw new Error('No session hash-dir found under ' + sessionDirBase);
  return join(sessionDirBase, entries[0].name);
}

describe('SessionManager adversarial', () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'red-sm-home-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    eventBus.removeAllListeners();
    vi.restoreAllMocks();
  });

  function setup(name: string): { mgr: SessionManager; workDir: string } {
    const workDir = join(tmpHome, name);
    mkdirSync(workDir, { recursive: true });
    return { mgr: new SessionManager(workDir), workDir };
  }

  it('claimForJobSync returns false for a session that does not exist', () => {
    const { mgr } = setup('claim-missing');

    const result = mgr.claimForJobSync('non-existent-session-id', 'job-99');

    expect(result).toBe(false);
  });

  it('releaseJob is a no-op when the stored activeJobId does not match the given jobId', () => {
    const { mgr, workDir } = setup('release-mismatch');
    const entry = mgr.allocate('codex', 'alpha', 'gpt-5', workDir);
    mgr.claimForJobSync(entry.sessionId, 'job-correct');

    mgr.releaseJob(entry.sessionId, 'job-WRONG');

    const stored = mgr.get('codex', entry.sessionId);
    expect(stored?.activeJobId).toBe('job-correct');
    expect(stored?.lastJobId).toBeUndefined();
  });

  it('list returns only sessions for the requested provider (no cross-provider leakage)', () => {
    const { mgr, workDir } = setup('list-filter');
    mgr.allocate('codex', 'codex-session', 'gpt-5', workDir);
    mgr.allocate('claude', 'claude-session', 'sonnet', workDir);

    const codexSessions = mgr.list('codex');
    const claudeSessions = mgr.list('claude');

    expect(codexSessions.every((s) => s.provider === 'codex')).toBe(true);
    expect(claudeSessions.every((s) => s.provider === 'claude')).toBe(true);
    expect(codexSessions).toHaveLength(1);
    expect(claudeSessions).toHaveLength(1);
  });

  it('returns null for an old-format session file without version and does not migrate it', () => {
    const { mgr, workDir } = setup('reject-old-shape');
    mgr.allocate('codex', 'sentinel', 'gpt-5', workDir);

    const sessionDir = resolveSessionDir(tmpHome);

    const oldSessionId = randomUUID();
    const oldEntry = {
      id: oldSessionId,
      provider: 'codex',
      name: 'old-session',
      threadId: 'thread-xyz',
      model: 'gpt-4',
      workingDirectory: '/old/cwd',
      createdAt: '2025-01-01T00:00:00.000Z',
      lastUsedAt: '2025-01-02T00:00:00.000Z',
    };
    writeFileSync(join(sessionDir, `${oldSessionId}.json`), JSON.stringify(oldEntry), 'utf-8');

    const result = mgr.get('codex', oldSessionId);

    expect(result).toBeNull();
    expect(JSON.parse(readFileSync(join(sessionDir, `${oldSessionId}.json`), 'utf-8'))).toEqual(oldEntry);
  });

  it('get() returns null for a corrupt (non-JSON) session file without throwing', () => {
    const { mgr, workDir } = setup('corrupt-session');
    const entry = mgr.allocate('codex', 'alpha', 'gpt-5', workDir);

    const sessionDir = resolveSessionDir(tmpHome);
    writeFileSync(join(sessionDir, `${entry.sessionId}.json`), '{ not valid json }', 'utf-8');

    expect(() => mgr.get('codex', entry.sessionId)).not.toThrow();
    expect(mgr.get('codex', entry.sessionId)).toBeNull();
  });
});
