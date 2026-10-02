import type { Principal } from '#src/security/principal.js';
import { executeCatalogRequest } from '#src/transport/dispatch.js';
import { providerHostListRpcSpec, providerHostListV2RpcSpec } from '#src/transport/rpc/catalog.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import { describe, expect, it, vi } from 'vitest';
import type { HostRef } from '#src/providers/contract.js';
import { canonicalWorkDirWireSchema } from '#src/runtime/canonical-work-dir.js';
import {
  ProviderHostAdministrationService,
  ProviderHostOwnerTornDown,
  type ProviderHostAdministrationOwner,
  type ProviderHostInventoryRecord,
} from '#src/coordinator/services/provider-host-administration.js';

const fingerprint = 'a'.repeat(64);
const workDir = canonicalWorkDirWireSchema.parse('/workspace');

function hostRef(instanceId: string): HostRef {
  return {
    provider: 'codex',
    fingerprint,
    instanceId,
    leaseMode: 'shared',
  };
}

function record(ref: HostRef, status: 'live' | 'retired-blocked' = 'live'): ProviderHostInventoryRecord {
  return {
    ref,
    status,
    spec: {
      provider: ref.provider,
      command: 'codex',
      args: ['app-server'],
      cwd: workDir,
      leaseMode: ref.leaseMode,
      idleRetirement: ref.leaseMode === 'shared' ? 'never' : null,
    },
    host: { owner: status === 'live' ? 'coordinator' : 'provider-proxy' },
    diagnostics: {
      hostLog: { entries: [], retainedBytes: 0, truncatedBeforeSeq: 0 },
      completedObservations: [],
      factsTruncatedBeforeSeq: 0,
    },
    diagnosticsRetention: { ownerBudgetTruncated: false },
  };
}

function owner(
  ownerId: string,
  records: readonly ProviderHostInventoryRecord[],
  overrides: Partial<ProviderHostAdministrationOwner> = {},
): ProviderHostAdministrationOwner & {
  listProviderHosts: ReturnType<typeof vi.fn>;
  inspectProviderHost: ReturnType<typeof vi.fn>;
  terminalEviction: ReturnType<typeof vi.fn>;
  evictProviderHost: ReturnType<typeof vi.fn>;
} {
  return {
    ownerId,
    listProviderHosts: vi.fn(async () => records),
    inspectProviderHost: vi.fn(async (ref: HostRef) => records.find((entry) => entry.ref === ref) ?? null),
    terminalEviction: vi.fn(async () => null),
    evictProviderHost: vi.fn(async () => ({ kind: 'evicted' as const })),
    ...overrides,
  } as never;
}

