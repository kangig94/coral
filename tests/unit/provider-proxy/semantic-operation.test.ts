import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `rebuildBoundProvider` builds a fresh registry per call via `createBuiltInProviderRegistry` and calls its
// real `rehydrateBinding`, which needs a real, persisted Claude/Codex account binding to succeed. Mocking the
// registry factory is the seam the module already exposes for this: it lets every test hand back a
// `BoundProvider` test double it fully controls (including a hand-rolled kernel) without touching the real
// provider catalog or filesystem-backed credential resolution.
const providerRegistryDouble = vi.hoisted(() => ({
  rehydrateBinding: vi.fn(),
}));
vi.mock('#src/providers/bootstrap.js', () => ({
  createBuiltInProviderRegistry: () => ({
    connectAppServerHost: () => {},
    rehydrateBinding: (binding: unknown) => providerRegistryDouble.rehydrateBinding(binding),
  }),
}));

// `createProxyAppServerHostAuthority` spawns real child processes through this transport. Mocking it (rather
// than the higher-level `DefaultProviderHostManager`'s injected `SpawnProviderServerFn` seam, which this
// module does not use) is what lets the host-pool tests below assert pooling/ref-counting/identity behavior
// without ever forking a process.
vi.mock('#src/providers/app-server-transport.js', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, spawnProviderServerTransport: vi.fn() };
});

// `openSession` reads the spawned process's own start time straight off `/proc` (or platform equivalent).
// Faking a pid that exists in `/proc` is possible but fragile across CI sandboxes; stubbing the probe itself
// is the same technique `provider-hosts/proxy-set-acquisition.test.ts` already uses for the identical call.
vi.mock('#src/infra/node-process.js', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, probeProcessStartedAtSeconds: vi.fn(() => 1_700_000_000) };
});

import { spawnProviderServerTransport, type ProviderServerHandle } from '#src/providers/app-server-transport.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { providerRequestFailed } from '#src/providers/fault.js';
import type {
  BoundProvider,
  BoundProviderAppServerCapability,
  BoundProviderAppServerExecutionRuntime,
} from '#src/providers/bound-provider-contract.js';
import type { HostRef, ProviderEventBody, ProviderServerSpec } from '#src/providers/contract.js';
import {
  MAX_PROVIDER_REPLAY_EVENTS,
  MAX_PROVIDER_REPLAY_BYTES,
  createOperationLedger,
  operationPrepareAttemptKey,
  type OperationLedger,
  type ProviderOperationKey,
} from '#src/provider-proxy/ledger.js';
import type { Proxy } from '#src/provider-proxy/proxy.js';
import type { ControlEndpointTimer } from '#src/provider-proxy/control-endpoint.js';
import {
  PROVIDER_EVENT_METHOD,
  encodeProxyControlFrame,
  providerEventRequestSchema,
  proxyOperationPreparePendingResultSchema,
  type OperationIdentity,
  type ProxyPreparedAppServerOperation,
} from '#src/provider-proxy/protocol.js';
import {
  OperationSupervisor,
  type OperationStageHandle,
  type SemanticOperationHost,
} from '#src/provider-proxy/operation-supervisor.js';
import {
  SEMANTIC_OPERATION_CANCELLATION_TIMEOUT_MS,
  createProxyAppServerHostAuthority,
  createSemanticOperationRuntime,
  specFingerprint,
  specIdentityKey,
  type ProxyAppServerHostAuthority,
} from '#src/provider-proxy/semantic-operation.js';
// Only a test is allowed to see both copies at once (`src/provider-proxy/` may not import
// `src/coordinator/`, enforced by `tests/invariants/architecture-layering.test.ts`, which scans `src/` only —
// see the "agrees byte-for-byte" case below for why importing the forbidden-to-production original here is
// exactly the point).
import { hostFingerprintFromSpec, hostKeyFromSpec } from '#src/coordinator/live/provider-hosts/state.js';
import {
  asJointActivationReceipt,
  asJointContainmentReceipt,
  asReservation,
} from '#tests/helpers/provider-proxy-correlation.js';

const runtime: Runtime = createRealRuntime('prod');

