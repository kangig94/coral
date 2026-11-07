import { describe, expect, it, vi } from 'vitest';
import type {
  AppServerSession,
  ProviderAppServerRuntime,
  ProviderEventBody,
  ProviderRequest,
  ProviderSteeringPort,
  ProviderTurnSettlement,
} from '#src/providers/contract.js';
import type { AppServerNotificationMessage } from '#src/providers/protocol.js';
import type { CodexExecutionPlan } from '#src/providers/codex/execution-plan.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { commitContinuityEvent } from '#src/providers/internal/continuity-commit.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { flushMicrotasks, VirtualTime } from '#tools/simulation/core/virtual-time.js';
import { snapshotAppServerExecutionRuntime } from '#src/providers/internal/runtime-boundary.js';
import { wrapAppServerSession } from '#src/providers/internal/server-lease-boundary.js';
import { codexTurnKernel } from '#src/providers/codex/thread-kernel.js';
import { codexThreadProvider } from '#src/providers/codex/thread-provider.js';
import { TEST_CODEX_PLAN } from '#tests/helpers/provider-credentials.js';

type CodexRuntime = ProviderAppServerRuntime<CodexExecutionPlan>;
type Rejection = 'active-writer' | 'closing' | 'listener-closing';

function resumeError(reason: Rejection): Error {
  const detail =
    reason === 'active-writer'
      ? 'already has an active writer'
      : `is closing; retry ${reason === 'closing' ? 'thread/resume ' : ''}after the thread is closed`;
  return new Error(`thread/resume failed [code=-32600]: thread thread-1 ${detail}`);
}

