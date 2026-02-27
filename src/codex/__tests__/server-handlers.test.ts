import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexExecResult } from '../../types.js';

vi.mock('../codex-executor.js', () => ({
  executeOneShot: vi.fn(),
  executeResume: vi.fn(),
  executeFork: vi.fn(),
  registerExecution: vi.fn(() => {
    const controller = { signal: undefined };
    return controller;
  }),
  unregisterExecution: vi.fn(),
  abortExecution: vi.fn(),
  isExecutionActive: vi.fn(() => false),
}));

vi.mock('../cli-detection.js', () => ({
  detectCodexCli: vi.fn(),
}));

vi.mock('../progress.js', () => ({
  createProgressFile: vi.fn(),
  removeProgressFile: vi.fn(),
  extractProgressId: vi.fn(),
  extractProgressMessage: vi.fn(),
  appendProgressEvent: vi.fn(),
  appendFinalResult: vi.fn(),
}));

let tmpDir = '';
vi.mock('node:os', () => ({
  homedir: () => tmpDir,
}));

import {
  executeOneShot,
  executeResume,
  executeFork,
  registerExecution,
  unregisterExecution,
  abortExecution,
  isExecutionActive,
} from '../codex-executor.js';
import { detectCodexCli } from '../cli-detection.js';
import {
  createProgressFile,
  extractProgressId,
  extractProgressMessage,
  appendProgressEvent,
  appendFinalResult,
} from '../progress.js';
import { SessionManager } from '../session-manager.js';
import { textResult, jsonResult, resultExtras } from '../../shared/mcp-utils.js';
import {
  extractCompletionData,
  sessionNotFoundError,
  makeEventCallback,
  handleSessionCreate,
  handleSessionSend,
  handleSessionList,
  handleSessionFork,
  handleSessionAbort,
  handleToolCall,
  tools,
  activeBackgroundFiles,
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

let mgr: SessionManager;

beforeEach(() => {
  tmpDir = mkdtempSync(join('/tmp', 'coral-handlers-test-'));
  mkdirSync(join(tmpDir, 'workspace'), { recursive: true });
  mgr = new SessionManager(join(tmpDir, 'workspace'));
  activeBackgroundFiles.clear();
  vi.mocked(detectCodexCli).mockResolvedValue({ available: true, version: 'codex 1.0.0', authState: 'authenticated' });
});

afterEach(() => {
  activeBackgroundFiles.clear();
  vi.clearAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── A. Pure utility functions ────────────────────────────────────────────────

describe('textResult', () => {
  it('wraps in MCP content format with isError false by default', () => {
    expect(textResult('hello')).toEqual({ content: [{ type: 'text', text: 'hello' }], isError: false });
  });

  it('sets isError true when specified', () => {
    expect(textResult('err', true).isError).toBe(true);
  });
});

describe('jsonResult', () => {
  it('stringifies data with 2-space indent', () => {
    const result = jsonResult({ foo: 'bar' });
    expect(result.content[0].text).toBe(JSON.stringify({ foo: 'bar' }, null, 2));
    expect(result.isError).toBe(false);
  });
});

describe('resultExtras', () => {
  it('returns empty object when exitCode=0, no errors, no warnings', () => {
    expect(resultExtras({ exitCode: 0, errors: [], warnings: [] })).toEqual({});
  });

  it('includes exit_code, errors, warnings when non-zero / present', () => {
    expect(resultExtras({ exitCode: 1, errors: ['e'], warnings: ['w'] })).toEqual({
      exit_code: 1, errors: ['e'], warnings: ['w'],
    });
  });

  it('omits exit_code when exitCode is null', () => {
    expect(resultExtras({ exitCode: null, errors: [], warnings: [] })).toEqual({});
  });

  it('includes aborted: true when aborted is true', () => {
    expect(resultExtras({ exitCode: null, errors: [], warnings: [], aborted: true })).toEqual({ aborted: true });
  });

  it('omits aborted when false or undefined', () => {
    expect(resultExtras({ exitCode: 0, errors: [], warnings: [], aborted: false })).toEqual({});
    expect(resultExtras({ exitCode: 0, errors: [], warnings: [] })).toEqual({});
  });
});

describe('sessionNotFoundError', () => {
  it('returns isError: true with session ref and recovery hint', () => {
    const result = sessionNotFoundError('my-session');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('my-session');
    expect(result.content[0].text).toContain('codex');
  });
});

// ─── B. extractCompletionData ─────────────────────────────────────────────────

describe('extractCompletionData', () => {
  it('extracts response, session, session_name, model, duration_ms', () => {
    const result = jsonResult({ response: 'hi', session: 't-1', model: 'o4-mini', duration_ms: 100 });
    expect(extractCompletionData(result, 'my-session')).toEqual({
      response: 'hi', session: 't-1', session_name: 'my-session', model: 'o4-mini', duration_ms: 100,
    });
  });

  it('includes notice field when present', () => {
    const result = jsonResult({ response: 'hi', session: null, model: 'o4-mini', duration_ms: 10, notice: 'No session' });
    expect(extractCompletionData(result, 'test').notice).toBe('No session');
  });

  it('omits notice field when absent', () => {
    const result = jsonResult({ response: 'hi', session: 't-1', model: 'o4-mini', duration_ms: 10 });
    expect(extractCompletionData(result, 'test')).not.toHaveProperty('notice');
  });

  it('forwards aborted and non_resumable when present', () => {
    const result = jsonResult({ response: '', session: null, model: 'o4-mini', duration_ms: 50, aborted: true, non_resumable: true });
    const data = extractCompletionData(result, 'test');
    expect(data.aborted).toBe(true);
    expect(data.non_resumable).toBe(true);
  });

  it('omits aborted and non_resumable when absent', () => {
    const result = jsonResult({ response: 'hi', session: 't-1', model: 'o4-mini', duration_ms: 10 });
    const data = extractCompletionData(result, 'test');
    expect(data).not.toHaveProperty('aborted');
    expect(data).not.toHaveProperty('non_resumable');
  });

  it('forwards exit_code, errors, warnings when present', () => {
    const result = jsonResult({ response: '', session: 't-1', model: 'o4-mini', duration_ms: 10, exit_code: 1, errors: ['e'], warnings: ['w'] });
    const data = extractCompletionData(result, 'test');
    expect(data.exit_code).toBe(1);
    expect(data.errors).toEqual(['e']);
    expect(data.warnings).toEqual(['w']);
  });
});

// ─── C. makeEventCallback ─────────────────────────────────────────────────────

describe('makeEventCallback', () => {
  beforeEach(() => {
    vi.mocked(extractProgressMessage).mockReturnValue('Processing...');
  });

  it('writes to progress file for valid JSON events with a message', () => {
    const cb = makeEventCallback({ progressFile: '/tmp/test.jsonl' });
    cb(JSON.stringify({ type: 'turn.started' }));
    expect(appendProgressEvent).toHaveBeenCalledWith('/tmp/test.jsonl', 'turn.started', 'Processing...');
  });

  it('calls notify with [Codex] prefix and incrementing counter when progressToken provided', () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const cb = makeEventCallback({ progressFile: '/tmp/test.jsonl', progressToken: 'pt-1', notify });
    cb(JSON.stringify({ type: 'turn.started' }));
    expect(notify).toHaveBeenCalledWith({
      method: 'notifications/progress',
      params: { progressToken: 'pt-1', progress: 1, message: '[Codex] Processing...' },
    });
  });

  it('does not call notify when no progressToken', () => {
    const notify = vi.fn();
    const cb = makeEventCallback({ progressFile: '/tmp/test.jsonl', notify });
    cb(JSON.stringify({ type: 'turn.started' }));
    expect(notify).not.toHaveBeenCalled();
  });

  it('silently ignores non-JSON lines', () => {
    const cb = makeEventCallback({ progressFile: '/tmp/test.jsonl' });
    expect(() => cb('not json at all')).not.toThrow();
    expect(appendProgressEvent).not.toHaveBeenCalled();
  });

  it('does not append when extractProgressMessage returns null', () => {
    vi.mocked(extractProgressMessage).mockReturnValueOnce(null);
    const cb = makeEventCallback({ progressFile: '/tmp/test.jsonl' });
    cb(JSON.stringify({ type: 'item.updated' }));
    expect(appendProgressEvent).not.toHaveBeenCalled();
  });
});

// ─── D. handleSessionCreate ───────────────────────────────────────────────────

describe('handleSessionCreate', () => {
  it('success with sessionId → registers session and returns response + session_name', async () => {
    vi.mocked(executeOneShot).mockResolvedValue(makeExecResult());
    const result = await handleSessionCreate({ prompt: 'hi', name: 'my-session', background: false, bypass: false }, mgr);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.response).toBe('test response');
    expect(data.session).toBe('thread-123');
    expect(data.session_name).toBe('my-session');
    expect(mgr.get('my-session')).not.toBeNull();
    const controller = vi.mocked(registerExecution).mock.results[0]?.value;
    expect(controller).toBeDefined();
    expect(unregisterExecution).toHaveBeenCalledWith('my-session', controller);
  });

  it('success without sessionId → returns notice and does NOT register', async () => {
    vi.mocked(executeOneShot).mockResolvedValue(makeExecResult({ sessionId: null }));
    const result = await handleSessionCreate({ prompt: 'hi', name: 'no-thread', background: false, bypass: false }, mgr);
    const data = JSON.parse(result.content[0].text);
    expect(data.notice).toContain('No session ID');
    expect(mgr.get('no-thread')).toBeNull();
  });

  it('includes errors and warnings in response via resultExtras', async () => {
    vi.mocked(executeOneShot).mockResolvedValue(makeExecResult({ exitCode: 1, errors: ['err'], warnings: ['warn'] }));
    const result = await handleSessionCreate({ prompt: 'hi', name: 'test', background: false, bypass: false }, mgr);
    const data = JSON.parse(result.content[0].text);
    expect(data.exit_code).toBe(1);
    expect(data.errors).toEqual(['err']);
    expect(data.warnings).toEqual(['warn']);
  });

  it('uses the provided name (dispatcher owns generation)', async () => {
    vi.mocked(executeOneShot).mockResolvedValue(makeExecResult());
    const result = await handleSessionCreate({ prompt: 'hi', name: 'explicit-name', background: false, bypass: false }, mgr);
    const data = JSON.parse(result.content[0].text);
    expect(data.session_name).toBe('explicit-name');
  });

  it('execute rejection still unregisters the same controller in finally', async () => {
    vi.mocked(executeOneShot).mockRejectedValue(new Error('boom'));
    await expect(handleSessionCreate({ prompt: 'hi', name: 'failing-session', background: false, bypass: false }, mgr)).rejects.toThrow('boom');
    const controller = vi.mocked(registerExecution).mock.results[0]?.value;
    expect(controller).toBeDefined();
    expect(unregisterExecution).toHaveBeenCalledWith('failing-session', controller);
  });
});

// ─── E. handleSessionSend ─────────────────────────────────────────────────────

describe('handleSessionSend', () => {
  beforeEach(() => {
    mgr.register('test-session', 'thread-001', 'o4-mini', '/workspace');
  });

  it('success → returns response and calls updateSession', async () => {
    vi.mocked(executeResume).mockResolvedValue(makeExecResult({ sessionId: 'thread-001' }));
    const result = await handleSessionSend({ session: 'test-session', prompt: 'follow up', background: false, bypass: false }, mgr);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.response).toBe('test response');
    expect(data.session_name).toBe('test-session');
    const controller = vi.mocked(registerExecution).mock.results[0]?.value;
    expect(controller).toBeDefined();
    expect(unregisterExecution).toHaveBeenCalledWith('test-session', controller);
  });

  it('session not found → isError: true (internal handler guard)', async () => {
    const result = await handleSessionSend({ session: 'nonexistent', prompt: 'hi', background: false, bypass: false }, mgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nonexistent');
  });

  it('passes entry sessionId and workingDirectory to executeResume', async () => {
    vi.mocked(executeResume).mockResolvedValue(makeExecResult());
    await handleSessionSend({ session: 'test-session', prompt: 'hi', background: false, bypass: false }, mgr);
    expect(executeResume).toHaveBeenCalledWith('thread-001', 'hi', undefined, '/workspace', undefined, false, undefined, undefined, undefined);
  });

  it('threads bypass=true to executeResume', async () => {
    vi.mocked(executeResume).mockResolvedValue(makeExecResult());
    await handleSessionSend({ session: 'test-session', prompt: 'hi', background: false, bypass: true }, mgr);
    expect(executeResume).toHaveBeenCalledWith('thread-001', 'hi', undefined, '/workspace', undefined, true, undefined, undefined, undefined);
  });
});

// ─── F. handleSessionList ─────────────────────────────────────────────────────

describe('handleSessionList', () => {
  it('empty → { sessions: [], total: 0 }', async () => {
    const result = await handleSessionList(mgr);
    const data = JSON.parse(result.content[0].text);
    expect(data.sessions).toEqual([]);
    expect(data.total).toBe(0);
  });

  it('with sessions → maps all fields correctly', async () => {
    mgr.register('session-1', 'thread-1', 'o4-mini', '/workspace');
    const result = await handleSessionList(mgr);
    const data = JSON.parse(result.content[0].text);
    expect(data.total).toBe(1);
    expect(data.sessions[0]).toMatchObject({
      name: 'session-1',
      session: 'thread-1',
      model: 'o4-mini',
      working_directory: '/workspace',
    });
  });

  it('should return status=completed when not executing', async () => {
    vi.mocked(isExecutionActive).mockReturnValue(false);
    mgr.register('idle-session', 'thread-1', 'o4-mini', '/workspace');
    const result = await handleSessionList(mgr);
    const data = JSON.parse(result.content[0].text);
    expect(data.sessions[0].status).toBe('completed');
  });

  it('should return status=running when actively executing', async () => {
    vi.mocked(isExecutionActive).mockReturnValue(true);
    mgr.register('active-session', 'thread-1', 'o4-mini', '/workspace');
    const result = await handleSessionList(mgr);
    const data = JSON.parse(result.content[0].text);
    expect(data.sessions[0].status).toBe('running');
    vi.mocked(isExecutionActive).mockReturnValue(false); // restore default
  });
});

// ─── G. handleSessionFork ─────────────────────────────────────────────────────

describe('handleSessionFork', () => {
  beforeEach(() => {
    mgr.register('base-session', 'thread-base', 'o4-mini', '/workspace');
  });

  it('success with name + sessionId → registers new session, includes forked_from', async () => {
    vi.mocked(executeFork).mockResolvedValue(makeExecResult({ sessionId: 'thread-fork' }));
    const result = await handleSessionFork({ session: 'base-session', name: 'forked', background: false, bypass: false }, mgr);
    const data = JSON.parse(result.content[0].text);
    expect(data.forked_from).toBe('thread-base');
    expect(data.session_name).toBe('forked');
    expect(mgr.get('forked')).not.toBeNull();
    const controller = vi.mocked(registerExecution).mock.results[0]?.value;
    expect(controller).toBeDefined();
    expect(unregisterExecution).toHaveBeenCalledWith('forked', controller);
  });

  it('success without name → does not register, no session_name in response', async () => {
    vi.mocked(executeFork).mockResolvedValue(makeExecResult({ sessionId: 'thread-fork' }));
    const result = await handleSessionFork({ session: 'base-session', background: false, bypass: false }, mgr);
    const data = JSON.parse(result.content[0].text);
    expect(data.session_name).toBeUndefined();
    expect(mgr.get('thread-fork')).toBeNull();
  });

  it('success with name but no sessionId → does not register', async () => {
    vi.mocked(executeFork).mockResolvedValue(makeExecResult({ sessionId: null }));
    const result = await handleSessionFork({ session: 'base-session', name: 'forked', background: false, bypass: false }, mgr);
    expect(result.isError).toBe(false);
    expect(mgr.get('forked')).toBeNull();
  });

  it('session not found → isError: true (internal handler guard)', async () => {
    const result = await handleSessionFork({ session: 'nonexistent', background: false, bypass: false }, mgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nonexistent');
  });

  it('uses entry workingDirectory when input omits it', async () => {
    vi.mocked(executeFork).mockResolvedValue(makeExecResult());
    await handleSessionFork({ session: 'base-session', background: false, bypass: false }, mgr);
    expect(executeFork).toHaveBeenCalledWith('thread-base', undefined, undefined, '/workspace', undefined, false, undefined, undefined, undefined);
  });

  it('foreground with non-existent session → isError via handler (not dispatcher)', async () => {
    const result = await handleSessionFork({ session: 'ghost', background: false, bypass: false }, mgr);
    expect(result.isError).toBe(true);
    expect(executeFork).not.toHaveBeenCalled();
  });
});

// ─── H. handleSessionAbort ───────────────────────────────────────────────────

describe('handleSessionAbort', () => {
  beforeEach(() => {
    mgr.register('active-session', 'thread-999', 'o4-mini', '/workspace');
  });

  it('returns abort_requested when execution is active', async () => {
    vi.mocked(abortExecution).mockReturnValue(true);
    const result = await handleSessionAbort({ session: 'active-session' }, mgr);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('abort_requested');
    expect(data.session_name).toBe('active-session');
  });

  it('returns isError when no active execution found', async () => {
    vi.mocked(abortExecution).mockReturnValue(false);
    const result = await handleSessionAbort({ session: 'active-session' }, mgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No active execution found');
  });

  it('resolves by canonical name when session exists', async () => {
    vi.mocked(abortExecution).mockReturnValue(true);
    await handleSessionAbort({ session: 'active-session' }, mgr);
    expect(abortExecution).toHaveBeenCalledWith('active-session');
  });

  it('falls back to raw ref when session not registered', async () => {
    vi.mocked(abortExecution).mockReturnValue(true);
    await handleSessionAbort({ session: 'unregistered-name' }, mgr);
    // session not in mgr → falls back to input.session as the key
    expect(abortExecution).toHaveBeenCalledWith('unregistered-name');
  });
});

// ─── I. handleToolCall dispatch + validation ──────────────────────────────────

describe('handleToolCall', () => {
  beforeEach(() => {
    vi.mocked(executeOneShot).mockResolvedValue(makeExecResult());
    vi.mocked(executeResume).mockResolvedValue(makeExecResult());
    vi.mocked(executeFork).mockResolvedValue(makeExecResult());
    vi.mocked(createProgressFile).mockReturnValue('/tmp/progress.jsonl');
    vi.mocked(extractProgressId).mockReturnValue('uuid-123');
  });

  it('registers exactly one codex tool', () => {
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('codex');
  });

  it('routes codex exec(no session) to handleSessionCreate', async () => {
    const result = await handleToolCall('codex', { op: 'exec', prompt: 'hello' }, mgr);
    expect(result.isError).toBe(false);
    expect(executeOneShot).toHaveBeenCalled();
  });

  it('routes codex exec(session) to handleSessionSend', async () => {
    mgr.register('session-1', 'thread-1', 'o4-mini', '/workspace');
    const result = await handleToolCall('codex', { op: 'exec', session: 'session-1', prompt: 'hi' }, mgr);
    expect(result.isError).toBe(false);
    expect(executeResume).toHaveBeenCalled();
  });

  it('routes codex list to handleSessionList', async () => {
    const result = await handleToolCall('codex', { op: 'list' }, mgr);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('sessions');
  });

  it('routes codex fork to handleSessionFork', async () => {
    mgr.register('session-1', 'thread-1', 'o4-mini', '/workspace');
    const result = await handleToolCall('codex', { op: 'fork', session: 'session-1' }, mgr);
    expect(result.isError).toBe(false);
    expect(executeFork).toHaveBeenCalled();
  });

  it('unknown tool name → isError: true with "Unknown tool:" message', async () => {
    const result = await handleToolCall('nonexistent_tool', {}, mgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool: nonexistent_tool');
  });

  it('Zod: exec without prompt → isError: true', async () => {
    const result = await handleToolCall('codex', { op: 'exec' }, mgr);
    expect(result.isError).toBe(true);
  });

  it('Zod: exec with session but without prompt → isError: true', async () => {
    const result = await handleToolCall('codex', { op: 'exec', session: 'session-1' }, mgr);
    expect(result.isError).toBe(true);
  });

  it('Zod: list with unknown props → isError: true (strict rejects)', async () => {
    const result = await handleToolCall('codex', { op: 'list', unknown: true }, mgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unrecognized key');
  });

  it('Zod: fork without session → isError: true', async () => {
    const result = await handleToolCall('codex', { op: 'fork', prompt: 'hi' }, mgr);
    expect(result.isError).toBe(true);
  });

  it('routes codex abort to handleSessionAbort', async () => {
    vi.mocked(abortExecution).mockReturnValue(true);
    mgr.register('session-to-abort', 'thread-ab', 'o4-mini', '/workspace');
    const result = await handleToolCall('codex', { op: 'abort', session: 'session-to-abort' }, mgr);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('abort_requested');
  });

  it('Zod: abort without session → isError: true', async () => {
    const result = await handleToolCall('codex', { op: 'abort' }, mgr);
    expect(result.isError).toBe(true);
  });

  it('unknown op returns structured error', async () => {
    const result = await handleToolCall('codex', { op: 'invalid_op' }, mgr);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: 'unknown_op', op: 'invalid_op' });
  });

  it('missing op falls through to generic Zod error, not unknown_op', async () => {
    const result = await handleToolCall('codex', {}, mgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('unknown_op');
  });

  it('exec(session) with non-existent session → early isError from dispatcher guard', async () => {
    const result = await handleToolCall('codex', { op: 'exec', session: 'nonexistent', prompt: 'hi' }, mgr);
    expect(result.isError).toBe(true);
    expect(executeResume).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('Session not found: "nonexistent"');
  });

  it('exec without session uses executeOneShot', async () => {
    vi.mocked(executeOneShot).mockResolvedValue(makeExecResult());
    const result = await handleToolCall('codex', { op: 'exec', prompt: 'hello' }, mgr);
    expect(result.isError).toBe(false);
    expect(executeOneShot).toHaveBeenCalled();
    expect(executeResume).not.toHaveBeenCalled();
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('session_name');
  });

  it('exec(session) uses executeResume', async () => {
    mgr.register('session-1', 'thread-1', 'o4-mini', '/workspace');
    vi.mocked(executeResume).mockResolvedValue(makeExecResult());
    const result = await handleToolCall('codex', { op: 'exec', session: 'session-1', prompt: 'follow-up' }, mgr);
    expect(result.isError).toBe(false);
    expect(executeResume).toHaveBeenCalledWith(
      'thread-1',
      'follow-up',
      undefined,
      '/workspace',
      undefined,
      false,
      undefined,
      undefined,
      expect.objectContaining({ available: true, authState: 'authenticated' }),
    );
    expect(executeOneShot).not.toHaveBeenCalled();
  });

  it('exec(session, name) ignores name and uses target session', async () => {
    mgr.register('base-session', 'thread-1', 'o4-mini', '/workspace');
    vi.mocked(executeResume).mockResolvedValue(makeExecResult());
    const result = await handleToolCall('codex', { op: 'exec', session: 'base-session', name: 'attempted-name', prompt: 'follow-up' }, mgr);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.session_name).toBe('base-session');
    expect(mgr.get('attempted-name')).toBeNull();
  });

  it('unknown op "create" returns unknown_op', async () => {
    const legacyCreate = { ['op']: 'create', prompt: 'hello' } as const;
    const result = await handleToolCall('codex', legacyCreate as any, mgr);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: 'unknown_op', ['op']: 'create' });
  });

  it('unknown op "send" returns unknown_op', async () => {
    const legacySend = { ['op']: 'send', session: 'session-1', prompt: 'hello' } as const;
    const result = await handleToolCall('codex', legacySend as any, mgr);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: 'unknown_op', ['op']: 'send' });
  });
});

