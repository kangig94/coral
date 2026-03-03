import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { launchJob, handleWait, activeSessions } from '../../runner/job-manager.js';
import { createSessionDir, appendProgressEvent, writeSessionResult, PROGRESS_FILE } from '../../runner/progress.js';
import type { SessionManager } from '../../runner/session-manager.js';
import {
  activeChildren,
  spawnCli,
  CliBusyError,
  MAX_ACTIVE_CHILDREN,
  MAX_ACTIVE_CHILDREN_PER_PROVIDER,
} from '../../runner/engine.js';

const dirsToClean = new Set<string>();

afterEach(() => {
  activeSessions.clear();
  activeChildren.clear();
  for (const dir of dirsToClean) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirsToClean.clear();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLaunch(resultText: string): { session: string; session_dir: string } {
  return JSON.parse(resultText) as { session: string; session_dir: string };
}

describe('ax scalability and isolation', () => {
  it('handles mixed-provider 20-session load with provider-isolated wait', async () => {
    const mgr = { register: vi.fn() } as unknown as SessionManager;

    const codexSessions: string[] = [];
    const claudeSessions: string[] = [];

    for (let i = 0; i < 20; i += 1) {
      const provider = i % 2 === 0 ? 'codex' : 'claude';
      const launched = launchJob({
        provider,
        sessionLabel: `${provider}-${i}`,
        workingDirectory: process.cwd(),
        handler: async (_signal, onEvent) => {
          onEvent(JSON.stringify({ message: `${provider}-progress-${i}` }));
          await sleep(30 + (i % 5) * 10);
          return `done-${i}`;
        },
        mgr,
        makeOnEvent: ({ progressFile }) => (line: string) => {
          try {
            const parsed = JSON.parse(line) as { message?: unknown };
            if (typeof parsed.message === 'string') {
              appendProgressEvent(progressFile, 'progress', parsed.message);
            }
          } catch {
            // Ignore malformed progress lines in this test.
          }
        },
        extractCompletion: (result: string) => ({
          responseText: result,
          metadata: { model: 'test-model' },
          sessionId: `thread-${i}`,
        }),
      });

      const launchData = parseLaunch(launched.content[0].text);
      dirsToClean.add(launchData.session_dir);
      if (provider === 'codex') codexSessions.push(launchData.session);
      else claudeSessions.push(launchData.session);
    }

    const codexWait = await handleWait('codex', { sessions: codexSessions, timeout_seconds: 5 });
    const claudeWait = await handleWait('claude', { sessions: claudeSessions, timeout_seconds: 5 });

    expect(codexWait.isError).toBe(false);
    expect(claudeWait.isError).toBe(false);

    const crossWait = await handleWait('codex', { sessions: [claudeSessions[0]], timeout_seconds: 1 });
    expect(crossWait.isError).toBe(true);
    expect(crossWait.content[0].text).toContain('does not belong to provider "codex"');
  }, 15_000);

  it('enforces engine launch caps with structured busy error under overflow', async () => {
    for (let i = 0; i < MAX_ACTIVE_CHILDREN; i += 1) {
      activeChildren.add({ provider: i % 2 === 0 ? 'codex' : 'claude', child: {} as ChildProcess });
    }

    await expect(spawnCli({
      provider: 'claude',
      command: 'claude',
      args: ['-p'],
      prompt: 'test',
    })).rejects.toBeInstanceOf(CliBusyError);

    activeChildren.clear();
    for (let i = 0; i < MAX_ACTIVE_CHILDREN_PER_PROVIDER; i += 1) {
      activeChildren.add({ provider: 'claude', child: {} as ChildProcess });
    }

    await expect(spawnCli({
      provider: 'claude',
      command: 'claude',
      args: ['-p'],
      prompt: 'test',
    })).rejects.toBeInstanceOf(CliBusyError);
  });

  it('wait polling emits incremental progress updates instead of only terminal state', async () => {
    const { id, dir } = createSessionDir('incremental', 'codex');
    dirsToClean.add(dir);

    const progressFile = join(dir, PROGRESS_FILE);
    const notifications: string[] = [];

    const waitPromise = handleWait(
      'codex',
      { sessions: [id], timeout_seconds: 3 },
      async (n) => {
        notifications.push(String(n.params.message));
      },
      'tok-1',
    );

    setTimeout(() => {
      appendProgressEvent(progressFile, 'item.completed', 'first');
      appendProgressEvent(progressFile, 'item.completed', 'second');
    }, 100);
    setTimeout(() => writeSessionResult(dir, 'done', { session_name: 'incremental' }), 250);

    const result = await waitPromise;
    const data = JSON.parse(result.content[0].text) as { status: string };

    expect(result.isError).toBe(false);
    expect(data.status).toBe('completed');
    expect(notifications.some((msg) => msg.includes('first'))).toBe(true);
    expect(notifications.some((msg) => msg.includes('second'))).toBe(true);
  });
});
