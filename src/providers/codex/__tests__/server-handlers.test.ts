import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexExecResult } from '../../../types.js';

vi.mock('../codex-executor.js', () => ({
  executeOneShot: vi.fn(),
  executeResume: vi.fn(),
  executeFork: vi.fn(),
}));

vi.mock('../cli-detection.js', () => ({
  detectCodexCli: vi.fn(),
}));

vi.mock('../../../runner/progress.js', () => ({
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
  appendProgressEvent: vi.fn(),
  formatElapsed: vi.fn(() => ''),
}));

vi.mock('../progress.js', () => ({
  extractProgressMessage: vi.fn(),
  appendProgressEvent: vi.fn(),
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
} from '../../../runner/progress.js';
import { SessionManager } from '../../../runner/session-manager.js';
import { activeSessions } from '../../../runner/job-manager.js';
import { jsonResult, type McpResult } from '../../../shared/mcp-utils.js';
import {
  extractCompletionData,
  launchJob,
  handleSessionCreate,
  handleSessionSend,
  handleSessionFork,
  handleCodexSessionList,
  handleCodexSessionAbort,
  handleCodexOp,
  handleCodexCoralOp,
  codexTool,
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

beforeEach(() => {
  tmpDir = mkdtempSync(join('/tmp', 'coral-codex-handlers-test-'));
  mkdirSync(join(tmpDir, 'workspace'), { recursive: true });
  mgr = new SessionManager(join(tmpDir, 'workspace'));

  activeSessions.clear();
  vi.mocked(createSessionDir).mockReturnValue({
    id: '12345678-1234-4234-8234-123456789abc',
    dir: '/tmp/coral-sessions/12345678-1234-4234-8234-123456789abc',
  });
  vi.mocked(detectCodexCli).mockResolvedValue({ available: true, version: 'codex 1.0.0', authState: 'authenticated' });
  vi.mocked(executeOneShot).mockResolvedValue(makeExecResult());
  vi.mocked(executeResume).mockResolvedValue(makeExecResult());
  vi.mocked(executeFork).mockResolvedValue(makeExecResult({ sessionId: 'thread-fork-1' }));
});

afterEach(() => {
  activeSessions.clear();
  vi.clearAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('extractCompletionData', () => {
  it('uses thread_id as canonical metadata field', () => {
    const result = jsonResult({ response: 'hi', thread_id: 'thread-1', model: 'o4-mini', duration_ms: 10 });
    const { responseText, metadata } = extractCompletionData(result, 's1');
    expect(responseText).toBe('hi');
    expect(metadata).toMatchObject({ thread_id: 'thread-1' });
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
  });

  it('handleSessionSend resumes using stored threadId', async () => {
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

  it('forked_from uses source coral UUID', async () => {
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

  it('handleCodexSessionAbort aborts by single UUID session', () => {
    const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const controller = new AbortController();
    activeSessions.set(sessionId, {
      provider: 'codex',
      sessionDir: '/tmp/x',
      controller,
      sessionName: 'abort-me',
      terminalState: 'running',
    } as never);

    const result = handleCodexSessionAbort({ session: sessionId });
    const data = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(false);
    expect(data.status).toBe('abort_requested');
    expect(controller.signal.aborted).toBe(true);
  });
});

describe('handleCodexOp routing', () => {
  it('exec resume with UUID succeeds', async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    mgr.register(sessionId, 'session-1', 'thread-1', 'o4-mini', '/workspace');

    const result = await handleCodexOp({ op: 'exec', session: sessionId, prompt: 'hi' }, mgr);
    expect(result.isError).toBe(false);
    expect(executeResume).toHaveBeenCalled();
  });

  it('coral:* op returns unknown_op in codex adapter', async () => {
    const result = await handleCodexOp({ op: 'coral:scanner', prompt: 'scan' }, mgr);
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('"error": "unknown_op"');
  });
});

describe('handleCodexCoralOp', () => {
  it('op description provides a concrete coral: example', () => {
    const opProp = codexTool.inputSchema.properties.op as { description?: string };
    expect(opProp.description).toMatch(/coral:[a-z]/);
  });

  it('session not in mgr returns error before CLI preflight', async () => {
    vi.mocked(detectCodexCli).mockResolvedValue({ available: false, error: 'CLI not installed' });

    const result = await handleCodexCoralOp(
      'scanner',
      '# Scanner\n',
      { op: 'coral:scanner', session: 'nonexistent-session', prompt: 'hi' },
      mgr,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nonexistent-session');
    expect(detectCodexCli).not.toHaveBeenCalled();
  });

  it('explicit name field overrides generated agentName-timestamp label', async () => {
    const result = await handleCodexCoralOp(
      'scanner',
      '# Scanner\n',
      { op: 'coral:scanner', prompt: 'scan this', name: 'my-custom-session' },
      mgr,
    );
    const data = JSON.parse(result.content[0].text) as { session_name: string };
    expect(result.isError).toBe(false);
    expect(data.session_name).toBe('my-custom-session');
  });

  it('without explicit name, session_name follows agentName-timestamp pattern', async () => {
    const before = Date.now();
    const result = await handleCodexCoralOp(
      'scanner',
      '# Scanner\n',
      { op: 'coral:scanner', prompt: 'scan this' },
      mgr,
    );
    const after = Date.now();

    const data = JSON.parse(result.content[0].text) as { session_name: string };
    expect(result.isError).toBe(false);
    expect(data.session_name).toMatch(/^scanner-\d+$/);
    const ts = parseInt(data.session_name.replace('scanner-', ''), 10);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('create path prepends coral content and forces bypass=true', async () => {
    await handleCodexCoralOp(
      'scanner',
      '# Scanner Agent\n',
      { op: 'coral:scanner', prompt: 'scan this', bypass: false },
      mgr,
    );
    await sleep(30);

    const calledPrompt = vi.mocked(executeOneShot).mock.calls[0]?.[0];
    const bypassArg = vi.mocked(executeOneShot).mock.calls[0]?.[4];
    expect(calledPrompt).toContain('# Scanner Agent');
    expect(calledPrompt).toContain('\n\n---\n\nscan this');
    expect(bypassArg).toBe(true);
  });

  it('resume path dispatches via executeResume with session cwd fallback and bypass=true', async () => {
    const sessionId = '22222222-2222-4222-8222-222222222222';
    mgr.register(sessionId, 'resume-session', 'thread-resume-002', 'o4-mini', '/project/root');

    const result = await handleCodexCoralOp(
      'scanner',
      '# Scanner Agent\n',
      { op: 'coral:scanner', session: sessionId, prompt: 'analyze again', bypass: false },
      mgr,
    );
    expect(result.isError).toBe(false);
    await sleep(30);

    expect(executeResume).toHaveBeenCalledTimes(1);
    const calledPrompt = vi.mocked(executeResume).mock.calls[0]?.[1];
    const calledCwd = vi.mocked(executeResume).mock.calls[0]?.[3];
    const bypassArg = vi.mocked(executeResume).mock.calls[0]?.[5];
    expect(calledPrompt).toContain('# Scanner Agent');
    expect(calledPrompt).toContain('\n\n---\n\nanalyze again');
    expect(calledCwd).toBe('/project/root');
    expect(bypassArg).toBe(true);
  });

  it('schema validation failures occur before execution', async () => {
    await expect(handleCodexCoralOp(
      'scanner',
      '# Scanner Agent\n',
      { op: 'coral:scanner', prompt: '' },
      mgr,
    )).rejects.toThrow();

    await expect(handleCodexCoralOp(
      'scanner',
      '# Scanner Agent\n',
      { op: 'coral:scanner' },
      mgr,
    )).rejects.toThrow();

    await expect(handleCodexCoralOp(
      'scanner',
      '# Scanner Agent\n',
      { op: 'coral:scanner', prompt: 'go', reasoning_effort: 'ultra-high' },
      mgr,
    )).rejects.toThrow();
  });
});

describe('launchJob', () => {
  it('launchJob writes errors through writeSessionError', async () => {
    launchJob(
      'failing-session',
      () => Promise.reject(new Error('boom')),
      mgr,
    );
    await sleep(20);
    expect(writeSessionError).toHaveBeenCalled();
  });

  it('launchJob return shape preserves MCP contract', () => {
    const mgrMock = { register: vi.fn() } as unknown as SessionManager;
    const launched = launchJob(
      'shape-check',
      async (): Promise<McpResult> => jsonResult({ ok: true, thread_id: 'thread-shape', model: 'o4-mini' }),
      mgrMock,
      '/tmp/work',
    );

    expect(launched).toEqual({
      content: [{ type: 'text', text: expect.any(String) }],
      isError: false,
    });
  });
});
