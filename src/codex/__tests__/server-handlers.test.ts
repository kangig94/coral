import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  activeJobs,
  handleSessionCreate,
  handleSessionSend,
  handleSessionFork,
  handleSessionList,
  handleSessionAbort,
  handleWait,
  handleToolCall,
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

  activeJobs.clear();
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
  activeJobs.clear();
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
    activeJobs.set(sessionId, {
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
    activeJobs.set(runningId, {
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
