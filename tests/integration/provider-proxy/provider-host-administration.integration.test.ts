import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProviderProxySetAuthority } from '#src/coordinator/live/provider-proxy/set-authority.js';
import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { HostRef } from '#src/providers/contract.js';
import type { ControlClient } from '#src/provider-proxy/control-client.js';
import { connectControlClient } from '#src/provider-proxy/control-client.js';
import type { ControlEndpointTimer } from '#src/provider-proxy/control-endpoint.js';
import type { ProxyBootstrapCapsule } from '#src/provider-proxy/bootstrap-capsule.js';
import { createProxy } from '#src/provider-proxy/proxy.js';
import type { SemanticOperationHost } from '#src/provider-proxy/operation-supervisor.js';
import type {
  ProxyProviderHostAdministrationAuthority,
  ProxyProviderHostInventoryRecord,
} from '#src/provider-proxy/provider-root-authority.js';
import type {
  CoordinatorIdentity,
  GuardianIdentity,
  ProxyIdentity,
  ReaperIdentity,
} from '#src/provider-proxy/protocol.js';
import { asReservation } from '#tests/helpers/provider-proxy-correlation.js';

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
const record: ProxyProviderHostInventoryRecord = {
  ref: hostRef,
  status: 'live',
  spec: {
    provider: 'codex',
    command: 'codex',
    args: ['app-server'],
    cwd: '/workspace',
    leaseMode: 'shared',
    idleRetirement: 'none',
  },
  host: { owner: 'provider-proxy' },
  diagnostics: {
    hostLog: { entries: [], retainedBytes: 0, truncatedBeforeSeq: 0 },
    completedObservations: [
      {
        factSeq: 1,
        generation: 2,
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
  },
  diagnosticsRetention: { ownerBudgetTruncated: false },
};

let cleanup: (() => Promise<void>) | undefined;
let authority: ReturnType<typeof createProviderProxySetAuthority>;
let providerHosts: ProxyProviderHostAdministrationAuthority & {
  listProviderHosts: ReturnType<typeof vi.fn>;
  inspectProviderHost: ReturnType<typeof vi.fn>;
  evictHost: ReturnType<typeof vi.fn>;
};

beforeEach(async () => {
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
    processStartedAtSeconds: 1_000,
    processGroupId: 102,
    guardianInstanceId: capsule.guardianInstanceId,
    reaperInstanceId: capsule.reaperInstanceId,
    generation: 'gen2',
    flavor: 'prod',
    buildSetId,
    hostFingerprint: capsule.hostFingerprint,
    canonicalEndpoint: endpoint,
  };
  providerHosts = {
    admissionSnapshot: () => ({ state: new Map(), tombstones: [] }),
    listProviderHosts: vi.fn(() => [record]),
    inspectProviderHost: vi.fn(() => record),
    evictHost: vi.fn(async () => true),
  };
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
  const control = await connectControlClient(endpoint, timer, 5_000);
  const coordinatorIdentity: CoordinatorIdentity = {
    instanceId: '55555555-5555-4555-8555-555555555555',
    pid: 1,
    processStartedAtSeconds: 900,
    generation: 'gen2',
    flavor: 'prod',
    buildSetId,
  };
  const opened = (await control.call(
    'control.open.v1',
    { bootstrapNonce: capsule.bootstrapNonce, coordinator: coordinatorIdentity },
    5_000,
  )) as { controlEpoch: number; heartbeatChallenge: string };
  await control.call(
    'control.heartbeat.v1',
    { controlEpoch: opened.controlEpoch, heartbeatChallenge: opened.heartbeatChallenge },
    5_000,
  );

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
    operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
  });
  cleanup = async () => {
    control.close();
    await proxy.close();
    rmSync(directory, { recursive: true, force: true });
  };
});

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe('provider-host proxy controls', () => {
  it('drives the real list sender through the real strict receiver and handler', async () => {
    await expect(authority.providerHosts?.list()).resolves.toEqual([record]);
    expect(providerHosts.listProviderHosts).toHaveBeenCalledOnce();
  });

  it('drives the real inspect sender through the real strict receiver and handler', async () => {
    await expect(authority.providerHosts?.inspect(hostRef)).resolves.toEqual(record);
    expect(providerHosts.inspectProviderHost).toHaveBeenCalledExactlyOnceWith(hostRef);
  });

  it('drives the real evict sender through the real strict receiver and handler', async () => {
    await expect(authority.providerHosts?.evict(hostRef)).resolves.toBe(true);
    expect(providerHosts.evictHost).toHaveBeenCalledExactlyOnceWith(hostRef);
  });
});

function unreachableClient(): ControlClient {
  return {
    call: async () => {
      throw new Error('unexpected control call');
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
    processStartedAtSeconds: 1_000,
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
    processStartedAtSeconds: 1_000,
    guardianInstanceId: guardianIdentity().guardianInstanceId,
    generation: 'gen2',
    flavor: 'prod',
    buildSetId,
    hostFingerprint: 'b'.repeat(64),
    canonicalControlEndpoint: '/tmp/reaper.sock',
    containmentKind: 'detached-process-group',
  };
}

function unusedRuntimePorts(): Pick<Runtime, 'ids' | 'env' | 'storage'> {
  const fail = (): never => {
    throw new Error('unexpected runtime port call');
  };
  return {
    ids: { uuid: fail, randomBytes: fail } as never,
    env: { get: fail } as never,
    storage: new Proxy({}, { get: fail }) as never,
  };
}