beforeEach(() => {
  // `spawnProviderServerTransport` and `rehydrateBinding` are plain `vi.fn()`s created inside a `vi.mock()`
  // factory, not `vi.spyOn` spies — `vi.restoreAllMocks()` below does not touch them, so each test resets its
  // own queued `mockResolvedValueOnce`/`mockReturnValue` state explicitly rather than leaking into the next.
  vi.mocked(spawnProviderServerTransport).mockReset();
  providerRegistryDouble.rehydrateBinding.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// --- shared fixtures --------------------------------------------------------------------------------------

function testKey(operationId = 'op-1'): ProviderOperationKey {
  return { jobId: 'job-1', operationId };
}

function preparedFixture(overrides: Partial<ProxyPreparedAppServerOperation> = {}): ProxyPreparedAppServerOperation {
  return {
    version: 1,
    provider: 'claude',
    binding: { provider: 'claude', kind: 'account', binding: {} },
    request: {
      action: 'exec',
      sessionId: 'session-1',
      prompt: 'hello',
      cwd: '/workspace',
      bypassPermissions: false,
      coralEnv: {},
    },
    persistedContinuity: null,
    baseEnv: {},
    protectedEnv: {},
    platform: 'linux',
    ...overrides,
  };
}

function unreachable(label: string): () => never {
  return () => {
    throw new Error(`unreachable in this test: ${label}`);
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = (value) => settle(value as T);
  });
  return { promise, resolve };
}

/** A `BoundProvider` test double whose only live behavior is the kernel (`execute`) and staging
 *  (`openReplacement`) the test supplies. Every other member throws if touched — none of them are this
 *  module's concern, and a silent stub would hide a real bug if the implementation ever started calling one. */
function fakeBoundProvider(options: {
  name?: string;
  openReplacement?: BoundProviderAppServerCapability['openReplacement'];
  execute: (runtime: BoundProviderAppServerExecutionRuntime) => AsyncIterable<ProviderEventBody>;
}): BoundProvider {
  const name = options.name ?? 'claude';
  return {
    name,
    envelope: { provider: name, kind: 'account', binding: {} },
    present: unreachable('present'),
    readiness: unreachable('readiness') as unknown as BoundProvider['readiness'],
    compareIdentity: unreachable('compareIdentity'),
    decodeContinuity: unreachable('decodeContinuity'),
    preflight: unreachable('preflight') as unknown as BoundProvider['preflight'],
    prepareExecution: () => ({
      kind: 'app-server',
      hostSpec: fakeHostSpec(name),
      execute: (executionRuntime) => {
        executionRuntime.onHostRef(fakeHostRef(name));
        return options.execute(executionRuntime);
      },
    }),
    appServer: {
      supportsInterrupt: false,
      supportsProbe: false,
      openReplacement: options.openReplacement ?? (async () => ({ hostRef: fakeHostRef(name), close: vi.fn() })),
      interrupt: unreachable('appServer.interrupt') as unknown as BoundProviderAppServerCapability['interrupt'],
      probe: unreachable('appServer.probe') as unknown as BoundProviderAppServerCapability['probe'],
    },
    artifacts: { kind: 'none', reason: 'test double' },
  };
}

function fakeHostSpec(provider = 'claude'): ProviderServerSpec {
  return { provider, command: provider, args: ['app-server'], cwd: '/workspace', leaseMode: 'job-exclusive' };
}

function fakeHostRef(provider = 'claude'): HostRef {
  return {
    provider,
    fingerprint: 'a'.repeat(64),
    instanceId: 'inst-1',
    leaseMode: 'job-exclusive',
    ownerJobId: 'job-1',
  };
}

/** The proxy-side authority `ensureProviderRoot` consults for the staged root's identity. Every test double
 *  provider stages through its own `openReplacement`, so `openSession`/`attachSession` — this module's
 *  callers into the host pool proper, exercised separately below — are never reached from here. */
function fakeHostAuthority(): ProxyAppServerHostAuthority {
  return {
    openSession: unreachable('hostAuthority.openSession') as unknown as ProxyAppServerHostAuthority['openSession'],
    attachSession: async () => null,
    rootIdentity: () => ({ pid: 4242, processStartedAtSeconds: 1_700_000_000 }),
    closed: () => new Promise<Error | void>(() => {}),
    forceClose: async () => {},
  };
}

/** A real `OperationLedger` behind the `Proxy` seam keeps these tests on production admission/accounting. */
function createTestProxy(): {
  proxy: Proxy;
  ledger: OperationLedger<ProxyPreparedAppServerOperation>;
  emittedEvents: Array<{ key: ProviderOperationKey; event: ProviderEventBody }>;
} {
  const ledger = createOperationLedger<ProxyPreparedAppServerOperation>();
  const emittedEvents: Array<{ key: ProviderOperationKey; event: ProviderEventBody }> = [];
  const proxy: Proxy = {
    listen: async () => {},
    close: async () => {},
    ledger: () => ledger,
    emitProviderEvent: async (key, event, signal) => {
      const providerSeq = ledger.nextProviderSeq(key);
      await ledger.recordEvent(
        key,
        { providerSeq, frame: JSON.stringify(event) },
        event.kind === 'terminal' || event.kind === 'suspended'
          ? { kind: 'completion' }
          : { kind: 'ordinary', ...(signal === undefined ? {} : { signal }) },
      );
      emittedEvents.push({ key, event });
      if (event.kind === 'terminal') ledger.transition(key, 'terminal-awaiting-settlement');
      if (event.kind === 'suspended') ledger.transition(key, 'suspended-awaiting-durable-decision');
    },
  };
  return { proxy, ledger, emittedEvents };
}

/** Mirrors the supervisor-owned transitions that make `host.start` legal before the semantic runtime emits. */
function prepareAndActivate(
  ledger: OperationLedger<ProxyPreparedAppServerOperation>,
  key: ProviderOperationKey,
  prepared: ProxyPreparedAppServerOperation,
): void {
  const reserved = ledger.prepare({ key, reservation: asReservation('res'), prepared, nowMs: 0 });
  if (reserved.kind !== 'reserved') throw new Error('expected a reservation');
  ledger.recordPreparation(key, { pid: 1, processStartedAtSeconds: 1 }, asJointContainmentReceipt('contained'));
  const fingerprint = 'f'.repeat(64);
  ledger.beginActivation(key, asReservation('res'), 0, fingerprint);
  ledger.completeActivation(key, fingerprint, {
    state: 'executing',
    activationFingerprint: fingerprint,
    startedAt: new Date(0).toISOString(),
    hostRef: {
      provider: prepared.provider,
      fingerprint: '0'.repeat(64),
      instanceId: `test:${key.operationId}`,
      leaseMode: 'job-exclusive',
      ownerJobId: key.jobId,
    },
    committedThroughProviderSeq: 0,
  });
}

async function fillToEventCeiling(
  ledger: OperationLedger<ProxyPreparedAppServerOperation>,
  key: ProviderOperationKey,
): Promise<void> {
  for (let seq = 1; seq <= MAX_PROVIDER_REPLAY_EVENTS; seq += 1) {
    await ledger.recordEvent(key, { providerSeq: seq, frame: 'x' }, { kind: 'ordinary' });
  }
}

const supervisorTimer: ControlEndpointTimer = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: { unref?: () => void }) => clearTimeout(handle as unknown as NodeJS.Timeout),
};

function supervisedOperation(index: number): OperationIdentity {
  const suffix = index.toString().padStart(12, '0');
  return {
    jobId: `00000000-0000-4000-8000-${suffix}`,
    operationId: `10000000-0000-4000-8000-${suffix}`,
    proxyInstanceId: '20000000-0000-4000-8000-000000000001',
    buildSetId: '30000000-0000-4000-8000-000000000001',
  };
}

