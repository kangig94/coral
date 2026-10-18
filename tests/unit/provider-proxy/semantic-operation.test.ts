import { hostFingerprintFromSpec } from '#src/providers/host-identity.js';
import { codexThreadProvider } from '#src/providers/codex/thread-provider.js';
import { commitContinuityEvent } from '#src/providers/internal/continuity-commit.js';
import { TEST_CODEX_PLAN } from '#tests/helpers/provider-credentials.js';
import { claudeSessionKernel } from '#src/providers/claude/session-kernel.js';
import { TEST_CLAUDE_PLAN } from '#tests/helpers/provider-credentials.js';
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

import type { ProviderResponseDiagnosticFact } from '#src/providers/host-diagnostics.js';
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
  HostRef,
  ProviderEventBody,
  ProviderServerSpec,
  ProviderSteeringPort,
  ProviderSendOutcome,
} from '#src/providers/contract.js';
import {
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
  decodeProxyControlFrame,
  providerEventRequestSchema,
  proxyOperationPreparePendingResultSchema,
  type OperationIdentity,
  type ProxyPreparedAppServerOperation,
} from '#src/provider-proxy/protocol.js';
import { OperationSupervisor } from '#src/provider-proxy/operation-supervisor.js';
import { type ProxyAppServerHostAuthority } from '#src/provider-proxy/provider-root-authority.js';
import {
  createSemanticOperationRuntime,
  SEMANTIC_OPERATION_SEND_TIMEOUT_MS,
} from '#src/provider-proxy/semantic-operation-runner.js';
import {
  asJointActivationReceipt,
  asJointContainmentReceipt,
  asReservation,
} from '#tests/helpers/provider-proxy-correlation.js';

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
      cwd: fixtureCanonicalWorkDir(process.cwd()),
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
  send?: BoundProviderAppServerCapability['send'];
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
      openReplacement: options.openReplacement ?? (async () => ({ hostRef: fakeHostRef(name), close: vi.fn() })),
      send: options.send ?? unreachable('appServer.send'),
      interrupt: unreachable('appServer.interrupt') as unknown as BoundProviderAppServerCapability['interrupt'],
    },
    artifacts: { kind: 'none', reason: 'test double' },
  };
}

function fakeHostSpec(provider = 'claude'): ProviderServerSpec {
  return {
    provider,
    command: provider,
    args: ['app-server'],
    cwd: fixtureCanonicalWorkDir(process.cwd()),
    leaseMode: 'job-exclusive',
  };
}

