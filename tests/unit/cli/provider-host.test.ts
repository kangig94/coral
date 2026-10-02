import { describe, expect, it } from 'vitest';

import {
  createProviderHostCommandOperations,
  formatProviderHostInspect,
  formatProviderHostList,
  parseProviderHostSelector,
} from '#src/cli/commands/backend.js';
import { IpcRpcError, type IpcClient } from '#src/transport/ipc/client.js';
import { encodeHostRef } from '#src/providers/host-ref-codec.js';
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
  it('requires exactly one selector', () => {
    expect(() => parseProviderHostSelector(undefined, undefined)).toThrow('Provide exactly one selector');
    expect(() => parseProviderHostSelector(encodeHostRef(ref), '/workspace')).toThrow('Provide exactly one selector');
  });

  it('decodes a positional token and preserves a raw work-directory selector', () => {
    expect(parseProviderHostSelector(encodeHostRef(ref), undefined)).toEqual({ hostRef: ref });
    expect(parseProviderHostSelector(undefined, './relative-workspace')).toEqual({
      workDir: './relative-workspace',
      projectRoot: process.cwd(),
    });
  });

  it('formats copyable canonical tokens and distinguishes retained blocked hosts', () => {
    const token = encodeHostRef(ref);
    expect(formatProviderHostList({ hosts: [host], tornDownOwnerIds: [] })).toContain(`${token}\tretired-blocked`);
    expect(formatProviderHostInspect({ host })).toContain(`"hostRef": "${token}"`);
  });

  it('names the unobserved owners by their error code ahead of the rows, with the status command rendered', () => {
    const listed = formatProviderHostList({
      hosts: [host],
      tornDownOwnerIds: ['provider-proxy:set-a', 'provider-proxy:set-b'],
    });
    expect(listed.split('\n').slice(0, 2)).toEqual([
      'provider_host_owner_torn_down: administration control released for provider-proxy:set-a, provider-proxy:set-b; their hosts are not listed.',
      'command=coral-cli backend status',
    ]);
    expect(listed.split('\n')[2]).toBe('HOST_REF\tSTATUS\tOWNER\tPROVIDER\tWORK_DIR');
    expect(formatProviderHostList({ hosts: [], tornDownOwnerIds: ['provider-proxy:set-a'] })).toBe(
      [
        'provider_host_owner_torn_down: administration control released for provider-proxy:set-a; their hosts are not listed.',
        'command=coral-cli backend status',
        'No provider hosts.',
      ].join('\n'),
    );
    expect(formatProviderHostList({ hosts: [host], tornDownOwnerIds: [] })).not.toContain(
      'provider_host_owner_torn_down',
    );
  });

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

  it.each([
    [
      'an RPC error that is not method-not-found',
      new IpcRpcError({ code: -32603, message: 'Missing required capability', data: { code: 'missing_capability' } }),
    ],
    ['a failure that is not an RPC error at all', new Error('socket closed')],
  ])('propagates %s from the v2 listing without asking for v1', async (_label, thrown) => {
    const requested: string[] = [];
    const client: Pick<IpcClient, 'request'> = {
      request: async <TResult>(method: string): Promise<TResult> => {
        requested.push(method);
        throw thrown;
      },
    };

    await expect(createProviderHostCommandOperations({ getClient: async () => client }).list()).rejects.toBe(thrown);
    expect(requested).toEqual(['coordinator.provider_host.list.v2']);
  });
});
