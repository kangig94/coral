import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ProviderEventBody,
  ProviderRequest,
  ProviderRuntime,
  ProviderServerLease,
} from '#src/providers/contract.js';
import type { DirentLike, EnvPort, StoragePort } from '#src/infra/port-types.js';

const kernelInvocations = {
  exec: 0,
  session: 0,
};

const BASE_BOOTSTRAP_SIGNATURE = {
  cwd: '/workspace',
  systemPromptHash: 'sha256:system',
  permissionMode: 'default' as const,
};
const ORIGINAL_CORAL_DEV_ASSERTIONS = process.env.CORAL_DEV_ASSERTIONS;

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    action: 'exec',
    sessionId: 'job-claude-exec-provider',
    name: 'claude',
    prompt: 'Run the task',
    cwd: '/workspace',
    bypassPermissions: false,
    coralEnv: {},
    ...overrides,
  };
}

function makeLease(
  options: {
    rpcImpl?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  } = {},
): ProviderServerLease & {
  emit(message: { method: string; params?: Record<string, unknown> }): void;
  releaseMock: ReturnType<typeof vi.fn>;
  rpcMock: ReturnType<typeof vi.fn>;
} {
  const handlers = new Set<(message: { method: string; params?: Record<string, unknown> }) => void>();
  const rpcMock = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (options.rpcImpl) {
      return options.rpcImpl(method, params);
    }

    return {};
  });
  const releaseMock = vi.fn();

  return {
    rpc: rpcMock as unknown as ProviderServerLease['rpc'],
    subscribe: vi.fn((handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    }),
    release: releaseMock,
    closed: new Promise<Error | void>(() => {}),
    releaseMock,
    rpcMock,
    emit(message) {
      for (const handler of handlers) {
        handler(message);
      }
    },
  };
}

function makeRuntime(
  lease: ProviderServerLease,
  overrides: Partial<ProviderRuntime> = {},
): ProviderRuntime & {
  acquireServer: ReturnType<typeof vi.fn>;
  runCli: ReturnType<typeof vi.fn>;
} {
  return {
    signal: new AbortController().signal,
    time: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => {
        if (handle !== null) clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
    },
    runCli: vi.fn(async () => ({
      stdout: '',
      stderr: '',
      code: 0,
      aborted: false,
    })),
    ids: { uuid: () => 'test-uuid', sha256: () => 'sha256:fake' },
    storage: { existsSync: () => true } as unknown as ProviderRuntime['storage'],
    acquireServer: vi.fn(async () => lease),
    continuityBridge: {
      checkpoint: vi.fn(),
      transportClosed: vi.fn(),
    },
    ...overrides,
  } as ProviderRuntime & {
    acquireServer: ReturnType<typeof vi.fn>;
    runCli: ReturnType<typeof vi.fn>;
  };
}

function dirent(name: string, kind: 'file' | 'dir'): DirentLike {
  return {
    name,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
  };
}

function artifactStorage(tree: Record<string, DirentLike[]>): ProviderRuntime['storage'] {
  return {
    existsSync: (path) => Object.prototype.hasOwnProperty.call(tree, path),
    readdirSync: ((path: string) => tree[path] ?? []) as unknown as StoragePort['readdirSync'],
    readFileSync: () => '',
    statSync: (() => ({
      size: 0,
      mtimeMs: 0,
      isDirectory: () => false,
      isFile: () => true,
    })) as unknown as StoragePort['statSync'],
  };
}

function env(homedir = '/home/user'): Pick<EnvPort, 'homedir' | 'get' | 'fullSnapshot'> {
  return {
    homedir: () => homedir,
    get: () => undefined,
    fullSnapshot: () => ({}),
  };
}