// ─── J. Auth preflight guard ─────────────────────────────────────────────────

describe('auth preflight guard', () => {
  const unauthenticatedCli = {
    available: true as const,
    version: 'codex 1.0.0',
    authState: 'unauthenticated' as const,
    authError: 'Codex CLI is not authenticated. Run "codex login" or set the OPENAI_API_KEY environment variable.',
  };

  it('exec foreground unauthenticated → immediate isError', async () => {
    vi.mocked(detectCodexCli).mockResolvedValue(unauthenticatedCli);

    const result = await handleToolCall('codex', { op: 'exec', prompt: 'hello' }, mgr);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('codex login');
    expect(executeOneShot).not.toHaveBeenCalled();
  });

  it('exec background unauthenticated → immediate isError (not launched)', async () => {
    vi.mocked(detectCodexCli).mockResolvedValue(unauthenticatedCli);

    const result = await handleToolCall('codex', { op: 'exec', prompt: 'hello', background: true }, mgr);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('launched');
    expect(createProgressFile).not.toHaveBeenCalled();
    expect(executeOneShot).not.toHaveBeenCalled();
  });

  it('exec foreground unknown auth → proceeds (fail-open)', async () => {
    vi.mocked(detectCodexCli).mockResolvedValue({ available: true, version: 'codex 1.0.0', authState: 'unknown' });
    vi.mocked(executeOneShot).mockResolvedValue(makeExecResult());

    const result = await handleToolCall('codex', { op: 'exec', prompt: 'hello' }, mgr);

    expect(result.isError).toBe(false);
    expect(executeOneShot).toHaveBeenCalledTimes(1);
    const preChecked = vi.mocked(executeOneShot).mock.calls[0]?.[7];
    expect(preChecked).toEqual(expect.objectContaining({ available: true, authState: 'unknown' }));
  });

  it('fork unauthenticated → immediate isError', async () => {
    mgr.register('base-session', 'thread-base', 'o4-mini', '/workspace');
    vi.mocked(detectCodexCli).mockResolvedValue(unauthenticatedCli);

    const result = await handleToolCall('codex', { op: 'fork', session: 'base-session' }, mgr);

    expect(result.isError).toBe(true);
    expect(executeFork).not.toHaveBeenCalled();
  });

  it('exec(session) missing session takes precedence over auth errors', async () => {
    vi.mocked(detectCodexCli).mockResolvedValue(unauthenticatedCli);

    const result = await handleToolCall('codex', { op: 'exec', session: 'missing', prompt: 'hello' }, mgr);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Session not found: "missing"');
    expect(detectCodexCli).not.toHaveBeenCalled();
  });

  it('fork missing session takes precedence over auth errors', async () => {
    vi.mocked(detectCodexCli).mockResolvedValue(unauthenticatedCli);

    const result = await handleToolCall('codex', { op: 'fork', session: 'missing' }, mgr);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Session not found: "missing"');
    expect(detectCodexCli).not.toHaveBeenCalled();
  });

  it('list is not gated by auth checks', async () => {
    vi.mocked(detectCodexCli).mockResolvedValue(unauthenticatedCli);

    const result = await handleToolCall('codex', { op: 'list' }, mgr);

    expect(result.isError).toBe(false);
    expect(detectCodexCli).not.toHaveBeenCalled();
  });

  it('abort is not gated by auth checks', async () => {
    vi.mocked(detectCodexCli).mockResolvedValue(unauthenticatedCli);
    vi.mocked(abortExecution).mockReturnValue(true);

    const result = await handleToolCall('codex', { op: 'abort', session: 'any-session' }, mgr);

    expect(result.isError).toBe(false);
    expect(detectCodexCli).not.toHaveBeenCalled();
  });

  it('exec with unknown auth probes once across preflight + executor path', async () => {
    vi.mocked(detectCodexCli).mockResolvedValue({ available: true, version: 'codex 1.0.0', authState: 'unknown' });
    vi.mocked(executeOneShot).mockResolvedValue(makeExecResult());

    const result = await handleToolCall('codex', { op: 'exec', prompt: 'hello' }, mgr);

    expect(result.isError).toBe(false);
    expect(detectCodexCli).toHaveBeenCalledTimes(1);
    const preChecked = vi.mocked(executeOneShot).mock.calls[0]?.[7];
    expect(preChecked).toEqual(expect.objectContaining({ available: true, authState: 'unknown' }));
  });
});