function harness(
  options: {
    catalog?: unknown;
    catalogError?: Error;
    deferredStart?: boolean;
    turnStatus?: 'completed' | 'inProgress';
    readTurnStatus?: 'completed' | 'inProgress';
    turnStartFailure?: boolean;
    resumeErrors?: readonly Error[];
    resumedIds?: string[];
    abortAfterResume?: boolean;
    closingDelay?: number;
    diagnosticThrows?: boolean;
    interruptReply?: Promise<{ kind: 'accepted' }>;
    interruptReplies?: Array<Promise<{ kind: 'accepted' }>>;
    interruptCompletes?: boolean;
    unsubscribe?: () => Promise<unknown>;
    observeSettlement?: boolean;
  } = {},
) {
  const time = new VirtualTime();
  const timers = vi.spyOn(time, 'setTimeout');
  const listeners = new Set<(message: AppServerNotificationMessage) => void>();
  const closed = createDeferred<Error | void>();
  const resumeEntered = createDeferred();
  const resumeReply = createDeferred<{ thread: { id: string } }>();
  const queuedResumes: Array<ReturnType<typeof createDeferred<{ thread: { id: string } }>>> = [];
  const subscribed = new Set<string>();
  const closingUntil = new Map<string, number>();
  const remainingErrors = [...(options.resumeErrors ?? [])];
  const resumedIds = [...(options.resumedIds ?? [])];
  const interruptReplies = [...(options.interruptReplies ?? [])];
  const invocations: Array<{
    threadId: string;
    turnId: string | null;
    controller: AbortController;
    startResponse: ReturnType<typeof createDeferred<{ turn: { id: string; status: string } }>>;
  }> = [];
  const methods: string[] = [];
  let resumeCount = 0;
  let turnCount = 0;
  let deferSecondResume = false;
  const deliver = (message: AppServerNotificationMessage) => {
    for (const listener of [...listeners]) listener(message);
  };
  const finish = (turnId: string, status = 'completed') => {
    const invocation = invocations.find((candidate) => candidate.turnId === turnId);
    if (invocation === undefined || !subscribed.has(invocation.threadId)) return;
    deliver({ method: 'turn/completed', params: { threadId: invocation.threadId, turn: { id: turnId, status } } });
  };
  const rpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
    methods.push(method);
    if (method === 'config/read') return { config: {} };
    if (method === 'model/list') {
      if (options.catalogError !== undefined) throw options.catalogError;
      return options.catalog ?? { data: [], nextCursor: null };
    }
    if (method === 'thread/start' || method === 'thread/resume') {
      const requestedId = method === 'thread/start' ? 'thread-1' : String(params.threadId);
      if (method === 'thread/resume') {
        resumeCount += 1;
        const error = remainingErrors.shift();
        if (error !== undefined) throw error;
        if (time.now() < (closingUntil.get(requestedId) ?? 0)) throw resumeError('closing');
        const queued = queuedResumes.shift();
        if (queued !== undefined) {
          subscribed.add(requestedId);
          return queued.promise;
        }
        if (resumeCount === 2) {
          subscribed.add(requestedId);
          resumeEntered.resolve();
          if (deferSecondResume) return resumeReply.promise;
        }
      }
      const threadId = resumedIds.shift() ?? requestedId;
      subscribed.add(threadId);
      if (options.abortAfterResume) invocations.at(-1)!.controller.abort();
      return { thread: { id: threadId } };
    }
    if (method === 'turn/start') {
      const invocation = [...invocations]
        .reverse()
        .find((candidate) => candidate.threadId === params.threadId && candidate.turnId === null);
      if (invocation === undefined) throw new Error('Missing fixture invocation');
      const turnId = `turn-${++turnCount}`;
      invocation.turnId = turnId;
      if (options.turnStartFailure) throw new Error('turn rejected');
      if (options.deferredStart) return invocation.startResponse.promise;
      return { turn: { id: turnId, status: options.turnStatus ?? 'inProgress' } };
    }
    if (method === 'thread/read') {
      const invocation = [...invocations].reverse().find((candidate) => candidate.threadId === params.threadId);
      return {
        thread: {
          id: params.threadId,
          turns: [{ id: invocation?.turnId, status: options.readTurnStatus ?? 'completed' }],
        },
      };
    }
    if (method === 'thread/unsubscribe') {
      const result = options.unsubscribe === undefined ? { status: 'unsubscribed' } : await options.unsubscribe();
      if (
        typeof result === 'object' &&
        result !== null &&
        'status' in result &&
        (result.status === 'unsubscribed' || result.status === 'notLoaded')
      ) {
        const threadId = String(params.threadId);
        subscribed.delete(threadId);
        closingUntil.set(threadId, time.now() + (options.closingDelay ?? 0));
      }
      return result;
    }
    throw new Error(`Unexpected fixture RPC: ${method}`);
  });
  const interrupt = vi.fn(async (continuity: Record<string, unknown>) => {
    methods.push('turn/interrupt');
    if (options.interruptCompletes !== false) finish(String(continuity.turnId), 'interrupted');
    return interruptReplies.shift() ?? options.interruptReply ?? { kind: 'accepted' as const };
  });
  const raw: AppServerSession = {
    rpc: rpc as AppServerSession['rpc'],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    closed: closed.promise,
    interrupt,
  };
  const run = (overrides: Partial<ProviderRequest> | 'exec' | 'resume' = {}, provider = false) => {
    const request: ProviderRequest = {
      action: 'resume',
      jobId: 'job-codex-thread-kernel',
      name: 'codex',
      conversationRef: 'thread-1',
      prompt: 'Continue',
      cwd: fixtureCanonicalWorkDir('/workspace'),
      bypassPermissions: false,
      coralEnv: {},
      ...(typeof overrides === 'string' ? { action: overrides } : overrides),
    };
    const controller = new AbortController();
    const started = createDeferred();
    const startResponse = createDeferred<{ turn: { id: string; status: string } }>();
    const invocation = {
      threadId: request.conversationRef ?? 'thread-1',
      turnId: null as string | null,
      controller,
      startResponse,
    };
    invocations.push(invocation);
    const lease = wrapAppServerSession(raw, `invocation-${invocations.length}`);
    const diagnostics = vi.fn<(message: string) => void>(() => {
      if (options.diagnosticThrows) throw new Error('Diagnostic sink closed');
    });
    const notSubmitted = vi.fn();
    let port: ProviderSteeringPort | undefined;
    let settlement: ProviderTurnSettlement | undefined;
    let settled = false;
    const runtime: CodexRuntime = {
      transport: 'app-server',
      appServerSession: lease,
      signal: controller.signal,
      time,
      ids: { uuid: () => 'test-uuid', sha256: () => 'sha256:fake' },
      storage: {
        existsSync: () => false,
        statSync: () => {
          throw Object.assign(new Error('No fixture config'), { code: 'ENOENT' });
        },
      } as unknown as CodexRuntime['storage'],
      persistedContinuity: { cwd: '/workspace', threadId: request.conversationRef ?? 'thread-1' },
      continuityBridge: { checkpoint: () => {}, transportClosed: () => {} },
      onProviderTurnTerminal: () => {},
      onProviderTurnStart: () => started.resolve(),
      onProviderTurnNotSubmitted: notSubmitted,
      onProviderDiagnostic: diagnostics,
      onProviderSteering: (value) => {
        port = value;
      },
      ...(options.observeSettlement
        ? {
            onProviderTurnSettlement: (value: ProviderTurnSettlement) => {
              settlement = value;
            },
          }
        : {}),
      kbRoot: '/mock/kb',
      executionPlan: TEST_CODEX_PLAN,
    };
    const events: ProviderEventBody[] = [];
    const done = (async () => {
      const stream = (provider ? codexThreadProvider : codexTurnKernel)(
        request,
        snapshotAppServerExecutionRuntime(runtime, runtime.executionPlan, lease),
      );
      for await (const event of stream) {
        events.push(event);
        if (event.kind === 'continuity') commitContinuityEvent(event);
      }
      settled = true;
    })();
    const emit = (
      method: string,
      item?: Record<string, unknown>,
      turnId = invocation.turnId ?? 'turn-1',
      threadId = invocation.threadId,
      status = 'completed',
    ) => {
      deliver({
        method,
        params: {
          threadId,
          turnId,
          ...(item === undefined ? {} : { item }),
          ...(method === 'turn/completed' ? { turn: { id: turnId, status } } : {}),
        },
      });
    };
    return {
      time,
      timers,
      lease,
      controller,
      started: started.promise,
      rpc,
      methods,
      interrupt,
      diagnostics,
      notSubmitted,
      events,
      done,
      listeners,
      get port() {
        if (port === undefined) throw new Error('Missing steering port');
        return port;
      },
      steering: () => port,
      settlement: () => settlement,
      settled: () => settled,
      messages: () => events.filter((event) => event.kind === 'progress').map((event) => event.message),
      emit,
      claim: async () => {
        startResponse.resolve({ turn: { id: invocation.turnId ?? 'turn-1', status: 'inProgress' } });
        await flushMicrotasks(20);
      },
      abort: () => controller.abort(),
      finish: (status = 'completed') => finish(invocation.turnId ?? 'turn-1', status),
      finalAnswer: (text = 'Done') => emit('item/completed', { type: 'agentMessage', text, phase: 'final_answer' }),
    };
  };
  return {
    time,
    timers,
    rpc,
    raw,
    close: () => closed.resolve(),
    listeners,
    methods,
    run,
    finish,
    count: (method: string) => rpc.mock.calls.filter(([called]) => called === method).length,
    tick: async (ms: number) => {
      time.tick(ms);
      await flushMicrotasks(50);
    },
    deferNextResume: () => {
      const reply = createDeferred<{ thread: { id: string } }>();
      queuedResumes.push(reply);
      return reply;
    },
    resumeEntered: resumeEntered.promise,
    deferResume: () => {
      deferSecondResume = true;
    },
    resume: () => resumeReply.resolve({ thread: { id: 'thread-1' } }),
    subscribed: () => subscribed.has('thread-1'),
    unsubscribes: () => rpc.mock.calls.filter(([method]) => method === 'thread/unsubscribe').length,
  };
}

