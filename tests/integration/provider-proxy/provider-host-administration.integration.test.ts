import type { ProcessIncarnation } from '#src/infra/node-process.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { strictControlExchangeResult as strictTestExchange } from '#tests/support/control-exchange.js';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('#src/providers/app-server-transport.js', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, spawnProviderServerTransport: vi.fn() };
});

vi.mock('#src/infra/node-process.js', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    probeProcessIncarnation: vi.fn(() => 'linux:00000000-0000-4000-8000-000000000000:1700000000' as ProcessIncarnation),
  };
});

import { createProviderProxySetAuthority } from '#src/coordinator/live/provider-proxy/set-authority.js';
import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { spawnProviderServerTransport, type ProviderServerHandle } from '#src/providers/app-server-transport.js';
import type { HostRef, ProviderServerSpec } from '#src/providers/contract.js';
import type { ProviderResponseDiagnosticFact } from '#src/providers/host-diagnostics.js';
import type { ControlClient } from '#src/provider-proxy/control-client.js';
import { connectControlClient } from '#src/provider-proxy/control-client.js';
import type { ControlEndpointTimer } from '#src/provider-proxy/control-endpoint.js';
import type { ProxyBootstrapCapsule } from '#src/provider-proxy/bootstrap-capsule.js';
import { createProxy } from '#src/provider-proxy/proxy.js';
import type { SemanticOperationHost } from '#src/provider-proxy/operation-supervisor.js';
import { createProxyAppServerHostAuthority } from '#src/provider-proxy/provider-root-authority.js';
import type {
  CoordinatorIdentity,
  GuardianIdentity,
  ProxyIdentity,
  ReaperIdentity,
} from '#src/provider-proxy/protocol.js';
import { asReservation } from '#tests/helpers/provider-proxy-correlation.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

const timer: ControlEndpointTimer = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

const buildSetId = '44444444-4444-4444-8444-444444444444';
const proxyInstanceId = '33333333-3333-4333-8333-333333333333';
const hostRef: HostRef = {
  provider: 'codex',
  fingerprint: 'a'.repeat(64),
  instanceId: 'host-instance',
  leaseMode: 'shared',
};
const providerSpec: ProviderServerSpec = {
  provider: 'codex',
  command: 'codex',
  args: ['app-server'],
  cwd: fixtureCanonicalWorkDir('/workspace'),
  leaseMode: 'shared',
  idleRetirement: 'never',
};

const releasedV0109NonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const releasedV0109PositiveSafeIntegerSchema = z.number().int().positive().safe();
const releasedV0109CanonicalWorkDirWireSchema = z
  .string()
  .refine(
    (value) => isAbsolute(value) && normalize(value) === value && resolve(value) === value,
    'Work directory must be absolute and normalized',
  )
  .describe('canonical-work-dir-wire')
  .brand<'CanonicalWorkDir'>();
const releasedV0109HostRefIdentitySchema = z
  .object({
    provider: z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
    fingerprint: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]{64}$/),
    instanceId: z.string().min(1).max(1024),
  })
  .strict();
const releasedV0109HostRefSchema = z.discriminatedUnion('leaseMode', [
  z.object({ ...releasedV0109HostRefIdentitySchema.shape, leaseMode: z.literal('shared') }).strict(),
  z
    .object({
      ...releasedV0109HostRefIdentitySchema.shape,
      leaseMode: z.literal('job-exclusive'),
      ownerJobId: z.string().min(1).max(1024),
    })
    .strict(),
]);
const releasedV0109LogEntrySchema = z
  .object({
    seq: releasedV0109NonNegativeSafeIntegerSchema,
    observedAt: z.number(),
    stream: z.literal('stderr'),
    text: z.string(),
    startTruncated: z.literal(true).optional(),
  })
  .strict();
