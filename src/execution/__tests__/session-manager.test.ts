import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type * as NodeOs from 'node:os';

let tmpHome = '';

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

import { SessionManager } from '../session-manager.js';
import { TypedEventBus } from '../event-bus.js';

let eventBus: TypedEventBus;

describe('execution SessionManager', () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'coral-execution-home-'));
    eventBus = new TypedEventBus();
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    eventBus.reset();
    vi.restoreAllMocks();
  });

  function setup(projectName: string): { mgr: SessionManager; workDir: string } {
    const workDir = join(tmpHome, projectName);
    mkdirSync(workDir, { recursive: true });
    return { mgr: new SessionManager(workDir, eventBus), workDir };
  }

  it('allocate creates an entry with state pending', () => {
    const { mgr, workDir } = setup('allocate-pending');

    const entry = mgr.allocate({
      provider: 'codex',
      name: 'alpha',
      model: 'gpt-5',
      cwd: workDir,
    });

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

    const entry = mgr.allocate({
      provider: 'codex',
      name: 'beta',
      model: 'gpt-5',
      cwd: workDir,
      projectRoot: '/my/project',
    });

    expect(entry.projectRoot).toBe('/my/project');
    expect(mgr.get('codex', entry.sessionId)?.projectRoot).toBe('/my/project');
  });

  it('allocate omits projectRoot when not provided', () => {
    const { mgr, workDir } = setup('alloc-no-root');

    const entry = mgr.allocate({
      provider: 'codex',
      name: 'gamma',
      model: 'gpt-5',
      cwd: workDir,
    });

    expect(entry.projectRoot).toBeUndefined();
  });

  it('allocate persists backend provenance and stored profile fields', () => {
    const { mgr, workDir } = setup('alloc-with-profile');

    const entry = mgr.allocate({
      provider: 'codex',
      name: 'delta',
      model: 'gpt-5',
      cwd: workDir,
      projectRoot: '/my/project',
      backendNamespace: 'ns-local',
      agentName: 'debugger',
      instruction: { content: 'Follow the debugger playbook.', channel: 'system' },
      bypassPermissions: true,
      systemPrompt: 'You are debugging.',
      controllerProfile: {
        owner: 'team-a',
        effort: 'high',
        claudeModelCap: 'sonnet',
      },
    });

    expect(mgr.get('codex', entry.sessionId)).toMatchObject({
      sessionId: entry.sessionId,
      projectRoot: '/my/project',
      backendNamespace: 'ns-local',
      agentName: 'debugger',
      instruction: { content: 'Follow the debugger playbook.', channel: 'system' },
      bypassPermissions: true,
      systemPrompt: 'You are debugging.',
      controllerProfile: {
        owner: 'team-a',
        effort: 'high',
        claudeModelCap: 'sonnet',
      },
    });
  });

  it('session:updated payload includes projectRoot when present', () => {
    const { mgr, workDir } = setup('emit-root');
    const emitted: unknown[] = [];
    eventBus.on('session:updated', (payload: unknown) => emitted.push(payload));

    mgr.allocate({
      provider: 'codex',
      name: 'epsilon',
      model: 'gpt-5',
      cwd: workDir,
      projectRoot: '/proj/root',
      backendNamespace: 'ns-local',
    });

    expect(emitted).toHaveLength(1);
    expect((emitted[0] as { projectRoot?: string }).projectRoot).toBe('/proj/root');
  });

  it('session:updated payload omits projectRoot when not set', () => {
    const { mgr, workDir } = setup('emit-no-root');
    const emitted: unknown[] = [];
    eventBus.on('session:updated', (payload: unknown) => emitted.push(payload));

    mgr.allocate({
      provider: 'codex',
      name: 'zeta',
      model: 'gpt-5',
      cwd: workDir,
    });

    expect(emitted).toHaveLength(1);
    expect((emitted[0] as { projectRoot?: string }).projectRoot).toBeUndefined();
  });

  it('emits session:updated with shard hash and version on writes', () => {
    const { mgr, workDir } = setup('session-updated-event');
    const updated = vi.fn();
    eventBus.on('session:updated', updated);

    const entry = mgr.allocate({
      provider: 'codex',
      name: 'alpha',
      model: 'gpt-5',
      cwd: workDir,
    });
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

  it('finalizeJobContinuityAtomic releases the claim and stores a resumable conversationRef', async () => {
    const { mgr, workDir } = setup('finalize-resumable');
    const entry = mgr.allocate('codex', 'alpha', 'gpt-5', workDir);
    mgr.claimForJobSync(entry.sessionId, 'job-1');

    const claimed = mgr.get('codex', entry.sessionId);
    if (!claimed) {
      throw new Error('Expected claimed session');
    }

    await expect(
      mgr.finalizeJobContinuityAtomic(entry.sessionId, {
        expectedActiveJobId: 'job-1',
        expectedVersion: claimed.version,
        mutation: {
          type: 'set_resumable',
          conversationRef: 'thread-1',
        },
      }),
    ).resolves.toBe(true);

    expect(mgr.get('codex', entry.sessionId)).toMatchObject({
      activeJobId: undefined,
      lastJobId: 'job-1',
      state: 'ready',
      conversationRef: 'thread-1',
    });
  });

  it('clearConversationRefAndMarkNonResumableAtomic clears conversationRef and releases the claim', async () => {
    const { mgr, workDir } = setup('finalize-non-resumable');
    const entry = mgr.allocate('codex', 'alpha', 'gpt-5', workDir);
    mgr.setConversationRef(entry.sessionId, 'thread-stale');
    mgr.claimForJobSync(entry.sessionId, 'job-1');

    const claimed = mgr.get('codex', entry.sessionId);
    if (!claimed) {
      throw new Error('Expected claimed session');
    }

    await expect(
      mgr.clearConversationRefAndMarkNonResumableAtomic(entry.sessionId, 'job-1', claimed.version),
    ).resolves.toBe(true);

    expect(mgr.get('codex', entry.sessionId)).toMatchObject({
      activeJobId: undefined,
      lastJobId: 'job-1',
      state: 'non_resumable',
    });
    expect(mgr.get('codex', entry.sessionId)?.conversationRef).toBeUndefined();
  });

  it('finalizeJobContinuityAtomic returns false when the version is stale', async () => {
    const { mgr, workDir } = setup('finalize-stale-version');
    const entry = mgr.allocate('codex', 'alpha', 'gpt-5', workDir);
    mgr.claimForJobSync(entry.sessionId, 'job-1');

    const claimed = mgr.get('codex', entry.sessionId);
    if (!claimed) {
      throw new Error('Expected claimed session');
    }

    await expect(
      mgr.finalizeJobContinuityAtomic(entry.sessionId, {
        expectedActiveJobId: 'job-1',
        expectedVersion: claimed.version - 1,
        mutation: {
          type: 'set_resumable',
          conversationRef: 'thread-1',
        },
      }),
    ).resolves.toBe(false);

    expect(mgr.get('codex', entry.sessionId)?.activeJobId).toBe('job-1');
    expect(mgr.get('codex', entry.sessionId)?.lastJobId).toBeUndefined();
    expect(mgr.get('codex', entry.sessionId)?.state).toBe('pending');
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

  it('getById finds a session across shards and refreshes cached reads after writes', () => {
    const alpha = setup('lookup-shard-a');
    const beta = setup('lookup-shard-b');
    const sessionA = alpha.mgr.allocate({
      provider: 'codex',
      name: 'alpha',
      model: 'gpt-5',
      cwd: alpha.workDir,
      projectRoot: alpha.workDir,
      backendNamespace: 'ns-a',
    });
    const sessionB = beta.mgr.allocate({
      provider: 'claude',
      name: 'beta',
      model: 'sonnet',
      cwd: beta.workDir,
      projectRoot: beta.workDir,
      backendNamespace: 'ns-b',
    });

    expect(SessionManager.getById(sessionA.sessionId)).toMatchObject({
      sessionId: sessionA.sessionId,
      provider: 'codex',
      backendNamespace: 'ns-a',
    });
    expect(SessionManager.getById(sessionB.sessionId)).toMatchObject({
      sessionId: sessionB.sessionId,
      provider: 'claude',
      backendNamespace: 'ns-b',
    });

    beta.mgr.setConversationRef(sessionB.sessionId, 'thread-2');

    expect(SessionManager.getById(sessionB.sessionId)).toMatchObject({
      sessionId: sessionB.sessionId,
      state: 'ready',
      conversationRef: 'thread-2',
    });
    expect(SessionManager.getById('missing-session-id')).toBeNull();
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
    eventBus = new TypedEventBus();
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

  it('get() returns null for a corrupt (non-JSON) session file on cache-miss read', () => {
    const { mgr, workDir } = setup('corrupt-session');
    const entry = mgr.allocate('codex', 'alpha', 'gpt-5', workDir);

    const sessionDir = resolveSessionDir(tmpHome);
    writeFileSync(join(sessionDir, `${entry.sessionId}.json`), '{ not valid json }', 'utf-8');

    // A fresh manager (no cache) should gracefully handle the corrupt file
    const freshMgr = SessionManager.openShard(sessionDir);
    expect(() => freshMgr.get('codex', entry.sessionId)).not.toThrow();
    expect(freshMgr.get('codex', entry.sessionId)).toBeNull();
  });
});
