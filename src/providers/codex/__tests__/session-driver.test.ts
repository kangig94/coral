import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRequest } from '../../../shared/types.js';
import type { ProviderRuntime, ProviderServerLease } from '../../types.js';
import { codexSessionDriver } from '../session-driver.js';
import type { Turn } from '../protocol.js';

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    action: 'exec',
    sessionId: 'job-1',
    prompt: 'Run checks',
    cwd: '/tmp/test',
    effort: 'high',
    bypassPermissions: false,
    coralEnv: {},
    ...overrides,
  };
}

function makeLease(
  rpcImpl: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): ProviderServerLease & {
  rpcMock: ReturnType<typeof vi.fn>;
} {
  const rpcMock = vi.fn((method: string, params: Record<string, unknown>) => rpcImpl(method, params));
  return {
    rpc: rpcMock as unknown as ProviderServerLease['rpc'],
    subscribe: vi.fn(() => vi.fn()),
    release: vi.fn(),
    closed: new Promise<Error | void>(() => {}),
    rpcMock,
  };
}

function makeRuntime(controller = new AbortController()): ProviderRuntime & {
  checkpointRecovery: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
} {
  return {
    signal: controller.signal,
    onEvent: vi.fn(),
    runCli: vi.fn(),
    checkpointRecovery: vi.fn(),
  } as ProviderRuntime & { checkpointRecovery: ReturnType<typeof vi.fn>; onEvent: ReturnType<typeof vi.fn> };
}

function makeContext(
  request: ProviderRequest,
  lease: ProviderServerLease,
  runtime: ProviderRuntime & { checkpointRecovery: ReturnType<typeof vi.fn>; onEvent: ReturnType<typeof vi.fn> },
) {
  return {
    lease,
    runtime,
    checkpointRecovery: runtime.checkpointRecovery,
    emitProgress(message: string) {
      runtime.onEvent({ jobId: request.sessionId, message, ts: 'now' });
    },
  };
}