describe('codexThreadProvider catalog selection', () => {
  it.each(['exec', 'resume'] as const)(
    'uses one catalog selection for %s thread, turn, and terminal',
    async (action) => {
      const h = harness({
        catalog: {
          data: [
            {
              model: 'gpt-6.1-sol',
              hidden: false,
              upgrade: null,
              supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
            },
          ],
          nextCursor: null,
        },
        turnStatus: 'completed',
      });
      const invocation = h.run({ action, model: 'opus', effort: 'ultra' }, true);
      await invocation.done;
      expect(h.count('model/list')).toBe(1);
      expect(h.rpc).toHaveBeenCalledWith(
        action === 'exec' ? 'thread/start' : 'thread/resume',
        expect.objectContaining({ model: 'gpt-6.1-sol' }),
      );
      expect(h.rpc).toHaveBeenCalledWith(
        'turn/start',
        expect.objectContaining({ model: 'gpt-6.1-sol', effort: 'high' }),
      );
      expect(invocation.events.find((event) => event.kind === 'terminal')).toMatchObject({
        terminal: { model: 'gpt-6.1-sol', outcome: { kind: 'completed' } },
      });
      expect(
        invocation.events.filter((event) => event.kind === 'progress' && event.message.includes('built-in')),
      ).toEqual([]);
    },
  );

  it('reads a refreshed catalog on each invocation sharing the same app-server transport', async () => {
    const model = {
      model: 'gpt-6.1-sol',
      hidden: false,
      upgrade: null,
      supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
    };
    const h = harness({ catalog: { data: [model], nextCursor: null }, turnStatus: 'completed' });
    await h.run({ action: 'exec', model: 'opus', effort: 'ultra' }, true).done;
    model.model = 'gpt-6.2-sol';
    model.supportedReasoningEfforts = [{ reasoningEffort: 'max' }];
    const invocation = h.run({ action: 'exec', model: 'opus', effort: 'ultra' }, true);
    await invocation.done;
    expect(h.count('model/list')).toBe(2);
    expect(
      h.rpc.mock.calls
        .filter(([method]) => method === 'turn/start')
        .map(([, params]) => ({ model: params.model, effort: params.effort })),
    ).toEqual([
      { model: 'gpt-6.1-sol', effort: 'high' },
      { model: 'gpt-6.2-sol', effort: 'max' },
    ]);
    expect(invocation.events.find((event) => event.kind === 'terminal')).toMatchObject({
      terminal: { model: 'gpt-6.2-sol' },
    });
  });

  it('reports an unavailable catalog once and uses the built-in fallback on thread and turn', async () => {
    const h = harness({ catalogError: new Error('-32600 unknown variant model/list'), turnStatus: 'completed' });
    const invocation = h.run({ action: 'exec', model: 'opus' }, true);
    await invocation.done;
    expect(h.count('model/list')).toBe(1);
    expect(h.rpc).toHaveBeenCalledWith('thread/start', expect.objectContaining({ model: 'gpt-6-sol' }));
    expect(h.rpc).toHaveBeenCalledWith('turn/start', expect.objectContaining({ model: 'gpt-6-sol' }));
    expect(
      invocation.events.filter((event) => event.kind === 'progress' && event.message.includes('catalog unavailable')),
    ).toHaveLength(1);
    expect(invocation.events.find((event) => event.kind === 'terminal')).toMatchObject({
      terminal: { model: 'gpt-6-sol' },
    });
  });
});

describe('codexTurnKernel steering', () => {
  const firstId = '33333333-3333-4333-8333-333333333333';
  const secondId = '44444444-4444-4444-8444-444444444444';
  const continuity = { cwd: '/workspace', threadId: 'thread-1', turnId: 'turn-1' };
  it('refuses an unclaimed or stale continuity instead of latching a steer for another turn', async () => {
    const h = harness({ deferredStart: true }).run();
    await h.started;
    await flushMicrotasks(20);
    expect(h.port.admit(continuity, firstId)).toMatchObject({ state: 'refused', code: 'turn_not_started' });
    await h.claim();
    for (const stale of [
      { ...continuity, turnId: 'old-turn' },
      { ...continuity, threadId: 'other-thread' },
      { cwd: '/workspace' },
    ]) {
      expect(h.port.admit(stale, firstId)).toMatchObject({ state: 'refused', code: 'turn_not_started' });
    }
    expect(h.port.admit(continuity, firstId)).toEqual({ state: 'admitted' });
    h.emit('turn/completed');
    await h.done;
  });

  it('throws for malformed continuity before latching a steer', async () => {
    const h = harness({ deferredStart: true }).run();
    await h.started;
    await flushMicrotasks(20);
    await h.claim();
    expect(() => h.port.admit({}, firstId)).toThrow(new TypeError('Invalid persisted Codex continuity.'));
    h.finalAnswer();
    h.time.tick(250);
    await h.done;
    expect(h.messages().some((message) => message.includes(firstId))).toBe(false);
  });

  it.each(['unknown', 'delivered'] as const)(
    'suspends inference indefinitely for a %s unread steer until explicit completion',
    async (state) => {
      const h = harness({ deferredStart: true }).run();
      await h.started;
      await flushMicrotasks(20);
      await h.claim();
      expect(h.port.admit(continuity, firstId)).toEqual({ state: 'admitted' });
      h.port.reportOutcome(firstId, state === 'delivered' ? { state } : { state, reason: 'reply lost' });
      h.finalAnswer();
      h.time.tick(86_400_000);
      await flushMicrotasks(20);
      expect(h.settled()).toBe(false);
      expect(h.events.some((event) => event.kind === 'terminal')).toBe(false);
      expect(h.messages().some((message) => message.includes('was not read'))).toBe(false);
      h.finalAnswer('Final answer repeated while the steer is unread');
      h.time.tick(86_400_000);
      await flushMicrotasks(20);
      expect(h.settled()).toBe(false);
      h.emit('turn/completed');
      await h.done;
      expect(h.settled()).toBe(true);
      const unreadIndex = h.events.findIndex(
        (event) =>
          event.kind === 'progress' && event.message === `Sent message ${firstId} was not read before the turn ended`,
      );
      const terminalIndex = h.events.findIndex((event) => event.kind === 'terminal');
      expect(unreadIndex).toBeGreaterThan(-1);
      expect(unreadIndex).toBeLessThan(terminalIndex);
      expect(h.messages().some((message) => message.includes('read by the agent'))).toBe(false);
      expect(h.events[terminalIndex]).toMatchObject({ terminal: { outcome: { kind: 'completed' } } });
    },
  );

  it('refuses after final answer and after explicit completion, even before terminal materialization', async () => {
    const h = harness({ deferredStart: true }).run();
    await h.started;
    await flushMicrotasks(20);
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
    const h = harness({ deferredStart: true }).run();
    await h.started;
    await flushMicrotasks(20);
    await h.claim();
    h.emit('turn/completed');
    expect(h.port.admit(continuity, firstId)).toMatchObject({ state: 'refused', code: 'turn_ended' });
    await h.done;
  });

  it.each(['delivered', 'unknown'] as const)(
    'keeps a %s steer unread until the active-turn clientId echo, then waits for the next final answer',
    async (state) => {
      const h = harness({ deferredStart: true }).run();
      await h.started;
      await flushMicrotasks(20);
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
      h.time.tick(10_000);
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
    const h = harness({ deferredStart: true }).run();
    await h.started;
    await flushMicrotasks(20);
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
    const h = harness({ deferredStart: true }).run();
    await h.started;
    await flushMicrotasks(20);
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
    const h = harness({ deferredStart: true }).run();
    await h.started;
    await flushMicrotasks(20);
    await h.claim();
    h.port.admit(continuity, firstId);
    h.port.admit(continuity, secondId);
    h.finalAnswer();
    h.time.tick(5_000);
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
    const h = harness({ deferredStart: true }).run();
    await h.started;
    await flushMicrotasks(20);
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
    const h = harness({ deferredStart: true }).run();
    await h.started;
    await flushMicrotasks(20);
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
    const h = harness({ deferredStart: true }).run();
    await h.started;
    await flushMicrotasks(20);
    await h.claim();
    h.finalAnswer();
    h.time.tick(250);
    await h.done;
    expect(h.events.filter((event) => event.kind === 'terminal')).toHaveLength(1);
    expect(h.messages().some((message) => message.startsWith('Sent message'))).toBe(false);
  });
});

