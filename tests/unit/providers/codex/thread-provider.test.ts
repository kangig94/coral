import { describe, expect, it, vi } from 'vitest';

import type {
  ProviderEventBody,
  ProviderRequest,
  ProviderRuntime,
  ProviderServerLease,
} from '#src/providers/contract.js';
import { codexThreadProvider } from '#src/providers/codex/thread-provider.js';
import { buildCodexExecutionPlan, type CodexExecutionPlan } from '#src/providers/codex/execution-plan.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { TEST_CODEX_SOURCE } from '../../../helpers/provider-credentials.js';

type MockLease = ProviderServerLease & {
  close(outcome?: Error | void): void;
  emit(message: { method: string; params?: Record<string, unknown> }): void;
  releaseMock: ReturnType<typeof vi.fn>;
  rpcMock: ReturnType<typeof vi.fn>;
  subscribeMock: ReturnType<typeof vi.fn>;
};

function makeLease(
  rpcImpl: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  effectiveConfig: Record<string, unknown> = {},
): MockLease {
  let handler: ((message: { method: string; params?: Record<string, unknown> }) => void) | null = null;
  const closed = createDeferred<Error | void>();
  const releaseMock = vi.fn();
  const rpcMock = vi.fn((method: string, params: Record<string, unknown>) =>
    method === 'config/read' ? Promise.resolve({ config: effectiveConfig }) : rpcImpl(method, params),
  );
  const subscribeMock = vi.fn((next: (message: { method: string; params?: Record<string, unknown> }) => void) => {
    handler = next;
    return () => {
      handler = null;
    };
  });

  return {
    rpc: rpcMock as unknown as ProviderServerLease['rpc'],
    subscribe: subscribeMock as unknown as ProviderServerLease['subscribe'],
    release: releaseMock,
    closed: closed.promise,
    close(outcome) {
      closed.resolve(outcome);
    },
    emit(message) {
      handler?.(message);
    },
    releaseMock,
    rpcMock,
    subscribeMock,
  };
}

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    action: 'resume',
    sessionId: 'job-codex-thread-provider',
    name: 'codex',
    conversationRef: 'thread-1',
    prompt: 'Resume and continue',
    cwd: '/workspace',
    bypassPermissions: false,
    coralEnv: {},
    ...overrides,
  };
}

type CodexRuntime = ProviderRuntime<CodexExecutionPlan>;

function makeRuntime(
  lease: ProviderServerLease,
  persistedContinuity: CodexRuntime['persistedContinuity'] = {
    cwd: '/workspace/persisted',
    threadId: 'thread-1',
  },
  overrides: Partial<Pick<CodexRuntime, 'signal' | 'storage' | 'env' | 'continuityBridge'>> = {},
): CodexRuntime & { acquirePreparedServer: ReturnType<typeof vi.fn> } {
  const prepared = buildCodexExecutionPlan({
    source: TEST_CODEX_SOURCE,
    request: makeRequest(),
    ...(persistedContinuity === undefined ? {} : { persistedContinuity }),
    baseEnv: {},
    platform: 'linux',
  });
  return {
    signal: overrides.signal ?? new AbortController().signal,
    time: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => {
        if (handle !== null) clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
    },
    ids: { uuid: () => 'test-uuid', sha256: () => 'sha256:fake' },
    storage: overrides.storage ?? ({ existsSync: () => true } as unknown as CodexRuntime['storage']),
    ...(overrides.env ? { env: overrides.env } : {}),
    runCli: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, aborted: false })),
    acquirePreparedServer: vi.fn(async () => lease),
    persistedContinuity,
    continuityBridge:
      overrides.continuityBridge ??
      ({
        checkpoint: () => {},
        transportClosed: () => {},
      } satisfies CodexRuntime['continuityBridge']),
    kbRoot: '/mock/kb',
    executionPlan: prepared.plan,
  };
}

