import { describe, expect, it, vi } from 'vitest';

import type {
  AppServerSession,
  ProviderAppServerRuntime,
  ProviderEventBody,
  ProviderRequest,
} from '#src/providers/contract.js';
import type { CodexExecutionPlan } from '#src/providers/codex/execution-plan.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { commitContinuityEvent } from '#src/providers/internal/continuity-commit.js';
import { codexThreadProvider } from '#src/providers/codex/thread-provider.js';
import { TEST_CODEX_PLAN } from '../../../helpers/provider-credentials.js';

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    action: 'resume',
    sessionId: 'job-codex-thread-kernel',
    name: 'codex',
    conversationRef: 'request-thread',
    prompt: 'Resume and continue',
    cwd: fixtureCanonicalWorkDir('/workspace/request'),
    bypassPermissions: false,
    coralEnv: {},
    ...overrides,
  };
}

type CodexRuntime = ProviderAppServerRuntime<CodexExecutionPlan>;

const APP_SERVER_SESSION: AppServerSession = {
  rpc: async <Result>(method: string) => (method === 'model/list' ? { data: [], nextCursor: null } : {}) as Result,
  subscribe: () => () => {},
  closed: new Promise<Error | void>(() => {}),
  interrupt: async () => ({ kind: 'not-accepted', reason: 'test refusal' }),
};

function makeRuntime(
  persistedContinuity: CodexRuntime['persistedContinuity'] = {
    cwd: '/workspace/persisted',
    threadId: 'persisted-thread',
  },
  overrides: Partial<Pick<CodexRuntime, 'env' | 'storage'>> = {},
): CodexRuntime {
  return {
    transport: 'app-server',
    signal: new AbortController().signal,
    time: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => {
        if (handle !== null) clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
    },
    ids: { uuid: () => 'test-uuid', sha256: () => 'sha256:fake' },
    appServerSession: APP_SERVER_SESSION,
    storage:
      overrides.storage ??
      ({
        existsSync: () => true,
        statSync: () => {
          throw Object.assign(new Error('No config.toml in this fixture'), { code: 'ENOENT' });
        },
      } as unknown as CodexRuntime['storage']),
    ...(overrides.env ? { env: overrides.env } : {}),
    persistedContinuity,
    continuityBridge: {
      checkpoint: () => {},
      transportClosed: () => {},
    },
    onProviderTurnTerminal: () => {},
    kbRoot: '/mock/kb',
    executionPlan: TEST_CODEX_PLAN,
  };
}

describe('codexThreadProvider catalog selection', () => {
  function runtimeWithCatalog(catalog: unknown, rejection?: Error) {
    const rpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'model/list') {
        if (rejection !== undefined) throw rejection;
        return catalog;
      }
      if (method === 'config/read') return { config: {} };
      if (method === 'thread/start') return { thread: { id: 'thread-catalog' } };
      if (method === 'thread/resume') return { thread: { id: params.threadId } };
      if (method === 'turn/start') return { turn: { id: 'turn-catalog', status: 'completed' } };
      throw new Error(`Unexpected method: ${method}`);
    });
    const runtime: CodexRuntime = {
      ...makeRuntime(),
      appServerSession: { ...APP_SERVER_SESSION, rpc: rpc as AppServerSession['rpc'] },
    };
    return { runtime, rpc };
  }

  async function collect(request: ProviderRequest, runtime: CodexRuntime): Promise<ProviderEventBody[]> {
    const events: ProviderEventBody[] = [];
    for await (const event of codexThreadProvider(request, runtime)) {
      events.push(event);
      if (event.kind === 'continuity') commitContinuityEvent(event);
    }
    return events;
  }

  it.each(['exec', 'resume'] as const)(
    'uses one catalog selection for %s thread, turn, and terminal',
    async (action) => {
      const { runtime, rpc } = runtimeWithCatalog({
        data: [
          {
            model: 'gpt-6.1-sol',
            hidden: false,
            upgrade: null,
            supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
          },
        ],
        nextCursor: null,
      });
      const request = makeRequest({ action, model: 'opus', effort: 'ultra' });

      const events = await collect(request, runtime);

      expect(rpc.mock.calls.filter(([method]) => method === 'model/list')).toHaveLength(1);
      expect(rpc).toHaveBeenCalledWith(
        action === 'exec' ? 'thread/start' : 'thread/resume',
        expect.objectContaining({ model: 'gpt-6.1-sol' }),
      );
      expect(rpc).toHaveBeenCalledWith('turn/start', expect.objectContaining({ model: 'gpt-6.1-sol', effort: 'high' }));
      expect(events.find((event) => event.kind === 'terminal')).toMatchObject({
        terminal: { model: 'gpt-6.1-sol', outcome: { kind: 'completed' } },
      });
      expect(events.filter((event) => event.kind === 'progress' && event.message.includes('built-in'))).toEqual([]);
    },
  );

  it('reads a refreshed catalog on each invocation sharing the same app-server transport', async () => {
    const model = {
      model: 'gpt-6.1-sol',
      hidden: false,
      upgrade: null,
      supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
    };
    const { runtime, rpc } = runtimeWithCatalog({ data: [model], nextCursor: null });
    const request = makeRequest({ action: 'exec', model: 'opus', effort: 'ultra' });

    await collect(request, runtime);
    model.model = 'gpt-6.2-sol';
    model.supportedReasoningEfforts = [{ reasoningEffort: 'max' }];
    const events = await collect(request, runtime);

    expect(rpc.mock.calls.filter(([method]) => method === 'model/list')).toHaveLength(2);
    expect(
      rpc.mock.calls
        .filter(([method]) => method === 'turn/start')
        .map(([, params]) => ({
          model: params.model,
          effort: params.effort,
        })),
    ).toEqual([
      { model: 'gpt-6.1-sol', effort: 'high' },
      { model: 'gpt-6.2-sol', effort: 'max' },
    ]);
    expect(events.find((event) => event.kind === 'terminal')).toMatchObject({ terminal: { model: 'gpt-6.2-sol' } });
  });

  it('reports an unavailable catalog once and uses the built-in fallback on thread and turn', async () => {
    const { runtime, rpc } = runtimeWithCatalog(undefined, new Error('-32600 unknown variant model/list'));

    const events = await collect(makeRequest({ action: 'exec', model: 'opus' }), runtime);

    expect(rpc.mock.calls.filter(([method]) => method === 'model/list')).toHaveLength(1);
    expect(rpc).toHaveBeenCalledWith('thread/start', expect.objectContaining({ model: 'gpt-6-sol' }));
    expect(rpc).toHaveBeenCalledWith('turn/start', expect.objectContaining({ model: 'gpt-6-sol' }));
    const notices = events.filter(
      (event) => event.kind === 'progress' && event.message.includes('catalog unavailable'),
    );
    expect(notices).toHaveLength(1);
    expect(events.find((event) => event.kind === 'terminal')).toMatchObject({ terminal: { model: 'gpt-6-sol' } });
  });
});
