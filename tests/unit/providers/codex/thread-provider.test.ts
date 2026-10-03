import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import type {
  AppServerSession,
  ProviderAppServerRuntime,
  ProviderEventBody,
  ProviderRequest,
} from '#src/providers/contract.js';
import { codexThreadProvider } from '#src/providers/codex/thread-provider.js';
import { codexTurnKernel } from '#src/providers/codex/thread-kernel.js';
import { codexAppServerLifecycle } from '#src/providers/codex/provider-facets.js';
import { commitContinuityEvent } from '#src/providers/internal/continuity-commit.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import {
  buildCodexExecutionPlan as buildCodexExecutionPlanWithHost,
  buildCodexHost,
  type CodexExecutionPlan,
} from '#src/providers/codex/execution-plan.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { flushMicrotasks, VirtualTime } from '#tools/simulation/core/virtual-time.js';
import { TEST_CODEX_ACCESS } from '../../../helpers/provider-credentials.js';

const TEST_WORKSPACE = mkdtempSync(join(tmpdir(), 'coral-codex-thread-provider-'));
const TEST_PERSISTED_CWD = join(TEST_WORKSPACE, 'persisted');
mkdirSync(TEST_PERSISTED_CWD);

afterAll(() => rmSync(TEST_WORKSPACE, { recursive: true, force: true }));

function buildCodexExecutionPlan(options: Omit<Parameters<typeof buildCodexExecutionPlanWithHost>[0], 'hostPlan'>) {
  const host = buildCodexHost(options);
  const prepared = buildCodexExecutionPlanWithHost({ ...options, hostPlan: host });
  return { ...prepared, plan: { host, session: prepared.session, turn: prepared.turn } };
}

type MockLease = AppServerSession & {
  close(outcome?: Error | void): void;
  waitForRpc(method: string, count?: number): Promise<void>;
  emit(message: { method: string; params?: Record<string, unknown> }): void;
  rpcMock: ReturnType<typeof vi.fn>;
};

const LISTED_SIZES = {
  data: ['gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-terra', 'gpt-6-luna'].map((model) => ({
    model,
    hidden: false,
    upgrade: null,
    supportedReasoningEfforts: [],
  })),
  nextCursor: null,
};

function makeLease(rpcImpl: (method: string, params: Record<string, unknown>) => Promise<unknown>): MockLease {
  const handlers = new Set<(message: { method: string; params?: Record<string, unknown> }) => void>();
  const closed = createDeferred<Error | void>();
  const waiters: Array<{ method: string; count: number; resolve: () => void }> = [];
  const rpcMock = vi.fn((method: string, params: Record<string, unknown>) => {
    const response =
      method === 'model/list'
        ? Promise.resolve(LISTED_SIZES)
        : method === 'config/read'
          ? Promise.resolve({ config: {} })
          : rpcImpl(method, params);
    for (const waiter of waiters) {
      if (waiter.method === method && rpcMock.mock.calls.filter(([name]) => name === method).length >= waiter.count) {
        waiter.resolve();
      }
    }
    return response;
  });

  const lease: MockLease = {
    waitForRpc(method, count = 1) {
      if (rpcMock.mock.calls.filter(([name]) => name === method).length >= count) return Promise.resolve();
      const deferred = createDeferred<void>();
      waiters.push({ method, count, resolve: () => deferred.resolve() });
      return deferred.promise;
    },
    rpc: rpcMock as unknown as AppServerSession['rpc'],
    subscribe(next) {
      handlers.add(next);
      return () => {
        handlers.delete(next);
      };
    },
    closed: closed.promise,
    interrupt: (continuity) => codexAppServerLifecycle.interrupt!(lease, continuity),
    close(outcome) {
      closed.resolve(outcome);
    },
    emit(message) {
      for (const handler of handlers) handler(message);
    },
    rpcMock,
  };
  return lease;
}

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    action: 'resume',
    sessionId: 'job-codex-thread-provider',
    name: 'codex',
    conversationRef: 'thread-1',
    prompt: 'Resume and continue',
    cwd: fixtureCanonicalWorkDir(TEST_WORKSPACE),
    bypassPermissions: false,
    coralEnv: {},
    ...overrides,
  };
}

type CodexRuntime = ProviderAppServerRuntime<CodexExecutionPlan>;

