import type { ProcessLiveness } from '#src/infra/node-process.js';
import type { ProcessIncarnation } from '#src/infra/node-process.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildGuardianSpawnUndo } from '#src/coordinator/live/provider-proxy/spawn-undo.js';
import {
  createProviderProxySetAuthority,
  type ProviderProxySetAuthorityDependencies,
} from '#src/coordinator/live/provider-proxy/set-authority.js';
import {
  ControlClientError,
  type ControlClient,
  type ControlClientRemoteFailure,
  type ControlExchange,
} from '#src/provider-proxy/control-client.js';
import type { HandoffCapsuleV3 } from '#src/provider-proxy/handoff-capsule.js';
import {
  CONTAINMENT_DISAPPEARANCE_CONFIRM_MS,
  SIGKILL_GRACE_MS,
  SIGTERM_GRACE_MS,
} from '#src/infra/process-constants.js';
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
  incarnation: testIncarnation(1_000),
  generation: 'gen2',
  flavor: 'prod',
  buildSetId: '44444444-4444-4444-8444-444444444444',
  hostFingerprint: 'a'.repeat(64),
  canonicalControlEndpoint: '/tmp/guardian.sock',
};

const REAPER_IDENTITY: ReaperIdentity = {
  reaperInstanceId: '22222222-2222-4222-8222-222222222222',
  pid: 101,
  incarnation: testIncarnation(1_000),
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
  incarnation: testIncarnation(1_000),
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
  incarnation: testIncarnation(900),
  generation: 'gen2',
  flavor: 'prod',
  buildSetId: GUARDIAN_IDENTITY.buildSetId,
};

/** A client that must never be called — a test that reaches it is exercising a path it did not mean to. */
function unreachableClient(): ControlClient {
  return {
    exchange: () => {
      throw new Error('unreachable: this client was not expected to exchange');
    },
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

/** `runtime.ids`/`storage` plus the default deadline configuration for the `stopAndReap`-only blocks below. */
function unusedRuntimePorts(): Pick<Runtime, 'ids' | 'env' | 'storage'> {
  const fail = (member: string) => (): never => {
    throw new Error(`unexpected use of runtime.${member} during stopAndReap`);
  };
  return {
    ids: { uuid: fail('ids.uuid'), randomBytes: fail('ids.randomBytes') } as unknown as Runtime['ids'],
    env: { get: () => undefined } as unknown as Runtime['env'],
    storage: new Proxy({}, { get: fail('storage') }) as unknown as Runtime['storage'],
  };
}

/**
 * Mirrors the real `ControlClient.exchange`'s own race, without a real socket: a timeout timer at `timeoutMs`
 * (the budget the caller under test passed in) races a result timer fixed at `resolveAtMs`. Both are
 * scheduled on the injected `VirtualTime`, so a test drives the outcome with `time.tick(...)` instead of
 * sleeping in real time.
 */
function fakeControlClient(time: VirtualTime, resolveAtMs: number, result: unknown): ControlClient {
  return {
    exchange: (_method, _params, timeoutMs) =>
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
          resolve({ kind: 'response', response: { kind: 'result', value: result } });
        }, resolveAtMs);
      }),
    faulted: new Promise<never>(() => undefined),
    onFault: () => () => undefined,
    close: () => {},
  };
}

