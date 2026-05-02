import { describe, expect, it, vi } from 'vitest';

import type {
  Provider,
  ProviderEventBody,
  ProviderRequest,
  ProviderRuntime,
  ProviderServerLease,
} from '#src/providers/contract.js';
import {
  type AppServerContract,
  bindAppServerNotificationHandler,
  requireAppServerLease,
} from '#src/providers/app-server.js';
import { buildJobDiagnostics, buildJobTerminal } from '#src/providers/terminal.js';
import { appServerSession } from '#src/providers/middleware/app-server-session.js';
import { createDeferred } from '#tools/testing/deferred.js';

const BASE_REQUEST: ProviderRequest = {
  action: 'exec',
  sessionId: 'job-app-server-session',
  prompt: 'run',
  cwd: process.cwd(),
  bypassPermissions: false,
  coralEnv: {},
};

type MockLease = ProviderServerLease & {
  close(outcome?: Error | void): void;
  emit(message: { method: string; params?: Record<string, unknown> }): void;
  releaseMock: ReturnType<typeof vi.fn>;
  subscribeMock: ReturnType<typeof vi.fn>;
};

type MockBridge = {
  checkpoint: ReturnType<typeof vi.fn>;
  transportClosed: ReturnType<typeof vi.fn>;
};

function makeLease(options: { onSubscribe?: () => void; unsubscribeThrows?: boolean } = {}): MockLease {
  let handler: ((message: { method: string; params?: Record<string, unknown> }) => void) | null = null;
  const closed = createDeferred<Error | void>();
  const subscribeMock = vi.fn((next: (message: { method: string; params?: Record<string, unknown> }) => void) => {
    options.onSubscribe?.();
    handler = next;
    return () => {
      handler = null;
      if (options.unsubscribeThrows) {
        throw new Error('unsubscribe failed');
      }
    };
  });
  const releaseMock = vi.fn();

  return {
    rpc: vi.fn(),
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
    subscribeMock,
  };
}

function makeBridge(): MockBridge {
  return {
    checkpoint: vi.fn(),
    transportClosed: vi.fn(),
  };
}

function makeRuntime(
  lease: ProviderServerLease,
  controller = new AbortController(),
  bridge = makeBridge(),
): ProviderRuntime & {
  acquireServer: ReturnType<typeof vi.fn>;
  continuityBridge: MockBridge;
} {
  return {
    signal: controller.signal,
    runCli: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, aborted: false })),
    time: {
      now: () => 0,
      setTimeout: () => ({ unref: () => {} }),
      clearTimeout: () => {},
    } as ProviderRuntime['time'],
    ids: { uuid: () => 'test-uuid', sha256: () => 'sha256:fake' },
    storage: { existsSync: () => true } as unknown as ProviderRuntime['storage'],
    acquireServer: vi.fn(async () => lease),
    persistedContinuity: undefined,
    continuityBridge: bridge as ProviderRuntime['continuityBridge'] & MockBridge,
    kbRoot: '/mock/kb',
  };
}

function makeContract(overrides: Partial<AppServerContract> = {}): AppServerContract {
  return {
    name: 'app-server-test',
    buildServerSpec: vi.fn(() => ({
      provider: 'app-server-test',
      command: 'echo',
      args: [],
      cwd: '/workspace',
    })),
    interrupt: vi.fn(async () => {}),
    subscriptionPhase: 'beforeInitialize',
    ...overrides,
  };
}

function terminalEvent(
  outcome: Extract<ReturnType<typeof buildJobTerminal>['outcome'], { kind: 'completed' | 'aborted' | 'failed' }>,
  content = '',
  failureCause?: Extract<ProviderEventBody, { kind: 'terminal' }>['failureCause'],
): Extract<ProviderEventBody, { kind: 'terminal' }> {
  return {
    kind: 'terminal',
    terminal: buildJobTerminal({ content, outcome }),
    diagnostics: buildJobDiagnostics({}),
    ...(failureCause === undefined ? {} : { failureCause }),
  };
}