describe('codexTurnKernel thread cleanup', () => {
  it.each(['exec', 'resume'] as const)('forces immediate unload for %s thread requests', async (action) => {
    const h = harness().run({ action });
    await h.started;
    await flushMicrotasks(20);
    h.finish();
    await h.done;
    expect(h.rpc).toHaveBeenCalledWith(
      action === 'exec' ? 'thread/start' : 'thread/resume',
      expect.objectContaining({ config: expect.objectContaining({ thread_unload_delay_secs: 0 }) }),
    );
  });

  it('waits for admitted steering RPC outcomes without holding terminal delivery', async () => {
    const h = harness().run();
    await h.started;
    await flushMicrotasks(20);
    const steering = h.steering()!;
    expect(steering.admit({ threadId: 'thread-1', turnId: 'turn-1' }, 'pending-steer')).toEqual({ state: 'admitted' });
    h.finish();
    await h.done;
    await flushMicrotasks(20);
    expect(h.methods).not.toContain('thread/unsubscribe');
    steering.reportOutcome('pending-steer', { state: 'delivered' });
    await flushMicrotasks(20);
    expect(h.methods).toContain('thread/unsubscribe');
  });

  it('keeps a terminal release warning when the later diagnostic sink throws', async () => {
    const h = harness({
      diagnosticThrows: true,
      unsubscribe: () => Promise.reject(new Error('unsubscribe refused')),
    }).run();
    await h.started;
    await flushMicrotasks(20);
    h.finish();
    await h.done;
    await flushMicrotasks(20);
    expect(h.diagnostics).toHaveBeenCalled();
    expect(h.events.find((event) => event.kind === 'terminal')).toMatchObject({
      terminal: { outcome: { kind: 'completed' } },
      diagnostics: { warnings: [expect.stringMatching(/release.*not yet confirmed/)] },
    });
  });

  it.each(['completed', 'failed'] as const)('unsubscribes once after a %s turn settles', async (status) => {
    const h = harness().run();
    await h.started;
    await flushMicrotasks(20);
    h.finish(status);
    await h.done;
    await flushMicrotasks(20);
    expect(h.rpc.mock.calls.filter(([method]) => method === 'thread/unsubscribe')).toHaveLength(1);
    expect(h.events.find((event) => event.kind === 'terminal')).toMatchObject({
      terminal: { outcome: { kind: status === 'completed' ? 'completed' : 'provider_exit' } },
    });
    expect(h.steering()?.admit({ threadId: 'thread-1', turnId: 'turn-1' }, 'late')).toMatchObject({ state: 'refused' });
  });

  it('releases a loaded thread when turn/start is rejected', async () => {
    const h = harness({ turnStartFailure: true }).run();
    await h.done;
    await flushMicrotasks(20);
    expect(h.methods).toEqual(expect.arrayContaining(['thread/resume', 'turn/start', 'thread/unsubscribe']));
  });

  it('releases after successful resume when abort prevents turn submission', async () => {
    const h = harness({ abortAfterResume: true }).run();
    await h.done;
    await flushMicrotasks(20);
    expect(h.methods).toContain('thread/unsubscribe');
    expect(h.methods).not.toContain('turn/start');
    expect(h.notSubmitted).toHaveBeenCalledOnce();
    expect(h.events.find((event) => event.kind === 'terminal')).toMatchObject({
      terminal: { outcome: { kind: 'aborted' } },
    });
  });

  it('finishes interrupt use before unsubscribing an aborted turn', async () => {
    const h = harness().run();
    await h.started;
    await flushMicrotasks(20);
    h.controller.abort();
    await h.done;
    await flushMicrotasks(20);
    expect(h.interrupt).toHaveBeenCalledOnce();
    expect(h.methods.indexOf('thread/unsubscribe')).toBeGreaterThan(h.methods.indexOf('turn/interrupt'));
    expect(h.events.find((event) => event.kind === 'terminal')).toMatchObject({
      terminal: { outcome: { kind: 'aborted' } },
    });
  });

  it('waits for an in-flight interrupt reply after the turn terminal arrives', async () => {
    const reply = createDeferred<{ kind: 'accepted' }>();
    const h = harness({ interruptReply: reply.promise }).run();
    await h.started;
    await flushMicrotasks(20);
    h.controller.abort();
    await h.done;
    await flushMicrotasks(20);
    expect(h.interrupt).toHaveBeenCalledOnce();
    expect(h.methods).not.toContain('thread/unsubscribe');
    reply.resolve({ kind: 'accepted' });
    await flushMicrotasks(20);
    expect(h.methods).toContain('thread/unsubscribe');
  });

  it('retains a cancelled pending start until its late reply and matching terminal establish cessation', async () => {
    const h = harness({ deferredStart: true });
    const turn = h.run();
    await turn.started;
    await flushMicrotasks(20);
    turn.abort();
    await turn.done;
    expect(turn.events.at(-1)).toMatchObject({ kind: 'suspended', reason: 'interrupt_unconfirmed' });
    expect(h.count('thread/unsubscribe')).toBe(0);
    expect(turn.messages()).toContain(
      'Codex thread thread-1 retained: turn cessation unconfirmed; its host or transport closing releases the writer lock.',
    );
    expect(turn.diagnostics).toHaveBeenCalledWith(expect.stringContaining('retained: turn cessation unconfirmed'));
    expect(h.count('thread/unsubscribe')).toBe(0);

    await turn.claim();
    await h.tick(5_000);
    expect(h.count('thread/unsubscribe')).toBe(0);
    turn.emit('turn/completed', undefined, 'another-turn');
    turn.emit('turn/completed', undefined, 'turn-1', 'another-thread');
    turn.emit('turn/completed', undefined, 'turn-1', 'thread-1', 'inProgress');
    await flushMicrotasks(20);
    expect(h.count('thread/unsubscribe')).toBe(0);
    turn.finish('interrupted');
    await flushMicrotasks(30);
    expect(h.count('thread/unsubscribe')).toBe(1);
    expect(h.listeners.size).toBe(0);
  });

  it('correlates a terminal notification received before the cancelled start reply', async () => {
    const h = harness({ deferredStart: true });
    const turn = h.run();
    await turn.started;
    await flushMicrotasks(20);
    turn.abort();
    await turn.done;
    turn.finish();
    await flushMicrotasks(20);
    expect(h.count('thread/unsubscribe')).toBe(0);
    await turn.claim();
    await flushMicrotasks(30);
    expect(h.count('thread/unsubscribe')).toBe(1);
    expect(h.listeners.size).toBe(0);
  });

  it('retains an unconfirmed turn until transport close without a late unsubscribe', async () => {
    const h = harness({ deferredStart: true });
    const turn = h.run();
    await turn.started;
    await flushMicrotasks(20);
    turn.abort();
    await turn.done;
    await h.tick(20_000);
    expect(h.count('thread/unsubscribe')).toBe(0);
    h.close();
    await flushMicrotasks(30);
    expect(h.listeners.size).toBe(0);
    await turn.claim();
    turn.finish();
    await flushMicrotasks(30);
    expect(h.count('thread/unsubscribe')).toBe(0);
  });

  it('releases a suspended turn only when the retained settlement observer finds terminal evidence', async () => {
    const h = harness({ interruptCompletes: false, observeSettlement: true });
    const turn = h.run();
    await turn.started;
    await flushMicrotasks(20);
    turn.abort();
    await flushMicrotasks(20);
    await h.tick(10_000);
    await turn.done;
    expect(turn.events.at(-1)).toMatchObject({ kind: 'suspended' });
    expect(h.count('thread/unsubscribe')).toBe(0);
    await h.tick(250);
    expect(h.count('thread/read')).toBe(1);
    expect(h.count('thread/unsubscribe')).toBe(1);
    expect(h.listeners.size).toBe(0);
  });

  it('retains a suspended turn after its settlement observation expires without terminal evidence', async () => {
    const h = harness({ interruptCompletes: false, observeSettlement: true, readTurnStatus: 'inProgress' });
    const turn = h.run();
    await turn.started;
    await flushMicrotasks(20);
    turn.abort();
    await flushMicrotasks(20);
    await h.tick(10_000);
    await turn.done;
    for (let i = 0; i < 16; i += 1) await h.tick(250);
    expect(h.count('thread/read')).toBeGreaterThan(0);
    expect(h.count('thread/unsubscribe')).toBe(0);
    turn.finish('interrupted');
    await flushMicrotasks(30);
    expect(h.count('thread/unsubscribe')).toBe(1);
    expect(h.listeners.size).toBe(0);
  });

  it('finishes the retained settlement observation before releasing on a late terminal', async () => {
    const reply = createDeferred<{ kind: 'accepted' }>();
    const h = harness({
      interruptCompletes: false,
      observeSettlement: true,
      readTurnStatus: 'inProgress',
      interruptReplies: [Promise.resolve({ kind: 'accepted' }), reply.promise],
    });
    const turn = h.run();
    await turn.started;
    await flushMicrotasks(20);
    turn.abort();
    await flushMicrotasks(20);
    await h.tick(10_000);
    await turn.done;
    for (let i = 0; i < 8; i += 1) await h.tick(250);
    expect(turn.interrupt).toHaveBeenCalledTimes(2);
    turn.finish('interrupted');
    await flushMicrotasks(30);
    expect(h.count('thread/unsubscribe')).toBe(0);
    reply.resolve({ kind: 'accepted' });
    await flushMicrotasks(30);
    expect(h.count('thread/unsubscribe')).toBe(1);
    expect(h.listeners.size).toBe(0);
  });

  it('releases both thread identities without stale dispatch after a mismatched resume response', async () => {
    const h = harness({ resumedIds: ['wrong-thread'], turnStatus: 'completed' });
    const wrong = h.run();
    await wrong.done;
    await flushMicrotasks(30);
    expect(h.rpc).toHaveBeenCalledWith('thread/unsubscribe', { threadId: 'wrong-thread' });
    expect(h.count('turn/start')).toBe(0);
    expect(wrong.notSubmitted).toHaveBeenCalledOnce();
    const next = h.run();
    await next.done;
    await flushMicrotasks(30);
    expect(next.events.find((event) => event.kind === 'terminal')).toMatchObject({
      terminal: { outcome: { kind: 'completed' } },
    });
    expect(h.rpc).toHaveBeenCalledWith('thread/unsubscribe', { threadId: 'thread-1' });
    await h.tick(2000);
    expect(
      h.rpc.mock.calls.filter(([method]) => method === 'thread/unsubscribe').map(([, params]) => params.threadId),
    ).toEqual(['wrong-thread', 'thread-1']);
  });

  it('keeps an inferred turn loaded until the transferred settlement observer closes', async () => {
    const h = harness({ observeSettlement: true }).run();
    await h.started;
    await flushMicrotasks(20);
    h.finalAnswer();
    h.time.tick(250);
    await h.done;
    expect(h.methods).not.toContain('thread/unsubscribe');
    const observer = h.settlement();
    expect(observer).toBeDefined();
    const settled = observer!.settle();
    h.time.tick(250);
    await flushMicrotasks(20);
    expect(await settled).toMatchObject({ kind: 'provider-turn-terminal', providerTurnId: 'turn-1' });
    expect(h.methods).toContain('thread/read');
    expect(h.methods).not.toContain('thread/unsubscribe');
    observer!.close();
    await flushMicrotasks(20);
    expect(h.listeners.size).toBe(0);
    expect(h.methods).toContain('thread/unsubscribe');
    observer!.close();
    await flushMicrotasks(20);
    expect(h.rpc.mock.calls.filter(([method]) => method === 'thread/unsubscribe')).toHaveLength(1);
  });

  it.each(['rejected', 'refused', 'no-reply'] as const)(
    'does not delay terminal delivery and reports %s release',
    async (outcome) => {
      const h = harness({
        unsubscribe: () =>
          outcome === 'rejected'
            ? Promise.reject(new Error('unsubscribe refused'))
            : outcome === 'refused'
              ? Promise.resolve({ status: 'notSubscribed' })
              : new Promise(() => {}),
      }).run();
      await h.started;
      await flushMicrotasks(20);
      h.finish();
      await h.done;
      expect(h.time.now()).toBe(1_000_000);
      expect(h.events.find((event) => event.kind === 'terminal')).toMatchObject({
        terminal: { outcome: { kind: 'completed' } },
      });
      await flushMicrotasks(20);
      h.time.tick(1000);
      await flushMicrotasks(20);
      expect(h.diagnostics).toHaveBeenCalled();
      expect(h.diagnostics.mock.calls.join(' ')).toMatch(/unsubscribe|release/i);
      expect(h.diagnostics.mock.calls.join(' ')).toMatch(outcome === 'refused' ? /refused/i : /release unconfirmed/i);
    },
  );
});

