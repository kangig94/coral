import type * as ProcessSupervisionModule from '#src/infra/process-supervision.js';
import type * as CustodyProcessTicketModule from '#src/infra/custody-process-ticket.js';
import { beforeEach, expect, it, vi } from 'vitest';
import { spawnProviderServerTransport, type ProviderServerHandle } from '#src/providers/app-server-transport.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { providerCustodyTicket } from '#tests/helpers/provider-custody.js';

const leafState = vi.hoisted(() => ({ changed: false, held: false }));
vi.mock('#src/infra/process-supervision.js', async (original) => ({
  ...(await original<typeof ProcessSupervisionModule>()),
  cleanupSpawnedProcessGroup: async () => {
    if (leafState.held)
      return {
        kind: 'held-alive',
        subject: { kind: 'process-group', processGroupId: 1234 },
        observation: 'alive',
        exit: 'process-group-absence',
      };
    queueMicrotask(() => {
      leafState.changed = true;
    });
    return { kind: 'observed-absent', evidence: { subject: { kind: 'spawned-process-group', processGroupId: 1234 } } };
  },
}));

vi.mock('#src/infra/custody-process-ticket.js', async (original) => ({
  ...(await original<typeof CustodyProcessTicketModule>()),
  custodyProcessTicketMatches: () => true,
}));

beforeEach(() => {
  leafState.changed = false;
  leafState.held = false;
});

it('refreshes leaf evidence after awaited detached-group cleanup before reporting absence', async () => {
  const runtime = new SimulationRuntime();
  vi.spyOn(runtime.process, 'failureDomainContainment').mockReturnValue({
    observe: () => (leafState.changed ? { kind: 'unknown', reason: 'EACCES' } : { kind: 'missing' }),
    kill: () => {
      throw new Error('legacy group cleanup must not signal a leaf');
    },
  });
  runtime.spawner.enqueueSpawn({ pid: 1234, close: null });
  const handle = await spawnProviderServerTransport({
    runtime,
    detached: true,
    generation: 1,
    options: {
      provider: 'test',
      command: 'fixture',
      args: [],
      custodyTicket: providerCustodyTicket,
      failureDomainName: 'host-test',
    },
    observeProviderResponse: () => {},
    acceptFailedSpawnCleanup: (hold) => ({
      kind: 'accepted',
      owner: 'provider-host-manager',
      settlement: hold.settled,
    }),
  });
  if ('kind' in handle) throw handle.error;
  const result = await handle.close((hold) => ({
    kind: 'accepted',
    owner: 'provider-host-manager',
    settlement: hold.settled,
  }));
  expect(leafState.changed).toBe(true);
  expect(result.kind).toBe('held-unobservable');
});

it('does not signal a retained wrapper after abandoning detached-group cleanup', async () => {
  leafState.held = true;
  const runtime = new SimulationRuntime();
  const leafKill = vi.fn(() => ({ kind: 'entered' as const }));
  vi.spyOn(runtime.process, 'failureDomainContainment').mockReturnValue({
    observe: () => ({ kind: 'absent' }),
    kill: leafKill,
  });
  runtime.spawner.enqueueSpawn({ pid: 1234, close: null, kills: [{ signal: 'default', delayMs: 100_000 }] });
  const accept: Parameters<ProviderServerHandle['close']>[0] = (hold) => ({
    kind: 'accepted',
    owner: 'provider-host-manager',
    settlement: hold.settled,
  });
  const handle = await spawnProviderServerTransport({
    runtime,
    detached: true,
    generation: 1,
    options: {
      provider: 'test',
      command: 'fixture',
      args: [],
      custodyTicket: providerCustodyTicket,
      failureDomainName: 'host-test',
    },
    observeProviderResponse: () => {},
    acceptFailedSpawnCleanup: accept,
  });
  if ('kind' in handle) throw handle.error;
  const childKill = vi.spyOn(handle.child, 'kill');
  const held = await handle.close(accept);
  if (held.kind !== 'held-alive' && held.kind !== 'held-unobservable')
    throw new Error(`Expected hold, got ${held.kind}`);
  await held.operatorExit.abandon();
  const before = childKill.mock.calls.length;
  await handle.close(accept);
  expect(childKill).toHaveBeenCalledTimes(before);
  expect(leafKill).not.toHaveBeenCalled();
});
