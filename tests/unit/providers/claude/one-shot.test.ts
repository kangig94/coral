import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { DirentLike, StoragePort } from '#src/infra/port-types.js';
import { claudeCurationCapability } from '#src/providers/claude/one-shot.js';
import type { ProviderServerSpec, AppServerSession } from '#src/providers/contract.js';
import { claudeAppServerLifecycle } from '#src/providers/claude/provider-facets.js';

beforeAll(() => vi.stubGlobal('__PLUGIN_ROOT__', '/test/plugin'));
afterAll(() => vi.unstubAllGlobals());

type BrokerNotificationHandler = (msg: { method: string; params?: Record<string, unknown> }) => void;

function systemContext(configDir: string) {
  return {
    access: {
      configDir,
      projectsRoot: join(configDir, 'projects'),
      routing: { kind: 'config-dir' as const },
    },
    brokerEnv: {},
    controllerEnv: { CLAUDE_CONFIG_DIR: configDir },
    projectsRoot: join(configDir, 'projects'),
  };
}

async function runClaudeOneShotTurn(
  deps: {
    readonly storage: Parameters<typeof claudeCurationCapability.prepare>[1]['storage'];
    readonly ids: Parameters<typeof claudeCurationCapability.prepare>[1]['ids'];
    readonly executionPlan: ReturnType<typeof systemContext>;
    readonly openServer: (spec: ProviderServerSpec) => Promise<AppServerSession>;
  },
  request: Parameters<typeof claudeCurationCapability.prepare>[0],
) {
  const hostPlan = claudeAppServerLifecycle.planHost({
    purpose: 'curation',
    access: deps.executionPlan.access,
    request,
    baseEnv: deps.executionPlan.brokerEnv,
    platform: 'linux',
    storage: deps.storage,
  });
  const prepared = claudeCurationCapability.prepare(request, {
    storage: deps.storage,
    ids: deps.ids,
    access: deps.executionPlan.access,
    baseEnv: deps.executionPlan.brokerEnv,
    platform: 'linux',
  });
  const appServerSession = await deps.openServer(claudeAppServerLifecycle.compileStableHost(hostPlan));
  return prepared.complete({ appServerSession });
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
  it('accepts a lifecycle interrupt request only for the exact broker turn response', async () => {
    const transport = (brokerTurnId: string): AppServerSession => ({
      rpc: async <R>() => ({ interrupted: true, brokerTurnId }) as R,
      subscribe: () => () => {},
      closed: Promise.resolve(),
      interrupt: async () => ({ kind: 'not-accepted', reason: 'test refusal' }),
    });
    const continuity = { brokerSessionKey: 'broker-1', brokerTurnId: 'turn-1' };

    await expect(claudeAppServerLifecycle.interrupt?.(transport('turn-other'), continuity)).resolves.toMatchObject({
      kind: 'not-accepted',
    });
    await expect(claudeAppServerLifecycle.interrupt?.(transport('turn-1'), continuity)).resolves.toEqual({
      kind: 'accepted',
    });
  });

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

    const rpc = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === 'session/ensure') {
        return {
          brokerSessionKey: 'broker-1',
          bootstrapSignature: {
            cwd: params.cwd,
            systemPromptHash: params.systemPromptHash,

            bootstrapConfigHash: params.bootstrapConfigHash,
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
    const lease: AppServerSession = {
      rpc: rpc as AppServerSession['rpc'],
      subscribe(handler) {
        broker.notify = handler;
        return () => {};
      },
      closed: new Promise(() => {}),
      interrupt: (continuity) =>
        Promise.resolve(rpc('turn/interrupt', continuity)).then(() => ({ kind: 'accepted' as const })),
    };

    const turn = runClaudeOneShotTurn(
      {
        storage,
        executionPlan: systemContext(`${home}/.claude`),
        ids: {
          uuid: () => 'turn-1',
          sha256: (value) => `hash:${value}`,
        },
        openServer: vi.fn(async () => lease),
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

            bootstrapConfigHash: params.bootstrapConfigHash,
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
    const lease: AppServerSession = {
      rpc: rpc as AppServerSession['rpc'],
      subscribe(handler) {
        broker.notify = handler;
        return () => {};
      },
      closed: new Promise(() => {}),
      interrupt: (continuity) =>
        Promise.resolve(rpc('turn/interrupt', continuity)).then(() => ({ kind: 'accepted' as const })),
    };

    const turn = runClaudeOneShotTurn(
      {
        storage,
        executionPlan: systemContext(`${home}/.claude`),
        ids: {
          uuid: () => 'turn-1',
          sha256: (value) => `hash:${value}`,
        },
        openServer: vi.fn(async () => lease),
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

            bootstrapConfigHash: params.bootstrapConfigHash,
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
    const lease: AppServerSession = {
      rpc: rpc as AppServerSession['rpc'],
      subscribe(handler) {
        broker.notify = handler;
        return () => {};
      },
      closed: new Promise(() => {}),
      interrupt: (continuity) =>
        Promise.resolve(rpc('turn/interrupt', continuity)).then(() => ({ kind: 'accepted' as const })),
    };

    const turn = runClaudeOneShotTurn(
      {
        storage,
        executionPlan: systemContext(`${home}/.claude`),
        ids: {
          uuid: () => 'turn-1',
          sha256: (value) => `hash:${value}`,
        },
        openServer: vi.fn(async () => lease),
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

  it('rejects turn/start responses that omit the requested turn id', async () => {
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

            bootstrapConfigHash: params.bootstrapConfigHash,
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
    const lease: AppServerSession = {
      rpc: rpc as AppServerSession['rpc'],
      subscribe(handler) {
        broker.notify = handler;
        return () => {};
      },
      closed: brokerClosed.promise,
      interrupt: (continuity) =>
        Promise.resolve(rpc('turn/interrupt', continuity)).then(() => ({ kind: 'accepted' as const })),
    };

    const turn = runClaudeOneShotTurn(
      {
        storage,
        executionPlan: systemContext(`${home}/.claude`),
        ids: {
          uuid: () => 'turn-1',
          sha256: (value) => `hash:${value}`,
        },
        openServer: vi.fn(async () => lease),
      },
      {
        cwd: '/workspace/kb',
        prompt: 'Classify this note.',
      },
    );

    await turnStarted.promise;
    await expect(turn).rejects.toThrow('did not return the exact requested broker turn id');
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

            bootstrapConfigHash: params.bootstrapConfigHash,
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
    const lease: AppServerSession = {
      rpc: rpc as AppServerSession['rpc'],
      subscribe: () => () => {},
      closed: new Promise(() => {}),
      interrupt: (continuity) =>
        Promise.resolve(rpc('turn/interrupt', continuity)).then(() => ({ kind: 'accepted' as const })),
    };

    await expect(
      runClaudeOneShotTurn(
        {
          storage,
          executionPlan: systemContext('/home/user/.claude'),
          ids: {
            uuid: () => 'turn-1',
            sha256: (value) => `hash:${value}`,
          },
          openServer: vi.fn(async () => lease),
        },
        {
          cwd: '/workspace/kb',
          prompt: 'Classify this note.',
        },
      ),
    ).rejects.toThrow('broker session key missing');
    expect(rpc.mock.calls.map(([method]) => method)).toEqual(['session/ensure']);
  });

  it('interrupts the exact reserved turn and closes the session when aborted during a hung turn/start', async () => {
    const controller = new AbortController();
    const turnStarted = createDeferred<void>();
    const storage: Pick<StoragePort, 'existsSync' | 'readdirSync' | 'unlinkSync'> = {
      existsSync: () => false,
      readdirSync: (() => []) as unknown as StoragePort['readdirSync'],
      unlinkSync: vi.fn(),
    };
    const rpc = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === 'session/ensure') {
        return {
          brokerSessionKey: 'broker-1',
          bootstrapSignature: {
            cwd: params.cwd,
            systemPromptHash: params.systemPromptHash,

            bootstrapConfigHash: params.bootstrapConfigHash,
            permissionMode: params.permissionMode,
          },
          sessionId: 'conversation-1',
          conversationRef: 'conversation-1',
        };
      }
      if (method === 'turn/start') {
        turnStarted.resolve();
        return await new Promise<never>(() => {});
      }
      if (method === 'session/close') {
        return { brokerSessionKey: params.brokerSessionKey, closed: true };
      }
      throw new Error(`unexpected RPC ${method}`);
    });
    const interrupt = vi.fn(async () => ({ kind: 'accepted' as const }));
    const lease: AppServerSession = {
      rpc: rpc as AppServerSession['rpc'],
      subscribe: () => () => {},
      closed: new Promise(() => {}),
      interrupt,
    };

    const turn = runClaudeOneShotTurn(
      {
        storage,
        executionPlan: systemContext('/home/user/.claude'),
        ids: { uuid: () => 'turn-1', sha256: (value) => `hash:${value}` },
        openServer: vi.fn(async () => lease),
      },
      { cwd: '/workspace/kb', prompt: 'Classify this note.', signal: controller.signal },
    );
    await turnStarted.promise;
    controller.abort('cancel-curation');

    await expect(turn).rejects.toThrow();
    expect(interrupt).toHaveBeenCalledWith({ brokerSessionKey: 'broker-1', brokerTurnId: 'turn-1' });
    expect(rpc).toHaveBeenCalledWith('session/close', { brokerSessionKey: 'broker-1' });
  });

  it.each([
    {
      name: 'persistent false responses',
      interrupt: () => Promise.resolve({ kind: 'not-accepted' as const, reason: 'test refusal' }),
      close: (brokerSessionKey: unknown) => Promise.resolve({ brokerSessionKey, closed: false }),
    },
    {
      name: 'throwing cancellation operations',
      interrupt: () => Promise.reject(new Error('interrupt unavailable')),
      close: () => Promise.reject(new Error('close unavailable')),
    },
  ])('does not report one-shot cancellation as confirmed after $name', async ({ interrupt, close }) => {
    const controller = new AbortController();
    const turnStarted = createDeferred<void>();
    const storage: Pick<StoragePort, 'existsSync' | 'readdirSync' | 'unlinkSync'> = {
      existsSync: () => false,
      readdirSync: (() => []) as unknown as StoragePort['readdirSync'],
      unlinkSync: vi.fn(),
    };
    const rpc = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === 'session/ensure') {
        return {
          brokerSessionKey: 'broker-1',
          bootstrapSignature: {
            cwd: params.cwd,
            systemPromptHash: params.systemPromptHash,
            bootstrapConfigHash: params.bootstrapConfigHash,
            permissionMode: params.permissionMode,
          },
          sessionId: 'conversation-1',
          conversationRef: 'conversation-1',
        };
      }
      if (method === 'turn/start') {
        turnStarted.resolve();
        return await new Promise<never>(() => {});
      }
      if (method === 'session/close') return await close(params.brokerSessionKey);
      throw new Error(`unexpected RPC ${method}`);
    });
    const interruptMock = vi.fn(interrupt);
    const lease: AppServerSession = {
      rpc: rpc as AppServerSession['rpc'],
      subscribe: () => () => {},
      closed: new Promise(() => {}),
      interrupt: interruptMock,
    };

    const turn = runClaudeOneShotTurn(
      {
        storage,
        executionPlan: systemContext('/home/user/.claude'),
        ids: { uuid: () => 'turn-1', sha256: (value) => `hash:${value}` },
        openServer: vi.fn(async () => lease),
      },
      { cwd: '/workspace/kb', prompt: 'Classify this note.', signal: controller.signal },
    );
    await turnStarted.promise;
    controller.abort('cancel-curation');

    await expect(turn).rejects.toThrow('could not be confirmed cancelled');
    expect(interruptMock).toHaveBeenCalledWith({ brokerSessionKey: 'broker-1', brokerTurnId: 'turn-1' });
    expect(rpc).toHaveBeenCalledWith('session/close', { brokerSessionKey: 'broker-1' });
  });
});
