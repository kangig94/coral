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

  it('reports a shutdown hold without calling it stale or evicted', async () => {
    const selectedRef = hostRef('held');
    const selected = owner('proxy-a', [record(selectedRef)], {
      evictProviderHost: vi.fn(async () => ({
        kind: 'held' as const,
        observation: 'alive' as const,
        successorOwner: 'provider-proxy-root-pool',
        operatorExit: 'retry-provider-shutdown',
      })),
    });
    const service = new ProviderHostAdministrationService({ owners: () => [selected] });

    await expect(service.evict({ hostRef: selectedRef })).rejects.toMatchObject({
      code: 'provider_host_shutdown_held',
      ownerIds: ['proxy-a'],
      matches: [selectedRef],
      hold: {
        kind: 'held',
        observation: 'alive',
        successorOwner: 'provider-proxy-root-pool',
        operatorExit: 'retry-provider-shutdown',
      },
    });
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

  it('rejects retained terminal matches from multiple owners as identity corruption', async () => {
    const selectedRef = hostRef('duplicate-terminal');
    const terminal = { kind: 'evicted' as const };
    const first = owner('coordinator', [], { terminalEviction: vi.fn(async () => terminal) });
    const duplicate = owner('proxy-a', [], { terminalEviction: vi.fn(async () => terminal) });
    const service = new ProviderHostAdministrationService({ owners: () => [first, duplicate] });

    await expect(service.evict({ hostRef: selectedRef })).rejects.toMatchObject({
      code: 'provider_host_identity_integrity',
      ownerIds: ['coordinator', 'proxy-a'],
      matches: [selectedRef, selectedRef],
    });
    expect(first.listProviderHosts).not.toHaveBeenCalled();
    expect(first.evictProviderHost).not.toHaveBeenCalled();
    expect(duplicate.evictProviderHost).not.toHaveBeenCalled();
  });

  it('requires an exact reference for eviction and performs no owner call', async () => {
    const first = owner('coordinator', [record(hostRef('first'))]);
    const second = owner('proxy-a', [record(hostRef('second'))]);
    const service = new ProviderHostAdministrationService({ owners: () => [first, second] });

    await expect(service.evict({ workDir })).rejects.toMatchObject({
      code: 'provider_host_eviction_requires_exact_ref',
    });
    expect(first.listProviderHosts).not.toHaveBeenCalled();
    expect(second.listProviderHosts).not.toHaveBeenCalled();
    expect(first.evictProviderHost).not.toHaveBeenCalled();
    expect(second.evictProviderHost).not.toHaveBeenCalled();
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

  it.each(['list'] as const)('fails %s closed when any captured owner inventory is unavailable', async (operation) => {
    const selectedRef = hostRef('selected');
    const selected = owner('coordinator', [record(selectedRef)]);
    const unavailable = owner('proxy-a', [], {
      listProviderHosts: vi.fn(async () => Promise.reject(new Error('control lost'))),
    });
    const service = new ProviderHostAdministrationService({ owners: () => [selected, unavailable] });

    const result =
      operation === 'list'
        ? service.list()
        : operation === 'inspect'
          ? service.inspect({ hostRef: selectedRef })
          : service.evict({ hostRef: selectedRef });
    await expect(result).rejects.toMatchObject({
      code: 'provider_host_inventory_unavailable',
      ownerIds: ['proxy-a'],
    });
    expect(selected.inspectProviderHost).not.toHaveBeenCalled();
    expect(selected.evictProviderHost).not.toHaveBeenCalled();
  });

  it('never reroutes by cwd when the selected exact ref retires or its owner disappears', async () => {
    const selectedRef = hostRef('selected');
    const replacementRef = hostRef('replacement');
    const selected = owner('proxy-a', [record(selectedRef)], {
      inspectProviderHost: vi.fn(async () => null),
      evictProviderHost: vi.fn(async () => ({ kind: 'stale' as const })),
    });
    const replacement = owner('proxy-b', [record(replacementRef)]);
    const service = new ProviderHostAdministrationService({ owners: () => [selected, replacement] });

    await expect(service.inspect({ hostRef: selectedRef })).rejects.toMatchObject({ code: 'provider_host_stale' });
    await expect(service.evict({ hostRef: selectedRef })).rejects.toMatchObject({ code: 'provider_host_stale' });
    expect(replacement.inspectProviderHost).not.toHaveBeenCalled();
    expect(replacement.evictProviderHost).not.toHaveBeenCalled();

    selected.inspectProviderHost.mockRejectedValueOnce(new Error('owner disappeared'));
    await expect(service.inspect({ hostRef: selectedRef })).rejects.toMatchObject({
      code: 'provider_host_inventory_unavailable',
      ownerIds: ['proxy-a'],
    });
    expect(replacement.inspectProviderHost).not.toHaveBeenCalled();
  });
});
