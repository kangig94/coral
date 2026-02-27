/**
 * Red-team adversarial tests for server-handlers.ts auth preflight guard.
 *
 * Gaps targeted (non-overlapping with server-handlers.test.ts):
 *   - exec(session=existing) background=true + authenticated → returns launched (not error)
 *     (existing tests cover unauthenticated background exec but not authenticated background exec(session))
 *   - fork(session=existing) background=true + authenticated → returns launched (not error)
 *   - Preflight auth error text format: "Error: <authError>" — the "Error: " prefix is added by
 *     preflightCliCheck(); existing tests check containment of "codex login" but not the exact prefix
 *   - Preflight CLI-not-found error format: "Error: <error>" — same prefix pattern
 *   - unauthenticated exec(no session) background=true: activeBackgroundFiles stays empty
 *     (existing test verifies !launched but does not assert activeBackgroundFiles stays clean)
 *   - unauthenticated fork background=true: createProgressFile never called and
 *     activeBackgroundFiles stays empty
 *   - handleSessionSend direct call with preChecked unauthenticated: executor throws and
 *     handleSessionSend propagates (no MCP wrapping at this layer — only handleToolCall wraps)
 *   - exec(session=existing) unauthenticated + detectCodexCli called exactly once
 *     (preflight runs after session found, so one detectCodexCli call — not zero, not two)
 *   - fork(session=existing) unauthenticated + detectCodexCli called exactly once
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexExecResult } from '../../../types.js';

vi.mock('../codex-executor.js', () => ({
  executeOneShot: vi.fn(),
  executeResume: vi.fn(),
  executeFork: vi.fn(),
  registerExecution: vi.fn(() => ({ signal: undefined })),
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
} from '../codex-executor.js';
import { detectCodexCli } from '../cli-detection.js';
import {
  createProgressFile,
  extractProgressId,
} from '../progress.js';
import { SessionManager } from '../session-manager.js';
import {
  handleToolCall,
  handleSessionSend,
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

const AUTH_ERROR = 'Codex CLI is not authenticated. Run "codex login" or set the OPENAI_API_KEY environment variable.';
const INSTALL_ERROR = 'Codex CLI not found. Install it with: npm install -g @openai/codex';

const authenticatedCli = { available: true as const, version: 'codex 1.0.0', authState: 'authenticated' as const };
const unauthenticatedCli = {
  available: true as const,
  version: 'codex 1.0.0',
  authState: 'unauthenticated' as const,
  authError: AUTH_ERROR,
};

let mgr: SessionManager;

beforeEach(() => {
  tmpDir = mkdtempSync(join('/tmp', 'coral-red-handlers-'));
  mkdirSync(join(tmpDir, 'workspace'), { recursive: true });
  mgr = new SessionManager(join(tmpDir, 'workspace'));
  activeBackgroundFiles.clear();
  vi.clearAllMocks();
  vi.mocked(detectCodexCli).mockResolvedValue(authenticatedCli);
  vi.mocked(createProgressFile).mockReturnValue('/tmp/red-progress.jsonl');
  vi.mocked(extractProgressId).mockReturnValue('red-uuid-789');
});

afterEach(() => {
  activeBackgroundFiles.clear();
  vi.clearAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Authenticated background happy paths ─────────────────────────────────────

describe('authenticated background exec paths', () => {
  it('exec(no session) background=true + authenticated → launched response', async () => {
    vi.mocked(executeOneShot).mockResolvedValue(makeExecResult());

    const result = await handleToolCall('codex', { op: 'exec', prompt: 'hello', background: true }, mgr);

    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('launched');
    expect(data.progress_id).toBe('red-uuid-789');
    // launchBackground fires the handler immediately — executeOneShot is invoked but
    // the caller receives the launched response before the handler's promise settles.
    expect(createProgressFile).toHaveBeenCalled();
  });

  it('exec(session=existing) background=true + authenticated → launched response', async () => {
    mgr.register('bg-session', 'thread-bg', 'o4-mini', '/workspace');
    vi.mocked(executeResume).mockResolvedValue(makeExecResult({ sessionId: 'thread-bg' }));

    const result = await handleToolCall('codex', { op: 'exec', session: 'bg-session', prompt: 'continue', background: true }, mgr);

    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('launched');
    expect(data.progress_id).toBe('red-uuid-789');
  });

  it('fork(session=existing) background=true + authenticated → launched response', async () => {
    mgr.register('fork-src', 'thread-fork', 'o4-mini', '/workspace');
    vi.mocked(executeFork).mockResolvedValue(makeExecResult({ sessionId: 'thread-fork2' }));

    const result = await handleToolCall('codex', { op: 'fork', session: 'fork-src', background: true }, mgr);

    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('launched');
    expect(data.progress_id).toBe('red-uuid-789');
  });
});

// ─── Auth error message exact format ─────────────────────────────────────────

describe('preflight error message exact format', () => {
  it('unauthenticated: error text is exactly "Error: <authError>" (no double-wrap)', async () => {
    vi.mocked(detectCodexCli).mockResolvedValue(unauthenticatedCli);

    const result = await handleToolCall('codex', { op: 'exec', prompt: 'hello' }, mgr);

    expect(result.isError).toBe(true);
    // preflightCliCheck wraps with "Error: " — verify the exact format
    expect(result.content[0].text).toBe(`Error: ${AUTH_ERROR}`);
  });

  it('cli unavailable: error text is exactly "Error: <install error>"', async () => {
    vi.mocked(detectCodexCli).mockResolvedValue({ available: false, error: INSTALL_ERROR });

    const result = await handleToolCall('codex', { op: 'exec', prompt: 'hello' }, mgr);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(`Error: ${INSTALL_ERROR}`);
  });

  it('fork unauthenticated: error text format matches "Error: <authError>"', async () => {
    mgr.register('fork-base', 'thread-b', 'o4-mini', '/workspace');
    vi.mocked(detectCodexCli).mockResolvedValue(unauthenticatedCli);

    const result = await handleToolCall('codex', { op: 'fork', session: 'fork-base' }, mgr);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(`Error: ${AUTH_ERROR}`);
  });
});

// ─── activeBackgroundFiles stays clean on auth errors ────────────────────────

describe('background file tracking: no files created on auth failure', () => {
  it('exec(no session) background unauthenticated: activeBackgroundFiles stays empty', async () => {
    vi.mocked(detectCodexCli).mockResolvedValue(unauthenticatedCli);

    await handleToolCall('codex', { op: 'exec', prompt: 'hello', background: true }, mgr);

    expect(createProgressFile).not.toHaveBeenCalled();
    expect(activeBackgroundFiles.size).toBe(0);
  });

  it('exec(session=existing) background unauthenticated: activeBackgroundFiles stays empty', async () => {
    mgr.register('existing-session', 'thread-e', 'o4-mini', '/workspace');
    vi.mocked(detectCodexCli).mockResolvedValue(unauthenticatedCli);

    await handleToolCall('codex', { op: 'exec', session: 'existing-session', prompt: 'hi', background: true }, mgr);

    expect(createProgressFile).not.toHaveBeenCalled();
    expect(activeBackgroundFiles.size).toBe(0);
  });

  it('fork(session=existing) background unauthenticated: activeBackgroundFiles stays empty', async () => {
    mgr.register('fork-src', 'thread-f', 'o4-mini', '/workspace');
    vi.mocked(detectCodexCli).mockResolvedValue(unauthenticatedCli);

    await handleToolCall('codex', { op: 'fork', session: 'fork-src', background: true }, mgr);

    expect(createProgressFile).not.toHaveBeenCalled();
    expect(activeBackgroundFiles.size).toBe(0);
  });
});

// ─── detectCodexCli call count for session-based ops ─────────────────────────

describe('detectCodexCli call count: session-based preflight ordering', () => {
  it('exec(session=existing) unauthenticated: detectCodexCli called exactly once', async () => {
    // Session found first, THEN preflight runs — so detectCodexCli fires exactly once
    mgr.register('existing', 'thread-e', 'o4-mini', '/workspace');
    vi.mocked(detectCodexCli).mockResolvedValue(unauthenticatedCli);

    await handleToolCall('codex', { op: 'exec', session: 'existing', prompt: 'hi' }, mgr);

    expect(vi.mocked(detectCodexCli)).toHaveBeenCalledTimes(1);
  });

  it('fork(session=existing) unauthenticated: detectCodexCli called exactly once', async () => {
    mgr.register('fork-base', 'thread-fb', 'o4-mini', '/workspace');
    vi.mocked(detectCodexCli).mockResolvedValue(unauthenticatedCli);

    await handleToolCall('codex', { op: 'fork', session: 'fork-base' }, mgr);

    expect(vi.mocked(detectCodexCli)).toHaveBeenCalledTimes(1);
  });

  it('exec(session=missing): detectCodexCli never called (session-not-found takes precedence)', async () => {
    vi.mocked(detectCodexCli).mockResolvedValue(unauthenticatedCli);

    await handleToolCall('codex', { op: 'exec', session: 'ghost', prompt: 'hi' }, mgr);

    expect(vi.mocked(detectCodexCli)).not.toHaveBeenCalled();
  });

  it('fork(session=missing): detectCodexCli never called (session-not-found takes precedence)', async () => {
    vi.mocked(detectCodexCli).mockResolvedValue(unauthenticatedCli);

    await handleToolCall('codex', { op: 'fork', session: 'ghost' }, mgr);

    expect(vi.mocked(detectCodexCli)).not.toHaveBeenCalled();
  });
});

// ─── handleSessionSend direct-call propagation (no MCP wrap) ─────────────────

describe('handleSessionSend direct call: auth error propagation without MCP wrapping', () => {
  beforeEach(() => {
    mgr.register('send-session', 'thread-001', 'o4-mini', '/workspace');
  });

  it('executor rejection propagates as throw (handleSessionSend does not catch)', async () => {
    // handleSessionSend is a low-level handler — it does NOT catch errors.
    // Only handleToolCall wraps errors into MCP responses.
    // When the executor throws (e.g., auth guard), the throw propagates to the caller.
    vi.mocked(executeResume).mockRejectedValue(new Error(AUTH_ERROR));

    await expect(
      handleSessionSend(
        { session: 'send-session', prompt: 'hi', background: false, bypass: false },
        mgr,
      ),
    ).rejects.toThrow(AUTH_ERROR);
  });

  it('handleToolCall wraps same executor rejection as MCP error (contrast with direct call)', async () => {
    // This is the MCP-layer contrast: handleToolCall converts the throw to isError:true
    vi.mocked(executeResume).mockRejectedValue(new Error(AUTH_ERROR));
    mgr.register('tc-session', 'thread-tc', 'o4-mini', '/workspace');

    const result = await handleToolCall(
      'codex',
      { op: 'exec', session: 'tc-session', prompt: 'hi' },
      mgr,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(AUTH_ERROR);
  });
});