function capacityFillingProgressEvent(operation: OperationIdentity, frameId: number): ProviderEventBody {
  const event: ProviderEventBody = { kind: 'progress', message: '' };
  const frame = encodeProxyControlFrame({
    jsonrpc: '2.0',
    id: frameId,
    method: PROVIDER_EVENT_METHOD,
    params: providerEventRequestSchema.parse({ operation, providerSeq: 1, event }),
  });
  return { kind: 'progress', message: 'x'.repeat(MAX_PROVIDER_REPLAY_BYTES - Buffer.byteLength(frame, 'utf8')) };
}

type SaturatedCompletion = 'terminal' | 'suspended' | 'throw' | 'eof';

function saturatedExecution(
  completion: SaturatedCompletion,
  pulled: () => void,
): (runtime: BoundProviderAppServerExecutionRuntime) => AsyncIterable<ProviderEventBody> {
  return async function* () {
    pulled();
    if (completion === 'terminal') {
      yield terminalCompleted;
      return;
    }
    if (completion === 'suspended') {
      yield { kind: 'suspended', reason: 'interrupt_unconfirmed' };
      return;
    }
    if (completion === 'throw') throw new Error('saturated kernel exploded');
  };
}

const terminalCompleted: ProviderEventBody = {
  kind: 'terminal',
  terminal: { content: 'done', durationMs: 5, outcome: { kind: 'completed' } },
  diagnostics: {},
};

// --- pump loop outcomes ------------------------------------------------------------------------------------

describe('semantic-operation runtime: pump loop outcomes', () => {
  it('drains a kernel that completes normally and leaves it awaiting settlement', async () => {
    const { proxy, ledger, emittedEvents } = createTestProxy();
    const key = testKey();
    const prepared = preparedFixture();
    prepareAndActivate(ledger, key, prepared);
    const closeStaged = vi.fn();
    const stagedHostRef = fakeHostRef();

    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: fakeBoundProvider({
        execute: async function* () {
          yield terminalCompleted;
        },
        openReplacement: async () => ({ hostRef: stagedHostRef, close: closeStaged }),
      }),
    });

    const host = createSemanticOperationRuntime({ runtime, hostAuthority: fakeHostAuthority(), getProxy: () => proxy });
    await host.ensureProviderRoot(key, prepared);
    const start = host.host.start({ key, prepared });

    await expect(start.result).resolves.toEqual({ kind: 'started', hostRef: stagedHostRef });
    await vi.waitFor(() => expect(ledger.get(key)?.state).toBe('terminal-awaiting-settlement'));
    expect(emittedEvents).toEqual([{ key, event: terminalCompleted }]);
    await vi.waitFor(() => expect(closeStaged).toHaveBeenCalledOnce());
  });

  it('synthesizes a failed terminal when a started provider stream ends without completion', async () => {
    const { proxy, ledger, emittedEvents } = createTestProxy();
    const key = testKey();
    const prepared = preparedFixture();
    prepareAndActivate(ledger, key, prepared);
    const closeStaged = vi.fn();
    const stagedHostRef = fakeHostRef();

    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: fakeBoundProvider({
        execute: async function* () {},
        openReplacement: async () => ({ hostRef: stagedHostRef, close: closeStaged }),
      }),
    });

    const host = createSemanticOperationRuntime({ runtime, hostAuthority: fakeHostAuthority(), getProxy: () => proxy });
    await host.ensureProviderRoot(key, prepared);
    const start = host.host.start({ key, prepared });

    await expect(start.result).resolves.toEqual({ kind: 'started', hostRef: stagedHostRef });
    await vi.waitFor(() => expect(closeStaged).toHaveBeenCalledOnce());
    expect.soft(ledger.get(key)?.state).toBe('terminal-awaiting-settlement');
    expect.soft(emittedEvents).toHaveLength(1);
    const event = emittedEvents[0]?.event;
    expect(event).toMatchObject({
      kind: 'terminal',
      terminal: { outcome: { kind: 'failed' } },
      failureCause: providerRequestFailed({
        provider: 'claude',
        message: 'Provider event stream ended without terminal or suspension.',
      }),
    });
  });

  it('synthesizes a failed terminal when the kernel throws with no stop in flight', async () => {
    const { proxy, ledger, emittedEvents } = createTestProxy();
    const key = testKey();
    const prepared = preparedFixture();
    prepareAndActivate(ledger, key, prepared);

    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: fakeBoundProvider({
        execute: async function* () {
          throw new Error('kernel exploded');
        },
      }),
    });

    const host = createSemanticOperationRuntime({ runtime, hostAuthority: fakeHostAuthority(), getProxy: () => proxy });
    await host.ensureProviderRoot(key, prepared);
    host.host.start({ key, prepared });

    await vi.waitFor(() => expect(ledger.get(key)?.state).toBe('terminal-awaiting-settlement'));
    expect(emittedEvents).toHaveLength(1);
    const [{ event }] = emittedEvents;
    if (event.kind !== 'terminal') throw new Error('expected a terminal event');
    expect(event.terminal.outcome).toEqual({ kind: 'failed' });
    expect(event.failureCause).toEqual(providerRequestFailed({ provider: 'claude', message: 'kernel exploded' }));
  });

  it('emits a synthesized aborted terminal when the kernel throws while an abort-cause stop is in flight', async () => {
    const { proxy, ledger, emittedEvents } = createTestProxy();
    const key = testKey();
    const prepared = preparedFixture();
    prepareAndActivate(ledger, key, prepared);
    let kernelWaiting = false;

    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: fakeBoundProvider({
        // A well-behaved app-server kernel watches its signal and throws once asked to stop; nothing about
        // this module's classification logic runs until it does.
        execute: async function* (execRuntime) {
          kernelWaiting = true;
          await new Promise<void>((_resolve, reject) => {
            execRuntime.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        },
      }),
    });

    const host = createSemanticOperationRuntime({ runtime, hostAuthority: fakeHostAuthority(), getProxy: () => proxy });
    await host.ensureProviderRoot(key, prepared);
    host.host.start({ key, prepared });
    await vi.waitFor(() => expect(kernelWaiting).toBe(true));

    await host.host.stop({ key, cause: 'user_abort' });

    expect(emittedEvents).toHaveLength(1);
    const [{ event }] = emittedEvents;
    if (event.kind !== 'terminal') throw new Error('expected a terminal event');
    expect(event.terminal.outcome).toEqual({ kind: 'aborted', reason: 'user_abort' });
    expect(ledger.get(key)?.state).toBe('terminal-awaiting-settlement');
  });

  it('emits nothing when the kernel throws while an interruption-cause stop is in flight', async () => {
    const { proxy, ledger, emittedEvents } = createTestProxy();
    const key = testKey();
    const prepared = preparedFixture();
    prepareAndActivate(ledger, key, prepared);
    let kernelWaiting = false;

    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: fakeBoundProvider({
        execute: async function* (execRuntime) {
          kernelWaiting = true;
          await new Promise<void>((_resolve, reject) => {
            execRuntime.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        },
      }),
    });

    const host = createSemanticOperationRuntime({ runtime, hostAuthority: fakeHostAuthority(), getProxy: () => proxy });
    await host.ensureProviderRoot(key, prepared);
    host.host.start({ key, prepared });
    await vi.waitFor(() => expect(kernelWaiting).toBe(true));

    await host.host.stop({ key, cause: 'restart' });

    // The coordinator, not this module, synthesizes `session.interrupted` from `operation.stop.v1`'s own
    // reply — so nothing here emits a provider event, and the entry is left exactly where it was (`executing`)
    // for `operation.stop.v1`'s own subsequent transition to move.
    expect(emittedEvents).toEqual([]);
    expect(ledger.get(key)?.state).toBe('executing');
  });
});