const releasedV0109LogSpanSchema = z
  .object({
    startSeq: releasedV0109NonNegativeSafeIntegerSchema,
    endSeq: releasedV0109NonNegativeSafeIntegerSchema,
    truncated: z.boolean(),
    historical: z.array(releasedV0109LogEntrySchema),
    during: z.array(releasedV0109LogEntrySchema),
    after: z.array(releasedV0109LogEntrySchema),
  })
  .strict();
const releasedV0109ResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('success') }).strict(),
  z
    .object({
      kind: z.literal('failure'),
      rpcCode: z.number().optional(),
      providerMessage: z.string().optional(),
      providerData: z.unknown().optional(),
    })
    .strict(),
]);
const releasedV0109DiagnosticFactSchema = z
  .object({
    factSeq: releasedV0109NonNegativeSafeIntegerSchema,
    generation: releasedV0109NonNegativeSafeIntegerSchema,
    requestId: releasedV0109NonNegativeSafeIntegerSchema,
    method: z.string(),
    response: releasedV0109ResponseSchema,
    hostLog: releasedV0109LogSpanSchema,
  })
  .strict();
const releasedV0109CommonShape = {
  ref: releasedV0109HostRefSchema,
  spec: z
    .object({
      provider: z.string().min(1),
      command: z.string().min(1),
      args: z.array(z.string()),
      cwd: releasedV0109CanonicalWorkDirWireSchema.nullable(),
      leaseMode: z.enum(['shared', 'job-exclusive']),
      idleRetirement: z.enum(['unleased', 'unleased-and-host-idle', 'never']).nullable(),
    })
    .strict(),
  diagnostics: z
    .object({
      hostLog: z
        .object({
          entries: z.array(releasedV0109LogEntrySchema),
          retainedBytes: releasedV0109NonNegativeSafeIntegerSchema,
          truncatedBeforeSeq: releasedV0109NonNegativeSafeIntegerSchema,
        })
        .strict(),
      completedObservations: z.array(releasedV0109DiagnosticFactSchema),
      factsTruncatedBeforeSeq: releasedV0109NonNegativeSafeIntegerSchema,
    })
    .strict(),
  diagnosticsRetention: z.object({ ownerBudgetTruncated: z.boolean() }).strict(),
};
const releasedV0109ReclamationFailureShape = {
  owner: z.literal('coordinator'),
  hostKey: z.string(),
  identityKey: z.string(),
  ownerJobId: z.string().nullable(),
  reclamationAttempts: releasedV0109PositiveSafeIntegerSchema,
  reclamationFailure: z.string(),
  reclamationRetryable: z.boolean(),
};
const releasedV0109ProviderHostInventoryRecordSchema = z.discriminatedUnion('status', [
  z
    .object({
      ...releasedV0109CommonShape,
      status: z.literal('live'),
      host: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
    })
    .strict(),
  z
    .object({
      ...releasedV0109CommonShape,
      status: z.literal('retired-blocked'),
      host: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
    })
    .strict(),
  z
    .object({
      ...releasedV0109CommonShape,
      status: z.literal('reclamation-failed'),
      host: z.union([
        z.object(releasedV0109ReclamationFailureShape).strict(),
        z
          .object({
            ...releasedV0109ReclamationFailureShape,
            pid: releasedV0109PositiveSafeIntegerSchema,
            processGroupId: releasedV0109PositiveSafeIntegerSchema,
          })
          .strict()
          .refine(({ pid, processGroupId }) => processGroupId === pid, {
            message: 'processGroupId must equal pid for a coordinator-owned provider host',
            path: ['processGroupId'],
          }),
      ]),
    })
    .strict(),
]);
const releasedV0109ProviderHostListResultSchema = z
  .object({ hosts: z.array(releasedV0109ProviderHostInventoryRecordSchema) })
  .strict();
const releasedV0109ProviderHostInspectResultSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('matched'), host: releasedV0109ProviderHostInventoryRecordSchema }).strict(),
  z.object({ state: z.literal('stale') }).strict(),
]);

