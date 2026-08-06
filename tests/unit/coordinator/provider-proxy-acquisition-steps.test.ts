import { describe, expect, it } from 'vitest';

import {
  ProviderProxyHandoffGrantUnavailableError,
  buildGuardianSpawnUndo,
  createProviderProxySetAuthority,
  type ProviderProxySetAuthorityDependencies,
} from '#src/coordinator/live/provider-proxy-acquisition-steps.js';
import type { ControlClient } from '#src/provider-proxy/control-client.js';
import { PROXY_DISAPPEARANCE_CONFIRM_MS, SIGKILL_GRACE_MS, SIGTERM_GRACE_MS } from '#src/infra/process-constants.js';
import { PROXY_TEARDOWN_RESERVE_MS } from '#src/provider-proxy/orphan-deadline.js';
import { PROXY_CONTROL_RPC_TIMEOUT_MS } from '#src/provider-proxy/protocol.js';
import type { GuardianIdentity, ProxyIdentity, ReaperIdentity } from '#src/provider-proxy/protocol.js';
import type { SpawnedRoleProcess } from '#src/provider-proxy/role-spawn.js';
import type { ChildProcessLike } from '#src/infra/port-types.js';
import type { Runtime } from '#src/runtime/ports.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';

const GUARDIAN_IDENTITY: GuardianIdentity = {
  guardianInstanceId: '11111111-1111-4111-8111-111111111111',
  pid: 100,
  processStartedAtSeconds: 1_000,
  generation: 'gen2',
  flavor: 'prod',
  buildSetId: '44444444-4444-4444-8444-444444444444',
  hostFingerprint: 'a'.repeat(64),
  canonicalControlEndpoint: '/tmp/guardian.sock',
};

const REAPER_IDENTITY: ReaperIdentity = {
  reaperInstanceId: '22222222-2222-4222-8222-222222222222',
  pid: 101,
  processStartedAtSeconds: 1_000,
  guardianInstanceId: GUARDIAN_IDENTITY.guardianInstanceId,
  generation: 'gen2',
  flavor: 'prod',
  buildSetId: '44444444-4444-4444-8444-444444444444',
  hostFingerprint: 'a'.repeat(64),
  canonicalControlEndpoint: '/tmp/reaper.sock',
  containmentKind: 'detached-process-group',
};

const PROXY_IDENTITY: ProxyIdentity = {
  proxyInstanceId: '33333333-3333-4333-8333-333333333333',
  pid: 102,
  processStartedAtSeconds: 1_000,
  processGroupId: 102,
  guardianInstanceId: GUARDIAN_IDENTITY.guardianInstanceId,
  reaperInstanceId: REAPER_IDENTITY.reaperInstanceId,
  generation: 'gen2',
  flavor: 'prod',
  buildSetId: '44444444-4444-4444-8444-444444444444',
  hostFingerprint: 'a'.repeat(64),
  canonicalEndpoint: '/tmp/proxy.sock',
};

/** A client that must never be called — `installHandoffGrant`'s refusal must not touch any wire. */
function unreachableClient(): ControlClient {
  return {
    call: () => Promise.reject(new Error('unreachable: this client was not expected to be called')),
    close: () => {},
  };
}

/**
 * Mirrors the real `ControlClient.call`'s own race, without a real socket: a timeout timer at `timeoutMs`
 * (the budget the caller under test passed in) races a result timer fixed at `resolveAtMs`. Both are
 * scheduled on the injected `VirtualTime`, so a test drives the outcome with `time.tick(...)` instead of
 * sleeping in real time.
 */
function fakeControlClient(time: VirtualTime, resolveAtMs: number, result: unknown): ControlClient {
  return {
    call: (_method, _params, timeoutMs) =>
      new Promise((resolve, reject) => {
        let settled = false;
        const timeoutHandle = time.setTimeout(() => {
          if (settled) return;
          settled = true;
          time.clearTimeout(resultHandle);
          reject(new Error(`exceeded its ${timeoutMs}ms budget`));
        }, timeoutMs);
        const resultHandle = time.setTimeout(() => {
          if (settled) return;
          settled = true;
          time.clearTimeout(timeoutHandle);
          resolve(result);
        }, resolveAtMs);
      }),
    close: () => {},
  };
}

function authorityWithGuardianClient(
  guardianClient: ControlClient,
): ReturnType<typeof createProviderProxySetAuthority> {
  const deps: ProviderProxySetAuthorityDependencies = {
    proxyInstanceId: PROXY_IDENTITY.proxyInstanceId,
    guardianClient,
    proxyClient: unreachableClient(),
    reaperClient: unreachableClient(),
    guardianIdentity: GUARDIAN_IDENTITY,
    reaperIdentity: REAPER_IDENTITY,
    proxyIdentityFields: PROXY_IDENTITY,
    heartbeats: [],
  };
  return createProviderProxySetAuthority(deps);
}