describe('codexTurnKernel successor subscriptions', () => {
  async function predecessorWithPendingSteer(h: ReturnType<typeof harness>) {
    const first = h.run();
    await first.started;
    await flushMicrotasks(30);
    expect(first.port.admit({ threadId: 'thread-1', turnId: 'turn-1' }, 'late-steer')).toEqual({ state: 'admitted' });
    h.finish('turn-1');
    await first.done;
    expect(h.unsubscribes()).toBe(0);
    return first;
  }

  it.each(['pending-steer', 'superseded-release', 'expired-superseded-release'] as const)(
    'releases the predecessor exactly once after a rejected resume with %s',
    async (state) => {
      const h = harness();
      const first = await predecessorWithPendingSteer(h);
      const reply = h.deferNextResume();
      const second = h.run();
      await flushMicrotasks(30);
      expect(h.count('thread/resume')).toBe(2);
      if (state === 'superseded-release') {
        first.port.reportOutcome('late-steer', { state: 'unknown', reason: 'Delayed steering reply' });
        await flushMicrotasks(30);
      }
      if (state === 'expired-superseded-release') await h.tick(1000);
      expect(h.unsubscribes()).toBe(0);
      reply.reject(new Error('Successor resume rejected'));
      await second.done;
      expect(second.notSubmitted).toHaveBeenCalledOnce();
      expect(second.events.find((event) => event.kind === 'terminal')).toMatchObject({
        terminal: { outcome: { kind: 'provider_exit' } },
      });
      if (state !== 'superseded-release') {
        expect(h.unsubscribes()).toBe(0);
        first.port.reportOutcome('late-steer', { state: 'unknown', reason: 'Delayed steering reply' });
      }
      await flushMicrotasks(50);
      expect(h.unsubscribes()).toBe(1);
      expect(h.subscribed()).toBe(false);
      expect(h.count('turn/start')).toBe(1);
      await h.tick(2000);
      expect(h.unsubscribes()).toBe(1);
    },
  );

  it('does not send a second unsubscribe when the predecessor already dispatched release', async () => {
    const releaseReply = createDeferred<unknown>();
    const h = harness({ unsubscribe: () => releaseReply.promise });
    const first = h.run();
    await first.started;
    await flushMicrotasks(30);
    h.finish('turn-1');
    await first.done;
    await flushMicrotasks(30);
    expect(h.unsubscribes()).toBe(1);
    const resumeReply = h.deferNextResume();
    const second = h.run();
    await flushMicrotasks(30);
    resumeReply.reject(new Error('Successor resume rejected'));
    await second.done;
    await flushMicrotasks(30);
    expect(second.notSubmitted).toHaveBeenCalledOnce();
    expect(h.unsubscribes()).toBe(1);
    releaseReply.resolve({ status: 'unsubscribed' });
    await flushMicrotasks(30);
    await h.tick(2000);
    expect(h.unsubscribes()).toBe(1);
  });

  it('hands release back during a transient resume retry delay before the successor runs', async () => {
    const h = harness();
    const first = await predecessorWithPendingSteer(h);
    const reply = h.deferNextResume();
    const second = h.run();
    await flushMicrotasks(30);
    reply.reject(resumeError('active-writer'));
    await flushMicrotasks(30);
    first.port.reportOutcome('late-steer', { state: 'unknown', reason: 'Delayed steering reply' });
    await flushMicrotasks(50);
    expect(h.unsubscribes()).toBe(1);
    expect(h.count('turn/start')).toBe(1);
    await h.tick(250);
    await second.started;
    await flushMicrotasks(30);
    expect(h.subscribed()).toBe(true);
    h.finish('turn-2');
    await second.done;
    await flushMicrotasks(30);
    expect(second.notSubmitted).not.toHaveBeenCalled();
    expect(second.events.find((event) => event.kind === 'terminal')).toMatchObject({
      terminal: { outcome: { kind: 'completed' } },
    });
    expect(h.unsubscribes()).toBe(2);
    expect(h.subscribed()).toBe(false);
  });

  it('keeps a newer successful successor protected when an intermediate resume fails', async () => {
    const h = harness();
    const first = await predecessorWithPendingSteer(h);
    const reply = h.deferNextResume();
    const second = h.run();
    await flushMicrotasks(30);
    const third = h.run();
    await third.started;
    await flushMicrotasks(30);
    reply.reject(new Error('Intermediate resume rejected'));
    await second.done;
    first.port.reportOutcome('late-steer', { state: 'unknown', reason: 'Delayed steering reply' });
    await flushMicrotasks(50);
    expect(h.unsubscribes()).toBe(0);
    expect(h.subscribed()).toBe(true);
    h.finish('turn-2');
    await third.done;
    await flushMicrotasks(30);
    expect(third.events.find((event) => event.kind === 'terminal')).toMatchObject({
      terminal: { outcome: { kind: 'completed' } },
    });
    expect(h.unsubscribes()).toBe(1);
    expect(h.subscribed()).toBe(false);
  });

  it('returns release responsibility past multiple rejected successors', async () => {
    const h = harness();
    const first = await predecessorWithPendingSteer(h);
    const secondReply = h.deferNextResume();
    const second = h.run();
    await flushMicrotasks(30);
    const thirdReply = h.deferNextResume();
    const third = h.run();
    await flushMicrotasks(30);
    secondReply.reject(new Error('Intermediate resume rejected'));
    await second.done;
    thirdReply.reject(new Error('Latest resume rejected'));
    await third.done;
    first.port.reportOutcome('late-steer', { state: 'unknown', reason: 'Delayed steering reply' });
    await flushMicrotasks(50);
    expect(h.count('turn/start')).toBe(1);
    expect(h.unsubscribes()).toBe(1);
    expect(h.subscribed()).toBe(false);
    await h.tick(2000);
    expect(h.unsubscribes()).toBe(1);
  });
  it.each(['running', 'resume-response-pending'] as const)(
    'keeps the successor subscription when its state is %s and the old steering outcome arrives',
    async (state) => {
      const h = harness();
      const first = h.run();
      await first.started;
      await flushMicrotasks(30);
      expect(first.port.admit({ threadId: 'thread-1', turnId: 'turn-1' }, 'late-steer')).toEqual({
        state: 'admitted',
      });
      h.finish('turn-1');
      await first.done;
      expect(h.unsubscribes()).toBe(0);
      if (state === 'resume-response-pending') h.deferResume();
      const second = h.run();
      await h.resumeEntered;
      if (state === 'running') {
        await second.started;
        await flushMicrotasks(30);
      }
      expect(first.lease).not.toBe(second.lease);
      expect(first.lease.closed).not.toBe(second.lease.closed);
      first.port.reportOutcome('late-steer', { state: 'unknown', reason: 'Delayed steering reply' });
      await flushMicrotasks(30);
      expect(h.unsubscribes()).toBe(0);
      expect(h.subscribed()).toBe(true);
      h.resume();
      await second.started;
      await flushMicrotasks(30);
      h.finish('turn-2');
      await second.done;
      await flushMicrotasks(30);
      expect(second.events.find((event) => event.kind === 'terminal')).toMatchObject({
        terminal: { outcome: { kind: 'completed' } },
      });
      expect(h.unsubscribes()).toBe(1);
      expect(h.subscribed()).toBe(false);
    },
  );
});