async function initializeState(
  request: ProviderRequest,
  lease: ProviderServerLease,
  runtime: ProviderRuntime & { checkpointRecovery: ReturnType<typeof vi.fn>; onEvent: ReturnType<typeof vi.fn> },
) {
  const ctx = makeContext(request, lease, runtime);
  const state = codexSessionDriver.createInitialState(ctx, request);
  const initialized = await codexSessionDriver.initialize(ctx, state, request);
  return { ctx, state, initialized };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('codexSessionDriver', () => {
  it('flushes buffered pre-turn notifications after turn/start', async () => {
    const request = makeRequest();
    const lease = makeLease(async (method) => {
      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } };
      }
      if (method === 'turn/start') {
        return { turn: { id: 'turn-1', status: 'inProgress' } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const runtime = makeRuntime();
    const { ctx, state } = await initializeState(request, lease, runtime);

    codexSessionDriver.applyNotification(state, {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        item: { type: 'agentMessage', text: 'Buffered final answer', phase: 'final_answer' },
      },
    });
    codexSessionDriver.applyNotification(state, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed' },
      },
    });

    expect(state.bufferedNotifications).toHaveLength(2);

    const started = await codexSessionDriver.startTurn(ctx, state, request);
    const outcome = await codexSessionDriver.awaitTurnOutcome(state);

    expect(started.terminal).toBeUndefined();
    expect(outcome).toMatchObject({
      kind: 'completed',
      turn: { id: 'turn-1', status: 'completed' },
    });
    expect(state.lastAgentMessage).toBe('Buffered final answer');
    expect(state.bufferedNotifications).toHaveLength(0);
  });

  it('preserves thread notifications that arrive before the main turn id exists', async () => {
    const request = makeRequest();
    const lease = makeLease(async (method) => {
      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } };
      }
      if (method === 'turn/start') {
        return { turn: { id: 'turn-1', status: 'inProgress' } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const runtime = makeRuntime();
    const { ctx, state } = await initializeState(request, lease, runtime);

    codexSessionDriver.applyNotification(state, {
      method: 'thread/started',
      params: { thread: { id: 'subthread-1' } },
    });
    codexSessionDriver.applyNotification(state, {
      method: 'thread/name/updated',
      params: { threadId: 'subthread-1' },
    });

    expect(state.threadIds.has('subthread-1')).toBe(false);

    await codexSessionDriver.startTurn(ctx, state, request);

    expect(state.threadIds.has('thread-1')).toBe(true);
    expect(state.threadIds.has('subthread-1')).toBe(true);
  });

  it('checkpoints a late-discovered turnId before final result mapping', async () => {
    const request = makeRequest();
    const lease = makeLease(async (method) => {
      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } };
      }
      if (method === 'turn/start') {
        return { turn: { status: 'inProgress' } as Turn };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const runtime = makeRuntime();
    const { ctx, state } = await initializeState(request, lease, runtime);

    await codexSessionDriver.startTurn(ctx, state, request);
    codexSessionDriver.applyNotification(state, {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        item: { type: 'agentMessage', text: 'Late turn answer', phase: 'final_answer' },
      },
    });
    codexSessionDriver.applyNotification(state, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'late-turn-1', status: 'completed' },
      },
    });

    const outcome = await codexSessionDriver.awaitTurnOutcome(state);

    expect(runtime.checkpointRecovery).toHaveBeenNthCalledWith(1, {
      conversationRef: 'thread-1',
      providerMeta: {
        providerContinuity: {
          cwd: '/tmp/test',
          threadId: 'thread-1',
        },
      },
    });
    expect(runtime.checkpointRecovery).toHaveBeenNthCalledWith(2, {
      conversationRef: 'thread-1',
      providerMeta: {
        providerContinuity: {
          cwd: '/tmp/test',
          threadId: 'thread-1',
          turnId: 'late-turn-1',
        },
      },
    });

    const result = codexSessionDriver.finalize(state, outcome);

    expect(result).toMatchObject({
      content: 'Late turn answer',
      conversationRef: 'thread-1',
    });
    expect(runtime.checkpointRecovery).toHaveBeenLastCalledWith({
      conversationRef: 'thread-1',
      providerMeta: {
        providerContinuity: {
          cwd: '/tmp/test',
          threadId: 'thread-1',
        },
      },
    });
  });

  it('gates inferred completion on pending collaborations', async () => {
    vi.useFakeTimers();
    const request = makeRequest();
    const lease = makeLease(async (method) => {
      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } };
      }
      if (method === 'turn/start') {
        return { turn: { id: 'turn-1', status: 'inProgress' } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const runtime = makeRuntime();
    const { ctx, state } = await initializeState(request, lease, runtime);
    await codexSessionDriver.startTurn(ctx, state, request);

    let resolved = false;
    const outcomePromise = codexSessionDriver.awaitTurnOutcome(state).then((outcome) => {
      resolved = true;
      return outcome;
    });

    codexSessionDriver.applyNotification(state, {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        item: { type: 'collabAgentToolCall', id: 'collab-1', status: 'inProgress' },
      },
    });
    codexSessionDriver.applyNotification(state, {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        item: { type: 'agentMessage', text: 'Answer pending collaboration', phase: 'final_answer' },
      },
    });

    await vi.advanceTimersByTimeAsync(300);
    expect(resolved).toBe(false);

    codexSessionDriver.applyNotification(state, {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        item: { type: 'collabAgentToolCall', id: 'collab-1', status: 'completed' },
      },
    });

    await vi.advanceTimersByTimeAsync(300);
    await expect(outcomePromise).resolves.toMatchObject({ kind: 'completed' });
  });

  it('gates inferred completion on active subagent turns', async () => {
    vi.useFakeTimers();
    const request = makeRequest();
    const lease = makeLease(async (method) => {
      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } };
      }
      if (method === 'turn/start') {
        return { turn: { id: 'turn-1', status: 'inProgress' } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const runtime = makeRuntime();
    const { ctx, state } = await initializeState(request, lease, runtime);
    await codexSessionDriver.startTurn(ctx, state, request);

    let resolved = false;
    const outcomePromise = codexSessionDriver.awaitTurnOutcome(state).then((outcome) => {
      resolved = true;
      return outcome;
    });

    codexSessionDriver.applyNotification(state, {
      method: 'thread/started',
      params: { thread: { id: 'subthread-1' } },
    });
    codexSessionDriver.applyNotification(state, {
      method: 'turn/started',
      params: { threadId: 'subthread-1', turnId: 'subturn-1' },
    });
    codexSessionDriver.applyNotification(state, {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        item: { type: 'agentMessage', text: 'Answer pending subagent', phase: 'final_answer' },
      },
    });

    await vi.advanceTimersByTimeAsync(300);
    expect(resolved).toBe(false);

    codexSessionDriver.applyNotification(state, {
      method: 'turn/completed',
      params: {
        threadId: 'subthread-1',
        turn: { id: 'subturn-1', status: 'completed' },
      },
    });

    await vi.advanceTimersByTimeAsync(300);
    await expect(outcomePromise).resolves.toMatchObject({ kind: 'completed' });
  });

  it('fires inferred completion only after both collaboration and subagent gates are empty', async () => {
    vi.useFakeTimers();
    const request = makeRequest();
    const lease = makeLease(async (method) => {
      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } };
      }
      if (method === 'turn/start') {
        return { turn: { id: 'turn-1', status: 'inProgress' } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const runtime = makeRuntime();
    const { ctx, state } = await initializeState(request, lease, runtime);
    await codexSessionDriver.startTurn(ctx, state, request);

    let resolved = false;
    const outcomePromise = codexSessionDriver.awaitTurnOutcome(state).then((outcome) => {
      resolved = true;
      return outcome;
    });

    codexSessionDriver.applyNotification(state, {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        item: { type: 'collabAgentToolCall', id: 'collab-1', status: 'inProgress', receiverThreadIds: ['subthread-1'] },
      },
    });
    codexSessionDriver.applyNotification(state, {
      method: 'turn/started',
      params: { threadId: 'subthread-1', turnId: 'subturn-1' },
    });
    codexSessionDriver.applyNotification(state, {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        item: { type: 'agentMessage', text: 'Answer waiting on both gates', phase: 'final_answer' },
      },
    });

    await vi.advanceTimersByTimeAsync(300);
    expect(resolved).toBe(false);

    codexSessionDriver.applyNotification(state, {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        item: { type: 'collabAgentToolCall', id: 'collab-1', status: 'completed' },
      },
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(resolved).toBe(false);

    codexSessionDriver.applyNotification(state, {
      method: 'turn/completed',
      params: {
        threadId: 'subthread-1',
        turn: { id: 'subturn-1', status: 'completed' },
      },
    });
    await vi.advanceTimersByTimeAsync(300);

    await expect(outcomePromise).resolves.toMatchObject({ kind: 'completed' });
  });

  it('no-ops interrupt requests until turn identity exists and keeps them idempotent', async () => {
    const request = makeRequest();
    const lease = makeLease(async (method, params) => {
      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } };
      }
      if (method === 'turn/start') {
        return { turn: { id: 'turn-1', status: 'inProgress' } };
      }
      if (method === 'turn/interrupt') {
        return { threadId: params.threadId, turnId: params.turnId };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const runtime = makeRuntime();
    const { ctx, state } = await initializeState(request, lease, runtime);

    await codexSessionDriver.requestInterrupt(ctx, state);
    expect(lease.rpcMock.mock.calls.map(([method]) => method)).toEqual(['thread/start']);

    await codexSessionDriver.startTurn(ctx, state, request);
    await codexSessionDriver.requestInterrupt(ctx, state);
    await codexSessionDriver.requestInterrupt(ctx, state);

    expect(lease.rpcMock.mock.calls.map(([method]) => method)).toEqual([
      'thread/start',
      'turn/start',
      'turn/interrupt',
    ]);
  });
});
