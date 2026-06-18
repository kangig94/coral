import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { DirentLike, StoragePort } from '#src/infra/port-types.js';
import { runClaudeOneShotTurn } from '#src/providers/claude/one-shot.js';
import type { ProviderServerLease } from '#src/providers/contract.js';

type BrokerNotificationHandler = (msg: { method: string; params?: Record<string, unknown> }) => void;

function dirent(name: string, kind: 'file' | 'dir'): DirentLike {
  return {
    name,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('runClaudeOneShotTurn', () => {
  it('returns the completed turn, closes the broker session, and removes the transient JSONL', async () => {
    const home = '/home/user';
    const projectsRoot = join(home, '.claude', 'projects');
    const projectDir = join(projectsRoot, '-workspace-kb');
    const jsonlPath = join(projectDir, 'conversation-1.jsonl');
    const turnStarted = createDeferred<void>();
    const broker = { notify: null as BrokerNotificationHandler | null };

    const unlinkSync = vi.fn();
    const storage: Pick<StoragePort, 'existsSync' | 'readdirSync' | 'unlinkSync'> = {
      existsSync: (path) => path === projectsRoot || path === projectDir || path === jsonlPath,
      readdirSync: ((path: string) => {
        if (path === projectsRoot) {
          return [dirent('-workspace-kb', 'dir')];
        }
        if (path === projectDir) {
          return [dirent('conversation-1.jsonl', 'file')];
        }
        return [];
      }) as unknown as StoragePort['readdirSync'],
      unlinkSync,
    };

    const release = vi.fn();
    const rpc = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === 'session/ensure') {
        return {
          brokerSessionKey: 'broker-1',
          bootstrapSignature: {
            cwd: params.cwd,
            systemPromptHash: params.systemPromptHash,
            permissionMode: params.permissionMode,
          },
          sessionId: 'conversation-1',
          conversationRef: 'conversation-1',
          activeTurnId: null,
          initialized: true,
        };
      }

      if (method === 'turn/start') {
        turnStarted.resolve();
        return {
          brokerSessionKey: params.brokerSessionKey,
          brokerTurnId: params.brokerTurnId,
          sessionId: 'conversation-1',
          conversationRef: 'conversation-1',
        };
      }

      if (method === 'session/close') {
        return {
          brokerSessionKey: params.brokerSessionKey,
          closed: true,
        };
      }

      throw new Error(`unexpected RPC ${method}`);
    });
    const lease: ProviderServerLease = {
      rpc: rpc as ProviderServerLease['rpc'],
      subscribe(handler) {
        broker.notify = handler;
        return () => {};
      },
      release,
      closed: new Promise(() => {}),
    };

    const turn = runClaudeOneShotTurn(
      {
        storage,
        env: { claudeConfigDir: () => `${home}/.claude` },
        ids: {
          uuid: () => 'turn-1',
          sha256: (value) => `hash:${value}`,
        },
        acquireServer: vi.fn(async () => lease),
      },
      {
        cwd: '/workspace/kb',
        prompt: 'Classify this note.',
        permissionMode: 'auto',
      },
    );

    await turnStarted.promise;
    const notify = broker.notify;
    if (notify === null) {
      throw new Error('expected broker subscription');
    }
    notify({
      method: 'turn/completed',
      params: {
        brokerSessionKey: 'broker-1',
        brokerTurnId: 'turn-1',
        sessionId: 'conversation-1',
        conversationRef: 'conversation-1',
        result: 'done',
        model: null,
        durationMs: null,
        numTurns: null,
        costUsd: null,
        usage: null,
        isError: false,
        subtype: 'success',
      },
    });

    await expect(turn).resolves.toBe('done');
    expect(rpc.mock.calls.map(([method]) => method)).toEqual(['session/ensure', 'turn/start', 'session/close']);
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ permissionMode: 'auto' });
    expect(unlinkSync).toHaveBeenCalledWith(jsonlPath);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('ignores shared broker notifications until its session and turn are known', async () => {
    const home = '/home/user';
    const projectsRoot = join(home, '.claude', 'projects');
    const projectDir = join(projectsRoot, '-workspace-kb');
    const jsonlPath = join(projectDir, 'conversation-1.jsonl');
    const ensureStarted = createDeferred<void>();
    const releaseEnsure = createDeferred<void>();
    const turnStarted = createDeferred<void>();
    const broker = { notify: null as BrokerNotificationHandler | null };

    const unlinkSync = vi.fn();
    const storage: Pick<StoragePort, 'existsSync' | 'readdirSync' | 'unlinkSync'> = {
      existsSync: (path) => path === projectsRoot || path === projectDir || path === jsonlPath,
      readdirSync: ((path: string) => {
        if (path === projectsRoot) {
          return [dirent('-workspace-kb', 'dir')];
        }
        if (path === projectDir) {
          return [dirent('conversation-1.jsonl', 'file')];
        }
        return [];
      }) as unknown as StoragePort['readdirSync'],
      unlinkSync,
    };

    const rpc = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === 'session/ensure') {
        ensureStarted.resolve();
        await releaseEnsure.promise;
        return {
          brokerSessionKey: 'broker-1',
          bootstrapSignature: {
            cwd: params.cwd,
            systemPromptHash: params.systemPromptHash,
            permissionMode: params.permissionMode,
          },
          sessionId: 'conversation-1',
          conversationRef: 'conversation-1',
          activeTurnId: null,
          initialized: true,
        };
      }

      if (method === 'turn/start') {
        turnStarted.resolve();
        return {
          brokerSessionKey: params.brokerSessionKey,
          brokerTurnId: params.brokerTurnId,
          sessionId: 'conversation-1',
          conversationRef: 'conversation-1',
        };
      }

      if (method === 'session/close') {
        return {
          brokerSessionKey: params.brokerSessionKey,
          closed: true,
        };
      }

      throw new Error(`unexpected RPC ${method}`);
    });
    const lease: ProviderServerLease = {
      rpc: rpc as ProviderServerLease['rpc'],
      subscribe(handler) {
        broker.notify = handler;
        return () => {};
      },
      release: vi.fn(),
      closed: new Promise(() => {}),
    };

    const turn = runClaudeOneShotTurn(
      {
        storage,
        env: { claudeConfigDir: () => `${home}/.claude` },
        ids: {
          uuid: () => 'turn-1',
          sha256: (value) => `hash:${value}`,
        },
        acquireServer: vi.fn(async () => lease),
      },
      {
        cwd: '/workspace/kb',
        prompt: 'Classify this note.',
      },
    );

    await ensureStarted.promise;
    const notify = broker.notify;
    if (notify === null) {
      throw new Error('expected broker subscription');
    }
    notify({
      method: 'turn/completed',
      params: {
        brokerSessionKey: 'other-broker',
        brokerTurnId: 'other-turn',
        sessionId: 'other-conversation',
        conversationRef: 'other-conversation',
        result: 'wrong result',
        isError: false,
      },
    });

    releaseEnsure.resolve();
    await turnStarted.promise;
    notify({
      method: 'turn/completed',
      params: {
        brokerSessionKey: 'broker-1',
        brokerTurnId: 'turn-1',
        sessionId: 'conversation-1',
        conversationRef: 'conversation-1',
        result: 'right result',
        isError: false,
      },
    });

    await expect(turn).resolves.toBe('right result');
    expect(unlinkSync).toHaveBeenCalledWith(jsonlPath);
  });
});