async function collect(stream: AsyncIterable<ProviderEventBody>): Promise<ProviderEventBody[]> {
  const events: ProviderEventBody[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function getTerminal(events: ProviderEventBody[]) {
  const terminal = events.find((event) => event.kind === 'terminal');
  if (!terminal || terminal.kind !== 'terminal') {
    throw new Error('Terminal event missing.');
  }

  return terminal;
}

async function loadProvider() {
  vi.resetModules();
  const module = await import('#src/providers/claude/exec-provider.js');
  const originalExec = module.claudeExecProvider;
  const originalSession = module.claudeSessionProvider;

  module.claudeDispatchTargets.exec = (request, runtime) => {
    kernelInvocations.exec += 1;
    return originalExec(request, runtime);
  };
  module.claudeDispatchTargets.session = (request, runtime) => {
    kernelInvocations.session += 1;
    return originalSession(request, runtime);
  };

  return module;
}

beforeEach(() => {
  kernelInvocations.exec = 0;
  kernelInvocations.session = 0;
});

afterEach(() => {
  if (ORIGINAL_CORAL_DEV_ASSERTIONS === undefined) {
    delete process.env.CORAL_DEV_ASSERTIONS;
    return;
  }

  process.env.CORAL_DEV_ASSERTIONS = ORIGINAL_CORAL_DEV_ASSERTIONS;
});

describe('claude exec-provider dispatcher', () => {
  it('routes exec on empty persisted continuity to claudeSessionProvider', async () => {
    const { claude } = await loadProvider();
    const lease = makeLease({
      rpcImpl: async (method) => {
        if (method === 'session/ensure') {
          return {
            brokerSessionKey: 'broker-exec',
            bootstrapSignature: BASE_BOOTSTRAP_SIGNATURE,
            sessionId: null,
          };
        }
        if (method === 'turn/start') {
          return { brokerTurnId: 'turn-exec' };
        }

        throw new Error(`Unexpected RPC: ${method}`);
      },
    });
    const runtime = makeRuntime(lease);

    const eventsPromise = collect(claude(makeRequest(), runtime));

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
    });
    lease.emit({
      method: 'turn/completed',
      params: {
        brokerSessionKey: 'broker-exec',
        brokerTurnId: 'turn-exec',
        result: 'broker exec result',
        costUsd: 0.01,
      },
    });

    const terminal = getTerminal(await eventsPromise);

    expect(kernelInvocations.session).toBe(1);
    expect(kernelInvocations.exec).toBe(0);
    expect(runtime.acquireServer).toHaveBeenCalledTimes(1);
    expect(runtime.runCli).not.toHaveBeenCalled();
    expect(terminal.terminal).toMatchObject({
      content: 'broker exec result',
      outcome: { kind: 'completed' },
    });
  });

  it('routes resume on empty persisted continuity to claudeSessionProvider', async () => {
    const { claude } = await loadProvider();
    const lease = makeLease({
      rpcImpl: async (method, params) => {
        if (method === 'session/ensure') {
          expect(params.conversationRef).toBe('conversation-resume');
          return {
            brokerSessionKey: 'broker-resume',
            bootstrapSignature: BASE_BOOTSTRAP_SIGNATURE,
            sessionId: 'conversation-resume',
          };
        }
        if (method === 'turn/start') {
          return { brokerTurnId: 'turn-resume' };
        }

        throw new Error(`Unexpected RPC: ${method}`);
      },
    });
    const runtime = makeRuntime(lease);

    const eventsPromise = collect(
      claude(
        makeRequest({
          action: 'resume',
          conversationRef: 'conversation-resume',
        }),
        runtime,
      ),
    );

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
    });
    lease.emit({
      method: 'turn/completed',
      params: {
        brokerSessionKey: 'broker-resume',
        brokerTurnId: 'turn-resume',
        result: 'broker resume result',
        conversationRef: 'conversation-resume',
        costUsd: 0.02,
      },
    });

    const terminal = getTerminal(await eventsPromise);

    expect(kernelInvocations.session).toBe(1);
    expect(kernelInvocations.exec).toBe(0);
    expect(runtime.acquireServer).toHaveBeenCalledTimes(1);
    expect(runtime.runCli).not.toHaveBeenCalled();
    expect(terminal.terminal).toMatchObject({
      content: 'broker resume result',
      outcome: { kind: 'completed' },
    });
  });

  it('emits the concrete Claude JSONL artifact handle during normal live execution', async () => {
    const { claude } = await loadProvider();
    const projectsRoot = '/home/user/.claude/projects';
    const lease = makeLease({
      rpcImpl: async (method) => {
        if (method === 'session/ensure') {
          return {
            brokerSessionKey: 'broker-live',
            bootstrapSignature: BASE_BOOTSTRAP_SIGNATURE,
            sessionId: 'conversation-live',
          };
        }
        if (method === 'turn/start') {
          return { brokerTurnId: 'turn-live' };
        }

        throw new Error(`Unexpected RPC: ${method}`);
      },
    });
    const runtime = makeRuntime(lease, {
      env: env(),
      storage: artifactStorage({
        [projectsRoot]: [dirent('-workspace', 'dir')],
        [`${projectsRoot}/-workspace`]: [dirent('conversation-live.jsonl', 'file')],
      }),
    });

    const eventsPromise = collect(claude(makeRequest(), runtime));

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
    });
    lease.emit({
      method: 'turn/completed',
      params: {
        brokerSessionKey: 'broker-live',
        brokerTurnId: 'turn-live',
        result: 'broker live result',
      },
    });

    const events = await eventsPromise;

    expect(events).toContainEqual({
      kind: 'artifact_handle',
      handle: `${projectsRoot}/-workspace/conversation-live.jsonl`,
      identity: { kind: 'claude-jsonl', conversationRef: 'conversation-live' },
    });
    expect(getTerminal(events).terminal).toMatchObject({
      content: 'broker live result',
      outcome: { kind: 'completed' },
    });
  });

  it('routes fork with no persisted markers to claudeExecProvider', async () => {
    const { claude } = await loadProvider();
    const lease = makeLease();
    const runtime = makeRuntime(lease, {
      runCli: vi.fn(async () => ({
        stdout: JSON.stringify({
          type: 'result',
          result: 'fork result',
          session_id: 'fork-session-1',
          total_cost_usd: 0.03,
        }),
        stderr: '',
        code: 0,
        aborted: false,
      })),
    });

    const terminal = getTerminal(
      await collect(
        claude(
          makeRequest({
            action: 'fork',
            conversationRef: 'parent-session',
          }),
          runtime,
        ),
      ),
    );

    expect(kernelInvocations.exec).toBe(1);
    expect(kernelInvocations.session).toBe(0);
    expect(runtime.acquireServer).not.toHaveBeenCalled();
    expect(runtime.runCli).toHaveBeenCalledTimes(1);
    expect(terminal.terminal).toMatchObject({
      content: 'fork result',
      outcome: { kind: 'completed' },
    });
  });

  it.each([
    [
      'envHash',
      {
        envHash: 'sha256:env',
      },
    ],
    [
      'conversationRef',
      {
        conversationRef: 'persisted-conversation',
      },
    ],
    [
      'brokerTurnId',
      {
        brokerTurnId: 'persisted-turn',
      },
    ],
  ])(
    'routes fork marker-only continuity through claudeExecProvider when only %s is persisted',
    async (_label, persistedContinuity) => {
      delete process.env.CORAL_DEV_ASSERTIONS;

      const { claude } = await loadProvider();
      const lease = makeLease();
      const runtime = makeRuntime(lease, {
        persistedContinuity,
        runCli: vi.fn(async () => ({
          stdout: JSON.stringify({
            type: 'result',
            result: 'fork result',
            session_id: 'fork-session-1',
            total_cost_usd: 0.03,
          }),
          stderr: '',
          code: 0,
          aborted: false,
        })),
      });

      const terminal = getTerminal(
        await collect(
          claude(
            makeRequest({
              action: 'fork',
              conversationRef: 'parent-session',
            }),
            runtime,
          ),
        ),
      );

      expect(kernelInvocations.exec).toBe(1);
      expect(kernelInvocations.session).toBe(0);
      expect(runtime.acquireServer).not.toHaveBeenCalled();
      expect(runtime.runCli).toHaveBeenCalledTimes(1);
      expect(terminal.terminal).toMatchObject({
        content: 'fork result',
        outcome: { kind: 'completed' },
      });
    },
  );

  it.each([
    [
      'envHash',
      {
        envHash: 'sha256:env',
      },
    ],
    [
      'conversationRef',
      {
        conversationRef: 'persisted-conversation',
      },
    ],
    [
      'brokerTurnId',
      {
        brokerTurnId: 'persisted-turn',
      },
    ],
  ])('throws under CORAL_DEV_ASSERTIONS=1 when only %s is persisted for fork', async (_label, persistedContinuity) => {
    process.env.CORAL_DEV_ASSERTIONS = '1';

    const { claude } = await loadProvider();
    const lease = makeLease();
    const runtime = makeRuntime(lease, {
      persistedContinuity,
      env: {
        get: (key) => (key === 'CORAL_DEV_ASSERTIONS' ? '1' : undefined),
        homedir: () => '/mock/home',
        fullSnapshot: () => ({}),
      },
    });

    let assertion: unknown;
    try {
      claude(
        makeRequest({
          action: 'fork',
          conversationRef: 'parent-session',
        }),
        runtime,
      );
    } catch (error: unknown) {
      assertion = error;
    }

    expect(assertion).toMatchObject({
      name: 'AssertionError',
      message:
        'Claude fork received envHash, conversationRef, or brokerTurnId without brokerSessionKey or bootstrapSignature.',
    });
    expect(kernelInvocations.exec).toBe(0);
    expect(kernelInvocations.session).toBe(0);
    expect(runtime.acquireServer).not.toHaveBeenCalled();
    expect(runtime.runCli).not.toHaveBeenCalled();
  });

  it.each([
    [
      'brokerSessionKey',
      {
        brokerSessionKey: 'broker-established',
      },
    ],
    [
      'bootstrapSignature',
      {
        bootstrapSignature: BASE_BOOTSTRAP_SIGNATURE,
      },
    ],
  ])(
    'rejects fork before claudeExecProvider runs when %s is already persisted',
    async (_label, persistedContinuity) => {
      const { claude } = await loadProvider();
      const lease = makeLease();
      const runtime = makeRuntime(lease, {
        persistedContinuity,
      });

      const terminal = getTerminal(
        await collect(
          claude(
            makeRequest({
              action: 'fork',
              conversationRef: 'parent-session',
            }),
            runtime,
          ),
        ),
      );

      expect(kernelInvocations.exec).toBe(0);
      expect(kernelInvocations.session).toBe(0);
      expect(runtime.acquireServer).not.toHaveBeenCalled();
      expect(runtime.runCli).not.toHaveBeenCalled();
      expect(terminal.terminal).toEqual({
        content: '',
        outcome: { kind: 'failed' },
      });
      expect(terminal.failureCause).toEqual({
        type: 'session.provider_failed',
        body: {
          provider: 'claude',
          reason: 'request_failed',
          message:
            'This Claude session already established persistent continuity. Start a new Coral session before forking.',
        },
      });
    },
  );

  it('rejects bootstrapSignature mismatch on an established session before dispatch', async () => {
    const { claude } = await loadProvider();
    const lease = makeLease();
    const runtime = makeRuntime(lease, {
      persistedContinuity: {
        bootstrapSignature: {
          cwd: '/persisted-workspace',
          systemPromptHash: 'sha256:system',
          permissionMode: 'default',
        },
        conversationRef: 'established-session',
      },
    });

    const terminal = getTerminal(await collect(claude(makeRequest(), runtime)));

    expect(kernelInvocations.exec).toBe(0);
    expect(kernelInvocations.session).toBe(0);
    expect(runtime.acquireServer).not.toHaveBeenCalled();
    expect(runtime.runCli).not.toHaveBeenCalled();
    expect(terminal.terminal).toEqual({
      content: '',
      outcome: { kind: 'failed' },
    });
    expect(terminal.failureCause).toEqual({
      type: 'session.provider_failed',
      body: {
        provider: 'claude',
        reason: 'request_failed',
        message:
          'This Claude session already established persistent continuity with cwd=/persisted-workspace, systemPromptHash=sha256:system, permissionMode=default. Start a new Coral session before changing that bootstrap signature.',
      },
    });
  });
});
