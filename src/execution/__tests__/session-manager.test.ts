import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

describe('execution SessionManager', () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'coral-execution-home-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
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
    expect(mgr.get('codex', entry.sessionId)).toMatchObject({
      sessionId: entry.sessionId,
      provider: 'codex',
      name: 'alpha',
      state: 'pending',
      model: 'gpt-5',
      cwd: workDir,
    });
  });

  it('claimForJob returns false when session already has activeJobId', () => {
    const { mgr, workDir } = setup('claim-active');
    const entry = mgr.allocate('codex', 'alpha', 'gpt-5', workDir);

    expect(mgr.claimForJob(entry.sessionId, 'job-1')).toBe(true);
    expect(mgr.claimForJob(entry.sessionId, 'job-2')).toBe(false);
  });

  it('releaseJob clears activeJobId and sets lastJobId', () => {
    const { mgr, workDir } = setup('release-job');
    const entry = mgr.allocate('codex', 'alpha', 'gpt-5', workDir);
    mgr.claimForJob(entry.sessionId, 'job-1');

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
    vi.restoreAllMocks();
  });

  function setup(name: string): { mgr: SessionManager; workDir: string } {
    const workDir = join(tmpHome, name);
    mkdirSync(workDir, { recursive: true });
    return { mgr: new SessionManager(workDir), workDir };
  }

  it('claimForJob returns false for a session that does not exist', () => {
    const { mgr } = setup('claim-missing');

    const result = mgr.claimForJob('non-existent-session-id', 'job-99');

    expect(result).toBe(false);
  });

  it('releaseJob is a no-op when the stored activeJobId does not match the given jobId', () => {
    const { mgr, workDir } = setup('release-mismatch');
    const entry = mgr.allocate('codex', 'alpha', 'gpt-5', workDir);
    mgr.claimForJob(entry.sessionId, 'job-correct');

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

  it('migrates old-format session file (id/threadId/workingDirectory) on first read', () => {
    const { mgr, workDir } = setup('migrate-old');
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

    expect(result).not.toBeNull();
    expect(result?.sessionId).toBe(oldSessionId);
    expect(result?.conversationRef).toBe('thread-xyz');
    expect(result?.cwd).toBe('/old/cwd');
    expect(result?.state).toBe('ready');

    const reread = mgr.get('codex', oldSessionId);
    expect(reread?.sessionId).toBe(oldSessionId);
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
