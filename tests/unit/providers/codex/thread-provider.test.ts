import { describe, expect, it, vi } from 'vitest';

import type {
  ProviderEventBody,
  ProviderRequest,
  ProviderRuntime,
  ProviderServerLease,
} from '#src/providers/contract.js';
import { codexThreadProvider } from '#src/providers/codex/thread-provider.js';
import { createDeferred } from '#tools/testing/deferred.js';

type MockLease = ProviderServerLease & {
  close(outcome?: Error | void): void;
  emit(message: { method: string; params?: Record<string, unknown> }): void;
  releaseMock: ReturnType<typeof vi.fn>;
  rpcMock: ReturnType<typeof vi.fn>;
  subscribeMock: ReturnType<typeof vi.fn>;
};

function makeLease(rpcImpl: (method: string, params: Record<string, unknown>) => Promise<unknown>): MockLease {
  let handler: ((message: { method: string; params?: Record<string, unknown> }) => void) | null = null;
  const closed = createDeferred<Error | void>();
  const releaseMock = vi.fn();
  const rpcMock = vi.fn((method: string, params: Record<string, unknown>) => rpcImpl(method, params));
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
    cwd: '/workspace/request',
    bypassPermissions: false,
    coralEnv: {},
    ...overrides,
  };
}

function makeRuntime(
  lease: ProviderServerLease,
  persistedContinuity: ProviderRuntime['persistedContinuity'] = {
    cwd: '/workspace/persisted',
    threadId: 'thread-1',
  },
): ProviderRuntime & { acquireServer: ReturnType<typeof vi.fn> } {
  return {
    signal: new AbortController().signal,
    time: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => {
        if (handle !== null) clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
    },
    ids: { uuid: () => 'test-uuid', sha256: () => 'sha256:fake' },
    storage: { existsSync: () => true } as unknown as ProviderRuntime['storage'],
    runCli: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, aborted: false })),
    acquireServer: vi.fn(async () => lease),
    persistedContinuity,
    continuityBridge: {
      checkpoint: () => {},
      transportClosed: () => {},
    },
    kbRoot: '/mock/kb',
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
      expect(runtime.acquireServer).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'codex',
          cwd: '/workspace/persisted',
        }),
      );
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

    expect(events).toHaveLength(5);
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
    expect(events[4]).toMatchObject({
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
});
