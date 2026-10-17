import { describe, expect, it, vi } from 'vitest';

import type {
  AppServerSession,
  ProviderAppServerRuntime,
  ProviderEventBody,
  ProviderRequest,
  ProviderSteeringPort,
} from '#src/providers/contract.js';
import type { CodexExecutionPlan } from '#src/providers/codex/execution-plan.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { commitContinuityEvent } from '#src/providers/internal/continuity-commit.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { flushMicrotasks, VirtualTime } from '#tools/simulation/core/virtual-time.js';
import { snapshotAppServerExecutionRuntime } from '#src/providers/internal/runtime-boundary.js';
import { codexTurnKernel } from '#src/providers/codex/thread-kernel.js';
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

describe('codexTurnKernel steering', () => {
  const firstId = '33333333-3333-4333-8333-333333333333';
  const secondId = '44444444-4444-4444-8444-444444444444';
  const continuity = { cwd: '/workspace', threadId: 'thread-1', turnId: 'turn-1' };

  async function harness() {
    const time = new VirtualTime();
    const controller = new AbortController();
    const start = createDeferred<{ turn: { id: string; status: string } }>();
    const starting = createDeferred();
    const steering = createDeferred<ProviderSteeringPort>();
    let receive: (message: { method: string; params?: Record<string, unknown> }) => void = () => {};
    const lease: AppServerSession = {
      ...APP_SERVER_SESSION,
      interrupt: async () => ({ kind: 'accepted' }),
      rpc: (async (method: string) => {
        if (method === 'config/read') return { config: {} };
        if (method === 'model/list') return { data: [], nextCursor: null };
        if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') {
          starting.resolve();
          return start.promise;
        }
        throw new Error(`Unexpected method: ${method}`);
      }) as AppServerSession['rpc'],
      subscribe: (handler) => {
        receive = handler;
        return () => {};
      },
    };
    const events: ProviderEventBody[] = [];
    let settled = false;
    const done = (async () => {
      const runtime: CodexRuntime = {
        ...makeRuntime({ cwd: '/workspace', threadId: 'thread-1' }),
        appServerSession: lease,
        signal: controller.signal,
        time,
        onProviderSteering: (port) => steering.resolve(port),
      };
      for await (const event of codexTurnKernel(
        makeRequest({ conversationRef: 'thread-1' }),
        snapshotAppServerExecutionRuntime(runtime, runtime.executionPlan, lease),
      ))
        events.push(event);
      settled = true;
    })();
    const port = await steering.promise;
    await starting.promise;

    function emit(
      method: string,
      item?: Record<string, unknown>,
      turnId = 'turn-1',
      threadId = 'thread-1',
      status = 'completed',
    ) {
      receive({
        method,
        params: {
          threadId,
          turnId,
          ...(item === undefined ? {} : { item }),
          ...(method === 'turn/completed' ? { turn: { id: turnId, status } } : {}),
        },
      });
    }
    async function claim() {
      start.resolve({ turn: { id: 'turn-1', status: 'inProgress' } });
      await flushMicrotasks(20);
    }
    function finalAnswer(text = 'Done') {
      emit('item/completed', { type: 'agentMessage', text, phase: 'final_answer' });
    }
    const messages = () => events.filter((event) => event.kind === 'progress').map((event) => event.message);
    return {
      time,
      port,
      events,
      done,
      emit,
      claim,
      finalAnswer,
      messages,
      abort: () => controller.abort(),
      settled: () => settled,
    };
  }

  it('refuses an unclaimed or stale continuity instead of latching a steer for another turn', async () => {
    const h = await harness();
    expect(h.port.admit(continuity, firstId)).toMatchObject({ state: 'refused', code: 'turn_not_started' });
    await h.claim();
    for (const stale of [{ ...continuity, turnId: 'old-turn' }, { ...continuity, threadId: 'other-thread' }, {}]) {
      expect(h.port.admit(stale, firstId)).toMatchObject({ state: 'refused', code: 'turn_not_started' });
    }
    expect(h.port.admit(continuity, firstId)).toEqual({ state: 'admitted' });
    h.emit('turn/completed');
    await h.done;
  });

  it('refuses after final answer and after explicit completion, even before terminal materialization', async () => {
    const h = await harness();
    await h.claim();
    h.finalAnswer();
    expect(h.port.admit(continuity, firstId)).toMatchObject({ state: 'refused', code: 'turn_ended' });
    h.emit('turn/completed');
    expect(h.port.admit(continuity, firstId)).toMatchObject({ state: 'refused', code: 'turn_ended' });
    await h.done;
    expect(h.port.admit(continuity, firstId)).toMatchObject({ state: 'refused', code: 'turn_ended' });
    expect(h.messages().some((message) => message.includes('was not read'))).toBe(false);
  });

  it('refuses a completed attempt that never produced a final answer item', async () => {
    const h = await harness();
    await h.claim();
    h.emit('turn/completed');
    expect(h.port.admit(continuity, firstId)).toMatchObject({ state: 'refused', code: 'turn_ended' });
    await h.done;
  });

  it.each(['delivered', 'unknown'] as const)(
    'keeps a %s steer unread until the active-turn clientId echo, then waits for the next final answer',
    async (state) => {
      const h = await harness();
      await h.claim();
      expect(h.port.admit(continuity, firstId)).toEqual({ state: 'admitted' });
      h.port.reportOutcome(firstId, state === 'delivered' ? { state } : { state, reason: 'reply lost' });
      h.finalAnswer('Answer before reading the steer');
      h.time.tick(1000);
      await flushMicrotasks(20);
      expect(h.settled()).toBe(false);

      h.emit('item/started', { type: 'userMessage', clientId: secondId });
      h.emit('item/completed', { type: 'userMessage', clientId: firstId });
      h.emit('item/started', { type: 'commandExecution', clientId: firstId });
      h.emit('item/started', { type: 'userMessage', clientId: firstId }, 'old-turn');
      h.emit('item/started', { type: 'userMessage', clientId: firstId }, 'turn-1', 'other-thread');
      h.time.tick(1000);
      await flushMicrotasks(20);
      expect(h.settled()).toBe(false);
      expect(h.messages().some((message) => message.includes('read by the agent'))).toBe(false);

      h.emit('item/started', { type: 'userMessage', clientId: firstId });
      h.emit('item/started', { type: 'userMessage', clientId: firstId });
      h.time.tick(1000);
      await flushMicrotasks(20);
      expect(h.messages().filter((message) => message === `Sent message ${firstId} read by the agent`)).toHaveLength(1);
      expect(h.settled()).toBe(false);
      h.finalAnswer('Answer after reading the steer');
      h.time.tick(250);
      await h.done;
      expect(h.events.find((event) => event.kind === 'terminal')).toMatchObject({
        terminal: { outcome: { kind: 'completed' }, content: 'Answer after reading the steer' },
      });
      expect(h.messages().some((message) => message.includes('was not read'))).toBe(false);
    },
  );

  it('retains the completion hold until every independently latched steer has been read', async () => {
    const h = await harness();
    await h.claim();
    expect(h.port.admit(continuity, firstId)).toEqual({ state: 'admitted' });
    expect(h.port.admit(continuity, secondId)).toEqual({ state: 'admitted' });
    h.emit('item/started', { type: 'userMessage', clientId: firstId });
    h.finalAnswer();
    h.time.tick(1000);
    await flushMicrotasks(20);
    expect(h.settled()).toBe(false);
    h.emit('item/started', { type: 'userMessage', clientId: secondId });
    h.finalAnswer('Both read');
    h.time.tick(250);
    await h.done;
    expect(h.messages()).toContain(`Sent message ${firstId} read by the agent`);
    expect(h.messages()).toContain(`Sent message ${secondId} read by the agent`);
  });

  it('clears only an answered refusal and resumes inference without a false unread diagnostic', async () => {
    const h = await harness();
    await h.claim();
    expect(h.port.admit(continuity, firstId)).toEqual({ state: 'admitted' });
    h.finalAnswer();
    h.port.reportOutcome(secondId, { state: 'refused', code: 'provider_rejected', reason: 'unrelated' });
    h.time.tick(1000);
    await flushMicrotasks(20);
    expect(h.settled()).toBe(false);
    h.port.reportOutcome(firstId, { state: 'refused', code: 'provider_rejected', reason: 'rejected' });
    h.time.tick(250);
    await h.done;
    expect(h.messages().some((message) => message.includes(firstId))).toBe(false);
  });

  it('emits each unread id before the terminal when the provider explicitly ends the turn', async () => {
    const h = await harness();
    await h.claim();
    h.port.admit(continuity, firstId);
    h.port.admit(continuity, secondId);
    h.finalAnswer();
    h.emit('turn/completed');
    await h.done;
    const terminalIndex = h.events.findIndex((event) => event.kind === 'terminal');
    expect(terminalIndex).toBeGreaterThan(-1);
    for (const id of [firstId, secondId]) {
      const unreadIndex = h.events.findIndex(
        (event) =>
          event.kind === 'progress' && event.message === `Sent message ${id} was not read before the turn ended`,
      );
      expect(unreadIndex).toBeGreaterThan(-1);
      expect(unreadIndex).toBeLessThan(terminalIndex);
    }
  });

  it('admits during final-answer streaming and holds completion if the steer remains unread', async () => {
    const h = await harness();
    await h.claim();
    h.emit('item/started', { type: 'agentMessage', text: 'Finishing', phase: 'final_answer' });
    expect(h.port.admit(continuity, firstId)).toEqual({ state: 'admitted' });
    h.finalAnswer();
    h.time.tick(1000);
    await flushMicrotasks(20);
    expect(h.settled()).toBe(false);
    h.emit('turn/completed');
    await h.done;
  });

  it('allows acknowledged cancellation to end a turn whose steer remains unread', async () => {
    const h = await harness();
    await h.claim();
    expect(h.port.admit(continuity, firstId)).toEqual({ state: 'admitted' });
    h.finalAnswer();
    h.abort();
    h.emit('turn/completed', undefined, 'turn-1', 'thread-1', 'interrupted');
    await h.done;
    expect(h.events.find((event) => event.kind === 'terminal')).toMatchObject({
      terminal: { outcome: { kind: 'aborted', reason: 'signal_abort' } },
    });
    expect(h.messages()).toContain(`Sent message ${firstId} was not read before the turn ended`);
  });

  it('preserves inferred completion for a turn with no sends', async () => {
    const h = await harness();
    await h.claim();
    h.finalAnswer();
    h.time.tick(250);
    await h.done;
    expect(h.events.filter((event) => event.kind === 'terminal')).toHaveLength(1);
    expect(h.messages().some((message) => message.startsWith('Sent message'))).toBe(false);
  });
});
