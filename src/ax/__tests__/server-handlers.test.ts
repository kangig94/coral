import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../codex/server-handlers.js', () => ({
  tools: [
    {
      name: 'codex',
      description: 'mock codex tool',
      inputSchema: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] },
    },
  ],
  handleToolCall: vi.fn(async (_name: string, args: Record<string, unknown>) => ({
    content: [{ type: 'text', text: JSON.stringify({ from: 'codex', args }) }],
    isError: false,
  })),
}));

vi.mock('../../claude/cli-detection.js', () => ({
  detectClaudeCli: vi.fn(async () => ({
    available: true,
    version: '2.1.63 (Claude Code)',
    authState: 'authenticated',
  })),
}));

vi.mock('../../claude/claude-executor.js', () => {
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
      options?: { model?: string; systemPrompt?: string; bypassPermissions?: boolean },
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
      options?: { model?: string; systemPrompt?: string; bypassPermissions?: boolean },
    ) => ({
      response: `resume:${prompt}`,
      sessionId: 'claude-thread-2',
      model: options?.model ?? 'sonnet',
      durationMs: 5,
      costUsd: 0.001,
      aborted: false,
    })),
  };
});

import { handleToolCall, tools } from '../server-handlers.js';
import { handleToolCall as handleCodexToolCall } from '../../codex/server-handlers.js';
import { detectClaudeCli } from '../../claude/cli-detection.js';
import { executeClaudeOneShot, executeClaudeResume } from '../../claude/claude-executor.js';
import { SessionManager } from '../../runner/session-manager.js';
import { createSessionDir, writeSessionResult } from '../../runner/progress.js';
import type { McpResult } from '../../shared/mcp-utils.js';
import { activeSessions, launchJob } from '../../runner/job-manager.js';
import { _test as resolverTest } from '../../runner/coral-resolver.js';

const mockCodexHandleToolCall = vi.mocked(handleCodexToolCall);
const mockDetectClaudeCli = vi.mocked(detectClaudeCli);
const mockExecuteClaudeOneShot = vi.mocked(executeClaudeOneShot);
const mockExecuteClaudeResume = vi.mocked(executeClaudeResume);

let tmpDir = '';
let mgr: SessionManager;
const sessionDirs = new Set<string>();
const defaultPluginRoot = process.cwd();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLaunch(result: McpResult): { session: string; session_dir: string } {
  return JSON.parse(result.content[0].text) as { session: string; session_dir: string };
}

