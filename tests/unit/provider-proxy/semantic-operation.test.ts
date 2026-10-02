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
import type { HostRef, ProviderEventBody, ProviderServerSpec } from '#src/providers/contract.js';
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
import {
  specFingerprint,
  specIdentityKey,
  type ProxyAppServerHostAuthority,
} from '#src/provider-proxy/provider-root-authority.js';
import { createSemanticOperationRuntime } from '#src/provider-proxy/semantic-operation-runner.js';
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
    cwd: fixtureCanonicalWorkDir(process.cwd()),
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

    const host = createSemanticOperationRuntime({ runtime, hostAuthority: fakeHostAuthority(), getProxy: () => proxy });
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
