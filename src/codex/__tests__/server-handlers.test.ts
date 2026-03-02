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
  createJobDir: vi.fn(() => ({
    jobId: 'test-uuid-1234-1234-1234-test-uuid-12',
    jobDir: '/tmp/coral-jobs/test-uuid-1234',
  })),
  writeJobResult: vi.fn(),
  writeJobError: vi.fn(),
  readJobStatus: vi.fn(() => ({ status: 'running' })),
  resolveJobDir: vi.fn((id: string) => `/tmp/coral-jobs/${id}`),
  JOBS_DIR: '/tmp/coral-jobs',
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
  createJobDir,
  writeJobResult,
  writeJobError,
  readJobStatus,
  resolveJobDir,
  extractProgressMessage,
  appendProgressEvent,
  JOBS_DIR,
} from '../progress.js';
import { SessionManager } from '../session-manager.js';
import { textResult, jsonResult, resultExtras } from '../../shared/mcp-utils.js';
import {
  extractCompletionData,
  sessionNotFoundError,
  makeEventCallback,
  launchJob,
  tryClaimTerminalWrite,
  activeJobs,
  shutdownSignal,
  handleSessionCreate,
  handleSessionSend,
  handleSessionList,
  handleSessionFork,
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
  activeJobs.clear();
  vi.mocked(detectCodexCli).mockResolvedValue({ available: true, version: 'codex 1.0.0', authState: 'authenticated' });
  vi.mocked(readJobStatus).mockReturnValue({ status: 'running' });
  vi.mocked(resolveJobDir).mockImplementation((id: string) => join(JOBS_DIR as string, id));
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
      exit_code: 1,
      errors: ['e'],
      warnings: ['w'],
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
  it('splits response text and metadata', () => {
    const result = jsonResult({ response: 'hi', session: 't-1', model: 'o4-mini', duration_ms: 100 });
    const { responseText, metadata } = extractCompletionData(result, 'my-session');
    expect(responseText).toBe('hi');
    expect(metadata).toMatchObject({
      session: 't-1',
      session_name: 'my-session',
      model: 'o4-mini',
      duration_ms: 100,
    });
  });

  it('includes notice field when present', () => {
    const result = jsonResult({ response: 'hi', session: null, model: 'o4-mini', duration_ms: 10, notice: 'No session' });
    const { metadata } = extractCompletionData(result, 'test');
    expect(metadata.notice).toBe('No session');
  });

  it('forwards aborted and non_resumable when present', () => {
    const result = jsonResult({ response: '', session: null, model: 'o4-mini', duration_ms: 50, aborted: true, non_resumable: true });
    const { metadata } = extractCompletionData(result, 'test');
    expect(metadata.aborted).toBe(true);
    expect(metadata.non_resumable).toBe(true);
  });

  it('forwards exit_code, errors, warnings when present', () => {
    const result = jsonResult({ response: '', session: 't-1', model: 'o4-mini', duration_ms: 10, exit_code: 1, errors: ['e'], warnings: ['w'] });
    const { metadata } = extractCompletionData(result, 'test');
    expect(metadata.exit_code).toBe(1);
    expect(metadata.errors).toEqual(['e']);
    expect(metadata.warnings).toEqual(['w']);
  });

  it('uses empty responseText when response is missing', () => {
    const result = jsonResult({ session: 't-1', model: 'o4-mini', duration_ms: 10 });
    const { responseText } = extractCompletionData(result, 'test');
    expect(responseText).toBe('');
  });
});

// ─── C. makeEventCallback ─────────────────────────────────────────────────────

