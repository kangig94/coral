import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexExecResult } from '../../types.js';

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

import {
  executeOneShot,
  executeResume,
  executeFork,
} from '../codex-executor.js';
import { detectCodexCli } from '../cli-detection.js';
import {
  createSessionDir,
  writeSessionError,
  readSessionStatus,
  resolveSessionDir,
  SESSIONS_DIR,
} from '../progress.js';
import { SessionManager } from '../session-manager.js';
import { jsonResult, type McpResult } from '../../shared/mcp-utils.js';
import {
  extractCompletionData,
  launchJob,
  activeSessions,
  handleSessionCreate,
  handleSessionSend,
  handleSessionFork,
  handleSessionList,
  handleSessionAbort,
  handleWait,
  handleToolCall,
  tools,
  _test as handlerTest,
} from '../server-handlers.js';

function makeExecResult(overrides: Partial<CodexExecResult> = {}): CodexExecResult {
  return {
    response: 'test response',
    sessionId: 'thread-123',
    model: 'o4-mini',
    durationMs: 500,
    exitCode: 0,
    errors: [],
    warnings: [],
    aborted: false,
    ...overrides,
  };
}

let tmpDir = '';
let mgr: SessionManager;
const dirsToClean = new Set<string>();
const defaultPluginRoot = process.cwd();

beforeEach(() => {
  tmpDir = mkdtempSync(join('/tmp', 'coral-handlers-test-'));
  mkdirSync(join(tmpDir, 'workspace'), { recursive: true });
  mkdirSync(join(tmpDir, 'agents'), { recursive: true });
  writeFileSync(join(tmpDir, 'agents', 'scanner.md'), '# Scanner Agent\n');
  handlerTest.setPluginRoot(tmpDir);
  mgr = new SessionManager(join(tmpDir, 'workspace'));

  activeSessions.clear();
  vi.mocked(createSessionDir).mockReturnValue({
    id: '12345678-1234-4234-8234-123456789abc',
    dir: '/tmp/coral-sessions/12345678-1234-4234-8234-123456789abc',
  });
  vi.mocked(detectCodexCli).mockResolvedValue({ available: true, version: 'codex 1.0.0', authState: 'authenticated' });
  vi.mocked(readSessionStatus).mockReturnValue({ status: 'running' });
  vi.mocked(resolveSessionDir).mockImplementation((id: string) => join(SESSIONS_DIR as string, id));
  vi.mocked(executeOneShot).mockResolvedValue(makeExecResult());
  vi.mocked(executeResume).mockResolvedValue(makeExecResult());
  vi.mocked(executeFork).mockResolvedValue(makeExecResult({ sessionId: 'thread-fork-1' }));
});

afterEach(() => {
  activeSessions.clear();
  vi.clearAllMocks();
  for (const dir of dirsToClean) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirsToClean.clear();
  handlerTest.setPluginRoot(defaultPluginRoot);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('extractCompletionData', () => {
  it('uses thread_id as canonical metadata field', () => {
    const result = jsonResult({ response: 'hi', thread_id: 'thread-1', model: 'o4-mini', duration_ms: 10 });
    const { responseText, metadata } = extractCompletionData(result, 's1');
    expect(responseText).toBe('hi');
    expect(metadata).toMatchObject({ thread_id: 'thread-1', session_name: 's1' });
  });

  it('falls back to legacy session field and warns', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const result = jsonResult({ response: 'hi', session: 'thread-old', model: 'o4-mini', duration_ms: 10 });
    const { metadata } = extractCompletionData(result, 's1');
    expect(metadata.thread_id).toBe('thread-old');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("legacy 'session' field"));
  });
});

