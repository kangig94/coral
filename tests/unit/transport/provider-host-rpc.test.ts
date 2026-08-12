import { describe, expect, it, vi } from 'vitest';

import type { Principal } from '#src/security/principal.js';
import { encodeHostRef } from '#src/providers/host-ref-codec.js';
import type { HostRef } from '#src/providers/contract.js';
import { executeCatalogRequest } from '#src/transport/dispatch.js';
import {
  providerHostEvictRpcSpec,
  providerHostInspectRpcSpec,
  providerHostListRpcSpec,
} from '#src/transport/rpc/catalog.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';

const agent: Principal = {
  subject: 'agent',
  transport: 'ipc',
  credential: { kind: 'child-principal', id: 'agent' },
  binding: { kind: 'unbound' },
};
const attenuatedOperator: Principal = {
  subject: 'operator',
  transport: 'ipc',
  credential: { kind: 'child-principal', id: 'operator' },
  binding: { kind: 'unbound' },
  attenuatedCaps: new Set(['jobs:read']),
};
const operator: Principal = {
  subject: 'operator',
  transport: 'ipc',
  credential: { kind: 'boot-token', id: 'operator' },
  binding: { kind: 'unbound' },
};

describe('provider-host RPC authorization', () => {
  it.each([
    ['list', providerHostListRpcSpec, {}],
    ['inspect', providerHostInspectRpcSpec, { workDir: '/definitely/not/read', projectRoot: '/also/not/read' }],
    ['evict', providerHostEvictRpcSpec, { workDir: '/definitely/not/read', projectRoot: '/also/not/read' }],
  ] as const)(
    'denies agent and attenuated-operator %s before owner inventory or mutation',
    async (method, spec, request) => {
      const providerHosts = {
        list: vi.fn(),
        inspect: vi.fn(),
        evict: vi.fn(),
      };
      const ports = { providerHosts } as unknown as HttpHandlerPorts;

      for (const principal of [agent, attenuatedOperator]) {
        await expect(executeCatalogRequest(spec, request, ports, principal)).resolves.toMatchObject({
          kind: 'unary',
          body: { code: 'missing_capability' },
        });
      }
      expect(providerHosts.list).not.toHaveBeenCalled();
      expect(providerHosts.inspect).not.toHaveBeenCalled();
      expect(providerHosts.evict).not.toHaveBeenCalled();
    },
  );

  it('declares the mandatory capability split in the catalog', () => {
    expect(providerHostListRpcSpec.requires).toBe('system:debug');
    expect(providerHostInspectRpcSpec.requires).toBe('system:debug');
    expect(providerHostEvictRpcSpec.requires).toBe('system:shutdown');
  });

  it.each([
    [
      'provider_host_inventory_unavailable',
      'Retry the original command; if it persists, run `coral-cli backend status` and restore the unavailable owner before retrying.',
    ],
    ['provider_host_not_found', 'Rerun `coral-cli backend provider-host list`, then use a currently listed reference.'],
    [
      'provider_host_ambiguous',
      'For one listed reference, run `coral-cli backend provider-host inspect <ref>` and verify it, then run `coral-cli backend provider-host evict <ref>`; never choose a match by position.',
    ],
    [
      'provider_host_identity_integrity',
      'Do not evict: preserve the complete error output and escalate the integrity failure.',
    ],
    [
      'provider_host_stale',
      'Rerun `coral-cli backend provider-host list` and act only on a currently listed reference.',
    ],
  ] as const)('returns actionable remediation for %s', async (code, remediation) => {
    const inspect = vi.fn(async () => {
      throw Object.assign(new Error(code), { code });
    });
    const ports = { providerHosts: { list: vi.fn(), inspect, evict: vi.fn() } } as unknown as HttpHandlerPorts;

    await expect(
      executeCatalogRequest(providerHostInspectRpcSpec, { workDir: '.', projectRoot: process.cwd() }, ports, operator),
    ).resolves.toMatchObject({
      kind: 'unary',
      body: { code, remediation },
    });
  });

  it('returns every canonical matching token when work-directory resolution is ambiguous', async () => {
    const refs: readonly HostRef[] = [
      { provider: 'codex', fingerprint: 'a'.repeat(64), instanceId: 'first', leaseMode: 'shared' },
      { provider: 'claude', fingerprint: 'b'.repeat(64), instanceId: 'second', leaseMode: 'shared' },
    ];
    const evict = vi.fn(async () => {
      throw Object.assign(new Error('ambiguous provider host'), {
        code: 'provider_host_ambiguous',
        ownerIds: ['coordinator', 'proxy-a'],
        matches: refs,
      });
    });
    const ports = { providerHosts: { list: vi.fn(), inspect: vi.fn(), evict } } as unknown as HttpHandlerPorts;

    await expect(
      executeCatalogRequest(providerHostEvictRpcSpec, { workDir: '.', projectRoot: process.cwd() }, ports, operator),
    ).resolves.toMatchObject({
      kind: 'unary',
      statusCode: 409,
      body: {
        code: 'provider_host_ambiguous',
        detail: { hostRefs: refs.map(encodeHostRef) },
      },
    });
    expect(evict).toHaveBeenCalledExactlyOnceWith({ workDir: process.cwd() });
  });

  it('returns the same canonical ambiguity detail for inspect without returning a host', async () => {
    const refs: readonly HostRef[] = [
      { provider: 'codex', fingerprint: 'a'.repeat(64), instanceId: 'first', leaseMode: 'shared' },
      { provider: 'codex', fingerprint: 'b'.repeat(64), instanceId: 'second', leaseMode: 'shared' },
    ];
    const inspect = vi.fn(async () => {
      throw Object.assign(new Error('ambiguous provider host'), {
        code: 'provider_host_ambiguous',
        ownerIds: ['coordinator', 'proxy-a'],
        matches: refs,
      });
    });
    const ports = { providerHosts: { list: vi.fn(), inspect, evict: vi.fn() } } as unknown as HttpHandlerPorts;

    await expect(
      executeCatalogRequest(providerHostInspectRpcSpec, { workDir: '.', projectRoot: process.cwd() }, ports, operator),
    ).resolves.toMatchObject({
      kind: 'unary',
      statusCode: 409,
      body: {
        code: 'provider_host_ambiguous',
        detail: { hostRefs: refs.map(encodeHostRef) },
      },
    });
    expect(inspect).toHaveBeenCalledExactlyOnceWith({ workDir: process.cwd() });
  });
});