describe('makeEventCallback', () => {
  beforeEach(() => {
    vi.mocked(extractProgressMessage).mockReturnValue('Processing...');
  });

  it('writes to progress file for valid JSON events with a message', () => {
    const cb = makeEventCallback('/tmp/test.jsonl');
    cb(JSON.stringify({ type: 'turn.started' }));
    expect(appendProgressEvent).toHaveBeenCalledWith('/tmp/test.jsonl', 'turn.started', 'Processing...');
  });

  it('silently ignores non-JSON lines', () => {
    const cb = makeEventCallback('/tmp/test.jsonl');
    expect(() => cb('not json at all')).not.toThrow();
    expect(appendProgressEvent).not.toHaveBeenCalled();
  });

  it('does not append when extractProgressMessage returns null', () => {
    vi.mocked(extractProgressMessage).mockReturnValueOnce(null);
    const cb = makeEventCallback('/tmp/test.jsonl');
    cb(JSON.stringify({ type: 'item.updated' }));
    expect(appendProgressEvent).not.toHaveBeenCalled();
  });
});

// ─── D. handleSessionCreate ───────────────────────────────────────────────────

describe('handleSessionCreate', () => {
  it('success with sessionId → returns response + session_name', async () => {
    vi.mocked(executeOneShot).mockResolvedValue(makeExecResult());

    const signal = new AbortController().signal;
    const result = await handleSessionCreate({ prompt: 'hi', name: 'my-session', bypass: false }, mgr, signal);

    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.response).toBe('test response');
    expect(data.session).toBe('thread-123');
    expect(data.session_name).toBe('my-session');
  });

  it('success without sessionId → returns notice', async () => {
    vi.mocked(executeOneShot).mockResolvedValue(makeExecResult({ sessionId: null }));

    const signal = new AbortController().signal;
    const result = await handleSessionCreate({ prompt: 'hi', name: 'no-thread', bypass: false }, mgr, signal);

    const data = JSON.parse(result.content[0].text);
    expect(data.notice).toContain('No session ID');
  });

  it('includes errors and warnings in response via resultExtras', async () => {
    vi.mocked(executeOneShot).mockResolvedValue(makeExecResult({ exitCode: 1, errors: ['err'], warnings: ['warn'] }));

    const signal = new AbortController().signal;
    const result = await handleSessionCreate({ prompt: 'hi', name: 'test', bypass: false }, mgr, signal);

    const data = JSON.parse(result.content[0].text);
    expect(data.exit_code).toBe(1);
    expect(data.errors).toEqual(['err']);
    expect(data.warnings).toEqual(['warn']);
  });

  it('uses the provided name (dispatcher owns generation)', async () => {
    vi.mocked(executeOneShot).mockResolvedValue(makeExecResult());

    const signal = new AbortController().signal;
    const result = await handleSessionCreate({ prompt: 'hi', name: 'explicit-name', bypass: false }, mgr, signal);

    const data = JSON.parse(result.content[0].text);
    expect(data.session_name).toBe('explicit-name');
  });

  it('rejects when executeOneShot throws', async () => {
    vi.mocked(executeOneShot).mockRejectedValue(new Error('boom'));

    const signal = new AbortController().signal;
    await expect(handleSessionCreate({ prompt: 'hi', name: 'failing-session', bypass: false }, mgr, signal)).rejects.toThrow('boom');
  });
});

// ─── E. handleSessionSend ─────────────────────────────────────────────────────

describe('handleSessionSend', () => {
  beforeEach(() => {
    mgr.register('test-session', 'thread-001', 'o4-mini', '/workspace');
  });

  it('success → returns response and session_name', async () => {
    vi.mocked(executeResume).mockResolvedValue(makeExecResult({ sessionId: 'thread-001' }));

    const signal = new AbortController().signal;
    const result = await handleSessionSend({ session: 'test-session', prompt: 'follow up', bypass: false }, mgr, signal);

    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.response).toBe('test response');
    expect(data.session_name).toBe('test-session');
  });

  it('session not found → isError: true (internal handler guard)', async () => {
    const signal = new AbortController().signal;
    const result = await handleSessionSend({ session: 'nonexistent', prompt: 'hi', bypass: false }, mgr, signal);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nonexistent');
  });

  it('passes entry sessionId and workingDirectory to executeResume', async () => {
    vi.mocked(executeResume).mockResolvedValue(makeExecResult());

    const signal = new AbortController().signal;
    await handleSessionSend({ session: 'test-session', prompt: 'hi', bypass: false }, mgr, signal);

    expect(executeResume).toHaveBeenCalledWith(
      'thread-001',
      'hi',
      undefined,
      '/workspace',
      undefined,
      false,
      undefined,
      signal,
      undefined,
    );
  });

  it('threads bypass=true to executeResume', async () => {
    vi.mocked(executeResume).mockResolvedValue(makeExecResult());

    const signal = new AbortController().signal;
    await handleSessionSend({ session: 'test-session', prompt: 'hi', bypass: true }, mgr, signal);

    expect(executeResume).toHaveBeenCalledWith(
      'thread-001',
      'hi',
      undefined,
      '/workspace',
      undefined,
      true,
      undefined,
      signal,
      undefined,
    );
  });
});

