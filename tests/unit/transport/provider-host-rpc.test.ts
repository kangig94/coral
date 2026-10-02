import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '#src/security/principal.js';
import { encodeHostRef } from '#src/providers/host-ref-codec.js';
import type { HostRef } from '#src/providers/contract.js';
import { executeCatalogRequest } from '#src/transport/dispatch.js';
import {
  providerHostEvictRpcSpec,
  providerHostListRpcSpec,
  providerHostListV2RpcSpec,
} from '#src/transport/rpc/catalog.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
const operator: Principal = {
  subject: 'operator',
  transport: 'ipc',
  credential: { kind: 'boot-token', id: 'operator' },
  binding: { kind: 'unbound' },
};

describe('provider-host RPC authorization', () => {
  it('refuses an eviction whose owner released administration control without deciding the host', async () => {
    const ref: HostRef = {
      provider: 'codex',
      fingerprint: 'c'.repeat(64),
      instanceId: 'torn-down-host',
      leaseMode: 'shared',
    };
    const encodedRef = encodeHostRef(ref);
    const evict = vi.fn(async () => {
      throw Object.assign(new Error('provider_host_owner_torn_down'), {
        code: 'provider_host_owner_torn_down',
        ownerIds: ['provider-proxy:set-a'],
        matches: [ref],
      });
    });
    const ports = { providerHosts: { list: vi.fn(), inspect: vi.fn(), evict } } as unknown as HttpHandlerPorts;

    await expect(
      executeCatalogRequest(providerHostEvictRpcSpec, { hostRef: ref }, ports, operator),
    ).resolves.toMatchObject({
      kind: 'unary',
      statusCode: 503,
      body: {
        code: 'provider_host_owner_torn_down',
        detail: { ownerIds: ['provider-proxy:set-a'], hostRefs: [encodedRef] },
      },
    });
  });

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