function authorityWithGuardianClient(
  guardianClient: ControlClient,
  providerRoots: ReadonlyArray<{ pid: number; incarnation: ProcessIncarnation }> = [],
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

function authorityWithProxyClient(proxyClient: ControlClient): ReturnType<typeof createProviderProxySetAuthority> {
  const deps: ProviderProxySetAuthorityDependencies = {
    proxyInstanceId: PROXY_IDENTITY.proxyInstanceId,
    guardianClient: unreachableClient(),
    proxyClient,
    reaperClient: unreachableClient(),
    guardianIdentity: GUARDIAN_IDENTITY,
    reaperIdentity: REAPER_IDENTITY,
    proxyIdentityFields: PROXY_IDENTITY,
    heartbeats: inactiveHeartbeats(),
    coordinatorIdentity: COORDINATOR_IDENTITY,
    handoffCapsulePath: '/dev/null/unused-handoff-capsule.json',
    runtime: unusedRuntimePorts(),
    operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
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
    const stubbornReapFloorMs = SIGTERM_GRACE_MS + SIGKILL_GRACE_MS + CONTAINMENT_DISAPPEARANCE_CONFIRM_MS;
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

  it('rejects a non-canonical inventory cwd at the real proxy response receiver', async () => {
    const proxyClient: ControlClient = {
      exchange: () =>
        Promise.resolve({
          kind: 'response',
          response: {
            kind: 'result',
            value: {
              hosts: [
                {
                  ref: {
                    provider: 'codex',
                    fingerprint: 'a'.repeat(64),
                    instanceId: 'host-instance',
                    leaseMode: 'shared',
                  },
                  status: 'live',
                  spec: {
                    provider: 'codex',
                    command: 'codex',
                    args: ['app-server'],
                    cwd: 'relative/provider-host',
                    leaseMode: 'shared',
                    idleRetirement: 'never',
                  },
                  host: { owner: 'provider-proxy' },
                  diagnostics: {
                    hostLog: { entries: [], retainedBytes: 0, truncatedBeforeSeq: 0 },
                    completedObservations: [],
                    factsTruncatedBeforeSeq: 0,
                  },
                  diagnosticsRetention: { ownerBudgetTruncated: false },
                },
              ],
            },
          },
        }),
      faulted: new Promise<never>(() => undefined),
      onFault: () => () => undefined,
      close: () => {},
    };
    const controls = authorityWithProxyClient(proxyClient).providerHosts;
    if (controls === undefined) throw new Error('provider-host controls were not composed');

    await expect(controls.list()).rejects.toThrow(/Work directory must be absolute and normalized/u);
  });
});

describe('createProviderProxySetAuthority: stopAndReap providerRoots', () => {
  it('names this coordinator’s own recorded provider roots, not an empty claim the guardian would refuse', async () => {
    const calls: unknown[] = [];
    const client: ControlClient = {
      exchange: (_method, params) => {
        calls.push(params);
        return Promise.resolve({
          kind: 'response',
          response: { kind: 'result', value: { state: 'containment-absent', disappearanceReceipt: 'gone' } },
        });
      },
      faulted: new Promise<never>(() => undefined),
      onFault: () => () => undefined,
      close: () => {},
    };
    const root = { pid: 9_001, incarnation: testIncarnation(700) };
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
      exchange: (_method, params) => {
        calls.push(params);
        return Promise.resolve({
          kind: 'response',
          response: { kind: 'result', value: { state: 'containment-absent', disappearanceReceipt: 'gone' } },
        });
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
  type InstallCall = { role: string; method: string; params: unknown };

  const tempRoots: string[] = [];
  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** Records every call made to a role's client and answers the named install method with the fixture above,
   *  or the configured failure for that one role. */
  function recordingClient(
    role: 'guardian' | 'reaper' | 'proxy',
    calls: InstallCall[],
    fail?: string,
    ackGrantId?: string,
    transientOnce = false,
    installGate?: Promise<void>,
    refuseOnce = false,
  ): ControlClient {
    let transientRemaining = transientOnce;
    let refusalRemaining = refuseOnce;
    return {
      exchange: async (method: string, params: unknown): Promise<ControlExchange> => {
        calls.push({ role, method, params });
        await installGate;
        if (method.includes('succession.register') || method.includes('succession-register')) {
          return {
            kind: 'response',
            response: {
              kind: 'result',
              value: {
                state: 'succession-registered',
                operation: (params as { operation: unknown }).operation,
              },
            },
          };
        }
        if (transientRemaining) {
          transientRemaining = false;
          return {
            kind: 'no-response',
            cause: 'timeout',
            error: new ControlClientError('control_call_failed', `${role} timed out`, 'timeout'),
          };
        }
        if (fail !== undefined && method === fail && (!refuseOnce || refusalRemaining)) {
          refusalRemaining = false;
          const failure: ControlClientRemoteFailure = {
            kind: 'json-rpc-error',
            jsonRpcCode: -32_000,
            protocolCode: null,
            admissionReason: null,
            heartbeatRefusal: null,
          };
          return {
            kind: 'response',
            response: {
              kind: 'refusal',
              failure,
              error: new ControlClientError(
                'control_call_failed',
                `${role} refused ${method}`,
                'remote-response',
                failure,
              ),
            },
          };
        }
        return {
          kind: 'response',
          response: {
            kind: 'result',
            value: {
              state: 'installed-dormant',
              grantId: ackGrantId ?? (params as { grantId: string }).grantId,
            },
          },
        };
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
    ackGrantId?: string;
    transientOnce?: 'guardian' | 'reaper' | 'proxy';
    refuseOnce?: 'guardian' | 'reaper' | 'proxy';
    installGate?: Promise<void>;
    recovery?: Readonly<{ capsule: HandoffCapsuleV3; operations: ReadonlyArray<typeof OPERATION> }>;
  }): { authority: ReturnType<typeof createProviderProxySetAuthority>; handoffCapsulePath: string } {
    const tempRoot = mkdtempSync(join(tmpdir(), 'coral-install-handoff-grant-'));
    tempRoots.push(tempRoot);
    const handoffCapsulePath = join(tempRoot, 'proxy.handoff.json');
    const runtime = createRealRuntime('dev', { baseDir: tempRoot });
    const common = {
      proxyInstanceId: PROXY_IDENTITY.proxyInstanceId,
      guardianClient: recordingClient(
        'guardian',
        options.calls,
        options.fail === 'guardian' ? (options.failMethod ?? 'guardian.handoff-install.v1') : undefined,
        options.ackGrantId,
        options.transientOnce === 'guardian',
        options.installGate,
        options.refuseOnce === 'guardian',
      ),
      reaperClient: recordingClient(
        'reaper',
        options.calls,
        options.fail === 'reaper' ? (options.failMethod ?? 'reaper.handoff-install.v1') : undefined,
        options.ackGrantId,
        options.transientOnce === 'reaper',
        options.installGate,
        options.refuseOnce === 'reaper',
      ),
      proxyClient: recordingClient(
        'proxy',
        options.calls,
        options.fail === 'proxy' ? (options.failMethod ?? 'handoff.install.v1') : undefined,
        options.ackGrantId,
        options.transientOnce === 'proxy',
        options.installGate,
        options.refuseOnce === 'proxy',
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
    const deps: ProviderProxySetAuthorityDependencies =
      options.recovery === undefined
        ? common
        : {
            ...common,
            recoveryCapsule: options.recovery.capsule,
            recoveryOperations: options.recovery.operations,
          };
    return { authority: createProviderProxySetAuthority(deps), handoffCapsulePath };
  }

  it('installs one standing credential on all roles and keeps its secret only in the mode-0600 capsule', async () => {
    const calls: InstallCall[] = [];
    const { authority, handoffCapsulePath } = authorityForInstall({ calls });

    const installation = await authority.installRecoveryCredential(new AbortController().signal);
    const registration = await authority.registerSuccessionOperation(OPERATION);

    expect(installation).toMatchObject({
      kind: 'installed',
      receipt: { kind: 'installed-recovery-credential' },
    });
    expect(registration).toEqual({ kind: 'registered' });

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
      guardianPid: number;
      guardianIncarnation: ProcessIncarnation;
      proxyPid: number;
      reaperPid: number;
      reaperIncarnation: ProcessIncarnation;
      containmentKind: string;
      proxyIncarnation: ProcessIncarnation;
      proxyProcessGroupId: number;
    };
    expect(written.version).toBe(3);
    expect(written.buildSetId).toBe(GUARDIAN_IDENTITY.buildSetId);
    expect(written.orphanTimeoutMs).toBe(DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS);
    expect(written.teardownReserveMs).toBe(PROXY_TEARDOWN_RESERVE_MS);
    // The two fields the design review found with a second, non-authoritative home: neither belongs in a
    // durable artifact a successor might one day trust in place of the store or the proxy's live ledger.
    expect(written.operations).toBeUndefined();
    expect(written.committedThroughProviderSeq).toBeUndefined();
    expect(written).toMatchObject({
      guardianPid: GUARDIAN_IDENTITY.pid,
      guardianIncarnation: GUARDIAN_IDENTITY.incarnation,
      proxyPid: PROXY_IDENTITY.pid,
      reaperPid: REAPER_IDENTITY.pid,
      reaperIncarnation: REAPER_IDENTITY.incarnation,
      containmentKind: REAPER_IDENTITY.containmentKind,
      proxyIncarnation: PROXY_IDENTITY.incarnation,
      proxyProcessGroupId: PROXY_IDENTITY.processGroupId,
    });
    expect((statSync(handoffCapsulePath).mode & 0o777).toString(8)).toBe('600');
  });

  it('returns to idle after a refusal so the next attempt can install', async () => {
    const calls: InstallCall[] = [];
    const { authority, handoffCapsulePath } = authorityForInstall({
      calls,
      fail: 'reaper',
      refuseOnce: 'reaper',
    });

    const outcome = await authority.installRecoveryCredential(new AbortController().signal);
    expect(() => statSync(handoffCapsulePath)).toThrow();
    const retry = await authority.installRecoveryCredential(new AbortController().signal);

    expect(outcome).toMatchObject({
      kind: 'refused',
      incident: { role: 'reaper', method: 'reaper.handoff-install.v1', exchange: { kind: 'response' } },
    });
    expect(retry).toMatchObject({ kind: 'installed' });
    expect(
      calls.filter(({ method }) => method.includes('handoff-install') || method === 'handoff.install.v1'),
    ).toHaveLength(6);
    expect(statSync(handoffCapsulePath).isFile()).toBe(true);
  });

  it('returns an idle cancellation without starting an exchange', async () => {
    const calls: InstallCall[] = [];
    const { authority } = authorityForInstall({ calls });
    const cancelled = new AbortController();
    cancelled.abort();

    const outcome = await authority.installRecoveryCredential(cancelled.signal);
    const retry = await authority.installRecoveryCredential(new AbortController().signal);

    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(retry).toMatchObject({ kind: 'installed' });
    expect(
      calls.filter(({ method }) => method.includes('handoff-install') || method === 'handoff.install.v1'),
    ).toHaveLength(3);
  });

  it('lets succession registration retry a transient install instead of retaining the failed attempt', async () => {
    const calls: InstallCall[] = [];
    const { authority } = authorityForInstall({ calls, transientOnce: 'guardian' });

    const first = await authority.registerSuccessionOperation(OPERATION);
    const second = await authority.registerSuccessionOperation(OPERATION);
    const installed = await authority.installRecoveryCredential(new AbortController().signal);

    expect(first).toMatchObject({ kind: 'retryable', incident: { role: 'guardian' } });
    expect(second).toEqual({ kind: 'registered' });
    expect(installed).toMatchObject({ kind: 'installed' });
    expect(
      calls.filter(({ role, method }) => role === 'guardian' && method === 'guardian.handoff-install.v1'),
    ).toHaveLength(2);
    expect(
      calls.filter(({ method }) => method.includes('handoff-install') || method === 'handoff.install.v1'),
    ).toHaveLength(6);
    expect(calls.filter(({ method }) => method.includes('succession-register'))).toHaveLength(2);
    expect(calls.filter(({ method }) => method === 'succession.register-operation.v1')).toHaveLength(1);
  });

  it('shares one in-flight install attempt between concurrent callers', async () => {
    const calls: InstallCall[] = [];
    let releaseInstall!: () => void;
    const installGate = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    const { authority } = authorityForInstall({ calls, installGate });

    const first = authority.installRecoveryCredential(new AbortController().signal);
    const second = authority.installRecoveryCredential(new AbortController().signal);

    expect(
      calls.filter(({ method }) => method.includes('handoff-install') || method === 'handoff.install.v1'),
    ).toHaveLength(3);
    releaseInstall();
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    expect(firstOutcome).toMatchObject({ kind: 'installed' });
    expect(secondOutcome).toEqual(firstOutcome);
  });

  it('accepts a shipped-v0.10.9-shaped acknowledgement only as proof that the grant was stored', async () => {
    const freshCalls: InstallCall[] = [];
    const fresh = authorityForInstall({ calls: freshCalls });
    await fresh.authority.installRecoveryCredential(new AbortController().signal);
    const capsule = JSON.parse(readFileSync(fresh.handoffCapsulePath, 'utf-8')) as HandoffCapsuleV3;
    const recoveredCalls: InstallCall[] = [];
    const recovered = authorityForInstall({
      calls: recoveredCalls,
      recovery: { capsule, operations: [OPERATION] },
    }).authority;

    const outcome = await recovered.installRecoveryCredential(new AbortController().signal);

    expect(outcome).toMatchObject({
      kind: 'installed',
      receipt: { kind: 'installed-recovery-credential', grantId: capsule.grantId },
    });
    expect(recovered.autonomousDeadline).toEqual({
      orphanTimeoutMs: capsule.orphanTimeoutMs,
      heartbeatHoldBound: expect.any(Object),
    });
    expect(recovered.autonomousDeadline).not.toHaveProperty('owner');
    expect(outcome).not.toHaveProperty('discharge');
    expect(recoveredCalls.map(({ role, method }) => `${role}:${method}`)).toEqual([
      'guardian:guardian.handoff-install.v1',
      'reaper:reaper.handoff-install.v1',
      'proxy:handoff.install.v1',
    ]);
    expect(recoveredCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ params: expect.objectContaining({ operations: [OPERATION] }) }),
      ]),
    );
  });

  it('returns an explicit refusal and does not contact the proxy when an enforcer refuses installation', async () => {
    const freshCalls: InstallCall[] = [];
    const fresh = authorityForInstall({ calls: freshCalls });
    await fresh.authority.installRecoveryCredential(new AbortController().signal);
    const capsule = JSON.parse(readFileSync(fresh.handoffCapsulePath, 'utf-8')) as HandoffCapsuleV3;
    const recoveredCalls: InstallCall[] = [];
    const recovered = authorityForInstall({
      calls: recoveredCalls,
      fail: 'guardian',
      recovery: { capsule, operations: [OPERATION] },
    }).authority;

    const outcome = await recovered.installRecoveryCredential(new AbortController().signal);

    expect(outcome).toMatchObject({ kind: 'refused', incident: { role: 'guardian' } });
    expect(recoveredCalls.some(({ role }) => role === 'proxy')).toBe(false);
  });

  it('does not accept an acknowledgement for a different recovered grant', async () => {
    const fresh = authorityForInstall({ calls: [] });
    await fresh.authority.installRecoveryCredential(new AbortController().signal);
    const capsule = JSON.parse(readFileSync(fresh.handoffCapsulePath, 'utf-8')) as HandoffCapsuleV3;
    const recoveredCalls: InstallCall[] = [];
    const recovered = authorityForInstall({
      calls: recoveredCalls,
      ackGrantId: '77777777-7777-4777-8777-777777777777',
      recovery: { capsule, operations: [OPERATION] },
    }).authority;

    await expect(recovered.installRecoveryCredential(new AbortController().signal)).rejects.toThrow(
      /provider_proxy_handoff_install_ack_grant_mismatch/u,
    );
    await expect(recovered.installRecoveryCredential(new AbortController().signal)).rejects.toThrow(
      /provider_proxy_handoff_install_ack_grant_mismatch/u,
    );
    expect(recoveredCalls.filter(({ method }) => method === 'guardian.handoff-install.v1')).toHaveLength(2);
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

    const registration = await authority.registerSuccessionOperation(pendingOperation);

    expect(registration).toEqual({ kind: 'registered' });
    const proxyRegistration = calls.find((call) => call.method === 'succession.register-operation.v1');
    expect(proxyRegistration?.params).toEqual({
      operation: pendingOperation,
    });
  });
});

function fakeSpawnedGuardian(pid: number, seed: number): SpawnedRoleProcess {
  return {
    child: {} as unknown as ChildProcessLike,
    pid,
    incarnation: testIncarnation(seed),
    // Never settles — these tests exercise the undo path, not the spawn-error race `spawnFailed` exists for.
    spawnFailed: new Promise<never>(() => {}),
  };
}

type SignalCall = { pid: number; signal: NodeJS.Signals | 0 };

/**
 * `observeLiveness` is answered by the test, not stubbed away: it is what decides between "the group went quietly"
 * and "escalate", so a runtime missing it would let the escalation path pass untested — which is how the
 * partial mock this replaces went unnoticed.
 */
function guardianUndoRuntime(
  time: VirtualTime,
  isAlive: () => boolean,
  killCalls: SignalCall[],
  observe?: () => ProcessLiveness,
): Runtime {
  return {
    time,
    process: {
      kill: (pid: number, signal: NodeJS.Signals | 0) => {
        killCalls.push({ pid, signal });
        return true;
      },
      observeLiveness: () => observe?.() ?? (isAlive() ? 'alive' : 'absent'),
    },
  } as unknown as Runtime;
}

describe('buildGuardianSpawnUndo', () => {
  it("signals the guardian's process group, not its bare pid", async () => {
    const time = new VirtualTime();
    const killCalls: SignalCall[] = [];
    const runtime = guardianUndoRuntime(time, () => false, killCalls);
    const spawned = fakeSpawnedGuardian(4_242, 1_000);

    const undo = buildGuardianSpawnUndo(runtime, spawned, 'linux', () => spawned.incarnation);
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

    const pending = buildGuardianSpawnUndo(runtime, spawned, 'linux', () => spawned.incarnation)();
    time.tick(PROXY_TEARDOWN_RESERVE_MS);
    await pending;

    expect(killCalls).toEqual([{ pid: -spawned.pid, signal: 'SIGTERM' }]);
  });

  it('escalates to SIGKILL on the group once the teardown reserve is spent', async () => {
    const time = new VirtualTime();
    const killCalls: SignalCall[] = [];
    const runtime = guardianUndoRuntime(time, () => true, killCalls);
    const spawned = fakeSpawnedGuardian(4_242, 1_000);

    const pending = buildGuardianSpawnUndo(runtime, spawned, 'linux', () => spawned.incarnation)();
    time.tick(PROXY_TEARDOWN_RESERVE_MS);
    await pending;

    // The same group, again: a guardian that spent its whole reserve without disappearing is not going to,
    // and leaving it holding the proxy containment is the one outcome this undo exists to rule out.
    expect(killCalls).toEqual([
      { pid: -spawned.pid, signal: 'SIGTERM' },
      { pid: -spawned.pid, signal: 'SIGKILL' },
    ]);
  });

  // On darwin an incarnation is wall-clock at one-second resolution, so a match is not proof the pid is still
  // the process this acquisition spawned. Refusing costs the guardian's orphan deadline — it never received
  // control, so it ends itself — and signalling a matching-but-different pid costs an unrelated process.
  // Escalation needs observed life. The group may have exited during the TERM grace and had its id reused, so
  // an unanswerable probe is not permission to SIGKILL a bare number.
  it("does not escalate to SIGKILL when the group's liveness cannot be observed", async () => {
    const time = new VirtualTime();
    const killCalls: SignalCall[] = [];
    const runtime = guardianUndoRuntime(
      time,
      () => true,
      killCalls,
      () => 'unknown',
    );
    const spawned = fakeSpawnedGuardian(4_242, 1_000);

    const pending = buildGuardianSpawnUndo(runtime, spawned, 'linux', () => spawned.incarnation)();
    time.tick(PROXY_TEARDOWN_RESERVE_MS);
    await pending;

    expect(killCalls).toEqual([{ pid: -spawned.pid, signal: 'SIGTERM' }]);
  });

  it('declines to signal on a platform whose incarnation cannot authorize one', async () => {
    const time = new VirtualTime();
    const killCalls: SignalCall[] = [];
    const runtime = guardianUndoRuntime(time, () => true, killCalls);
    const spawned = fakeSpawnedGuardian(4_242, 1_000);

    await buildGuardianSpawnUndo(runtime, spawned, 'darwin', () => spawned.incarnation)();

    expect(killCalls).toEqual([]);
  });

  it('refuses to signal once the recorded incarnation no longer matches (recycled pid)', async () => {
    const time = new VirtualTime();
    const killCalls: SignalCall[] = [];
    const runtime = guardianUndoRuntime(time, () => true, killCalls);
    const spawned = fakeSpawnedGuardian(4_242, 1_000);
    // A different incarnation than what this acquisition recorded at spawn time: pid 4242 now names some
    // other process, and signalling it would kill a stranger.
    const readProcessIncarnation = (): ProcessIncarnation => testIncarnation(9_999);

    const undo = buildGuardianSpawnUndo(runtime, spawned, 'linux', readProcessIncarnation);
    await undo();

    expect(killCalls).toEqual([]);
  });
});
