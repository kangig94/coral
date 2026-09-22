import { createServer } from 'node:http';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as CompositionWorldMod from '#src/coordinator/composition/world.js';
import type * as HttpHandlerMod from '#src/transport/http/handler.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import type { ProviderProxySetAuthority } from '#src/coordinator/live/provider-proxy/authority.js';

const captured = vi.hoisted(() => ({
  ports: null as HttpHandlerPorts | null,
  proxySets: [] as readonly ProviderProxySetAuthority[],
}));

vi.mock('#src/transport/http/handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HttpHandlerMod>();
  return {
    ...actual,
    createHttpHandler: (ports: HttpHandlerPorts) => {
      captured.ports = ports;
      return actual.createHttpHandler(ports);
    },
  };
});

vi.mock('#src/coordinator/composition/world.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CompositionWorldMod>();
  return {
    ...actual,
    createCoordinatorWorld: (...args: Parameters<(typeof CompositionWorldMod)['createCoordinatorWorld']>) => ({
      ...actual.createCoordinatorWorld(...args),
      providerProxyAuthority: { liveSets: () => captured.proxySets },
    }),
  };
});

import { createCoordinatorCore } from '#src/coordinator/composition/index.js';
import type {
  ProviderHostAdministrationAuthority,
  ProviderHostManager,
} from '#src/coordinator/live/provider-hosts/index.js';
import {
  ProviderHostOwnerTornDown,
  type ProviderHostInventoryRecord,
} from '#src/coordinator/services/provider-host-administration.js';
import { ControlClientError } from '#src/provider-proxy/control-client.js';
import { canonicalizeWorkDir } from '#src/runtime/canonical-work-dir.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';

const proxyInstanceId = '22222222-2222-4222-8222-222222222222';
const localOwnerId = 'coordinator:torn-down-classification-instance';
const proxyOwnerId = `provider-proxy:${proxyInstanceId}`;

function localRecord(): ProviderHostInventoryRecord {
  return {
    ref: { provider: 'codex', fingerprint: 'a'.repeat(64), instanceId: 'local-host', leaseMode: 'shared' },
    status: 'live',
    spec: {
      provider: 'codex',
      command: 'codex',
      args: ['app-server'],
      cwd: canonicalizeWorkDir(process.cwd(), process.cwd()),
      leaseMode: 'shared',
      idleRetirement: 'never',
    },
    host: { owner: 'coordinator' },
    diagnostics: {
      hostLog: { entries: [], retainedBytes: 0, truncatedBeforeSeq: 0 },
      completedObservations: [],
      factsTruncatedBeforeSeq: 0,
    },
    diagnosticsRetention: { ownerBudgetTruncated: false },
  };
}

function proxySetAnsweringWith(error: Error): ProviderProxySetAuthority {
  const reject = async (): Promise<never> => Promise.reject(error);
  return {
    proxyInstanceId,
    providerHosts: { list: reject, inspect: reject, terminalEviction: reject, evict: reject },
  } as unknown as ProviderProxySetAuthority;
}

function proxySetHoldingNoHosts(): ProviderProxySetAuthority {
  return { proxyInstanceId, providerHosts: { list: async () => [] } } as unknown as ProviderProxySetAuthority;
}

function composeProviderHostPorts(): NonNullable<HttpHandlerPorts['providerHosts']> {
  const administration = {
    admissionSnapshot: () => ({ state: new Map(), tombstones: [] }),
    listProviderHosts: () => [localRecord()],
    inspectProviderHost: () => localRecord(),
    terminalEviction: () => null,
    evictHost: async () => ({ kind: 'evicted' as const }),
  };
  const providerHostManager = {
    openSession: async () => {
      throw new Error('provider-host session creation was not expected');
    },
    attachSession: async () => null,
    drainForHandoff: async () => ({
      kind: 'provider-hosts-quiesced',
      liveProxySets: [],
      acquisitionCleanupHolds: [],
      closingHosts: [],
    }),
    shutdown: async () => ({
      kind: 'provider-hosts-quiesced',
      liveProxySets: [],
      acquisitionCleanupHolds: [],
      closingHosts: [],
    }),
    routeAppServerOperation: () => null,
    ...administration,
  } satisfies ProviderHostManager & ProviderHostAdministrationAuthority;

  captured.ports = null;
  createCoordinatorCore(
    {
      onFatalShutdownError: vi.fn(),
      runtime: createRealRuntime('prod'),
      storeFormat: currentCoralStoreFormat(),
      pluginRoot: process.cwd(),
      backendNamespace: 'provider-host-torn-down-classification-test',
      bootSnapshot: {
        version: '1.0.0',
        bundleHash: '0123456789abcdef',
        flavor: 'prod',
        instanceId: 'torn-down-classification-instance',
        token: 'operator-token',
        bootToken: 'boot-token',
        shutdownToken: 'shutdown-token',
        now: () => 0,
        log: vi.fn(),
      },
      createServerFn: (handler) => createServer(handler),
      providerHostManager,
      kbDaemonSupervisor: createMockKbDaemonSupervisor(),
      getConsumerStuck: () => [],
    },
    async () => [],
  );
  const providerHosts = (captured.ports as HttpHandlerPorts | null)?.providerHosts;
  if (providerHosts === undefined) throw new Error('Production composition did not assemble provider-host ports.');
  return providerHosts;
}

beforeEach(() => {
  captured.proxySets = [];
});

describe('proxy-set provider-host owner classification', () => {
  it('reports an owner adapter that declined to send as torn down, and names it by its owner id', async () => {
    captured.proxySets = [proxySetAnsweringWith(new ProviderHostOwnerTornDown())];
    const providerHosts = composeProviderHostPorts();

    await expect(providerHosts.list()).resolves.toEqual({
      hosts: [{ ...localRecord(), ownerId: localOwnerId }],
      tornDownOwnerIds: [proxyOwnerId],
    });
  });

  it.each([
    ['a channel that closed under a call', new ControlClientError('control_client_closed', 'closed.', 'closed')],
    [
      'a failed control call',
      new ControlClientError('control_call_failed', 'provider-host.list.v2 failed', 'remote-response', {
        kind: 'invalid-frame',
      }),
    ],
  ])('leaves %s unavailable, because the call reached a control that existed', async (_label, error) => {
    captured.proxySets = [proxySetAnsweringWith(error)];
    const providerHosts = composeProviderHostPorts();

    await expect(providerHosts.list()).rejects.toMatchObject({
      code: 'provider_host_inventory_unavailable',
      ownerIds: [proxyOwnerId],
    });
  });

  it('names no torn-down owner when an answering proxy set is composed alongside the local owner', async () => {
    captured.proxySets = [proxySetHoldingNoHosts()];
    const providerHosts = composeProviderHostPorts();

    await expect(providerHosts.list()).resolves.toEqual({
      hosts: [{ ...localRecord(), ownerId: localOwnerId }],
      tornDownOwnerIds: [],
    });
  });
});