describe('codexTurnKernel resume rejections', () => {
  it('retries the exact active-writer rejection without retrying unrelated writer errors', async () => {
    const writer = harness({ resumeErrors: [resumeError('active-writer')], turnStatus: 'completed' });
    const resumed = writer.run();
    await flushMicrotasks(50);
    expect(writer.count('turn/start')).toBe(0);
    await writer.tick(250);
    await resumed.done;
    expect(writer.count('thread/resume')).toBe(2);
    expect(writer.count('turn/start')).toBe(1);
    expect(resumed.notSubmitted).not.toHaveBeenCalled();
    expect(resumed.events.find((event) => event.kind === 'terminal')).toMatchObject({
      terminal: { outcome: { kind: 'completed' } },
    });

    const missing = harness({ resumeErrors: [new Error('thread thread-1 not found')] });
    const unavailable = missing.run();
    await expect(unavailable.done).rejects.toThrow('no longer resumable');
    expect(missing.count('thread/resume')).toBe(1);
    expect(missing.count('turn/start')).toBe(0);
    expect(unavailable.notSubmitted).toHaveBeenCalledOnce();

    const unrelated = harness({ resumeErrors: [new Error('another active writer')] });
    const failed = unrelated.run();
    await failed.done;
    expect(unrelated.count('thread/resume')).toBe(1);
    expect(unrelated.count('turn/start')).toBe(0);
    expect(failed.events.find((event) => event.kind === 'terminal')).toMatchObject({
      terminal: { outcome: { kind: 'provider_exit' } },
    });
    expect(failed.notSubmitted).toHaveBeenCalledOnce();
  });

  it('exhausts the shared retry schedule with a facts-only failure and records no delivery', async () => {
    const h = harness({ resumeErrors: Array.from({ length: 4 }, () => resumeError('active-writer')) });
    const invocation = h.run();
    await flushMicrotasks(50);
    for (const delay of [250, 500, 1000]) await h.tick(delay);
    await invocation.done;
    expect(h.count('thread/resume')).toBe(4);
    expect(h.timers.mock.calls.map(([, ms]) => ms)).toEqual([250, 500, 1000]);
    expect(h.count('turn/start')).toBe(0);
    expect(invocation.notSubmitted).toHaveBeenCalledOnce();
    expect(invocation.events.find((event) => event.kind === 'terminal')).toMatchObject({
      terminal: { outcome: { kind: 'failed' } },
      failureCause: {
        body: {
          reason: 'request_failed',
          message:
            'Codex reported an active writer for thread thread-1 on the final resume attempt (4 attempts); no turn was submitted.',
        },
      },
    });
  });

  it('does not retry unrelated resume failures', async () => {
    const h = harness({ resumeErrors: [new Error('RPC transport failed')] });
    const invocation = h.run();
    await invocation.done;
    expect(h.count('thread/resume')).toBe(1);
    expect(invocation.notSubmitted).toHaveBeenCalledOnce();
    expect(invocation.events.find((event) => event.kind === 'terminal')).toMatchObject({
      terminal: { outcome: { kind: 'provider_exit' } },
    });
  });

  it('does not retry or submit after abort during the first active-writer retry delay', async () => {
    const h = harness({ resumeErrors: [resumeError('active-writer')] });
    const invocation = h.run();
    await flushMicrotasks(50);
    invocation.controller.abort();
    await invocation.done;
    await h.tick(10_000);
    expect(h.count('thread/resume')).toBe(1);
    expect(h.count('turn/start')).toBe(0);
    expect(invocation.notSubmitted).toHaveBeenCalledOnce();
    expect(invocation.events.find((event) => event.kind === 'terminal')).toMatchObject({
      terminal: { outcome: { kind: 'aborted' } },
    });
  });
});