// ─── F. handleSessionList ─────────────────────────────────────────────────────

describe('handleSessionList', () => {
  it('empty → { sessions: [], total: 0 }', () => {
    const result = handleSessionList(mgr);
    const data = JSON.parse(result.content[0].text);
    expect(data.sessions).toEqual([]);
    expect(data.total).toBe(0);
  });

  it('returns status=running for sessions with active jobs', () => {
    mgr.register('active-session', 'thread-1', 'o4-mini', '/workspace');
    activeJobs.set('job-abc', {
      jobDir: '/tmp/x',
      controller: new AbortController(),
      sessionName: 'active-session',
      terminalState: 'running',
    } as never);

    const result = handleSessionList(mgr);
    const data = JSON.parse(result.content[0].text);
    expect(data.sessions[0].status).toBe('running');

    activeJobs.clear();
  });

  it('returns status=completed for sessions without active jobs', () => {
    mgr.register('idle-session', 'thread-1', 'o4-mini', '/workspace');

    const result = handleSessionList(mgr);
    const data = JSON.parse(result.content[0].text);
    expect(data.sessions[0].status).toBe('completed');
  });
});

// ─── G. handleSessionFork ─────────────────────────────────────────────────────

describe('handleSessionFork', () => {
  beforeEach(() => {
    mgr.register('base-session', 'thread-base', 'o4-mini', '/workspace');
  });

  it('success with name includes forked_from + session_name', async () => {
    vi.mocked(executeFork).mockResolvedValue(makeExecResult({ sessionId: 'thread-fork' }));

    const signal = new AbortController().signal;
    const result = await handleSessionFork({ session: 'base-session', name: 'forked', bypass: false }, mgr, signal);

    const data = JSON.parse(result.content[0].text);
    expect(data.forked_from).toBe('thread-base');
    expect(data.session_name).toBe('forked');
  });

  it('success without name returns no session_name', async () => {
    vi.mocked(executeFork).mockResolvedValue(makeExecResult({ sessionId: 'thread-fork' }));

    const signal = new AbortController().signal;
    const result = await handleSessionFork({ session: 'base-session', bypass: false }, mgr, signal);

    const data = JSON.parse(result.content[0].text);
    expect(data.session_name).toBeUndefined();
  });

  it('session not found → isError: true (internal handler guard)', async () => {
    const signal = new AbortController().signal;
    const result = await handleSessionFork({ session: 'nonexistent', bypass: false }, mgr, signal);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nonexistent');
  });

  it('uses entry workingDirectory when input omits it', async () => {
    vi.mocked(executeFork).mockResolvedValue(makeExecResult());

    const signal = new AbortController().signal;
    await handleSessionFork({ session: 'base-session', bypass: false }, mgr, signal);

    expect(executeFork).toHaveBeenCalledWith(
      'thread-base',
      undefined,
      undefined,
      '/workspace',
      undefined,
      false,
      undefined,
      signal,
      undefined,
    );
  });
});

// ─── H. handleSessionAbort ────────────────────────────────────────────────────