describe('ax server-handlers', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join('/tmp', 'coral-ax-handlers-test-'));
    mkdirSync(join(tmpDir, 'workspace'), { recursive: true });
    mkdirSync(join(tmpDir, 'agents'), { recursive: true });
    mkdirSync(join(tmpDir, 'skills', 'plan'), { recursive: true });

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
    writeFileSync(join(tmpDir, 'skills', 'plan', 'SKILL.md'), '# Plan Skill\nSkill body\n');

    resolverTest.setPluginRoot(tmpDir);
    mgr = new SessionManager(join(tmpDir, 'workspace'));

    activeSessions.clear();
    sessionDirs.clear();
    mockCodexHandleToolCall.mockClear();
    mockDetectClaudeCli.mockClear();
    mockExecuteClaudeOneShot.mockClear();
    mockExecuteClaudeResume.mockClear();
  });

  afterEach(() => {
    resolverTest.setPluginRoot(defaultPluginRoot);
    activeSessions.clear();

    for (const dir of sessionDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    sessionDirs.clear();

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exposes both codex and claude tool definitions', () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual(['claude', 'codex']);
  });

  it('exposes claude bypass field in tool schema with boolean default false', () => {
    const claudeTool = tools.find((tool) => tool.name === 'claude');
    expect(claudeTool).toBeDefined();

    const bypassSchema = claudeTool?.inputSchema.properties.bypass as {
      type?: string;
      default?: boolean;
    };
    expect(bypassSchema.type).toBe('boolean');
    expect(bypassSchema.default).toBe(false);
  });

  it('routes codex tool calls through codex handler', async () => {
    const result = await handleToolCall('codex', { op: 'list' }, mgr);

    expect(result.isError).toBe(false);
    expect(mockCodexHandleToolCall).toHaveBeenCalledTimes(1);
    expect(mockCodexHandleToolCall).toHaveBeenCalledWith('codex', { op: 'list' }, mgr, undefined, undefined);
  });

  it('routes claude tool calls through claude handler', async () => {
    const result = await handleToolCall('claude', { op: 'list' }, mgr);
    const data = JSON.parse(result.content[0].text) as { sessions: unknown[]; total: number };

    expect(result.isError).toBe(false);
    expect(data.sessions).toEqual([]);
    expect(data.total).toBe(0);
  });

  it('coral:<name> resolves agent and prepends content for codex tool', async () => {
    const result = await handleToolCall('codex', { op: 'coral:architect', prompt: 'Run checks' }, mgr);
    const data = JSON.parse(result.content[0].text) as { args: Record<string, unknown> };

    expect(result.isError).toBe(false);
    expect(data.args.op).toBe('exec');
    expect(String(data.args.prompt)).toContain('# Architect\nAgent body');
    expect(String(data.args.prompt)).toContain('\n\n---\n\nRun checks');
    expect(data.args.bypass).toBe(true);
  });

  it('coral codex path forces bypass true even when input sets bypass false', async () => {
    const result = await handleToolCall(
      'codex',
      { op: 'coral:architect', prompt: 'Run checks', bypass: false },
      mgr,
    );
    const data = JSON.parse(result.content[0].text) as { args: Record<string, unknown> };

    expect(result.isError).toBe(false);
    expect(data.args.bypass).toBe(true);
  });

  it('coral:<name> resolves skill and prepends content for codex tool', async () => {
    const result = await handleToolCall('codex', { op: 'coral:plan', prompt: 'Plan this task' }, mgr);
    const data = JSON.parse(result.content[0].text) as { args: Record<string, unknown> };

    expect(result.isError).toBe(false);
    expect(data.args.op).toBe('exec');
    expect(String(data.args.prompt)).toContain('# Plan Skill\nSkill body');
    expect(String(data.args.prompt)).toContain('\n\n---\n\nPlan this task');
  });

  it('coral:<name> resolves agent for claude and strips frontmatter into system prompt', async () => {
    const result = await handleToolCall(
      'claude',
      { op: 'coral:frontmatter', prompt: 'Implement this', name: 'front-agent-session' },
      mgr,
    );
    const launchData = JSON.parse(result.content[0].text) as { session_dir?: string };
    if (launchData.session_dir) sessionDirs.add(launchData.session_dir);

    expect(result.isError).toBe(false);

    await sleep(30);

    expect(mockExecuteClaudeOneShot).toHaveBeenCalledTimes(1);
    const [, options] = mockExecuteClaudeOneShot.mock.calls[0] ?? [];
    expect(options?.systemPrompt).toBe('# Frontmatter Agent\nBody text');
    expect(options?.bypassPermissions).toBe(true);
  });

  it('coral claude path forces bypass true even when input sets bypass false', async () => {
    const result = await handleToolCall(
      'claude',
      { op: 'coral:frontmatter', prompt: 'Implement this', bypass: false, name: 'forced-bypass-session' },
      mgr,
    );
    const launchData = JSON.parse(result.content[0].text) as { session_dir?: string };
    if (launchData.session_dir) sessionDirs.add(launchData.session_dir);

    expect(result.isError).toBe(false);

    await sleep(30);

    const [, options] = mockExecuteClaudeOneShot.mock.calls[0] ?? [];
    expect(options?.bypassPermissions).toBe(true);
  });

  it('coral claude resume path forwards bypassPermissions true', async () => {
    const claudeSession = createSessionDir('claude-coral-resume', 'claude');
    sessionDirs.add(claudeSession.dir);
    mgr.register('claude', claudeSession.id, 'claude-coral-resume', 'thread-claude-coral-resume', 'sonnet', '/tmp/work');

    const result = await handleToolCall(
      'claude',
      { op: 'coral:architect', prompt: 'continue', session: claudeSession.id, bypass: false },
      mgr,
    );
    const launchData = JSON.parse(result.content[0].text) as { session_dir?: string };
    if (launchData.session_dir) sessionDirs.add(launchData.session_dir);

    expect(result.isError).toBe(false);
    await sleep(30);

    const [, , options] = mockExecuteClaudeResume.mock.calls[0] ?? [];
    expect(options?.bypassPermissions).toBe(true);
  });

  it('direct claude exec create defaults bypassPermissions to false', async () => {
    const result = await handleToolCall('claude', { op: 'exec', prompt: 'create default bypass' }, mgr);
    const launchData = JSON.parse(result.content[0].text) as { session_dir?: string };
    if (launchData.session_dir) sessionDirs.add(launchData.session_dir);

    expect(result.isError).toBe(false);
    await sleep(30);

    const [, options] = mockExecuteClaudeOneShot.mock.calls[0] ?? [];
    expect(options?.bypassPermissions).toBe(false);
  });

  it('direct claude exec create forwards bypassPermissions true when bypass is true', async () => {
    const result = await handleToolCall('claude', { op: 'exec', prompt: 'create bypass true', bypass: true }, mgr);
    const launchData = JSON.parse(result.content[0].text) as { session_dir?: string };
    if (launchData.session_dir) sessionDirs.add(launchData.session_dir);

    expect(result.isError).toBe(false);
    await sleep(30);

    const [, options] = mockExecuteClaudeOneShot.mock.calls[0] ?? [];
    expect(options?.bypassPermissions).toBe(true);
  });

  it('direct claude exec resume defaults bypassPermissions to false', async () => {
    const claudeSession = createSessionDir('claude-exec-resume-default', 'claude');
    sessionDirs.add(claudeSession.dir);
    mgr.register('claude', claudeSession.id, 'claude-exec-resume-default', 'thread-claude-exec-resume-default', 'sonnet', '/tmp/work');

    const result = await handleToolCall(
      'claude',
      { op: 'exec', prompt: 'resume default bypass', session: claudeSession.id },
      mgr,
    );
    const launchData = JSON.parse(result.content[0].text) as { session_dir?: string };
    if (launchData.session_dir) sessionDirs.add(launchData.session_dir);

    expect(result.isError).toBe(false);
    await sleep(30);

    const [, , options] = mockExecuteClaudeResume.mock.calls[0] ?? [];
    expect(options?.bypassPermissions).toBe(false);
  });

  it('direct claude exec resume forwards bypassPermissions true when bypass is true', async () => {
    const claudeSession = createSessionDir('claude-exec-resume-true', 'claude');
    sessionDirs.add(claudeSession.dir);
    mgr.register('claude', claudeSession.id, 'claude-exec-resume-true', 'thread-claude-exec-resume-true', 'sonnet', '/tmp/work');

    const result = await handleToolCall(
      'claude',
      { op: 'exec', prompt: 'resume bypass true', session: claudeSession.id, bypass: true },
      mgr,
    );
    const launchData = JSON.parse(result.content[0].text) as { session_dir?: string };
    if (launchData.session_dir) sessionDirs.add(launchData.session_dir);

    expect(result.isError).toBe(false);
    await sleep(30);

    const [, , options] = mockExecuteClaudeResume.mock.calls[0] ?? [];
    expect(options?.bypassPermissions).toBe(true);
  });

  it('coral:<name> launches skills on claude tool via append-system-prompt', async () => {
    const result = await handleToolCall('claude', { op: 'coral:plan', prompt: 'Run skill' }, mgr);

    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('running');
    expect(data.session_name).toMatch(/^plan-/);
  });

  it('coral:<name> rejects traversal attempts', async () => {
    const codexResult = await handleToolCall('codex', { op: 'coral:../evil', prompt: 'x' }, mgr);
    const claudeResult = await handleToolCall('claude', { op: 'coral:../evil', prompt: 'x' }, mgr);

    expect(codexResult.isError).toBe(true);
    expect(claudeResult.isError).toBe(true);
  });

  it('keeps abort/list/wait isolated by provider', async () => {
    const codexSession = createSessionDir('codex-running', 'codex');
    const claudeSession = createSessionDir('claude-running', 'claude');
    sessionDirs.add(codexSession.dir);
    sessionDirs.add(claudeSession.dir);

    mgr.register('codex', codexSession.id, 'codex-running', 'thread-codex', 'gpt-5.3-codex', process.cwd());
    mgr.register('claude', claudeSession.id, 'claude-running', 'thread-claude', 'sonnet', process.cwd());

    activeSessions.set(codexSession.id, {
      provider: 'codex',
      sessionDir: codexSession.dir,
      controller: new AbortController(),
      sessionName: 'codex-running',
      terminalState: 'running',
    });
    activeSessions.set(claudeSession.id, {
      provider: 'claude',
      sessionDir: claudeSession.dir,
      controller: new AbortController(),
      sessionName: 'claude-running',
      terminalState: 'running',
    });

    const listClaude = await handleToolCall('claude', { op: 'list' }, mgr);
    const listData = JSON.parse(listClaude.content[0].text) as { sessions: Array<{ session: string }> };
    expect(listData.sessions.map((s) => s.session)).toEqual([claudeSession.id]);

    const abortCross = await handleToolCall('claude', { op: 'abort', session: codexSession.id }, mgr);
    expect(abortCross.isError).toBe(true);

    const waitCross = await handleToolCall(
      'claude',
      { op: 'wait', sessions: [codexSession.id], timeout_seconds: 1 },
      mgr,
    );
    expect(waitCross.isError).toBe(true);
    expect(waitCross.content[0].text).toContain('does not belong to provider "claude"');
  });

  it('returns isError for unknown tool names', async () => {
    const result = await handleToolCall('unknown-tool', { op: 'list' }, mgr);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool: unknown-tool');
  });
});