describe('createProviderProxySetAuthority: stopAndReap budget', () => {
  it('confirms a teardown against a stubborn target that spends the full SIGTERM+SIGKILL escalation', async () => {
    const time = new VirtualTime();
    // The minimum time a legitimate hard reap takes when the target does not die on the first signal: SIGTERM
    // grace, then SIGKILL grace, then the disappearance confirmation window — the exact floor
    // `guardian.stop-and-reap.v1`'s `budgetMs: 'caller-deadline'` exists to protect, and exclusive of any
    // per-syscall overhead. A budget below this floor cannot ever succeed against a stubborn process, so this
    // is deliberately the value under test rather than an arbitrary number that merely exceeds the bug's
    // 5s budget.
    const stubbornReapFloorMs = SIGTERM_GRACE_MS + SIGKILL_GRACE_MS + PROXY_DISAPPEARANCE_CONFIRM_MS;
    expect(stubbornReapFloorMs).toBe(11_000);
    expect(stubbornReapFloorMs).toBeGreaterThan(PROXY_CONTROL_RPC_TIMEOUT_MS);
    expect(stubbornReapFloorMs).toBeLessThan(PROXY_TEARDOWN_RESERVE_MS);
    const client = fakeControlClient(time, stubbornReapFloorMs, {
      state: 'containment-absent',
      disappearanceReceipt: 'gone',
    });
    const authority = authorityWithGuardianClient(client);

    const pending = authority.stopAndReap(new AbortController().signal);
    time.tick(stubbornReapFloorMs);

    await expect(pending).resolves.toEqual({ disappearanceReceipt: 'gone' });
  });

  it('still reports unconfirmed when the caller signal aborts before the reap answers', async () => {
    const time = new VirtualTime();
    const client = fakeControlClient(time, PROXY_TEARDOWN_RESERVE_MS - 1, {
      state: 'containment-absent',
      disappearanceReceipt: 'gone',
    });
    const authority = authorityWithGuardianClient(client);
    const deadline = new AbortController();

    const pending = authority.stopAndReap(deadline.signal);
    deadline.abort();
    const result = await pending;

    expect(result).toHaveProperty('unconfirmed');
  });
});

describe('createProviderProxySetAuthority: RPC response validation', () => {
  it('refuses a malformed stop-and-reap response instead of propagating it as confirmed', async () => {
    const time = new VirtualTime();
    // Missing `disappearanceReceipt` — a peer that answered but not with the shape the contract promises.
    const client = fakeControlClient(time, 50, { state: 'containment-absent' });
    const authority = authorityWithGuardianClient(client);

    const pending = authority.stopAndReap(new AbortController().signal);
    time.tick(50);
    const result = await pending;

    expect(result).not.toHaveProperty('disappearanceReceipt');
    expect(result).toHaveProperty('unconfirmed');
  });
});

describe('createProviderProxySetAuthority: installHandoffGrant', () => {
  it('refuses with its named error instead of half-installing a grant no successor could find', async () => {
    const authority = authorityWithGuardianClient(unreachableClient());

    await expect(authority.installHandoffGrant([], new AbortController().signal)).rejects.toBeInstanceOf(
      ProviderProxyHandoffGrantUnavailableError,
    );
  });

  it('names what is missing: no reaper install RPC, no successor capsule', async () => {
    const authority = authorityWithGuardianClient(unreachableClient());

    await expect(authority.installHandoffGrant([], new AbortController().signal)).rejects.toThrow(
      /reaper\.handoff-install\.v1/u,
    );
  });
});

function fakeSpawnedGuardian(pid: number, processStartedAtSeconds: number): SpawnedRoleProcess {
  return {
    child: {} as unknown as ChildProcessLike,
    pid,
    processStartedAtSeconds,
    // Never settles — these tests exercise the undo path, not the spawn-error race `spawnFailed` exists for.
    spawnFailed: new Promise<never>(() => {}),
  };
}

describe('buildGuardianSpawnUndo', () => {
  it("signals the guardian's process group, not its bare pid", () => {
    const time = new VirtualTime();
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    const runtime = {
      time,
      process: {
        kill: (pid: number, signal: NodeJS.Signals | 0) => {
          killCalls.push({ pid, signal });
          return true;
        },
      },
    } as unknown as Runtime;
    const spawned = fakeSpawnedGuardian(4_242, 1_000);

    const undo = buildGuardianSpawnUndo(runtime, spawned, 'linux', () => spawned.processStartedAtSeconds);
    undo();

    // detached:true makes the guardian its own process-group leader (and it spawns the reaper into that
    // group before this coordinator holds control on either), so undo must reap the whole group — the
    // negative-pid convention `process.kill` understands — not just the guardian's own pid.
    expect(killCalls).toEqual([{ pid: -spawned.pid, signal: 'SIGTERM' }]);
  });

  it('refuses to signal once the recorded start time no longer matches (recycled pid)', () => {
    const time = new VirtualTime();
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    const runtime = {
      time,
      process: {
        kill: (pid: number, signal: NodeJS.Signals | 0) => {
          killCalls.push({ pid, signal });
          return true;
        },
      },
    } as unknown as Runtime;
    const spawned = fakeSpawnedGuardian(4_242, 1_000);
    // A different start time than what this acquisition recorded at spawn time: pid 4242 now names some
    // other process, and signalling it would kill a stranger.
    const readProcessStartedAtSeconds = (): number => 9_999;

    const undo = buildGuardianSpawnUndo(runtime, spawned, 'linux', readProcessStartedAtSeconds);
    undo();

    expect(killCalls).toEqual([]);
  });
});
