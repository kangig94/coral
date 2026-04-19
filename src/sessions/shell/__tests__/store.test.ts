import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

import { currentBuildFlavor } from '../../../infra/paths.js';
import { createRealRuntime } from '../../../runtime/real.js';
import { appendEvents } from '../../../store/append.js';
import { openStoreDatabase } from '../../../store/db.js';
import { createEmptyRegistry } from '../../../store/envelope.js';
import { ensureStoreMigrationsDir } from '../../../store/migrations.js';
import { discussRegistry } from '../../../discuss/store-registry.js';
import { jobsRegistry } from '../../../jobs/events.js';
import { composeReducers } from '../../../store/reducers.js';
import { storePaths } from '../../../store/paths.js';
import { sessionsRegistry } from '../../events.js';
import { workflowRegistry } from '../../../workflow/events.js';
import { SessionManager } from '../store.js';

const runtime = createRealRuntime();

function resolveSessionDir(baseDir: string): string {
  const sessionDirBase = join(baseDir, '.claude', 'coral', 'execution', 'sessions');
  const entries = readdirSync(sessionDirBase, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (entries.length === 0) throw new Error('No session hash-dir found under ' + sessionDirBase);
  return join(sessionDirBase, entries[0].name);
}

describe('sessions shell store', () => {
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
    return { mgr: new SessionManager(workDir, runtime), workDir };
  }

  function setupWithJournal(projectName: string): {
    db: ReturnType<typeof openStoreDatabase>;
    mgr: SessionManager;
    workDir: string;
  } {
    const workDir = join(tmpHome, projectName);
    mkdirSync(workDir, { recursive: true });

    const db = openStoreDatabase({
      path: storePaths(currentBuildFlavor()).dbFile,
      storage: runtime.storage,
      migrationsDir: ensureStoreMigrationsDir(runtime.storage),
    });
    const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
    const upcasters = createEmptyRegistry();
    const coordinatorAppendEvents = (inputs: Parameters<typeof appendEvents>[1]) => {
      appendEvents(db, inputs, {
        now: () => new Date('2026-04-19T00:00:00.000Z'),
        reducers,
        upcasters,
      });
    };

    return {
      db,
      mgr: new SessionManager(workDir, runtime, coordinatorAppendEvents),
      workDir,
    };
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

  it('allocate appends session.opened and continuity checkpoints append to the journal', () => {
    const { db, mgr, workDir } = setupWithJournal('journal-events');
    const entry = mgr.allocate({
      provider: 'codex',
      name: 'alpha',
      model: 'gpt-5',
      cwd: workDir,
      projectRoot: workDir,
      backendNamespace: 'ns-a',
      controllerProfile: { owner: 'team-a' },
    });

    mgr.setConversationRef(entry.sessionId, 'thread-1');

    try {
      const rows = db
        .prepare(
          `SELECT type, body
             FROM events
            WHERE stream_kind = 'session' AND stream_id = ?
            ORDER BY seq ASC`,
        )
        .all(entry.sessionId) as Array<{ type: string; body: Uint8Array | Buffer }>;

      expect(rows.map((row) => row.type)).toEqual([
        'session.opened',
        'session.continuity.checkpointed',
      ]);
      expect(JSON.parse(new TextDecoder().decode(rows[0].body))).toEqual({
        controller: 'team-a',
        provider: 'codex',
      });
      expect(JSON.parse(new TextDecoder().decode(rows[1].body))).toEqual({
        conversationRef: 'thread-1',
        resumable: true,
        providerContinuity: null,
      });
    } finally {
      db.close();
    }
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
});

describe('sessions shell store adversarial', () => {
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
    return { mgr: new SessionManager(workDir, runtime), workDir };
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

    const freshMgr = SessionManager.openShard(sessionDir, runtime);
    expect(() => freshMgr.get('codex', entry.sessionId)).not.toThrow();
    expect(freshMgr.get('codex', entry.sessionId)).toBeNull();
  });
});
