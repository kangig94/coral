import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

// `rebuildBoundProvider` builds a fresh registry per call via `createBuiltInProviderRegistry` and calls its
// real `rehydrateBinding`, which needs a real, persisted Claude/Codex account binding to succeed. Mocking the
// registry factory is the seam the module already exposes for this: it lets every test hand back a
// `BoundProvider` test double it fully controls (including a hand-rolled kernel) without touching the real
// provider catalog or filesystem-backed credential resolution.
const providerRegistryDouble = vi.hoisted(() => ({
  rehydrateBinding: vi.fn(),
}));
vi.mock('#src/providers/bootstrap.js', () => ({
  classifyProviderResponseServiceability: (_provider: string, fact: ProviderResponseDiagnosticFact) =>
    fact.method === 'config/read' ? (fact.response.kind === 'success' ? 'serviceable' : 'unserviceable') : 'unknown',
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
import type { ProviderResponseDiagnosticFact } from '#src/providers/host-diagnostics.js';
import { ProviderHostUnserviceableError } from '#src/providers/host-admission.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { providerRequestFailed } from '#src/providers/fault.js';
import { providerProxyEmergencyEvent } from '#src/providers/proxy-failure.js';
import type {
  BoundProvider,
  BoundProviderAppServerCapability,
  BoundProviderAppServerExecutionRuntime,
} from '#src/providers/bound-provider-contract.js';
import type {
  AppServerSession,
  HostRef,
  ProviderAppServerRuntime,
  ProviderEventBody,
  ProviderServerSpec,
} from '#src/providers/contract.js';
import { codexTurnKernel } from '#src/providers/codex/thread-kernel.js';
import { codexAppServerLifecycle } from '#src/providers/codex/provider-facets.js';
import type { CodexExecutionPlan } from '#src/providers/codex/execution-plan.js';
import {
  MAX_PROVIDER_REPLAY_EVENTS,
  MAX_PROVIDER_REPLAY_BYTES,
  MAX_PROXY_SHARED_REPLAY_BYTES,
  createOperationLedger,
  operationPrepareAttemptKey,
  type OperationLedger,
  type ProviderOperationKey,
} from '#src/provider-proxy/ledger.js';
import { ControlEndpointError } from '#src/provider-proxy/control-endpoint.js';
import type { Proxy } from '#src/provider-proxy/proxy.js';
import { ReplayAdmissionError } from '#src/provider-proxy/replay-budget.js';
import type { ControlEndpointTimer } from '#src/provider-proxy/control-endpoint.js';
import {
  PROVIDER_EVENT_METHOD,
  decodeProxyControlFrame,
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
  createProxyAppServerHostAuthority,
  specFingerprint,
  specIdentityKey,
  type ProxyAppServerHostAuthority,
} from '#src/provider-proxy/provider-root-authority.js';
import {
  SEMANTIC_OPERATION_CANCELLATION_TIMEOUT_MS,
  createSemanticOperationRuntime,
} from '#src/provider-proxy/semantic-operation-runner.js';
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
import { TEST_CODEX_PLAN } from '#tests/helpers/provider-credentials.js';

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
      cwd: fixtureCanonicalWorkDir('/workspace'),
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
  supportsInterrupt?: boolean;
  executionHostRef?: HostRef;
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
        executionRuntime.onHostRef(options.executionHostRef ?? fakeHostRef(name));
        return options.execute(executionRuntime);
      },
    }),
    appServer: {
      supportsInterrupt: options.supportsInterrupt ?? false,
      supportsProbe: false,
      openReplacement: options.openReplacement ?? (async () => ({ hostRef: fakeHostRef(name), close: vi.fn() })),
      interrupt: unreachable('appServer.interrupt') as unknown as BoundProviderAppServerCapability['interrupt'],
      probe: unreachable('appServer.probe') as unknown as BoundProviderAppServerCapability['probe'],
    },
    artifacts: { kind: 'none', reason: 'test double' },
  };
}

