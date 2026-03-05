import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../codex/cli-detection.js', () => ({
  detectCodexCli: vi.fn(async () => ({ available: true, version: 'codex 1.0.0', authState: 'authenticated' })),
}));

vi.mock('../codex/codex-executor.js', () => ({
  executeOneShot: vi.fn(async () => ({
    response: 'codex response',
    sessionId: 'codex-thread',
    model: 'o4-mini',
    durationMs: 5,
    exitCode: 0,
    errors: [],
    warnings: [],
    aborted: false,
  })),
  executeResume: vi.fn(async () => ({
    response: 'codex resume',
    sessionId: 'codex-thread-resume',
    model: 'o4-mini',
    durationMs: 5,
    exitCode: 0,
    errors: [],
    warnings: [],
    aborted: false,
  })),
  executeFork: vi.fn(async () => ({
    response: 'codex fork',
    sessionId: 'codex-thread-fork',
    model: 'o4-mini',
    durationMs: 5,
    exitCode: 0,
    errors: [],
    warnings: [],
    aborted: false,
  })),
}));

vi.mock('../claude/cli-detection.js', () => ({
  detectClaudeCli: vi.fn(async () => ({ available: true, version: '2.1.63', authState: 'authenticated' })),
}));

vi.mock('../claude/claude-executor.js', () => ({
  executeClaudeOneShot: vi.fn(async () => ({
    response: 'claude response',
    sessionId: 'claude-thread',
    model: 'sonnet',
    durationMs: 5,
    costUsd: 0.001,
    aborted: false,
  })),
  executeClaudeResume: vi.fn(async () => ({
    response: 'claude resume',
    sessionId: 'claude-thread-resume',
    model: 'sonnet',
    durationMs: 5,
    costUsd: 0.001,
    aborted: false,
  })),
}));

import { executeOneShot } from '../codex/codex-executor.js';
import { executeClaudeOneShot } from '../claude/claude-executor.js';
import { codexAdapter } from '../codex/server-handlers.js';
import { claudeAdapter } from '../claude/server-handlers.js';
import { SessionManager } from '../../runner/session-manager.js';
import { jsonResult } from '../../shared/mcp-utils.js';

const mockExecuteOneShot = vi.mocked(executeOneShot);
const mockExecuteClaudeOneShot = vi.mocked(executeClaudeOneShot);

let tmpDir = '';
const sessionDirs = new Set<string>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trackSessionDir(resultText: string): void {
  const parsed = JSON.parse(resultText) as { session_dir?: string };
  if (parsed.session_dir) sessionDirs.add(parsed.session_dir);
}

describe('provider parity', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join('/tmp', 'coral-provider-parity-'));
    mkdirSync(join(tmpDir, 'workspace'), { recursive: true });
    sessionDirs.clear();
    mockExecuteOneShot.mockClear();
    mockExecuteClaudeOneShot.mockClear();
  });

  afterEach(() => {
    for (const dir of sessionDirs) rmSync(dir, { recursive: true, force: true });
    sessionDirs.clear();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('codex coral injection prepends content and forces bypass', async () => {
    const mgr = new SessionManager(join(tmpDir, 'workspace'));
    const result = await codexAdapter.handleCoralOp(
      'architect',
      '# Architect\nAgent body',
      { op: 'coral:architect', prompt: 'Run checks', bypass: false },
      mgr,
    );
    trackSessionDir(result.content[0].text);
    await sleep(30);

    expect(mockExecuteOneShot).toHaveBeenCalledTimes(1);
    const calledPrompt = mockExecuteOneShot.mock.calls[0]?.[0];
    const calledBypass = mockExecuteOneShot.mock.calls[0]?.[4];
    expect(calledPrompt).toContain('# Architect\nAgent body');
    expect(calledPrompt).toContain('\n\n---\n\nRun checks');
    expect(calledBypass).toBe(true);
  });

  it('claude coral injection uses pre-stripped system prompt and forces bypass', async () => {
    const mgr = new SessionManager(join(tmpDir, 'workspace'));
    const strippedPrompt = '# Claude Agent\nBody text';
    const result = await claudeAdapter.handleCoralOp(
      'architect',
      strippedPrompt,
      { op: 'coral:architect', prompt: 'Run checks', bypass: false },
      mgr,
    );
    trackSessionDir(result.content[0].text);
    await sleep(30);

    expect(mockExecuteClaudeOneShot).toHaveBeenCalledTimes(1);
    const [, options] = mockExecuteClaudeOneShot.mock.calls[0] ?? [];
    expect(options?.systemPrompt).toBe(strippedPrompt);
    expect(options?.bypassPermissions).toBe(true);
  });

  it('adapters expose consistent completion extraction shape', () => {
    const codex = codexAdapter.extractCompletion(jsonResult({
      response: 'codex text',
      thread_id: 'thread-codex',
      model: 'o4-mini',
      duration_ms: 5,
    }));
    const claude = claudeAdapter.extractCompletion(jsonResult({
      response: 'claude text',
      thread_id: 'thread-claude',
      model: 'sonnet',
      duration_ms: 5,
      cost_usd: 0.001,
    }));

    expect(codex).toEqual(expect.objectContaining({
      responseText: 'codex text',
      sessionId: 'thread-codex',
      metadata: expect.objectContaining({ thread_id: 'thread-codex' }),
    }));
    expect(claude).toEqual(expect.objectContaining({
      responseText: 'claude text',
      sessionId: 'thread-claude',
      metadata: expect.objectContaining({ thread_id: 'thread-claude' }),
    }));
  });

  it('claude completion extraction ignores legacy session field', () => {
    const legacy = claudeAdapter.extractCompletion(jsonResult({
      response: 'claude text',
      session: 'thread-legacy',
      model: 'sonnet',
      duration_ms: 5,
      cost_usd: 0.001,
    }));

    expect(legacy.sessionId).toBeUndefined();
    expect(legacy.metadata.thread_id).toBeUndefined();
  });
});