describe('ax provider isolation — handleWait mismatch via status file provider', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join('/tmp', 'coral-ax-isolation-'));
    mkdirSync(join(tmpDir, 'workspace'), { recursive: true });
    mkdirSync(join(tmpDir, 'agents'), { recursive: true });
    mkdirSync(join(tmpDir, 'skills', 'plan'), { recursive: true });
    resolverTest.setPluginRoot(tmpDir);
    mgr = new SessionManager(join(tmpDir, 'workspace'));
    activeSessions.clear();
    sessionDirs.clear();
  });

  afterEach(() => {
    resolverTest.setPluginRoot(defaultPluginRoot);
    activeSessions.clear();
    for (const d of sessionDirs) rmSync(d, { recursive: true, force: true });
    sessionDirs.clear();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('wait with claude provider rejects a session whose status.json says provider=codex', async () => {
    const { id, dir } = createSessionDir('codex-only', 'codex');
    sessionDirs.add(dir);

    const result = await handleToolCall('claude', { op: 'wait', sessions: [id], timeout_seconds: 1 }, mgr);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('does not belong to provider "claude"');
  });

  it('wait with mismatched provider still rejects even when session is in activeSessions', async () => {
    const { id, dir } = createSessionDir('active-codex', 'codex');
    sessionDirs.add(dir);
    activeSessions.set(id, {
      provider: 'codex',
      sessionDir: dir,
      controller: new AbortController(),
      sessionName: 'active-codex',
      terminalState: 'running',
    });

    const result = await handleToolCall('claude', { op: 'wait', sessions: [id], timeout_seconds: 1 }, mgr);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('does not belong to provider "claude"');
  });
});