function fakeHostSpec(provider = 'claude'): ProviderServerSpec {
  return {
    provider,
    command: provider,
    args: ['app-server'],
    cwd: fixtureCanonicalWorkDir('/workspace'),
    leaseMode: 'job-exclusive',
  };
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
    beginOperation: () => ({
      selectCancellationMode: () => {},
      openSession: unreachable('hostAuthority.openSession') as never,
      attachSession: async () => null,
    }),
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
  const ledger = createOperationLedger<ProxyPreparedAppServerOperation>({
    encodeProxyEmergencyCompletion: ({ providerSeq, event }) => ({ providerSeq, frame: JSON.stringify(event) }),
  });
  const emittedEvents: Array<{ key: ProviderOperationKey; event: ProviderEventBody }> = [];
  const proxy: Proxy = {
    listen: async () => {},
    close: async () => {},
    ledger: () => ledger,
    emitProviderEvent: (key, event) => {
      const providerSeq = ledger.nextProviderSeq(key);
      try {
        ledger.recordEvent(
          key,
          { providerSeq, frame: JSON.stringify(event) },
          event.kind === 'terminal' || event.kind === 'suspended' ? { kind: 'completion' } : { kind: 'ordinary' },
        );
      } catch (error: unknown) {
        if (!(error instanceof ReplayAdmissionError)) throw error;
        const emergency = providerProxyEmergencyEvent({
          reason:
            event.kind === 'terminal' || event.kind === 'suspended'
              ? 'provider_completion_too_large'
              : error.scope === 'operation-events'
                ? 'provider_replay_operation_events_exhausted'
                : error.scope === 'operation-bytes'
                  ? 'provider_replay_operation_bytes_exhausted'
                  : 'provider_replay_proxy_bytes_exhausted',
        });
        ledger.recordProxyEmergencyCompletion(key, emergency, 1);
        emittedEvents.push({ key, event: emergency });
        ledger.transition(key, 'terminal-awaiting-settlement');
        return { kind: 'proxy-emergency-terminal' };
      }
      emittedEvents.push({ key, event });
      if (event.kind === 'terminal') ledger.transition(key, 'terminal-awaiting-settlement');
      if (event.kind === 'suspended') ledger.transition(key, 'suspended-awaiting-durable-decision');
      return { kind: 'recorded', providerSeq };
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
    ledger.recordEvent(key, { providerSeq: seq, frame: 'x' }, { kind: 'ordinary' });
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

function capacityFillingProgressEvent(
  operation: OperationIdentity,
  frameId: number,
  targetFrameBytes = MAX_PROVIDER_REPLAY_BYTES,
): ProviderEventBody {
  const event: ProviderEventBody = { kind: 'progress', message: '' };
  const frame = encodeProxyControlFrame({
    jsonrpc: '2.0',
    id: frameId,
    method: PROVIDER_EVENT_METHOD,
    params: providerEventRequestSchema.parse({ operation, providerSeq: 1, event }),
  });
  return { kind: 'progress', message: 'x'.repeat(targetFrameBytes - Buffer.byteLength(frame, 'utf8')) };
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
      beginOperation: () => ({
        selectCancellationMode: () => {},
        openSession: unreachable('hostAuthority.openSession'),
        attachSession: async () => null,
      }),
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
      name: 'SemanticOperationCancellationUnconfirmedError',
      code: 'semantic_operation_cancellation_unconfirmed',
      message: expect.stringContaining('Provider operation cancellation did not settle within 10000ms.'),
    });
  });
});