// --- stop() racing a still-draining emit --------------------------------------------------------------------

describe('semantic-operation runtime: stop() racing a still-draining emit', () => {
  it('awaits the in-flight iteration fully before resolving, and the straggler transition is refused as invalid once more', async () => {
    const { proxy, ledger, emittedEvents } = createTestProxy();
    const key = testKey();
    const prepared = preparedFixture();
    prepareAndActivate(ledger, key, prepared);

    const order: string[] = [];
    const progressEvent: ProviderEventBody = { kind: 'progress', message: 'before stop' };
    const closeStaged = vi.fn(() => {
      order.push('closed');
    });
    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: fakeBoundProvider({
        execute: async function* (execRuntime) {
          yield progressEvent;
          await new Promise<void>((_resolve, reject) => {
            if (execRuntime.signal.aborted) {
              reject(new Error('aborted'));
              return;
            }
            execRuntime.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        },
        openReplacement: async () => ({ hostRef: fakeHostRef(), close: closeStaged }),
      }),
    });

    const host = createSemanticOperationRuntime({ runtime, hostAuthority: fakeHostAuthority(), getProxy: () => proxy });
    await host.ensureProviderRoot(key, prepared);
    host.host.start({ key, prepared });

    // The first event must already be emitted before stop is called, rather than being caused by the stop.
    await vi.waitFor(() => expect(emittedEvents).toHaveLength(1));

    order.push('stop-called');
    await host.host.stop({ key, cause: 'user_abort' });
    order.push('stop-resolved');

    // If stop() returned before the pump's own finally-block cleanup ran, 'closed' would land after
    // 'stop-resolved' instead of before it — this is the ordering guarantee the doc comment promises.
    expect(order).toEqual(['stop-called', 'closed', 'stop-resolved']);
    expect(emittedEvents[0]).toEqual({ key, event: progressEvent });
    expect(emittedEvents[1]?.event).toMatchObject({
      kind: 'terminal',
      terminal: { outcome: { kind: 'aborted', reason: 'user_abort' } },
    });
    expect(ledger.get(key)?.state).toBe('terminal-awaiting-settlement');

    // No event was emitted after stop() resolved.
    expect(emittedEvents).toHaveLength(2);

    // The synthesized abort already carried this operation to `terminal-awaiting-settlement`; the control
    // handler racing the same stop must be refused rather than silently reapplying the transition.
    expect(() => ledger.transition(key, 'terminal-awaiting-settlement')).toThrow(/does not reach/u);
  });
});

describe('semantic-operation runtime: bounded cancellation', () => {
  it('force-closes the tracked host and lets transport closure settle a pull that ignores abort', async () => {
    const { proxy, ledger } = createTestProxy();
    const key = testKey();
    const prepared = preparedFixture();
    prepareAndActivate(ledger, key, prepared);
    const closeStaged = vi.fn();
    const transportClosed = deferred<Error | void>();
    const forceClose = vi.fn(async () => {
      transportClosed.resolve();
    });
    const hostAuthority = {
      openSession: unreachable('hostAuthority.openSession'),
      attachSession: async () => null,
      rootIdentity: () => ({ pid: 4242, processStartedAtSeconds: 1_700_000_000 }),
      closed: () => transportClosed.promise,
      forceClose,
    } as ProxyAppServerHostAuthority;

    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: fakeBoundProvider({
        execute: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise<IteratorResult<ProviderEventBody>>(() => {}),
          }),
        }),
        openReplacement: async () => ({ hostRef: fakeHostRef(), close: closeStaged }),
      }),
    });

    const semantic = createSemanticOperationRuntime({ runtime, hostAuthority, getProxy: () => proxy });
    await semantic.ensureProviderRoot(key, prepared);
    const start = semantic.host.start({ key, prepared });
    await expect(start.result).resolves.toEqual({ kind: 'started', hostRef: fakeHostRef() });

    let stopSettled = false;
    void Promise.resolve(semantic.host.stop({ key, cause: 'user_abort' })).then(() => {
      stopSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect.soft(forceClose).toHaveBeenCalledOnce();
    expect.soft(stopSettled).toBe(true);
    expect(closeStaged).toHaveBeenCalledOnce();
  });

  it('times out release when staging ignores abort before exposing a host', async () => {
    vi.useFakeTimers();
    const { proxy } = createTestProxy();
    const neverOpened = deferred<Readonly<{ hostRef: HostRef; close(): void }>>();
    const openReplacement = vi.fn(() => neverOpened.promise);
    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: fakeBoundProvider({
        execute: unreachable('execute') as unknown as (
          runtime: BoundProviderAppServerExecutionRuntime,
        ) => AsyncIterable<ProviderEventBody>,
        openReplacement,
      }),
    });

    const semantic = createSemanticOperationRuntime({
      runtime,
      hostAuthority: fakeHostAuthority(),
      getProxy: () => proxy,
    });
    const stage = semantic.stage(testKey(), preparedFixture());
    await Promise.resolve();
    expect(openReplacement).toHaveBeenCalledOnce();

    let releaseSettled = false;
    let releaseError: unknown;
    void stage.abortAndRelease().then(
      () => {
        releaseSettled = true;
      },
      (error: unknown) => {
        releaseSettled = true;
        releaseError = error;
      },
    );
    await vi.advanceTimersByTimeAsync(SEMANTIC_OPERATION_CANCELLATION_TIMEOUT_MS);

    expect.soft(releaseSettled).toBe(true);
    expect(releaseError).toMatchObject({
      name: 'SemanticOperationCancellationTimeoutError',
      code: 'semantic_operation_cancellation_timeout',
      timeoutMs: SEMANTIC_OPERATION_CANCELLATION_TIMEOUT_MS,
      message: 'Provider operation cancellation did not settle within 10000ms.',
    });
  });
});

