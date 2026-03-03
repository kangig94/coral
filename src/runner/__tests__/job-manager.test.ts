import { describe, it, expect, vi, afterEach } from 'vitest';
import { join } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { type McpResult, jsonResult } from '../../shared/mcp-utils.js';
import { launchJob, handleWait, activeSessions } from '../job-manager.js';
import {
  createSessionDir,
  appendProgressEvent,
  writeSessionResult,
  PROGRESS_FILE,
} from '../progress.js';
import type { SessionManager } from '../session-manager.js';

const dirsToClean = new Set<string>();

afterEach(() => {
  for (const dir of dirsToClean) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirsToClean.clear();
  activeSessions.clear();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('runner job-manager launchJob', () => {
  it('injects session_name in metadata and registers session when sessionId is provided', async () => {
    const mgr = { register: vi.fn() } as unknown as SessionManager;

    const launched = launchJob({
      provider: 'claude',
      sessionLabel: 'claude-session',
      workingDirectory: '/tmp/work',
      handler: async (): Promise<McpResult> => jsonResult({ ok: true }),
      mgr,
      makeOnEvent: () => () => {},
      extractCompletion: () => ({
        responseText: 'final response',
        metadata: { model: 'sonnet' },
        sessionId: 'thread-claude-1',
      }),
    });

    const launchData = JSON.parse(launched.content[0].text) as { session: string; session_dir: string };
    dirsToClean.add(launchData.session_dir);
    expect(activeSessions.get(launchData.session)?.provider).toBe('claude');

    await sleep(25);

    const status = JSON.parse(readFileSync(join(launchData.session_dir, 'status.json'), 'utf-8'));
    expect(status.status).toBe('completed');
    expect(status.session_name).toBe('claude-session');
    expect(mgr.register).toHaveBeenCalledWith(
      'claude',
      launchData.session,
      'claude-session',
      'thread-claude-1',
      'sonnet',
      '/tmp/work',
    );
  });

  it('does not register when completion has no sessionId and preserves non_resumable metadata', async () => {
    const mgr = { register: vi.fn() } as unknown as SessionManager;

    const launched = launchJob({
      provider: 'claude',
      sessionLabel: 'non-resumable',
      workingDirectory: '/tmp/work',
      handler: async (): Promise<McpResult> => jsonResult({ ok: true }),
      mgr,
      makeOnEvent: () => () => {},
      extractCompletion: () => ({
        responseText: 'output',
        metadata: { non_resumable: true },
      }),
    });

    const launchData = JSON.parse(launched.content[0].text) as { session_dir: string };
    dirsToClean.add(launchData.session_dir);

    await sleep(25);

    const status = JSON.parse(readFileSync(join(launchData.session_dir, 'status.json'), 'utf-8'));
    expect(status.non_resumable).toBe(true);
    expect(mgr.register).not.toHaveBeenCalled();
  });
});

describe('runner job-manager handleWait', () => {
  it('enforces provider ownership', async () => {
    const { id, dir } = createSessionDir('owned-by-codex', 'codex');
    dirsToClean.add(dir);

    const result = await handleWait('claude', { sessions: [id], timeout_seconds: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('does not belong to provider "claude"');
  });

  it('polls progress incrementally and completes when status becomes terminal', async () => {
    const { id, dir } = createSessionDir('claude-wait', 'claude');
    dirsToClean.add(dir);
    const progressFile = join(dir, PROGRESS_FILE);

    const notifications: string[] = [];
    const notify = vi.fn(async (n: { method: string; params: Record<string, unknown> }) => {
      notifications.push(String(n.params.message));
    });

    const waitPromise = handleWait(
      'claude',
      { sessions: [id], timeout_seconds: 3 },
      notify,
      'tok-1',
    );

    setTimeout(() => appendProgressEvent(progressFile, 'item.completed', 'First message'), 100);
    setTimeout(() => appendProgressEvent(progressFile, 'item.completed', 'Second message'), 200);
    setTimeout(() => writeSessionResult(dir, 'done', { session_name: 'claude-wait' }), 300);

    const result = await waitPromise;
    const data = JSON.parse(result.content[0].text);

    expect(data.status).toBe('completed');
    expect(notifications.some((m) => m.includes('First message'))).toBe(true);
    expect(notifications.some((m) => m.includes('Second message'))).toBe(true);
  });
});