describe('handleSessionAbort', () => {
  it('job_id provided → aborts the matching job and returns abort_requested', async () => {
    const controller = new AbortController();
    activeJobs.set('job-abc-123', {
      jobDir: '/tmp/x',
      controller,
      sessionName: 'my-session',
      terminalState: 'running',
    } as never);

    const result = await handleSessionAbort({ job_id: 'job-abc-123' }, mgr);

    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('abort_requested');
    expect(data.job_id).toBe('job-abc-123');
    expect(controller.signal.aborted).toBe(true);

    activeJobs.clear();
  });

  it('session provided → aborts all matching jobs by session field', async () => {
    const c1 = new AbortController();
    const c2 = new AbortController();

    activeJobs.set('job-1', {
      jobDir: '/tmp/x',
      controller: c1,
      sessionName: 'n',
      session: 'thread-999',
      terminalState: 'running',
    } as never);

    activeJobs.set('job-2', {
      jobDir: '/tmp/y',
      controller: c2,
      sessionName: 'n',
      session: 'thread-999',
      terminalState: 'running',
    } as never);

    const result = await handleSessionAbort({ session: 'thread-999' }, mgr);

    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.matched_job_ids).toHaveLength(2);
    expect(c1.signal.aborted).toBe(true);
    expect(c2.signal.aborted).toBe(true);

    activeJobs.clear();
  });

  it('both job_id and session → isError', async () => {
    const result = await handleSessionAbort({ job_id: 'abc', session: 'xyz' }, mgr);
    expect(result.isError).toBe(true);
  });

  it('neither job_id nor session → isError', async () => {
    const result = await handleSessionAbort({}, mgr);
    expect(result.isError).toBe(true);
  });

  it('job_id not in activeJobs → isError', async () => {
    const result = await handleSessionAbort({ job_id: 'nonexistent-job' }, mgr);
    expect(result.isError).toBe(true);
  });

  it('session with no matching jobs → isError', async () => {
    const result = await handleSessionAbort({ session: 'no-such-thread' }, mgr);
    expect(result.isError).toBe(true);
  });
});

// ─── I. handleToolCall dispatch + validation ──────────────────────────────────