// --- pre-consumption replay admission ------------------------------------------------------------------------

describe('semantic-operation runtime: replay admission', () => {
  it('pulls one ordinary event before admission and does not pull another until that event is admitted', async () => {
    const { proxy, ledger, emittedEvents } = createTestProxy();
    const key = testKey();
    const prepared = preparedFixture();
    prepareAndActivate(ledger, key, prepared);
    await fillToEventCeiling(ledger, key);

    let pullCount = 0;
    const progressEvent: ProviderEventBody = { kind: 'progress', message: 'first' };
    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: fakeBoundProvider({
        execute: async function* () {
          pullCount += 1;
          yield progressEvent;
          pullCount += 1;
          yield terminalCompleted;
        },
      }),
    });

    const host = createSemanticOperationRuntime({ runtime, hostAuthority: fakeHostAuthority(), getProxy: () => proxy });
    await host.ensureProviderRoot(key, prepared);
    host.host.start({ key, prepared });

    await vi.waitFor(() => expect(pullCount).toBe(1));
    expect(emittedEvents).toHaveLength(0);
    expect(pullCount).toBe(1);

    ledger.acknowledge(key, 1);
    await vi.waitFor(() => expect(pullCount).toBe(2));
    expect(ledger.get(key)?.state).toBe('terminal-awaiting-settlement');
    expect(ledger.get(key)?.bufferedEvents).toHaveLength(MAX_PROVIDER_REPLAY_EVENTS + 1);
    expect(emittedEvents.at(-1)).toEqual({ key, event: terminalCompleted });
  });

  it.each([
    ['terminal', 'terminal-awaiting-settlement'],
    ['suspended', 'suspended-awaiting-durable-decision'],
    ['throw', 'terminal-awaiting-settlement'],
    ['eof', 'terminal-awaiting-settlement'],
  ] as const)(
    'admits a fifth %s completion while four ordinary frames retain the full proxy budget',
    async (completion, expectedState) => {
      const holders = [1, 2, 3, 4].map(supervisedOperation);
      const target = supervisedOperation(5);
      const containmentReceipt = asJointContainmentReceipt('contained');
      let pullCount = 0;

      providerRegistryDouble.rehydrateBinding.mockReturnValue({
        ok: true,
        value: fakeBoundProvider({
          execute: saturatedExecution(completion, () => {
            pullCount += 1;
          }),
        }),
      });

      const proxy: Proxy = {
        listen: async () => {},
        close: async () => {},
        ledger: () => supervisor.ledger(),
        emitProviderEvent: (key, event, signal) => supervisor.emitProviderEvent(key, event, signal),
      };
      const semantic = createSemanticOperationRuntime({
        runtime,
        hostAuthority: fakeHostAuthority(),
        getProxy: () => proxy,
      });
      const semanticHost: SemanticOperationHost = {
        start: (input) =>
          input.key.operationId === target.operationId
            ? semantic.host.start(input)
            : {
                result: Promise.resolve({ kind: 'started', hostRef: fakeHostRef() }),
                abortAndRelease: async () => {},
              },
        stop: (input) => (input.key.operationId === target.operationId ? semantic.host.stop(input) : Promise.resolve()),
      };
      const stageProviderRoot = (
        key: ProviderOperationKey,
        reserved: Readonly<{ prepared: ProxyPreparedAppServerOperation }>,
      ): OperationStageHandle => ({
        result:
          key.operationId === target.operationId
            ? semantic
                .ensureProviderRoot(key, reserved.prepared)
                .then((staged) =>
                  staged.state === 'permanent-refusal'
                    ? staged
                    : { state: 'staged' as const, providerRoot: staged.providerRoot, receipt: containmentReceipt },
                )
            : Promise.resolve({
                state: 'staged' as const,
                providerRoot: { pid: 4242, processStartedAtSeconds: 1_700_000_000 },
                receipt: containmentReceipt,
              }),
        confirmActivation: async () => {},
        abortAndRelease: async () => {},
      });

      const supervisor = new OperationSupervisor({
        host: semanticHost,
        timer: supervisorTimer,
        mintReservation: () => asReservation('40000000-0000-4000-8000-000000000001'),
        wallClockNow: () => 0,
        nowMs: () => 0,
        proxyInstanceId: target.proxyInstanceId,
        buildSetId: target.buildSetId,
        stageProviderRoot,
        pushProviderEvent: async () => {
          throw new Error('control is deliberately offline');
        },
      });

      const prepare = async (operation: OperationIdentity) => {
        const prepareRequest = {
          operation,
          hostFingerprint: 'a'.repeat(64),
          prepareAttemptNumber: 1,
          prepared: preparedFixture(),
        };
        const prepared = proxyOperationPreparePendingResultSchema.parse(
          await supervisor.prepare(operation, {
            prepareAttemptNumber: 1,
            prepareAttemptKey: operationPrepareAttemptKey(prepareRequest),
            prepared: prepareRequest.prepared,
          }),
        );
        return prepared;
      };
      const activate = async (
        operation: OperationIdentity,
        prepared: ReturnType<typeof proxyOperationPreparePendingResultSchema.parse>,
      ): Promise<void> => {
        await supervisor.activate(operation, {
          reservation: prepared.reservation,
          jointContainmentReceipt: prepared.jointContainmentReceipt,
          jointActivationReceipt: asJointActivationReceipt('activated'),
          activationFingerprint: 'f'.repeat(64),
        });
        await supervisor.attach(operation, 0);
      };

      try {
        const prepared = new Map<OperationIdentity, Awaited<ReturnType<typeof prepare>>>();
        for (const operation of [...holders, target]) prepared.set(operation, await prepare(operation));
        for (const [index, holder] of holders.entries()) {
          const holderPreparation = prepared.get(holder);
          if (holderPreparation === undefined) throw new Error('missing holder preparation');
          await activate(holder, holderPreparation);
          await supervisor.emitProviderEvent(holder, capacityFillingProgressEvent(holder, index + 1));
          expect(supervisor.ledger().get(holder)?.bufferedBytes).toBe(MAX_PROVIDER_REPLAY_BYTES);
        }

        const targetPreparation = prepared.get(target);
        if (targetPreparation === undefined) throw new Error('missing target preparation');
        await activate(target, targetPreparation);
        await vi.waitFor(() => expect(pullCount).toBe(1));
        for (const holder of holders) {
          expect(supervisor.ledger().get(holder)).toMatchObject({
            state: 'executing',
            bufferedBytes: MAX_PROVIDER_REPLAY_BYTES,
          });
        }
        await vi.waitFor(() => expect(supervisor.ledger().get(target)?.state).toBe(expectedState));
        expect(supervisor.ledger().get(target)?.bufferedEvents).toHaveLength(1);
      } finally {
        for (const holder of holders) {
          if ((supervisor.ledger().get(holder)?.bufferedEvents.length ?? 0) > 0) {
            supervisor.ledger().acknowledge(holder, 1);
          }
        }
        await Promise.resolve();
        supervisor.close();
      }
    },
  );
});