let cleanup: (() => Promise<void>) | undefined;
let authority: ReturnType<typeof createProviderProxySetAuthority>;
let providerHosts: ReturnType<typeof createProxyAppServerHostAuthority>;
let providerServer: ReturnType<typeof fakeProviderServerHandle>;
let control: ControlClient;

beforeEach(async () => {
  vi.mocked(spawnProviderServerTransport).mockReset();
  const directory = mkdtempSync(join(tmpdir(), 'coral-provider-host-control-'));
  const endpoint = join(directory, 'proxy.sock');
  const capsule: ProxyBootstrapCapsule = {
    role: 'proxy',
    generation: 'gen2',
    flavor: 'prod',
    buildSetId,
    hostFingerprint: 'b'.repeat(64),
    guardianInstanceId: '11111111-1111-4111-8111-111111111111',
    reaperInstanceId: '22222222-2222-4222-8222-222222222222',
    proxyInstanceId,
    bootstrapNonce: 'c'.repeat(64),
    canonicalEndpoint: endpoint,
    guardianControlEndpoint: join(directory, 'guardian.sock'),
    proxyGuardianAuthSecret: 'd'.repeat(64),
  };
  const proxyIdentity: ProxyIdentity = {
    proxyInstanceId,
    pid: 102,
    incarnation: testIncarnation(1_000),
    processGroupId: 102,
    guardianInstanceId: capsule.guardianInstanceId,
    reaperInstanceId: capsule.reaperInstanceId,
    generation: 'gen2',
    flavor: 'prod',
    buildSetId,
    hostFingerprint: capsule.hostFingerprint,
    canonicalEndpoint: endpoint,
  };
  const realRuntime = createRealRuntime('prod');
  const providerRuntime: Runtime = {
    ...realRuntime,
    ids: {
      ...realRuntime.ids,
      uuid: () => hostRef.instanceId,
      sha256: () => hostRef.fingerprint,
    },
  };
  providerServer = fakeProviderServerHandle();
  vi.mocked(spawnProviderServerTransport).mockResolvedValueOnce(providerServer.handle);
  providerHosts = createProxyAppServerHostAuthority(providerRuntime);
  const scope = providerHosts.beginOperation({ jobId: 'job-1', operationId: 'operation-1' });
  scope.selectCancellationMode('shared-acknowledged-interrupt');
  const openedHost = await scope.openSession(providerSpec);
  expect(openedHost.hostRef).toEqual(hostRef);

  const semanticHost: SemanticOperationHost = {
    start: () => {
      throw new Error('semantic operation start was not expected');
    },
    stop: () => {},
  };
  let challenge = 0;
  const proxy = createProxy({
    capsule,
    clock: createMonotonicClock(Symbol('provider-host-control')),
    identity: proxyIdentity,
    host: semanticHost,
    providerHosts,
    timer,
    mintChallenge: () => `challenge-${challenge++}`,
    mintReceipt: () => 'receipt',
    mintReservation: () => asReservation('40000000-0000-4000-8000-000000000001'),
    wallClockNow: () => 0,
    containment: {
      stageProviderRoot: () => {
        throw new Error('provider root staging was not expected');
      },
    },
  });
  await proxy.listen();
  control = await connectControlClient(endpoint, timer, 5_000);
  const coordinatorIdentity: CoordinatorIdentity = {
    instanceId: '55555555-5555-4555-8555-555555555555',
    pid: 1,
    incarnation: testIncarnation(900),
    generation: 'gen2',
    flavor: 'prod',
    buildSetId,
  };
  const openedControl = (await strictTestExchange(control, 'control.open.v1', {
    bootstrapNonce: capsule.bootstrapNonce,
    coordinator: coordinatorIdentity,
  })) as { controlEpoch: number; heartbeatChallenge: string };
  await strictTestExchange(control, 'control.heartbeat.v1', {
    controlEpoch: openedControl.controlEpoch,
    heartbeatChallenge: openedControl.heartbeatChallenge,
  });

  authority = createProviderProxySetAuthority({
    proxyInstanceId,
    guardianClient: unreachableClient(),
    proxyClient: control,
    reaperClient: unreachableClient(),
    guardianIdentity: guardianIdentity(),
    reaperIdentity: reaperIdentity(),
    proxyIdentityFields: proxyIdentity,
    heartbeats: {
      proxy: { stop: () => {} },
      guardian: { stop: () => {} },
      reaper: { stop: () => {} },
    },
    coordinatorIdentity,
    handoffCapsulePath: join(directory, 'unused.json'),
    runtime: unusedRuntimePorts(),
    recoveryCapsule: {} as never,
    recoveryOperations: [],
    operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
  });
  cleanup = async () => {
    control.close();
    await providerHosts.evictHost(hostRef);
    await proxy.close();
    rmSync(directory, { recursive: true, force: true });
  };
});

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe('provider-host proxy controls', () => {
  it('emits list and inspect v1 payloads accepted by the released v0.10.9 schemas', async () => {
    const assertReleasedPayloads = async (): Promise<void> => {
      const list = await strictTestExchange(control, 'provider-host.list.v1', {}, 5_000);
      const inspect = await strictTestExchange(control, 'provider-host.inspect.v1', { hostRef }, 5_000);

      expect(releasedV0109ProviderHostListResultSchema.parse(list)).toEqual(list);
      expect(releasedV0109ProviderHostInspectResultSchema.parse(inspect)).toEqual(inspect);
    };

    await assertReleasedPayloads();

    const spawnOptions = vi.mocked(spawnProviderServerTransport).mock.calls[0]?.[0];
    if (spawnOptions === undefined) throw new Error('provider-host transport was not spawned');
    spawnOptions.observeProviderResponse(rejectedConfigRead(0));
    providerServer.resolveClosed();
    await vi.waitFor(() => expect(providerHosts.admissionSnapshot().tombstones).toHaveLength(1));

    await assertReleasedPayloads();
  });

  it('refuses v1 list and inspect payloads that only v2 can represent', async () => {
    const live = providerHosts.listProviderHosts()[0];
    if (live === undefined) throw new Error('provider-host fixture did not open a live host');
    const v2OnlyRecords = [
      {
        ...live,
        status: 'reclamation-failed',
        host: {
          owner: 'provider-proxy',
          hostKey: 'provider-proxy-host',
          ownerJobId: 'job-1',
          pid: process.pid,
          reclamationAttempts: 1,
          reclamationFailure: 'cleanup held',
          reclamationRetryable: true,
        },
      },
      {
        ...live,
        status: 'shutdown-held',
        host: {
          owner: 'provider-proxy',
          hostKey: 'provider-proxy-host',
          ownerJobId: 'job-1',
          pid: process.pid,
          observation: 'unobservable',
          successorOwner: null,
          operatorExit: 'retry-provider-shutdown',
        },
      },
    ] as const;

    for (const record of v2OnlyRecords) {
      const list = vi.spyOn(providerHosts, 'listProviderHosts').mockReturnValue([record as never]);
      const inspect = vi.spyOn(providerHosts, 'inspectProviderHost').mockReturnValue(record as never);
      try {
        await expect(strictTestExchange(control, 'provider-host.list.v2', {}, 5_000)).resolves.toEqual({
          hosts: [record],
        });
        await expect(strictTestExchange(control, 'provider-host.inspect.v2', { hostRef }, 5_000)).resolves.toEqual({
          state: 'matched',
          host: record,
        });
        await expect(strictTestExchange(control, 'provider-host.list.v1', {}, 5_000)).rejects.toThrow(
          'Provider-host inventory requires provider-host.list.v2.',
        );
        await expect(strictTestExchange(control, 'provider-host.inspect.v1', { hostRef }, 5_000)).rejects.toThrow(
          'Provider-host inventory requires provider-host.inspect.v2.',
        );
      } finally {
        list.mockRestore();
        inspect.mockRestore();
      }
    }
  });

  it('preserves a held eviction in v2 and refuses to fold it through v1', async () => {
    const eviction = vi.spyOn(providerHosts, 'evictHost').mockResolvedValue({
      kind: 'held',
      observation: 'alive',
      successorOwner: 'broker-session-pool',
      operatorExit: 'retry-broker-shutdown',
    });
    try {
      await expect(strictTestExchange(control, 'provider-host.evict.v2', { hostRef }, 5_000)).resolves.toEqual({
        kind: 'held',
        observation: 'alive',
        successorOwner: 'broker-session-pool',
        operatorExit: 'retry-broker-shutdown',
      });
      await expect(strictTestExchange(control, 'provider-host.evict.v1', { hostRef }, 5_000)).rejects.toThrow(
        'Provider-host eviction requires provider-host.evict.v2.',
      );
    } finally {
      eviction.mockRestore();
    }
  });

  it('preserves operator abandonment in v2 and refuses to fold it through v1', async () => {
    const abandonment = {
      kind: 'operator-abandoned' as const,
      subject: { kind: 'unattributable-process-group' as const, processGroupId: 4_242 },
      processAbsenceProven: false as const,
      successor: { owner: 'operator-command' as const, acceptance: 'accepted' as const },
    };
    const eviction = vi.spyOn(providerHosts, 'evictHost').mockResolvedValue(abandonment);
    try {
      await expect(strictTestExchange(control, 'provider-host.evict.v2', { hostRef }, 5_000)).resolves.toEqual(
        abandonment,
      );
      await expect(strictTestExchange(control, 'provider-host.evict.v1', { hostRef }, 5_000)).rejects.toThrow(
        'Provider-host eviction requires provider-host.evict.v2.',
      );
    } finally {
      eviction.mockRestore();
    }
  });

  it('passes actual live and retained-tombstone records through the real strict list and inspect handlers', async () => {
    const controls = authority.providerHosts;
    if (controls === undefined) throw new Error('provider-host controls were not composed');

    const liveRecords = providerHosts.listProviderHosts();
    expect(liveRecords).toHaveLength(1);
    expect(liveRecords[0]?.status).toBe('live');
    await expect(controls.list()).resolves.toEqual(liveRecords);
    await expect(controls.inspect(hostRef)).resolves.toEqual(liveRecords[0]);

    const spawnOptions = vi.mocked(spawnProviderServerTransport).mock.calls[0]?.[0];
    if (spawnOptions === undefined) throw new Error('provider-host transport was not spawned');
    spawnOptions.observeProviderResponse(rejectedConfigRead(0));
    providerServer.resolveClosed();
    await vi.waitFor(() => expect(providerHosts.admissionSnapshot().tombstones).toHaveLength(1));

    const tombstoneRecords = providerHosts.listProviderHosts();
    expect(tombstoneRecords).toHaveLength(1);
    expect(tombstoneRecords[0]?.status).toBe('retired-blocked');
    await expect(controls.list()).resolves.toEqual(tombstoneRecords);
    await expect(controls.inspect(hostRef)).resolves.toEqual(tombstoneRecords[0]);
  });

  it('drives the real evict sender through the real strict receiver and handler', async () => {
    const controls = authority.providerHosts;
    if (controls === undefined) throw new Error('provider-host controls were not composed');

    await expect(controls.evict(hostRef)).resolves.toEqual({ kind: 'evicted' });
    expect(providerServer.closeMock).toHaveBeenCalledOnce();
    expect(providerHosts.listProviderHosts()).toEqual([]);
  });

  it('rejects a non-canonical inventory cwd at the real proxy response sender', async () => {
    const controls = authority.providerHosts;
    if (controls === undefined) throw new Error('provider-host controls were not composed');
    const live = providerHosts.listProviderHosts()[0];
    if (live === undefined) throw new Error('provider-host fixture did not open a live host');
    const malformed = {
      ...live,
      spec: { ...live.spec, cwd: 'relative/provider-host' },
    } as unknown as typeof live;
    const list = vi.spyOn(providerHosts, 'listProviderHosts').mockReturnValue([malformed]);

    try {
      await expect(controls.list()).rejects.toThrow(/Work directory must be absolute and normalized/u);
    } finally {
      list.mockRestore();
    }
  });
});