describe('session handlers', () => {
  it('handleSessionCreate emits thread_id in completion payload', async () => {
    const result = await handleSessionCreate({ prompt: 'hi', name: 'my-session', bypass: false }, mgr, new AbortController().signal);
    const data = JSON.parse(result.content[0].text);
    expect(data.thread_id).toBe('thread-123');
    expect(data.session).toBeUndefined();
  });

  it('handleSessionSend resumes using stored threadId and updates by UUID', async () => {
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    mgr.register(sessionId, 'test-session', 'thread-001', 'o4-mini', '/workspace');

    const result = await handleSessionSend(
      { session: sessionId, prompt: 'follow up', bypass: false },
      mgr,
      new AbortController().signal,
    );

    expect(result.isError).toBe(false);
    expect(executeResume).toHaveBeenCalledWith(
      'thread-001',
      'follow up',
      undefined,
      '/workspace',
      undefined,
      false,
      undefined,
      expect.anything(),
      undefined,
    );
  });

  it('forked_from uses source coral UUID (not thread_id)', async () => {
    const sourceSessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    mgr.register(sourceSessionId, 'base-session', 'thread-base', 'o4-mini', '/workspace');

    const result = await handleSessionFork(
      { session: sourceSessionId, name: 'forked', bypass: false },
      mgr,
      new AbortController().signal,
    );
    const data = JSON.parse(result.content[0].text);
    expect(data.forked_from).toBe(sourceSessionId);
    expect(data.thread_id).toBe('thread-fork-1');
  });

  it('handleSessionAbort aborts by single UUID session', async () => {
    const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const controller = new AbortController();
    activeSessions.set(sessionId, {
      sessionDir: '/tmp/x',
      controller,
      sessionName: 'abort-me',
      terminalState: 'running',
    } as never);

    const result = await handleSessionAbort({ session: sessionId }, mgr);
    const data = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(false);
    expect(data.status).toBe('abort_requested');
    expect(data.session).toBe(sessionId);
    expect(controller.signal.aborted).toBe(true);
    expect(data.thread_id).toBeUndefined();
    expect(data.job_id).toBeUndefined();
  });

  it('handleWait uses sessions/completed_session/running_sessions/session_dir fields', async () => {
    const sessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const dir = join(SESSIONS_DIR as string, sessionId);
    mkdirSync(dir, { recursive: true });
    dirsToClean.add(dir);
    vi.mocked(readSessionStatus).mockReturnValue({ status: 'completed', session_name: 'wait-session' });

    const result = await handleWait({ op: 'wait', sessions: [sessionId] });
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('completed');
    expect(data.completed_session).toBe(sessionId);
    expect(data.session_dir).toBe(dir);
    expect(data.completed_job_id).toBeUndefined();
    expect(data.job_dir).toBeUndefined();
  });
});