describe('provider host administration', () => {
  it('revalidates one exact ref at its captured owner before inspect and eviction', async () => {
    const selectedRef = hostRef('selected');
    const selectedRecord = record(selectedRef);
    const selected = owner('coordinator', [selectedRecord], {
      inspectProviderHost: vi.fn(async () => selectedRecord),
      evictProviderHost: vi.fn(async () => ({ kind: 'evicted' as const })),
    });
    const untouched = owner('proxy-a', [record(hostRef('untouched'))]);
    const service = new ProviderHostAdministrationService({ owners: () => [selected, untouched] });

    await expect(service.inspect({ hostRef: selectedRef })).resolves.toMatchObject({
      ownerId: 'coordinator',
      ref: selectedRef,
    });
    await expect(service.evict({ hostRef: selectedRef })).resolves.toEqual({
      ownerId: 'coordinator',
      hostRef: selectedRef,
    });
    expect(selected.inspectProviderHost).toHaveBeenCalledExactlyOnceWith(selectedRef);
    expect(selected.evictProviderHost).toHaveBeenCalledExactlyOnceWith(selectedRef);
    expect(untouched.inspectProviderHost).not.toHaveBeenCalled();
    expect(untouched.evictProviderHost).not.toHaveBeenCalled();
  });

  it('reconstructs an exact-ref route from a surviving owner after the first service loses the reply', async () => {
    const selectedRef = hostRef('lost-abandonment-reply');
    const abandonment = {
      kind: 'operator-abandoned' as const,
      subject: { kind: 'unattributable-process-group' as const, processGroupId: 4_242 },
      processAbsenceProven: false as const,
      successor: { owner: 'operator-command' as const, acceptance: 'accepted' as const },
    };
    let visible = true;
    let retained: typeof abandonment | null = null;
    const evictProviderHost = vi.fn(async () => {
      visible = false;
      retained = abandonment;
      if (evictProviderHost.mock.calls.length === 1) throw new Error('terminal reply was lost');
      return abandonment;
    });
    const selected = owner('proxy-a', [], {
      listProviderHosts: vi.fn(async () => (visible ? [record(selectedRef)] : [])),
      terminalEviction: vi.fn(async () => retained),
      evictProviderHost,
    });
    const untouched = owner('proxy-b', []);
    const firstService = new ProviderHostAdministrationService({ owners: () => [selected, untouched] });

    await expect(firstService.evict({ hostRef: selectedRef })).rejects.toMatchObject({
      code: 'provider_host_inventory_unavailable',
      ownerIds: ['proxy-a'],
    });
    untouched.listProviderHosts.mockRejectedValue(new Error('sibling inventory unavailable'));
    const secondService = new ProviderHostAdministrationService({ owners: () => [selected, untouched] });
    const retry = await secondService.evict({ hostRef: selectedRef }).catch((error: unknown) => error);
    expect(retry).toMatchObject({
      code: 'provider_host_operator_abandoned',
      ownerIds: ['proxy-a'],
      matches: [selectedRef],
      abandonment: {
        kind: 'operator-abandoned',
        subject: { kind: 'unattributable-process-group', processGroupId: 4_242 },
        processAbsenceProven: false,
        successor: { owner: 'operator-command', acceptance: 'accepted' },
      },
    });
    expect((retry as { abandonment: unknown }).abandonment).toBe(abandonment);
    expect(evictProviderHost).toHaveBeenCalledTimes(2);
    expect(untouched.listProviderHosts).toHaveBeenCalledOnce();
    expect(untouched.evictProviderHost).not.toHaveBeenCalled();
  });

  it('answers a torn-down owner rather than an unavailable inventory once its control is released', async () => {
    const localRef = hostRef('local-while-draining');
    const local = owner('coordinator:test', [record(localRef)]);
    const tornDown = owner('provider-proxy:released', [], {
      listProviderHosts: vi.fn(async () => Promise.reject(new ProviderHostOwnerTornDown())),
      inspectProviderHost: vi.fn(async () => Promise.reject(new ProviderHostOwnerTornDown())),
      terminalEviction: vi.fn(async () => Promise.reject(new ProviderHostOwnerTornDown())),
      evictProviderHost: vi.fn(async () => Promise.reject(new ProviderHostOwnerTornDown())),
    });
    const service = new ProviderHostAdministrationService({ owners: () => [local, tornDown] });

    await expect(service.list()).resolves.toMatchObject({
      rows: [{ ownerId: 'coordinator:test', ref: { instanceId: 'local-while-draining' } }],
      tornDownOwnerIds: ['provider-proxy:released'],
    });
    await expect(service.evict({ hostRef: localRef })).resolves.toEqual({
      ownerId: 'coordinator:test',
      hostRef: localRef,
    });

    const unknownRef = hostRef('only-on-the-torn-down-owner');
    for (const result of [service.evict({ hostRef: unknownRef }), service.inspect({ hostRef: unknownRef })]) {
      await expect(result).rejects.toMatchObject({
        code: 'provider_host_owner_torn_down',
        ownerIds: ['provider-proxy:released'],
        matches: [unknownRef],
      });
    }
  });
});

const operator: Principal = {
  subject: 'operator',
  transport: 'ipc',
  credential: { kind: 'boot-token', id: 'operator' },
  binding: { kind: 'unbound' },
};

describe('provider-host RPC authorization', () => {
  it('refuses an unrepresentable v1 inventory while v2 preserves the unavailable owner', async () => {
    const list = vi.fn(async () => ({ hosts: [], tornDownOwnerIds: ['provider-proxy:set-a'] }));
    const ports = { providerHosts: { list, inspect: vi.fn(), evict: vi.fn() } } as unknown as HttpHandlerPorts;

    await expect(executeCatalogRequest(providerHostListRpcSpec, {}, ports, operator)).resolves.toMatchObject({
      kind: 'unary',
      statusCode: 503,
      body: { code: 'provider_host_inventory_unavailable', detail: { ownerIds: ['provider-proxy:set-a'] } },
    });

    await expect(executeCatalogRequest(providerHostListV2RpcSpec, {}, ports, operator)).resolves.toMatchObject({
      kind: 'unary',
      body: { hosts: [], tornDownOwnerIds: ['provider-proxy:set-a'] },
    });
  });
});