async function collect(stream: AsyncIterable<ProviderEventBody>): Promise<ProviderEventBody[]> {
  const events: ProviderEventBody[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe('appServerSession', () => {
  it('subscribes before the leaf starts when the contract requires beforeInitialize', async () => {
    const order: string[] = [];
    const lease = makeLease({ onSubscribe: () => order.push('subscribe') });
    const runtime = makeRuntime(lease);
    const contract = makeContract({ subscriptionPhase: 'beforeInitialize' });
    const terminal = terminalEvent({ kind: 'completed' }, 'before-initialize');
    const provider: Provider = async function* leaf(_request, nextRuntime) {
      order.push('kernel:start');
      expect(requireAppServerLease(nextRuntime, contract.name)).toBe(lease);
      yield terminal;
    };

    const events = await collect(appServerSession(contract)(provider)(BASE_REQUEST, runtime));

    expect(order).toEqual(['subscribe', 'kernel:start']);
    expect(events).toEqual([terminal]);
    expect(lease.subscribeMock).toHaveBeenCalledTimes(1);
    expect(lease.releaseMock).toHaveBeenCalledTimes(1);
    expect(contract.buildServerSpec).toHaveBeenCalledWith(
      BASE_REQUEST,
      undefined,
      expect.objectContaining({
        storage: expect.anything(),
      }),
    );
  });

  it('delivers notifications through the bound runtime handler with a single lease subscription', async () => {
    const lease = makeLease();
    const runtime = makeRuntime(lease);
    const dynamicHandler = vi.fn();
    const staticHandler = vi.fn();
    const contract = makeContract({ onNotification: staticHandler, subscriptionPhase: 'afterInitialize' });
    const started = createDeferred<void>();
    const nextTerminal = createDeferred<Extract<ProviderEventBody, { kind: 'terminal' }>>();
    const terminal = terminalEvent({ kind: 'completed' }, 'bound-handler');
    const provider: Provider = async function* leaf(_request, nextRuntime) {
      const clearNotificationBinding = bindAppServerNotificationHandler(nextRuntime, dynamicHandler);
      expect(requireAppServerLease(nextRuntime, contract.name)).toBe(lease);
      started.resolve();

      try {
        yield await nextTerminal.promise;
      } finally {
        clearNotificationBinding();
      }
    };

    const eventsPromise = collect(appServerSession(contract)(provider)(BASE_REQUEST, runtime));

    await started.promise;
    lease.emit({ method: 'session/updated', params: { ok: true } });
    await vi.waitFor(() => {
      expect(dynamicHandler).toHaveBeenCalledWith({ method: 'session/updated', params: { ok: true } });
      expect(staticHandler).toHaveBeenCalledWith({ method: 'session/updated', params: { ok: true } });
    });
    nextTerminal.resolve(terminal);

    const events = await eventsPromise;

    expect(events).toEqual([terminal]);
    expect(lease.subscribeMock).toHaveBeenCalledTimes(1);
    expect(lease.releaseMock).toHaveBeenCalledTimes(1);
  });

  it('routes aborts to interrupt and preserves the leaf-authored aborted terminal', async () => {
    const controller = new AbortController();
    const lease = makeLease();
    const runtime = makeRuntime(lease, controller);
    const interrupt = vi.fn(async () => {});
    const contract = makeContract({ interrupt });
    const started = createDeferred<void>();
    const nextTerminal = createDeferred<Extract<ProviderEventBody, { kind: 'terminal' }>>();
    const terminal = terminalEvent({ kind: 'aborted', reason: 'signal_abort' });
    const provider: Provider = async function* leaf(_request, nextRuntime) {
      expect(requireAppServerLease(nextRuntime, contract.name)).toBe(lease);
      started.resolve();
      yield await nextTerminal.promise;
    };

    const eventsPromise = collect(appServerSession(contract)(provider)(BASE_REQUEST, runtime));

    await started.promise;
    controller.abort();
    await vi.waitFor(() => {
      expect(interrupt).toHaveBeenCalledWith(lease);
    });
    nextTerminal.resolve(terminal);

    const events = await eventsPromise;

    expect(events).toEqual([terminal]);
    expect(events[0]).toBe(terminal);
    expect(events[0]).toMatchObject({
      kind: 'terminal',
      terminal: {
        outcome: {
          kind: 'aborted',
          reason: 'signal_abort',
        },
      },
    });
    expect(runtime.continuityBridge.transportClosed).not.toHaveBeenCalled();
    expect(lease.releaseMock).toHaveBeenCalledTimes(1);
  });

  it('publishes typed transport-close state through the continuity bridge and preserves the leaf terminal', async () => {
    const lease = makeLease();
    const bridge = makeBridge();
    const runtime = makeRuntime(lease, new AbortController(), bridge);
    const contract = makeContract();
    const started = createDeferred<void>();
    const nextTerminal = createDeferred<Extract<ProviderEventBody, { kind: 'terminal' }>>();
    const terminal = terminalEvent({ kind: 'failed' }, '', {
      type: 'session.provider_failed',
      body: {
        provider: 'app-server-test',
        reason: 'request_failed',
        message: 'leaf-authored close handling',
      },
    });
    const provider: Provider = async function* leaf(_request, nextRuntime) {
      expect(requireAppServerLease(nextRuntime, contract.name)).toBe(lease);
      started.resolve();
      yield await nextTerminal.promise;
    };

    const eventsPromise = collect(appServerSession(contract)(provider)(BASE_REQUEST, runtime));

    await started.promise;
    const closedError = new Error('transport down');
    lease.close(closedError);
    await vi.waitFor(() => {
      expect(bridge.transportClosed).toHaveBeenCalledWith({
        kind: 'transport_closed',
        error: closedError,
      });
    });
    nextTerminal.resolve(terminal);

    const events = await eventsPromise;

    expect(events).toEqual([terminal]);
    expect(events[0]).toBe(terminal);
    expect(events.find((event) => event.kind === 'continuity')).toBeUndefined();
    expect(bridge.checkpoint).not.toHaveBeenCalled();
    expect(lease.releaseMock).toHaveBeenCalledTimes(1);
  });
});
