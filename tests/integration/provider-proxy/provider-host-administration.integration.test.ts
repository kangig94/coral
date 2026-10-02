import { expect, it } from 'vitest';

import {
  ProviderHostAdministrationService,
  type ProviderHostAdministrationOwner,
} from '#src/coordinator/services/provider-host-administration.js';
import type { HostRef, ProviderHostTerminalEvictionDisposition } from '#src/providers/contract.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

it('recovers accepted operator abandonment after its terminal eviction reply is lost', async () => {
  const hostRef: HostRef = {
    provider: 'codex',
    fingerprint: 'a'.repeat(64),
    instanceId: 'host-instance',
    leaseMode: 'shared',
  };
  const abandonment = {
    kind: 'operator-abandoned' as const,
    subject: { kind: 'process' as const, pid: 42 },
    processAbsenceProven: false as const,
    successor: { owner: 'operator-command' as const, acceptance: 'accepted' as const },
  };
  let terminal: ProviderHostTerminalEvictionDisposition | null = null;
  const owner: ProviderHostAdministrationOwner = {
    ownerId: 'provider-proxy:owner',
    listProviderHosts: () =>
      terminal === null
        ? [
            {
              ref: hostRef,
              status: 'live',
              spec: {
                provider: 'codex',
                command: 'codex',
                args: ['app-server'],
                cwd: fixtureCanonicalWorkDir('/workspace'),
                leaseMode: 'shared',
                idleRetirement: 'never',
              },
              host: {},
              diagnostics: {
                hostLog: { entries: [], retainedBytes: 0, truncatedBeforeSeq: 0 },
                completedObservations: [],
                factsTruncatedBeforeSeq: 0,
              },
              diagnosticsRetention: { ownerBudgetTruncated: false },
            },
          ]
        : [],
    inspectProviderHost: () => null,
    terminalEviction: () => terminal,
    evictProviderHost: async () => {
      if (terminal !== null) return terminal;
      terminal = abandonment;
      throw new Error('terminal reply was lost');
    },
  };

  const first = new ProviderHostAdministrationService({ owners: () => [owner] });
  await expect(first.evict({ hostRef })).rejects.toMatchObject({ code: 'provider_host_inventory_unavailable' });
  expect(owner.listProviderHosts()).toEqual([]);

  const successor = new ProviderHostAdministrationService({ owners: () => [owner] });
  await expect(successor.evict({ hostRef })).rejects.toMatchObject({
    code: 'provider_host_operator_abandoned',
    ownerIds: [owner.ownerId],
    matches: [hostRef],
    abandonment,
  });
});
