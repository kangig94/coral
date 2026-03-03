import { describe, it, expect, vi, afterEach } from 'vitest';
import { join } from 'node:path';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  it('accepts any session regardless of provider', async () => {
    const { id, dir } = createSessionDir('owned-by-codex', 'codex');
    dirsToClean.add(dir);
    writeSessionResult(dir, 'done', { session_name: 'owned-by-codex' });

    const result = await handleWait({ sessions: [id], timeout_seconds: 1 });
    const data = JSON.parse(result.content[0].text) as { status: string; completed_session: string };
    expect(result.isError).toBe(false);
    expect(data.status).toBe('completed');
    expect(data.completed_session).toBe(id);
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

  it('returns error for unknown session directory', async () => {
    const unknownSession = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const result = await handleWait({ sessions: [unknownSession], timeout_seconds: 1 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(unknownSession);
  });

  it('timeout response uses running_sessions and omits legacy fields', async () => {
    const { id, dir } = createSessionDir('timeout-session', 'codex');
    dirsToClean.add(dir);

    const result = await handleWait({ sessions: [id], timeout_seconds: 1 });
    const data = JSON.parse(result.content[0].text) as {
      status: string;
      running_sessions?: string[];
      running_jobs?: string[];
      cursors?: unknown;
    };

    expect(result.isError).toBe(false);
    expect(data.status).toBe('timeout');
    expect(data.running_sessions).toEqual([id]);
    expect(data.running_jobs).toBeUndefined();
    expect(data.cursors).toBeUndefined();
  }, 3000);

  it('completed response does not include cursors field', async () => {
    const { id, dir } = createSessionDir('completed-session', 'codex');
    dirsToClean.add(dir);
    writeSessionResult(dir, 'done', { session_name: 'completed-session' });

    const result = await handleWait({ sessions: [id], timeout_seconds: 1 });
    const data = JSON.parse(result.content[0].text) as {
      status: string;
      completed_session: string;
      cursors?: unknown;
    };

    expect(result.isError).toBe(false);
    expect(data.status).toBe('completed');
    expect(data.completed_session).toBe(id);
    expect(data.cursors).toBeUndefined();
  });

  it('progress notification dedup skips repeated messages', async () => {
    const { id, dir } = createSessionDir('wait-dedup', 'codex');
    dirsToClean.add(dir);
    const progressFile = join(dir, PROGRESS_FILE);
    const line = JSON.stringify({ event: 'thread.message.delta', message: 'same message' });
    writeFileSync(progressFile, `${line}\n${line}\n`, 'utf-8');
    writeSessionResult(dir, 'done', { session_name: 'wait-dedup' });

    const notify = vi.fn(async () => {});
    const result = await handleWait({ sessions: [id], timeout_seconds: 3 }, notify, 'progress-token');
    const data = JSON.parse(result.content[0].text) as { completed_session: string };

    expect(result.isError).toBe(false);
    expect(data.completed_session).toBe(id);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      method: 'notifications/progress',
      params: expect.objectContaining({
        message: '[wait-dedup] same message',
      }),
    }));
  });

  it('progress notification ignores trailing partial JSONL line', async () => {
    const { id, dir } = createSessionDir('wait-partial-line', 'codex');
    dirsToClean.add(dir);
    const progressFile = join(dir, PROGRESS_FILE);
    const completeLine = JSON.stringify({ event: 'thread.message.delta', message: 'complete message' });
    const partialLine = JSON.stringify({ event: 'thread.message.delta', message: 'partial message' });
    writeFileSync(progressFile, `${completeLine}\n${partialLine}`, 'utf-8');
    writeSessionResult(dir, 'done', { session_name: 'wait-partial-line' });

    const notify = vi.fn(async () => {});
    const result = await handleWait({ sessions: [id], timeout_seconds: 3 }, notify, 'progress-token');
    const data = JSON.parse(result.content[0].text) as { completed_session: string };

    expect(result.isError).toBe(false);
    expect(data.completed_session).toBe(id);
    expect(notify).toHaveBeenCalledTimes(1);
    const [firstArg] = notify.mock.calls[0] as unknown as [{ params?: { message?: string } }];
    expect(firstArg.params?.message).toBe('[wait-partial-line] complete message');
  });
});