describe('tool routing and UUID semantics', () => {
  it('exec resume with UUID succeeds', async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    mgr.register(sessionId, 'session-1', 'thread-1', 'o4-mini', '/workspace');

    const result = await handleToolCall('codex', { op: 'exec', session: sessionId, prompt: 'hi' }, mgr);
    expect(result.isError).toBe(false);
    expect(executeResume).toHaveBeenCalled();
  });

  it('exec resume with non-UUID name fails as session-not-found (not schema error)', async () => {
    const result = await handleToolCall('codex', { op: 'exec', session: 'named-session', prompt: 'hi' }, mgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Session not found: "named-session"');
  });

  it('fork with non-UUID session fails as session-not-found', async () => {
    const result = await handleToolCall('codex', { op: 'fork', session: 'named-session' }, mgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Session not found: "named-session"');
  });

  it('coral:scanner with non-UUID session fails as session-not-found', async () => {
    const result = await handleToolCall('codex', { op: 'coral:scanner', session: 'named-session', prompt: 'scan' }, mgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Session not found: "named-session"');
  });

  it('MCP tool response never exposes thread_id field', async () => {
    const result = await handleToolCall('codex', { op: 'exec', prompt: 'hello' }, mgr);
    const data = JSON.parse(result.content[0].text);
    expect(data.thread_id).toBeUndefined();
    expect(data.session).toBeDefined();
    expect(data.session_dir).toBeDefined();
  });

  it('unnamed fork registers and is resumable', async () => {
    const sourceSession = '22222222-2222-4222-8222-222222222222';
    mgr.register(sourceSession, 'base', 'thread-base', 'o4-mini', '/workspace');

    const forkResult = await handleToolCall('codex', { op: 'fork', session: sourceSession }, mgr);
    const forkData = JSON.parse(forkResult.content[0].text) as { session: string };
    await new Promise((resolve) => setTimeout(resolve, 20));

    const forkedEntry = mgr.get(forkData.session);
    expect(forkedEntry).not.toBeNull();
    expect(forkedEntry?.threadId).toBe('thread-fork-1');

    vi.mocked(executeResume).mockClear();
    const resumeResult = await handleToolCall('codex', { op: 'exec', session: forkData.session, prompt: 'continue' }, mgr);
    expect(resumeResult.isError).toBe(false);
    expect(executeResume).toHaveBeenCalledWith(
      'thread-fork-1',
      'continue',
      undefined,
      expect.any(String),
      undefined,
      false,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('early abort works immediately after launch', async () => {
    const pending = new Promise<McpResult>(() => {});
    const launchResult = launchJob('early-abort', () => pending, mgr);
    const launchData = JSON.parse(launchResult.content[0].text) as { session: string };

    const abortResult = await handleSessionAbort({ session: launchData.session }, mgr);
    const abortData = JSON.parse(abortResult.content[0].text);
    expect(abortResult.isError).toBe(false);
    expect(abortData.status).toBe('abort_requested');
  });

  it('list with duplicate names marks running by UUID key', () => {
    const runningId = '33333333-3333-4333-8333-333333333333';
    const completedId = '44444444-4444-4444-8444-444444444444';
    mgr.register(runningId, 'same-name', 'thread-running', 'o4-mini', '/workspace');
    mgr.register(completedId, 'same-name', 'thread-completed', 'o4-mini', '/workspace');
    activeSessions.set(runningId, {
      sessionDir: '/tmp/running',
      controller: new AbortController(),
      sessionName: 'same-name',
      terminalState: 'running',
    } as never);

    const listResult = handleSessionList(mgr);
    const data = JSON.parse(listResult.content[0].text) as { sessions: Array<{ session: string; status: string }> };
    const running = data.sessions.find((s) => s.session === runningId);
    const completed = data.sessions.find((s) => s.session === completedId);

    expect(running?.status).toBe('running');
    expect(completed?.status).toBe('completed');
  });

  it('launchJob writes errors through writeSessionError', async () => {
    launchJob(
      'failing-session',
      () => Promise.reject(new Error('boom')),
      mgr,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writeSessionError).toHaveBeenCalled();
  });
});

// ── Merged from red-session-naming: API response field contracts ──────────────

describe('API response: thread_id leakage and field presence', () => {
  it('list response does not expose thread_id (internal field)', () => {
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    mgr.register(sessionId, 'my-session', 'thread-internal-001', 'o4-mini', '/workspace');

    const result = handleSessionList(mgr);
    const data = JSON.parse(result.content[0].text) as { sessions: Array<Record<string, unknown>> };
    expect(data.sessions).toHaveLength(1);

    const entry = data.sessions[0];
    expect(entry).not.toHaveProperty('thread_id');
    expect(entry).not.toHaveProperty('threadId');
    expect(entry).toHaveProperty('session', sessionId);
  });

  it('wait timeout response uses running_sessions (not running_jobs)', async () => {
    const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    vi.mocked(readSessionStatus).mockReturnValue({ status: 'running' });

    const { createSessionDir: realCreate } =
      await vi.importActual<typeof import('../progress.js')>('../progress.js');
    const { dir } = realCreate(`timeout-test-${sessionId}`);

    try {
      vi.mocked(resolveSessionDir).mockImplementation((id) =>
        id === sessionId ? dir : `/tmp/coral-sessions/${id}`,
      );

      const result = await handleWait({ op: 'wait', sessions: [sessionId], timeout_seconds: 1 });
      const data = JSON.parse(result.content[0].text);

      expect(data.status).toBe('timeout');
      expect(data.running_sessions).toBeDefined();
      expect(Array.isArray(data.running_sessions)).toBe(true);
      expect(data.running_jobs).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 3000);
});

// ── Merged from red-session-naming: handleWait behavioral gaps ────────────────

describe('handleWait: behavioral gaps', () => {
  it('wait for non-existent session dir returns error', async () => {
    const sessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    vi.mocked(resolveSessionDir).mockReturnValue('/tmp/coral-sessions/does-not-exist-dir');

    const result = await handleWait({ op: 'wait', sessions: [sessionId] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(sessionId);
  });

  it('cursor for completed_session is excluded from returned cursors', async () => {
    const sessionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const { createSessionDir: realCreate, writeSessionResult: realWrite, readSessionStatus: realRead } =
      await vi.importActual<typeof import('../progress.js')>('../progress.js');
    const { dir } = realCreate('cursor-test');

    try {
      realWrite(dir, 'done', { session_name: 'cursor-test' });
      vi.mocked(resolveSessionDir).mockImplementation((id) =>
        id === sessionId ? dir : `/tmp/coral-sessions/${id}`,
      );
      vi.mocked(readSessionStatus).mockImplementation((d) =>
        d === dir ? realRead(d) : { status: 'running' },
      );

      const result = await handleWait({
        op: 'wait',
        sessions: [sessionId],
        cursors: { [sessionId]: 0 },
      });
      const data = JSON.parse(result.content[0].text);

      expect(data.status).toBe('completed');
      expect(data.completed_session).toBe(sessionId);
      expect(data.cursors?.[sessionId]).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cursor for non-completed session preserved when another completes', async () => {
    const completedId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const runningId = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const { createSessionDir: realCreate, writeSessionResult: realWrite } =
      await vi.importActual<typeof import('../progress.js')>('../progress.js');
    const { dir: completedDir } = realCreate('two-session-completed');
    const { dir: runningDir } = realCreate('two-session-running');

    try {
      realWrite(completedDir, 'done', { session_name: 'completed-sess' });
      vi.mocked(resolveSessionDir).mockImplementation((id) => {
        if (id === completedId) return completedDir;
        if (id === runningId) return runningDir;
        return `/tmp/coral-sessions/${id}`;
      });
      vi.mocked(readSessionStatus).mockImplementation((d) =>
        d === completedDir ? { status: 'completed' } : { status: 'running' },
      );

      const result = await handleWait({
        op: 'wait',
        sessions: [completedId, runningId],
        cursors: { [completedId]: 0, [runningId]: 42 },
      });
      const data = JSON.parse(result.content[0].text);

      expect(data.completed_session).toBe(completedId);
      expect(data.cursors?.[runningId]).toBe(42);
      expect(data.cursors?.[completedId]).toBeUndefined();
    } finally {
      rmSync(completedDir, { recursive: true, force: true });
      rmSync(runningDir, { recursive: true, force: true });
    }
  });
});

// ── Merged from red-session-naming: activeSessions lifecycle ──────────────────

describe('activeSessions lifecycle', () => {
  it('entry is removed after successful completion', async () => {
    vi.mocked(createSessionDir).mockReturnValue({
      id: 'lifecycle-ok-11111111-1111-4111-8111-111111111111',
      dir: '/tmp/coral-sessions/lifecycle-ok',
    });

    let resolveHandler!: (r: McpResult) => void;
    const pending = new Promise<McpResult>((resolve) => { resolveHandler = resolve; });

    launchJob('cleanup-test', () => pending, mgr);
    const jobId = 'lifecycle-ok-11111111-1111-4111-8111-111111111111';
    expect(activeSessions.has(jobId)).toBe(true);

    resolveHandler(jsonResult({ response: 'done', thread_id: 'thread-lifecycle', model: 'o4-mini', duration_ms: 10 }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(activeSessions.has(jobId)).toBe(false);
  });

  it('entry is removed after error', async () => {
    vi.mocked(createSessionDir).mockReturnValue({
      id: 'lifecycle-err-22222222-2222-4222-8222-222222222222',
      dir: '/tmp/coral-sessions/lifecycle-err',
    });

    let rejectHandler!: (e: Error) => void;
    const failing = new Promise<McpResult>((_, reject) => { rejectHandler = reject; });

    launchJob('error-cleanup-test', () => failing, mgr);
    const jobId = 'lifecycle-err-22222222-2222-4222-8222-222222222222';
    expect(activeSessions.has(jobId)).toBe(true);

    rejectHandler(new Error('boom'));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(activeSessions.has(jobId)).toBe(false);
  });

  it('abort on terminalizing entry does not throw (controller.abort is idempotent)', async () => {
    const sessionId = '33333333-cccc-4ccc-8ccc-cccccccccccc';
    const controller = new AbortController();
    activeSessions.set(sessionId, {
      sessionDir: '/tmp/test',
      controller,
      sessionName: 'terminalizing-job',
      terminalState: 'terminalizing',
    } as never);

    const result = await handleSessionAbort({ session: sessionId }, mgr);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('abort_requested');
    expect(() => controller.abort()).not.toThrow();
  });
});

// ── Merged from red-session-naming: extractCompletionData edge cases ──────────

describe('extractCompletionData: null thread_id path', () => {
  it('neither thread_id nor session in payload — metadata.thread_id is null', () => {
    const result = jsonResult({ response: 'hi', model: 'o4-mini', duration_ms: 10 });
    const { responseText, metadata } = extractCompletionData(result, 'test-session');
    expect(responseText).toBe('hi');
    expect(metadata.thread_id).toBeNull();
  });

  it('when completion has no thread_id, session is NOT registered in mgr', async () => {
    const newId = 'no-thread-44444444-4444-4444-8444-444444444444';
    vi.mocked(createSessionDir).mockReturnValue({
      id: newId,
      dir: '/tmp/coral-sessions/no-thread',
    });

    launchJob(
      'no-thread-session',
      () => Promise.resolve(jsonResult({ response: 'done', model: 'o4-mini', duration_ms: 5 })),
      mgr,
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mgr.get(newId)).toBeNull();
  });
});

// ── Merged from red-coral-agent: resolveAgentPrompt ───────────────────────────

describe('resolveAgentPrompt: file content and return type', () => {
  it('returns file contents as-is including YAML frontmatter', async () => {
    const frontmatterContent = '---\ntitle: Test Agent\nmodel: o4-mini\n---\n\n# Test Agent\nYou are a test agent.\n';
    writeFileSync(join(tmpDir, 'agents', 'frontmatter-agent.md'), frontmatterContent);

    const result = await handleToolCall('codex', { op: 'coral:frontmatter-agent', prompt: 'go' }, mgr);
    expect(result.isError).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 30));

    const calledPrompt = vi.mocked(executeOneShot).mock.calls[0]?.[0];
    expect(calledPrompt).toContain('---\ntitle: Test Agent\nmodel: o4-mini\n---');
    expect(calledPrompt).toContain('\n\n---\n\ngo');
  });

  it('missing agent returns isError without Error: prefix doubling', async () => {
    const result = await handleToolCall('codex', { op: 'coral:does-not-exist-xyz', prompt: 'test' }, mgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Agent file not found: agents/does-not-exist-xyz.md');
    expect(result.content[0].text).not.toMatch(/^Error: Error:/);
  });
});

// ── Merged from red-coral-agent: session lookup ordering ──────────────────────

describe('handleCoralAgent: session lookup ordering', () => {
  it('session not in mgr returns error before CLI preflight', async () => {
    vi.mocked(detectCodexCli).mockResolvedValue({ available: false, error: 'CLI not installed' });

    const result = await handleToolCall(
      'codex',
      { op: 'coral:scanner', session: 'nonexistent-session', prompt: 'hi' },
      mgr,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nonexistent-session');
    expect(detectCodexCli).not.toHaveBeenCalled();
  });

  it('session found + CLI unauthenticated returns auth error', async () => {
    const sessionId = '12345678-1234-4234-8234-123456789abc';
    mgr.register(sessionId, 'test-session', 'thread-auth-test', 'o4-mini', '/workspace');
    vi.mocked(detectCodexCli).mockResolvedValue({
      available: true,
      version: 'codex 1.0.0',
      authState: 'unauthenticated',
      authError: 'Run codex login',
    });

    const result = await handleToolCall(
      'codex',
      { op: 'coral:scanner', session: sessionId, prompt: 'hi' },
      mgr,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Run codex login');
  });
});

// ── Merged from red-coral-agent: session name and prompt construction ─────────

describe('handleCoralAgent: session name and prompt construction', () => {
  it('explicit name field overrides generated agentName-timestamp label', async () => {
    const result = await handleToolCall(
      'codex',
      { op: 'coral:scanner', prompt: 'scan this', name: 'my-custom-session' },
      mgr,
    );
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.session_name).toBe('my-custom-session');
  });

  it('without explicit name, session_name follows agentName-timestamp pattern', async () => {
    const before = Date.now();
    const result = await handleToolCall('codex', { op: 'coral:scanner', prompt: 'scan this' }, mgr);
    const after = Date.now();

    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.session_name).toMatch(/^scanner-\d+$/);
    const ts = parseInt(data.session_name.replace('scanner-', ''), 10);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('agent file body containing --- does not confuse the separator', async () => {
    writeFileSync(join(tmpDir, 'agents', 'has-separator.md'), '# Agent\n---\nSection after divider\n');

    await handleToolCall('codex', { op: 'coral:has-separator', prompt: 'user prompt' }, mgr);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const calledPrompt = vi.mocked(executeOneShot).mock.calls[0]?.[0];
    expect(calledPrompt).toContain('# Agent\n---\nSection after divider\n\n\n---\n\nuser prompt');
  });
});

// ── Merged from red-coral-agent: coral:* session resume (AC7) ─────────────────

describe('coral:* with session field resumes existing session', () => {
  it('dispatches via executeResume not executeOneShot', async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    mgr.register(sessionId, 'existing-session', 'thread-resume-001', 'o4-mini', '/workspace');

    const result = await handleToolCall(
      'codex',
      { op: 'coral:scanner', session: sessionId, prompt: 'follow up' },
      mgr,
    );
    expect(result.isError).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(executeResume).toHaveBeenCalledTimes(1);
    expect(executeOneShot).not.toHaveBeenCalled();
  });

  it('augmented prompt is sent to executeResume with agent content prepended', async () => {
    const sessionId = '22222222-2222-4222-8222-222222222222';
    mgr.register(sessionId, 'resume-session', 'thread-resume-002', 'o4-mini', '/workspace');
    const agentContent = readFileSync(join(tmpDir, 'agents', 'scanner.md'), 'utf-8');

    await handleToolCall('codex', { op: 'coral:scanner', session: sessionId, prompt: 'analyze again' }, mgr);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const calledPrompt = vi.mocked(executeResume).mock.calls[0]?.[1];
    expect(calledPrompt).toContain(agentContent);
    expect(calledPrompt).toContain('\n\n---\n\nanalyze again');
  });

  it('working_directory falls back to session entry cwd', async () => {
    const sessionId = '33333333-3333-4333-8333-333333333333';
    mgr.register(sessionId, 'cwd-session', 'thread-cwd-001', 'o4-mini', '/project/root');

    await handleToolCall('codex', { op: 'coral:scanner', session: sessionId, prompt: 'scan' }, mgr);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const calledCwd = vi.mocked(executeResume).mock.calls[0]?.[3];
    expect(calledCwd).toBe('/project/root');
  });
});

// ── Merged from red-coral-agent: tool schema and Zod validation ───────────────

describe('coral:* tool schema and Zod validation routing', () => {
  it('op description provides a concrete coral: example', () => {
    const opProp = tools[0].inputSchema.properties.op as { description?: string };
    expect(opProp.description).toMatch(/coral:[a-z]/);
  });

  it('empty prompt string fails Zod validation (not agent file lookup)', async () => {
    const result = await handleToolCall('codex', { op: 'coral:scanner', prompt: '' }, mgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('Agent file not found');
  });

  it('invalid reasoning_effort value fails Zod validation', async () => {
    const result = await handleToolCall(
      'codex',
      { op: 'coral:scanner', prompt: 'go', reasoning_effort: 'ultra-high' } as unknown as Record<string, unknown>,
      mgr,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('Agent file not found');
  });

  it('missing prompt returns Zod error, never unknown_op', async () => {
    const result = await handleToolCall('codex', { op: 'coral:scanner' }, mgr);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).not.toContain('unknown_op');
  });

  it('non-existent agent returns file-not-found error (not path-traversal)', async () => {
    const result = await handleToolCall('codex', { op: 'coral:ghost-agent', prompt: 'test' }, mgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Agent file not found: agents/ghost-agent.md');
    expect(result.content[0].text).not.toContain('Invalid agent name');
  });
});
