import { EventEmitter } from 'node:events';

import { testIncarnation } from '#tests/helpers/process-incarnation.js';
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

import {
  spawnProviderServerTransport,
  type ProviderServerFailedSpawnCleanupDisposition,
  type ProviderServerHandle,
} from '#src/providers/app-server-transport.js';
import type { ProviderResponseDiagnosticFact } from '#src/providers/host-diagnostics.js';
import { ProviderHostUnserviceableError } from '#src/providers/host-admission.js';
import { encodeHostRef } from '#src/providers/host-ref-codec.js';
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
  ProviderTurnTerminalEvidence,
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
import { controlExchangeForTest } from '#src/provider-proxy/control-client.js';
import { createProxyGuardianContainment } from '#src/provider-proxy/role-main.js';
import type { Proxy } from '#src/provider-proxy/proxy.js';
import { ReplayAdmissionError } from '#src/provider-proxy/replay-budget.js';
import type { ControlEndpointTimer } from '#src/provider-proxy/control-endpoint.js';
import {
  PROVIDER_EVENT_METHOD,
  decodeProxyControlFrame,
  encodeProxyControlFrame,
  providerEventRequestSchema,
  providerHostListResultV1Schema,
  providerHostListResultV2Schema,
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

const realRuntime = createRealRuntime('prod');
const readProcessIncarnation = vi.fn(() => testIncarnation(1_700_000_000));
const runtime: Runtime = {
  ...realRuntime,
  process: { ...realRuntime.process, readProcessIncarnation },
};

beforeEach(() => {
  // `spawnProviderServerTransport` and `rehydrateBinding` are plain `vi.fn()`s created inside a `vi.mock()`
  // factory, not `vi.spyOn` spies — `vi.restoreAllMocks()` below does not touch them, so each test resets its
  // own queued `mockResolvedValueOnce`/`mockReturnValue` state explicitly rather than leaking into the next.
  vi.mocked(spawnProviderServerTransport).mockReset();
  providerRegistryDouble.rehydrateBinding.mockReset();
  readProcessIncarnation.mockReset().mockReturnValue(testIncarnation(1_700_000_000));
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
    rootIdentity: () => ({ pid: 4242, incarnation: testIncarnation(1_700_000_000) }),
    closed: () => new Promise<Error | void>(() => {}),
    forceClose: async () => undefined,
    evictHost: async () => ({ kind: 'stale' as const }),
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
  ledger.recordPreparation(key, { pid: 1, incarnation: testIncarnation(1) }, asJointContainmentReceipt('contained'));
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

    expect(emittedEvents).toHaveLength(2);

    // The synthesized abort already carried this operation to `terminal-awaiting-settlement`; the control
    // handler racing the same stop must be refused rather than silently reapplying the transition.
    expect(() => ledger.transition(key, 'terminal-awaiting-settlement')).toThrow(/does not reach/u);
  });
});