describe('ax provider isolation — abort cross-provider', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join('/tmp', 'coral-ax-abort-'));
    mkdirSync(join(tmpDir, 'workspace'), { recursive: true });
    resolverTest.setPluginRoot(tmpDir);
    mgr = new SessionManager(join(tmpDir, 'workspace'));
    activeSessions.clear();
    sessionDirs.clear();
  });

  afterEach(() => {
    resolverTest.setPluginRoot(defaultPluginRoot);
    activeSessions.clear();
    for (const d of sessionDirs) rmSync(d, { recursive: true, force: true });
    sessionDirs.clear();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('abort via claude tool rejects a codex session ID', async () => {
    const { id, dir } = createSessionDir('codex-session', 'codex');
    sessionDirs.add(dir);
    activeSessions.set(id, {
      provider: 'codex',
      sessionDir: dir,
      controller: new AbortController(),
      sessionName: 'codex-session',
      terminalState: 'running',
    });

    const result = await handleToolCall('claude', { op: 'abort', session: id }, mgr);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No active execution found');
  });

  it('abort via codex tool does not abort a running claude controller', async () => {
    const { id, dir } = createSessionDir('claude-session', 'claude');
    sessionDirs.add(dir);
    const controller = new AbortController();
    activeSessions.set(id, {
      provider: 'claude',
      sessionDir: dir,
      controller,
      sessionName: 'claude-session',
      terminalState: 'running',
    });

    await handleToolCall('codex', { op: 'abort', session: id }, mgr);

    expect(controller.signal.aborted).toBe(false);
  });
});

