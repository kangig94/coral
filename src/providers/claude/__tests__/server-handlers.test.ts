import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../cli-detection.js', () => ({
  detectClaudeCli: vi.fn(async () => ({
    available: true,
    version: '2.1.63 (Claude Code)',
    authState: 'authenticated',
  })),
}));

vi.mock('../claude-executor.js', () => {
  class MockClaudeExecParseError extends Error {
    failure: unknown;

    constructor(failure: unknown) {
      super('mock parse error');
      this.name = 'ClaudeExecParseError';
      this.failure = failure;
    }
  }

  return {
    ClaudeExecParseError: MockClaudeExecParseError,
    executeClaudeOneShot: vi.fn(async (
      prompt: string,
      options?: {
        model?: string;
        systemPrompt?: string;
        effort?: string;
        bypassPermissions?: boolean;
        onEvent?: (line: string) => void;
      },
    ) => ({
      response: `one-shot:${prompt}`,
      sessionId: 'claude-thread-1',
      model: options?.model ?? 'sonnet',
      durationMs: 5,
      costUsd: 0.001,
      aborted: false,
    })),
    executeClaudeResume: vi.fn(async (
      _sessionId: string,
      prompt: string,
      options?: {
        model?: string;
        workingDirectory?: string;
        systemPrompt?: string;
        effort?: string;
        bypassPermissions?: boolean;
        onEvent?: (line: string) => void;
      },
    ) => ({
      response: `resume:${prompt}`,
      sessionId: 'claude-thread-2',
      model: options?.model ?? 'sonnet',
      durationMs: 5,
      costUsd: 0.001,
      aborted: false,
    })),
    executeClaudeFork: vi.fn(async (
      _sessionId: string,
      prompt: string,
      options?: { model?: string; onEvent?: (line: string) => void },
    ) => ({
      response: `fork:${prompt}`,
      sessionId: 'claude-thread-forked',
      model: options?.model ?? 'sonnet',
      durationMs: 5,
      costUsd: 0.001,
      aborted: false,
    })),
  };
});

import { executeClaudeOneShot, executeClaudeResume, executeClaudeFork, ClaudeExecParseError } from '../claude-executor.js';
import { handleClaudeOp, handleClaudeSessionFork, claudeAdapter, makeClaudeEventCallback } from '../server-handlers.js';
import { SessionManager } from '../../../runner/session-manager.js';
import { createSessionDir } from '../../../runner/progress.js';
import { activeSessions } from '../../../runner/job-manager.js';
import { _test as resolverTest } from '../../../coral/resolver.js';

const mockExecuteClaudeOneShot = vi.mocked(executeClaudeOneShot);
const mockExecuteClaudeResume = vi.mocked(executeClaudeResume);
const mockExecuteClaudeFork = vi.mocked(executeClaudeFork);

let tmpDir = '';
let mgr: SessionManager;
const sessionDirs = new Set<string>();
const defaultPluginRoot = process.cwd();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trackSessionDir(result: { content: Array<{ text: string }> }): void {
  const launchData = JSON.parse(result.content[0].text) as { session_dir?: string };
  if (launchData.session_dir) sessionDirs.add(launchData.session_dir);
}

async function expectLaunched(result: { isError: boolean; content: Array<{ text: string }> }): Promise<void> {
  trackSessionDir(result);
  expect(result.isError).toBe(false);
  await sleep(30);
}

function registerSession(name: string, threadId: string, workingDirectory = '/tmp/work'): string {
  const claudeSession = createSessionDir(name, 'claude');
  sessionDirs.add(claudeSession.dir);
  mgr.register('claude', claudeSession.id, name, threadId, 'sonnet', workingDirectory);
  return claudeSession.id;
}

function oneShotOptions() {
  const [, options] = mockExecuteClaudeOneShot.mock.calls[0] ?? [];
  return options;
}

function resumeOptions() {
  const [, , options] = mockExecuteClaudeResume.mock.calls[0] ?? [];
  return options;
}

