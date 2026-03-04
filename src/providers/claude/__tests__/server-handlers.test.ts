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
  };
});

import { executeClaudeOneShot, executeClaudeResume } from '../claude-executor.js';
import { handleClaudeOp, claudeAdapter, makeClaudeEventCallback } from '../server-handlers.js';
import { SessionManager } from '../../../runner/session-manager.js';
import { createSessionDir } from '../../../runner/progress.js';
import { activeSessions } from '../../../runner/job-manager.js';
import { _test as resolverTest, resolveCoralContent } from '../../../coral/resolver.js';

const mockExecuteClaudeOneShot = vi.mocked(executeClaudeOneShot);
const mockExecuteClaudeResume = vi.mocked(executeClaudeResume);

let tmpDir = '';
let mgr: SessionManager;
const sessionDirs = new Set<string>();
const defaultPluginRoot = process.cwd();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  it('coral create strips metadata into system prompt and forces bypass', async () => {
    const result = await claudeAdapter.handleCoralOp(
      'frontmatter',
      resolveCoralContent('frontmatter').content,
      { op: 'coral:frontmatter', prompt: 'Implement this', name: 'front-agent-session', effort: 'xhigh', bypass: false },
      mgr,
    );
    const launchData = JSON.parse(result.content[0].text) as { session_dir?: string };
    if (launchData.session_dir) sessionDirs.add(launchData.session_dir);

    expect(result.isError).toBe(false);
    await sleep(30);

    const [, options] = mockExecuteClaudeOneShot.mock.calls[0] ?? [];
    expect(options?.systemPrompt).toBe('# Frontmatter Agent\nBody text');
    expect(options?.effort).toBe('xhigh');
    expect(options?.bypassPermissions).toBe(true);
  });

  it('coral resume forwards bypassPermissions=true and defaults working_directory from session', async () => {
    const claudeSession = createSessionDir('claude-coral-resume', 'claude');
    sessionDirs.add(claudeSession.dir);
    mgr.register('claude', claudeSession.id, 'claude-coral-resume', 'thread-claude-coral-resume', 'sonnet', '/tmp/work');

    const result = await claudeAdapter.handleCoralOp(
      'architect',
      resolveCoralContent('architect').content,
      { op: 'coral:architect', prompt: 'continue', session: claudeSession.id, effort: 'high', bypass: false },
      mgr,
    );
    const launchData = JSON.parse(result.content[0].text) as { session_dir?: string };
    if (launchData.session_dir) sessionDirs.add(launchData.session_dir);

    expect(result.isError).toBe(false);
    await sleep(30);

    const [, , options] = mockExecuteClaudeResume.mock.calls[0] ?? [];
    expect(options?.workingDirectory).toBe('/tmp/work');
    expect(options?.effort).toBe('high');
    expect(options?.bypassPermissions).toBe(true);
    expect(options?.onEvent).toEqual(expect.any(Function));
  });

  it('direct exec create defaults bypassPermissions to false', async () => {
    const result = await handleClaudeOp({ op: 'exec', prompt: 'create default bypass', effort: 'medium' }, mgr);
    const launchData = JSON.parse(result.content[0].text) as { session_dir?: string };
    if (launchData.session_dir) sessionDirs.add(launchData.session_dir);

    expect(result.isError).toBe(false);
    await sleep(30);

    const [, options] = mockExecuteClaudeOneShot.mock.calls[0] ?? [];
    expect(options?.effort).toBe('medium');
    expect(options?.bypassPermissions).toBe(false);
    expect(options?.onEvent).toEqual(expect.any(Function));
  });

  it('direct exec create forwards bypassPermissions=true when bypass is true', async () => {
    const result = await handleClaudeOp({ op: 'exec', prompt: 'create bypass true', bypass: true }, mgr);
    const launchData = JSON.parse(result.content[0].text) as { session_dir?: string };
    if (launchData.session_dir) sessionDirs.add(launchData.session_dir);

    expect(result.isError).toBe(false);
    await sleep(30);

    const [, options] = mockExecuteClaudeOneShot.mock.calls[0] ?? [];
    expect(options?.bypassPermissions).toBe(true);
    expect(options?.onEvent).toEqual(expect.any(Function));
  });

  it('direct exec resume forwards effort to executeClaudeResume', async () => {
    const claudeSession = createSessionDir('claude-direct-resume', 'claude');
    sessionDirs.add(claudeSession.dir);
    mgr.register('claude', claudeSession.id, 'claude-direct-resume', 'thread-claude-direct-resume', 'sonnet', '/tmp/work');

    const result = await handleClaudeOp({
      op: 'exec',
      session: claudeSession.id,
      prompt: 'resume now',
      effort: 'high',
    }, mgr);
    const launchData = JSON.parse(result.content[0].text) as { session_dir?: string };
    if (launchData.session_dir) sessionDirs.add(launchData.session_dir);

    expect(result.isError).toBe(false);
    await sleep(30);

    const [, , options] = mockExecuteClaudeResume.mock.calls[0] ?? [];
    expect(options?.effort).toBe('high');
    expect(options?.onEvent).toEqual(expect.any(Function));
  });

});