// ─── K. Background/foreground branching ──────────────────────────────────────

describe('background/foreground branching', () => {
  beforeEach(() => {
    vi.mocked(createProgressFile).mockReturnValue('/tmp/progress.jsonl');
    vi.mocked(extractProgressId).mockReturnValue('uuid-123');
  });

  it('exec(no session) with background: true → returns immediately with progress_id + status: launched', async () => {
    vi.mocked(executeOneShot).mockResolvedValue(makeExecResult());
    const result = await handleToolCall('codex', { op: 'exec', prompt: 'hello', background: true }, mgr);
    const data = JSON.parse(result.content[0].text);
    expect(data.progress_id).toBe('uuid-123');
    expect(data.status).toBe('launched');
  });

  it('exec(session) with background + missing session → returns error, not launched', async () => {
    const result = await handleToolCall('codex', { op: 'exec', session: 'none', prompt: 'hi', background: true }, mgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('launched');
  });

  it('fork with background + missing session → returns error, not launched', async () => {
    const result = await handleToolCall('codex', { op: 'fork', session: 'none', background: true }, mgr);
    expect(result.isError).toBe(true);
  });

  it('foreground without progressToken → createProgressFile not called', async () => {
    vi.mocked(executeOneShot).mockResolvedValue(makeExecResult());
    await handleToolCall('codex', { op: 'exec', prompt: 'hello' }, mgr);
    expect(createProgressFile).not.toHaveBeenCalled();
  });

  it('foreground with progress token forwards notifications via runForeground path', async () => {
    vi.mocked(extractProgressMessage).mockReturnValueOnce('Processing...');
    vi.mocked(executeOneShot).mockImplementationOnce(async (_prompt, _model, _workingDir, _effort, _bypass, onEvent) => {
      onEvent?.(JSON.stringify({ type: 'turn.started' }));
      return makeExecResult();
    });

    const notify = vi.fn().mockResolvedValue(undefined);
    const result = await handleToolCall('codex', { op: 'exec', prompt: 'hello' }, mgr, 'pt-foreground', notify);

    expect(result.isError).toBe(false);
    expect(createProgressFile).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith({
      method: 'notifications/progress',
      params: { progressToken: 'pt-foreground', progress: 1, message: '[Codex] Processing...' },
    });
  });

  it('background handler resolves → appendFinalResult called with completed', async () => {
    let resolveExec!: (v: CodexExecResult) => void;
    vi.mocked(executeOneShot).mockReturnValue(new Promise(r => { resolveExec = r; }));

    handleToolCall('codex', { op: 'exec', prompt: 'hello', background: true }, mgr);

    resolveExec(makeExecResult());
    await new Promise(r => setTimeout(r, 10));

    expect(appendFinalResult).toHaveBeenCalledWith('/tmp/progress.jsonl', 'completed', expect.any(Object));
  });

  it('background handler rejects → appendFinalResult called with error', async () => {
    let rejectExec!: (e: Error) => void;
    vi.mocked(executeOneShot).mockReturnValue(new Promise((_, r) => { rejectExec = r; }));

    handleToolCall('codex', { op: 'exec', prompt: 'hello', background: true }, mgr);

    rejectExec(new Error('codex failed'));
    await new Promise(r => setTimeout(r, 10));

    expect(appendFinalResult).toHaveBeenCalledWith('/tmp/progress.jsonl', 'error', { error: 'codex failed' });
  });

  it('background completion → activeBackgroundFiles cleaned up in finally', async () => {
    let resolveExec!: (v: CodexExecResult) => void;
    vi.mocked(executeOneShot).mockReturnValue(new Promise(r => { resolveExec = r; }));

    await handleToolCall('codex', { op: 'exec', prompt: 'hello', background: true }, mgr);

    expect(activeBackgroundFiles.has('/tmp/progress.jsonl')).toBe(true);

    resolveExec(makeExecResult());
    await new Promise(r => setTimeout(r, 10));

    expect(activeBackgroundFiles.has('/tmp/progress.jsonl')).toBe(false);
  });
});

// ─── L. finally-clause reliability on rejection ───────────────────────────────

describe('finally-clause fires on executor rejection', () => {
  it('handleSessionCreate: unregisterExecution called even when executeOneShot rejects', async () => {
    const ctrl = new AbortController();
    vi.mocked(registerExecution).mockReturnValue(ctrl);
    vi.mocked(executeOneShot).mockRejectedValue(new Error('spawn failed'));

    await expect(
      handleSessionCreate({ prompt: 'hi', name: 'fail-session', background: false, bypass: false }, mgr),
    ).rejects.toThrow('spawn failed');

    expect(vi.mocked(unregisterExecution)).toHaveBeenCalledWith('fail-session', ctrl);
  });

  it('handleSessionSend: unregisterExecution called even when executeResume rejects', async () => {
    mgr.register('send-session', 'thread-001', 'o4-mini', '/workspace');
    const ctrl = new AbortController();
    vi.mocked(registerExecution).mockReturnValue(ctrl);
    vi.mocked(executeResume).mockRejectedValue(new Error('resume failed'));

    await expect(
      handleSessionSend({ session: 'send-session', prompt: 'hi', background: false, bypass: false }, mgr),
    ).rejects.toThrow('resume failed');

    expect(vi.mocked(unregisterExecution)).toHaveBeenCalledWith('send-session', ctrl);
  });

  it('handleSessionFork: unregisterExecution called even when executeFork rejects', async () => {
    mgr.register('base', 'thread-base', 'o4-mini', '/workspace');
    const ctrl = new AbortController();
    vi.mocked(registerExecution).mockReturnValue(ctrl);
    vi.mocked(executeFork).mockRejectedValue(new Error('fork failed'));

    await expect(
      handleSessionFork({ session: 'base', background: false, bypass: false }, mgr),
    ).rejects.toThrow('fork failed');

    expect(vi.mocked(unregisterExecution)).toHaveBeenCalledWith('base', ctrl);
  });

  it('handleToolCall wraps executor rejection as MCP error (does not propagate to caller)', async () => {
    vi.mocked(executeOneShot).mockRejectedValue(new Error('Codex CLI not found'));

    const result = await handleToolCall('codex', { op: 'exec', prompt: 'hello' }, mgr);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Codex CLI not found');
    expect(vi.mocked(unregisterExecution)).toHaveBeenCalledTimes(1);
  });
});

// ─── M. dispatchExecution notify threading ────────────────────────────────────

describe('dispatchExecution threads progressToken and notify to runForeground', () => {
  it('exec foreground without progressToken: notify is NOT called', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    vi.mocked(executeOneShot).mockImplementation(
      async (_prompt, _model, _cwd, _effort, _bypass, onEvent) => {
        if (onEvent) onEvent(JSON.stringify({ type: 'turn.started' }));
        return makeExecResult();
      },
    );

    await handleToolCall('codex', { op: 'exec', prompt: 'hello' }, mgr, undefined, notify);

    expect(notify).not.toHaveBeenCalled();
  });

  it('fork foreground with progressToken + notify: notify is called during execution', async () => {
    mgr.register('base-for-fork', 'thread-base', 'o4-mini', '/workspace');
    const notify = vi.fn().mockResolvedValue(undefined);
    vi.mocked(createProgressFile).mockReturnValue('/tmp/fork-progress.jsonl');
    vi.mocked(extractProgressMessage).mockReturnValue('Processing...');
    vi.mocked(executeFork).mockImplementation(
      async (_sid, _prompt, _model, _cwd, _effort, _bypass, onEvent) => {
        if (onEvent) onEvent(JSON.stringify({ type: 'turn.started' }));
        return makeExecResult({ sessionId: 'thread-fork2' });
      },
    );

    await handleToolCall('codex', { op: 'fork', session: 'base-for-fork' }, mgr, 'pt-fork', notify);

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'notifications/progress' }),
    );
  });
});