function makeRuntime(
  lease: AppServerSession,
  persistedContinuity: CodexRuntime['persistedContinuity'] = {
    cwd: TEST_PERSISTED_CWD,
    threadId: 'thread-1',
  },
  overrides: Partial<
    Pick<
      CodexRuntime,
      'signal' | 'storage' | 'env' | 'continuityBridge' | 'time' | 'onProviderTurnTerminal' | 'onProviderTurnSettlement'
    >
  > = {},
): CodexRuntime {
  const prepared = buildCodexExecutionPlan({
    access: TEST_CODEX_ACCESS,
    request: makeRequest(),
    ...(persistedContinuity === undefined ? {} : { persistedContinuity }),
    baseEnv: {},
    platform: 'linux',
  });
  return {
    transport: 'app-server',
    signal: overrides.signal ?? new AbortController().signal,
    time: overrides.time ?? new VirtualTime(),
    ids: { uuid: () => 'test-uuid', sha256: () => 'sha256:fake' },
    storage:
      overrides.storage ??
      ({
        existsSync: () => true,
        readFileSync: () => {
          throw Object.assign(new Error('No config in fixture'), { code: 'ENOENT' });
        },
      } as unknown as CodexRuntime['storage']),
    ...(overrides.env ? { env: overrides.env } : {}),
    appServerSession: lease,
    persistedContinuity,
    continuityBridge:
      overrides.continuityBridge ??
      ({
        checkpoint: () => {},
        transportClosed: () => {},
      } satisfies CodexRuntime['continuityBridge']),
    onProviderTurnTerminal: overrides.onProviderTurnTerminal ?? (() => {}),
    ...(overrides.onProviderTurnSettlement ? { onProviderTurnSettlement: overrides.onProviderTurnSettlement } : {}),
    kbRoot: '/mock/kb',
    executionPlan: prepared.plan,
  };
}

async function collect(stream: AsyncIterable<ProviderEventBody>): Promise<ProviderEventBody[]> {
  const events: ProviderEventBody[] = [];
  for await (const event of stream) {
    events.push(event);
    if (event.kind === 'continuity') commitContinuityEvent(event);
  }
  return events;
}

