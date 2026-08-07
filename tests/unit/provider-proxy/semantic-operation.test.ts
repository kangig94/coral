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
  createOperationLedger,
  type OperationLedger,
  type ProviderOperationKey,
} from '#src/provider-proxy/ledger.js';
import type { Proxy } from '#src/provider-proxy/proxy.js';
import type { ProxyPreparedAppServerOperation } from '#src/provider-proxy/protocol.js';
import {
  createProxyAppServerHostAuthority,
  createSemanticOperationRuntime,
  type ProxyAppServerHostAuthority,
} from '#src/provider-proxy/semantic-operation.js';

const runtime: Runtime = createRealRuntime('prod');

// Matches `PAUSED_POLL_INTERVAL_MS` in semantic-operation.ts, which is not exported: it is an internal timing
// constant, not part of this module's public contract, so the tests below name their own copy rather than
// reach into the module for it.
const POLL_INTERVAL_MS = 50;

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
      execute: options.execute,
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
  };
}

/** A real `OperationLedger` behind the `Proxy` seam, wired exactly as `proxy.ts`'s own `emitProviderEvent`
 *  is: recording into the ledger and reporting its real `paused` verdict. Real objects over mocks — the
 *  ledger's own transition/capacity rules are what several of these tests are ultimately proving hold. */
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
    emitProviderEvent: (key, event) => {
      emittedEvents.push({ key, event });
      const providerSeq = ledger.nextProviderSeq(key);
      return ledger.recordEvent(key, { providerSeq, frame: JSON.stringify(event) });
    },
  };
  return { proxy, ledger, emittedEvents };
}

/** Mirrors what `operation.prepare.v1` then `operation.activate.v1` do to a ledger entry before `host.start`
 *  is ever legal to call — `runPump`'s own `safeTransition` calls require the entry to already be `executing`. */
function prepareAndActivate(
  ledger: OperationLedger<ProxyPreparedAppServerOperation>,
  key: ProviderOperationKey,
  prepared: ProxyPreparedAppServerOperation,
): void {
  const reserved = ledger.prepare({ key, reservationId: 'res', activationNonce: 'nonce', prepared, nowMs: 0 });
  if (reserved.kind !== 'reserved') throw new Error('expected a reservation');
  ledger.activate(key, 'res', 'nonce', 0);
}

/** Seeds the ledger to one event short of its per-operation ceiling, so the very next `recordEvent` call
 *  tips it into `paused: true` — cheap (tiny frames) and exercises the real ledger math rather than asserting
 *  against a hand-picked byte count. */
function fillToEventCeiling(ledger: OperationLedger<ProxyPreparedAppServerOperation>, key: ProviderOperationKey): void {
  for (let seq = 1; seq <= MAX_PROVIDER_REPLAY_EVENTS - 1; seq += 1) {
    ledger.recordEvent(key, { providerSeq: seq, frame: 'x' });
  }
}

const terminalCompleted: ProviderEventBody = {
  kind: 'terminal',
  terminal: { content: 'done', durationMs: 5, outcome: { kind: 'completed' } },
  diagnostics: {},
};

// --- pump loop outcomes ------------------------------------------------------------------------------------

