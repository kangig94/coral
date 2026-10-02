import { describe, expect, it } from 'vitest';

import { createProviderHostCommandOperations } from '#src/cli/commands/backend.js';
import { IpcRpcError, type IpcClient } from '#src/transport/ipc/client.js';
import type { HostRef } from '#src/providers/contract.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

const ref: HostRef = {
  provider: 'codex',
  fingerprint: 'a'.repeat(64),
  instanceId: 'host-instance',
  leaseMode: 'shared',
};

const host = {
  ownerId: 'coordinator:test-instance',
  ref,
  status: 'retired-blocked' as const,
  spec: {
    provider: 'codex',
    command: 'codex',
    args: ['app-server'],
    cwd: fixtureCanonicalWorkDir('/workspace'),
    leaseMode: 'shared' as const,
    idleRetirement: 'never' as const,
  },
  host: { owner: 'coordinator' },
  diagnostics: {
    hostLog: { entries: [], retainedBytes: 0, truncatedBeforeSeq: 0 },
    completedObservations: [],
    factsTruncatedBeforeSeq: 0,
  },
  diagnosticsRetention: { ownerBudgetTruncated: false },
};

describe('provider-host CLI contracts', () => {
  it('asks the v2 listing first and falls back to a complete v1 listing on an older coordinator', async () => {
    const answers = new Map<string, unknown>([
      ['coordinator.provider_host.list', { hosts: [host] }],
      ['coordinator.provider_host.list.v2', { hosts: [host], tornDownOwnerIds: ['provider-proxy:set-a'] }],
    ]);
    const requested: string[] = [];
    const client: Pick<IpcClient, 'request'> = {
      request: async <TResult>(method: string): Promise<TResult> => {
        requested.push(method);
        const answer = answers.get(method);
        if (answer === undefined) throw new IpcRpcError({ code: -32601, message: 'Method not found' });
        return answer as TResult;
      },
    };

    await expect(createProviderHostCommandOperations({ getClient: async () => client }).list()).resolves.toEqual({
      hosts: [host],
      tornDownOwnerIds: ['provider-proxy:set-a'],
    });
    expect(requested).toEqual(['coordinator.provider_host.list.v2']);

    answers.delete('coordinator.provider_host.list.v2');
    requested.length = 0;
    await expect(createProviderHostCommandOperations({ getClient: async () => client }).list()).resolves.toEqual({
      hosts: [host],
      tornDownOwnerIds: [],
    });
    expect(requested).toEqual(['coordinator.provider_host.list.v2', 'coordinator.provider_host.list']);
  });
});