// ─── N. Guard-before-dispatch ordering ───────────────────────────────────────

describe('guard-before-dispatch: registerExecution not called on session-not-found', () => {
  it('exec(session) with nonexistent session: registerExecution never called', async () => {
    const result = await handleToolCall(
      'codex', { op: 'exec', session: 'ghost-session', prompt: 'hi' }, mgr,
    );

    expect(result.isError).toBe(true);
    expect(vi.mocked(registerExecution)).not.toHaveBeenCalled();
    expect(vi.mocked(executeResume)).not.toHaveBeenCalled();
  });

  it('fork with nonexistent session: registerExecution never called', async () => {
    const result = await handleToolCall(
      'codex', { op: 'fork', session: 'ghost-session' }, mgr,
    );

    expect(result.isError).toBe(true);
    expect(vi.mocked(registerExecution)).not.toHaveBeenCalled();
    expect(vi.mocked(executeFork)).not.toHaveBeenCalled();
  });

  it('exec(session) background with nonexistent session: registerExecution never called', async () => {
    const result = await handleToolCall(
      'codex', { op: 'exec', session: 'ghost-bg', prompt: 'hi', background: true }, mgr,
    );

    expect(result.isError).toBe(true);
    expect(vi.mocked(registerExecution)).not.toHaveBeenCalled();
  });

  it('fork background with nonexistent session: registerExecution never called', async () => {
    const result = await handleToolCall(
      'codex', { op: 'fork', session: 'ghost-bg', background: true }, mgr,
    );

    expect(result.isError).toBe(true);
    expect(vi.mocked(registerExecution)).not.toHaveBeenCalled();
  });
});