describe('ax provider isolation — handleClaudeSessionList active-session status', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join('/tmp', 'coral-ax-list-'));
    mkdirSync(join(tmpDir, 'workspace'), { recursive: true });
    resolverTest.setPluginRoot(tmpDir);
    mgr = new SessionManager(join(tmpDir, 'workspace'));
    activeSessions.clear();
    sessionDirs.clear();
  });

  afterEach(() => {
    resolverTest.setPluginRoot(defaultPluginRoot);
    activeSessions.clear();
    for (const d of sessionDirs) rmSync(d, { recursive: true, force: true });
    sessionDirs.clear();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('claude list shows "completed" for a session registered under codex in activeSessions', async () => {
    const { id, dir } = createSessionDir('shared-label', 'claude');
    sessionDirs.add(dir);
    mgr.register('claude', id, 'shared-label', 'thread-shared', 'sonnet', process.cwd());
    activeSessions.set(id, {
      provider: 'codex',
      sessionDir: dir,
      controller: new AbortController(),
      sessionName: 'shared-label',
      terminalState: 'running',
    });

    const result = await handleToolCall('claude', { op: 'list' }, mgr);
    expect(result.isError).toBe(false);

    const data = JSON.parse(result.content[0].text) as {
      sessions: Array<{ session: string; status: string }>;
    };
    const entry = data.sessions.find((s) => s.session === id);
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('completed');
  });
});

describe('ax launchJob — session_name injection beats adapter metadata', () => {
  beforeEach(() => {
    activeSessions.clear();
    sessionDirs.clear();
  });

  afterEach(() => {
    activeSessions.clear();
    for (const d of sessionDirs) rmSync(d, { recursive: true, force: true });
    sessionDirs.clear();
  });

  it('launchJob sessionLabel overrides session_name from extractCompletion metadata', async () => {
    const mgrMock = { register: vi.fn() } as unknown as SessionManager;

    const launched = launchJob({
      provider: 'claude',
      sessionLabel: 'canonical-name',
      workingDirectory: '/tmp/work',
      handler: async (): Promise<McpResult> => ({
        content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
        isError: false,
      }),
      mgr: mgrMock,
      makeOnEvent: () => () => {},
      extractCompletion: () => ({
        responseText: 'response',
        metadata: { model: 'sonnet', session_name: 'adapter-injected-name' },
        sessionId: 'thread-1',
      }),
    });

    const launchData = parseLaunch(launched);
    sessionDirs.add(launchData.session_dir);

    await sleep(30);

    const status = JSON.parse(readFileSync(join(launchData.session_dir, 'status.json'), 'utf-8'));
    expect(status.status).toBe('completed');
    expect(status.session_name).toBe('canonical-name');
  });
});

