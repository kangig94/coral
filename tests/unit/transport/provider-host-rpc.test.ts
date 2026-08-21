import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { backendLog } from '#src/infra/backend-log.js';
import type { Principal } from '#src/security/principal.js';
import { encodeHostRef } from '#src/providers/host-ref-codec.js';
import type { HostRef } from '#src/providers/contract.js';
import { canonicalizeWorkDir } from '#src/runtime/canonical-work-dir.js';
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

  it.each([
    ['inspect', providerHostInspectRpcSpec, 'inspect'],
    ['evict', providerHostEvictRpcSpec, 'evict'],
  ] as const)('routes provider-host %s for a separator-confusable child directory', async (_route, spec, method) => {
    const root = mkdtempSync(join(tmpdir(), 'coral-provider-host-rpc-dotdot-name-'));
    const allowed = join(root, 'a');
    const child = join(allowed, '..b');
    mkdirSync(allowed);
    mkdirSync(child);
    const reachedOwner = new Error(`provider_host_${method}_reached_owner`);
    const providerHosts = {
      list: vi.fn(),
      inspect: vi.fn(async () => {
        throw reachedOwner;
      }),
      evict: vi.fn(async () => {
        throw reachedOwner;
      }),
    };
    const ports = { providerHosts } as unknown as HttpHandlerPorts;
    const boundOperator = {
      ...operator,
      binding: { kind: 'project', root: canonicalizeWorkDir(allowed, root) },
    } satisfies Principal;

    try {
      await expect(
        executeCatalogRequest(spec, { workDir: '..b', projectRoot: allowed }, ports, boundOperator),
      ).rejects.toBe(reachedOwner);
      expect(providerHosts[method]).toHaveBeenCalledExactlyOnceWith({ workDir: canonicalizeWorkDir(child, allowed) });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('declares the mandatory capability split in the catalog', () => {
    expect(providerHostListRpcSpec.requires).toBe('system:debug');
    expect(providerHostInspectRpcSpec.requires).toBe('system:debug');
    expect(providerHostEvictRpcSpec.requires).toBe('system:shutdown');
  });

  it.each([
    ['inspect', providerHostInspectRpcSpec, 'inspect'],
    ['evict', providerHostEvictRpcSpec, 'evict'],
  ] as const)(
    'denies and audits a canonical work-directory escape before contacting the %s owner',
    async (_route, spec, ownerMethod) => {
      const root = mkdtempSync(join(tmpdir(), 'coral-provider-host-rpc-authz-'));
      const allowed = join(root, 'allowed');
      const outside = join(root, 'outside');
      mkdirSync(allowed);
      mkdirSync(outside);
      symlinkSync(outside, join(allowed, 'escape'), 'dir');

      const providerHosts = {
        list: vi.fn(),
        inspect: vi.fn(() => {
          throw new Error('provider_host_inspect_owner_contacted_before_authorization');
        }),
        evict: vi.fn(() => {
          throw new Error('provider_host_evict_owner_contacted_before_authorization');
        }),
      };
      const ports = { providerHosts } as unknown as HttpHandlerPorts;
      const boundOperator = {
        ...operator,
        binding: { kind: 'project', root: canonicalizeWorkDir(allowed, root) },
      } satisfies Principal;
      const canonicalOutside = canonicalizeWorkDir(outside, root);
      const warn = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

      try {
        const result = await executeCatalogRequest(
          spec,
          { workDir: 'escape', projectRoot: allowed },
          ports,
          boundOperator,
        );

        expect(result).toMatchObject({ kind: 'unary', statusCode: 403, body: { code: 'scope_mismatch' } });
        expect(providerHosts[ownerMethod]).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledOnce();
        const auditLine = String(warn.mock.calls[0]?.[0]);
        expect(auditLine.startsWith('audit ')).toBe(true);
        const audit = JSON.parse(auditLine.slice('audit '.length)) as Record<string, unknown>;
        expect(audit).toMatchObject({
          event: 'authorization_decision',
          method: spec.name,
          binding: { kind: 'project', root: canonicalOutside },
          decision: {
            ok: false,
            reason: 'resource_unbound',
            detail: { requestedBinding: { kind: 'project', root: canonicalOutside } },
          },
        });
      } finally {
        warn.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    [
      'provider_host_inventory_unavailable',
      'Retry the original command; if it persists, run `coral-cli backend shutdown`, then retry the original command to start a fresh coordinator.',
    ],
    ['provider_host_not_found', 'Rerun `coral-cli backend provider-host list`, then use a currently listed reference.'],
    [
      'provider_host_ambiguous',
      'For one listed reference, run `coral-cli backend provider-host inspect <ref>` and verify it, then run `coral-cli backend provider-host evict <ref>`; never choose a match by position.',
    ],
    [
      'provider_host_identity_integrity',
      'Do not evict: preserve the complete error output, then run `coral-cli backend status` to capture coordinator state before escalating the integrity failure.',
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

  it('names all three inventory statuses when no provider host matches', async () => {
    const inspect = vi.fn(async () => {
      throw Object.assign(new Error('provider_host_not_found'), { code: 'provider_host_not_found' });
    });
    const ports = { providerHosts: { list: vi.fn(), inspect, evict: vi.fn() } } as unknown as HttpHandlerPorts;

    await expect(
      executeCatalogRequest(providerHostInspectRpcSpec, { workDir: '.', projectRoot: process.cwd() }, ports, operator),
    ).resolves.toMatchObject({
      kind: 'unary',
      body: { message: 'No live, retained-blocked, or reclamation-failed provider host matches the selector.' },
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