describe('handleToolCall', () => {
  beforeEach(() => {
    vi.mocked(executeOneShot).mockResolvedValue(makeExecResult());
    vi.mocked(executeResume).mockResolvedValue(makeExecResult());
    vi.mocked(executeFork).mockResolvedValue(makeExecResult());
  });

  it('registers exactly one codex tool', () => {
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('codex');
  });

  it('exec returns job_id and status:running immediately', async () => {
    vi.mocked(executeOneShot).mockResolvedValue(makeExecResult());

    const result = await handleToolCall('codex', { op: 'exec', prompt: 'hello' }, mgr);

    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.job_id).toBeDefined();
    expect(data.status).toBe('running');
    expect(data.session_name).toBeDefined();
    expect(data.job_dir).toBeDefined();
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

  it('routes codex wait to handleWait', async () => {
    const jobId = '12345678-1234-1234-1234-123456789abc';
    const dir = join(JOBS_DIR as string, jobId);
    mkdirSync(dir, { recursive: true });
    dirsToClean.add(dir);

    vi.mocked(readJobStatus).mockReturnValue({ status: 'completed', session_name: 'wait-session' });

    const result = await handleToolCall('codex', { op: 'wait', job_ids: [jobId] }, mgr);

    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('completed');
    expect(data.completed_job_id).toBe(jobId);
  });

  it('routes codex abort to handleSessionAbort', async () => {
    const jobId = '12345678-1234-1234-1234-123456789abc';
    const controller = new AbortController();
    activeJobs.set(jobId, {
      jobDir: '/tmp/x',
      controller,
      sessionName: 'session-to-abort',
      terminalState: 'running',
    } as never);

    const result = await handleToolCall('codex', { op: 'abort', job_id: jobId }, mgr);

    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('abort_requested');
    expect(controller.signal.aborted).toBe(true);
  });

  it('routes coral:scanner to agent resolution and prepends agent prompt', async () => {
    const result = await handleToolCall('codex', { op: 'coral:scanner', prompt: 'inspect this' }, mgr);
    expect(result.isError).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(executeOneShot).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(executeOneShot).mock.calls[0]?.[0];
    expect(prompt).toContain('# Scanner Agent');
    expect(prompt).toContain('\n\n---\n\ninspect this');
  });

  it('coral:nonexistent returns agent file not found error', async () => {
    const result = await handleToolCall('codex', { op: 'coral:nonexistent', prompt: 'test' }, mgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Agent file not found: agents/nonexistent.md');
  });

  it('coral:scanner without prompt returns Zod error, not unknown_op', async () => {
    const result = await handleToolCall('codex', { op: 'coral:scanner' }, mgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('unknown_op');
  });

  it('tool schema op has no enum to allow coral:* values', () => {
    const opSchema = tools[0].inputSchema.properties.op as { enum?: unknown[] };
    expect(opSchema.enum).toBeUndefined();
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

  it('abort without identifiers → isError from handler one-of guard', async () => {
    const result = await handleToolCall('codex', { op: 'abort' }, mgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Provide exactly one of job_id or session');
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

  it('unknown op "create" returns unknown_op', async () => {
    const legacyCreate: Record<string, unknown> = { op: 'create', prompt: 'hello' };
    const result = await handleToolCall('codex', legacyCreate, mgr);

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: 'unknown_op', op: 'create' });
  });

  it('unknown op "send" returns unknown_op', async () => {
    const legacySend: Record<string, unknown> = { op: 'send', session: 'session-1', prompt: 'hello' };
    const result = await handleToolCall('codex', legacySend, mgr);

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: 'unknown_op', op: 'send' });
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

  it('exec unauthenticated → immediate isError', async () => {
    vi.mocked(detectCodexCli).mockResolvedValue(unauthenticatedCli);

    const result = await handleToolCall('codex', { op: 'exec', prompt: 'hello' }, mgr);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('codex login');
    expect(executeOneShot).not.toHaveBeenCalled();
  });

  it('exec unknown auth → proceeds (fail-open)', async () => {
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

    const result = await handleToolCall('codex', { op: 'abort', session: 'any-session' }, mgr);

    expect(result.isError).toBe(true);
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

// ─── O. extractCompletionData edge values ────────────────────────────────────

describe('extractCompletionData edge values', () => {
  it('session field: undefined → metadata.session is null', () => {
    const result = jsonResult({ response: 'hi', model: 'o4-mini', duration_ms: 10 });
    expect(extractCompletionData(result, 'my-session').metadata.session).toBeNull();
  });

  it('session field: numeric 0 (falsy) is preserved via ??', () => {
    const result = jsonResult({ response: 'hi', session: 0, model: 'o4-mini', duration_ms: 10 });
    expect(extractCompletionData(result, 'my-session').metadata.session).toBe(0);
  });

  it('exit_code: 0 is included (any defined value is forwarded)', () => {
    const result = jsonResult({ response: 'hi', session: 't-1', model: 'm', duration_ms: 1, exit_code: 0 });
    expect(extractCompletionData(result, 'test').metadata).toHaveProperty('exit_code', 0);
  });

  it('errors and warnings: non-array values are omitted', () => {
    const result = jsonResult({ response: 'hi', session: 't-1', model: 'm', duration_ms: 1, errors: 'bad', warnings: null });
    const metadata = extractCompletionData(result, 'test').metadata;
    expect(metadata).not.toHaveProperty('errors');
    expect(metadata).not.toHaveProperty('warnings');
  });
});

// ─── Q. launchJob ─────────────────────────────────────────────────────────────

describe('launchJob', () => {
  beforeEach(() => {
    vi.mocked(createJobDir).mockReturnValue({
      jobId: 'test-job-id',
      jobDir: '/tmp/coral-jobs/test-job-id',
    });
  });

  it('returns job_id, job_dir, session_name, status:running immediately', () => {
    const handler = vi.fn().mockReturnValue(new Promise(() => {}));

    const result = launchJob('my-session', handler, mgr);

    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.job_id).toBe('test-job-id');
    expect(data.job_dir).toBe('/tmp/coral-jobs/test-job-id');
    expect(data.session_name).toBe('my-session');
    expect(data.status).toBe('running');

    activeJobs.clear();
  });

  it('adds entry to activeJobs', () => {
    const handler = vi.fn().mockReturnValue(new Promise(() => {}));

    launchJob('my-session', handler, mgr);

    expect(activeJobs.size).toBe(1);
    activeJobs.clear();
  });

  it('registers session in mgr when handler resolves with sessionId', async () => {
    vi.mocked(executeOneShot).mockResolvedValue(makeExecResult());

    launchJob(
      'reg-session',
      (sig, onEvent) => handleSessionCreate({ prompt: 'hi', name: 'reg-session', bypass: false }, mgr, sig, onEvent),
      mgr,
      true,
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mgr.get('reg-session')).not.toBeNull();
    activeJobs.clear();
  });

  it('calls writeJobError when handler rejects', async () => {
    vi.mocked(executeOneShot).mockRejectedValue(new Error('codex error'));

    launchJob(
      'fail-session',
      (sig, onEvent) => handleSessionCreate({ prompt: 'hi', name: 'fail-session', bypass: false }, mgr, sig, onEvent),
      mgr,
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(writeJobError).toHaveBeenCalled();
    activeJobs.clear();
  });
});

// ─── R. tryClaimTerminalWrite ────────────────────────────────────────────────

describe('tryClaimTerminalWrite', () => {
  beforeEach(() => {
    vi.mocked(createJobDir).mockReturnValue({ jobId: 'claim-job', jobDir: '/tmp/x' });
  });

  it('returns true on first call for running job', () => {
    const handler = vi.fn().mockReturnValue(new Promise(() => {}));

    launchJob('session', handler, mgr);

    expect(tryClaimTerminalWrite('claim-job', 'completed')).toBe(true);
    activeJobs.clear();
  });

  it('returns false on second call (already terminalizing)', () => {
    const handler = vi.fn().mockReturnValue(new Promise(() => {}));

    launchJob('session', handler, mgr);

    tryClaimTerminalWrite('claim-job', 'completed');
    expect(tryClaimTerminalWrite('claim-job', 'error')).toBe(false);

    activeJobs.clear();
  });

  it('returns false for unknown job_id', () => {
    expect(tryClaimTerminalWrite('nonexistent', 'completed')).toBe(false);
  });
});

// ─── S. handleWait ────────────────────────────────────────────────────────────

describe('handleWait', () => {
  let testJobId: string;
  let testJobDir: string;

  beforeEach(() => {
    testJobId = '12345678-1234-1234-1234-123456789abc';
    testJobDir = join(JOBS_DIR as string, testJobId);
    mkdirSync(testJobDir, { recursive: true });
    dirsToClean.add(testJobDir);
    vi.mocked(resolveJobDir).mockImplementation((id: string) => join(JOBS_DIR as string, id));
  });

  it('returns error for unknown job_id (no directory)', async () => {
    const unknownJobId = '12345678-1234-1234-1234-123456789abd';
    const unknownDir = join(JOBS_DIR as string, unknownJobId);
    rmSync(unknownDir, { recursive: true, force: true });

    const result = await handleWait({ op: 'wait', job_ids: [unknownJobId] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown job_id');
  });

  it('returns immediately when job is already completed', async () => {
    vi.mocked(readJobStatus).mockReturnValue({ status: 'completed', session_name: 'test-session' });

    const result = await handleWait({ op: 'wait', job_ids: [testJobId] });

    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('completed');
    expect(data.completed_job_id).toBe(testJobId);
    expect(data.session_name).toBe('test-session');
  }, 5000);

  it('returns timeout when jobs are still running', async () => {
    vi.mocked(readJobStatus).mockReturnValue({ status: 'running' });

    const result = await handleWait({ op: 'wait', job_ids: [testJobId], timeout_seconds: 1 });

    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('timeout');
    expect(data.running_jobs).toContain(testJobId);
    expect(shutdownSignal.signal.aborted).toBe(false);
  }, 5000);
});
