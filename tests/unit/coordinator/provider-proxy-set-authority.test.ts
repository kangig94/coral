import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildGuardianSpawnUndo } from '#src/coordinator/live/provider-proxy/spawn-undo.js';
import {
  createProviderProxySetAuthority,
  type ProviderProxySetAuthorityDependencies,
} from '#src/coordinator/live/provider-proxy/set-authority.js';
import type { ControlClient } from '#src/provider-proxy/control-client.js';
import { PROXY_DISAPPEARANCE_CONFIRM_MS, SIGKILL_GRACE_MS, SIGTERM_GRACE_MS } from '#src/infra/process-constants.js';
import {
  DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
  PROXY_TEARDOWN_RESERVE_MS,
} from '#src/provider-proxy/orphan-deadline.js';
import { PROXY_CONTROL_RPC_TIMEOUT_MS } from '#src/provider-proxy/protocol.js';
import type {
  CoordinatorIdentity,
  GuardianIdentity,
  ProxyIdentity,
  ReaperIdentity,
} from '#src/provider-proxy/protocol.js';
import type { SpawnedRoleProcess } from '#src/provider-proxy/role-spawn.js';
import type { ChildProcessLike } from '#src/infra/port-types.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';
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

const COORDINATOR_IDENTITY: CoordinatorIdentity = {
  instanceId: '55555555-5555-4555-8555-555555555555',
  pid: 1,
  processStartedAtSeconds: 900,
  generation: 'gen2',
  flavor: 'prod',
  buildSetId: GUARDIAN_IDENTITY.buildSetId,
};

/** A client that must never be called — a test that reaches it is exercising a path it did not mean to. */
function unreachableClient(): ControlClient {
  return {
    call: () => Promise.reject(new Error('unreachable: this client was not expected to be called')),
    faulted: new Promise<never>(() => undefined),
    onFault: () => () => undefined,
    close: () => {},
  };
}

function inactiveHeartbeats() {
  return {
    proxy: { stop: () => undefined },
    guardian: { stop: () => undefined },
    reaper: { stop: () => undefined },
  };
}

/** `runtime.ids`/`env`/`storage` for the `stopAndReap`-only describe blocks below. */
function unusedRuntimePorts(): Pick<Runtime, 'ids' | 'env' | 'storage'> {
  const fail = (member: string) => (): never => {
    throw new Error(`unexpected use of runtime.${member} during stopAndReap`);
  };
  return {
    ids: { uuid: fail('ids.uuid'), randomBytes: fail('ids.randomBytes') } as unknown as Runtime['ids'],
    env: { get: fail('env.get') } as unknown as Runtime['env'],
    storage: new Proxy({}, { get: fail('storage') }) as unknown as Runtime['storage'],
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
    faulted: new Promise<never>(() => undefined),
    onFault: () => () => undefined,
    close: () => {},
  };
}

