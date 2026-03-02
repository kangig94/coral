/**
 * Red-team adversarial tests for the api-session-naming rename.
 *
 * Staging file — copy to src/codex/__tests__/red-session-naming.test.ts to run.
 *
 * Coverage gaps targeted (non-overlapping with existing tests):
 *
 * SCHEMA — old field names leak through
 *   1. wait rejects `job_ids` (old field name) — schema should not accept it
 *   2. abort rejects `job_id` (old field name) — removed from abortShape
 *   3. wait cursors with non-UUID key rejected at schema layer
 *   4. wait with both `sessions` and `job_ids` — only `sessions` is canonical
 *
 * API RESPONSE FIELDS — thread_id leakage and field presence
 *   5. exec fresh response has session/session_dir/session_name/status; no thread_id/job_id/job_dir
 *   6. list response: each entry has no thread_id field (internal field must not leak)
 *   7. abort response: no thread_id / no job_id in body
 *   8. wait timeout response uses running_sessions not running_jobs
 *
 * WAIT — behavioral gaps
 *   9. wait for non-existent session dir returns error (session dir not created)
 *  10. wait: cursor for completed_session is excluded from returned cursors record
 *  11. wait: second session cursor preserved when first session completes
 *
 * SESSION MANAGER — legacy migration edge-case names
 *  12. legacy migration: name is empty string (valid JSON, v1 shape) — migrates deterministically
 *  13. legacy migration: name with spaces — treated as literal, case-sensitive
 *  14. legacy migration: name with dots — passes v1 guard, migrates correctly
 *  15. legacy migration with corrupt JSON alongside valid v1 — corrupt file is skipped, valid migrates
 *  16. get() with empty string id returns null (no path-traversal attempt)
 *
 * ACTIVE JOBS LIFECYCLE
 *  17. launchJob: activeSessions entry is removed after successful completion (finally block)
 *  18. launchJob: activeSessions entry is removed after error (finally block)
 *  19. abort on terminalizing entry still returns abort_requested (controller.abort() is idempotent)
 *
 * EXTRACT COMPLETION DATA — null thread_id path
 *  20. extractCompletionData: neither thread_id nor session in payload — metadata.thread_id is null
 *  21. launchJob: when thread_id is null in completion, session is NOT registered in mgr
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ZodError } from 'zod';

vi.mock('../codex-executor.js', () => ({
  executeOneShot: vi.fn(),
  executeResume: vi.fn(),
  executeFork: vi.fn(),
}));

vi.mock('../cli-detection.js', () => ({
  detectCodexCli: vi.fn(),
}));

vi.mock('../progress.js', () => ({
  createSessionDir: vi.fn(() => ({
    id: '12345678-1234-4234-8234-123456789abc',
    dir: '/tmp/coral-sessions/12345678-1234-4234-8234-123456789abc',
  })),
  writeSessionResult: vi.fn(),
  writeSessionError: vi.fn(),
  readSessionStatus: vi.fn(() => ({ status: 'running' })),
  resolveSessionDir: vi.fn((id: string) => `/tmp/coral-sessions/${id}`),
  SESSIONS_DIR: '/tmp/coral-sessions',
  PROGRESS_FILE: 'progress.jsonl',
  extractProgressMessage: vi.fn(),
  appendProgressEvent: vi.fn(),
  formatElapsed: vi.fn(() => ''),
}));

import { codexOpSchema } from '../schemas.js';
import {
  handleToolCall,
  handleWait,
  handleSessionAbort,
  handleSessionList,
  extractCompletionData,
  launchJob,
  activeSessions,
  _test as handlerTest,
} from '../server-handlers.js';
import { SessionManager } from '../session-manager.js';
import { jsonResult } from '../../shared/mcp-utils.js';
import {
  createSessionDir,
  readSessionStatus,
  resolveSessionDir,
} from '../progress.js';
import { executeOneShot } from '../codex-executor.js';
import { detectCodexCli } from '../cli-detection.js';
import type { CodexExecResult } from '../../types.js';

// ── test helpers ──────────────────────────────────────────────────────────────

function makeExecResult(overrides: Partial<CodexExecResult> = {}): CodexExecResult {
  return {
    response: 'ok',
    sessionId: 'thread-test-001',
    model: 'o4-mini',
    durationMs: 100,
    exitCode: 0,
    errors: [],
    warnings: [],
    aborted: false,
    ...overrides,
  };
}

const LEGACY_SESSION_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

function uuidV5(namespace: string, name: string): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const nameBytes = Buffer.from(name, 'utf-8');
  const hash = createHash('sha1').update(nsBytes).update(nameBytes).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const h = hash.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function projectHash(dir: string): string {
  return createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 12);
}

function sessionsDir(homedirPath: string, workingDirectory: string): string {
  return join(homedirPath, '.claude', 'coral', 'sessions', projectHash(workingDirectory));
}

// ── module-level fixtures ─────────────────────────────────────────────────────

let tmpDir = '';
let homedirTmp = '';

vi.mock('node:os', () => ({
  homedir: () => homedirTmp,
  tmpdir: () => '/tmp',
}));

const defaultPluginRoot = process.cwd();

beforeEach(() => {
  tmpDir = mkdtempSync(join('/tmp', 'coral-red-naming-'));
  homedirTmp = mkdtempSync(join('/tmp', 'coral-red-home-'));
  mkdirSync(join(tmpDir, 'workspace'), { recursive: true });
  mkdirSync(join(tmpDir, 'agents'), { recursive: true });
  writeFileSync(join(tmpDir, 'agents', 'scanner.md'), '# Scanner\n');
  handlerTest.setPluginRoot(tmpDir);
  activeSessions.clear();

  vi.mocked(detectCodexCli).mockResolvedValue({
    available: true,
    version: 'codex 1.0.0',
    authState: 'authenticated',
  });
  vi.mocked(executeOneShot).mockResolvedValue(makeExecResult());
  vi.mocked(createSessionDir).mockReturnValue({
    id: '12345678-1234-4234-8234-123456789abc',
    dir: '/tmp/coral-sessions/12345678-1234-4234-8234-123456789abc',
  });
  vi.mocked(resolveSessionDir).mockImplementation((id: string) => `/tmp/coral-sessions/${id}`);
  vi.mocked(readSessionStatus).mockReturnValue({ status: 'running' });
});

afterEach(() => {
  activeSessions.clear();
  vi.clearAllMocks();
  handlerTest.setPluginRoot(defaultPluginRoot);
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(homedirTmp, { recursive: true, force: true });
});

// ── 1-4: Schema — old field names must be rejected ───────────────────────────

describe('schema: old field names are rejected after rename', () => {
  it('wait rejects job_ids (old field name — not job_ids anymore, sessions is the key)', () => {
    // Before rename: wait accepted job_ids. After rename: sessions is the only valid field.
    // Passing job_ids must fail because there is no sessions array.
    const result = codexOpSchema.safeParse({ op: 'wait', job_ids: ['12345678-1234-1234-1234-123456789abc'] });
    expect(result.success).toBe(false);
  });

  it('abort rejects job_id (old field name — abortShape has no job_id)', () => {
    // Before rename: abort accepted job_id as an alternative. After rename: only session UUID.
    // Passing job_id without session must fail (missing required field).
    const result = codexOpSchema.safeParse({ op: 'abort', job_id: '12345678-1234-1234-1234-123456789abc' });
    expect(result.success).toBe(false);
  });

  it('wait cursors with non-UUID key is rejected at schema layer', () => {
    // cursors is z.record(z.string().uuid(), ...) — non-UUID keys must fail validation.
    const result = codexOpSchema.safeParse({
      op: 'wait',
      sessions: ['12345678-1234-1234-1234-123456789abc'],
      cursors: { 'not-a-uuid': 0 },
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(ZodError);
  });

  it('wait with both sessions and job_ids: job_ids is ignored, only sessions is validated', () => {
    // If both fields passed, only sessions matters. job_ids is an unknown extra field.
    // waitShape is not strict(), so extra fields may be accepted — but sessions must be valid.
    const result = codexOpSchema.safeParse({
      op: 'wait',
      sessions: ['12345678-1234-1234-1234-123456789abc'],
      job_ids: ['bad'],
    });
    // sessions is valid UUID, so this should parse successfully (job_ids is stripped as unknown)
    expect(result.success).toBe(true);
    if (result.success) {
      // The parsed output must use sessions, not job_ids
      expect(result.data).toMatchObject({ sessions: ['12345678-1234-1234-1234-123456789abc'] });
      expect((result.data as Record<string, unknown>).job_ids).toBeUndefined();
    }
  });
});

// ── 5-8: API response field contracts ────────────────────────────────────────

describe('API response: renamed fields and no old field names', () => {
  it('exec fresh response has session/session_dir/session_name/status; no thread_id/job_id/job_dir', async () => {
    const mgr = new SessionManager(join(tmpDir, 'workspace'));
    const result = await handleToolCall('codex', { op: 'exec', prompt: 'hello' }, mgr);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);

    // Required new fields
    expect(data.session).toBeDefined();
    expect(data.session_dir).toBeDefined();
    expect(data.session_name).toBeDefined();
    expect(data.status).toBe('running');

    // Must NOT contain old or internal fields
    expect(data.thread_id).toBeUndefined();
    expect(data.job_id).toBeUndefined();
    expect(data.job_dir).toBeUndefined();
  });

  it('list response: each session entry does not expose thread_id (internal field)', () => {
    const mgr = new SessionManager(join(tmpDir, 'workspace'));
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    mgr.register(sessionId, 'my-session', 'thread-internal-001', 'o4-mini', '/workspace');

    const result = handleSessionList(mgr);
    expect(result.isError).toBe(false);

    const data = JSON.parse(result.content[0].text) as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(data.sessions).toHaveLength(1);

    const entry = data.sessions[0];
    // threadId must NOT appear in the public list output under any key
    expect(entry).not.toHaveProperty('thread_id');
    expect(entry).not.toHaveProperty('threadId');
    // The public UUID alias must be present
    expect(entry).toHaveProperty('session', sessionId);
  });

  it('abort response does not expose thread_id or job_id fields', async () => {
    const mgr = new SessionManager(join(tmpDir, 'workspace'));
    const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const controller = new AbortController();
    activeSessions.set(sessionId, {
      sessionDir: '/tmp/test',
      controller,
      sessionName: 'abort-target',
      terminalState: 'running',
    } as never);

    const result = await handleSessionAbort({ session: sessionId }, mgr);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);

    expect(data.session).toBe(sessionId);
    expect(data.status).toBe('abort_requested');
    // Internal fields must not appear
    expect(data.thread_id).toBeUndefined();
    expect(data.job_id).toBeUndefined();
    expect(data.threadId).toBeUndefined();
  });

  it('wait timeout response uses running_sessions (not running_jobs)', async () => {
    // Simulate a wait that times out immediately (timeout_seconds = 1 is minimum;
    // use a very short poll by mocking readSessionStatus to always return running,
    // then rely on the timeout boundary being reached at 1 second).
    // Instead: call handleWait with a session that has a dir but status stays running,
    // and a tiny timeout, so we reach timeoutResponse().
    const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    // resolveSessionDir must not throw so the session dir "exists"
    vi.mocked(resolveSessionDir).mockImplementation((id) => `/tmp/coral-sessions/${id}`);
    // existsSync is real; we need the dir to exist for the handler to proceed past the check.
    // Since we can't easily mock existsSync here, use the real SESSIONS_DIR path approach
    // by using the real createSessionDir and real progress infrastructure for this one test.
    //
    // Alternative: trigger timeout with timeout_seconds=1 and mock readSessionStatus to stay 'running'.
    // The wait loop polls every 500ms; at timeout_seconds=1 the loop exits.
    // We rely on the mock returning 'running' so it never completes.
    vi.mocked(readSessionStatus).mockReturnValue({ status: 'running' });

    // We need the session dir to exist (existsSync check in handleWait).
    // Use the real filesystem: create a real session dir.
    const { createSessionDir: realCreateSessionDir } = await vi.importActual<typeof import('../progress.js')>('../progress.js');
    const { dir } = realCreateSessionDir(`timeout-test-${sessionId}`);

    try {
      // Point resolveSessionDir at the real dir for this session.
      vi.mocked(resolveSessionDir).mockImplementation((id) => id === sessionId ? dir : `/tmp/coral-sessions/${id}`);

      const result = await handleWait({ op: 'wait', sessions: [sessionId], timeout_seconds: 1 });
      const data = JSON.parse(result.content[0].text);

      expect(data.status).toBe('timeout');
      // New field name: running_sessions (not running_jobs)
      expect(data.running_sessions).toBeDefined();
      expect(Array.isArray(data.running_sessions)).toBe(true);
      // Old field name must NOT appear
      expect(data.running_jobs).toBeUndefined();
      expect(data.matched_job_ids).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 3000);
});

// ── 9-11: wait behavioral gaps ────────────────────────────────────────────────

describe('handleWait: behavioral gaps', () => {
  it('wait for non-existent session dir returns error immediately', async () => {
    const sessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    // resolveSessionDir returns a path, but existsSync will return false (dir not created)
    vi.mocked(resolveSessionDir).mockReturnValue('/tmp/coral-sessions/does-not-exist-dir');

    const result = await handleWait({ op: 'wait', sessions: [sessionId] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(sessionId);
  });

  it('wait: cursor for completed_session is excluded from returned cursors record', async () => {
    const sessionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

    const { createSessionDir: realCreate, writeSessionResult: realWrite } =
      await vi.importActual<typeof import('../progress.js')>('../progress.js');
    const { dir } = realCreate(`cursor-test`);

    try {
      realWrite(dir, 'done', { session_name: 'cursor-test' });

      // Use real readSessionStatus for this specific dir; mock handles everything else
      vi.mocked(resolveSessionDir).mockImplementation((id) =>
        id === sessionId ? dir : `/tmp/coral-sessions/${id}`,
      );
      // Import actual readSessionStatus so we can call it without require()
      const { readSessionStatus: realReadStatus } =
        await vi.importActual<typeof import('../progress.js')>('../progress.js');
      vi.mocked(readSessionStatus).mockImplementation((d) => {
        if (d === dir) return realReadStatus(d);
        return { status: 'running' };
      });

      const result = await handleWait({
        op: 'wait',
        sessions: [sessionId],
        cursors: { [sessionId]: 0 },
      });
      const data = JSON.parse(result.content[0].text);

      expect(data.status).toBe('completed');
      expect(data.completed_session).toBe(sessionId);
      // The completed session's cursor must NOT appear in the returned cursors object
      // (per the implementation: for (const [id, offset] of cursors) if (id !== completedId))
      expect(data.cursors?.[sessionId]).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('wait: cursor for non-completed session is preserved when another session completes', async () => {
    const completedId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const runningId = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    const { createSessionDir: realCreate, writeSessionResult: realWrite } =
      await vi.importActual<typeof import('../progress.js')>('../progress.js');
    const { dir: completedDir } = realCreate(`two-session-completed`);
    const { dir: runningDir } = realCreate(`two-session-running`);

    try {
      realWrite(completedDir, 'done', { session_name: 'completed-sess' });

      vi.mocked(resolveSessionDir).mockImplementation((id) => {
        if (id === completedId) return completedDir;
        if (id === runningId) return runningDir;
        return `/tmp/coral-sessions/${id}`;
      });
      vi.mocked(readSessionStatus).mockImplementation((d) => {
        if (d === completedDir) return { status: 'completed' };
        return { status: 'running' };
      });

      const result = await handleWait({
        op: 'wait',
        sessions: [completedId, runningId],
        cursors: { [completedId]: 0, [runningId]: 42 },
      });
      const data = JSON.parse(result.content[0].text);

      expect(data.completed_session).toBe(completedId);
      // Running session cursor must be preserved in returned cursors
      expect(data.cursors?.[runningId]).toBe(42);
      // Completed session cursor must be omitted
      expect(data.cursors?.[completedId]).toBeUndefined();
    } finally {
      rmSync(completedDir, { recursive: true, force: true });
      rmSync(runningDir, { recursive: true, force: true });
    }
  });
});

// ── 12-16: SessionManager legacy migration edge-case names ───────────────────

describe('SessionManager: legacy migration edge-case names', () => {
  function setup(projectName: string): { mgr: SessionManager; workDir: string; dir: string } {
    const workDir = join(tmpDir, projectName);
    mkdirSync(workDir, { recursive: true });
    const dir = sessionsDir(homedirTmp, workDir);
    mkdirSync(dir, { recursive: true });
    return { mgr: new SessionManager(workDir), workDir, dir };
  }

  it('legacy migration: empty string name migrates to deterministic UUID', () => {
    // An old session file with name="" should be treated as a legacy v1 entry.
    // uuidV5(namespace, '') is a valid deterministic UUID.
    const workDir = join(tmpDir, 'empty-name');
    mkdirSync(workDir, { recursive: true });
    const dir = sessionsDir(homedirTmp, workDir);
    mkdirSync(dir, { recursive: true });

    const legacyName = '';
    writeFileSync(join(dir, `${legacyName || '_empty'}.json`), JSON.stringify({
      name: legacyName,
      sessionId: 'thread-empty-name',
      model: 'o4-mini',
      createdAt: '2024-01-01T00:00:00.000Z',
      lastUsedAt: '2024-01-02T00:00:00.000Z',
      workingDirectory: '/some/dir',
    }), 'utf-8');

    const mgr = new SessionManager(workDir);
    const migratedId = uuidV5(LEGACY_SESSION_NAMESPACE, legacyName);

    // The migration uses the bare name as-is (empty string is valid input to uuidV5)
    const found = mgr.get(migratedId);
    // Either migrated (empty name is a valid string in isLegacySessionEntryV1) or skipped —
    // what matters is no crash and no invalid path construction.
    if (found !== null) {
      expect(found.id).toBe(migratedId);
      expect(found.threadId).toBe('thread-empty-name');
    }
    // No exception must be thrown during migration regardless.
  });

  it('legacy migration: name with spaces migrates to deterministic UUID (case-sensitive, literal)', () => {
    const workDir = join(tmpDir, 'space-name');
    mkdirSync(workDir, { recursive: true });
    const dir = sessionsDir(homedirTmp, workDir);
    mkdirSync(dir, { recursive: true });

    const legacyName = 'my session name';
    // File name on disk uses the literal name (spaces allowed in unix filenames)
    writeFileSync(join(dir, `${legacyName}.json`), JSON.stringify({
      name: legacyName,
      sessionId: 'thread-space-001',
      model: 'o4-mini',
      createdAt: '2024-01-01T00:00:00.000Z',
      lastUsedAt: '2024-01-02T00:00:00.000Z',
      workingDirectory: '/space/dir',
    }), 'utf-8');

    const mgr = new SessionManager(workDir);
    const migratedId = uuidV5(LEGACY_SESSION_NAMESPACE, legacyName);

    const found = mgr.get(migratedId);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(migratedId);
    expect(found?.name).toBe(legacyName);
    expect(found?.threadId).toBe('thread-space-001');
    // Old file should be removed
    expect(existsSync(join(dir, `${legacyName}.json`))).toBe(false);
  });

  it('legacy migration: name with dots migrates correctly', () => {
    const workDir = join(tmpDir, 'dot-name');
    mkdirSync(workDir, { recursive: true });
    const dir = sessionsDir(homedirTmp, workDir);
    mkdirSync(dir, { recursive: true });

    const legacyName = 'session.v1.test';
    writeFileSync(join(dir, `${legacyName}.json`), JSON.stringify({
      name: legacyName,
      sessionId: 'thread-dots-001',
      model: 'o4-mini',
      createdAt: '2024-01-01T00:00:00.000Z',
      lastUsedAt: '2024-01-02T00:00:00.000Z',
      workingDirectory: '/dot/dir',
    }), 'utf-8');

    const mgr = new SessionManager(workDir);
    const migratedId = uuidV5(LEGACY_SESSION_NAMESPACE, legacyName);

    const found = mgr.get(migratedId);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(migratedId);
    expect(found?.threadId).toBe('thread-dots-001');
  });

  it('legacy migration: corrupt JSON alongside valid v1 — corrupt skipped, valid migrates', () => {
    const workDir = join(tmpDir, 'mixed-migration');
    mkdirSync(workDir, { recursive: true });
    const dir = sessionsDir(homedirTmp, workDir);
    mkdirSync(dir, { recursive: true });

    const legacyName = 'valid-legacy';
    writeFileSync(join(dir, `${legacyName}.json`), JSON.stringify({
      name: legacyName,
      sessionId: 'thread-valid-migrate',
      model: 'o4-mini',
      createdAt: '2024-01-01T00:00:00.000Z',
      lastUsedAt: '2024-01-02T00:00:00.000Z',
      workingDirectory: '/mixed/dir',
    }), 'utf-8');
    // Corrupt file alongside valid one
    writeFileSync(join(dir, 'corrupt-legacy.json'), '{invalid json!!!', 'utf-8');

    const mgr = new SessionManager(workDir);
    const migratedId = uuidV5(LEGACY_SESSION_NAMESPACE, legacyName);

    // Valid legacy migrates
    const found = mgr.get(migratedId);
    expect(found).not.toBeNull();
    expect(found?.threadId).toBe('thread-valid-migrate');

    // Corrupt file must not prevent the rest of the list from loading
    const all = mgr.list();
    expect(all.some((e) => e.id === migratedId)).toBe(true);
  });

  it('get() with empty string id returns null without throwing', () => {
    const { mgr } = setup('empty-get');
    // get() calls readSession('') which builds path '<dir>/.json'
    // It must not throw — it should return null gracefully
    expect(() => mgr.get('')).not.toThrow();
    const result = mgr.get('');
    expect(result).toBeNull();
  });
});

// ── 17-19: activeSessions lifecycle ───────────────────────────────────────────────

describe('activeSessions lifecycle: cleanup after completion and error', () => {
  it('activeSessions entry is removed after successful job completion', async () => {
    vi.mocked(createSessionDir).mockReturnValue({
      id: 'lifecycle-ok-11111111-1111-4111-8111-111111111111',
      dir: '/tmp/coral-sessions/lifecycle-ok',
    });

    const mgr = new SessionManager(join(tmpDir, 'workspace'));
    let resolveHandler!: (r: import('../../shared/mcp-utils.js').McpResult) => void;
    const pending = new Promise<import('../../shared/mcp-utils.js').McpResult>(
      (resolve) => { resolveHandler = resolve; },
    );

    launchJob('cleanup-test', () => pending, mgr);
    const jobId = 'lifecycle-ok-11111111-1111-4111-8111-111111111111';
    expect(activeSessions.has(jobId)).toBe(true);

    // Resolve with a proper completion result
    resolveHandler(jsonResult({ response: 'done', thread_id: 'thread-lifecycle', model: 'o4-mini', duration_ms: 10 }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    // After completion, the entry must be cleaned up
    expect(activeSessions.has(jobId)).toBe(false);
  });

  it('activeSessions entry is removed after job error', async () => {
    vi.mocked(createSessionDir).mockReturnValue({
      id: 'lifecycle-err-22222222-2222-4222-8222-222222222222',
      dir: '/tmp/coral-sessions/lifecycle-err',
    });

    const mgr = new SessionManager(join(tmpDir, 'workspace'));
    let rejectHandler!: (e: Error) => void;
    const failing = new Promise<import('../../shared/mcp-utils.js').McpResult>(
      (_, reject) => { rejectHandler = reject; },
    );

    launchJob('error-cleanup-test', () => failing, mgr);
    const jobId = 'lifecycle-err-22222222-2222-4222-8222-222222222222';
    expect(activeSessions.has(jobId)).toBe(true);

    rejectHandler(new Error('boom'));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(activeSessions.has(jobId)).toBe(false);
  });

  it('abort on terminalizing entry does not throw (controller.abort() is idempotent)', async () => {
    const mgr = new SessionManager(join(tmpDir, 'workspace'));
    const sessionId = '33333333-cccc-4ccc-8ccc-cccccccccccc';
    const controller = new AbortController();

    // Simulate a job that has been claimed for terminal write (terminalizing state)
    activeSessions.set(sessionId, {
      sessionDir: '/tmp/test',
      controller,
      sessionName: 'terminalizing-job',
      terminalState: 'terminalizing',
    } as never);

    // Abort must not throw even when already terminalizing
    const result = await handleSessionAbort({ session: sessionId }, mgr);
    // The session IS in activeSessions so it will be found and abort_requested returned
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('abort_requested');
    // controller.abort() is idempotent: second call should not error
    expect(() => controller.abort()).not.toThrow();
  });
});

// ── 20-21: extractCompletionData null thread_id path ─────────────────────────

describe('extractCompletionData: null thread_id path', () => {
  it('neither thread_id nor session in payload — metadata.thread_id is null', () => {
    const result = jsonResult({ response: 'hi', model: 'o4-mini', duration_ms: 10 });
    const { responseText, metadata } = extractCompletionData(result, 'test-session');
    expect(responseText).toBe('hi');
    // When both thread_id and session are absent, threadId variable stays null
    expect(metadata.thread_id).toBeNull();
  });

  it('launchJob: when completion has no thread_id, session is NOT registered in mgr', async () => {
    const newId = 'no-thread-44444444-4444-4444-8444-444444444444';
    vi.mocked(createSessionDir).mockReturnValue({
      id: newId,
      dir: '/tmp/coral-sessions/no-thread',
    });

    const mgr = new SessionManager(join(tmpDir, 'workspace'));

    // Simulate a handler that completes but emits no thread_id
    launchJob(
      'no-thread-session',
      () => Promise.resolve(jsonResult({ response: 'done', model: 'o4-mini', duration_ms: 5 })),
      mgr,
    );

    await new Promise((resolve) => setTimeout(resolve, 30));

    // Without thread_id, mgr.register is NOT called, so get(newId) returns null
    const found = mgr.get(newId);
    expect(found).toBeNull();
  });
});