describe('semantic-operation runtime: capability-directed cancellation', () => {
  function sharedHostRef(): HostRef {
    return {
      provider: 'claude',
      fingerprint: 'b'.repeat(64),
      instanceId: 'shared-instance',
      leaseMode: 'job-exclusive',
      ownerJobId: 'job-1',
    };
  }

  function sharedHostAuthority() {
    const transportClosed = deferred<Error | void>();
    let rootAlive = true;
    const forceClose = vi.fn(async () => {
      rootAlive = false;
      transportClosed.resolve(new Error('shared provider root was force-closed'));
    });
    const authority: ProxyAppServerHostAuthority = {
      beginOperation: () => {
        let selected = false;
        return {
          selectCancellationMode: () => {
            if (selected) throw new Error('cancellation mode selected twice');
            selected = true;
          },
          openSession: unreachable('scope.openSession') as never,
          attachSession: async () => null,
        };
      },
      rootIdentity: () => (rootAlive ? { pid: 4_242, processStartedAtSeconds: 1_700_000_000 } : null),
      closed: () => transportClosed.promise,
      forceClose,
    };
    return { authority, forceClose, rootAlive: () => rootAlive };
  }

  it('keeps a same-host sibling usable after exact interrupt confirmation (C3-M1)', async () => {
    const { proxy, ledger, emittedEvents } = createTestProxy();
    const operationA = testKey('op-a');
    const operationB = testKey('op-b');
    const prepared = preparedFixture();
    prepareAndActivate(ledger, operationA, prepared);
    prepareAndActivate(ledger, operationB, prepared);
    const hostRef = sharedHostRef();
    const continueB = deferred();
    const shared = sharedHostAuthority();

    providerRegistryDouble.rehydrateBinding
      .mockReturnValueOnce({
        ok: true,
        value: fakeBoundProvider({
          supportsInterrupt: true,
          executionHostRef: hostRef,
          openReplacement: async () => ({ hostRef, close: vi.fn() }),
          execute: async function* (execRuntime) {
            await new Promise<void>((resolve) => {
              if (execRuntime.signal.aborted) resolve();
              else execRuntime.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            execRuntime.onProviderTurnTerminal({
              kind: 'provider-turn-terminal',
              providerTurnId: 'turn-a',
              status: 'interrupted',
            });
            yield {
              kind: 'terminal',
              terminal: { content: '', durationMs: 1, outcome: { kind: 'aborted', reason: 'signal_abort' } },
              diagnostics: {},
            };
          },
        }),
      })
      .mockReturnValueOnce({
        ok: true,
        value: fakeBoundProvider({
          supportsInterrupt: true,
          executionHostRef: hostRef,
          openReplacement: async () => ({ hostRef, close: vi.fn() }),
          execute: async function* (execRuntime) {
            yield { kind: 'progress', message: 'sibling-ready' };
            await continueB.promise;
            yield { kind: 'progress', message: 'sibling-after-cancel' };
            execRuntime.onProviderTurnTerminal({
              kind: 'provider-turn-terminal',
              providerTurnId: 'turn-b',
              status: 'completed',
            });
            yield terminalCompleted;
          },
        }),
      });

    const semantic = createSemanticOperationRuntime({
      runtime,
      hostAuthority: shared.authority,
      getProxy: () => proxy,
    });
    await semantic.ensureProviderRoot(operationA, prepared);
    await semantic.ensureProviderRoot(operationB, prepared);
    const startedA = semantic.host.start({ key: operationA, prepared });
    const startedB = semantic.host.start({ key: operationB, prepared });
    await expect(startedA.result).resolves.toEqual({ kind: 'started', hostRef });
    await expect(startedB.result).resolves.toEqual({ kind: 'started', hostRef });
    await vi.waitFor(() =>
      expect(emittedEvents.some(({ key, event }) => key === operationB && event.kind === 'progress')).toBe(true),
    );

    await semantic.host.stop({ key: operationA, cause: 'user_abort' });
    continueB.resolve();
    await vi.waitFor(() =>
      expect(
        emittedEvents.some(
          ({ key, event }) =>
            key === operationB && event.kind === 'progress' && event.message === 'sibling-after-cancel',
        ),
        'shared sibling could not complete a post-cancel operation',
      ).toBe(true),
    );

    expect(shared.rootAlive(), 'shared sibling root became null after cancelling its peer').toBe(true);
    expect(shared.forceClose).not.toHaveBeenCalled();
    await semantic.host.stop({ key: operationB, cause: 'user_abort' });
  });

  it('does not authenticate cancellation from a generic provider terminal', async () => {
    const { proxy, ledger } = createTestProxy();
    const operationA = testKey('op-a');
    const prepared = preparedFixture();
    prepareAndActivate(ledger, operationA, prepared);
    const hostRef = sharedHostRef();
    const shared = sharedHostAuthority();
    const onRelinquish = vi.fn();

    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: fakeBoundProvider({
        supportsInterrupt: true,
        executionHostRef: hostRef,
        openReplacement: async () => ({ hostRef, close: vi.fn() }),
        execute: async function* (execRuntime) {
          await new Promise<void>((resolve) => {
            if (execRuntime.signal.aborted) resolve();
            else execRuntime.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          yield {
            kind: 'terminal',
            terminal: { content: '', durationMs: 1, outcome: { kind: 'aborted', reason: 'signal_abort' } },
            diagnostics: {},
          };
        },
      }),
    });

    const semantic = createSemanticOperationRuntime({
      runtime,
      hostAuthority: shared.authority,
      getProxy: () => proxy,
      onRelinquish,
    });
    await semantic.ensureProviderRoot(operationA, prepared);
    const started = semantic.host.start({ key: operationA, prepared });
    await expect(started.result).resolves.toEqual({ kind: 'started', hostRef });

    const stopFailure = await Promise.resolve(semantic.host.stop({ key: operationA, cause: 'user_abort' })).then(
      () => null,
      (error: unknown) => error,
    );
    let siblingAdmissionFailure: unknown = null;
    try {
      void semantic.stage(testKey('op-b'), prepared).result.catch(() => {});
    } catch (error: unknown) {
      siblingAdmissionFailure = error;
    }

    expect(siblingAdmissionFailure, 'a generic terminal left the shared root admissible').toMatchObject({
      code: 'semantic_operation_admission_closed',
    });
    expect(stopFailure).toMatchObject({ code: 'semantic_operation_cancellation_unconfirmed' });
    expect(onRelinquish).toHaveBeenCalledWith(stopFailure);
    expect(shared.forceClose).not.toHaveBeenCalled();
  });

  it('closes admission and requests whole-set relinquishment after an unconfirmed interrupt (C3-M8)', async () => {
    const { proxy, ledger } = createTestProxy();
    const operationA = testKey('op-a');
    const prepared = preparedFixture();
    prepareAndActivate(ledger, operationA, prepared);
    const hostRef = sharedHostRef();
    const shared = sharedHostAuthority();
    const onRelinquish = vi.fn();
    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: fakeBoundProvider({
        supportsInterrupt: true,
        executionHostRef: hostRef,
        openReplacement: async () => ({ hostRef, close: vi.fn() }),
        execute: async function* (execRuntime) {
          await new Promise<void>((resolve) => {
            if (execRuntime.signal.aborted) resolve();
            else execRuntime.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          yield { kind: 'suspended', reason: 'interrupt_unconfirmed' };
        },
      }),
    });
    const semantic = createSemanticOperationRuntime({
      runtime,
      hostAuthority: shared.authority,
      getProxy: () => proxy,
      onRelinquish,
    });
    await semantic.ensureProviderRoot(operationA, prepared);
    const started = semantic.host.start({ key: operationA, prepared });
    await expect(started.result).resolves.toEqual({ kind: 'started', hostRef });

    const stopFailure = await Promise.resolve(semantic.host.stop({ key: operationA, cause: 'restart' })).then(
      () => null,
      (error: unknown) => error,
    );
    let siblingAdmissionFailure: unknown = null;
    try {
      void semantic.stage(testKey('op-b'), prepared).result.catch(() => {});
    } catch (error: unknown) {
      siblingAdmissionFailure = error;
    }

    expect(siblingAdmissionFailure, 'a sibling was admitted/reused on the tainted host').toMatchObject({
      code: 'semantic_operation_admission_closed',
    });
    expect(stopFailure).toMatchObject({ code: 'semantic_operation_cancellation_unconfirmed' });
    expect(onRelinquish).toHaveBeenCalledOnce();
    expect(onRelinquish).toHaveBeenCalledWith(stopFailure);
    expect(shared.forceClose).not.toHaveBeenCalled();
  });

  it('does not reuse a Codex root after a wrong-turn terminal and the interrupt deadline', async () => {
    const { proxy, ledger } = createTestProxy();
    const operationA = testKey('op-a');
    const prepared = preparedFixture({
      provider: 'codex',
      binding: { provider: 'codex', kind: 'account', binding: {} },
      request: {
        action: 'resume',
        sessionId: 'session-1',
        conversationRef: 'thread-1',
        prompt: 'hello',
        cwd: fixtureCanonicalWorkDir('/workspace'),
        bypassPermissions: false,
        coralEnv: {},
      },
      persistedContinuity: { cwd: '/workspace', threadId: 'thread-1' },
    });
    prepareAndActivate(ledger, operationA, prepared);
    const hostRef: HostRef = {
      provider: 'codex',
      fingerprint: 'b'.repeat(64),
      instanceId: 'shared-codex-instance',
      leaseMode: 'job-exclusive',
      ownerJobId: 'job-1',
    };
    const shared = sharedHostAuthority();
    const requestedDelaysMs: number[] = [];
    const kernelAbortController = new AbortController();
    const notifications: {
      handler: ((message: { method: string; params?: Record<string, unknown> }) => void) | null;
    } = { handler: null };
    const rpc = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'config/read') return { config: {} };
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress' } };
      if (method === 'turn/interrupt') return await new Promise<never>(() => {});
      throw new Error(`Unexpected Codex RPC: ${method}`);
    });
    const lease: AppServerSession = {
      rpc: rpc as AppServerSession['rpc'],
      subscribe: (handler) => {
        notifications.handler = handler;
        return () => {
          notifications.handler = null;
        };
      },
      closed: new Promise<Error | void>(() => {}),
      interrupt: (continuity) => codexAppServerLifecycle.interrupt!(lease, continuity),
    };
    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: fakeBoundProvider({
        name: 'codex',
        supportsInterrupt: true,
        executionHostRef: hostRef,
        openReplacement: async () => ({ hostRef, close: vi.fn() }),
        execute: async function* (execRuntime) {
          const codexRuntime: ProviderAppServerRuntime<CodexExecutionPlan> = {
            transport: 'app-server',
            signal: kernelAbortController.signal,
            time: {
              now: () => Date.now(),
              setTimeout: (callback, delayMs) => {
                requestedDelaysMs.push(delayMs);
                return globalThis.setTimeout(callback, 5);
              },
              clearTimeout: (handle) => {
                if (handle !== null) globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
              },
            },
            storage: execRuntime.storage,
            ...(execRuntime.env === undefined ? {} : { env: execRuntime.env }),
            ids: execRuntime.ids,
            persistedContinuity: { cwd: '/workspace', threadId: 'thread-1' },
            continuityBridge: { checkpoint: () => {}, transportClosed: () => {} },
            kbRoot: execRuntime.kbRoot,
            ...(execRuntime.coralProjects === undefined ? {} : { coralProjects: execRuntime.coralProjects }),
            ...(execRuntime.projectSource === undefined ? {} : { projectSource: execRuntime.projectSource }),
            appServerSession: lease,
            onProviderTurnTerminal: execRuntime.onProviderTurnTerminal,
            executionPlan: TEST_CODEX_PLAN,
          };
          for await (const event of codexTurnKernel(prepared.request, codexRuntime)) {
            if (event.kind === 'terminal' || event.kind === 'suspended') {
              yield event;
              return;
            }
          }
          throw new Error('Codex kernel ended without a terminal or suspended event.');
        },
      }),
    });
    const onRelinquish = vi.fn();
    const semantic = createSemanticOperationRuntime({
      runtime,
      hostAuthority: shared.authority,
      getProxy: () => proxy,
      onRelinquish,
    });
    await semantic.ensureProviderRoot(operationA, prepared);
    const started = semantic.host.start({ key: operationA, prepared });
    await expect(started.result).resolves.toEqual({ kind: 'started', hostRef });
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith('turn/start', expect.any(Object)));
    const notify = notifications.handler;
    if (notify === null) throw new Error('Codex notification handler was not installed.');
    notify({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
    });
    await Promise.resolve();

    notify({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-other', status: 'interrupted' },
      },
    });
    const stopPromise = Promise.resolve(semantic.host.stop({ key: operationA, cause: 'restart' })).then(
      () => null,
      (error: unknown) => error,
    );
    kernelAbortController.abort('restart');
    const stopFailure = await stopPromise;
    let siblingAdmissionFailure: unknown = null;
    try {
      void semantic.stage(testKey('op-b'), prepared).result.catch(() => {});
    } catch (error: unknown) {
      siblingAdmissionFailure = error;
    }

    expect(requestedDelaysMs).toContain(10_000);
    expect(siblingAdmissionFailure, 'a sibling was admitted after Codex cessation remained unconfirmed').toMatchObject({
      code: 'semantic_operation_admission_closed',
    });
    expect(stopFailure).toMatchObject({ code: 'semantic_operation_cancellation_unconfirmed' });
    expect(onRelinquish).toHaveBeenCalledOnce();
  });
});