async function collect(stream: AsyncIterable<ProviderEventBody>): Promise<ProviderEventBody[]> {
  const events: ProviderEventBody[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe('codexThreadProvider', () => {
  it.each([
    ['start', { action: 'exec' as const, conversationRef: undefined }, {}],
    ['resume', { action: 'resume' as const, conversationRef: 'thread-1' }, { cwd: '/workspace', threadId: 'thread-1' }],
  ])('rejects hostile effective config before %s RPCs and releases the lease', async (_mode, request, continuity) => {
    const downstreamRpc = vi.fn(async (method: string) => {
      throw new Error(`must not call ${method}`);
    });
    const lease = makeLease(downstreamRpc, { model_provider: 'hostile-proxy' });
    const runtime = makeRuntime(lease, continuity);

    const events = await collect(codexThreadProvider(makeRequest(request), runtime));

    expect(lease.rpcMock).toHaveBeenCalledWith('config/read', { cwd: '/workspace', includeLayers: false });
    expect(downstreamRpc).not.toHaveBeenCalled();
    expect(lease.rpcMock.mock.calls.map(([method]) => method)).not.toEqual(
      expect.arrayContaining(['thread/start', 'thread/resume', 'turn/start']),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'terminal',
      terminal: {
        outcome: {
          kind: 'provider_exit',
          code: 1,
          note: expect.stringContaining("Unsupported Codex effective setting 'model_provider'"),
        },
      },
    });
    expect(lease.releaseMock).toHaveBeenCalledTimes(1);
  });

  it('runs the composed stack end-to-end and emits live continuity deltas before the terminal', async () => {
    const lease = makeLease(async (method) => {
      if (method === 'thread/resume') {
        return { thread: { id: 'thread-1' } };
      }
      if (method === 'turn/start') {
        return { turn: { id: 'turn-1', status: 'inProgress' } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const runtime = makeRuntime(lease);

    const eventsPromise = collect(codexThreadProvider(makeRequest(), runtime));

    await vi.waitFor(() => {
      expect(runtime.acquirePreparedServer).toHaveBeenCalledWith();
    });
    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith(
        'turn/start',
        expect.objectContaining({
          threadId: 'thread-1',
        }),
      );
    });

    lease.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'agentMessage',
          text: 'Final answer',
          phase: 'final_answer',
        },
      },
    });
    lease.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'completed',
        },
      },
    });

    const events = await eventsPromise;

    expect(events).toHaveLength(6);
    expect(events[0]).toEqual({
      kind: 'continuity',
      conversationRef: 'thread-1',
      resumable: true,
      providerContinuity: {
        cwd: '/workspace/persisted',
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    });
    expect(events[1]).toEqual({
      kind: 'progress',
      message: 'Thread ready (thread-1).',
    });
    expect(events[2]).toEqual({
      kind: 'continuity',
      conversationRef: 'thread-1',
      resumable: true,
      providerContinuity: {
        cwd: '/workspace/persisted',
        threadId: 'thread-1',
        turnId: undefined,
      },
    });
    expect(events[3]).toEqual({
      kind: 'progress',
      message: 'Turn completed.',
    });
    expect(events[4]).toEqual({
      kind: 'progress',
      message: expect.stringContaining('No rollout JSONL found matching thread thread-1'),
    });
    expect(events[5]).toMatchObject({
      kind: 'terminal',
      terminal: {
        content: 'Final answer',
        outcome: { kind: 'completed' },
      },
      diagnostics: {},
    });
    expect(lease.subscribeMock).toHaveBeenCalledTimes(1);
    expect(lease.releaseMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty thread id returned by the app-server before checkpointing', async () => {
    const lease = makeLease(async (method) => {
      if (method === 'thread/resume') {
        return { thread: { id: '' } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const runtime = makeRuntime(lease);

    const events = await collect(codexThreadProvider(makeRequest(), runtime));

    expect(lease.rpcMock).toHaveBeenCalledWith('thread/resume', expect.any(Object));
    expect(lease.rpcMock).not.toHaveBeenCalledWith('turn/start', expect.any(Object));
    expect(events.flatMap((event) => (event.kind === 'progress' ? [event.message] : []))).not.toContain(
      'Thread ready ().',
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'terminal',
      terminal: {
        outcome: {
          kind: 'provider_exit',
          code: 1,
          note: expect.stringContaining('non-empty thread id'),
        },
      },
      diagnostics: {},
    });
    expect(lease.releaseMock).toHaveBeenCalledTimes(1);
  });

  it('does not checkpoint an empty turn id returned by turn/start', async () => {
    const lease = makeLease(async (method) => {
      if (method === 'thread/resume') {
        return { thread: { id: 'thread-1' } };
      }
      if (method === 'turn/start') {
        return { turn: { id: '', status: 'inProgress' } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const runtime = makeRuntime(lease);

    const eventsPromise = collect(codexThreadProvider(makeRequest(), runtime));

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
    });

    lease.emit({
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
        },
      },
    });
    lease.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'agentMessage',
          text: 'Final answer',
          phase: 'final_answer',
        },
      },
    });
    lease.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'completed',
        },
      },
    });

    const events = await eventsPromise;
    const continuityEvents = events.filter((event): event is Extract<ProviderEventBody, { kind: 'continuity' }> => {
      return event.kind === 'continuity';
    });
    const terminal = events.find((event): event is Extract<ProviderEventBody, { kind: 'terminal' }> => {
      return event.kind === 'terminal';
    });

    expect(continuityEvents.map((event) => event.providerContinuity?.turnId)).not.toContain('');
    expect(continuityEvents).toContainEqual({
      kind: 'continuity',
      conversationRef: 'thread-1',
      resumable: true,
      providerContinuity: {
        cwd: '/workspace/persisted',
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    });
    expect(terminal?.terminal.outcome).toEqual({ kind: 'completed' });
    expect(lease.releaseMock).toHaveBeenCalledTimes(1);
  });

  it('emits the final transport-close continuity snapshot from the outer middleware before the terminal', async () => {
    const lease = makeLease(async (method) => {
      if (method === 'thread/resume') {
        return { thread: { id: 'thread-1' } };
      }
      if (method === 'turn/start') {
        return { turn: { id: 'turn-1', status: 'inProgress' } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const runtime = makeRuntime(lease);

    const eventsPromise = collect(codexThreadProvider(makeRequest(), runtime));

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith(
        'turn/start',
        expect.objectContaining({
          threadId: 'thread-1',
        }),
      );
    });

    lease.close(new Error('transport down'));

    const events = await eventsPromise;

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      kind: 'continuity',
      conversationRef: 'thread-1',
      resumable: true,
      providerContinuity: {
        cwd: '/workspace/persisted',
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    });
    expect(events[1]).toEqual({
      kind: 'progress',
      message: 'Thread ready (thread-1).',
    });
    expect(events[2]).toMatchObject({
      kind: 'terminal',
      terminal: {
        outcome: {
          kind: 'provider_exit',
          code: 1,
          note: expect.stringContaining('transport down'),
        },
      },
      diagnostics: {},
    });
    expect(events[2]).not.toHaveProperty('failureCause');
    expect(lease.releaseMock).toHaveBeenCalledTimes(1);
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

    await vi.waitFor(() => expect(starts).toBe(1));
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

    await vi.waitFor(() => expect(starts).toBe(2));
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
    expect(lease.releaseMock).toHaveBeenCalledTimes(1);
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

    await vi.waitFor(() => expect(starts).toBe(1));
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

    await vi.waitFor(() => expect(starts).toBe(2));
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

  it('uses exact terminal error evidence only when the completed turn omits Turn.error', async () => {
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
    await vi.waitFor(() => expect(starts).toBe(1));

    lease.emit({
      method: 'error',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        willRetry: false,
        error: { message: 'capacity fallback', codexErrorInfo: 'serverOverloaded' },
      },
    });
    lease.emit({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed' } },
    });

    await vi.waitFor(() => expect(starts).toBe(2));
    lease.emit({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed' } },
    });

    const events = await eventsPromise;
    expect(events.filter((event) => event.kind === 'terminal')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: 'terminal', terminal: { outcome: { kind: 'completed' } } });
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
    await vi.waitFor(() => expect(starts).toBe(1));
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
    await vi.waitFor(() => expect(starts).toBe(2));
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
      await vi.waitFor(() => expect(starts).toBe(1));
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

  it.each([
    ['serverOverloaded', 'capacity'],
    ['cyberPolicy', 'policy false positive'],
  ] as const)(
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
        await vi.waitFor(() => expect(starts).toBe(Number(turnId.at(-1))));
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

  it('grants one continuation to each recoverable error kind in the same thread', async () => {
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
    const failures = [
      { codexErrorInfo: 'serverOverloaded', message: 'capacity' },
      { codexErrorInfo: 'cyberPolicy', message: 'policy false positive' },
      { codexErrorInfo: 'serverOverloaded', message: 'capacity again' },
    ] as const;

    for (const [index, failure] of failures.entries()) {
      const turnNumber = index + 1;
      await vi.waitFor(() => expect(starts).toBe(turnNumber));
      lease.emit({
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: `turn-${turnNumber}`, status: 'failed', error: failure },
        },
      });
    }

    const events = await eventsPromise;
    expect(starts).toBe(3);
    expect(events.filter((event) => event.kind === 'terminal')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      kind: 'terminal',
      terminal: { outcome: { kind: 'provider_exit', note: expect.stringContaining('capacity again') } },
    });
    const progress = events.flatMap((event) => (event.kind === 'progress' ? [event.message] : []));
    expect(progress.filter((message) => message.includes('retrying the same thread (1/1)'))).toEqual([
      'Codex capacity reached; retrying the same thread (1/1).',
      'Codex policy check stopped the turn; retrying the same thread (1/1).',
    ]);
  });

  it('does not continue non-capacity failures', async () => {
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
    await vi.waitFor(() => expect(starts).toBe(1));
    lease.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'failed', error: { message: 'bad input', codexErrorInfo: 'badRequest' } },
      },
    });

    const events = await eventsPromise;
    expect(starts).toBe(1);
    expect(events.at(-1)).toMatchObject({
      kind: 'terminal',
      terminal: { outcome: { kind: 'provider_exit', note: expect.stringContaining('bad input') } },
    });
  });

  it('waits for explicit completion after willRetry true and follows the completed error', async () => {
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
    await vi.waitFor(() => expect(starts).toBe(1));
    lease.emit({
      method: 'error',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        willRetry: true,
        error: { message: 'reconnecting', codexErrorInfo: 'serverOverloaded' },
      },
    });
    lease.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', text: 'not final yet', phase: 'final_answer' },
      },
    });

    const settledEarly = await Promise.race([
      eventsPromise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 300)),
    ]);
    expect(settledEarly).toBe(false);
    expect(starts).toBe(1);

    lease.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'failed', error: { message: 'bad input', codexErrorInfo: 'badRequest' } },
      },
    });
    const events = await eventsPromise;
    expect(starts).toBe(1);
    expect(events.at(-1)).toMatchObject({
      kind: 'terminal',
      terminal: { outcome: { kind: 'provider_exit', note: expect.stringContaining('bad input') } },
    });
  });

  it('waits for explicit completion after malformed structured error evidence', async () => {
    const lease = makeLease(async (method) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress' } };
      throw new Error(`Unexpected method: ${method}`);
    });
    const eventsPromise = collect(codexThreadProvider(makeRequest(), makeRuntime(lease)));
    await vi.waitFor(() => expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object)));
    lease.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', text: 'premature answer', phase: 'final_answer' },
      },
    });
    lease.emit({
      method: 'error',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        willRetry: false,
        error: { message: 'malformed', codexErrorInfo: { httpConnectionFailed: {} } },
      },
    });
    const settledEarly = await Promise.race([
      eventsPromise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 300)),
    ]);
    expect(settledEarly).toBe(false);

    lease.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'failed', error: { message: 'bad input', codexErrorInfo: 'badRequest' } },
      },
    });
    const events = await eventsPromise;
    expect(events.at(-1)).toMatchObject({
      kind: 'terminal',
      terminal: { outcome: { kind: 'provider_exit', note: expect.stringContaining('bad input') } },
    });
  });

  it('fails once without overwriting a pre-discovered turn id when the RPC response conflicts', async () => {
    const startResponse = createDeferred<unknown>();
    const lease = makeLease(async (method) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') return startResponse.promise;
      throw new Error(`Unexpected method: ${method}`);
    });
    const eventsPromise = collect(codexThreadProvider(makeRequest(), makeRuntime(lease)));
    await vi.waitFor(() => expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object)));

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

  it('fails when a turn/started notification conflicts after the RPC response claimed the id', async () => {
    const lease = makeLease(async (method) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') return { turn: { id: 'turn-response', status: 'inProgress' } };
      throw new Error(`Unexpected method: ${method}`);
    });
    const eventsPromise = collect(codexThreadProvider(makeRequest(), makeRuntime(lease)));
    await vi.waitFor(() => expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object)));
    lease.emit({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-notification' } },
    });

    const events = await eventsPromise;
    expect(events.at(-1)).toMatchObject({
      kind: 'terminal',
      terminal: { outcome: { kind: 'provider_exit', note: expect.stringContaining('id mismatch') } },
    });
  });

  it('preserves the first id-mismatch failure when the pending start RPC later rejects', async () => {
    const startResponse = createDeferred<unknown>();
    const lease = makeLease(async (method) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') return startResponse.promise;
      throw new Error(`Unexpected method: ${method}`);
    });
    const eventsPromise = collect(codexThreadProvider(makeRequest(), makeRuntime(lease)));
    await vi.waitFor(() => expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object)));
    lease.emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-first' } } });
    lease.emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-conflict' } } });
    startResponse.reject(new Error('late start rejection'));

    const events = await eventsPromise;
    expect(events.at(-1)).toMatchObject({
      kind: 'terminal',
      terminal: { outcome: { kind: 'provider_exit', note: expect.stringContaining('id mismatch') } },
    });
    expect(JSON.stringify(events.at(-1))).not.toContain('late start rejection');
  });

  it('replays a buffered completion after a same-id pre-response claim and id-less start response', async () => {
    const startResponse = createDeferred<unknown>();
    const lease = makeLease(async (method) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') return startResponse.promise;
      throw new Error(`Unexpected method: ${method}`);
    });
    const eventsPromise = collect(codexThreadProvider(makeRequest(), makeRuntime(lease)));
    await vi.waitFor(() => expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object)));
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

  it.each(['inProgress', 'failed'] as const)(
    'fails when the continuation start response reuses a retired id (%s)',
    async (status) => {
      let starts = 0;
      const lease = makeLease(async (method) => {
        if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') {
          starts += 1;
          if (starts === 1) return { turn: { id: 'turn-1', status: 'inProgress' } };
          return {
            turn: {
              id: 'turn-1',
              status,
              ...(status === 'failed'
                ? { error: { message: 'capacity again', codexErrorInfo: 'serverOverloaded' } }
                : {}),
            },
          };
        }
        throw new Error(`Unexpected method: ${method}`);
      });
      const eventsPromise = collect(codexThreadProvider(makeRequest(), makeRuntime(lease)));
      await vi.waitFor(() => expect(starts).toBe(1));
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
      expect(events.at(-1)).toMatchObject({
        kind: 'terminal',
        terminal: { outcome: { kind: 'provider_exit', note: expect.stringContaining('reused retired turn id') } },
      });
    },
  );

  it('does not run artifact discovery for a terminal turn/start response', async () => {
    const existsSync = vi.fn(() => false);
    const lease = makeLease(async (method) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'completed' } };
      throw new Error(`Unexpected method: ${method}`);
    });
    const runtime = makeRuntime(
      lease,
      { cwd: '/workspace/persisted', threadId: 'thread-1' },
      {
        env: {
          homedir: () => '/home/test',
          fullSnapshot: () => ({}),
          get: () => undefined,
        },
        storage: {
          existsSync,
          readdirSync: (() => []) as CodexRuntime['storage']['readdirSync'],
          readFileSync: (() => '') as CodexRuntime['storage']['readFileSync'],
          statSync: (() => ({
            size: 0,
            mtimeMs: 0,
            isDirectory: () => false,
            isFile: () => false,
          })) as unknown as CodexRuntime['storage']['statSync'],
        },
      },
    );

    const events = await collect(codexThreadProvider(makeRequest(), runtime));
    expect(events.at(-1)).toMatchObject({ kind: 'terminal', terminal: { outcome: { kind: 'completed' } } });
    expect(existsSync).not.toHaveBeenCalled();
    expect(events.filter((event) => event.kind === 'artifact_handle')).toEqual([]);
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
    await vi.waitFor(() => expect(starts).toBe(1));
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

  it('interrupts a continuation discovered after abort while turn/start is pending', async () => {
    const controller = new AbortController();
    const continuationStart = createDeferred<unknown>();
    let starts = 0;
    const lease = makeLease(async (method) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') {
        starts += 1;
        if (starts === 1) return { turn: { id: 'turn-1', status: 'inProgress' } };
        return continuationStart.promise;
      }
      if (method === 'turn/interrupt') return { threadId: 'thread-1', turnId: 'turn-2' };
      throw new Error(`Unexpected method: ${method}`);
    });
    const runtime = makeRuntime(
      lease,
      { cwd: '/workspace/persisted', threadId: 'thread-1' },
      { signal: controller.signal },
    );
    const eventsPromise = collect(codexThreadProvider(makeRequest(), runtime));
    await vi.waitFor(() => expect(starts).toBe(1));
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
    await vi.waitFor(() => expect(starts).toBe(2));

    controller.abort();
    const settledBeforeId = await Promise.race([
      eventsPromise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);
    expect(settledBeforeId).toBe(false);

    lease.emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-2' } } });
    await vi.waitFor(() =>
      expect(lease.rpcMock).toHaveBeenCalledWith('turn/interrupt', { threadId: 'thread-1', turnId: 'turn-2' }),
    );
    const events = await eventsPromise;
    expect(lease.rpcMock.mock.calls.filter(([method]) => method === 'turn/interrupt')).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'terminal')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: 'terminal', terminal: { outcome: { kind: 'aborted' } } });
  });

  it('settles a pending continuation start when the transport closes', async () => {
    const continuationStart = createDeferred<unknown>();
    let starts = 0;
    const lease = makeLease(async (method) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') {
        starts += 1;
        if (starts === 1) return { turn: { id: 'turn-1', status: 'inProgress' } };
        return continuationStart.promise;
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const eventsPromise = collect(codexThreadProvider(makeRequest(), makeRuntime(lease)));
    await vi.waitFor(() => expect(starts).toBe(1));
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
    await vi.waitFor(() => expect(starts).toBe(2));
    lease.close(new Error('closed during continuation start'));

    const events = await eventsPromise;
    expect(events.filter((event) => event.kind === 'terminal')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      kind: 'terminal',
      terminal: { outcome: { kind: 'provider_exit', note: expect.stringContaining('closed during continuation') } },
    });
    expect(lease.releaseMock).toHaveBeenCalledTimes(1);
  });

  it('keeps abort ownership when transport closes while interrupt is pending', async () => {
    const controller = new AbortController();
    const interrupt = createDeferred<unknown>();
    const lease = makeLease(async (method) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress' } };
      if (method === 'turn/interrupt') return interrupt.promise;
      throw new Error(`Unexpected method: ${method}`);
    });
    const runtime = makeRuntime(
      lease,
      { cwd: '/workspace/persisted', threadId: 'thread-1' },
      { signal: controller.signal },
    );
    const eventsPromise = collect(codexThreadProvider(makeRequest(), runtime));
    await vi.waitFor(() => expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object)));
    controller.abort();
    await vi.waitFor(() =>
      expect(lease.rpcMock).toHaveBeenCalledWith('turn/interrupt', { threadId: 'thread-1', turnId: 'turn-1' }),
    );
    lease.close(new Error('transport closed during interrupt'));

    const events = await eventsPromise;
    expect(events.filter((event) => event.kind === 'terminal')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: 'terminal', terminal: { outcome: { kind: 'aborted' } } });
    const continuity = events.flatMap((event) => (event.kind === 'continuity' ? [event.providerContinuity] : []));
    expect(continuity.at(-1)?.turnId).toBe('turn-1');
    expect(lease.releaseMock).toHaveBeenCalledTimes(1);
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
        makeRuntime(lease, { cwd: '/workspace/persisted', threadId: 'thread-1' }, { signal: controller.signal }),
      ),
    );
    await vi.waitFor(() => expect(starts).toBe(1));
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
    await vi.waitFor(() => expect(starts).toBe(2));
    controller.abort();
    continuationStart.resolve({ turn: { id: 'turn-2', status: 'inProgress' } });
    await vi.waitFor(() =>
      expect(lease.rpcMock).toHaveBeenCalledWith('turn/interrupt', { threadId: 'thread-1', turnId: 'turn-2' }),
    );
    lease.close(new Error('closed after start response'));

    const events = await eventsPromise;
    expect(events.at(-1)).toMatchObject({ kind: 'terminal', terminal: { outcome: { kind: 'aborted' } } });
    const continuity = events.flatMap((event) => (event.kind === 'continuity' ? [event.providerContinuity] : []));
    expect(continuity.at(-1)?.turnId).toBe('turn-2');
    expect(lease.releaseMock).toHaveBeenCalledTimes(1);
  });
});
