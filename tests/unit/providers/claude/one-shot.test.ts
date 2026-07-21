import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { DirentLike, StoragePort } from '#src/infra/port-types.js';
import { runClaudeOneShotTurn } from '#src/providers/claude/one-shot.js';
import type { ProviderServerLease } from '#src/providers/contract.js';

type BrokerNotificationHandler = (msg: { method: string; params?: Record<string, unknown> }) => void;

function systemContext(configDir: string) {
  return {
    source: {
      version: 1 as const,
      provider: 'claude' as const,
      kind: 'config-dir' as const,
      configDir,
      projectsRoot: join(configDir, 'projects'),
    },
    brokerEnv: {},
    controllerEnv: { CLAUDE_CONFIG_DIR: configDir },
    projectsRoot: join(configDir, 'projects'),
  };
}

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
        providerContext: systemContext(`${home}/.claude`),
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
        providerContext: systemContext(`${home}/.claude`),
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

  it('does not let a stale turn notification change the transient JSONL cleanup target', async () => {
    const home = '/home/user';
    const projectsRoot = join(home, '.claude', 'projects');
    const projectDir = join(projectsRoot, '-workspace-kb');
    const jsonlPath = join(projectDir, 'conversation-1.jsonl');
    const staleJsonlPath = join(projectDir, 'stale-conversation.jsonl');
    const turnStarted = createDeferred<void>();
    const broker = { notify: null as BrokerNotificationHandler | null };

    const unlinkSync = vi.fn();
    const storage: Pick<StoragePort, 'existsSync' | 'readdirSync' | 'unlinkSync'> = {
      existsSync: (path) =>
        path === projectsRoot || path === projectDir || path === jsonlPath || path === staleJsonlPath,
      readdirSync: ((path: string) => {
        if (path === projectsRoot) {
          return [dirent('-workspace-kb', 'dir')];
        }
        if (path === projectDir) {
          return [dirent('conversation-1.jsonl', 'file'), dirent('stale-conversation.jsonl', 'file')];
        }
        return [];
      }) as unknown as StoragePort['readdirSync'],
      unlinkSync,
    };

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
      release: vi.fn(),
      closed: new Promise(() => {}),
    };

    const turn = runClaudeOneShotTurn(
      {
        storage,
        providerContext: systemContext(`${home}/.claude`),
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

    await turnStarted.promise;
    await Promise.resolve();
    await Promise.resolve();
    const notify = broker.notify;
    if (notify === null) {
      throw new Error('expected broker subscription');
    }
    notify({
      method: 'turn/completed',
      params: {
        brokerSessionKey: 'broker-1',
        brokerTurnId: 'stale-turn',
        sessionId: 'stale-conversation',
        conversationRef: 'stale-conversation',
        result: 'stale result',
        isError: false,
      },
    });
    notify({
      method: 'turn/completed',
      params: {
        brokerSessionKey: 'broker-1',
        brokerTurnId: 'turn-1',
        result: 'right result',
        isError: false,
      },
    });

    await expect(turn).resolves.toBe('right result');
    expect(unlinkSync).toHaveBeenCalledTimes(1);
    expect(unlinkSync).toHaveBeenCalledWith(jsonlPath);
  });

  it('keeps the requested turn id when turn/start omits it from the response', async () => {
    const home = '/home/user';
    const projectsRoot = join(home, '.claude', 'projects');
    const projectDir = join(projectsRoot, '-workspace-kb');
    const jsonlPath = join(projectDir, 'conversation-1.jsonl');
    const turnStarted = createDeferred<void>();
    const brokerClosed = createDeferred<Error | void>();
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
      closed: brokerClosed.promise,
    };

    const turn = runClaudeOneShotTurn(
      {
        storage,
        providerContext: systemContext(`${home}/.claude`),
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

    await turnStarted.promise;
    await Promise.resolve();
    await Promise.resolve();
    const notify = broker.notify;
    if (notify === null) {
      throw new Error('expected broker subscription');
    }
    notify({
      method: 'turn/completed',
      params: {
        brokerSessionKey: 'broker-1',
        brokerTurnId: 'turn-1',
        result: 'right result',
        isError: false,
      },
    });
    brokerClosed.resolve(new Error('broker closed after ignored completion'));

    await expect(turn).resolves.toBe('right result');
    expect(unlinkSync).toHaveBeenCalledWith(jsonlPath);
  });

  it('fails before turn/start when session/ensure omits the broker session key', async () => {
    const storage: Pick<StoragePort, 'existsSync' | 'readdirSync' | 'unlinkSync'> = {
      existsSync: () => false,
      readdirSync: (() => []) as unknown as StoragePort['readdirSync'],
      unlinkSync: vi.fn(),
    };
    const rpc = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === 'session/ensure') {
        return {
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
      throw new Error(`unexpected RPC ${method}`);
    });
    const release = vi.fn();
    const lease: ProviderServerLease = {
      rpc: rpc as ProviderServerLease['rpc'],
      subscribe: () => () => {},
      release,
      closed: new Promise(() => {}),
    };

    await expect(
      runClaudeOneShotTurn(
        {
          storage,
          providerContext: systemContext('/home/user/.claude'),
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
      ),
    ).rejects.toThrow('broker session key missing');
    expect(rpc.mock.calls.map(([method]) => method)).toEqual(['session/ensure']);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