describe('ax claude exec with missing session_id — non_resumable path', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join('/tmp', 'coral-ax-nonresumable-'));
    mkdirSync(join(tmpDir, 'workspace'), { recursive: true });
    resolverTest.setPluginRoot(tmpDir);
    mgr = new SessionManager(join(tmpDir, 'workspace'));
    activeSessions.clear();
    sessionDirs.clear();
    mockExecuteClaudeOneShot.mockReset();
  });

  afterEach(() => {
    resolverTest.setPluginRoot(defaultPluginRoot);
    activeSessions.clear();
    for (const d of sessionDirs) rmSync(d, { recursive: true, force: true });
    sessionDirs.clear();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('claude exec with no session_id: status.json gets non_resumable=true, session not registered', async () => {
    mockExecuteClaudeOneShot.mockResolvedValue({
      response: 'answer',
      sessionId: null,
      model: 'sonnet',
      durationMs: 5,
      costUsd: 0.001,
      aborted: false,
    });

    const result = await handleToolCall('claude', { op: 'exec', prompt: 'What is 1+1?' }, mgr);
    expect(result.isError).toBe(false);

    const launchData = parseLaunch(result);
    sessionDirs.add(launchData.session_dir);

    await sleep(50);

    const status = JSON.parse(readFileSync(join(launchData.session_dir, 'status.json'), 'utf-8'));
    expect(status.status).toBe('completed');
    expect(status.non_resumable).toBe(true);
    expect(mgr.list('claude').find((s) => s.id === launchData.session)).toBeUndefined();
  });

  it('claude exec with session_id: non_resumable is absent from status.json', async () => {
    mockExecuteClaudeOneShot.mockResolvedValue({
      response: 'answer',
      sessionId: 'real-session-id',
      model: 'sonnet',
      durationMs: 5,
      costUsd: 0.001,
      aborted: false,
    });

    const result = await handleToolCall('claude', { op: 'exec', prompt: 'Hello', name: 'my-test-session' }, mgr);
    expect(result.isError).toBe(false);

    const launchData = parseLaunch(result);
    sessionDirs.add(launchData.session_dir);

    await sleep(50);

    const status = JSON.parse(readFileSync(join(launchData.session_dir, 'status.json'), 'utf-8'));
    expect(status.status).toBe('completed');
    expect(status.non_resumable).toBeUndefined();
  });
});

describe('ax provider isolation — wait with multiple sessions where one mismatches', () => {
  beforeEach(() => {
    activeSessions.clear();
    sessionDirs.clear();
  });

  afterEach(() => {
    activeSessions.clear();
    for (const d of sessionDirs) rmSync(d, { recursive: true, force: true });
    sessionDirs.clear();
  });

  it('returns error immediately when first session in list mismatches provider', async () => {
    const mismatch = createSessionDir('codex-owned', 'codex');
    const owned = createSessionDir('claude-owned', 'claude');
    sessionDirs.add(mismatch.dir);
    sessionDirs.add(owned.dir);

    const result = await handleToolCall('claude', {
      op: 'wait',
      sessions: [mismatch.id, owned.id],
      timeout_seconds: 1,
    }, new SessionManager(process.cwd()));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('does not belong to provider "claude"');
  });

  it('wait for two sessions both owned by claude succeeds', async () => {
    const s1 = createSessionDir('claude-s1', 'claude');
    const s2 = createSessionDir('claude-s2', 'claude');
    sessionDirs.add(s1.dir);
    sessionDirs.add(s2.dir);

    setTimeout(() => writeSessionResult(s1.dir, 'done', { session_name: 'claude-s1' }), 30);

    const result = await handleToolCall('claude', {
      op: 'wait',
      sessions: [s1.id, s2.id],
      timeout_seconds: 2,
    }, new SessionManager(process.cwd()));

    expect(result.isError).toBe(false);
  });
});

describe('ax extractClaudeCompletionData — session_name from exec name input, not CLI output', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join('/tmp', 'coral-ax-completion-'));
    mkdirSync(join(tmpDir, 'workspace'), { recursive: true });
    resolverTest.setPluginRoot(tmpDir);
    mgr = new SessionManager(join(tmpDir, 'workspace'));
    activeSessions.clear();
    sessionDirs.clear();
    mockExecuteClaudeOneShot.mockReset();
  });

  afterEach(() => {
    resolverTest.setPluginRoot(defaultPluginRoot);
    activeSessions.clear();
    for (const d of sessionDirs) rmSync(d, { recursive: true, force: true });
    sessionDirs.clear();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('status.json session_name matches the exec name input, not a value from CLI output', async () => {
    mockExecuteClaudeOneShot.mockResolvedValue({
      response: 'response text',
      sessionId: 'thread-xyz',
      model: 'sonnet',
      durationMs: 5,
      costUsd: 0.001,
      aborted: false,
    });

    const result = await handleToolCall('claude', { op: 'exec', prompt: 'Do something', name: 'user-chosen-name' }, mgr);
    expect(result.isError).toBe(false);

    const launchData = parseLaunch(result);
    sessionDirs.add(launchData.session_dir);

    await sleep(50);

    const status = JSON.parse(readFileSync(join(launchData.session_dir, 'status.json'), 'utf-8'));
    expect(status.session_name).toBe('user-chosen-name');
  });
});