describe('Codex transient resume rejection', () => {
  it('retries only the complete closing responses and leaves unrelated closing failures terminal', async () => {
    for (const message of [
      'connection is closing',
      'thread thread-1 is closing',
      'thread thread-1 is closing; retry later',
    ]) {
      const h = harness({ resumeErrors: [new Error(message)] });
      const failed = h.run();
      await failed.done;
      expect(h.count('thread/resume')).toBe(1);
      expect(h.count('turn/start')).toBe(0);
      expect(failed.notSubmitted).toHaveBeenCalledOnce();
      expect(failed.events.find((event) => event.kind === 'terminal')).toMatchObject({
        terminal: { outcome: { kind: 'provider_exit' } },
      });
    }
    for (const message of [
      'thread thread-1 is closing; retry thread/resume after the thread is closed',
      'thread thread-1 is closing; retry after the thread is closed',
    ]) {
      const h = harness({ resumeErrors: [new Error(message)], turnStatus: 'completed' });
      const resumed = h.run();
      await flushMicrotasks(50);
      expect(h.count('turn/start')).toBe(0);
      await h.tick(250);
      await resumed.done;
      expect(h.count('thread/resume')).toBe(2);
      expect(h.count('turn/start')).toBe(1);
      expect(resumed.notSubmitted).not.toHaveBeenCalled();
      expect(resumed.events.find((event) => event.kind === 'terminal')).toMatchObject({
        terminal: { outcome: { kind: 'completed' } },
      });
    }
  });

  it('resumes on the same host after unsubscribe briefly leaves the thread closing', async () => {
    const h = harness({ closingDelay: 250, turnStatus: 'completed' });
    const first = h.run('exec');
    await first.done;
    await flushMicrotasks(50);
    expect(h.count('thread/unsubscribe')).toBe(1);
    const second = h.run();
    await flushMicrotasks(50);
    expect(first.lease.connectionIdentity).toBe(second.lease.connectionIdentity);
    expect(h.count('thread/resume')).toBe(1);
    expect(h.count('turn/start')).toBe(1);
    await h.tick(250);
    await second.done;
    expect(h.count('thread/resume')).toBe(2);
    expect(h.count('turn/start')).toBe(2);
    expect(second.notSubmitted).not.toHaveBeenCalled();
    expect(second.events.find((event) => event.kind === 'terminal')).toMatchObject({
      terminal: { outcome: { kind: 'completed' } },
    });
  });

  it.each([
    { name: 'closing throughout', rejections: ['closing', 'closing', 'closing', 'closing'], lastReason: 'closing' },
    {
      name: 'stale-listener closing throughout',
      rejections: ['listener-closing', 'listener-closing', 'listener-closing', 'listener-closing'],
      lastReason: 'closing',
    },
    {
      name: 'mixed reasons ending closing',
      rejections: ['active-writer', 'closing', 'active-writer', 'closing'],
      lastReason: 'closing',
    },
    {
      name: 'mixed reasons ending active writer',
      rejections: ['closing', 'active-writer', 'closing', 'active-writer'],
      lastReason: 'active-writer',
    },
  ] as const)(
    'exhausts one shared schedule for $name and diagnoses its final rejection',
    async ({ rejections, lastReason }) => {
      const h = harness({ resumeErrors: rejections.map(resumeError), turnStatus: 'completed' });
      const invocation = h.run();
      await flushMicrotasks(50);
      await h.tick(250);
      await h.tick(500);
      await h.tick(1000);
      await invocation.done;
      expect(h.count('thread/resume')).toBe(4);
      expect(h.count('turn/start')).toBe(0);
      expect(invocation.notSubmitted).toHaveBeenCalledOnce();
      expect(h.time.now()).toBe(1_001_750);
      expect(h.timers.mock.calls.map(([, ms]) => ms)).toEqual([250, 500, 1000]);
      const terminal = invocation.events.find((event) => event.kind === 'terminal');
      expect(terminal).toMatchObject({
        terminal: { outcome: { kind: 'failed' } },
        failureCause: { body: { reason: 'request_failed' } },
      });
      if (terminal?.kind !== 'terminal') throw new Error('Missing terminal');
      const cause = terminal.failureCause;
      if (cause?.type !== 'session.provider_failed') throw new Error('Missing request failure cause');
      const message = cause.body.message;
      expect(message).toContain('thread-1');
      expect(message).toContain('no turn was submitted');
      expect(message).toContain(lastReason === 'closing' ? 'closing' : 'active writer');
      expect(message).not.toMatch(/live Coral|owns|held by/);
      if (lastReason === 'closing') expect(message).not.toContain('active writer');
      else expect(message).not.toContain('closing');
    },
  );

  it('aborts during the second closing retry delay without retrying or submitting later', async () => {
    const h = harness({ resumeErrors: Array.from({ length: 4 }, () => resumeError('closing')) });
    const invocation = h.run();
    await flushMicrotasks(50);
    await h.tick(250);
    expect(h.count('thread/resume')).toBe(2);
    invocation.controller.abort();
    await invocation.done;
    await h.tick(10_000);
    expect(h.count('thread/resume')).toBe(2);
    expect(h.count('turn/start')).toBe(0);
    expect(invocation.notSubmitted).toHaveBeenCalledOnce();
    expect(invocation.events.find((event) => event.kind === 'terminal')).toMatchObject({
      terminal: { outcome: { kind: 'aborted' } },
    });
  });
});