describe('claude provider server-handlers', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join('/tmp', 'coral-claude-handlers-test-'));
    mkdirSync(join(tmpDir, 'workspace'), { recursive: true });
    mkdirSync(join(tmpDir, 'agents'), { recursive: true });

    writeFileSync(join(tmpDir, 'agents', 'architect.md'), '# Architect\nAgent body\n');
    writeFileSync(join(tmpDir, 'agents', 'frontmatter.md'), [
      '---',
      'title: Frontmatter Agent',
      'model: sonnet',
      '---',
      '',
      '> **CORAL_METHODS**: use method list',
      '# Frontmatter Agent',
      'Body text',
      '',
    ].join('\n'));

    resolverTest.setPluginRoot(tmpDir);
    mgr = new SessionManager(join(tmpDir, 'workspace'));
    activeSessions.clear();
    sessionDirs.clear();
    mockExecuteClaudeOneShot.mockClear();
    mockExecuteClaudeResume.mockClear();
    mockExecuteClaudeFork.mockClear();
  });

  afterEach(() => {
    resolverTest.setPluginRoot(defaultPluginRoot);
    activeSessions.clear();
    for (const dir of sessionDirs) rmSync(dir, { recursive: true, force: true });
    sessionDirs.clear();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exports a provider adapter with matching tool name', () => {
    expect(claudeAdapter.name).toBe('claude');
    expect(claudeAdapter.tool.name).toBe('claude');
  });

  it('tool schema exposes effort field', () => {
    const properties = claudeAdapter.tool.inputSchema.properties as Record<string, unknown>;
    expect(properties.effort).toEqual({
      type: 'string',
      enum: ['low', 'medium', 'high', 'xhigh'],
      description: 'Model reasoning effort level',
    });
  });

  it('makeClaudeEventCallback appends tool/text progress from assistant events', () => {
    const progressFile = join(tmpDir, 'workspace', 'progress.jsonl');
    const onEvent = makeClaudeEventCallback(progressFile);

    onEvent(JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: '/repo/src/main.ts' } },
        ],
      },
    }));
    onEvent(JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'drafting...' }],
      },
    }));

    const lines = readFileSync(progressFile, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0].event).toBe('assistant');
    expect(lines[0].message).toBe('Read(/repo/src/main.ts)');
    expect(lines[1].message).toBe('Generating response...');
  });

  it('makeClaudeEventCallback ignores non-JSON and unsupported event types', () => {
    const progressFile = join(tmpDir, 'workspace', 'progress-ignored.jsonl');
    const onEvent = makeClaudeEventCallback(progressFile);

    onEvent('not-json');
    onEvent(JSON.stringify({ type: 'result', result: 'done' }));
    onEvent(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_result', text: 'ignored' }] } }));

    expect(existsSync(progressFile)).toBe(false);
  });

  it('list op returns empty sessions when none are registered', async () => {
    const result = await handleClaudeOp({ op: 'list' }, mgr);
    const data = JSON.parse(result.content[0].text) as { sessions: unknown[]; total: number };

    expect(result.isError).toBe(false);
    expect(data.sessions).toEqual([]);
    expect(data.total).toBe(0);
  });

  it('coral create uses pre-stripped system prompt and forces bypass', async () => {
    const strippedPrompt = '# Frontmatter Agent\nBody text';
    const result = await claudeAdapter.handleCoralOp(
      'frontmatter',
      strippedPrompt,
      { op: 'coral:frontmatter', prompt: 'Implement this', name: 'front-agent-session', effort: 'xhigh', bypass: false },
      mgr,
    );
    await expectLaunched(result);

    const options = oneShotOptions();
    expect(options?.systemPrompt).toBe(strippedPrompt);
    expect(options?.effort).toBe('xhigh');
    expect(options?.bypassPermissions).toBe(true);
  });

  it('coral resume forwards bypassPermissions=true and defaults working_directory from session', async () => {
    const sessionId = registerSession('claude-coral-resume', 'thread-claude-coral-resume');
    const strippedPrompt = '# Architect\nAgent body';

    const result = await claudeAdapter.handleCoralOp(
      'architect',
      strippedPrompt,
      { op: 'coral:architect', prompt: 'continue', session: sessionId, effort: 'high', bypass: false },
      mgr,
    );
    await expectLaunched(result);

    const options = resumeOptions();
    expect(options?.workingDirectory).toBe('/tmp/work');
    expect(options?.effort).toBe('high');
    expect(options?.systemPrompt).toBe(strippedPrompt);
    expect(options?.bypassPermissions).toBe(true);
    expect(options?.onEvent).toEqual(expect.any(Function));
  });

  it('direct exec create defaults bypassPermissions to false', async () => {
    const result = await handleClaudeOp({ op: 'exec', prompt: 'create default bypass', effort: 'medium' }, mgr);
    await expectLaunched(result);

    const options = oneShotOptions();
    expect(options?.effort).toBe('medium');
    expect(options?.bypassPermissions).toBe(false);
    expect(options?.onEvent).toEqual(expect.any(Function));
  });

  it('direct exec create forwards bypassPermissions=true when bypass is true', async () => {
    const result = await handleClaudeOp({ op: 'exec', prompt: 'create bypass true', bypass: true }, mgr);
    await expectLaunched(result);

    const options = oneShotOptions();
    expect(options?.bypassPermissions).toBe(true);
    expect(options?.onEvent).toEqual(expect.any(Function));
  });

  it('direct exec resume forwards effort to executeClaudeResume', async () => {
    const sessionId = registerSession('claude-direct-resume', 'thread-claude-direct-resume');

    const result = await handleClaudeOp({
      op: 'exec',
      session: sessionId,
      prompt: 'resume now',
      effort: 'high',
    }, mgr);
    await expectLaunched(result);

    const options = resumeOptions();
    expect(options?.effort).toBe('high');
    expect(options?.onEvent).toEqual(expect.any(Function));
  });

  it('fork op routes through handleClaudeOp and returns forked_from', async () => {
    const sessionId = registerSession('claude-fork-source', 'thread-fork-source');
    const result = await handleClaudeOp({ op: 'fork', session: sessionId, name: 'forked' }, mgr);
    await expectLaunched(result);
  });

  it('fork op with non-existent session returns error', async () => {
    const result = await handleClaudeOp({ op: 'fork', session: 'nonexistent-ref' }, mgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nonexistent-ref');
  });

  it('fork returns non_resumable when CLI output cannot be parsed', async () => {
    const sessionId = registerSession('claude-fork-parse-fail', 'thread-fork-parse');
    const failure = {
      exitCode: 17,
      stdout: 'not-json',
      stderr: 'parse exploded',
      parseError: 'Fully unparseable stream-json output',
    };
    mockExecuteClaudeFork.mockRejectedValueOnce(new ClaudeExecParseError(failure));

    const result = await handleClaudeSessionFork(
      { session: sessionId, prompt: 'fork it', model: 'opus', bypass: false },
      mgr,
      new AbortController().signal,
    );

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
    expect(payload).toMatchObject({
      response: '',
      notice: 'Claude CLI returned non-JSON output while forking session.',
      non_resumable: true,
    });
  });

  it('fork marks as non_resumable when CLI returns no session id', async () => {
    const sessionId = registerSession('claude-fork-no-id', 'thread-fork-no-id');
    mockExecuteClaudeFork.mockResolvedValueOnce({
      response: 'fork-output',
      sessionId: '',
      model: 'sonnet',
      durationMs: 22,
      costUsd: 0.004,
      aborted: false,
    });

    const result = await handleClaudeSessionFork(
      { session: sessionId, prompt: 'fork without id', name: 'child', bypass: false },
      mgr,
      new AbortController().signal,
    );

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
    expect(payload).toMatchObject({
      response: 'fork-output',
      notice: 'No session ID returned by Claude CLI output. Session not registered.',
      non_resumable: true,
    });
    expect(payload).not.toHaveProperty('thread_id');
    expect(payload).not.toHaveProperty('forked_from');
  });

});