// ─── O. extractCompletionData edge values ────────────────────────────────────

describe('extractCompletionData edge values', () => {
  it('session field: undefined → null', () => {
    const result = jsonResult({ response: 'hi', model: 'o4-mini', duration_ms: 10 });
    expect(extractCompletionData(result, 'my-session').session).toBeNull();
  });

  it('session field: numeric 0 (falsy) is preserved via ??', () => {
    const result = jsonResult({ response: 'hi', session: 0, model: 'o4-mini', duration_ms: 10 });
    expect(extractCompletionData(result, 'my-session').session).toBe(0);
  });

  it('exit_code: 0 is included (any defined value is forwarded)', () => {
    const result = jsonResult({ response: 'hi', session: 't-1', model: 'm', duration_ms: 1, exit_code: 0 });
    expect(extractCompletionData(result, 'test')).toHaveProperty('exit_code', 0);
  });

  it('errors and warnings: non-array values are omitted', () => {
    const result = jsonResult({ response: 'hi', session: 't-1', model: 'm', duration_ms: 1, errors: 'bad', warnings: null });
    const data = extractCompletionData(result, 'test');
    expect(data).not.toHaveProperty('errors');
    expect(data).not.toHaveProperty('warnings');
  });
});

// ─── P. registerExecution called exactly once per handler ─────────────────────