// --- pre-consumption replay admission ------------------------------------------------------------------------

describe('semantic-operation runtime: replay admission', () => {
  it.each([
    ['ordinary execution', false],
    ['shutdown race', true],
  ] as const)(
    'turns event-count refusal into exactly one proxy-origin terminal without pulling the provider terminal (%s)',
    async (_schedule, shutdownRace) => {
      const operation = supervisedOperation(99);
      const key = { jobId: operation.jobId, operationId: operation.operationId };
      const prepared = preparedFixture();
      const gate = deferred();
      let pullCount = 0;
      const progressEvent: ProviderEventBody = { kind: 'progress', message: 'first' };
      providerRegistryDouble.rehydrateBinding.mockReturnValue({
        ok: true,
        value: fakeBoundProvider({
          execute: async function* () {
            await gate.promise;
            pullCount += 1;
            yield progressEvent;
            pullCount += 1;
            yield terminalCompleted;
          },
        }),
      });

      const proxy = {} as Proxy;
      const semantic = createSemanticOperationRuntime({
        runtime,
        hostAuthority: fakeHostAuthority(),
        getProxy: () => proxy,
      });
      const containmentReceipt = asJointContainmentReceipt('contained');
      const supervisor = new OperationSupervisor({
        host: semantic.host,
        timer: supervisorTimer,
        mintReservation: () => asReservation('40000000-0000-4000-8000-000000000001'),
        wallClockNow: () => 0,
        nowMs: () => 0,
        proxyInstanceId: operation.proxyInstanceId,
        buildSetId: operation.buildSetId,
        stageProviderRoot: (stagedKey, reserved) => ({
          result: semantic
            .ensureProviderRoot(stagedKey, reserved.prepared)
            .then((staged) =>
              staged.state !== 'staged'
                ? staged
                : { state: 'staged' as const, providerRoot: staged.providerRoot, receipt: containmentReceipt },
            ),
          confirmActivation: async () => {},
          abortAndRelease: async () => {},
        }),
        pushProviderEvent: () => {
          throw new ControlEndpointError('control_endpoint_push_no_tenancy', 'control is deliberately offline');
        },
        faultProviderEventControl: () => {},
      });
      Object.assign(proxy, {
        listen: async () => {},
        close: async () => {},
        ledger: () => supervisor.ledger(),
        emitProviderEvent: (emittedKey: ProviderOperationKey, event: ProviderEventBody) =>
          supervisor.emitProviderEvent(emittedKey, event),
      });

      const prepareRequest = {
        operation,
        hostFingerprint: 'a'.repeat(64),
        prepareAttemptNumber: 1,
        prepared,
      };
      const reservation = proxyOperationPreparePendingResultSchema.parse(
        await supervisor.prepare(operation, {
          prepareAttemptNumber: 1,
          prepareAttemptKey: operationPrepareAttemptKey(prepareRequest),
          prepared,
        }),
      );
      await supervisor.activate(operation, {
        reservation: reservation.reservation,
        jointContainmentReceipt: reservation.jointContainmentReceipt,
        jointActivationReceipt: asJointActivationReceipt('activated'),
        activationFingerprint: 'f'.repeat(64),
      });
      await supervisor.attach(operation, 0);
      await fillToEventCeiling(supervisor.ledger(), key);
      const shutdown = shutdownRace ? semantic.shutdown('queue_shutdown') : null;
      gate.resolve();

      await vi.waitFor(() => expect(pullCount).toBe(1));
      if (shutdown !== null) await expect(shutdown).resolves.toBeUndefined();
      await new Promise<void>((resolve) => setImmediate(resolve));

      const entry = supervisor.ledger().get(key);
      expect({
        state: entry?.state,
        eventCount: entry?.bufferedEvents.length,
        pullCount,
      }).toEqual({
        state: 'terminal-awaiting-settlement',
        eventCount: MAX_PROVIDER_REPLAY_EVENTS + 1,
        pullCount: 1,
      });
      const emergency = entry?.bufferedEvents.at(-1);
      if (emergency === undefined) throw new Error('Expected a proxy-emergency terminal.');
      const decoded = decodeProxyControlFrame(emergency.frame);
      if (!('params' in decoded)) throw new Error('Expected a provider event request.');
      expect(providerEventRequestSchema.parse(decoded.params)).toMatchObject({
        providerSeq: MAX_PROVIDER_REPLAY_EVENTS + 1,
        event: {
          kind: 'terminal',
          failureCause: { body: { provider: '@coral/provider-proxy' } },
        },
      });
      const terminalEvents = (entry?.bufferedEvents ?? []).filter(({ frame }) => {
        try {
          const decodedFrame = decodeProxyControlFrame(frame);
          return (
            'params' in decodedFrame && providerEventRequestSchema.parse(decodedFrame.params).event.kind === 'terminal'
          );
        } catch {
          return false;
        }
      });
      expect(terminalEvents).toHaveLength(1);
      supervisor.close();
    },
  );

  it.each([
    ['terminal', 'terminal-awaiting-settlement'],
    ['suspended', 'suspended-awaiting-durable-decision'],
    ['throw', 'terminal-awaiting-settlement'],
    ['eof', 'terminal-awaiting-settlement'],
  ] as const)(
    'admits a fifth %s completion while four ordinary frames retain the full shared budget',
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
        emitProviderEvent: (key, event) => supervisor.emitProviderEvent(key, event),
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
                  staged.state !== 'staged'
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
        pushProviderEvent: () => {
          throw new ControlEndpointError('control_endpoint_push_no_tenancy', 'control is deliberately offline');
        },
        faultProviderEventControl: () => {},
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
          const targetFrameBytes =
            index < 3 ? MAX_PROVIDER_REPLAY_BYTES : MAX_PROXY_SHARED_REPLAY_BYTES - 3 * MAX_PROVIDER_REPLAY_BYTES;
          supervisor.emitProviderEvent(holder, capacityFillingProgressEvent(holder, index + 1, targetFrameBytes));
          expect(supervisor.ledger().get(holder)?.bufferedBytes).toBe(targetFrameBytes);
        }

        const targetPreparation = prepared.get(target);
        if (targetPreparation === undefined) throw new Error('missing target preparation');
        await activate(target, targetPreparation);
        await vi.waitFor(() => expect(pullCount).toBe(1));
        for (const holder of holders) {
          expect(supervisor.ledger().get(holder)).toMatchObject({
            state: 'executing',
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

  it('returns an exact terminal provider-host refusal when fresh placement is blocked', async () => {
    const { proxy } = createTestProxy();
    const hostRef = fakeHostRef('codex');
    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: fakeBoundProvider({
        name: 'codex',
        execute: unreachable('execute') as unknown as (
          runtime: BoundProviderAppServerExecutionRuntime,
        ) => AsyncIterable<ProviderEventBody>,
        openReplacement: async () => {
          throw new ProviderHostUnserviceableError(hostRef);
        },
      }),
    });
    const host = createSemanticOperationRuntime({ runtime, hostAuthority: fakeHostAuthority(), getProxy: () => proxy });

    await expect(host.ensureProviderRoot(testKey(), preparedFixture({ provider: 'codex' }))).resolves.toEqual({
      state: 'permanent-refusal',
      code: 'provider_host_unserviceable',
      disposition: 'terminal-failure',
      reason: `Provider host ${hostRef.provider}/${hostRef.instanceId} is unserviceable; evict that exact host before retrying fresh placement.`,
      hostRef,
      remediation: {
        action: 'evict-provider-host',
        command: 'coral backend provider-host evict <host-ref>',
      },
    });
  });
});

// --- createProxyAppServerHostAuthority: the host pool -----------------------------------------------------

function fakeProviderServerHandle(options?: { pid?: number }): {
  handle: ProviderServerHandle;
  closeMock: ReturnType<typeof vi.fn>;
  resolveClosed(): void;
} {
  const closed = deferred<Error | void>();
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
    closePromise: closed.promise,
    isClosed: () => false,
    inspectDiagnostics: () => ({
      hostLog: { entries: [], retainedBytes: 0, truncatedBeforeSeq: 0 },
      completedObservations: [],
      factsTruncatedBeforeSeq: 0,
    }),
    markExpectedClose: vi.fn(),
    close: closeMock,
  };
  return { handle, closeMock, resolveClosed: () => closed.resolve() };
}