// --- prepare refusal classification -------------------------------------------------------------------------

describe('semantic-operation runtime: prepare refusal classification', () => {
  it('returns a reconstruction refusal when the binding cannot be rehydrated', async () => {
    const { proxy } = createTestProxy();
    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: false,
      failure: { reason: 'invalid-persisted-binding', provider: 'claude' },
    });

    const host = createSemanticOperationRuntime({ runtime, hostAuthority: fakeHostAuthority(), getProxy: () => proxy });

    await expect(host.ensureProviderRoot(testKey(), preparedFixture())).resolves.toEqual({
      state: 'permanent-refusal',
      code: 'provider_reconstruction_refused',
      disposition: 'local-fallback',
      reason: "Prepared operation named provider 'claude' with an unrehydratable binding (invalid-persisted-binding).",
    });
  });

  it('returns a reconstruction refusal when persisted continuity is not a record', async () => {
    const { proxy } = createTestProxy();
    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: fakeBoundProvider({
        execute: unreachable('execute') as unknown as (
          runtime: BoundProviderAppServerExecutionRuntime,
        ) => AsyncIterable<ProviderEventBody>,
      }),
    });

    const host = createSemanticOperationRuntime({ runtime, hostAuthority: fakeHostAuthority(), getProxy: () => proxy });
    const prepared = preparedFixture({ persistedContinuity: 'not-a-record' });

    await expect(host.ensureProviderRoot(testKey(), prepared)).resolves.toEqual({
      state: 'permanent-refusal',
      code: 'provider_reconstruction_refused',
      disposition: 'local-fallback',
      reason: "Prepared operation for provider 'claude' carried non-record persisted continuity.",
    });
  });

  it('returns a reconstruction refusal when the rehydrated binding names a different provider', async () => {
    const { proxy } = createTestProxy();
    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: fakeBoundProvider({
        name: 'codex',
        execute: unreachable('execute') as unknown as (
          runtime: BoundProviderAppServerExecutionRuntime,
        ) => AsyncIterable<ProviderEventBody>,
      }),
    });

    const host = createSemanticOperationRuntime({ runtime, hostAuthority: fakeHostAuthority(), getProxy: () => proxy });

    await expect(host.ensureProviderRoot(testKey(), preparedFixture({ provider: 'claude' }))).resolves.toEqual({
      state: 'permanent-refusal',
      code: 'provider_reconstruction_refused',
      disposition: 'local-fallback',
      reason: "Prepared operation named provider 'claude' but its binding rehydrated to 'codex'.",
    });
  });

  it('returns a reconstruction refusal when the binding has no app-server capability', async () => {
    const { proxy } = createTestProxy();
    const withoutAppServer = fakeBoundProvider({
      execute: unreachable('execute') as unknown as (
        runtime: BoundProviderAppServerExecutionRuntime,
      ) => AsyncIterable<ProviderEventBody>,
    });
    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: { ...withoutAppServer, appServer: undefined },
    });

    const host = createSemanticOperationRuntime({ runtime, hostAuthority: fakeHostAuthority(), getProxy: () => proxy });

    await expect(host.ensureProviderRoot(testKey(), preparedFixture())).resolves.toEqual({
      state: 'permanent-refusal',
      code: 'provider_reconstruction_refused',
      disposition: 'local-fallback',
      reason: "Provider 'claude' has no app-server capability; this proxy runs app-server operations only.",
    });
  });

  it('returns a provider-creation refusal when openReplacement rejects before exposing a root', async () => {
    const { proxy } = createTestProxy();
    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: fakeBoundProvider({
        execute: unreachable('execute') as unknown as (
          runtime: BoundProviderAppServerExecutionRuntime,
        ) => AsyncIterable<ProviderEventBody>,
        openReplacement: async () => {
          throw new Error('provider creation failed');
        },
      }),
    });

    const host = createSemanticOperationRuntime({ runtime, hostAuthority: fakeHostAuthority(), getProxy: () => proxy });

    await expect(host.ensureProviderRoot(testKey(), preparedFixture())).resolves.toEqual({
      state: 'permanent-refusal',
      code: 'provider_creation_refused',
      disposition: 'local-fallback',
      reason: 'provider creation failed',
    });
  });
});