function authorityWithGuardianClient(
  guardianClient: ControlClient,
  providerRoots: ReadonlyArray<{ pid: number; processStartedAtSeconds: number }> = [],
): ReturnType<typeof createProviderProxySetAuthority> {
  const deps: ProviderProxySetAuthorityDependencies = {
    proxyInstanceId: PROXY_IDENTITY.proxyInstanceId,
    guardianClient,
    proxyClient: unreachableClient(),
    reaperClient: guardianClient,
    guardianIdentity: GUARDIAN_IDENTITY,
    reaperIdentity: REAPER_IDENTITY,
    proxyIdentityFields: PROXY_IDENTITY,
    heartbeats: inactiveHeartbeats(),
    coordinatorIdentity: COORDINATOR_IDENTITY,
    handoffCapsulePath: '/dev/null/unused-handoff-capsule.json',
    runtime: unusedRuntimePorts(),
    operationRegistry: { operationsFor: () => [], providerRootsFor: () => providerRoots },
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

    await expect(pending).resolves.toEqual({ disappearanceReceipt: 'guardian:gone;reaper:gone' });
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

describe('createProviderProxySetAuthority: stopAndReap providerRoots', () => {
  it('names this coordinator’s own recorded provider roots, not an empty claim the guardian would refuse', async () => {
    const calls: unknown[] = [];
    const client: ControlClient = {
      call: (_method, params) => {
        calls.push(params);
        return Promise.resolve({ state: 'containment-absent', disappearanceReceipt: 'gone' });
      },
      faulted: new Promise<never>(() => undefined),
      onFault: () => () => undefined,
      close: () => {},
    };
    const root = { pid: 9_001, processStartedAtSeconds: 700 };
    const authority = authorityWithGuardianClient(client, [root]);

    const result = await authority.stopAndReap(new AbortController().signal);

    // Hardcoding `providerRoots: []` here is exactly the defect: both enforcers refuse a teardown that
    // disagrees with what they actually recorded, so an empty claim against a set with a real staged root
    // always fails — this asserts the actual wire params carried the registry's own roots instead.
    expect(calls).toEqual([
      expect.objectContaining({ providerRoots: [root], guardian: GUARDIAN_IDENTITY }),
      expect.objectContaining({ providerRoots: [root], reaper: REAPER_IDENTITY }),
    ]);
    expect(result).toEqual({ disappearanceReceipt: 'guardian:gone;reaper:gone' });
  });

  it('names an empty set when this coordinator holds no live operations against the proxy', async () => {
    const calls: unknown[] = [];
    const client: ControlClient = {
      call: (_method, params) => {
        calls.push(params);
        return Promise.resolve({ state: 'containment-absent', disappearanceReceipt: 'gone' });
      },
      faulted: new Promise<never>(() => undefined),
      onFault: () => () => undefined,
      close: () => {},
    };
    const authority = authorityWithGuardianClient(client, []);

    await authority.stopAndReap(new AbortController().signal);

    expect(calls).toEqual([
      expect.objectContaining({ providerRoots: [], guardian: GUARDIAN_IDENTITY }),
      expect.objectContaining({ providerRoots: [], reaper: REAPER_IDENTITY }),
    ]);
  });
});

describe('createProviderProxySetAuthority: continuous recovery', () => {
  const OPERATION = {
    jobId: '88888888-8888-4888-8888-888888888888',
    operationId: '66666666-6666-4666-8666-666666666666',
    proxyInstanceId: PROXY_IDENTITY.proxyInstanceId,
    buildSetId: GUARDIAN_IDENTITY.buildSetId,
  };
  const INSTALL_ACK = { state: 'installed-dormant' as const, grantId: '77777777-7777-4777-8777-777777777777' };
  type InstallCall = { role: string; method: string; params: unknown };

  const tempRoots: string[] = [];
  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** Records every call made to a role's client and answers the named install method with the fixture above,
   *  or the configured failure for that one role. */
  function recordingClient(role: 'guardian' | 'reaper' | 'proxy', calls: InstallCall[], fail?: string): ControlClient {
    return {
      call: (method: string, params: unknown) => {
        calls.push({ role, method, params });
        if (fail !== undefined && method === fail) {
          return Promise.reject(new Error(`${role} refused ${method}`));
        }
        if (method.includes('succession.register') || method.includes('succession-register')) {
          return Promise.resolve({
            state: 'succession-registered',
            operation: (params as { operation: unknown }).operation,
          });
        }
        return Promise.resolve(INSTALL_ACK);
      },
      faulted: new Promise<never>(() => undefined),
      onFault: () => () => undefined,
      close: () => {},
    };
  }

  function authorityForInstall(options: {
    calls: InstallCall[];
    fail?: 'guardian' | 'reaper' | 'proxy';
    failMethod?: string;
  }): { authority: ReturnType<typeof createProviderProxySetAuthority>; handoffCapsulePath: string } {
    const tempRoot = mkdtempSync(join(tmpdir(), 'coral-install-handoff-grant-'));
    tempRoots.push(tempRoot);
    const handoffCapsulePath = join(tempRoot, 'proxy.handoff.json');
    const runtime = createRealRuntime('dev', { baseDir: tempRoot });
    const deps: ProviderProxySetAuthorityDependencies = {
      proxyInstanceId: PROXY_IDENTITY.proxyInstanceId,
      guardianClient: recordingClient(
        'guardian',
        options.calls,
        options.fail === 'guardian' ? (options.failMethod ?? 'guardian.handoff-install.v1') : undefined,
      ),
      reaperClient: recordingClient(
        'reaper',
        options.calls,
        options.fail === 'reaper' ? (options.failMethod ?? 'reaper.handoff-install.v1') : undefined,
      ),
      proxyClient: recordingClient(
        'proxy',
        options.calls,
        options.fail === 'proxy' ? (options.failMethod ?? 'handoff.install.v1') : undefined,
      ),
      guardianIdentity: GUARDIAN_IDENTITY,
      reaperIdentity: REAPER_IDENTITY,
      proxyIdentityFields: PROXY_IDENTITY,
      heartbeats: inactiveHeartbeats(),
      coordinatorIdentity: COORDINATOR_IDENTITY,
      handoffCapsulePath,
      runtime,
      operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
    };
    return { authority: createProviderProxySetAuthority(deps), handoffCapsulePath };
  }

  it('installs one standing credential on all roles and keeps its secret only in the mode-0600 capsule', async () => {
    const calls: InstallCall[] = [];
    const { authority, handoffCapsulePath } = authorityForInstall({ calls });

    await authority.installRecoveryCredential(new AbortController().signal);
    await authority.registerSuccessionOperation(OPERATION);

    expect(calls.map((call) => call.method)).toEqual(
      expect.arrayContaining([
        'guardian.handoff-install.v1',
        'reaper.handoff-install.v1',
        'handoff.install.v1',
        'guardian.succession-register-operation.v1',
        'reaper.succession-register-operation.v1',
        'succession.register-operation.v1',
      ]),
    );

    const written = JSON.parse(readFileSync(handoffCapsulePath, 'utf-8')) as {
      version: number;
      buildSetId: string;
      orphanTimeoutMs: number;
      teardownReserveMs: number;
      operations?: readonly unknown[];
      committedThroughProviderSeq?: number;
    };
    expect(written.version).toBe(1);
    expect(written.buildSetId).toBe(GUARDIAN_IDENTITY.buildSetId);
    expect(written.orphanTimeoutMs).toBe(DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS);
    expect(written.teardownReserveMs).toBe(PROXY_TEARDOWN_RESERVE_MS);
    // The two fields the design review found with a second, non-authoritative home: neither belongs in a
    // durable artifact a successor might one day trust in place of the store or the proxy's live ledger.
    expect(written.operations).toBeUndefined();
    expect(written.committedThroughProviderSeq).toBeUndefined();
    expect((statSync(handoffCapsulePath).mode & 0o777).toString(8)).toBe('600');
  });

  it('writes no capsule when one authority refuses its install call', async () => {
    const calls: InstallCall[] = [];
    const { authority, handoffCapsulePath } = authorityForInstall({ calls, fail: 'reaper' });

    await expect(authority.installRecoveryCredential(new AbortController().signal)).rejects.toThrow(/reaper refused/u);
    expect(() => statSync(handoffCapsulePath)).toThrow();
  });

  it('registers a non-executing journal operation in standing succession membership', async () => {
    const calls: InstallCall[] = [];
    const pendingOperation = {
      jobId: '88888888-8888-4888-8888-888888888889',
      operationId: '66666666-6666-4666-8666-666666666667',
      proxyInstanceId: PROXY_IDENTITY.proxyInstanceId,
      buildSetId: GUARDIAN_IDENTITY.buildSetId,
    };
    const { authority } = authorityForInstall({ calls });

    await authority.registerSuccessionOperation(pendingOperation);

    const proxyRegistration = calls.find((call) => call.method === 'succession.register-operation.v1');
    expect(proxyRegistration?.params).toEqual({
      operation: pendingOperation,
    });
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

type SignalCall = { pid: number; signal: NodeJS.Signals | 0 };

/**
 * `isAlive` is answered by the test, not stubbed away: it is what decides between "the group went quietly"
 * and "escalate", so a runtime missing it would let the escalation path pass untested — which is how the
 * partial mock this replaces went unnoticed.
 */
function guardianUndoRuntime(time: VirtualTime, isAlive: () => boolean, killCalls: SignalCall[]): Runtime {
  return {
    time,
    process: {
      kill: (pid: number, signal: NodeJS.Signals | 0) => {
        killCalls.push({ pid, signal });
        return true;
      },
      isAlive,
    },
  } as unknown as Runtime;
}

describe('buildGuardianSpawnUndo', () => {
  it("signals the guardian's process group, not its bare pid", async () => {
    const time = new VirtualTime();
    const killCalls: SignalCall[] = [];
    const runtime = guardianUndoRuntime(time, () => false, killCalls);
    const spawned = fakeSpawnedGuardian(4_242, 1_000);

    const undo = buildGuardianSpawnUndo(runtime, spawned, 'linux', () => spawned.processStartedAtSeconds);
    await undo();

    // detached:true makes the guardian its own process-group leader (and it spawns the reaper into that
    // group before this coordinator holds control on either), so undo must reap the whole group — the
    // negative-pid convention `process.kill` understands — not just the guardian's own pid.
    expect(killCalls).toEqual([{ pid: -spawned.pid, signal: 'SIGTERM' }]);
  });

  it('waits out the teardown reserve for a group still reaping rather than force-killing it mid-reap', async () => {
    const time = new VirtualTime();
    const killCalls: SignalCall[] = [];
    // Alive while the guardian drives its own enforcer's stopAndReap, gone before the reserve runs out.
    const disappearsAt = time.now() + PROXY_TEARDOWN_RESERVE_MS / 2;
    const runtime = guardianUndoRuntime(time, () => time.now() < disappearsAt, killCalls);
    const spawned = fakeSpawnedGuardian(4_242, 1_000);

    const pending = buildGuardianSpawnUndo(runtime, spawned, 'linux', () => spawned.processStartedAtSeconds)();
    time.tick(PROXY_TEARDOWN_RESERVE_MS);
    await pending;

    expect(killCalls).toEqual([{ pid: -spawned.pid, signal: 'SIGTERM' }]);
  });

  it('escalates to SIGKILL on the group once the teardown reserve is spent', async () => {
    const time = new VirtualTime();
    const killCalls: SignalCall[] = [];
    const runtime = guardianUndoRuntime(time, () => true, killCalls);
    const spawned = fakeSpawnedGuardian(4_242, 1_000);

    const pending = buildGuardianSpawnUndo(runtime, spawned, 'linux', () => spawned.processStartedAtSeconds)();
    time.tick(PROXY_TEARDOWN_RESERVE_MS);
    await pending;

    // The same group, again: a guardian that spent its whole reserve without disappearing is not going to,
    // and leaving it holding the proxy containment is the one outcome this undo exists to rule out.
    expect(killCalls).toEqual([
      { pid: -spawned.pid, signal: 'SIGTERM' },
      { pid: -spawned.pid, signal: 'SIGKILL' },
    ]);
  });

  it('refuses to signal once the recorded start time no longer matches (recycled pid)', async () => {
    const time = new VirtualTime();
    const killCalls: SignalCall[] = [];
    const runtime = guardianUndoRuntime(time, () => true, killCalls);
    const spawned = fakeSpawnedGuardian(4_242, 1_000);
    // A different start time than what this acquisition recorded at spawn time: pid 4242 now names some
    // other process, and signalling it would kill a stranger.
    const readProcessStartedAtSeconds = (): number => 9_999;

    const undo = buildGuardianSpawnUndo(runtime, spawned, 'linux', readProcessStartedAtSeconds);
    await undo();

    expect(killCalls).toEqual([]);
  });
});