describe('codexThreadProvider', () => {
  it('resumes the same thread after its app-server host retires between turns', async () => {
    const threadId = 'thread-after-retirement';
    const firstLease = makeLease(async (method) => {
      if (method === 'thread/start') return { thread: { id: threadId } };
      if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'completed' } };
      throw new Error(`Unexpected method: ${method}`);
    });
    const firstRequest = makeRequest({ action: 'exec', conversationRef: undefined });

    const firstEvents = await collect(
      codexThreadProvider(firstRequest, makeRuntime(firstLease, { cwd: TEST_WORKSPACE })),
    );
    const persistedContinuity = firstEvents.find(
      (event): event is Extract<ProviderEventBody, { kind: 'continuity' }> =>
        event.kind === 'continuity' && event.providerContinuity?.threadId === threadId,
    )?.providerContinuity;

    expect(firstLease.rpcMock).toHaveBeenCalledWith('thread/start', expect.any(Object));
    expect(firstLease.rpcMock).not.toHaveBeenCalledWith('thread/resume', expect.any(Object));
    expect(persistedContinuity).toMatchObject({ threadId });
    if (persistedContinuity === undefined || persistedContinuity === null) {
      throw new Error('First turn did not persist Codex thread continuity.');
    }

    firstLease.close();
    await expect(firstLease.closed).resolves.toBeUndefined();

    const followUpLease = makeLease(async (method, params) => {
      if (method === 'thread/resume') return { thread: { id: params.threadId } };
      if (method === 'turn/start') return { turn: { id: 'turn-2', status: 'completed' } };
      throw new Error(`Unexpected method: ${method}`);
    });
    const followUpRequest = makeRequest({ conversationRef: threadId, prompt: 'Continue after retirement' });

    await collect(codexThreadProvider(followUpRequest, makeRuntime(followUpLease, persistedContinuity)));

    expect(followUpLease.rpcMock).toHaveBeenCalledWith(
      'thread/resume',
      expect.objectContaining({ threadId: persistedContinuity.threadId }),
    );
    expect(followUpLease.rpcMock).not.toHaveBeenCalledWith('thread/start', expect.any(Object));
  });

  it('isolates thread config, notifications, and cancellation for two turns on one shared session', async () => {
    const lease = makeLease(async (method, params) => {
      if (method === 'thread/resume') return { thread: { id: params.threadId } };
      if (method === 'turn/start') return { turn: { id: `turn-${params.threadId}`, status: 'inProgress' } };
      if (method === 'turn/interrupt') return {};
      throw new Error(`Unexpected method: ${method}`);
    });
    const requestA = makeRequest({ sessionId: 'job-a', conversationRef: 'thread-a' });
    const requestB = makeRequest({ sessionId: 'job-b', conversationRef: 'thread-b' });
    const controllerB = new AbortController();
    const runtimeA = makeRuntime(lease, { cwd: TEST_WORKSPACE, threadId: 'thread-a' });
    const runtimeB = makeRuntime(lease, { cwd: TEST_WORKSPACE, threadId: 'thread-b' }, { signal: controllerB.signal });
    runtimeA.executionPlan = buildCodexExecutionPlan({
      access: TEST_CODEX_ACCESS,
      request: requestA,
      baseEnv: {},
      protectedEnv: { CORAL_CHILD_PRINCIPAL_HANDLE: 'handle-a' },
      platform: 'linux',
    }).plan;
    runtimeB.executionPlan = buildCodexExecutionPlan({
      access: TEST_CODEX_ACCESS,
      request: requestB,
      baseEnv: {},
      protectedEnv: { CORAL_CHILD_PRINCIPAL_HANDLE: 'handle-b' },
      platform: 'linux',
    }).plan;

    const eventsA = collect(codexThreadProvider(requestA, runtimeA));
    let bSettled = false;
    const eventsB = collect(codexThreadProvider(requestB, runtimeB)).finally(() => {
      bSettled = true;
    });
    await lease.waitForRpc('turn/start', 2);

    const resumeCalls = lease.rpcMock.mock.calls.filter(([method]) => method === 'thread/resume');
    const configA = resumeCalls.find(([, params]) => params.threadId === 'thread-a')?.[1].config;
    const configB = resumeCalls.find(([, params]) => params.threadId === 'thread-b')?.[1].config;
    expect(configA).toMatchObject({ shell_environment_policy: { set: { CORAL_CHILD_PRINCIPAL_HANDLE: 'handle-a' } } });
    expect(configB).toMatchObject({ shell_environment_policy: { set: { CORAL_CHILD_PRINCIPAL_HANDLE: 'handle-b' } } });
    expect(configA).not.toEqual(configB);

    lease.emit({
      method: 'turn/completed',
      params: { threadId: 'thread-a', turn: { id: 'turn-thread-a', status: 'completed' } },
    });
    await expect(eventsA).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'terminal' })]));
    expect(bSettled).toBe(false);

    controllerB.abort('cancel-b');
    await lease.waitForRpc('turn/interrupt');
    lease.emit({
      method: 'turn/completed',
      params: { threadId: 'thread-b', turn: { id: 'turn-thread-b', status: 'interrupted' } },
    });
    await expect(eventsB).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'terminal' })]));
    expect(lease.rpcMock).not.toHaveBeenCalledWith('turn/interrupt', expect.objectContaining({ threadId: 'thread-a' }));
  });

  it('does not start a turn until the resumed thread checkpoint is durably committed', async () => {
    const durable = createDeferred<void>();
    const checkpointEntered = createDeferred<void>();
    const checkpoint = vi.fn(() => {
      checkpointEntered.resolve();
      return durable.promise;
    });
    const lease = makeLease(async (method) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'completed' } };
      throw new Error(`Unexpected method: ${method}`);
    });
    const runtime = makeRuntime(lease, undefined, {
      continuityBridge: { checkpoint, transportClosed: vi.fn() },
    });

    const events = collect(codexTurnKernel(makeRequest(), runtime));
    await checkpointEntered.promise;
    expect(lease.rpcMock).not.toHaveBeenCalledWith('turn/start', expect.any(Object));

    durable.resolve();
    await expect(events).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'terminal' })]));
    expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.objectContaining({ threadId: 'thread-1' }));
  });

  it('continues one structured capacity failure in the same thread and emits one terminal', async () => {
    let starts = 0;
    const lease = makeLease(async (method) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') {
        starts += 1;
        return { turn: { id: `turn-${starts}`, status: 'inProgress' } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const runtime = makeRuntime(lease);
    const eventsPromise = collect(codexThreadProvider(makeRequest({ prompt: 'original task' }), runtime));

    await lease.waitForRpc('turn/start');
    lease.emit({
      method: 'error',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        willRetry: false,
        error: {
          message: 'Selected model is at capacity. Please try a different model.',
          codexErrorInfo: 'serverOverloaded',
        },
      },
    });
    lease.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'failed',
          error: {
            message: 'Selected model is at capacity. Please try a different model.',
            codexErrorInfo: 'serverOverloaded',
          },
        },
      },
    });

    await lease.waitForRpc('turn/start', 2);
    const secondStart = lease.rpcMock.mock.calls.filter(([method]) => method === 'turn/start')[1]?.[1];
    expect(secondStart).toMatchObject({
      threadId: 'thread-1',
      input: [
        {
          type: 'text',
          text: expect.stringContaining('Continue the unanswered or partial response'),
        },
      ],
    });
    expect(JSON.stringify(secondStart)).not.toContain('original task');
    const [firstStart] = lease.rpcMock.mock.calls
      .filter(([method]) => method === 'turn/start')
      .map(([, params]) => params);
    const { input: _firstInput, ...firstOptions } = firstStart as Record<string, unknown>;
    const { input: _secondInput, ...secondOptions } = secondStart as Record<string, unknown>;
    expect(secondOptions).toEqual(firstOptions);

    lease.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-2',
        item: { type: 'agentMessage', text: 'Recovered answer', phase: 'final_answer' },
      },
    });
    lease.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'failed', error: { message: 'late failure', codexErrorInfo: 'badRequest' } },
      },
    });
    lease.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', text: 'stale answer', phase: 'final_answer' },
      },
    });
    lease.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        item: { type: 'agentMessage', text: 'id-less stale answer', phase: 'final_answer' },
      },
    });
    lease.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-2',
        item: { type: 'agentMessage', text: '', phase: 'final_answer' },
      },
    });
    lease.emit({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-2',
        tokenUsage: {
          total: { inputTokens: 120, cachedInputTokens: 20, outputTokens: 7 },
        },
      },
    });
    lease.emit({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          total: { inputTokens: 999, cachedInputTokens: 99, outputTokens: 99 },
        },
      },
    });
    lease.emit({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed' } },
    });

    const events = await eventsPromise;
    expect(events.filter((event) => event.kind === 'terminal')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      kind: 'terminal',
      terminal: {
        content: 'Recovered answer',
        outcome: { kind: 'completed' },
        usage: { inputTokens: 100, cacheReadTokens: 20, outputTokens: 7 },
      },
    });
    const progress = events.flatMap((event) => (event.kind === 'progress' ? [event.message] : []));
    expect(
      progress.filter((message) => message === 'Codex capacity reached; retrying the same thread (1/1).'),
    ).toHaveLength(1);
    expect(progress).not.toContain('Turn failed.');
    expect(progress.some((message) => message.startsWith('Codex error: Selected model is at capacity'))).toBe(false);
    const continuity = events.flatMap((event) => (event.kind === 'continuity' ? [event.providerContinuity] : []));
    const turn1Index = continuity.findIndex((entry) => entry?.turnId === 'turn-1');
    const turn2Index = continuity.findIndex((entry) => entry?.turnId === 'turn-2');
    expect(turn1Index).toBeGreaterThanOrEqual(0);
    expect(turn2Index).toBeGreaterThan(turn1Index);
    expect(continuity.slice(turn1Index + 1, turn2Index).some((entry) => entry?.turnId === undefined)).toBe(true);
    expect(continuity.at(-1)?.turnId).toBeUndefined();
  });

  it('continues one structured cyber-policy failure in the same thread', async () => {
    let starts = 0;
    const lease = makeLease(async (method) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') {
        starts += 1;
        return { turn: { id: `turn-${starts}`, status: 'inProgress' } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const eventsPromise = collect(
      codexThreadProvider(makeRequest({ prompt: 'ordinary implementation task' }), makeRuntime(lease)),
    );

    await lease.waitForRpc('turn/start');
    lease.emit({
      method: 'error',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        willRetry: false,
        error: { message: 'This content was flagged for possible cybersecurity risk.', codexErrorInfo: 'cyberPolicy' },
      },
    });
    lease.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'failed',
          error: {
            message: 'This content was flagged for possible cybersecurity risk.',
            codexErrorInfo: 'cyberPolicy',
          },
        },
      },
    });

    await lease.waitForRpc('turn/start', 2);
    const startsParams = lease.rpcMock.mock.calls
      .filter(([method]) => method === 'turn/start')
      .map(([, params]) => params as Record<string, unknown>);
    expect(startsParams[1]).toMatchObject({
      threadId: 'thread-1',
      input: [
        {
          type: 'text',
          text: expect.stringContaining('Keep the work strictly within defensive software quality'),
        },
      ],
    });
    expect(JSON.stringify(startsParams[1])).not.toContain('ordinary implementation task');

    lease.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-2',
        item: { type: 'agentMessage', text: 'Recovered from a policy false positive', phase: 'final_answer' },
      },
    });
    lease.emit({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed' } },
    });

    const events = await eventsPromise;
    expect(events.filter((event) => event.kind === 'terminal')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      kind: 'terminal',
      terminal: { content: 'Recovered from a policy false positive', outcome: { kind: 'completed' } },
    });
    const progress = events.flatMap((event) => (event.kind === 'progress' ? [event.message] : []));
    expect(progress).toContain('Codex policy check stopped the turn; retrying the same thread (1/1).');
    expect(progress.some((message) => message.startsWith('Codex error: This content was flagged'))).toBe(false);
  });

  it('preserves the last pre-retirement usage when the continuation emits no usage', async () => {
    let starts = 0;
    const lease = makeLease(async (method) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') {
        starts += 1;
        return { turn: { id: `turn-${starts}`, status: 'inProgress' } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const eventsPromise = collect(codexThreadProvider(makeRequest(), makeRuntime(lease)));
    await lease.waitForRpc('turn/start');
    lease.emit({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 } },
      },
    });
    lease.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'failed',
          error: { message: 'capacity', codexErrorInfo: 'serverOverloaded' },
        },
      },
    });
    await lease.waitForRpc('turn/start', 2);
    lease.emit({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed' } },
    });

    const events = await eventsPromise;
    expect(events.at(-1)).toMatchObject({
      kind: 'terminal',
      terminal: { usage: { inputTokens: 60, cacheReadTokens: 40, outputTokens: 10 } },
    });
  });

  it('does not use stale or unstructured error notifications as capacity evidence', async () => {
    for (const errorEvent of [
      {
        method: 'error',
        params: {
          threadId: 'thread-1',
          turnId: 'other-turn',
          willRetry: false,
          error: { message: 'capacity', codexErrorInfo: 'serverOverloaded' },
        },
      },
      {
        method: 'error',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          willRetry: false,
          error: { message: 'Selected model is at capacity. Please try a different model.' },
        },
      },
    ]) {
      let starts = 0;
      const lease = makeLease(async (method) => {
        if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') {
          starts += 1;
          return { turn: { id: 'turn-1', status: 'inProgress' } };
        }
        throw new Error(`Unexpected method: ${method}`);
      });
      const eventsPromise = collect(codexThreadProvider(makeRequest(), makeRuntime(lease)));
      await lease.waitForRpc('turn/start');
      lease.emit(errorEvent);
      lease.emit({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed' } },
      });
      const events = await eventsPromise;
      expect(starts).toBe(1);
      expect(events.at(-1)).toMatchObject({ kind: 'terminal', terminal: { outcome: { kind: 'provider_exit' } } });
    }
  });

  it.each([['serverOverloaded', 'capacity']] as const)(
    'spends the continuation budget once when repeated %s failures occur',
    async (codexErrorInfo, message) => {
      let starts = 0;
      const lease = makeLease(async (method) => {
        if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') {
          starts += 1;
          return { turn: { id: `turn-${starts}`, status: 'inProgress' } };
        }
        throw new Error(`Unexpected method: ${method}`);
      });
      const runtime = makeRuntime(lease);
      const eventsPromise = collect(codexThreadProvider(makeRequest(), runtime));

      for (const turnId of ['turn-1', 'turn-2']) {
        await lease.waitForRpc('turn/start', Number(turnId.at(-1)));
        lease.emit({
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: {
              id: turnId,
              status: 'failed',
              error: { message, codexErrorInfo },
            },
          },
        });
      }

      const events = await eventsPromise;
      expect(starts).toBe(2);
      expect(events.filter((event) => event.kind === 'terminal')).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        kind: 'terminal',
        terminal: { outcome: { kind: 'provider_exit', note: expect.stringContaining(message) } },
      });
    },
  );

  it('fails once without overwriting a pre-discovered turn id when the RPC response conflicts', async () => {
    const startResponse = createDeferred<unknown>();
    const lease = makeLease(async (method) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') return startResponse.promise;
      throw new Error(`Unexpected method: ${method}`);
    });
    const eventsPromise = collect(codexThreadProvider(makeRequest(), makeRuntime(lease)));
    await lease.waitForRpc('turn/start');

    lease.emit({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-notification' } },
    });
    startResponse.resolve({ turn: { id: 'turn-response', status: 'inProgress' } });

    const events = await eventsPromise;
    expect(events.filter((event) => event.kind === 'terminal')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      kind: 'terminal',
      terminal: { outcome: { kind: 'provider_exit', note: expect.stringContaining('id mismatch') } },
    });
    const continuity = events.flatMap((event) => (event.kind === 'continuity' ? [event.providerContinuity] : []));
    expect(continuity.some((entry) => entry?.turnId === 'turn-notification')).toBe(true);
    expect(continuity.some((entry) => entry?.turnId === 'turn-response')).toBe(false);
  });

  it('replays a buffered completion after a same-id pre-response claim and id-less start response', async () => {
    const startResponse = createDeferred<unknown>();
    const lease = makeLease(async (method) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') return startResponse.promise;
      throw new Error(`Unexpected method: ${method}`);
    });
    const eventsPromise = collect(codexThreadProvider(makeRequest(), makeRuntime(lease)));
    await lease.waitForRpc('turn/start');
    lease.emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
    lease.emit({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
    });
    startResponse.resolve({ turn: { status: 'inProgress' } });

    const events = await eventsPromise;
    expect(events.filter((event) => event.kind === 'terminal')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: 'terminal', terminal: { outcome: { kind: 'completed' } } });
    const continuity = events.flatMap((event) => (event.kind === 'continuity' ? [event.providerContinuity] : []));
    expect(continuity.some((entry) => entry?.turnId === 'turn-1')).toBe(true);
  });

  it('does not recover an id-less terminal turn/start response', async () => {
    let starts = 0;
    const lease = makeLease(async (method) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') {
        starts += 1;
        return {
          turn: {
            status: 'failed',
            error: { message: 'capacity without id', codexErrorInfo: 'serverOverloaded' },
          },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const events = await collect(codexThreadProvider(makeRequest(), makeRuntime(lease)));
    expect(starts).toBe(1);
    expect(events.at(-1)).toMatchObject({
      kind: 'terminal',
      terminal: { outcome: { kind: 'provider_exit', note: expect.stringContaining('capacity without id') } },
    });
  });

  it('converts a continuation start rejection into the invocation final failure', async () => {
    let starts = 0;
    const lease = makeLease(async (method) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') {
        starts += 1;
        if (starts === 1) return { turn: { id: 'turn-1', status: 'inProgress' } };
        throw new Error('continuation start rejected');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const eventsPromise = collect(codexThreadProvider(makeRequest(), makeRuntime(lease)));
    await lease.waitForRpc('turn/start');
    lease.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'failed',
          error: { message: 'capacity', codexErrorInfo: 'serverOverloaded' },
        },
      },
    });

    const events = await eventsPromise;
    expect(starts).toBe(2);
    expect(events.filter((event) => event.kind === 'terminal')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      kind: 'terminal',
      terminal: { outcome: { kind: 'provider_exit', note: expect.stringContaining('continuation start rejected') } },
    });
  });

  it('suspends an abort when the app-server neither answers the interrupt nor closes', async () => {
    const controller = new AbortController();
    const wedgedInterrupt = createDeferred<unknown>();
    const lease = makeLease(async (method) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress' } };
      // The wedged host: accepts the interrupt and never answers it. The lease is
      // also never closed, so both legs of the abort race stay pending — this is
      // the state that left five jobs `running` and unabortable for an hour.
      if (method === 'turn/interrupt') return wedgedInterrupt.promise;
      throw new Error(`Unexpected method: ${method}`);
    });
    const requestedDelaysMs: number[] = [];
    const time = new VirtualTime();
    const runtime = makeRuntime(
      lease,
      { cwd: TEST_PERSISTED_CWD, threadId: 'thread-1' },
      {
        signal: controller.signal,
        time: {
          now: () => time.now(),
          setTimeout: (fn, ms) => {
            requestedDelaysMs.push(ms);
            return time.setTimeout(fn, ms);
          },
          clearTimeout: (handle) => time.clearTimeout(handle),
        },
      },
    );
    const eventsPromise = collect(codexThreadProvider(makeRequest(), runtime));
    await lease.waitForRpc('turn/start');

    controller.abort();
    await lease.waitForRpc('turn/interrupt');
    await flushMicrotasks();
    time.tick(10_000);
    const events = await eventsPromise;

    expect(requestedDelaysMs).toContain(10_000);
    expect(events.filter((event) => event.kind === 'terminal')).toHaveLength(0);
    expect(events.at(-1)).toEqual({ kind: 'suspended', reason: 'interrupt_unconfirmed' });
    // The snapshot survives so a later boot can still probe the turn.
    const continuity = events.flatMap((event) => (event.kind === 'continuity' ? [event.providerContinuity] : []));
    expect(continuity.at(-1)?.turnId).toBe('turn-1');
  });

  it('suspends without a terminal when exact-turn interruption is not confirmed', async () => {
    const controller = new AbortController();
    const lease = makeLease(async (method) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress' } };
      throw new Error(`Unexpected method: ${method}`);
    });
    lease.interrupt = vi.fn(async () => ({ kind: 'not-accepted' as const, reason: 'test refusal' }));
    const runtime = makeRuntime(
      lease,
      { cwd: TEST_PERSISTED_CWD, threadId: 'thread-1' },
      { signal: controller.signal },
    );
    const eventsPromise = collect(codexThreadProvider(makeRequest(), runtime));
    await lease.waitForRpc('turn/start');

    controller.abort();
    const events = await eventsPromise;

    expect(lease.interrupt).toHaveBeenCalledWith({ threadId: 'thread-1', turnId: 'turn-1' });
    expect(events.at(-1)).toEqual({ kind: 'suspended', reason: 'interrupt_unconfirmed' });
    expect(events.some((event) => event.kind === 'terminal')).toBe(false);
    const continuity = events.flatMap((event) => (event.kind === 'continuity' ? [event.providerContinuity] : []));
    expect(continuity.at(-1)?.turnId).toBe('turn-1');
  });

  it('settles as aborted when close follows a start response while interrupt remains pending', async () => {
    const controller = new AbortController();
    const continuationStart = createDeferred<unknown>();
    const interrupt = createDeferred<unknown>();
    let starts = 0;
    const lease = makeLease(async (method) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') {
        starts += 1;
        if (starts === 1) return { turn: { id: 'turn-1', status: 'inProgress' } };
        return continuationStart.promise;
      }
      if (method === 'turn/interrupt') return interrupt.promise;
      throw new Error(`Unexpected method: ${method}`);
    });
    const eventsPromise = collect(
      codexThreadProvider(
        makeRequest(),
        makeRuntime(lease, { cwd: TEST_PERSISTED_CWD, threadId: 'thread-1' }, { signal: controller.signal }),
      ),
    );
    await lease.waitForRpc('turn/start');
    lease.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'failed',
          error: { message: 'capacity', codexErrorInfo: 'serverOverloaded' },
        },
      },
    });
    await lease.waitForRpc('turn/start', 2);
    controller.abort();
    continuationStart.resolve({ turn: { id: 'turn-2', status: 'inProgress' } });
    await lease.waitForRpc('turn/interrupt');
    lease.close(new Error('closed after start response'));

    const events = await eventsPromise;
    expect(events.at(-1)).toMatchObject({ kind: 'terminal', terminal: { outcome: { kind: 'aborted' } } });
    const continuity = events.flatMap((event) => (event.kind === 'continuity' ? [event.providerContinuity] : []));
    expect(continuity.at(-1)?.turnId).toBe('turn-2');
  });
});