// --- createProxyAppServerHostAuthority: the host pool -----------------------------------------------------

function fakeProviderServerHandle(options?: { pid?: number }): {
  handle: ProviderServerHandle;
  closeMock: ReturnType<typeof vi.fn>;
} {
  const closeMock = vi.fn(async () => {});
  const handle: ProviderServerHandle = {
    pid: options?.pid ?? 1_000,
    child: {} as never,
    generation: 1,
    rpc: {
      request: vi.fn(async () => ({})) as unknown as ProviderServerHandle['rpc']['request'],
      notify: vi.fn(),
    },
    onNotification: vi.fn(() => () => {}) as unknown as ProviderServerHandle['onNotification'],
    closePromise: new Promise(() => {}),
    isClosed: () => false,
    markExpectedClose: vi.fn(),
    close: closeMock,
  };
  return { handle, closeMock };
}

function sharedSpec(overrides: Partial<ProviderServerSpec> = {}): ProviderServerSpec {
  return {
    provider: 'claude',
    command: 'claude',
    args: ['app-server'],
    cwd: '/workspace',
    leaseMode: 'shared',
    idleRetirement: 'host-reported',
    ...overrides,
  } as ProviderServerSpec;
}

function exclusiveSpec(overrides: Partial<ProviderServerSpec> = {}): ProviderServerSpec {
  return {
    provider: 'codex',
    command: 'codex',
    args: ['app-server'],
    cwd: '/workspace',
    leaseMode: 'job-exclusive',
    ...overrides,
  } as ProviderServerSpec;
}

describe('semantic-operation: createProxyAppServerHostAuthority (host pool)', () => {
  it('pools a shared spec by executable identity alone, spawning once and reusing it', async () => {
    const server = fakeProviderServerHandle();
    vi.mocked(spawnProviderServerTransport).mockResolvedValueOnce(server.handle);
    const authority = createProxyAppServerHostAuthority(runtime);
    const spec = sharedSpec();

    const first = await authority.openSession(spec);
    const second = await authority.openSession(spec);

    expect(spawnProviderServerTransport).toHaveBeenCalledTimes(1);
    expect(first.hostRef.instanceId).toBe(second.hostRef.instanceId);
    first.close();
    second.close();
  });

  it('pools a job-exclusive spec by identity and job id, spawning a separate process per job', async () => {
    const jobA = fakeProviderServerHandle();
    const jobB = fakeProviderServerHandle();
    vi.mocked(spawnProviderServerTransport).mockResolvedValueOnce(jobA.handle).mockResolvedValueOnce(jobB.handle);
    const authority = createProxyAppServerHostAuthority(runtime);
    const spec = exclusiveSpec();

    const forJobA = await authority.openSession(spec, { jobId: 'job-a' });
    const forJobB = await authority.openSession(spec, { jobId: 'job-b' });

    expect(spawnProviderServerTransport).toHaveBeenCalledTimes(2);
    expect(forJobA.hostRef.instanceId).not.toBe(forJobB.hostRef.instanceId);
    forJobA.close();
    forJobB.close();
  });

  it('reuses one job-exclusive entry across repeated stage-then-activate calls for the same job', async () => {
    const server = fakeProviderServerHandle();
    vi.mocked(spawnProviderServerTransport).mockResolvedValueOnce(server.handle);
    const authority = createProxyAppServerHostAuthority(runtime);
    const spec = exclusiveSpec();

    const first = await authority.openSession(spec, { jobId: 'job-a' });
    const second = await authority.openSession(spec, { jobId: 'job-a' });

    expect(spawnProviderServerTransport).toHaveBeenCalledTimes(1);
    expect(first.hostRef.instanceId).toBe(second.hostRef.instanceId);
    first.close();
    second.close();
  });

  it('refuses a job-exclusive acquisition with no job id before ever spawning', async () => {
    const authority = createProxyAppServerHostAuthority(runtime);

    await expect(authority.openSession(exclusiveSpec())).rejects.toThrow('provider_host_policy_invalid');
    expect(spawnProviderServerTransport).not.toHaveBeenCalled();
  });

  it('does not close the pooled process while another operation still references it', async () => {
    const server = fakeProviderServerHandle();
    vi.mocked(spawnProviderServerTransport).mockResolvedValueOnce(server.handle);
    const authority = createProxyAppServerHostAuthority(runtime);
    const spec = sharedSpec();

    const first = await authority.openSession(spec);
    const second = await authority.openSession(spec);

    first.close();
    expect(server.closeMock).not.toHaveBeenCalled();
    second.close();
    expect(server.closeMock).toHaveBeenCalledOnce();
  });

  it('attachSession matches only a hostRef whose fields all agree, and rejects any that disagree', async () => {
    const server = fakeProviderServerHandle();
    vi.mocked(spawnProviderServerTransport).mockResolvedValueOnce(server.handle);
    const authority = createProxyAppServerHostAuthority(runtime);
    const spec = sharedSpec();
    const opened = await authority.openSession(spec);

    const attached = await authority.attachSession(opened.hostRef, { spec, jobId: 'shared-attachment' });
    expect(attached).not.toBeNull();
    attached?.close();

    const wrongFingerprint = await authority.attachSession(
      { ...opened.hostRef, fingerprint: '0'.repeat(64) },
      { spec, jobId: 'shared-attachment' },
    );
    expect(wrongFingerprint).toBeNull();

    opened.close();
  });

  it('reports the live root identity for a held hostRef and null once its last reference releases', async () => {
    const server = fakeProviderServerHandle({ pid: 4_242 });
    vi.mocked(spawnProviderServerTransport).mockResolvedValueOnce(server.handle);
    const authority = createProxyAppServerHostAuthority(runtime);
    const opened = await authority.openSession(sharedSpec());

    expect(authority.rootIdentity(opened.hostRef)).toEqual({ pid: 4_242, processStartedAtSeconds: 1_700_000_000 });

    opened.close();
    expect(authority.rootIdentity(opened.hostRef)).toBeNull();
  });

  it('force-closes a matching entry immediately without waiting for its references', async () => {
    const server = fakeProviderServerHandle();
    vi.mocked(spawnProviderServerTransport).mockResolvedValueOnce(server.handle);
    const authority = createProxyAppServerHostAuthority(runtime);
    const opened = await authority.openSession(sharedSpec());
    const attached = await authority.attachSession(opened.hostRef, {
      spec: sharedSpec(),
      jobId: 'shared-attachment',
    });
    expect(attached).not.toBeNull();
    expect(authority.closed(opened.hostRef)).toBe(server.handle.closePromise);

    const closing = authority.forceClose(opened.hostRef);

    expect(authority.rootIdentity(opened.hostRef)).toBeNull();
    expect(authority.closed(opened.hostRef)).toBeNull();
    await closing;
    await authority.forceClose(opened.hostRef);
    opened.close();
    attached?.close();
    expect(server.closeMock).toHaveBeenCalledOnce();
  });
});