describe('registerExecution called exactly once per handler', () => {
  it('handleSessionCreate: registerExecution called exactly once', async () => {
    vi.mocked(executeOneShot).mockResolvedValue(makeExecResult());

    await handleSessionCreate({ prompt: 'hi', name: 'once-test', background: false, bypass: false }, mgr);

    expect(vi.mocked(registerExecution)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(registerExecution)).toHaveBeenCalledWith('once-test');
  });

  it('handleSessionSend: registerExecution called exactly once', async () => {
    mgr.register('send-once', 'thread-001', 'o4-mini', '/workspace');
    vi.mocked(executeResume).mockResolvedValue(makeExecResult());

    await handleSessionSend({ session: 'send-once', prompt: 'hi', background: false, bypass: false }, mgr);

    expect(vi.mocked(registerExecution)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(registerExecution)).toHaveBeenCalledWith('send-once');
  });

  it('handleSessionFork: registerExecution called exactly once', async () => {
    mgr.register('fork-once-base', 'thread-f', 'o4-mini', '/workspace');
    vi.mocked(executeFork).mockResolvedValue(makeExecResult());

    await handleSessionFork({ session: 'fork-once-base', background: false, bypass: false }, mgr);

    expect(vi.mocked(registerExecution)).toHaveBeenCalledTimes(1);
  });
});