describe('semantic-operation runtime: pump loop outcomes', () => {
  it('drains a kernel that completes normally and settles the ledger to terminal-awaiting-journal-ack', async () => {
    const { proxy, ledger, emittedEvents } = createTestProxy();
    const key = testKey();
    const prepared = preparedFixture();
    prepareAndActivate(ledger, key, prepared);
    const closeStaged = vi.fn();

    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: fakeBoundProvider({
        execute: async function* () {
          yield terminalCompleted;
        },
        openReplacement: async () => ({ hostRef: fakeHostRef(), close: closeStaged }),
      }),
    });

    const host = createSemanticOperationRuntime({ runtime, hostAuthority: fakeHostAuthority(), getProxy: () => proxy });
    await host.ensureProviderRoot(key, prepared);
    host.host.start({ key, prepared });

    await vi.waitFor(() => expect(ledger.get(key)?.state).toBe('terminal-awaiting-journal-ack'));
    expect(emittedEvents).toEqual([{ key, event: terminalCompleted }]);
    expect(closeStaged).toHaveBeenCalledOnce();
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

    await vi.waitFor(() => expect(ledger.get(key)?.state).toBe('terminal-awaiting-journal-ack'));
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
    expect(ledger.get(key)?.state).toBe('terminal-awaiting-journal-ack');
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
    // One event short of the ceiling: the kernel's own terminal event below is what tips the buffer over,
    // so `emitProviderEvent` reports `paused: true` on the very event `stop()` will race against.
    fillToEventCeiling(ledger, key);

    const order: string[] = [];
    const closeStaged = vi.fn(() => {
      order.push('closed');
    });
    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: fakeBoundProvider({
        execute: async function* () {
          yield terminalCompleted;
        },
        openReplacement: async () => ({ hostRef: fakeHostRef(), close: closeStaged }),
      }),
    });

    const host = createSemanticOperationRuntime({ runtime, hostAuthority: fakeHostAuthority(), getProxy: () => proxy });
    await host.ensureProviderRoot(key, prepared);
    host.host.start({ key, prepared });

    // Give the pump exactly enough of a turn to emit the terminal and enter its paused wait, but no more —
    // proving the straggler was already emitted *before* stop() was ever called, not caused by it.
    await vi.waitFor(() => expect(emittedEvents).toHaveLength(1));

    order.push('stop-called');
    await host.host.stop({ key, cause: 'user_abort' });
    order.push('stop-resolved');

    // If stop() returned before the pump's own finally-block cleanup ran, 'closed' would land after
    // 'stop-resolved' instead of before it — this is the ordering guarantee the doc comment promises.
    expect(order).toEqual(['stop-called', 'closed', 'stop-resolved']);
    expect(emittedEvents).toEqual([{ key, event: terminalCompleted }]);
    expect(ledger.get(key)?.state).toBe('terminal-awaiting-journal-ack');

    // No event was emitted after stop() resolved.
    expect(emittedEvents).toHaveLength(1);

    // The one-event straggler already carried this operation to `terminal-awaiting-journal-ack` via this
    // module's own `safeTransition`. A second actor (proxy.ts's `operation.stop.v1`, racing the same natural
    // completion) attempting the very same transition afterwards is refused, not silently reapplied.
    expect(() => ledger.transition(key, 'terminal-awaiting-journal-ack')).toThrow(/does not reach/u);
  });
});

// --- paused back-pressure ------------------------------------------------------------------------------------

describe('semantic-operation runtime: paused back-pressure', () => {
  it('stops pulling from the kernel while the ledger reports paused, and resumes exactly when capacity frees', async () => {
    vi.useFakeTimers();
    const { proxy, ledger, emittedEvents } = createTestProxy();
    const key = testKey();
    const prepared = preparedFixture();
    prepareAndActivate(ledger, key, prepared);
    fillToEventCeiling(ledger, key);

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

    // Flush the first pull, the tipping emit (paused: true), and entry into the capacity-polling wait.
    await vi.advanceTimersByTimeAsync(0);
    expect(pullCount).toBe(1);
    expect(emittedEvents).toHaveLength(1);

    // One full poll tick while the ledger is still over capacity: still not pulled further.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(pullCount).toBe(1);

    // Exactly what frees capacity in production: a coordinator ack (`operation.adopt.v1` / a committed
    // `provider.event.v1` ack), acknowledging the seeded backlog.
    ledger.acknowledge(key, MAX_PROVIDER_REPLAY_EVENTS - 1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(pullCount).toBe(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(ledger.get(key)?.state).toBe('terminal-awaiting-journal-ack');
    // The terminal's own emitProviderEvent call, made once capacity was well clear, reported not-paused.
    expect(emittedEvents.at(-1)).toEqual({ key, event: terminalCompleted });
  });
});

// --- rebuildBoundProvider failure branches ------------------------------------------------------------------

describe('semantic-operation runtime: rebuildBoundProvider failure branches', () => {
  it('rejects ensureProviderRoot when the binding cannot be rehydrated', async () => {
    const { proxy } = createTestProxy();
    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: false,
      failure: { reason: 'invalid-persisted-binding', provider: 'claude' },
    });

    const host = createSemanticOperationRuntime({ runtime, hostAuthority: fakeHostAuthority(), getProxy: () => proxy });

    await expect(host.ensureProviderRoot(testKey(), preparedFixture())).rejects.toThrow(/unrehydratable binding/u);
  });

  it('rejects ensureProviderRoot when persisted continuity is not a record', async () => {
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

    await expect(host.ensureProviderRoot(testKey(), prepared)).rejects.toThrow(TypeError);
    await expect(host.ensureProviderRoot(testKey('op-2'), prepared)).rejects.toThrow(
      /non-record persisted continuity/u,
    );
  });

  it('rejects ensureProviderRoot when the rehydrated binding names a different provider than requested', async () => {
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

    await expect(host.ensureProviderRoot(testKey(), preparedFixture({ provider: 'claude' }))).rejects.toThrow(
      /rehydrated to 'codex'/u,
    );
  });

  it('rejects ensureProviderRoot when the rehydrated binding has no app-server capability', async () => {
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

    await expect(host.ensureProviderRoot(testKey(), preparedFixture())).rejects.toThrow(/no app-server capability/u);
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
});