// --- specIdentityKey / specFingerprint: the host-pool key function --------------------------------------
//
// Regression coverage for the defect where `specIdentityKey` passed `Object.keys(canonical).sort()` as
// `JSON.stringify`'s *replacer* argument. A replacer allowlist applies at every nesting level, not just the
// top, so both `env` and `initializeRequest` — themselves objects one level down — serialized as `{}` no
// matter what they held. Two specs differing only in credentials then produced an identical pool key, and
// `openSession` (`createProxyAppServerHostAuthority`, above) would hand back an already-running host spawned
// under different credentials.

describe('semantic-operation: specIdentityKey / specFingerprint', () => {
  it('produces different keys and fingerprints for specs that differ only in env', () => {
    const withAccountA = sharedSpec({ env: { CORAL_ACCOUNT: 'account-a' } });
    const withAccountB = sharedSpec({ env: { CORAL_ACCOUNT: 'account-b' } });

    expect(specIdentityKey(withAccountA)).not.toBe(specIdentityKey(withAccountB));
    expect(specFingerprint(runtime, withAccountA)).not.toBe(specFingerprint(runtime, withAccountB));
  });

  it('produces different keys and fingerprints for specs that differ only in initializeRequest', () => {
    const withFoo = sharedSpec({
      initializeRequest: { method: 'initialize', params: { clientInfo: { name: 'foo' } } },
    });
    const withBar = sharedSpec({
      initializeRequest: { method: 'initialize', params: { clientInfo: { name: 'bar' } } },
    });

    expect(specIdentityKey(withFoo)).not.toBe(specIdentityKey(withBar));
    expect(specFingerprint(runtime, withFoo)).not.toBe(specFingerprint(runtime, withBar));
  });

  it('produces the same key for two specs whose fields were populated in a different order', () => {
    const inDeclaredOrder = sharedSpec({ env: { A_VAR: '1', B_VAR: '2' } });
    // Same content as `inDeclaredOrder`, but every object literal below (the spec itself and its nested
    // `env`) lists its keys in the opposite order — proving the key is order-independent, not merely
    // insensitive to `env`'s own ordering.
    const reversedInsertionOrder: ProviderServerSpec = {
      idleRetirement: 'host-reported',
      leaseMode: 'shared',
      env: { B_VAR: '2', A_VAR: '1' },
      cwd: '/workspace',
      args: ['app-server'],
      command: 'claude',
      provider: 'claude',
    };

    expect(specIdentityKey(reversedInsertionOrder)).toBe(specIdentityKey(inDeclaredOrder));
    expect(specFingerprint(runtime, reversedInsertionOrder)).toBe(specFingerprint(runtime, inDeclaredOrder));
  });

  // The whole risk this module's doc comments call out is silent drift between this file's copy and the
  // coordinator's original (`hostKeyFromSpec`/`hostFingerprintFromSpec`,
  // `src/coordinator/live/provider-hosts/state.ts`) — a `HostRef.fingerprint` minted by one build that a
  // proxy from a different build can never recognize as the same host. Only a test can see both copies at
  // once (the layering ban applies to `src/`, not `tests/`), so this is the one thing that makes the
  // "mirrors" claim in both modules' doc comments self-enforcing rather than merely asserted.
  it('agrees byte-for-byte with the coordinator-side hostKeyFromSpec / hostFingerprintFromSpec', () => {
    const specs: ProviderServerSpec[] = [
      sharedSpec({
        env: { CORAL_ACCOUNT: 'account-a' },
        initializeRequest: { method: 'initialize', params: { clientInfo: { name: 'proxy' } } },
        initializeTimeoutMs: 5_000,
        shutdownCapability: { method: 'shutdown', timeoutMs: 1_000 },
      }),
      exclusiveSpec({ initializeTimeoutMs: 2_500 }),
    ];

    for (const spec of specs) {
      expect(specIdentityKey(spec)).toBe(hostKeyFromSpec(spec));
      expect(specFingerprint(runtime, spec)).toBe(hostFingerprintFromSpec(spec));
    }
  });
});