function fakeHostRef(provider = 'claude'): HostRef {
  return {
    provider,
    fingerprint: hostFingerprintFromSpec(fakeHostSpec(provider)),
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
  const reserved = ledger.prepare({
    key,
    reservation: asReservation('40000000-0000-4000-8000-000000000001'),
    prepared,
    nowMs: 0,
  });
  if (reserved.kind !== 'reserved') throw new Error('expected a reservation');
  ledger.recordPreparation(key, { pid: 1, incarnation: testIncarnation(1) }, asJointContainmentReceipt('contained'));
  const fingerprint = 'f'.repeat(64);
  ledger.beginActivation(key, asReservation('40000000-0000-4000-8000-000000000001'), 0, fingerprint);
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

const supervisorTimer: ControlEndpointTimer = {
  setTimeout: () => ({}),
  clearTimeout: () => {},
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

const terminalCompleted: ProviderEventBody = {
  kind: 'terminal',
  terminal: { content: 'done', durationMs: 5, outcome: { kind: 'completed' } },
  diagnostics: {},
};

// --- pump loop outcomes ------------------------------------------------------------------------------------

describe('semantic-operation runtime: pump loop outcomes', () => {
  it('synthesizes a failed terminal when a started provider stream ends without completion', async () => {
    const { proxy, ledger, emittedEvents } = createTestProxy();
    const key = testKey();
    const prepared = preparedFixture();
    prepareAndActivate(ledger, key, prepared);
    const closed = deferred();
    const closeStaged = vi.fn(() => {
      closed.resolve();
    });
    const stagedHostRef = fakeHostRef();

    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: fakeBoundProvider({
        execute: async function* () {},
        openReplacement: async () => ({ hostRef: stagedHostRef, close: closeStaged }),
      }),
    });

    const host = createSemanticOperationRuntime({
      hostRoot: '/test/plugin',
      hostFingerprint: hostFingerprintFromSpec(fakeHostSpec()),
      runtime,
      hostAuthority: fakeHostAuthority(),
      getProxy: () => proxy,
    });
    await host.ensureProviderRoot(key, prepared);
    const start = host.host.start({ key, prepared });

    await expect(start.result).resolves.toEqual({ kind: 'started', hostRef: stagedHostRef });
    await closed.promise;
    expect(closeStaged).toHaveBeenCalledOnce();
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
});

// --- pre-consumption replay admission ------------------------------------------------------------------------

describe('semantic-operation runtime: replay admission', () => {
  it('turns replay refusal into exactly one emergency terminal without pulling the provider terminal', async () => {
    const operation = supervisedOperation(99);
    const key = { jobId: operation.jobId, operationId: operation.operationId };
    const prepared = preparedFixture();
    const gate = deferred();
    const completed = deferred();
    let pullCount = 0;
    const progressEvent: ProviderEventBody = { kind: 'progress', message: 'first' };
    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: fakeBoundProvider({
        openReplacement: async () => ({
          hostRef: fakeHostRef(),
          close: () => {
            completed.resolve();
          },
        }),
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
      hostRoot: '/test/plugin',
      hostFingerprint: hostFingerprintFromSpec(fakeHostSpec()),
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
      hostFingerprint: hostFingerprintFromSpec(fakeHostSpec()),
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
    vi.spyOn(supervisor.ledger(), 'recordEvent').mockImplementationOnce(() => {
      throw new ReplayAdmissionError('operation-events', 'replay exhausted');
    });
    gate.resolve();

    await completed.promise;
    await semantic.shutdown('queue_shutdown');

    const entry = supervisor.ledger().get(key);
    expect({
      state: entry?.state,
      eventCount: entry?.bufferedEvents.length,
      pullCount,
    }).toEqual({
      state: 'terminal-awaiting-settlement',
      eventCount: 1,
      pullCount: 1,
    });
    const emergency = entry?.bufferedEvents.at(-1);
    if (emergency === undefined) throw new Error('Expected a proxy-emergency terminal.');
    const decoded = decodeProxyControlFrame(emergency.frame);
    if (!('params' in decoded)) throw new Error('Expected a provider event request.');
    expect(providerEventRequestSchema.parse(decoded.params)).toMatchObject({
      providerSeq: 1,
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
  });
});

it.each(['config-error', 'abort-before-turn', 'completed-turn'])(
  'settles Codex after %s without relinquishing the proxy',
  async (scenario) => {
    const { proxy, emittedEvents } = createTestProxy();
    // These event-only probes exercise host cleanup; the ledger seam does not need wire activation.
    proxy.emitProviderEvent = (key, event) => {
      emittedEvents.push({ key, event });
      if (event.kind === 'continuity') commitContinuityEvent(event);
      return { kind: 'recorded', providerSeq: emittedEvents.length };
    };
    const key = testKey();
    const prepared = preparedFixture({
      provider: 'codex',
      binding: { provider: 'codex', kind: 'account', binding: {} },
    });
    const relinquish = vi.fn();
    const rpc = vi.fn(async (method: string) => {
      if (method === 'config/read') {
        if (scenario === 'config-error') throw new Error('config read rejected');
        return { config: {} };
      }
      if (method === 'model/list') return { data: [], nextCursor: null };
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'completed' } };
      throw new Error('unexpected RPC ' + method);
    });
    const bound = fakeBoundProvider({
      name: 'codex',
      supportsInterrupt: true,
      execute: (executionRuntime) =>
        codexThreadProvider({ ...prepared.request, name: 'codex' }, {
          ...executionRuntime,
          executionPlan: TEST_CODEX_PLAN,
          appServerSession: {
            rpc,
            subscribe: () => () => {},
            closed: new Promise(() => {}),
            interrupt: async () => ({ kind: 'accepted' as const }),
          },
        } as never),
    });
    providerRegistryDouble.rehydrateBinding.mockReturnValue({ ok: true, value: bound });
    const semantic = createSemanticOperationRuntime({
      hostRoot: '/test/plugin',
      hostFingerprint: hostFingerprintFromSpec(fakeHostSpec()),
      runtime,
      hostAuthority: fakeHostAuthority(),
      getProxy: () => proxy,
      onRelinquish: relinquish,
    });
    await semantic.ensureProviderRoot(key, prepared);
    const start = semantic.host.start({ key, prepared });
    await start.result;
    // Stop only after host acquisition and before any turn submission.
    if (scenario === 'abort-before-turn')
      await Promise.resolve(semantic.host.stop({ key, cause: 'signal_abort' })).catch(() => {});
    await vi.waitFor(() => expect(emittedEvents.some(({ event }) => event.kind === 'terminal')).toBe(true));
    const cleanup = await start.abortAndRelease().then(
      () => ({ kind: 'released' }),
      (error) => ({ kind: 'held', message: error.message }),
    );
    expect.soft(relinquish).not.toHaveBeenCalled();
    expect(cleanup).toEqual({ kind: 'released' });
  },
);

it('releases a Claude session/ensure failure before turn/start', async () => {
  const { proxy, emittedEvents } = createTestProxy();
  proxy.emitProviderEvent = (key, event) => {
    emittedEvents.push({ key, event });
    return { kind: 'recorded', providerSeq: emittedEvents.length };
  };
  const key = testKey();
  const prepared = preparedFixture();
  const rpc = vi.fn(async () => {
    throw new Error('session ensure rejected');
  });
  providerRegistryDouble.rehydrateBinding.mockReturnValue({
    ok: true,
    value: fakeBoundProvider({
      name: 'claude',
      supportsInterrupt: true,
      execute: (executionRuntime) =>
        claudeSessionKernel({ ...prepared.request, name: 'claude' }, {
          ...executionRuntime,
          executionPlan: TEST_CLAUDE_PLAN,
          appServerSession: {
            rpc,
            subscribe: () => () => {},
            closed: new Promise(() => {}),
            interrupt: async () => ({ kind: 'accepted' }),
          },
        } as never),
    }),
  });
  const relinquish = vi.fn();
  const semantic = createSemanticOperationRuntime({
    hostRoot: '/test/plugin',
    hostFingerprint: hostFingerprintFromSpec(fakeHostSpec()),
    runtime,
    hostAuthority: fakeHostAuthority(),
    getProxy: () => proxy,
    onRelinquish: relinquish,
  });
  await semantic.ensureProviderRoot(key, prepared);
  const start = semantic.host.start({ key, prepared });
  await start.result;
  await vi.waitFor(() => expect(emittedEvents.some((e) => e.event.kind === 'terminal')).toBe(true));
  const cleanup = await start.abortAndRelease().then(
    () => ({ kind: 'released' }),
    (error) => ({ kind: 'held', message: error.message }),
  );
  expect.soft(relinquish).not.toHaveBeenCalled();
  expect(cleanup).toEqual({ kind: 'released' });
});

it('releases a pre-turn config failure through the real operation supervisor', async () => {
  const operation = supervisedOperation(1);
  const key = { jobId: operation.jobId, operationId: operation.operationId };
  const prepared = preparedFixture({ provider: 'codex', binding: { provider: 'codex', kind: 'account', binding: {} } });
  const rpc = vi.fn(async () => {
    throw new Error('config read rejected');
  });
  const closeStaged = vi.fn();
  providerRegistryDouble.rehydrateBinding.mockReturnValue({
    ok: true,
    value: fakeBoundProvider({
      name: 'codex',
      supportsInterrupt: true,
      openReplacement: async () => ({ hostRef: fakeHostRef('codex'), close: closeStaged }),
      execute: (executionRuntime) =>
        codexThreadProvider({ ...prepared.request, name: 'codex' }, {
          ...executionRuntime,
          executionPlan: TEST_CODEX_PLAN,
          appServerSession: {
            rpc,
            subscribe: () => () => {},
            closed: new Promise(() => {}),
            interrupt: async () => ({ kind: 'accepted' }),
          },
        } as never),
    }),
  });
  const proxy = {} as Proxy;
  const relinquish = vi.fn();
  const semantic = createSemanticOperationRuntime({
    hostRoot: '/test/plugin',
    hostFingerprint: hostFingerprintFromSpec(fakeHostSpec('codex')),
    runtime,
    hostAuthority: fakeHostAuthority(),
    getProxy: () => proxy,
    onRelinquish: relinquish,
  });
  const supervisor = new OperationSupervisor({
    host: semantic.host,
    timer: supervisorTimer,
    mintReservation: () => asReservation('40000000-0000-4000-8000-000000000001'),
    wallClockNow: () => 0,
    nowMs: () => 0,
    proxyInstanceId: operation.proxyInstanceId,
    buildSetId: operation.buildSetId,
    stageProviderRoot: (stagedKey, reserved) => {
      const stage = semantic.stage(stagedKey, reserved.prepared);
      return {
        result: stage.result.then((staged) =>
          staged.state !== 'staged' ? staged : { ...staged, receipt: asJointContainmentReceipt('contained') },
        ),
        confirmActivation: async () => {},
        abortAndRelease: () => stage.abortAndRelease(),
      };
    },
    pushProviderEvent: () => {
      throw new ControlEndpointError('control_endpoint_push_no_tenancy', 'offline test transport');
    },
    faultProviderEventControl: () => {},
  });
  Object.assign(proxy, {
    listen: async () => {},
    close: async () => {},
    ledger: () => supervisor.ledger(),
    emitProviderEvent: (k: ProviderOperationKey, e: ProviderEventBody) => supervisor.emitProviderEvent(k, e),
  });
  const reservation = proxyOperationPreparePendingResultSchema.parse(
    await supervisor.prepare(operation, {
      prepareAttemptNumber: 1,
      prepareAttemptKey: operationPrepareAttemptKey({
        operation,
        hostFingerprint: hostFingerprintFromSpec(fakeHostSpec('codex')),
        prepareAttemptNumber: 1,
        prepared,
      }),
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
  await vi.waitFor(() => expect(supervisor.ledger().get(key)?.completionRecorded).toBe(true));
  const seq = supervisor.ledger().nextProviderSeq(key) - 1;
  const attempts = [];
  for (let i = 0; i < 3; i++)
    attempts.push(
      await supervisor.settle(operation, seq).then(
        (value) => ({ kind: 'released', value }),
        (error) => ({ kind: 'held', message: error.message }),
      ),
    );
  expect(supervisor.ledger().get(key)).toBeNull();
  const nextJob = await Promise.resolve()
    .then(() => semantic.ensureProviderRoot({ ...key, jobId: 'job-next' }, prepared))
    .then(
      () => ({ kind: 'admitted' }),
      (error) => ({ kind: 'refused', message: error.message }),
    );
  expect.soft(relinquish).not.toHaveBeenCalled();
  expect.soft(nextJob).toEqual({ kind: 'admitted' });
  expect(attempts[0]).toMatchObject({ kind: 'released' });
});

it.each(['submitted', 'unknown'] as const)('requires cessation evidence for a %s turn start', async (submission) => {
  const { proxy, emittedEvents } = createTestProxy();
  proxy.emitProviderEvent = (key, event) => {
    emittedEvents.push({ key, event });
    return { kind: 'recorded', providerSeq: emittedEvents.length };
  };
  providerRegistryDouble.rehydrateBinding.mockReturnValue({
    ok: true,
    value: fakeBoundProvider({
      supportsInterrupt: true,
      execute: async function* (executionRuntime) {
        if (submission === 'submitted') executionRuntime.onProviderTurnStart?.();
        yield terminalCompleted;
      },
    }),
  });
  const key = testKey();
  const prepared = preparedFixture();
  const relinquish = vi.fn();
  const semantic = createSemanticOperationRuntime({
    hostRoot: '/test/plugin',
    hostFingerprint: hostFingerprintFromSpec(fakeHostSpec()),
    runtime,
    hostAuthority: fakeHostAuthority(),
    getProxy: () => proxy,
    onRelinquish: relinquish,
  });
  await semantic.ensureProviderRoot(key, prepared);
  const start = semantic.host.start({ key, prepared });
  await start.result;
  await vi.waitFor(() => expect(emittedEvents.some(({ event }) => event.kind === 'terminal')).toBe(true));
  await expect(start.abortAndRelease()).rejects.toMatchObject({ code: 'semantic_operation_cancellation_unconfirmed' });
  expect(relinquish).toHaveBeenCalledOnce();
});

it('refuses a compiled fingerprint mismatch with local fallback before opening a host', async () => {
  const close = vi.fn();
  const open = vi.fn(async () => ({ hostRef: fakeHostRef(), close }));
  const execute = vi.fn(async function* () {});
  providerRegistryDouble.rehydrateBinding.mockReturnValue({
    ok: true,
    value: fakeBoundProvider({ execute, openReplacement: open }),
  });
  const { proxy } = createTestProxy();
  const semantic = createSemanticOperationRuntime({
    runtime,
    hostRoot: '/retained/build',
    hostFingerprint: 'b'.repeat(64),
    hostAuthority: fakeHostAuthority(),
    getProxy: () => proxy,
  });
  const stage = semantic.stage(testKey(), preparedFixture());
  await expect(stage.result).resolves.toMatchObject({
    state: 'permanent-refusal',
    code: 'proxy_prepare_refused',
    disposition: 'local-fallback',
    reason: expect.stringContaining('provider_host_fingerprint_mismatch'),
  });
  await stage.abortAndRelease();
  expect(execute).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});

describe('semantic-operation send admission', () => {
  const input = { text: 'Change direction', clientMessageId: '33333333-3333-4333-8333-333333333333' };
  const continuity = { cwd: '/workspace', threadId: 'thread-current', turnId: 'turn-current' };

  async function fixture(
    options: {
      provider?: 'codex' | 'claude';
      supportsInterrupt?: boolean;
      steering?: ProviderSteeringPort | null;
      continuity?: Record<string, unknown> | null;
      clearTurn?: boolean;
      send?: BoundProviderAppServerCapability['send'];
    } = {},
  ) {
    const { proxy, ledger, emittedEvents } = createTestProxy();
    const key = testKey();
    const provider = options.provider ?? 'codex';
    const prepared = preparedFixture({ provider, persistedContinuity: { threadId: 'old', turnId: 'old' } });
    prepareAndActivate(ledger, key, prepared);
    const submit = deferred();
    const submitted = deferred();
    const checkpoint = deferred();
    const checkpointSeen = deferred();
    const ack = deferred();
    const checkpointCommitted = deferred();
    const clearTurn = deferred();
    const turnCleared = deferred();
    const finish = deferred();
    const closed = deferred();
    const closeStaged = vi.fn(() => closed.resolve());
    const send = vi.fn<BoundProviderAppServerCapability['send']>(
      options.send ?? (async (): Promise<ProviderSendOutcome> => ({ state: 'delivered' })),
    );
    const steering =
      options.steering === undefined
        ? {
            admit: vi.fn(() => ({ state: 'admitted' as const })),
            reportOutcome: vi.fn(),
          }
        : options.steering;
    const emit = proxy.emitProviderEvent;
    proxy.emitProviderEvent = (eventKey, event) => {
      const result = emit(eventKey, event);
      if (event.kind !== 'continuity' || result.kind !== 'recorded') return result;
      checkpointSeen.resolve();
      return {
        kind: 'continuity-recorded',
        providerSeq: result.providerSeq,
        settlement: { providerSeq: result.providerSeq, committed: ack.promise, reject: unreachable('commit reject') },
      };
    };
    let executionRuntime!: BoundProviderAppServerExecutionRuntime;
    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: fakeBoundProvider({
        name: provider,
        supportsInterrupt: options.supportsInterrupt,
        send,
        openReplacement: async () => ({ hostRef: fakeHostRef(provider), close: closeStaged }),
        execute: async function* (activeRuntime) {
          executionRuntime = activeRuntime;
          if (steering !== null) activeRuntime.onProviderSteering?.(steering);
          await submit.promise;
          activeRuntime.onProviderTurnStart?.();
          submitted.resolve();
          await checkpoint.promise;
          yield {
            kind: 'continuity',
            conversationRef: 'thread-current',
            resumable: true,
            providerContinuity: options.continuity === undefined ? continuity : options.continuity,
          };
          checkpointCommitted.resolve();
          if (options.clearTurn) {
            await clearTurn.promise;
            yield {
              kind: 'continuity',
              conversationRef: 'thread-current',
              resumable: true,
              providerContinuity: { threadId: 'thread-current' },
            };
            turnCleared.resolve();
          }
          await finish.promise;
          yield terminalCompleted;
        },
      }),
    });
    const hostAuthority = fakeHostAuthority();
    const forceClose = vi.spyOn(hostAuthority, 'forceClose');
    const semantic = createSemanticOperationRuntime({
      runtime,
      hostAuthority,
      hostRoot: '/plugin',
      hostFingerprint: hostFingerprintFromSpec(fakeHostSpec(provider)),
      getProxy: () => proxy,
    });
    await semantic.ensureProviderRoot(key, prepared);
    const beforeStart = semantic.host.admitSend!({ key, input });
    const start = semantic.host.start({ key, prepared });
    await start.result;
    return {
      semantic,
      send,
      steering,
      beforeStart,
      executionRuntime,
      closeStaged,
      forceClose,
      emittedEvents,
      admit: () => semantic.host.admitSend!({ key, input }),
      sendMessage: () => {
        const admission = semantic.host.admitSend!({ key, input });
        return admission.state === 'admitted' ? admission.write() : Promise.resolve(admission);
      },
      submit: async () => {
        submit.resolve();
        await submitted.promise;
      },
      checkpoint: async () => {
        checkpoint.resolve();
        await checkpointSeen.promise;
      },
      ack: async () => {
        ack.resolve();
        await checkpointCommitted.promise;
      },
      clearTurn: async () => {
        clearTurn.resolve();
        await turnCleared.promise;
      },
      release: () => start.abortAndRelease(),
      close: async () => {
        submit.resolve();
        checkpoint.resolve();
        ack.resolve();
        clearTurn.resolve();
        finish.resolve();
        await closed.promise;
      },
    };
  }

  it('refuses before start, submission and checkpoint ACK instead of using prepared continuity', async () => {
    const h = await fixture();
    expect(h.beforeStart).toMatchObject({ state: 'refused', code: 'turn_not_started' });
    expect(h.admit()).toMatchObject({ state: 'refused', code: 'turn_not_started' });
    await h.submit();
    expect(h.admit()).toMatchObject({ state: 'refused', code: 'turn_not_started' });
    await h.checkpoint();
    expect(h.admit()).toMatchObject({ state: 'refused', code: 'turn_not_started' });
    expect(h.send).not.toHaveBeenCalled();
    await h.ack();
    await expect(h.sendMessage()).resolves.toEqual({ state: 'delivered', providerTurnId: 'turn-current' });
    expect(h.steering?.admit).toHaveBeenCalledWith(continuity, input.clientMessageId);
    await h.close();
  });

  it('uses committed Claude brokerTurnId for send without requiring a Codex turnId', async () => {
    const claudeContinuity = { brokerSessionKey: 'broker-current', brokerTurnId: 'claude-turn-current' };
    const h = await fixture({ provider: 'claude', continuity: claudeContinuity });
    try {
      await h.submit();
      await h.checkpoint();
      expect(h.admit()).toMatchObject({ state: 'refused', code: 'turn_not_started' });
      await h.ack();
      await expect(h.sendMessage()).resolves.toEqual({ state: 'delivered', providerTurnId: 'claude-turn-current' });
      expect(h.steering?.admit).toHaveBeenCalledWith(claudeContinuity, input.clientMessageId);
      expect(h.send.mock.calls[0]?.[1]).toEqual(claudeContinuity);
    } finally {
      await h.close();
    }
  });

  it.each([true, false])(
    'sends with the exact retained host and original preparation in interrupt mode %s',
    async (supportsInterrupt) => {
      const h = await fixture({ supportsInterrupt });
      await h.submit();
      await h.checkpoint();
      await h.ack();
      await h.sendMessage();
      expect(h.send).toHaveBeenCalledExactlyOnceWith(
        fakeHostRef('codex'),
        continuity,
        input,
        expect.objectContaining({ jobId: 'job-1', persistedContinuity: { threadId: 'old', turnId: 'old' } }),
        expect.any(AbortSignal),
      );
      expect(h.steering?.reportOutcome).toHaveBeenCalledWith(input.clientMessageId, { state: 'delivered' });
      expect(h.executionRuntime.signal.aborted).toBe(false);
      expect(h.forceClose).not.toHaveBeenCalled();
      expect(h.closeStaged).not.toHaveBeenCalled();
      expect(h.emittedEvents.filter(({ event }) => event.kind === 'progress')).toEqual([]);
      await h.close();
    },
  );

  it.each([
    { state: 'delivered' },
    { state: 'refused', code: 'turn_ended', reason: 'The Claude segment ended before the write.' },
    { state: 'unknown', reason: 'The Claude broker reply was lost.' },
  ] satisfies ProviderSendOutcome[])(
    'records a Claude send before the facet and preserves its $state outcome across repeats and terminal',
    async (outcome) => {
      const operation = supervisedOperation(1);
      const key = { jobId: operation.jobId, operationId: operation.operationId };
      const prepared = preparedFixture();
      const claudeContinuity = { brokerSessionKey: 'broker-current', brokerTurnId: 'claude-turn-current' };
      const finish = deferred();
      const answer = deferred<ProviderSendOutcome>();
      const steering = { admit: vi.fn(() => ({ state: 'admitted' as const })), reportOutcome: vi.fn() };
      const send = vi.fn<BoundProviderAppServerCapability['send']>();
      const openReplacement = vi.fn(async () => ({ hostRef: fakeHostRef(), close: vi.fn() }));
      providerRegistryDouble.rehydrateBinding.mockReturnValue({
        ok: true,
        value: fakeBoundProvider({
          supportsInterrupt: true,
          openReplacement,
          send,
          execute: async function* (executionRuntime) {
            executionRuntime.onProviderSteering?.(steering);
            executionRuntime.onProviderTurnStart?.();
            yield {
              kind: 'continuity',
              conversationRef: 'claude-session',
              resumable: true,
              providerContinuity: claudeContinuity,
            };
            await finish.promise;
            executionRuntime.onProviderTurnTerminal({
              kind: 'provider-turn-terminal',
              providerTurnId: claudeContinuity.brokerTurnId,
              status: 'completed',
            });
            yield terminalCompleted;
          },
        }),
      });
      const proxy = {} as Proxy;
      const hostAuthority = fakeHostAuthority();
      const forceClose = vi.spyOn(hostAuthority, 'forceClose');
      const semantic = createSemanticOperationRuntime({
        hostRoot: '/test/plugin',
        hostFingerprint: hostFingerprintFromSpec(fakeHostSpec()),
        runtime,
        hostAuthority,
        getProxy: () => proxy,
      });
      const supervisor = new OperationSupervisor({
        host: semantic.host,
        timer: supervisorTimer,
        mintReservation: () => asReservation('40000000-0000-4000-8000-000000000001'),
        wallClockNow: () => 0,
        nowMs: () => 0,
        proxyInstanceId: operation.proxyInstanceId,
        buildSetId: operation.buildSetId,
        stageProviderRoot: (stagedKey, reserved) => {
          const stage = semantic.stage(stagedKey, reserved.prepared);
          return {
            result: stage.result.then((staged) =>
              staged.state !== 'staged' ? staged : { ...staged, receipt: asJointContainmentReceipt('contained') },
            ),
            confirmActivation: async () => {},
            abortAndRelease: () => stage.abortAndRelease(),
          };
        },
        pushProviderEvent: unreachable('unadvanced supervisor pump'),
        faultProviderEventControl: unreachable('provider event control fault'),
      });
      Object.assign(proxy, {
        ledger: () => supervisor.ledger(),
        emitProviderEvent: (eventKey: ProviderOperationKey, event: ProviderEventBody) =>
          supervisor.emitProviderEvent(eventKey, event),
      });
      send.mockImplementation(async (hostRef, currentContinuity, sentInput) => {
        expect(hostRef).toEqual(fakeHostRef());
        expect(currentContinuity).toEqual(claudeContinuity);
        expect(sentInput).toEqual(input);
        const buffered = supervisor.ledger().get(key)?.bufferedEvents ?? [];
        expect(buffered).toHaveLength(1);
        const record = providerEventRequestSchema.parse((JSON.parse(buffered[0].frame) as { params: unknown }).params);
        expect(record).toMatchObject({
          providerSeq: 2,
          event: { kind: 'progress', message: expect.stringContaining(`Sending message ${input.clientMessageId}`) },
        });
        expect(buffered[0].frame).toContain('This line does not prove delivery.');
        return answer.promise;
      });
      try {
        const reservation = proxyOperationPreparePendingResultSchema.parse(
          await supervisor.prepare(operation, {
            prepareAttemptNumber: 1,
            prepareAttemptKey: operationPrepareAttemptKey({
              operation,
              hostFingerprint: hostFingerprintFromSpec(fakeHostSpec()),
              prepareAttemptNumber: 1,
              prepared,
            }),
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
        await vi.waitFor(() => expect(supervisor.ledger().nextProviderSeq(key)).toBe(2));
        expect(semantic.host.admitSend!({ key, input })).toMatchObject({ state: 'refused', code: 'turn_not_started' });
        await supervisor.attach(operation, 1);
        await vi.waitFor(() => expect(semantic.host.admitSend!({ key, input }).state).toBe('admitted'));

        const pending = supervisor.send(operation, input);
        expect(supervisor.send(operation, input)).toBe(pending);
        expect(send).toHaveBeenCalledOnce();
        finish.resolve();
        await vi.waitFor(() => expect(supervisor.ledger().get(key)?.completionRecorded).toBe(true));
        expect(supervisor.send(operation, input)).toBe(pending);
        answer.resolve(outcome);
        await expect(pending).resolves.toEqual(
          outcome.state === 'delivered' ? { ...outcome, providerTurnId: claudeContinuity.brokerTurnId } : outcome,
        );
        expect(supervisor.send(operation, input)).toBe(pending);
        expect(
          supervisor
            .ledger()
            .get(key)
            ?.bufferedEvents.map(({ providerSeq }) => providerSeq),
        ).toEqual([2, 3]);
        expect(send).toHaveBeenCalledOnce();
        expect(openReplacement).toHaveBeenCalledOnce();
        expect(forceClose).not.toHaveBeenCalled();
        await supervisor.attach(operation, 3);
        await expect(supervisor.settle(operation, 3)).resolves.toMatchObject({
          state: 'released-after-terminal',
          settledThroughProviderSeq: 3,
        });
      } finally {
        answer.resolve(outcome);
        finish.resolve();
        supervisor.close();
      }
    },
  );

  it('passes a kernel final-answer refusal through without invoking the facet', async () => {
    const reportOutcome = vi.fn();
    const refusal = { state: 'refused' as const, code: 'turn_ended' as const, reason: 'Final answer already seen.' };
    const h = await fixture({ steering: { admit: () => refusal, reportOutcome } });
    await h.submit();
    await h.checkpoint();
    await h.ack();
    expect(h.admit()).toEqual(refusal);
    expect(h.send).not.toHaveBeenCalled();
    expect(reportOutcome).not.toHaveBeenCalled();
    await h.close();
  });

  it('releases the kernel steering latch when the supervisor refuses record admission without writing', async () => {
    const h = await fixture();
    await h.submit();
    await h.checkpoint();
    await h.ack();
    const admission = h.admit();
    if (admission.state !== 'admitted') throw new Error('Expected send admission');
    const refusal = { state: 'refused', code: 'control_unavailable', reason: 'Replay budget exhausted.' } as const;
    admission.refuse(refusal);
    expect(h.steering?.reportOutcome).toHaveBeenCalledExactlyOnceWith(input.clientMessageId, refusal);
    expect(h.send).not.toHaveBeenCalled();
    await h.close();
  });

  it('refuses a thread checkpoint without a current turn as not started', async () => {
    const h = await fixture({ continuity: { threadId: 'thread-current' } });
    await h.submit();
    await h.checkpoint();
    await h.ack();
    expect(h.admit()).toMatchObject({ state: 'refused', code: 'turn_not_started' });
    expect(h.send).not.toHaveBeenCalled();
    await h.close();
  });

  it('refuses an unsupported provider without steering or writing', async () => {
    const h = await fixture({ steering: null });
    await h.submit();
    await h.checkpoint();
    await h.ack();
    expect(h.admit()).toMatchObject({ state: 'refused', code: 'transport_unsupported' });
    expect(h.send).not.toHaveBeenCalled();
    await h.close();
  });

  it('refuses a cleared active turn instead of reusing its prior committed identity', async () => {
    const h = await fixture({ clearTurn: true });
    await h.submit();
    await h.checkpoint();
    await h.ack();
    await h.clearTurn();
    expect(h.admit()).toMatchObject({ state: 'refused', code: 'turn_ended' });
    expect(h.send).not.toHaveBeenCalled();
    await h.close();
  });

  it.each(['stop', 'release'] as const)('refuses while %s is draining without invoking send', async (action) => {
    const h = await fixture();
    await h.submit();
    await h.checkpoint();
    await h.ack();
    const draining = action === 'stop' ? h.semantic.host.stop({ key: testKey(), cause: 'user_abort' }) : h.release();
    expect(h.admit()).toMatchObject({ state: 'refused', code: 'turn_ended' });
    expect(h.send).not.toHaveBeenCalled();
    await h.close();
    await draining;
  });

  it('refuses immediately on a provider terminal and after release', async () => {
    const h = await fixture();
    await h.submit();
    await h.checkpoint();
    await h.ack();
    h.executionRuntime.onProviderTurnTerminal({
      kind: 'provider-turn-terminal',
      providerTurnId: 'turn-current',
      status: 'completed',
    });
    expect(h.admit()).toMatchObject({ state: 'refused', code: 'turn_ended' });
    expect(h.send).not.toHaveBeenCalled();
    await h.close();
    expect(h.admit()).toMatchObject({ state: 'refused', code: 'turn_ended' });
  });

  it.each(['delivered', 'refused', 'unknown'] as const)('reports the %s facet outcome to the kernel', async (state) => {
    const outcome: ProviderSendOutcome =
      state === 'refused'
        ? { state, code: 'provider_rejected', reason: 'Provider rejection' }
        : state === 'unknown'
          ? { state, reason: 'No answer' }
          : { state };
    const h = await fixture({ send: async () => outcome });
    await h.submit();
    await h.checkpoint();
    await h.ack();
    await expect(h.sendMessage()).resolves.toMatchObject(outcome);
    expect(h.steering?.reportOutcome).toHaveBeenCalledExactlyOnceWith(input.clientMessageId, outcome);
    await h.close();
  });

  it.each(['throw', 'malformed'] as const)(
    'returns unknown as a value for a %s facet failure after admission',
    async (failure) => {
      const h = await fixture({
        send: async () => {
          if (failure === 'throw') throw new Error('Write may have started');
          return { state: 'invalid' } as unknown as ProviderSendOutcome;
        },
      });
      await h.submit();
      await h.checkpoint();
      await h.ack();
      await expect(h.sendMessage()).resolves.toMatchObject({ state: 'unknown' });
      expect(h.steering?.reportOutcome).toHaveBeenCalledWith(
        input.clientMessageId,
        expect.objectContaining({ state: 'unknown' }),
      );
      expect(h.executionRuntime.signal.aborted).toBe(false);
      expect(h.forceClose).not.toHaveBeenCalled();
      await h.close();
    },
  );

  it('bounds a hung attempt, reports unknown once and ignores a late rejection without aborting the operation', async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const answer = new Promise<ProviderSendOutcome>((_resolve, fail) => {
      reject = fail;
    });
    const h = await fixture({ send: () => answer });
    await h.submit();
    await h.checkpoint();
    await h.ack();
    const pending = h.sendMessage();
    await vi.advanceTimersByTimeAsync(SEMANTIC_OPERATION_SEND_TIMEOUT_MS);
    await expect(pending).resolves.toMatchObject({ state: 'unknown' });
    expect(h.send.mock.calls[0]?.[4]?.aborted).toBe(true);
    expect(h.executionRuntime.signal.aborted).toBe(false);
    expect(h.forceClose).not.toHaveBeenCalled();
    expect(h.closeStaged).not.toHaveBeenCalled();
    reject(new Error('late provider failure'));
    await Promise.resolve();
    expect(h.steering?.reportOutcome).toHaveBeenCalledTimes(1);
    await h.close();
  });
});