function rejectedConfigRead(generation: number): ProviderResponseDiagnosticFact {
  return {
    factSeq: 1,
    generation,
    requestId: 1,
    method: 'config/read',
    response: {
      kind: 'failure',
      rpcCode: -32_603,
      providerMessage: 'fixture rejection',
      providerData: { cause: 'fixture' },
    },
    hostLog: { startSeq: 1, endSeq: 2 },
  };
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

function selectedHostScope(
  authority: ProxyAppServerHostAuthority,
  key: ProviderOperationKey,
  mode: 'shared-acknowledged-interrupt' | 'operation-isolated',
) {
  const scope = authority.beginOperation(key);
  scope.selectCancellationMode(mode);
  return scope;
}

describe('semantic-operation: createProxyAppServerHostAuthority (host pool)', () => {
  it('pools a shared spec by executable identity alone, spawning once and reusing it', async () => {
    const server = fakeProviderServerHandle();
    vi.mocked(spawnProviderServerTransport).mockResolvedValueOnce(server.handle);
    const authority = createProxyAppServerHostAuthority(runtime);
    const spec = sharedSpec();
    const firstScope = selectedHostScope(
      authority,
      { jobId: 'job-a', operationId: 'op-a' },
      'shared-acknowledged-interrupt',
    );
    const secondScope = selectedHostScope(
      authority,
      { jobId: 'job-b', operationId: 'op-b' },
      'shared-acknowledged-interrupt',
    );

    const first = await firstScope.openSession(spec);
    const second = await secondScope.openSession(spec);

    expect(spawnProviderServerTransport).toHaveBeenCalledTimes(1);
    expect(first.hostRef.instanceId).toBe(second.hostRef.instanceId);
    first.close();
    second.close();
  });

  it('refuses fresh work on a blocked proxy host while exact attachment remains available', async () => {
    const first = fakeProviderServerHandle();
    const second = fakeProviderServerHandle({ pid: 1_001 });
    first.handle.inspectDiagnostics = () => ({
      hostLog: { entries: [], retainedBytes: 0, truncatedBeforeSeq: 7 },
      completedObservations: [],
      factsTruncatedBeforeSeq: 12,
    });
    vi.mocked(spawnProviderServerTransport).mockResolvedValueOnce(first.handle).mockResolvedValueOnce(second.handle);
    const authority = createProxyAppServerHostAuthority(runtime);
    const hostSpec = sharedSpec({ provider: 'codex' });
    const scope = selectedHostScope(authority, testKey(), 'shared-acknowledged-interrupt');
    const opened = await scope.openSession(hostSpec);
    const firstSpawn = vi.mocked(spawnProviderServerTransport).mock.calls[0]?.[0];
    firstSpawn?.observeProviderResponse(rejectedConfigRead(0));

    const attached = await scope.attachSession(opened.hostRef, { spec: hostSpec, jobId: 'attached-job' });
    await expect(attached?.session.rpc('interrupt', {})).resolves.toEqual({});
    await expect(scope.openSession(hostSpec)).rejects.toMatchObject({
      code: 'provider_host_unserviceable',
      hostRef: opened.hostRef,
      remediation: { action: 'evict-provider-host' },
    });
    expect(spawnProviderServerTransport).toHaveBeenCalledOnce();

    first.resolveClosed();
    await vi.waitFor(() =>
      expect(authority.admissionSnapshot().state.values().next().value?.phase).toBe('retired-blocked'),
    );
    expect(authority.admissionSnapshot().tombstones[0]).toMatchObject({
      ref: opened.hostRef,
      spec: { cwd: hostSpec.cwd },
      retirement: { status: 'retired', processAbsent: true },
      diagnostics: {
        hostLog: { truncatedBeforeSeq: 7 },
        factsTruncatedBeforeSeq: 12,
      },
    });
    await expect(scope.openSession(hostSpec)).rejects.toMatchObject({ code: 'provider_host_unserviceable' });

    expect(authority.confirmEvicted({ ...opened.hostRef, instanceId: 'stale-instance' })).toBe(false);
    expect(authority.confirmEvicted(opened.hostRef)).toBe(true);
    const replacement = await scope.openSession(hostSpec);
    expect(replacement.hostRef.instanceId).not.toBe(opened.hostRef.instanceId);
    expect(spawnProviderServerTransport).toHaveBeenCalledTimes(2);

    firstSpawn?.observeProviderResponse(rejectedConfigRead(1));
    expect(authority.admissionSnapshot().state.values().next().value).toMatchObject({
      ref: replacement.hostRef,
      generation: 1,
      phase: 'live',
    });

    attached?.close();
    opened.close();
    replacement.close();
  });

  it('keeps operation-isolated admission keyed by operation identity', async () => {
    const first = fakeProviderServerHandle();
    const second = fakeProviderServerHandle({ pid: 1_001 });
    vi.mocked(spawnProviderServerTransport).mockResolvedValueOnce(first.handle).mockResolvedValueOnce(second.handle);
    const authority = createProxyAppServerHostAuthority(runtime);
    const hostSpec = exclusiveSpec();
    const firstScope = selectedHostScope(
      authority,
      { jobId: 'job-a', operationId: 'operation-a' },
      'operation-isolated',
    );
    const opened = await firstScope.openSession(hostSpec, { jobId: 'job-a' });
    vi.mocked(spawnProviderServerTransport).mock.calls[0]?.[0].observeProviderResponse(rejectedConfigRead(0));
    first.resolveClosed();
    await vi.waitFor(() => expect(authority.admissionSnapshot().tombstones).toHaveLength(1));

    const secondScope = selectedHostScope(
      authority,
      { jobId: 'job-a', operationId: 'operation-b' },
      'operation-isolated',
    );
    const otherOperation = await secondScope.openSession(hostSpec, { jobId: 'job-a' });
    expect(otherOperation.hostRef.instanceId).not.toBe(opened.hostRef.instanceId);
    expect(authority.admissionSnapshot().state.size).toBe(2);
    expect(spawnProviderServerTransport).toHaveBeenCalledTimes(2);

    opened.close();
    otherOperation.close();
  });

  it('refuses a concurrent second isolated root and reuses the token after the first closes (C3-M7)', async () => {
    const jobA = fakeProviderServerHandle();
    const jobB = fakeProviderServerHandle();
    vi.mocked(spawnProviderServerTransport).mockResolvedValueOnce(jobA.handle).mockResolvedValueOnce(jobB.handle);
    const authority = createProxyAppServerHostAuthority(runtime);
    const spec = exclusiveSpec();

    const forJobA = await selectedHostScope(
      authority,
      { jobId: 'job-a', operationId: 'op-a' },
      'operation-isolated',
    ).openSession(spec, { jobId: 'job-a' });
    const jobBScope = selectedHostScope(authority, { jobId: 'job-b', operationId: 'op-b' }, 'operation-isolated');
    const concurrentFailure = await jobBScope.openSession(spec, { jobId: 'job-b' }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(concurrentFailure, 'a second isolated root spawned while set A already held one').toMatchObject({
      code: 'provider_root_live_capacity',
    });
    expect(spawnProviderServerTransport).toHaveBeenCalledOnce();
    forJobA.close();
    await vi.waitFor(() => expect(jobA.closeMock).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));
    const forJobB = await jobBScope.openSession(spec, { jobId: 'job-b' });
    expect(spawnProviderServerTransport).toHaveBeenCalledTimes(2);
    forJobB.close();
  });

  it('reuses one job-exclusive entry across repeated stage-then-activate calls for the same job', async () => {
    const server = fakeProviderServerHandle();
    vi.mocked(spawnProviderServerTransport).mockResolvedValueOnce(server.handle);
    const authority = createProxyAppServerHostAuthority(runtime);
    const spec = exclusiveSpec();
    const scope = selectedHostScope(
      authority,
      { jobId: 'job-a', operationId: 'op-a' },
      'shared-acknowledged-interrupt',
    );

    const first = await scope.openSession(spec, { jobId: 'job-a' });
    const second = await scope.openSession(spec, { jobId: 'job-a' });

    expect(spawnProviderServerTransport).toHaveBeenCalledTimes(1);
    expect(first.hostRef.instanceId).toBe(second.hostRef.instanceId);
    first.close();
    second.close();
  });

  it('refuses a job-exclusive acquisition with no job id before ever spawning', async () => {
    const authority = createProxyAppServerHostAuthority(runtime);
    const scope = selectedHostScope(authority, testKey(), 'shared-acknowledged-interrupt');

    await expect(scope.openSession(exclusiveSpec())).rejects.toThrow('provider_host_policy_invalid');
    expect(spawnProviderServerTransport).not.toHaveBeenCalled();
  });

  it('does not close the pooled process while another operation still references it', async () => {
    const server = fakeProviderServerHandle();
    vi.mocked(spawnProviderServerTransport).mockResolvedValueOnce(server.handle);
    const authority = createProxyAppServerHostAuthority(runtime);
    const spec = sharedSpec();
    const firstScope = selectedHostScope(
      authority,
      { jobId: 'job-a', operationId: 'op-a' },
      'shared-acknowledged-interrupt',
    );
    const secondScope = selectedHostScope(
      authority,
      { jobId: 'job-b', operationId: 'op-b' },
      'shared-acknowledged-interrupt',
    );

    const first = await firstScope.openSession(spec);
    const second = await secondScope.openSession(spec);

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
    const scope = selectedHostScope(authority, testKey(), 'shared-acknowledged-interrupt');
    const opened = await scope.openSession(spec);

    const attached = await scope.attachSession(opened.hostRef, { spec, jobId: 'shared-attachment' });
    expect(attached).not.toBeNull();
    attached?.close();

    const wrongFingerprint = await scope.attachSession(
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
    const opened = await selectedHostScope(authority, testKey(), 'shared-acknowledged-interrupt').openSession(
      sharedSpec(),
    );

    expect(authority.rootIdentity(opened.hostRef)).toEqual({ pid: 4_242, processStartedAtSeconds: 1_700_000_000 });

    opened.close();
    expect(authority.rootIdentity(opened.hostRef)).toBeNull();
  });

  it('force-closes an isolated matching entry immediately without waiting for its references', async () => {
    const server = fakeProviderServerHandle();
    vi.mocked(spawnProviderServerTransport).mockResolvedValueOnce(server.handle);
    const authority = createProxyAppServerHostAuthority(runtime);
    const scope = selectedHostScope(authority, testKey(), 'operation-isolated');
    const opened = await scope.openSession(sharedSpec());
    const attached = await scope.attachSession(opened.hostRef, {
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

  it('prohibits force-closing a shared operation scope', async () => {
    const server = fakeProviderServerHandle();
    vi.mocked(spawnProviderServerTransport).mockResolvedValueOnce(server.handle);
    const authority = createProxyAppServerHostAuthority(runtime);
    const opened = await selectedHostScope(authority, testKey(), 'shared-acknowledged-interrupt').openSession(
      sharedSpec(),
    );

    await expect(authority.forceClose(opened.hostRef)).rejects.toThrow(
      'provider_host_scope_shared_force_close_forbidden',
    );
    expect(authority.rootIdentity(opened.hostRef)).not.toBeNull();
    expect(server.closeMock).not.toHaveBeenCalled();
    opened.close();
  });

  it('requires one cancellation-mode selection before acquisition', async () => {
    const authority = createProxyAppServerHostAuthority(runtime);
    const scope = authority.beginOperation(testKey());

    expect(() => scope.openSession(sharedSpec())).toThrow('provider_host_scope_unselected');
    scope.selectCancellationMode('shared-acknowledged-interrupt');
    expect(() => scope.selectCancellationMode('operation-isolated')).toThrow('provider_host_scope_already_selected');
    expect(spawnProviderServerTransport).not.toHaveBeenCalled();
  });

  it('latches generation draining after 127 sequential distinct isolated roots', async () => {
    let nextPid = 10_000;
    const closeMocks: Array<ReturnType<typeof vi.fn>> = [];
    vi.mocked(spawnProviderServerTransport).mockImplementation(async () => {
      const server = fakeProviderServerHandle({ pid: nextPid++ });
      closeMocks.push(server.closeMock);
      return server.handle;
    });
    const authority = createProxyAppServerHostAuthority(runtime);
    const spec = exclusiveSpec();
    const roots = new Set<string>();

    for (let index = 0; index < 127; index += 1) {
      const key = { jobId: `job-${index}`, operationId: `op-${index}` };
      const scope = selectedHostScope(authority, key, 'operation-isolated');
      const opened = await scope.openSession(spec, { jobId: key.jobId });
      const root = authority.rootIdentity(opened.hostRef);
      if (root === null) throw new Error('new isolated root was not live');
      roots.add(`${root.pid}@${root.processStartedAtSeconds}`);
      opened.close();
      await vi.waitFor(() => expect(closeMocks[index]).toHaveBeenCalledOnce());
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const refused = await selectedHostScope(
      authority,
      { jobId: 'job-127', operationId: 'op-127' },
      'operation-isolated',
    )
      .openSession(spec, { jobId: 'job-127' })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(roots.size).toBe(127);
    expect(refused).toMatchObject({ code: 'provider_root_generation_draining' });
    expect(spawnProviderServerTransport).toHaveBeenCalledTimes(127);
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
      cwd: fixtureCanonicalWorkDir('/workspace'),
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