function fakeProviderServerHandle(): {
  handle: ProviderServerHandle;
  closeMock: ReturnType<typeof vi.fn>;
  resolveClosed(): void;
} {
  let resolveClosed!: () => void;
  let closed = false;
  const child = Object.assign(new EventEmitter(), {
    pid: process.pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: null,
    stdout: null,
    stderr: null,
    kill: () => true,
  });
  const closePromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const observeClosed = (): void => {
    if (closed) return;
    closed = true;
    child.exitCode = 0;
    child.emit('exit', child.exitCode, child.signalCode);
    child.emit('close', child.exitCode, child.signalCode);
    resolveClosed();
  };
  const closeMock = vi.fn(async () => {
    observeClosed();
    return {
      kind: 'observed-absent' as const,
      evidence: { subject: { kind: 'process' as const, pid: process.pid } },
    };
  });
  return {
    handle: {
      pid: process.pid,
      child,
      generation: 0,
      rpc: {
        request: vi.fn(async () => ({})) as unknown as ProviderServerHandle['rpc']['request'],
        notify: vi.fn(),
      },
      onNotification: vi.fn(() => () => {}) as unknown as ProviderServerHandle['onNotification'],
      closePromise,
      isClosed: () => closed,
      inspectDiagnostics: () => ({
        hostLog: { entries: [], retainedBytes: 0, truncatedBeforeSeq: 0 },
        completedObservations: [
          {
            factSeq: 1,
            generation: 0,
            requestId: 3,
            method: 'config/read',
            response: { kind: 'failure', rpcCode: -32_603, providerMessage: 'fixture', providerData: null },
            hostLog: {
              startSeq: 4,
              endSeq: 5,
              truncated: true,
              historical: [{ seq: 1, observedAt: 1, stream: 'stderr', text: 'before' }],
              during: [],
              after: [],
            },
          },
        ],
        factsTruncatedBeforeSeq: 0,
      }),
      markExpectedClose: vi.fn(),
      close: closeMock,
    },
    closeMock,
    resolveClosed: observeClosed,
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

function unreachableClient(): ControlClient {
  return {
    exchange: () => {
      throw new Error('unexpected control exchange');
    },
    faulted: new Promise<never>(() => {}),
    onFault: () => () => {},
    close: () => {},
  };
}

function guardianIdentity(): GuardianIdentity {
  return {
    guardianInstanceId: '11111111-1111-4111-8111-111111111111',
    pid: 100,
    incarnation: testIncarnation(1_000),
    generation: 'gen2',
    flavor: 'prod',
    buildSetId,
    hostFingerprint: 'b'.repeat(64),
    canonicalControlEndpoint: '/tmp/guardian.sock',
  };
}

function reaperIdentity(): ReaperIdentity {
  return {
    reaperInstanceId: '22222222-2222-4222-8222-222222222222',
    pid: 101,
    incarnation: testIncarnation(1_000),
    guardianInstanceId: guardianIdentity().guardianInstanceId,
    generation: 'gen2',
    flavor: 'prod',
    buildSetId,
    hostFingerprint: 'b'.repeat(64),
    canonicalControlEndpoint: '/tmp/reaper.sock',
    containmentKind: 'detached-process-group',
  };
}

function unusedRuntimePorts(): Runtime {
  const fail = (): never => {
    throw new Error('unexpected runtime port call');
  };
  return {
    ids: { uuid: fail, randomBytes: fail } as never,
    env: { get: fail } as never,
    storage: new Proxy({}, { get: fail }) as never,
  } as unknown as Runtime;
}