describe('semantic-operation runtime: bounded cancellation', () => {
  it('observes deadline expiry when the kernel throws before its first wait', async () => {
    vi.useFakeTimers();
    const { proxy, ledger } = createTestProxy();
    const key = testKey();
    const prepared = preparedFixture();
    prepareAndActivate(ledger, key, prepared);
    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: fakeBoundProvider({
        execute: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => {
              throw new Error('synchronous kernel failure');
            },
          }),
        }),
      }),
    });
    const hostAuthority = {
      ...fakeHostAuthority(),
      forceClose: () => new Promise<never>(() => {}),
    };
    const semantic = createSemanticOperationRuntime({ runtime, hostAuthority, getProxy: () => proxy });
    await semantic.ensureProviderRoot(key, prepared);
    await semantic.host.start({ key, prepared }).result;
    await vi.advanceTimersByTimeAsync(0);
    const stopped = Promise.resolve(semantic.host.stop({ key, cause: 'user_abort' })).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(SEMANTIC_OPERATION_CANCELLATION_TIMEOUT_MS);
    expect(await stopped).toMatchObject({ code: 'semantic_operation_cancellation_unconfirmed' });
  });

  it('does not request another kernel event after the cancellation deadline', async () => {
    vi.useFakeTimers();
    const { proxy, ledger, emittedEvents } = createTestProxy();
    const key = testKey('late-tail');
    const prepared = preparedFixture();
    prepareAndActivate(ledger, key, prepared);
    const late = deferred();
    const never = deferred();
    const closeStaged = vi.fn();
    const hostAuthority = { ...fakeHostAuthority(), forceClose: vi.fn() };
    let drained = 0;
    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: fakeBoundProvider({
        supportsInterrupt: true,
        openReplacement: async () => ({ hostRef: fakeHostRef(), close: closeStaged }),
        execute: async function* () {
          yield { kind: 'progress', message: 'ready' };
          await late.promise;
          drained += 1;
          yield { kind: 'progress', message: 'late-1' };
          drained += 1;
          yield { kind: 'progress', message: 'late-2' };
          await never.promise;
        },
      }),
    });
    const semantic = createSemanticOperationRuntime({ runtime, hostAuthority, getProxy: () => proxy });
    await semantic.ensureProviderRoot(key, prepared);
    await semantic.host.start({ key, prepared }).result;
    await vi.advanceTimersByTimeAsync(0);
    const stopped = Promise.resolve(semantic.host.stop({ key, cause: 'user_abort' })).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(SEMANTIC_OPERATION_CANCELLATION_TIMEOUT_MS + 1);
    expect(await stopped).toMatchObject({ code: 'semantic_operation_cancellation_unconfirmed' });
    const eventsAtDeadline = emittedEvents.length;

    late.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(1);
    expect(emittedEvents).toHaveLength(eventsAtDeadline);
    expect(closeStaged).not.toHaveBeenCalled();
    expect(hostAuthority.forceClose).not.toHaveBeenCalled();
    await expect(semantic.shutdown('signal_abort')).rejects.toMatchObject({
      code: 'semantic_operation_shutdown_incomplete',
    });
  });

  it('force-closes the tracked host and lets transport closure settle a pull that ignores abort', async () => {
    const { proxy, ledger } = createTestProxy();
    const key = testKey();
    const prepared = preparedFixture();
    prepareAndActivate(ledger, key, prepared);
    const closeStaged = vi.fn();
    const transportClosed = deferred<Error | void>();
    const forceClose = vi.fn(async () => {
      transportClosed.resolve();
      return undefined;
    });
    const hostAuthority = {
      beginOperation: () => ({
        selectCancellationMode: () => {},
        openSession: unreachable('hostAuthority.openSession'),
        attachSession: async () => null,
      }),
      rootIdentity: () => ({ pid: 4242, incarnation: testIncarnation(1_700_000_000) }),
      closed: () => transportClosed.promise,
      forceClose,
      evictHost: async () => ({ kind: 'stale' as const }),
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

  it('keeps isolated cancellation held when root cleanup remains alive', async () => {
    const { proxy, ledger } = createTestProxy();
    const key = testKey();
    const prepared = preparedFixture();
    prepareAndActivate(ledger, key, prepared);
    const closeStaged = vi.fn();
    const settled = new Promise<void>(() => undefined);
    const operatorExit = {
      kind: 'abandon-provider-host-acquisition' as const,
      abandon: vi.fn(async () => ({
        kind: 'operator-abandoned' as const,
        subject: { kind: 'process' as const, pid: 4_242 },
        processAbsenceProven: false as const,
        successor: { owner: 'operator-command' as const, acceptance: 'accepted' as const },
      })),
    };
    const retry = vi.fn();
    const forceClose = vi.fn(async () => ({
      kind: 'held-alive' as const,
      subject: { kind: 'process' as const, pid: 4_242 },
      observation: 'alive' as const,
      operatorExit,
      settled,
      retry,
      successor: {
        kind: 'accepted' as const,
        owner: 'provider-proxy-root-pool' as const,
        settlement: settled,
      },
    }));
    const hostAuthority = {
      beginOperation: () => ({
        selectCancellationMode: () => {},
        openSession: unreachable('hostAuthority.openSession'),
        attachSession: async () => null,
      }),
      rootIdentity: () => ({ pid: 4_242, incarnation: testIncarnation(1_700_000_000) }),
      closed: () => new Promise<Error | void>(() => undefined),
      forceClose,
      evictHost: async () => ({ kind: 'stale' as const }),
    } as ProxyAppServerHostAuthority;
    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: fakeBoundProvider({
        execute: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise<IteratorResult<ProviderEventBody>>(() => undefined),
          }),
        }),
        openReplacement: async () => ({ hostRef: fakeHostRef(), close: closeStaged }),
      }),
    });
    const semantic = createSemanticOperationRuntime({ runtime, hostAuthority, getProxy: () => proxy });
    await semantic.ensureProviderRoot(key, prepared);
    const start = semantic.host.start({ key, prepared });
    await expect(start.result).resolves.toEqual({ kind: 'started', hostRef: fakeHostRef() });

    await expect(Promise.resolve(semantic.host.stop({ key, cause: 'user_abort' }))).rejects.toMatchObject({
      name: 'SemanticOperationCancellationUnconfirmedError',
      code: 'semantic_operation_cancellation_unconfirmed',
      message: expect.stringContaining('process:alive'),
    });

    expect(forceClose).toHaveBeenCalledOnce();
    expect(closeStaged).not.toHaveBeenCalled();
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
      return undefined;
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
      rootIdentity: () => (rootAlive ? { pid: 4_242, incarnation: testIncarnation(1_700_000_000) } : null),
      closed: () => transportClosed.promise,
      forceClose,
      evictHost: async () => ({ kind: 'stale' as const }),
    };
    return { authority, forceClose, rootAlive: () => rootAlive };
  }

  it.each(['notification', 'start-response', 'final-answer'] as const)(
    'releases a normally completed real Codex kernel without cancellation refusal (%s)',
    async (path) => {
      const { proxy, ledger, emittedEvents } = createTestProxy();
      const operation = testKey('normal-completion');
      const prepared = preparedFixture({
        provider: 'codex',
        binding: { provider: 'codex', kind: 'account', binding: {} },
      });
      prepareAndActivate(ledger, operation, prepared);
      const shared = sharedHostAuthority();
      const hostRef = { ...sharedHostRef(), provider: 'codex' };
      const notifications = new Set<(message: { method: string; params?: Record<string, unknown> }) => void>();
      const rpc = vi.fn(async (method: string) => {
        if (method === 'config/read') return { config: {} };
        if (method === 'model/list') return { data: [], nextCursor: null };
        if (method === 'thread/start') return { thread: { id: 'thread-normal' } };
        if (method === 'turn/start')
          return { turn: { id: 'turn-normal', status: path === 'start-response' ? 'completed' : 'inProgress' } };
        throw new Error(`Unexpected Codex RPC: ${method}`);
      });
      const lease: AppServerSession = {
        rpc: rpc as AppServerSession['rpc'],
        subscribe: (handler) => {
          notifications.add(handler);
          return () => {
            notifications.delete(handler);
          };
        },
        closed: new Promise(() => {}),
        interrupt: async (continuity) => {
          if (path === 'final-answer') {
            expect(continuity).toEqual({ threadId: 'thread-normal', turnId: 'turn-normal' });
            return { kind: 'accepted' };
          }
          throw new Error('A completed turn must not be interrupted');
        },
      };
      providerRegistryDouble.rehydrateBinding.mockReturnValue({
        ok: true,
        value: fakeBoundProvider({
          name: 'codex',
          supportsInterrupt: true,
          executionHostRef: hostRef,
          openReplacement: async () => ({ hostRef, close: vi.fn() }),
          execute: (execRuntime) =>
            codexTurnKernel(prepared.request, {
              ...execRuntime,
              transport: 'app-server',
              appServerSession: lease,
              persistedContinuity: undefined,
              continuityBridge: { checkpoint: () => {}, transportClosed: () => {} },
              executionPlan: TEST_CODEX_PLAN,
            }),
        }),
      });
      const onRelinquish = vi.fn();
      const semantic = createSemanticOperationRuntime({
        runtime,
        hostAuthority: shared.authority,
        getProxy: () => proxy,
        onRelinquish,
      });
      const stage = semantic.stage(operation, prepared);
      await stage.result;
      const start = semantic.host.start({ key: operation, prepared });
      await start.result;
      await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith('turn/start', expect.any(Object)));
      const emit = (message: { method: string; params?: Record<string, unknown> }) => {
        if (notifications.size === 0) throw new Error('Kernel lost its subscription');
        for (const notification of notifications) notification(message);
      };
      if (path === 'final-answer') {
        emit({
          method: 'item/completed',
          params: {
            threadId: 'thread-normal',
            turnId: 'turn-normal',
            item: { type: 'agentMessage', text: 'done', phase: 'final_answer' },
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(emittedEvents.some(({ event }) => event.kind === 'terminal')).toBe(true);
        expect(emittedEvents.at(-1)?.event).toMatchObject({
          terminal: { content: 'done', outcome: { kind: 'completed' } },
        });
      }
      if (path !== 'start-response')
        emit({
          method: 'turn/completed',
          params: { threadId: 'thread-normal', turn: { id: 'turn-normal', status: 'completed' } },
        });
      await vi.waitFor(() => expect(emittedEvents.some(({ event }) => event.kind === 'terminal')).toBe(true));
      await expect(Promise.all([start.abortAndRelease(), stage.abortAndRelease()])).resolves.toEqual([
        undefined,
        undefined,
      ]);
      expect(onRelinquish).not.toHaveBeenCalled();
      expect(shared.forceClose).not.toHaveBeenCalled();
    },
  );

  it.each([
    { recovery: false, completion: 'inferred', action: 'release' },
    { recovery: true, completion: 'inferred', action: 'release' },
    { recovery: true, completion: 'inferred', action: 'abort' },
    { recovery: true, completion: 'start-failure', action: 'release' },
    { recovery: true, completion: 'start-failure', action: 'abort' },
  ])(
    'requires the current Codex turn: recovery=$recovery, $completion, $action',
    async ({ recovery, completion, action }) => {
      vi.useFakeTimers();
      const { proxy, ledger, emittedEvents } = createTestProxy();
      const operation = testKey('current-turn');
      const prepared = preparedFixture({
        provider: 'codex',
        binding: { provider: 'codex', kind: 'account', binding: {} },
      });
      prepareAndActivate(ledger, operation, prepared);
      const shared = sharedHostAuthority();
      const hostRef = { ...sharedHostRef(), provider: 'codex' };
      const close = vi.fn();
      const notifications = new Set<(message: { method: string; params?: Record<string, unknown> }) => void>();
      let starts = 0;
      const rpc = vi.fn(async (method: string) => {
        if (method === 'config/read') return { config: {} };
        if (method === 'model/list') return { data: [], nextCursor: null };
        if (method === 'thread/start') return { thread: { id: 'thread-current' } };
        if (method === 'turn/start') {
          starts += 1;
          if (completion === 'start-failure' && starts === 2) throw new Error('replacement start unavailable');
          return {
            turn:
              recovery && starts === 1
                ? {
                    id: 'turn-retired',
                    status: 'failed',
                    error: { message: 'capacity', codexErrorInfo: 'serverOverloaded' },
                  }
                : { id: 'turn-current', status: 'inProgress' },
          };
        }
        if (method === 'thread/read') throw new Error('state unavailable');
        throw new Error(`Unexpected Codex RPC: ${method}`);
      });
      const lease: AppServerSession = {
        rpc: rpc as AppServerSession['rpc'],
        subscribe: (handler) => {
          notifications.add(handler);
          return () => {
            notifications.delete(handler);
          };
        },
        closed: new Promise(() => {}),
        interrupt: vi.fn(async () => {
          throw new Error('No active turn was observed');
        }),
      };
      providerRegistryDouble.rehydrateBinding.mockReturnValue({
        ok: true,
        value: fakeBoundProvider({
          name: 'codex',
          supportsInterrupt: true,
          executionHostRef: hostRef,
          openReplacement: async () => ({ hostRef, close }),
          execute: (execRuntime) =>
            codexTurnKernel(prepared.request, {
              ...execRuntime,
              transport: 'app-server',
              appServerSession: lease,
              persistedContinuity: undefined,
              continuityBridge: { checkpoint: () => {}, transportClosed: () => {} },
              executionPlan: TEST_CODEX_PLAN,
            }),
        }),
      });
      const semantic = createSemanticOperationRuntime({
        runtime,
        hostAuthority: shared.authority,
        getProxy: () => proxy,
      });
      const stage = semantic.stage(operation, prepared);
      await stage.result;
      const start = semantic.host.start({ key: operation, prepared });
      await start.result;
      await vi.advanceTimersByTimeAsync(0);
      expect(starts).toBe(recovery ? 2 : 1);
      const cancel = () =>
        action === 'abort' ? semantic.host.stop({ key: operation, cause: 'user_abort' }) : start.abortAndRelease();
      if (completion === 'start-failure') {
        expect(emittedEvents.at(-1)?.event).toMatchObject({ terminal: { outcome: { kind: 'provider_exit' } } });
        await expect(cancel()).rejects.toMatchObject({ code: 'semantic_operation_cancellation_unconfirmed' });
        expect(shared.forceClose).not.toHaveBeenCalled();
        return;
      }
      for (const notify of notifications)
        notify({
          method: 'item/completed',
          params: {
            threadId: 'thread-current',
            turnId: 'turn-current',
            item: { type: 'agentMessage', text: 'done', phase: 'final_answer' },
          },
        });
      await vi.advanceTimersByTimeAsync(250);
      expect(emittedEvents.at(-1)?.event).toMatchObject({
        terminal: { content: 'done', outcome: { kind: 'completed' } },
      });
      const release = Promise.resolve(cancel()).then(
        () => null,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await release).toMatchObject({ code: 'semantic_operation_cancellation_unconfirmed' });
      expect(rpc.mock.calls.some(([method]) => method === 'thread/read')).toBe(true);
      expect(close).not.toHaveBeenCalled();
      for (const notify of notifications)
        notify({
          method: 'turn/completed',
          params: {
            threadId: 'thread-current',
            turn: { id: 'turn-retired', status: 'completed' },
          },
        });
      const wrongTurnRelease = stage.abortAndRelease().then(
        () => null,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await wrongTurnRelease).toMatchObject({ code: 'semantic_operation_cancellation_unconfirmed' });
      for (const notify of notifications)
        notify({
          method: 'turn/completed',
          params: {
            threadId: 'thread-current',
            turn: { id: 'turn-current', status: 'completed' },
          },
        });
      await expect(Promise.all([start.abortAndRelease(), stage.abortAndRelease()])).resolves.toEqual([
        undefined,
        undefined,
      ]);
      await start.abortAndRelease();
      expect(close).toHaveBeenCalledOnce();
      expect(shared.forceClose).not.toHaveBeenCalled();
      expect(lease.interrupt).not.toHaveBeenCalled();
      expect(emittedEvents.filter(({ event }) => event.kind === 'terminal')).toHaveLength(1);
    },
  );

  it.each(
    [false, true].flatMap((recovery) =>
      ['exact', 'throw-after-exact', 'retired', 'none'].map((confirmation) => ({ recovery, confirmation })),
    ),
  )('settles active real Codex aborts: recovery=$recovery, $confirmation', async ({ recovery, confirmation }) => {
    vi.useFakeTimers();
    const operationA = supervisedOperation(81);
    const operationB = supervisedOperation(82);
    const prepared = preparedFixture({
      provider: 'codex',
      binding: { provider: 'codex', kind: 'account', binding: {} },
    });
    const shared = sharedHostAuthority();
    const hostRef = { ...sharedHostRef(), provider: 'codex' };
    const closeA = vi.fn();
    const evidence: ProviderTurnTerminalEvidence[] = [];
    const events: Array<{ key: ProviderOperationKey; event: ProviderEventBody }> = [];
    const notifications = new Map<
      string,
      Set<(message: { method: string; params?: Record<string, unknown> }) => void>
    >();
    let siblingSignal!: AbortSignal;
    let startsA = 0;
    const notify = (threadId: string, turnId: string, status: string) => {
      for (const handler of notifications.get(threadId) ?? [])
        handler({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status } } });
    };
    const interrupt = vi.fn(async (identity: { threadId: string; turnId: string }) => {
      expect(identity).toEqual({ threadId: 'thread-a', turnId: 'turn-a' });
      if (confirmation !== 'none') notify('thread-a', 'turn-retired', 'interrupted');
      if (confirmation === 'exact' || confirmation === 'throw-after-exact') notify('thread-a', 'turn-a', 'interrupted');
      return { kind: 'accepted' as const };
    });
    for (const sibling of [false, true]) {
      const threadId = sibling ? 'thread-b' : 'thread-a';
      const handlers = new Set<(message: { method: string; params?: Record<string, unknown> }) => void>();
      notifications.set(threadId, handlers);
      const lease: AppServerSession = {
        rpc: (async (method: string) => {
          if (method === 'config/read') return { config: {} };
          if (method === 'model/list') return { data: [], nextCursor: null };
          if (method === 'thread/start') return { thread: { id: threadId } };
          if (method === 'turn/start') {
            if (!sibling) startsA += 1;
            if (!sibling && recovery && startsA === 1)
              return {
                turn: {
                  id: 'turn-retired',
                  status: 'failed',
                  error: { message: 'capacity', codexErrorInfo: 'serverOverloaded' },
                },
              };
            return { turn: { id: sibling ? 'turn-b' : 'turn-a', status: 'inProgress' } };
          }
          throw new Error(`Unexpected Codex RPC: ${method}`);
        }) as AppServerSession['rpc'],
        subscribe: (handler) => {
          handlers.add(handler);
          return () => {
            handlers.delete(handler);
          };
        },
        closed: new Promise(() => {}),
        interrupt,
      };
      providerRegistryDouble.rehydrateBinding.mockReturnValueOnce({
        ok: true,
        value: fakeBoundProvider({
          name: 'codex',
          supportsInterrupt: true,
          executionHostRef: hostRef,
          openReplacement: async () => ({ hostRef, close: sibling ? vi.fn() : closeA }),
          execute: async function* (execRuntime) {
            if (sibling) siblingSignal = execRuntime.signal;
            for await (const event of codexTurnKernel(prepared.request, {
              ...execRuntime,
              transport: 'app-server',
              appServerSession: lease,
              persistedContinuity: undefined,
              continuityBridge: { checkpoint: () => {}, transportClosed: () => {} },
              executionPlan: TEST_CODEX_PLAN,
              onProviderTurnTerminal: (terminal) => {
                if (!sibling) evidence.push(terminal);
                execRuntime.onProviderTurnTerminal(terminal);
              },
            })) {
              if (
                !sibling &&
                confirmation === 'throw-after-exact' &&
                event.kind === 'progress' &&
                execRuntime.signal.aborted
              )
                throw new Error('consumer failed after exact confirmation');
              yield event;
            }
          },
        }),
      });
    }
    const proxy = {} as Proxy;
    const onRelinquish = vi.fn();
    const semantic = createSemanticOperationRuntime({
      runtime,
      hostAuthority: shared.authority,
      getProxy: () => proxy,
      onRelinquish,
    });
    const guardianExchange = vi.fn(async (method: string) => {
      const value =
        method === 'guardian.register-provider-root.v1'
          ? {
              state: 'staged-contained',
              providerRoot: shared.authority.rootIdentity(hostRef),
              jointContainmentReceipt: 'contained',
            }
          : { state: 'membership-released' };
      return controlExchangeForTest({ kind: 'response', response: { kind: 'result', value } });
    });
    const semanticReleases: ProviderOperationKey[] = [];
    const containment = createProxyGuardianContainment({
      identity: {
        proxyInstanceId: operationA.proxyInstanceId,
        buildSetId: operationA.buildSetId,
        pid: 6_000,
        incarnation: testIncarnation(850),
        processGroupId: 6_000,
        guardianInstanceId: '50000000-0000-4000-8000-000000000001',
        reaperInstanceId: '60000000-0000-4000-8000-000000000001',
        generation: 'gen2',
        flavor: 'prod',
        hostFingerprint: 'a'.repeat(64),
        canonicalEndpoint: '/tmp/unused-codex-abort.sock',
      },
      guardianChannel: { exchange: guardianExchange },
      stageProviderRoot: (key, payload) => {
        const stage = semantic.stage(key, payload);
        return {
          result: stage.result,
          abortAndRelease: () => {
            semanticReleases.push(key);
            return stage.abortAndRelease();
          },
        };
      },
    });
    const supervisor = new OperationSupervisor({
      host: semantic.host,
      timer: supervisorTimer,
      mintReservation: () => asReservation('40000000-0000-4000-8000-000000000001'),
      wallClockNow: () => Date.now(),
      nowMs: () => Date.now(),
      proxyInstanceId: operationA.proxyInstanceId,
      buildSetId: operationA.buildSetId,
      stageProviderRoot: containment.stageProviderRoot,
      pushProviderEvent: () => {
        throw new ControlEndpointError('control_endpoint_push_no_tenancy', 'offline');
      },
      faultProviderEventControl: () => {},
    });
    Object.assign(proxy, {
      ledger: () => supervisor.ledger(),
      emitProviderEvent: (key: ProviderOperationKey, event: ProviderEventBody) => {
        events.push({ key, event });
        return supervisor.emitProviderEvent(key, event);
      },
    });
    for (const operation of [operationA, operationB]) {
      const request = { operation, hostFingerprint: 'a'.repeat(64), prepareAttemptNumber: 1, prepared };
      const reservation = proxyOperationPreparePendingResultSchema.parse(
        await supervisor.prepare(operation, {
          prepareAttemptNumber: 1,
          prepareAttemptKey: operationPrepareAttemptKey(request),
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
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(startsA).toBe(recovery ? 2 : 1);
    expect(supervisor.ledger().get(operationB)?.state).toBe('executing');
    const stopped = supervisor.stop(operationA, 'user_abort').then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(interrupt).toHaveBeenCalledOnce();
    const confirmed = confirmation === 'exact' || confirmation === 'throw-after-exact';
    if (!confirmed) await vi.advanceTimersByTimeAsync(SEMANTIC_OPERATION_CANCELLATION_TIMEOUT_MS);
    expect(await stopped).toEqual(
      confirmed ? null : expect.objectContaining({ code: 'semantic_operation_cancellation_unconfirmed' }),
    );
    await vi.advanceTimersByTimeAsync(0);
    const finalSeq = supervisor.ledger().nextProviderSeq(operationA) - 1;
    if (confirmed) {
      expect(evidence.at(-1)).toMatchObject({ providerTurnId: 'turn-a', status: 'interrupted' });
      expect(
        events.filter(({ key, event }) => key.jobId === operationA.jobId && event.kind === 'terminal'),
      ).toHaveLength(1);
      expect(events.at(-1)?.event).toMatchObject({ terminal: { outcome: { kind: 'aborted' } } });
      if (confirmation === 'exact')
        expect(events.at(-1)?.event).toMatchObject({ terminal: { model: expect.any(String) } });
      const receipt = await supervisor.settle(operationA, finalSeq);
      expect(receipt).toMatchObject({ state: 'released-after-terminal' });
      expect(await supervisor.settle(operationA, finalSeq)).toEqual(receipt);
      expect(closeA).toHaveBeenCalledOnce();
      expect(guardianExchange.mock.calls.filter(([method]) => method === 'guardian.operation-release.v1')).toHaveLength(
        1,
      );
    } else {
      await expect(supervisor.settle(operationA, finalSeq)).rejects.toMatchObject({
        code: 'semantic_operation_cancellation_unconfirmed',
      });
      expect(supervisor.ledger().get(operationA)?.state).toBe('releasing');
      const releaseAttempts = guardianExchange.mock.calls.length;
      const semanticAttempts = semanticReleases.length;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(semanticReleases.length).toBeGreaterThan(semanticAttempts);
      expect(guardianExchange).toHaveBeenCalledTimes(releaseAttempts);
      expect(closeA).not.toHaveBeenCalled();
      expect(semantic.host.cancellationHold?.(operationA)).toMatchObject({ state: 'draining', pendingSiblings: 1 });
    }
    expect(onRelinquish).not.toHaveBeenCalled();
    expect(siblingSignal.aborted).toBe(false);
    expect(supervisor.ledger().get(operationB)?.state).toBe('executing');
    expect(shared.rootAlive()).toBe(true);
    expect(shared.forceClose).not.toHaveBeenCalled();
    notify('thread-b', 'turn-b', 'completed');
    await vi.advanceTimersByTimeAsync(0);
    expect(events.at(-1)).toMatchObject({
      key: { jobId: operationB.jobId },
      event: { terminal: { outcome: { kind: 'completed' } } },
    });
    supervisor.close();
  });

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

  const siblingDrainFailures = [
    'unconfirmed-interrupt',
    'cancellation-deadline',
    'sibling-cancellation-deadline',
    'quarantined-sibling-settlement',
    'quarantined-sibling-cancellation',
  ];
  it.each(siblingDrainFailures)(
    'bounds sibling draining through quarantine before relinquishing an unsafe set: %s',
    async (failureMode) => {
      vi.useFakeTimers();
      const { proxy, ledger, emittedEvents } = createTestProxy();
      const operationA = testKey('op-a');
      const operationB = { jobId: 'job-2', operationId: 'op-b' };
      const prepared = preparedFixture();
      prepareAndActivate(ledger, operationA, prepared);
      prepareAndActivate(ledger, operationB, prepared);
      const hostRef = sharedHostRef();
      const shared = sharedHostAuthority();
      const continueB = deferred();
      let siblingSignal!: AbortSignal;
      const closeA = vi.fn();
      providerRegistryDouble.rehydrateBinding
        .mockReturnValueOnce({
          ok: true,
          value: fakeBoundProvider({
            supportsInterrupt: true,
            executionHostRef: hostRef,
            openReplacement: async () => ({ hostRef, close: closeA }),
            execute: async function* (execRuntime) {
              await new Promise<void>((resolve) => {
                if (failureMode === 'cancellation-deadline') return;
                execRuntime.signal.addEventListener('abort', () => resolve(), { once: true });
              });
              yield { kind: 'suspended', reason: 'interrupt_unconfirmed' };
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
              siblingSignal = execRuntime.signal;
              yield { kind: 'progress', message: 'sibling-ready' };
              await continueB.promise;
              execRuntime.onProviderTurnTerminal({
                kind: 'provider-turn-terminal',
                providerTurnId: 'turn-b',
                status: 'completed',
              });
              yield terminalCompleted;
            },
          }),
        });
      const onRelinquish = vi.fn(() => {
        void semantic.shutdown('signal_abort').catch(() => {});
      });
      const semantic = createSemanticOperationRuntime({
        runtime,
        hostAuthority: shared.authority,
        getProxy: () => proxy,
        onRelinquish,
      });
      await semantic.ensureProviderRoot(operationA, prepared);
      await semantic.ensureProviderRoot(operationB, prepared);
      await semantic.host.start({ key: operationA, prepared }).result;
      const startedB = semantic.host.start({ key: operationB, prepared });
      await startedB.result;
      const stopped = Promise.resolve(semantic.host.stop({ key: operationA, cause: 'signal_abort' })).catch(
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(
        failureMode.startsWith('quarantined-') ? 0 : SEMANTIC_OPERATION_CANCELLATION_TIMEOUT_MS,
      );
      const failure = await stopped;
      expect(failure).toMatchObject({ code: 'semantic_operation_cancellation_unconfirmed' });
      expect(siblingSignal.aborted).toBe(false);
      expect(onRelinquish).not.toHaveBeenCalled();
      expect(closeA).not.toHaveBeenCalled();
      expect(() => semantic.stage(testKey('op-c'), prepared)).toThrow(
        expect.objectContaining({ code: 'semantic_operation_admission_closed' }),
      );
      await expect(semantic.host.stop({ key: operationA, cause: 'signal_abort' })).rejects.toBe(failure);
      if (failureMode.startsWith('quarantined-')) {
        expect(semantic.host.cancellationHold?.(operationA)).toMatchObject({ state: 'draining', pendingSiblings: 1 });
        await vi.advanceTimersByTimeAsync(SEMANTIC_OPERATION_CANCELLATION_TIMEOUT_MS - 1);
        expect(semantic.host.cancellationHold?.(operationA)?.state).toBe('draining');
        await vi.advanceTimersByTimeAsync(1);
        expect(semantic.host.cancellationHold?.(operationA)).toMatchObject({
          state: 'quarantined',
          drainTimeoutMs: SEMANTIC_OPERATION_CANCELLATION_TIMEOUT_MS,
          pendingSiblings: 1,
          exit: 'sibling-settlement-or-cancellation',
        });
        await vi.advanceTimersByTimeAsync(86_400_000);
        expect(siblingSignal.aborted).toBe(false);
        expect(onRelinquish).not.toHaveBeenCalled();
        expect(closeA).not.toHaveBeenCalled();
        expect(shared.forceClose).not.toHaveBeenCalled();
        expect(() => semantic.stage(testKey('op-c'), prepared)).toThrow(
          expect.objectContaining({ code: 'semantic_operation_admission_closed' }),
        );
        await expect(semantic.host.stop({ key: operationA, cause: 'signal_abort' })).rejects.toBe(failure);
      }
      if (failureMode === 'sibling-cancellation-deadline' || failureMode === 'quarantined-sibling-cancellation') {
        const stopB = Promise.resolve(semantic.host.stop({ key: operationB, cause: 'signal_abort' })).catch(
          (error: unknown) => error,
        );
        await vi.advanceTimersByTimeAsync(SEMANTIC_OPERATION_CANCELLATION_TIMEOUT_MS);
        expect(await stopB).toMatchObject({ code: 'semantic_operation_cancellation_unconfirmed', key: operationB });
        expect(onRelinquish).toHaveBeenCalledExactlyOnceWith(failure);
        expect(semantic.host.cancellationHold?.(operationA)).toMatchObject({
          state: 'relinquishing',
          pendingSiblings: 0,
        });
        return;
      }
      continueB.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(emittedEvents.some(({ key, event }) => key === operationB && event === terminalCompleted)).toBe(true);
      expect(onRelinquish).not.toHaveBeenCalled();
      await startedB.abortAndRelease();
      expect(onRelinquish).toHaveBeenCalledExactlyOnceWith(failure);
      expect(shared.forceClose).not.toHaveBeenCalled();
      expect(semantic.host.cancellationHold?.(operationA)).toMatchObject({
        state: 'relinquishing',
        pendingSiblings: 0,
      });
    },
  );

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

  describe('inferred turn settlement retry ownership', () => {
    it.each(
      ['none', 'callback-before', 'callback-after', 'settlement'].flatMap((retiredEvidence) =>
        ['recover', 'contain'].map((successor) => ({ retiredEvidence, successor })),
      ),
    )(
      'paces re-observation and takes the $successor successor ($retiredEvidence)',
      async ({ successor, retiredEvidence }) => {
        vi.useFakeTimers();
        const operationA = supervisedOperation(71);
        const operationB = supervisedOperation(72);
        const prepared = preparedFixture();
        const shared = sharedHostAuthority();
        const hostRef = sharedHostRef();
        const continueB = deferred();
        let siblingSignal!: AbortSignal;
        const settleTurn = vi.fn(async () => null as ProviderTurnTerminalEvidence | null);
        const retiredTerminal: ProviderTurnTerminalEvidence = {
          kind: 'provider-turn-terminal',
          providerTurnId: 'turn-retired',
          status: 'failed',
        };
        if (retiredEvidence === 'settlement') settleTurn.mockResolvedValue(retiredTerminal);
        const closeTurn = vi.fn();
        const closeA = vi.fn();
        providerRegistryDouble.rehydrateBinding
          .mockReturnValueOnce({
            ok: true,
            value: fakeBoundProvider({
              supportsInterrupt: true,
              executionHostRef: hostRef,
              openReplacement: async () => ({ hostRef, close: closeA }),
              execute: async function* (execRuntime) {
                if (retiredEvidence === 'callback-before') execRuntime.onProviderTurnTerminal(retiredTerminal);
                execRuntime.onProviderTurnSettlement!({
                  providerTurnId: 'turn-a',
                  settle: settleTurn,
                  close: closeTurn,
                });
                if (retiredEvidence === 'callback-after') execRuntime.onProviderTurnTerminal(retiredTerminal);
                yield {
                  kind: 'terminal',
                  terminal: { content: 'Final answer', durationMs: 0, outcome: { kind: 'completed' } },
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
                siblingSignal = execRuntime.signal;
                yield { kind: 'progress', message: 'sibling-ready' };
                await continueB.promise;
                execRuntime.onProviderTurnTerminal({
                  kind: 'provider-turn-terminal',
                  providerTurnId: 'turn-b',
                  status: 'completed',
                });
                yield terminalCompleted;
              },
            }),
          });
        const proxy = {} as Proxy;
        const onRelinquish = vi.fn();
        const semantic = createSemanticOperationRuntime({
          runtime,
          hostAuthority: shared.authority,
          getProxy: () => proxy,
          onRelinquish,
        });
        const events: ProviderEventBody[] = [];
        const supervisor = new OperationSupervisor({
          host: semantic.host,
          timer: supervisorTimer,
          mintReservation: () => asReservation('40000000-0000-4000-8000-000000000001'),
          wallClockNow: () => Date.now(),
          nowMs: () => Date.now(),
          proxyInstanceId: operationA.proxyInstanceId,
          buildSetId: operationA.buildSetId,
          stageProviderRoot: (key, reserved) => {
            const stage = semantic.stage(key, reserved.prepared);
            return {
              result: stage.result.then((staged) =>
                staged.state !== 'staged'
                  ? staged
                  : {
                      state: 'staged' as const,
                      providerRoot: staged.providerRoot,
                      receipt: asJointContainmentReceipt('contained'),
                    },
              ),
              confirmActivation: async () => {},
              abortAndRelease: () => stage.abortAndRelease(),
            };
          },
          pushProviderEvent: () => {
            throw new ControlEndpointError('control_endpoint_push_no_tenancy', 'offline');
          },
          faultProviderEventControl: () => {},
        });
        Object.assign(proxy, {
          ledger: () => supervisor.ledger(),
          emitProviderEvent: (key: ProviderOperationKey, event: ProviderEventBody) => {
            events.push(event);
            return supervisor.emitProviderEvent(key, event);
          },
        });
        const activate = async (operation: OperationIdentity) => {
          const request = { operation, hostFingerprint: 'a'.repeat(64), prepareAttemptNumber: 1, prepared };
          const reservation = proxyOperationPreparePendingResultSchema.parse(
            await supervisor.prepare(operation, {
              prepareAttemptNumber: 1,
              prepareAttemptKey: operationPrepareAttemptKey(request),
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
        };
        await activate(operationA);
        await activate(operationB);
        await vi.advanceTimersByTimeAsync(0);
        expect(closeA).not.toHaveBeenCalled();
        const answer = events.find((event) => event.kind === 'terminal');
        expect(answer).toMatchObject({ terminal: { content: 'Final answer', outcome: { kind: 'completed' } } });
        const finalSeq = supervisor.ledger().nextProviderSeq(operationA) - 1;
        await expect(supervisor.settle(operationA, finalSeq)).rejects.toMatchObject({
          code: 'semantic_operation_cancellation_unconfirmed',
        });
        expect(settleTurn).toHaveBeenCalledTimes(1);
        expect(siblingSignal.aborted).toBe(false);
        expect(onRelinquish).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(999);
        expect(settleTurn).toHaveBeenCalledTimes(1);
        if (successor === 'recover')
          settleTurn.mockResolvedValue({
            kind: 'provider-turn-terminal',
            providerTurnId: 'turn-a',
            status: 'completed',
          });
        await vi.advanceTimersByTimeAsync(1);
        expect(settleTurn).toHaveBeenCalledTimes(2);
        if (successor === 'recover') {
          const receipt = await supervisor.settle(operationA, finalSeq);
          expect(receipt).toMatchObject({
            state: 'released-after-terminal',
          });
          expect(await supervisor.settle(operationA, finalSeq)).toEqual(receipt);
          expect(closeTurn).toHaveBeenCalledOnce();
          expect(closeA).toHaveBeenCalledOnce();
        } else {
          await vi.advanceTimersByTimeAsync(1_000);
          expect(settleTurn).toHaveBeenCalledTimes(3);
          expect(semantic.host.cancellationHold?.(operationA)).toMatchObject({ state: 'draining', pendingSiblings: 1 });
          await vi.advanceTimersByTimeAsync(SEMANTIC_OPERATION_CANCELLATION_TIMEOUT_MS);
          expect(semantic.host.cancellationHold?.(operationA)).toMatchObject({
            state: 'quarantined',
            pendingSiblings: 1,
          });
          expect(closeTurn).not.toHaveBeenCalled();
        }
        expect(siblingSignal.aborted).toBe(false);
        expect(shared.forceClose).not.toHaveBeenCalled();
        expect(onRelinquish).not.toHaveBeenCalled();
        expect(events.filter((event) => event.kind === 'terminal')).toEqual([answer]);
        continueB.resolve();
        await vi.advanceTimersByTimeAsync(0);
        await supervisor.settle(operationB, supervisor.ledger().nextProviderSeq(operationB) - 1);
        expect(onRelinquish).toHaveBeenCalledTimes(successor === 'contain' ? 1 : 0);
        if (successor === 'contain') expect(semantic.host.cancellationHold?.(operationA)?.state).toBe('relinquishing');
        supervisor.close();
      },
    );
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
                providerRoot: { pid: 4242, incarnation: testIncarnation(1_700_000_000) },
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
    const encodedHostRef = encodeHostRef(hostRef);

    await expect(host.ensureProviderRoot(testKey(), preparedFixture({ provider: 'codex' }))).resolves.toEqual({
      state: 'permanent-refusal',
      code: 'provider_host_unserviceable',
      disposition: 'terminal-failure',
      reason:
        `Provider host ${encodedHostRef} (${hostRef.provider}/${hostRef.instanceId}) is unserviceable. ` +
        `Run coral-cli backend provider-host inspect ${encodedHostRef}, then ` +
        `coral-cli backend provider-host evict ${encodedHostRef} before retrying fresh placement.`,
      hostRef,
      remediation: {
        action: 'evict-provider-host',
        command: 'coral-cli backend provider-host evict <host-ref>',
      },
    });
  });
});

// --- createProxyAppServerHostAuthority: the host pool -----------------------------------------------------

function fakeProviderServerHandle(options?: {
  pid?: number;
  request?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  close?: () => Promise<void>;
  closeDisposition?: ProviderServerHandle['close'];
}): {
  handle: ProviderServerHandle;
  closeMock: ReturnType<typeof vi.fn>;
  resolveClosed(): void;
} {
  const closed = deferred<Error | void>();
  const child = Object.assign(new EventEmitter(), {
    pid: options?.pid ?? 1_000,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: null,
    stdout: null,
    stderr: null,
    kill: () => true,
  });
  let isClosed = false;
  const resolveClosed = (): void => {
    if (isClosed) return;
    isClosed = true;
    child.exitCode = 0;
    child.emit('exit', child.exitCode, child.signalCode);
    child.emit('close', child.exitCode, child.signalCode);
    closed.resolve();
  };
  const closeMock = vi.fn(async (...args: Parameters<ProviderServerHandle['close']>) => {
    if (options?.closeDisposition !== undefined) return options.closeDisposition(...args);
    await options?.close?.();
    resolveClosed();
    return {
      kind: 'observed-absent' as const,
      evidence: { subject: { kind: 'process' as const, pid: options?.pid ?? 1_000 } },
    };
  });
  const handle: ProviderServerHandle = {
    pid: options?.pid ?? 1_000,
    child,
    generation: 1,
    rpc: {
      request: vi.fn(options?.request ?? (async () => ({}))) as unknown as ProviderServerHandle['rpc']['request'],
      notify: vi.fn(),
    },
    onNotification: vi.fn(() => () => {}) as unknown as ProviderServerHandle['onNotification'],
    closePromise: closed.promise,
    isClosed: () => isClosed,
    inspectDiagnostics: () => ({
      hostLog: { entries: [], retainedBytes: 0, truncatedBeforeSeq: 0 },
      completedObservations: [],
      factsTruncatedBeforeSeq: 0,
    }),
    markExpectedClose: vi.fn(),
    close: closeMock,
  };
  return {
    handle,
    closeMock,
    resolveClosed,
  };
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
    idleRetirement: 'unleased-and-host-idle',
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
  it('abandons admission without claiming a detached failed spawn closed when the operator takes ownership', async () => {
    vi.useFakeTimers();
    const failure = new Error('provider initialization failed while cleanup remained held');
    const subject = { kind: 'unattributable-process-group', processGroupId: 1_000 } as const;
    const settlement = deferred();
    const settled = settlement.promise;
    const abandonment = {
      kind: 'operator-abandoned' as const,
      subject,
      processAbsenceProven: false as const,
      successor: { owner: 'operator-command' as const, acceptance: 'accepted' as const },
    };
    const mismatchedAbandonment = {
      ...abandonment,
      subject: { kind: 'unattributable-process-group' as const, processGroupId: 999 },
    };
    let abandonAttempts = 0;
    let transferred: ProviderServerFailedSpawnCleanupDisposition | null = null;
    const operatorExit = {
      kind: 'abandon-provider-host-acquisition' as const,
      abandon: vi.fn(async () => {
        abandonAttempts += 1;
        transferred = abandonAttempts === 1 ? mismatchedAbandonment : abandonment;
        settlement.resolve();
        return transferred as typeof abandonment;
      }),
    };
    const retry = vi.fn<() => Promise<ProviderServerFailedSpawnCleanupDisposition>>();
    retry.mockImplementation(
      async () =>
        transferred ?? {
          kind: 'held-unobservable',
          subject,
          observation: 'unobservable',
          operatorExit,
          settled,
          retry,
        },
    );
    vi.mocked(spawnProviderServerTransport).mockImplementationOnce(async (params) => {
      const hold = {
        kind: 'held-unobservable' as const,
        subject,
        observation: 'unobservable' as const,
        operatorExit,
        settled,
        retry,
        error: failure,
      };
      return { ...hold, successor: params.acceptFailedSpawnCleanup(hold) };
    });
    const authority = createProxyAppServerHostAuthority(runtime);
    const scope = selectedHostScope(authority, testKey(), 'operation-isolated');

    await expect(scope.openSession(sharedSpec())).rejects.toBe(failure);
    const [record] = authority.listProviderHosts();
    expect(record).toMatchObject({
      status: 'reclamation-failed',
      host: { owner: 'provider-proxy', reclamationRetryable: true },
    });
    if (record === undefined) throw new Error('Expected a failed-spawn cleanup inventory record.');

    await expect(authority.evictHostV1(record.ref)).resolves.toEqual({ kind: 'requires-v2' });
    expect(operatorExit.abandon).not.toHaveBeenCalled();

    await expect(authority.evictHost(record.ref)).resolves.toEqual({
      kind: 'held',
      observation: 'unobservable',
      successorOwner: null,
      operatorExit: 'abandon-provider-host-acquisition',
    });
    await Promise.resolve();
    expect(authority.listProviderHosts()).toMatchObject([{ status: 'reclamation-failed' }]);
    expect(authority.admissionSnapshot().state.size).toBe(1);
    expect(authority.admissionSnapshot().tombstones).toEqual([]);

    await expect(authority.evictHost(record.ref)).resolves.toBe(abandonment);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(operatorExit.abandon).toHaveBeenCalledTimes(2);
    await expect(authority.evictHost(record.ref)).resolves.toBe(abandonment);
    expect(operatorExit.abandon).toHaveBeenCalledTimes(2);
    expect(authority.listProviderHosts()).toEqual([]);
    expect(authority.admissionSnapshot().state.size).toBe(0);
    expect(authority.admissionSnapshot().tombstones).toEqual([]);
  });

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
    expect(readProcessIncarnation).toHaveBeenCalledWith(server.handle.pid, runtime.env.platform());
    expect(vi.mocked(spawnProviderServerTransport).mock.calls[0]?.[0]).not.toHaveProperty('detached');
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
    expect(authority.listProviderHosts()).toEqual([
      expect.objectContaining({
        ref: opened.hostRef,
        status: 'live',
        spec: expect.objectContaining({ cwd: hostSpec.cwd }),
      }),
    ]);
    expect(authority.inspectProviderHost(opened.hostRef)).toMatchObject({ ref: opened.hostRef, status: 'live' });
    expect(first.closeMock, 'a negative finding performed a proxy close').not.toHaveBeenCalled();

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
    expect(authority.listProviderHosts()).toEqual([
      expect.objectContaining({
        ref: opened.hostRef,
        status: 'retired-blocked',
        spec: expect.objectContaining({ cwd: hostSpec.cwd }),
      }),
    ]);
    expect(authority.inspectProviderHost(opened.hostRef)).toMatchObject({
      ref: opened.hostRef,
      status: 'retired-blocked',
    });
    await expect(scope.openSession(hostSpec)).rejects.toMatchObject({ code: 'provider_host_unserviceable' });

    expect(await authority.evictHost({ ...opened.hostRef, instanceId: 'stale-instance' })).toEqual({ kind: 'stale' });
    expect(await authority.evictHostV1(opened.hostRef)).toEqual({ kind: 'evicted' });
    expect(await authority.evictHostV1(opened.hostRef)).toEqual({ kind: 'evicted' });
    expect(first.closeMock, 'retired-blocked eviction attempted a second physical close').not.toHaveBeenCalled();
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

  it('correlates an openSession RPC rejection to its exact blocked proxy host', async () => {
    const providerCause = new Error('proxy provider RPC rejected');
    const server = fakeProviderServerHandle({
      request: async (method) => {
        if (method === 'turn/start') throw providerCause;
        return {};
      },
    });
    vi.mocked(spawnProviderServerTransport).mockResolvedValueOnce(server.handle);
    const authority = createProxyAppServerHostAuthority(runtime);
    const scope = selectedHostScope(authority, testKey(), 'shared-acknowledged-interrupt');
    const opened = await scope.openSession(sharedSpec({ provider: 'codex' }));
    vi.mocked(spawnProviderServerTransport).mock.calls[0]?.[0].observeProviderResponse(rejectedConfigRead(0));

    const rejection = await opened.session.rpc('turn/start', {}).catch((error: unknown) => error);

    opened.close();
    expect(rejection, 'proxy openSession RPC lost its exact blocked host reference').toMatchObject({
      name: 'ProviderHostUnserviceableResponseError',
      hostRef: opened.hostRef,
    });
    expect(
      (rejection as { providerCause?: unknown }).providerCause,
      'proxy openSession RPC lost the raw provider cause',
    ).toBe(providerCause);
  });

  it("awaits exact live proxy close before confirmation and leaves another owner's live job untouched", async () => {
    const evictedClose = deferred();
    const continuingRpc = deferred<unknown>();
    let rejectEvictedRpc!: (reason: unknown) => void;
    const evictedRpc = new Promise<unknown>((_resolve, reject) => {
      rejectEvictedRpc = reject;
    });
    const evicted = fakeProviderServerHandle({
      pid: 1_010,
      request: (method) => (method === 'live/job' ? evictedRpc : Promise.resolve({})),
      close: () => {
        rejectEvictedRpc(new Error('evicted proxy host closed'));
        return evictedClose.promise;
      },
    });
    const untouched = fakeProviderServerHandle({
      pid: 1_011,
      request: (method) => (method === 'live/job' ? continuingRpc.promise : Promise.resolve({})),
    });
    const replacement = fakeProviderServerHandle({ pid: 1_012 });
    vi.mocked(spawnProviderServerTransport)
      .mockResolvedValueOnce(evicted.handle)
      .mockResolvedValueOnce(untouched.handle)
      .mockResolvedValueOnce(replacement.handle);
    const evictedOwner = createProxyAppServerHostAuthority(runtime);
    const untouchedOwner = createProxyAppServerHostAuthority(runtime);
    const evictedScope = selectedHostScope(
      evictedOwner,
      { jobId: 'job-a', operationId: 'operation-a' },
      'shared-acknowledged-interrupt',
    );
    const untouchedScope = selectedHostScope(
      untouchedOwner,
      { jobId: 'job-b', operationId: 'operation-b' },
      'shared-acknowledged-interrupt',
    );
    const first = await evictedScope.openSession(
      sharedSpec({ provider: 'codex', cwd: fixtureCanonicalWorkDir('/workspace/a') }),
    );
    const second = await untouchedScope.openSession(
      sharedSpec({ provider: 'codex', cwd: fixtureCanonicalWorkDir('/workspace/b') }),
    );
    const evictedJob = first.session.rpc('live/job', {}).then(
      () => null,
      (error: unknown) => error,
    );
    const liveJob = second.session.rpc('live/job', {});
    vi.mocked(spawnProviderServerTransport).mock.calls[0]?.[0].observeProviderResponse(rejectedConfigRead(0));

    let evictionSettled = false;
    const eviction = evictedOwner.evictHost(first.hostRef).then((result) => {
      evictionSettled = true;
      return result;
    });
    await vi.waitFor(() => expect(evicted.closeMock, 'ref A exact live close was not selected').toHaveBeenCalledOnce());
    await expect(evictedJob).resolves.toMatchObject({ message: 'evicted proxy host closed' });

    expect(evictionSettled, 'ref A eviction settled before ref A exact live close').toBe(false);
    await expect(
      evictedScope.openSession(sharedSpec({ provider: 'codex', cwd: fixtureCanonicalWorkDir('/workspace/a') })),
      'ref A admission reopened before ref A exact live close settled',
    ).rejects.toMatchObject({
      code: 'provider_host_unserviceable',
      hostRef: first.hostRef,
    });
    expect(untouched.closeMock, 'ref B was closed while evicting ref A').not.toHaveBeenCalled();

    evictedClose.resolve();
    await expect(eviction).resolves.toEqual({ kind: 'evicted' });
    const reopened = await evictedScope.openSession(
      sharedSpec({ provider: 'codex', cwd: fixtureCanonicalWorkDir('/workspace/a') }),
    );
    expect(reopened.hostRef.instanceId).not.toBe(first.hostRef.instanceId);
    expect(untouched.closeMock, 'ref B was closed while evicting ref A').not.toHaveBeenCalled();
    continuingRpc.resolve({ continued: true });
    await expect(liveJob).resolves.toEqual({ continued: true });

    first.close();
    second.close();
    reopened.close();
  });

  it('keeps a foreign retired proxy ref blocked while evicting an exact live ref', async () => {
    const exactClose = deferred();
    const retired = fakeProviderServerHandle({ pid: 1_020 });
    const exact = fakeProviderServerHandle({ pid: 1_021, close: () => exactClose.promise });
    const replacement = fakeProviderServerHandle({ pid: 1_022 });
    vi.mocked(spawnProviderServerTransport)
      .mockResolvedValueOnce(retired.handle)
      .mockResolvedValueOnce(exact.handle)
      .mockResolvedValueOnce(replacement.handle);
    const authority = createProxyAppServerHostAuthority(runtime);
    const retiredScope = selectedHostScope(
      authority,
      { jobId: 'job-retired', operationId: 'operation-retired' },
      'operation-isolated',
    );
    const exactScope = selectedHostScope(
      authority,
      { jobId: 'job-exact', operationId: 'operation-exact' },
      'operation-isolated',
    );
    const hostSpec = sharedSpec({ provider: 'codex' });
    const retiredSession = await retiredScope.openSession(hostSpec);
    vi.mocked(spawnProviderServerTransport).mock.calls[0]?.[0].observeProviderResponse(rejectedConfigRead(0));
    retired.resolveClosed();
    await vi.waitFor(() => expect(authority.admissionSnapshot().tombstones).toHaveLength(1));

    const exactSession = await exactScope.openSession(hostSpec);
    vi.mocked(spawnProviderServerTransport).mock.calls[1]?.[0].observeProviderResponse(rejectedConfigRead(1));
    const eviction = authority.evictHost(exactSession.hostRef);
    await vi.waitFor(() =>
      expect(exact.closeMock, 'ref A exact live close was not selected over foreign ref B').toHaveBeenCalledOnce(),
    );
    expect(retired.closeMock, 'foreign retired ref B received a second physical close').not.toHaveBeenCalled();
    await expect(
      retiredScope.openSession(hostSpec),
      'foreign ref B admission was cleared while evicting ref A',
    ).rejects.toMatchObject({ code: 'provider_host_unserviceable', hostRef: retiredSession.hostRef });

    exactClose.resolve();
    await expect(eviction).resolves.toEqual({ kind: 'evicted' });
    const reopened = await exactScope.openSession(hostSpec);
    expect(reopened.hostRef.instanceId).not.toBe(exactSession.hostRef.instanceId);
    await expect(retiredScope.openSession(hostSpec)).rejects.toMatchObject({
      code: 'provider_host_unserviceable',
      hostRef: retiredSession.hostRef,
    });

    retiredSession.close();
    exactSession.close();
    reopened.close();
  });

  it('keeps proxy admission blocked when exact live close fails', async () => {
    const server = fakeProviderServerHandle({
      pid: 1_030,
      close: async () => {
        throw new Error('proxy close refused');
      },
    });
    vi.mocked(spawnProviderServerTransport).mockResolvedValueOnce(server.handle);
    const authority = createProxyAppServerHostAuthority(runtime);
    const scope = selectedHostScope(authority, testKey(), 'shared-acknowledged-interrupt');
    const hostSpec = sharedSpec({ provider: 'codex' });
    const opened = await scope.openSession(hostSpec);
    vi.mocked(spawnProviderServerTransport).mock.calls[0]?.[0].observeProviderResponse(rejectedConfigRead(0));

    await expect(authority.evictHost(opened.hostRef)).rejects.toThrow('proxy close refused');
    expect(authority.admissionSnapshot().state.values().next().value).toMatchObject({
      ref: opened.hostRef,
      phase: 'blocked-live',
    });
    await expect(scope.openSession(hostSpec)).rejects.toMatchObject({
      code: 'provider_host_unserviceable',
      hostRef: opened.hostRef,
    });
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

    expect(authority.rootIdentity(opened.hostRef)).toEqual({ pid: 4_242, incarnation: testIncarnation(1_700_000_000) });

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

  it('retains an accepted close hold and retries it before releasing the root', async () => {
    const settled = new Promise<void>(() => undefined);
    const mismatchedAbandonment = {
      kind: 'operator-abandoned' as const,
      subject: { kind: 'process' as const, pid: 999 },
      processAbsenceProven: false as const,
      successor: { owner: 'operator-command' as const, acceptance: 'accepted' as const },
    };
    const observedAbsent = {
      kind: 'observed-absent' as const,
      evidence: { subject: { kind: 'process' as const, pid: 1_000 } },
    };
    const retry = vi.fn().mockResolvedValueOnce(mismatchedAbandonment).mockResolvedValueOnce(observedAbsent);
    const server = fakeProviderServerHandle({
      closeDisposition: async (acceptCleanupHold) => {
        const hold = {
          kind: 'held-alive' as const,
          subject: { kind: 'process' as const, pid: 1_000 },
          observation: 'alive' as const,
          operatorExit: {
            kind: 'abandon-provider-host-acquisition' as const,
            abandon: vi.fn(async () => ({
              kind: 'operator-abandoned' as const,
              subject: { kind: 'process' as const, pid: 1_000 },
              processAbsenceProven: false as const,
              successor: { owner: 'operator-command' as const, acceptance: 'accepted' as const },
            })),
          },
          settled,
          retry,
        };
        return { ...hold, successor: acceptCleanupHold(hold) };
      },
    });
    vi.mocked(spawnProviderServerTransport).mockResolvedValueOnce(server.handle);
    const authority = createProxyAppServerHostAuthority(runtime);
    const opened = await selectedHostScope(authority, testKey(), 'operation-isolated').openSession(sharedSpec());

    await expect(authority.forceClose(opened.hostRef)).resolves.toMatchObject({
      kind: 'held-alive',
      successor: { kind: 'accepted', owner: 'provider-proxy-root-pool' },
    });
    expect(authority.admissionSnapshot().state.size).toBe(1);
    expect(authority.listProviderHosts()).toMatchObject([
      { status: 'reclamation-failed', host: { owner: 'provider-proxy', reclamationAttempts: 1 } },
    ]);

    await expect(authority.forceClose(opened.hostRef)).rejects.toThrow('provider_host_operator_transfer_invalid');
    expect(authority.admissionSnapshot().state.size).toBe(1);
    expect(authority.admissionSnapshot().tombstones).toEqual([]);

    await expect(authority.forceClose(opened.hostRef)).resolves.toMatchObject({ kind: 'observed-absent' });
    expect(retry).toHaveBeenCalledTimes(2);
    expect(authority.admissionSnapshot().state.size).toBe(0);
  });

  it('retains proxy ownership when the broker shutdown successor accepts only child cleanup', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        disposition: 'held-unobservable',
        observation: 'unobservable',
        subjects: [{ kind: 'claude-child', controller: 'print', generation: 1 }],
        successor: { kind: 'accepted', owner: 'broker-session-pool' },
        operatorExit: { kind: 'retry-broker-shutdown' },
      })
      .mockResolvedValueOnce({ ok: true, disposition: 'observed-absent' });
    const server = fakeProviderServerHandle({ request });
    vi.mocked(spawnProviderServerTransport).mockResolvedValueOnce(server.handle);
    const authority = createProxyAppServerHostAuthority(runtime);
    const opened = await selectedHostScope(authority, testKey(), 'operation-isolated').openSession(
      exclusiveSpec({
        shutdownCapability: {
          method: 'broker/shutdown',
          timeoutMs: 1_000,
          resultDisposition: {
            kind: 'provider-server-shutdown-v1',
            successorOwner: 'broker-session-pool',
            operatorExit: 'retry-broker-shutdown',
          },
        },
      }),
      { jobId: 'job-1' },
    );

    const held = await authority.forceClose(opened.hostRef);
    expect(held).toMatchObject({
      kind: 'provider-shutdown-held-unobservable',
      subject: { kind: 'provider-server', pid: 1_000 },
      obligations: [{ kind: 'claude-child', controller: 'print', generation: 1 }],
      successor: { kind: 'accepted', owner: 'broker-session-pool' },
      operatorExit: { kind: 'retry-broker-shutdown', retry: expect.any(Function) },
      retry: expect.any(Function),
    });
    expect(server.closeMock).not.toHaveBeenCalled();
    expect(authority.admissionSnapshot().state.size).toBe(1);
    expect(authority.listProviderHosts()).toMatchObject([
      {
        status: 'shutdown-held',
        host: {
          observation: 'unobservable',
          successorOwner: 'broker-session-pool',
          operatorExit: 'retry-broker-shutdown',
        },
      },
    ]);
    expect(request).toHaveBeenCalledOnce();

    if (
      held === undefined ||
      (held.kind !== 'provider-shutdown-held-alive' && held.kind !== 'provider-shutdown-held-unobservable')
    ) {
      throw new Error('Expected broker shutdown to remain held.');
    }
    await expect(held.operatorExit.retry()).resolves.toMatchObject({ kind: 'observed-absent' });
    expect(authority.admissionSnapshot().state.size).toBe(0);
    expect(authority.listProviderHosts()).toEqual([]);
  });

  it('reports a live broker hold before reporting eviction after the hold is discharged', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        disposition: 'held-unobservable',
        observation: 'unobservable',
        subjects: [{ kind: 'claude-child', controller: 'print', generation: 1 }],
        successor: { kind: 'accepted', owner: 'broker-session-pool' },
        operatorExit: { kind: 'retry-broker-shutdown' },
      })
      .mockResolvedValueOnce({ ok: true, disposition: 'observed-absent' });
    const server = fakeProviderServerHandle({ request });
    vi.mocked(spawnProviderServerTransport).mockResolvedValueOnce(server.handle);
    const authority = createProxyAppServerHostAuthority(runtime);
    const opened = await selectedHostScope(authority, testKey(), 'operation-isolated').openSession(
      exclusiveSpec({
        shutdownCapability: {
          method: 'broker/shutdown',
          timeoutMs: 1_000,
          resultDisposition: {
            kind: 'provider-server-shutdown-v1',
            successorOwner: 'broker-session-pool',
            operatorExit: 'retry-broker-shutdown',
          },
        },
      }),
      { jobId: 'job-1' },
    );

    await expect(authority.evictHost(opened.hostRef)).resolves.toEqual({
      kind: 'held',
      observation: 'unobservable',
      successorOwner: 'broker-session-pool',
      operatorExit: 'retry-broker-shutdown',
    });
    expect(server.closeMock).not.toHaveBeenCalled();
    expect(authority.admissionSnapshot().state.size).toBe(1);
    expect(authority.listProviderHosts()).toMatchObject([{ status: 'shutdown-held' }]);

    await expect(authority.evictHost(opened.hostRef)).resolves.toEqual({ kind: 'evicted' });
    expect(authority.admissionSnapshot().state.size).toBe(0);
    expect(authority.listProviderHosts()).toEqual([]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(server.closeMock).toHaveBeenCalledOnce();
    opened.close();
  });

  it('retains the broker when its shutdown hold names a different successor', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        disposition: 'held-alive',
        observation: 'alive',
        subjects: [{ kind: 'claude-child', controller: 'tui', generation: 2 }],
        successor: { kind: 'accepted', owner: 'different-owner' },
        operatorExit: { kind: 'retry-broker-shutdown' },
      })
      .mockResolvedValueOnce({ ok: true, disposition: 'observed-absent' });
    const server = fakeProviderServerHandle({ request });
    vi.mocked(spawnProviderServerTransport).mockResolvedValueOnce(server.handle);
    const authority = createProxyAppServerHostAuthority(runtime);
    const opened = await selectedHostScope(authority, testKey(), 'operation-isolated').openSession(
      exclusiveSpec({
        shutdownCapability: {
          method: 'broker/shutdown',
          timeoutMs: 1_000,
          resultDisposition: {
            kind: 'provider-server-shutdown-v1',
            successorOwner: 'broker-session-pool',
            operatorExit: 'retry-broker-shutdown',
          },
        },
      }),
      { jobId: 'job-1' },
    );

    const held = await authority.forceClose(opened.hostRef);
    expect(held).toMatchObject({
      kind: 'provider-shutdown-held-unobservable',
      subject: { kind: 'provider-server', pid: 1_000 },
      successor: null,
      operatorExit: { kind: 'retry-provider-shutdown', retry: expect.any(Function) },
      retry: expect.any(Function),
    });
    expect(server.closeMock).not.toHaveBeenCalled();
    expect(authority.admissionSnapshot().state.size).toBe(1);
    expect(authority.listProviderHosts()).toMatchObject([
      {
        status: 'shutdown-held',
        host: {
          owner: 'provider-proxy',
          pid: 1_000,
          observation: 'unobservable',
          successorOwner: null,
          operatorExit: 'retry-provider-shutdown',
        },
      },
    ]);
    if (
      held === undefined ||
      (held.kind !== 'provider-shutdown-held-alive' && held.kind !== 'provider-shutdown-held-unobservable')
    ) {
      throw new Error('Expected the malformed shutdown transfer to remain retryable.');
    }

    await expect(held.retry()).resolves.toMatchObject({ kind: 'observed-absent' });
    expect(server.closeMock).toHaveBeenCalledOnce();
    expect(authority.admissionSnapshot().state.size).toBe(0);
  });

  it('retains a last-session shutdown hold until a later close observes absence', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        disposition: 'held-alive',
        observation: 'alive',
        subjects: [{ kind: 'claude-child', controller: 'tui', generation: 2 }],
        successor: { kind: 'accepted', owner: 'different-owner' },
        operatorExit: { kind: 'retry-broker-shutdown' },
      })
      .mockResolvedValueOnce({ ok: true, disposition: 'observed-absent' });
    const server = fakeProviderServerHandle({ request });
    vi.mocked(spawnProviderServerTransport).mockResolvedValueOnce(server.handle);
    const authority = createProxyAppServerHostAuthority(runtime);
    const opened = await selectedHostScope(authority, testKey(), 'operation-isolated').openSession(
      exclusiveSpec({
        shutdownCapability: {
          method: 'broker/shutdown',
          timeoutMs: 1_000,
          resultDisposition: {
            kind: 'provider-server-shutdown-v1',
            successorOwner: 'broker-session-pool',
            operatorExit: 'retry-broker-shutdown',
          },
        },
      }),
      { jobId: 'job-1' },
    );

    opened.close();

    await vi.waitFor(() =>
      expect(authority.listProviderHosts()).toMatchObject([
        {
          ref: opened.hostRef,
          status: 'shutdown-held',
          host: {
            owner: 'provider-proxy',
            hostKey: expect.any(String),
            ownerJobId: 'job-1',
            pid: 1_000,
            observation: 'unobservable',
            successorOwner: null,
            operatorExit: 'retry-provider-shutdown',
          },
        },
      ]),
    );
    const heldInventory = { hosts: authority.listProviderHosts() };
    expect(providerHostListResultV2Schema.safeParse(heldInventory).success).toBe(true);
    expect(providerHostListResultV1Schema.safeParse(heldInventory).success).toBe(false);
    await expect(authority.forceClose(opened.hostRef)).resolves.toMatchObject({ kind: 'observed-absent' });
    expect(authority.listProviderHosts()).toEqual([]);
  });

  it('retains a close hold when its operator exit returns a mismatched subject', async () => {
    const subject = { kind: 'process', pid: 1_000 } as const;
    const settled = new Promise<void>(() => undefined);
    const abandonment = {
      kind: 'operator-abandoned' as const,
      subject,
      processAbsenceProven: false as const,
      successor: { owner: 'operator-command' as const, acceptance: 'accepted' as const },
    };
    let abandonAttempts = 0;
    const operatorExit = {
      kind: 'abandon-provider-host-acquisition' as const,
      abandon: vi.fn(async () => {
        abandonAttempts += 1;
        return abandonAttempts === 1
          ? ({
              ...abandonment,
              subject: { kind: 'process' as const, pid: 999 },
            } as unknown as typeof abandonment)
          : abandonment;
      }),
    };
    const retry = vi.fn<() => Promise<ProviderServerFailedSpawnCleanupDisposition>>();
    retry.mockImplementation(async () => ({
      kind: 'held-alive',
      subject,
      observation: 'alive',
      operatorExit,
      settled,
      retry,
    }));
    const server = fakeProviderServerHandle({
      closeDisposition: async (acceptCleanupHold) => {
        const hold = {
          kind: 'held-alive' as const,
          subject,
          observation: 'alive' as const,
          operatorExit,
          settled,
          retry,
        };
        return { ...hold, successor: acceptCleanupHold(hold) };
      },
    });
    vi.mocked(spawnProviderServerTransport).mockResolvedValueOnce(server.handle);
    const authority = createProxyAppServerHostAuthority(runtime);
    const opened = await selectedHostScope(authority, testKey(), 'operation-isolated').openSession(sharedSpec());

    await expect(authority.forceClose(opened.hostRef)).resolves.toMatchObject({ kind: 'held-alive' });
    await expect(authority.evictHostV1(opened.hostRef)).resolves.toEqual({ kind: 'requires-v2' });
    expect(operatorExit.abandon).not.toHaveBeenCalled();
    await expect(authority.evictHost(opened.hostRef)).resolves.toEqual({
      kind: 'held',
      observation: 'alive',
      successorOwner: 'provider-proxy-root-pool',
      operatorExit: 'abandon-provider-host-acquisition',
    });
    expect(authority.listProviderHosts()).toMatchObject([{ status: 'reclamation-failed' }]);
    expect(authority.admissionSnapshot().state.size).toBe(1);
    expect(authority.admissionSnapshot().tombstones).toEqual([]);

    await expect(authority.evictHost(opened.hostRef)).resolves.toBe(abandonment);
    expect(operatorExit.abandon).toHaveBeenCalledTimes(2);
    await expect(authority.evictHost(opened.hostRef)).resolves.toBe(abandonment);
    expect(authority.terminalEviction(opened.hostRef)).toBe(abandonment);
    expect(operatorExit.abandon).toHaveBeenCalledTimes(2);
    expect(authority.listProviderHosts()).toEqual([]);
    expect(authority.admissionSnapshot().state.size).toBe(0);
    expect(authority.admissionSnapshot().tombstones).toEqual([]);
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
      roots.add(`${root.pid}@${root.incarnation}`);
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
      idleRetirement: 'unleased-and-host-idle',
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
    const sharedRetirementPolicies = ['unleased', 'unleased-and-host-idle', 'never'] as const;
    const specs: ProviderServerSpec[] = [
      ...sharedRetirementPolicies.map((idleRetirement) =>
        sharedSpec({
          env: { CORAL_ACCOUNT: 'account-a' },
          initializeRequest: { method: 'initialize', params: { clientInfo: { name: 'proxy' } } },
          initializeTimeoutMs: 5_000,
          shutdownCapability: { method: 'shutdown', timeoutMs: 1_000 },
          idleRetirement,
        }),
      ),
      exclusiveSpec({ initializeTimeoutMs: 2_500 }),
    ];

    for (const spec of specs) {
      expect(specIdentityKey(spec)).toBe(hostKeyFromSpec(spec));
      expect(specFingerprint(runtime, spec)).toBe(hostFingerprintFromSpec(spec));
    }
  });
});
