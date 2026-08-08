import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type { AppServerProxyRouteRequest } from '#src/jobs/contracts/app-server-proxy-route.js';
import type { ProviderHostManager } from '#src/coordinator/live/provider-hosts/index.js';
import type { JobProgressStore } from '#src/jobs/contracts/job-store.js';
import type { Database } from '#src/store/db.js';
import type { HostRef } from '#src/providers/contract.js';
import type { ProviderOperationRuntimeMeta } from '#src/jobs/runtime-meta.js';
import type { ActivateProviderOperationResult } from '#src/coordinator/services/provider-proxy-operation-activation.js';
import type { ProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import { LocalOperationRegistry } from '#src/coordinator/services/operation-registry.js';
import { backendLog } from '#src/infra/backend-log.js';
import { createAppServerProxyRoute } from '#src/coordinator/services/provider-proxy-launch-route.js';

// Opaque to `createAppServerProxyRoute`: it is forwarded verbatim into `authority.activateOperation`, which
// this suite fakes entirely, so a real store is unnecessary — a distinguishable sentinel is enough to prove
// identity forwarding without pulling in `store/db.js`'s real construction machinery.
const DB_SENTINEL = { kind: 'test-db-sentinel' } as unknown as Database;

function providerOperationRuntimeMeta(
  overrides: Partial<ProviderOperationRuntimeMeta> = {},
): ProviderOperationRuntimeMeta {
  return {
    version: 1,
    jobId: randomUUID(),
    operationId: randomUUID(),
    buildSetId: randomUUID(),
    hostFingerprint: 'a'.repeat(64),
    guardianInstanceId: randomUUID(),
    guardianPid: 100,
    guardianProcessStartedAtSeconds: 1,
    guardianControlEndpoint: '/tmp/guardian.sock',
    proxyInstanceId: randomUUID(),
    proxyPid: 200,
    reaperInstanceId: randomUUID(),
    reaperPid: 300,
    reaperProcessStartedAtSeconds: 2,
    reaperControlEndpoint: '/tmp/reaper.sock',
    containmentKind: 'detached-group',
    proxyProcessStartedAtSeconds: 3,
    proxyProcessGroupId: 200,
    canonicalEndpoint: '/tmp/proxy.sock',
    reservation: randomUUID(),
    providerRootPid: 7_001,
    providerRootProcessStartedAtSeconds: 800,
    jointContainmentReceipt: 'joint-1',
    committedThroughProviderSeq: 0,
    ...overrides,
  };
}

function requestFixture(overrides: Partial<AppServerProxyRouteRequest> = {}): AppServerProxyRouteRequest {
  return {
    jobId: randomUUID(),
    operationId: randomUUID(),
    hostSpec: {
      provider: 'codex',
      command: 'codex',
      args: ['app-server'],
      cwd: '/workspace',
      leaseMode: 'job-exclusive',
    },
    provider: 'codex',
    binding: { provider: 'codex', kind: 'account', binding: { account: 'acct-1' } },
    request: {
      action: 'exec',
      sessionId: 'session-1',
      prompt: 'do the thing',
      cwd: '/workspace',
      bypassPermissions: false,
      coralEnv: {},
    },
    persistedContinuity: null,
    baseEnv: {},
    protectedEnv: {},
    platform: 'linux',
    ...overrides,
  };
}

/** A live proxy set authority whose `activateOperation` this suite fully controls — the one method
 *  `createAppServerProxyRoute` calls once `routeAppServerOperation` has already named a set. */
function fakeAuthority(
  activateOperation: ProviderProxyOperationAuthority['activateOperation'],
): ProviderProxyOperationAuthority {
  const proxyInstanceId = randomUUID();
  const buildSetId = randomUUID();
  return {
    // `operation.prepare.v1`'s wire identity requires canonical UUIDs for both fields below
    // (`operationIdentitySchema`), so this fixture mints real ones rather than readable placeholders.
    proxyInstanceId,
    setIdentity: {
      buildSetId,
      hostFingerprint: 'a'.repeat(64),
      guardianInstanceId: 'guardian-1',
      guardianPid: 100,
      guardianProcessStartedAtSeconds: 1,
      guardianControlEndpoint: '/tmp/guardian.sock',
      proxyInstanceId,
      proxyPid: 200,
      reaperInstanceId: 'reaper-1',
      reaperPid: 300,
      reaperProcessStartedAtSeconds: 2,
      reaperControlEndpoint: '/tmp/reaper.sock',
      containmentKind: 'detached-group',
      proxyProcessStartedAtSeconds: 3,
      proxyProcessGroupId: 200,
      canonicalEndpoint: '/tmp/proxy.sock',
    },
    snapshotOperations: async () => [],
    installHandoffGrant: async () => {},
    stopAndReap: async () => ({ disappearanceReceipt: 'r' }),
    stopHeartbeats: () => {},
    initiateControlClose: async () => {},
    activateOperation,
  };
}

function deps(
  overrides: {
    hostManager?: Pick<ProviderHostManager, 'routeAppServerOperation'>;
    progressStore?: Pick<JobProgressStore, 'appendRuntimeStarted'>;
    registry?: LocalOperationRegistry;
  } = {},
): {
  route: ReturnType<typeof createAppServerProxyRoute>;
  appendRuntimeStarted: ReturnType<typeof vi.fn>;
  registry: LocalOperationRegistry;
} {
  const registry = overrides.registry ?? new LocalOperationRegistry();
  const appendRuntimeStarted = vi.fn();
  const route = createAppServerProxyRoute({
    hostManager: overrides.hostManager ?? { routeAppServerOperation: () => null },
    getDb: () => DB_SENTINEL,
    progressStore: overrides.progressStore ?? { appendRuntimeStarted },
    now: () => 1_700_000_000_000,
    registry,
  });
  return { route, appendRuntimeStarted, registry };
}

describe('createAppServerProxyRoute', () => {
  it("activate returns 'executing' on a successful publication order and registers the operation", async () => {
    const meta = providerOperationRuntimeMeta();
    const control = { stop: vi.fn(async () => {}) };
    const activateOperation = vi.fn(
      async (): Promise<ActivateProviderOperationResult> => ({
        kind: 'executing',
        committedThroughProviderSeq: 0,
        meta,
        control,
      }),
    );
    const { route, appendRuntimeStarted, registry } = deps({
      hostManager: { routeAppServerOperation: () => fakeAuthority(activateOperation) },
    });
    const request = requestFixture({ jobId: meta.jobId, operationId: meta.operationId });
    const release = vi.fn();

    const result = await route.activate(request, release, new AbortController().signal);

    expect(result).toBe('executing');
    expect(activateOperation).toHaveBeenCalledWith(
      DB_SENTINEL,
      expect.objectContaining({ jobId: request.jobId, operationId: request.operationId }),
      expect.objectContaining({ provider: 'codex' }),
    );
    // Registered under this job: `stateForJob` is the registry's own read surface for "does this coordinator
    // generation currently track a live operation for this job", which is exactly what "registers the
    // operation" means from the registry's point of view.
    expect(registry.stateForJob(request.jobId)).toBe('activated');
    expect(appendRuntimeStarted).toHaveBeenCalledWith(
      request.jobId,
      expect.objectContaining({
        transport: 'app-server',
        providerMeta: expect.objectContaining({
          provider: 'codex',
          leaseState: 'acquired',
          hostRef: {
            provider: 'codex',
            fingerprint: meta.hostFingerprint,
            instanceId: meta.proxyInstanceId,
            leaseMode: 'job-exclusive',
            ownerJobId: request.jobId,
          } satisfies HostRef,
        }),
      }),
    );
  });

  it("returns 'executing' for an unknown activation outcome so local execution stays suppressed", async () => {
    const meta = providerOperationRuntimeMeta();
    const control = { stop: vi.fn(async () => {}) };
    const activateOperation = vi.fn(
      async (): Promise<ActivateProviderOperationResult> => ({
        kind: 'unknown',
        step: 'proxy-activate',
        reason: 'both activation replies timed out',
        committedThroughProviderSeq: 0,
        meta,
        control,
      }),
    );
    const { route, registry } = deps({
      hostManager: { routeAppServerOperation: () => fakeAuthority(activateOperation) },
    });
    const request = requestFixture({ jobId: meta.jobId, operationId: meta.operationId });

    const result = await route.activate(request, vi.fn(), new AbortController().signal);

    expect(result).toBe('executing');
    expect(registry.stateForJob(request.jobId)).toBe('activated');
  });

  it('reaches the registry with the exact release closure activate() was handed', async () => {
    const meta = providerOperationRuntimeMeta();
    const control = { stop: vi.fn(async () => {}) };
    const activateOperation = vi.fn(
      async (): Promise<ActivateProviderOperationResult> => ({
        kind: 'executing',
        committedThroughProviderSeq: 0,
        meta,
        control,
      }),
    );
    const { route, registry } = deps({
      hostManager: { routeAppServerOperation: () => fakeAuthority(activateOperation) },
    });
    const request = requestFixture({ jobId: meta.jobId, operationId: meta.operationId });
    const release = vi.fn();

    await route.activate(request, release, new AbortController().signal);
    expect(release).not.toHaveBeenCalled();

    // `settled()` is the registry's only caller of a registered entry's release closure — invoking it here is
    // the direct proof that *this* release (not a copy, not a no-op default) is what the registry now holds.
    registry.settled({
      jobId: meta.jobId,
      operationId: meta.operationId,
      proxyInstanceId: meta.proxyInstanceId,
      buildSetId: meta.buildSetId,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  describe('falls back to local execution identically for every unusable-set reason', () => {
    it('answers null with no live set for this executable identity', async () => {
      const { route, appendRuntimeStarted, registry } = deps({ hostManager: { routeAppServerOperation: () => null } });
      const request = requestFixture();

      const result = await route.activate(request, vi.fn(), new AbortController().signal);

      expect(result).toBeNull();
      expect(registry.stateForJob(request.jobId)).toBeNull();
      expect(appendRuntimeStarted).not.toHaveBeenCalled();
    });

    it('answers null on a typed capacity/activation-failed result, compensated and nothing written', async () => {
      const activateOperation = vi.fn(
        async (): Promise<ActivateProviderOperationResult> => ({
          kind: 'activation-failed',
          step: 'proxy-activate',
          reason: 'ledger refused activation',
        }),
      );
      const { route, appendRuntimeStarted, registry } = deps({
        hostManager: { routeAppServerOperation: () => fakeAuthority(activateOperation) },
      });
      const request = requestFixture();

      const result = await route.activate(request, vi.fn(), new AbortController().signal);

      expect(result).toBeNull();
      expect(registry.stateForJob(request.jobId)).toBeNull();
      expect(appendRuntimeStarted).not.toHaveBeenCalled();
    });

    // The fallback is identical for all three, and must stay identical — nothing durable happened, so running
    // in-process is exactly as safe. What must NOT be identical is how loudly each one passes. A set that
    // existed and refused activation is a different event from "no set" or "at capacity", and four separate
    // wire-contract breaks shipped precisely because all three returned the same silent `null`: the job still
    // completed in-process, so a dead proxy path looked exactly like a working one to tests and operators.
    it('reports a refusal but stays quiet for the routine reasons', async () => {
      const warn = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);
      try {
        const refused = deps({
          hostManager: {
            routeAppServerOperation: () =>
              fakeAuthority(
                vi.fn(
                  async (): Promise<ActivateProviderOperationResult> => ({
                    kind: 'activation-failed',
                    step: 'guardian-activate',
                    reason: 'identity_mismatch',
                  }),
                ),
              ),
          },
        });
        await refused.route.activate(requestFixture(), vi.fn(), new AbortController().signal);
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0]?.[0]).toContain('guardian-activate');
        expect(warn.mock.calls[0]?.[0]).toContain('identity_mismatch');

        warn.mockClear();
        const atCapacity = deps({
          hostManager: {
            routeAppServerOperation: () =>
              fakeAuthority(
                vi.fn(
                  async (): Promise<ActivateProviderOperationResult> => ({
                    kind: 'capacity',
                    retryable: true,
                    reason: 'ledger full',
                  }),
                ),
              ),
          },
        });
        await atCapacity.route.activate(requestFixture(), vi.fn(), new AbortController().signal);
        expect(warn).not.toHaveBeenCalled();

        warn.mockClear();
        const noSet = deps({ hostManager: { routeAppServerOperation: () => null } });
        await noSet.route.activate(requestFixture(), vi.fn(), new AbortController().signal);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('answers null when the operation.prepare.v1 RPC itself rejects', async () => {
      const activateOperation = vi.fn(async (): Promise<ActivateProviderOperationResult> => {
        throw new Error('operation.prepare.v1 timed out');
      });
      const { route, appendRuntimeStarted, registry } = deps({
        hostManager: { routeAppServerOperation: () => fakeAuthority(activateOperation) },
      });
      const request = requestFixture();

      const result = await route.activate(request, vi.fn(), new AbortController().signal);

      expect(result).toBeNull();
      expect(registry.stateForJob(request.jobId)).toBeNull();
      expect(appendRuntimeStarted).not.toHaveBeenCalled();
    });
  });
});
