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
  providerHostListV2RpcSpec,
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

  it('keeps each list generation strict about its own shape, so only v2 can carry a torn-down owner', () => {
    expect(providerHostListV2RpcSpec.requires).toBe(providerHostListRpcSpec.requires);
    expect(
      providerHostListV2RpcSpec.responseSchema.parse({ hosts: [], tornDownOwnerIds: ['provider-proxy:set-a'] }),
    ).toEqual({ hosts: [], tornDownOwnerIds: ['provider-proxy:set-a'] });
    expect(providerHostListRpcSpec.responseSchema.safeParse({ hosts: [], tornDownOwnerIds: [] }).success).toBe(false);
    expect(providerHostListV2RpcSpec.responseSchema.safeParse({ hosts: [] }).success).toBe(false);
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

  it('reports a released provider-host owner without soliciting a destructive set decision', async () => {
    const inspect = vi.fn(async () => {
      throw Object.assign(new Error('provider_host_owner_torn_down'), { code: 'provider_host_owner_torn_down' });
    });
    const ports = { providerHosts: { list: vi.fn(), inspect, evict: vi.fn() } } as unknown as HttpHandlerPorts;

    const result = await executeCatalogRequest(
      providerHostInspectRpcSpec,
      { workDir: '.', projectRoot: process.cwd() },
      ports,
      operator,
    );

    expect(result).toMatchObject({
      kind: 'unary',
      body: {
        code: 'provider_host_owner_torn_down',
        remediation:
          "Run `coral-cli backend status`. If it reports this coordinator as draining, the drain ends by itself once its budget is exhausted; retry the original command once status no longer reports it as shutting down. If it does not report draining, status instead reports the released set under its own token together with that set's exact next action; take the action status reports for that token.",
      },
    });
    // Neither destructive command is named directly: the reader is pointed at `backend status`'s own
    // per-set `action=` line, which is the only surface that already knows which one currently applies.
    expect(result).not.toMatchObject({
      kind: 'unary',
      body: { remediation: expect.stringContaining('provider-proxy-set contain') },
    });
    expect(result).not.toMatchObject({
      kind: 'unary',
      body: { remediation: expect.stringContaining('provider-proxy-set abandon') },
    });
    // A refusal must not tell the reader to wait on a condition no command reports.
    expect(result).not.toMatchObject({
      kind: 'unary',
      body: { remediation: expect.stringContaining('succession') },
    });
    expect(result).not.toMatchObject({
      kind: 'unary',
      body: { remediation: expect.stringContaining('no automatic deadline') },
    });
  });

  it('returns exact-reference remediation when work-directory eviction is refused', async () => {
    const evict = vi.fn(async () => {
      throw Object.assign(new Error('exact reference required'), {
        code: 'provider_host_eviction_requires_exact_ref',
      });
    });
    const ports = { providerHosts: { list: vi.fn(), inspect: vi.fn(), evict } } as unknown as HttpHandlerPorts;

    await expect(
      executeCatalogRequest(providerHostEvictRpcSpec, { workDir: '.', projectRoot: process.cwd() }, ports, operator),
    ).resolves.toMatchObject({
      kind: 'unary',
      statusCode: 409,
      body: {
        code: 'provider_host_eviction_requires_exact_ref',
        message: 'Provider-host eviction requires an exact host reference.',
        remediation:
          'Run `coral-cli backend provider-host list`, inspect the intended host, then run `coral-cli backend provider-host evict <ref>` with its exact reference.',
      },
    });
    expect(evict).toHaveBeenCalledExactlyOnceWith({ workDir: process.cwd() });
  });

  it('renders a shutdown hold with its observation, successor, exit, and exact retry command', async () => {
    const ref: HostRef = {
      provider: 'codex',
      fingerprint: 'a'.repeat(64),
      instanceId: 'held-host',
      leaseMode: 'shared',
    };
    const evict = vi.fn(async () => {
      throw Object.assign(new Error('provider host remains held'), {
        code: 'provider_host_shutdown_held',
        ownerIds: ['proxy-a'],
        matches: [ref],
        hold: {
          kind: 'held',
          observation: 'alive',
          successorOwner: 'broker-session-pool',
          operatorExit: 'retry-broker-shutdown',
        },
      });
    });
    const ports = { providerHosts: { list: vi.fn(), inspect: vi.fn(), evict } } as unknown as HttpHandlerPorts;
    const encodedRef = encodeHostRef(ref);

    await expect(
      executeCatalogRequest(providerHostEvictRpcSpec, { hostRef: ref }, ports, operator),
    ).resolves.toMatchObject({
      kind: 'unary',
      statusCode: 409,
      body: {
        code: 'provider_host_shutdown_held',
        message: expect.stringContaining(
          `observation=alive; successorOwner=broker-session-pool; operatorExit=retry-broker-shutdown`,
        ),
        remediation: expect.stringContaining(`coral-cli backend provider-host evict ${encodedRef}`),
        detail: {
          ownerIds: ['proxy-a'],
          hostRefs: [encodedRef],
          observation: 'alive',
          successorOwner: 'broker-session-pool',
          operatorExit: 'retry-broker-shutdown',
        },
      },
    });
  });

  it('renders terminal operator abandonment with the exact subject and retained exact-reference replay', async () => {
    const ref: HostRef = {
      provider: 'codex',
      fingerprint: 'a'.repeat(64),
      instanceId: 'abandoned-host',
      leaseMode: 'shared',
    };
    const abandonment = {
      kind: 'operator-abandoned' as const,
      subject: { kind: 'unattributable-process-group' as const, processGroupId: 4_242 },
      processAbsenceProven: false as const,
      successor: { owner: 'operator-command' as const, acceptance: 'accepted' as const },
    };
    const evict = vi.fn(async () => {
      throw Object.assign(new Error('provider host cleanup ownership was abandoned'), {
        code: 'provider_host_operator_abandoned',
        ownerIds: ['proxy-a'],
        matches: [ref],
        abandonment,
      });
    });
    const ports = { providerHosts: { list: vi.fn(), inspect: vi.fn(), evict } } as unknown as HttpHandlerPorts;
    const encodedRef = encodeHostRef(ref);

    const result = await executeCatalogRequest(providerHostEvictRpcSpec, { hostRef: ref }, ports, operator);

    expect(result).toMatchObject({
      kind: 'unary',
      statusCode: 409,
      body: {
        code: 'provider_host_operator_abandoned',
        message: expect.stringContaining(`subject=${JSON.stringify(abandonment.subject)}`),
        remediation: `Inspect the recorded process because it may still be live. Retry \`coral-cli backend provider-host evict ${encodedRef}\` to recover this retained terminal disposition for the owner process's lifetime; the retry does not prove that the abandoned process exited.`,
        detail: {
          ownerIds: ['proxy-a'],
          hostRefs: [encodedRef],
          abandonment,
        },
      },
    });
    expect(JSON.stringify(result)).toContain(`coral-cli backend provider-host evict ${encodedRef}`);
  });

  it('carries a proxy-owned shutdown hold through the operator inventory response', async () => {
    const record = {
      ref: { provider: 'codex', fingerprint: 'a'.repeat(64), instanceId: 'held-host', leaseMode: 'shared' as const },
      status: 'shutdown-held' as const,
      spec: {
        provider: 'codex',
        command: 'codex',
        args: ['app-server'],
        cwd: null,
        leaseMode: 'shared' as const,
        idleRetirement: 'never' as const,
      },
      host: {
        owner: 'provider-proxy' as const,
        hostKey: 'held-host-key',
        ownerJobId: null,
        pid: 123,
        observation: 'unobservable' as const,
        successorOwner: null,
        operatorExit: 'retry-provider-shutdown',
      },
      diagnostics: {
        hostLog: { entries: [], retainedBytes: 0, truncatedBeforeSeq: 0 },
        completedObservations: [],
        factsTruncatedBeforeSeq: 0,
      },
      diagnosticsRetention: { ownerBudgetTruncated: false },
      ownerId: 'proxy-a',
    };
    const ports = {
      providerHosts: {
        list: vi.fn(async () => ({ hosts: [record], tornDownOwnerIds: [] })),
        inspect: vi.fn(),
        evict: vi.fn(),
      },
    } as unknown as HttpHandlerPorts;

    await expect(executeCatalogRequest(providerHostListRpcSpec, {}, ports, operator)).resolves.toMatchObject({
      kind: 'unary',
      body: { hosts: [record] },
    });
  });

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
        message: `This coordinator has released administration control of provider-proxy:set-a and can no longer ask it, so it cannot say whether ${encodedRef} exists on it.`,
        detail: { ownerIds: ['provider-proxy:set-a'], hostRefs: [encodedRef] },
      },
    });
  });

  it('names only a placeholder, never the work directory, when a selector resolves on no owner that answered', async () => {
    const inspect = vi.fn(async () => {
      throw Object.assign(new Error('provider_host_owner_torn_down'), {
        code: 'provider_host_owner_torn_down',
        ownerIds: ['provider-proxy:set-a'],
        matches: [],
        workDir: process.cwd(),
      });
    });
    const ports = { providerHosts: { list: vi.fn(), inspect, evict: vi.fn() } } as unknown as HttpHandlerPorts;

    const answered = await executeCatalogRequest(
      providerHostInspectRpcSpec,
      { workDir: '.', projectRoot: process.cwd() },
      ports,
      operator,
    );
    expect(answered).toMatchObject({
      kind: 'unary',
      statusCode: 503,
      body: {
        code: 'provider_host_owner_torn_down',
        message:
          'This coordinator has released administration control of provider-proxy:set-a and can no longer ask it, so it cannot say whether the selected provider host exists on it.',
        remediation: expect.stringContaining(
          'Run `coral-cli backend provider-host list`; an exact reference on an owner that answered is served now, and `coral-cli backend provider-host inspect` with that exact reference reports it. Run `coral-cli backend status`.',
        ),
        detail: { ownerIds: ['provider-proxy:set-a'], hostRefs: [], workDir: process.cwd() },
      },
    });
    if (answered.kind !== 'unary') throw new Error('expected a unary provider-host refusal');
    const rendered = JSON.stringify(answered);
    expect(rendered).not.toContain('<ref>');
    expect(rendered).not.toContain('provider-host evict');
    expect(rendered).not.toContain('provider-proxy-set contain');
    expect(rendered).not.toContain('provider-proxy-set abandon');
  });

  it('never lets a work directory carrying a newline forge an extra line in the message or remediation', async () => {
    // A POSIX directory name may contain any byte but NUL and '/', so this is a real work directory,
    // not a synthetic string only a test could produce.
    const injectedWorkDir = '/tmp/project\ncommand=coral-cli backend shutdown';
    const inspect = vi.fn(async () => {
      throw Object.assign(new Error('provider_host_owner_torn_down'), {
        code: 'provider_host_owner_torn_down',
        ownerIds: ['provider-proxy:set-a'],
        matches: [],
        workDir: injectedWorkDir,
      });
    });
    const ports = { providerHosts: { list: vi.fn(), inspect, evict: vi.fn() } } as unknown as HttpHandlerPorts;

    const answered = await executeCatalogRequest(
      providerHostInspectRpcSpec,
      { workDir: '.', projectRoot: process.cwd() },
      ports,
      operator,
    );
    if (answered.kind !== 'unary') throw new Error('expected a unary provider-host refusal');
    const body = answered.body as { message: string; remediation: string };
    expect(body.message).not.toContain('\n');
    expect(body.message).not.toContain('command=coral-cli backend shutdown');
    expect(body.remediation).not.toContain('command=coral-cli backend shutdown');
  });

  it('carries the owners a draining coordinator can no longer observe through the v2 inventory response', async () => {
    const ports = {
      providerHosts: {
        list: vi.fn(async () => ({ hosts: [], tornDownOwnerIds: ['provider-proxy:set-a'] })),
        inspect: vi.fn(),
        evict: vi.fn(),
      },
    } as unknown as HttpHandlerPorts;

    await expect(executeCatalogRequest(providerHostListV2RpcSpec, {}, ports, operator)).resolves.toMatchObject({
      kind: 'unary',
      body: { hosts: [], tornDownOwnerIds: ['provider-proxy:set-a'] },
    });
  });

  it('refuses the v1 inventory it cannot represent a torn-down owner in, and keeps its exact shape otherwise', async () => {
    const list = vi.fn(async () => ({ hosts: [], tornDownOwnerIds: ['provider-proxy:set-a'] }));
    const ports = { providerHosts: { list, inspect: vi.fn(), evict: vi.fn() } } as unknown as HttpHandlerPorts;

    await expect(executeCatalogRequest(providerHostListRpcSpec, {}, ports, operator)).resolves.toMatchObject({
      kind: 'unary',
      statusCode: 503,
      body: { code: 'provider_host_inventory_unavailable', detail: { ownerIds: ['provider-proxy:set-a'] } },
    });

    list.mockResolvedValue({ hosts: [], tornDownOwnerIds: [] });
    await expect(executeCatalogRequest(providerHostListRpcSpec, {}, ports, operator)).resolves.toEqual({
      kind: 'unary',
      body: { hosts: [] },
    });
  });

  it('names every inventory status when no provider host matches', async () => {
    const inspect = vi.fn(async () => {
      throw Object.assign(new Error('provider_host_not_found'), { code: 'provider_host_not_found' });
    });
    const ports = { providerHosts: { list: vi.fn(), inspect, evict: vi.fn() } } as unknown as HttpHandlerPorts;

    await expect(
      executeCatalogRequest(providerHostInspectRpcSpec, { workDir: '.', projectRoot: process.cwd() }, ports, operator),
    ).resolves.toMatchObject({
      kind: 'unary',
      body: {
        message: 'No live, retained-blocked, shutdown-held, or reclamation-failed provider host matches the selector.',
      },
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
