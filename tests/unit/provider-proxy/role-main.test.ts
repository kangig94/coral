import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createProviderBootstrapCapsule,
  type consumeProviderBootstrapCapsule as consumeProviderBootstrapCapsuleType,
  type GuardianBootstrapCapsule,
  type ProxyBootstrapCapsule,
  type ReaperBootstrapCapsule,
} from '#src/provider-proxy/bootstrap-capsule.js';
import {
  controlExchangeForTest,
  type ControlClient,
  type ControlExchange,
} from '#src/provider-proxy/control-client.js';
import type { EnforcementOutcome } from '#src/provider-proxy/enforcement.js';
import type * as NodeProcessMod from '#src/infra/node-process.js';
import { CORAL_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS_ENV } from '#src/provider-proxy/orphan-deadline.js';
import {
  buildEnforcementOutcomeHandlers,
  GuardianConstructionCleanupHeldError,
  runProviderRoleMain,
  startProviderGuardianRole,
  startProviderProxyRole,
  type ProviderRoleMainPorts,
} from '#src/provider-proxy/role-main.js';
import type { ProviderRole } from '#src/provider-proxy/role-argv.js';
import type {
  connectRoleControlWithRetry as connectRoleControlWithRetryType,
  spawnRoleProcess as spawnRoleProcessType,
} from '#src/provider-proxy/role-spawn.js';
import type * as ProxyMod from '#src/provider-proxy/proxy.js';
import type * as ReaperMod from '#src/provider-proxy/reaper.js';
import type * as ProviderRootAuthorityMod from '#src/provider-proxy/provider-root-authority.js';
import type * as SemanticOperationRunnerMod from '#src/provider-proxy/semantic-operation-runner.js';
import { createRealRuntime } from '#src/runtime/real.js';

const roleSenderHarness = vi.hoisted(() => ({
  enabled: false,
  capsule: undefined as unknown,
  channel: undefined as unknown,
  spawnRoleProcess: undefined as unknown,
}));

const proxyRoleCloseHarness = vi.hoisted(() => ({
  enabled: false,
  proxyClose: vi.fn<() => Promise<void>>(),
  proxyListen: vi.fn<() => Promise<void>>(),
  semanticShutdown: vi.fn<() => Promise<void>>(),
  onRelinquish: undefined as unknown,
}));

const reaperRoleCloseHarness = vi.hoisted(() => ({
  enabled: false,
  reaperClose: vi.fn<() => Promise<void>>(),
  reaperListen: vi.fn<() => Promise<void>>(),
  enforcer: vi.fn<() => unknown>(),
  onOutcome: undefined as ((outcome: EnforcementOutcome) => void) | undefined,
  latchTeardown: undefined as (() => void) | undefined,
  markContainmentAbsent: undefined as (() => void) | undefined,
}));

const processIncarnationProbeCleanupHarness = vi.hoisted(() => ({
  enabled: false,
  cleanup: vi.fn<() => ReturnType<typeof NodeProcessMod.terminateProcessIncarnationProbes>>(),
}));

vi.mock('#src/infra/node-process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeProcessMod>();
  return {
    ...actual,
    terminateProcessIncarnationProbes: () =>
      processIncarnationProbeCleanupHarness.enabled
        ? processIncarnationProbeCleanupHarness.cleanup()
        : actual.terminateProcessIncarnationProbes(),
  };
});

vi.mock('#src/provider-proxy/bootstrap-capsule.js', async (importOriginal) => {
  const actual = await importOriginal<{
    consumeProviderBootstrapCapsule: typeof consumeProviderBootstrapCapsuleType;
  }>();
  return {
    ...actual,
    consumeProviderBootstrapCapsule: (...args: Parameters<typeof actual.consumeProviderBootstrapCapsule>) =>
      roleSenderHarness.enabled
        ? (roleSenderHarness.capsule as ReturnType<typeof actual.consumeProviderBootstrapCapsule>)
        : actual.consumeProviderBootstrapCapsule(...args),
  };
});

vi.mock('#src/provider-proxy/role-spawn.js', async (importOriginal) => {
  const actual = await importOriginal<{
    connectRoleControlWithRetry: typeof connectRoleControlWithRetryType;
    spawnRoleProcess: typeof spawnRoleProcessType;
  }>();
  return {
    ...actual,
    connectRoleControlWithRetry: (...args: Parameters<typeof actual.connectRoleControlWithRetry>) =>
      roleSenderHarness.enabled
        ? Promise.resolve(roleSenderHarness.channel as Awaited<ReturnType<typeof actual.connectRoleControlWithRetry>>)
        : actual.connectRoleControlWithRetry(...args),
    spawnRoleProcess: (...args: Parameters<typeof actual.spawnRoleProcess>) =>
      roleSenderHarness.enabled
        ? (roleSenderHarness.spawnRoleProcess as typeof actual.spawnRoleProcess)(...args)
        : actual.spawnRoleProcess(...args),
  };
});

vi.mock('#src/provider-proxy/provider-root-authority.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderRootAuthorityMod>();
  return {
    ...actual,
    createProxyAppServerHostAuthority: (...args: Parameters<typeof actual.createProxyAppServerHostAuthority>) =>
      proxyRoleCloseHarness.enabled
        ? ({
            beginOperation: () => ({
              selectCancellationMode: () => {},
              openSession: async () => {
                throw new Error('unused proxy role host authority');
              },
              attachSession: async () => null,
            }),
            rootIdentity: () => null,
            closed: () => null,
            forceClose: async () => {},
            evictHost: async () => false,
            admissionSnapshot: () => ({ state: new Map(), tombstones: [] }),
            listProviderHosts: () => [],
            inspectProviderHost: () => null,
          } satisfies ReturnType<typeof actual.createProxyAppServerHostAuthority>)
        : actual.createProxyAppServerHostAuthority(...args),
  };
});

vi.mock('#src/provider-proxy/semantic-operation-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SemanticOperationRunnerMod>();
  return {
    ...actual,
    createSemanticOperationRuntime: (...args: Parameters<typeof actual.createSemanticOperationRuntime>) => {
      if (proxyRoleCloseHarness.enabled) {
        proxyRoleCloseHarness.onRelinquish = args[0].onRelinquish;
        return {
          host: {
            start: () => {
              throw new Error('unused proxy role semantic start');
            },
            stop: async () => {},
          },
          stage: () => {
            throw new Error('unused proxy role semantic stage');
          },
          ensureProviderRoot: async () => {
            throw new Error('unused proxy role semantic root acquisition');
          },
          shutdown: () => proxyRoleCloseHarness.semanticShutdown(),
        } satisfies ReturnType<typeof actual.createSemanticOperationRuntime>;
      }
      return actual.createSemanticOperationRuntime(...args);
    },
  };
});

vi.mock('#src/provider-proxy/proxy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ProxyMod>();
  return {
    ...actual,
    createProxy: (...args: Parameters<typeof actual.createProxy>) =>
      proxyRoleCloseHarness.enabled
        ? ({
            listen: proxyRoleCloseHarness.proxyListen,
            close: proxyRoleCloseHarness.proxyClose,
            ledger: () => {
              throw new Error('unused proxy role ledger');
            },
            emitProviderEvent: () => {
              throw new Error('unused proxy role provider event');
            },
          } satisfies ReturnType<typeof actual.createProxy>)
        : actual.createProxy(...args),
  };
});

vi.mock('#src/provider-proxy/reaper.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ReaperMod>();
  return {
    ...actual,
    createReaper: (...args: Parameters<typeof actual.createReaper>) => {
      if (!reaperRoleCloseHarness.enabled) return actual.createReaper(...args);
      reaperRoleCloseHarness.onOutcome = args[0].onOutcome;
      reaperRoleCloseHarness.latchTeardown = args[0].deadlines.latchTeardown;
      reaperRoleCloseHarness.markContainmentAbsent = args[0].deadlines.markContainmentAbsent;
      return {
        listen: reaperRoleCloseHarness.reaperListen,
        close: reaperRoleCloseHarness.reaperClose,
        enforcer: reaperRoleCloseHarness.enforcer,
      } as unknown as ReturnType<typeof actual.createReaper>;
    },
  };
});

/**
 * `runProviderRoleMain`'s dispatch has no test anywhere: `process-topology.integration.test.ts` drives
 * `startProviderGuardianRole`/`startProviderReaperRole`/`startProviderProxyRole` directly, never through this
 * function's own `mode.role` branch, and never exercises `'none'` at all. `buildEnforcementOutcomeHandlers`
 * (BLOCKING 3) is likewise only reachable, in production, from deep inside a real guardian/reaper socket —
 * this exercises its close/mark-exited/exit contract directly, with fakes standing in for all three.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  roleSenderHarness.enabled = false;
  roleSenderHarness.capsule = undefined;
  roleSenderHarness.channel = undefined;
  roleSenderHarness.spawnRoleProcess = undefined;
  proxyRoleCloseHarness.enabled = false;
  proxyRoleCloseHarness.proxyClose.mockReset();
  proxyRoleCloseHarness.proxyListen.mockReset();
  proxyRoleCloseHarness.semanticShutdown.mockReset();
  proxyRoleCloseHarness.onRelinquish = undefined;
  reaperRoleCloseHarness.enabled = false;
  reaperRoleCloseHarness.reaperClose.mockReset();
  reaperRoleCloseHarness.reaperListen.mockReset();
  reaperRoleCloseHarness.enforcer.mockReset();
  reaperRoleCloseHarness.onOutcome = undefined;
  reaperRoleCloseHarness.latchTeardown = undefined;
  reaperRoleCloseHarness.markContainmentAbsent = undefined;
  processIncarnationProbeCleanupHarness.enabled = false;
  processIncarnationProbeCleanupHarness.cleanup.mockReset();
});

function scopedTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function pairingCapsule(role: 'guardian' | 'reaper' | 'proxy', directory: string, pairingSecret: unknown): unknown {
  const shared = {
    generation: 'gen2' as const,
    flavor: 'prod' as const,
    buildSetId: randomUUID(),
    hostFingerprint: randomBytes(32).toString('hex'),
    guardianInstanceId: randomUUID(),
    reaperInstanceId: randomUUID(),
    proxyInstanceId: randomUUID(),
    bootstrapNonce: randomBytes(32).toString('hex'),
  };
  if (role === 'guardian') {
    return {
      role,
      ...shared,
      canonicalControlEndpoint: join(directory, 'g.sock'),
      reaperControlEndpoint: join(directory, 'r.sock'),
      proxyEndpoint: join(directory, 'p.sock'),
      guardianReaperAuthSecret: pairingSecret,
      proxyGuardianAuthSecret: randomBytes(32).toString('hex'),
    };
  }
  if (role === 'reaper') {
    return {
      role,
      ...shared,
      canonicalControlEndpoint: join(directory, 'r.sock'),
      guardianControlEndpoint: join(directory, 'g.sock'),
      proxyEndpoint: join(directory, 'p.sock'),
      guardianReaperAuthSecret: pairingSecret,
    };
  }
  return {
    role,
    ...shared,
    canonicalEndpoint: join(directory, 'p.sock'),
    guardianControlEndpoint: join(directory, 'g.sock'),
    proxyGuardianAuthSecret: pairingSecret,
  };
}

function roleSenderPorts(directory: string, orphanTimeoutMs?: string): ProviderRoleMainPorts {
  const runtime = createRealRuntime('prod');
  return {
    runtime:
      orphanTimeoutMs === undefined
        ? runtime
        : {
            ...runtime,
            env: {
              ...runtime.env,
              get: (key: string) =>
                key === CORAL_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS_ENV ? orphanTimeoutMs : runtime.env.get(key),
            },
          },
    pluginRoot: directory,
    baseDir: directory,
    readProcessIncarnation: (pid) => (pid === process.pid ? testIncarnation(1) : null),
  };
}

function fakeSpawnedRole(): unknown {
  return {
    kind: 'spawned',
    child: {},
    pid: 2_000_000_000,
    incarnation: testIncarnation(1),
    spawnFailed: new Promise<never>(() => {}),
  };
}

function enableRoleSender(
  capsule: unknown,
  channel: Pick<ControlClient, 'exchange' | 'close'>,
  spawnRoleProcess = vi.fn(fakeSpawnedRole),
): void {
  roleSenderHarness.enabled = true;
  roleSenderHarness.capsule = capsule;
  roleSenderHarness.channel = {
    ...channel,
    faulted: new Promise<never>(() => undefined),
    onFault: () => () => undefined,
  };
  roleSenderHarness.spawnRoleProcess = spawnRoleProcess;
}

describe('role pairing sender schemas', () => {
  it('refuses malformed guardian-to-reaper pairing params before consulting the reaper', async () => {
    const directory = scopedTempDir('coral-guardian-pair-sender-');
    const exchange = vi.fn(async (): Promise<never> => {
      throw new Error('receiver was consulted');
    });
    enableRoleSender(pairingCapsule('guardian', directory, { unexpected: true }), { exchange, close: vi.fn() });

    const failure = await startProviderGuardianRole('/unused', roleSenderPorts(directory)).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(GuardianConstructionCleanupHeldError);
    expect((failure as GuardianConstructionCleanupHeldError).cause).toMatchObject({
      issues: [expect.objectContaining({ code: 'invalid_type', path: ['pairingSecret'] })],
    });
    expect((failure as GuardianConstructionCleanupHeldError).hold.pending).toMatchObject([
      {
        kind: 'reaper-process',
        identity: { pid: 2_000_000_000, incarnation: testIncarnation(1) },
        reason: expect.stringContaining('Could not confirm'),
      },
    ]);
    expect(exchange).not.toHaveBeenCalled();
  });

  it('refuses malformed proxy-to-guardian pairing params before consulting the guardian', async () => {
    const directory = scopedTempDir('coral-proxy-pair-sender-');
    const exchange = vi.fn(async (): Promise<never> => {
      throw new Error('receiver was consulted');
    });
    enableRoleSender(pairingCapsule('proxy', directory, { unexpected: true }), { exchange, close: vi.fn() });

    await expect(startProviderProxyRole('/unused', roleSenderPorts(directory))).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'invalid_type', path: ['pairingSecret'] })],
    });
    expect(exchange).not.toHaveBeenCalled();
  });

  it('refuses a malformed reaper pairing reply before spawning or constructing the proxy', async () => {
    const directory = scopedTempDir('coral-reaper-pair-reply-');
    const exchange = vi.fn(
      async (): Promise<ControlExchange> =>
        controlExchangeForTest({
          kind: 'response',
          response: { kind: 'result', value: { state: 'paired', unexpected: true } },
        }),
    );
    const spawnRoleProcess = vi
      .fn()
      .mockImplementationOnce(fakeSpawnedRole)
      .mockImplementation(() => {
        throw new Error('malformed pairing reply was acted on');
      });
    enableRoleSender(
      pairingCapsule('guardian', directory, randomBytes(32).toString('hex')),
      { exchange, close: vi.fn() },
      spawnRoleProcess,
    );
    let reaperObservation: NodeProcessMod.ProcessIncarnation | null = null;
    const ports = {
      ...roleSenderPorts(directory, '74000'),
      readProcessIncarnation: (pid: number) => (pid === process.pid ? testIncarnation(1) : reaperObservation),
    };

    const failure = await startProviderGuardianRole('/unused', ports).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GuardianConstructionCleanupHeldError);
    expect((failure as GuardianConstructionCleanupHeldError).cause).toMatchObject({
      issues: [expect.objectContaining({ code: 'unrecognized_keys', keys: ['unexpected'], path: [] })],
    });
    const hold = (failure as GuardianConstructionCleanupHeldError).hold;
    expect(hold.pending).toMatchObject([
      {
        kind: 'reaper-process',
        identity: { pid: 2_000_000_000, incarnation: testIncarnation(1) },
      },
    ]);
    reaperObservation = testIncarnation(2);
    await expect(hold.retry()).resolves.toEqual({ kind: 'settled' });
    expect(exchange).toHaveBeenCalledOnce();
    expect(spawnRoleProcess).toHaveBeenCalledOnce();
    expect(spawnRoleProcess.mock.calls[0]?.[3].envAdditions).toMatchObject({
      [CORAL_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS_ENV]: '74000',
    });
  });
});

describe('runProviderRoleMain', () => {
  it("returns 0 for 'none' without constructing a runtime or touching a capsule", async () => {
    // No capsule path is even given — reaching a non-zero result, or a throw, would prove this fell through
    // to a role branch rather than staying the documented no-op.
    await expect(runProviderRoleMain({ role: 'none' }, { pluginRoot: '/unused' })).resolves.toBe(0);
  });

  it.each<[ProviderRole, ProviderRole]>([
    ['guardian', 'reaper'],
    ['reaper', 'proxy'],
    ['proxy', 'guardian'],
  ])('dispatches %s to the matching role start function, not a different one', async (mode, wrongCapsuleRole) => {
    const dir = scopedTempDir(`coral-role-dispatch-${mode}-`);
    const capsulePath = join(dir, `${mode}.bootstrap.json`);
    const runtime = createRealRuntime('prod');
    const capsuleEnv = { storage: runtime.storage, uid: process.getuid?.() ?? 0 };
    const shared = {
      generation: 'gen2' as const,
      flavor: 'prod' as const,
      buildSetId: randomUUID(),
      hostFingerprint: randomBytes(32).toString('hex'),
      guardianInstanceId: randomUUID(),
      reaperInstanceId: randomUUID(),
      proxyInstanceId: randomUUID(),
      bootstrapNonce: randomBytes(32).toString('hex'),
    };
    // Deliberately tagged as a *different* role than the mode under test: `consumeProviderBootstrapCapsule`
    // checks the role tag before anything else that would need a real strict-build identity to get past, so
    // this fails fast with a `bootstrap_capsule_role_mismatch` naming the `expectedRole` the dispatch target
    // actually asked for — proof `runProviderRoleMain` reached that role's own start function, not merely
    // that some code path threw.
    const wrongCapsule: GuardianBootstrapCapsule | ReaperBootstrapCapsule | ProxyBootstrapCapsule =
      wrongCapsuleRole === 'guardian'
        ? {
            role: 'guardian',
            ...shared,
            canonicalControlEndpoint: join(dir, 'g.sock'),
            reaperControlEndpoint: join(dir, 'r.sock'),
            proxyEndpoint: join(dir, 'p.sock'),
            guardianReaperAuthSecret: randomBytes(32).toString('hex'),
            proxyGuardianAuthSecret: randomBytes(32).toString('hex'),
          }
        : wrongCapsuleRole === 'reaper'
          ? {
              role: 'reaper',
              ...shared,
              canonicalControlEndpoint: join(dir, 'r.sock'),
              guardianControlEndpoint: join(dir, 'g.sock'),
              proxyEndpoint: join(dir, 'p.sock'),
              guardianReaperAuthSecret: randomBytes(32).toString('hex'),
            }
          : {
              role: 'proxy',
              ...shared,
              canonicalEndpoint: join(dir, 'p.sock'),
              guardianControlEndpoint: join(dir, 'g.sock'),
              proxyGuardianAuthSecret: randomBytes(32).toString('hex'),
            };
    createProviderBootstrapCapsule(capsulePath, wrongCapsule, capsuleEnv);

    await expect(runProviderRoleMain({ role: mode, capsulePath }, { pluginRoot: dir })).rejects.toMatchObject({
      code: 'bootstrap_capsule_role_mismatch',
    });
  });

  it('closes an armed proxy pairing and proxy control before exiting on semantic shutdown failure', async () => {
    const directory = scopedTempDir('coral-proxy-role-close-');
    let guardianArmed = false;
    const pairingClose = vi.fn();
    const pairingExchange = vi.fn(async (method: string): Promise<ControlExchange> => {
      if (method !== 'guardian.pair.v1') throw new Error(`unexpected guardian method: ${method}`);
      guardianArmed = true;
      return controlExchangeForTest({
        kind: 'response',
        response: { kind: 'result', value: { state: 'paired' } },
      });
    });
    enableRoleSender(pairingCapsule('proxy', directory, randomBytes(32).toString('hex')), {
      exchange: pairingExchange,
      close: pairingClose,
    });
    proxyRoleCloseHarness.enabled = true;
    proxyRoleCloseHarness.proxyListen.mockResolvedValue();
    proxyRoleCloseHarness.proxyClose.mockResolvedValue();
    const semanticFailure = Object.assign(new Error('one semantic operation remained staged'), {
      code: 'semantic_operation_shutdown_incomplete',
      failures: [{ key: { jobId: 'job-1', operationId: 'op-1' }, kind: 'cancellation-failed' }],
    });
    proxyRoleCloseHarness.semanticShutdown.mockRejectedValue(semanticFailure);

    let shutdown: (() => void) | null = null;
    let interrupt: (() => void) | null = null;
    vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      if (event === 'SIGTERM') shutdown = listener as () => void;
      if (event === 'SIGINT') interrupt = listener as () => void;
      return process;
    });
    const exitProcess = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await expect(
      runProviderRoleMain({ role: 'proxy', capsulePath: '/unused' }, { pluginRoot: directory }),
    ).resolves.toBe(0);
    expect(guardianArmed).toBe(true);
    expect(shutdown).not.toBeNull();
    expect(interrupt).not.toBeNull();

    (shutdown as (() => void) | null)?.();
    (interrupt as (() => void) | null)?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(proxyRoleCloseHarness.semanticShutdown).toHaveBeenCalledOnce();
    expect(pairingClose, 'armed guardian pairing was not closed').toHaveBeenCalledOnce();
    expect(proxyRoleCloseHarness.proxyClose).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(1);
  });

  it('honours a stored exit after a held probe child closes without another shutdown signal', async () => {
    const directory = scopedTempDir('coral-proxy-role-probe-cleanup-');
    enableRoleSender(pairingCapsule('proxy', directory, randomBytes(32).toString('hex')), {
      exchange: vi.fn(
        async (): Promise<ControlExchange> =>
          controlExchangeForTest({
            kind: 'response',
            response: { kind: 'result', value: { state: 'paired' } },
          }),
      ),
      close: vi.fn(),
    });
    proxyRoleCloseHarness.enabled = true;
    proxyRoleCloseHarness.proxyListen.mockResolvedValue();
    proxyRoleCloseHarness.proxyClose.mockResolvedValue();
    let settleSemanticShutdown!: () => void;
    proxyRoleCloseHarness.semanticShutdown.mockReturnValue(
      new Promise((resolve) => {
        settleSemanticShutdown = resolve;
      }),
    );
    processIncarnationProbeCleanupHarness.enabled = true;
    let settleCleanup!: (
      disposition: Awaited<ReturnType<typeof NodeProcessMod.terminateProcessIncarnationProbes>>,
    ) => void;
    let settleChildren!: () => void;
    const untilSettled = new Promise<void>((resolve) => {
      settleChildren = resolve;
    });
    processIncarnationProbeCleanupHarness.cleanup.mockReturnValueOnce(
      new Promise((resolve) => {
        settleCleanup = resolve;
      }),
    );
    processIncarnationProbeCleanupHarness.cleanup.mockResolvedValueOnce({ disposition: 'settled' });

    let shutdown: (() => void) | null = null;
    vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      if (event === 'SIGTERM') shutdown = listener as () => void;
      return process;
    });
    const exitProcess = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await expect(
      runProviderRoleMain({ role: 'proxy', capsulePath: '/unused' }, { pluginRoot: directory }),
    ).resolves.toBe(0);
    exitProcess.mockClear();

    (shutdown as (() => void) | null)?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(processIncarnationProbeCleanupHarness.cleanup).toHaveBeenCalledOnce();
    expect(exitProcess).not.toHaveBeenCalled();

    settleCleanup({
      disposition: 'hold',
      unsettled: [
        {
          child: {} as never,
          pid: 4_242,
          reason: 'close-unobserved',
          exit: 'child-close',
        },
      ],
      untilSettled,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(exitProcess).not.toHaveBeenCalled();

    settleSemanticShutdown();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(processIncarnationProbeCleanupHarness.cleanup).toHaveBeenCalledOnce();
    expect(exitProcess).not.toHaveBeenCalled();

    settleChildren();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(processIncarnationProbeCleanupHarness.cleanup).toHaveBeenCalledTimes(2);
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it('closes and exits cleanly when a reaper is signalled before any containment is recorded', async () => {
    const directory = scopedTempDir('coral-reaper-role-close-');
    enableRoleSender(pairingCapsule('reaper', directory, randomBytes(32).toString('hex')), {
      exchange: vi.fn(async (): Promise<never> => {
        throw new Error('reaper unexpectedly opened an outbound control exchange');
      }),
      close: vi.fn(),
    });
    reaperRoleCloseHarness.enabled = true;
    reaperRoleCloseHarness.reaperListen.mockResolvedValue();
    reaperRoleCloseHarness.reaperClose.mockResolvedValue();
    reaperRoleCloseHarness.enforcer.mockReturnValue(null);

    let shutdown: (() => void) | null = null;
    vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      if (event === 'SIGTERM') shutdown = listener as () => void;
      return process;
    });
    const exitProcess = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await expect(
      runProviderRoleMain({ role: 'reaper', capsulePath: '/unused' }, { pluginRoot: directory }),
    ).resolves.toBe(0);
    expect(reaperRoleCloseHarness.reaperListen).toHaveBeenCalledOnce();
    expect(shutdown).not.toBeNull();
    exitProcess.mockClear();

    (shutdown as (() => void) | null)?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(reaperRoleCloseHarness.enforcer).toHaveBeenCalledOnce();
    expect(reaperRoleCloseHarness.reaperClose).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(0);
    expect(reaperRoleCloseHarness.reaperClose.mock.invocationCallOrder[0]).toBeLessThan(
      exitProcess.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it.each(['SIGTERM', 'SIGINT'] as const)(
    '%s preserves an unattributable hold and keeps the role alive',
    async (signal) => {
      const directory = scopedTempDir('coral-reaper-role-signal-authority-');
      enableRoleSender(pairingCapsule('reaper', directory, randomBytes(32).toString('hex')), {
        exchange: vi.fn(async (): Promise<never> => {
          throw new Error('reaper unexpectedly opened an outbound control exchange');
        }),
        close: vi.fn(),
      });
      reaperRoleCloseHarness.enabled = true;
      reaperRoleCloseHarness.reaperListen.mockResolvedValue();
      reaperRoleCloseHarness.reaperClose.mockResolvedValue();
      const unattributable = { kind: 'recorded-group-unattributable', reason: 'still held' } as const;
      const giveUp = vi.fn(async () => {
        reaperRoleCloseHarness.onOutcome?.(unattributable);
        return { kind: 'holding', outcome: unattributable } as const;
      });
      reaperRoleCloseHarness.enforcer.mockReturnValue({ giveUp, retryUnattributable: () => null });

      let shutdown: (() => void) | null = null;
      vi.spyOn(process, 'on').mockImplementation((event, listener) => {
        if (event === signal) shutdown = listener as () => void;
        return process;
      });
      const exitProcess = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

      await expect(
        runProviderRoleMain({ role: 'reaper', capsulePath: '/unused' }, { pluginRoot: directory }),
      ).resolves.toBe(0);
      reaperRoleCloseHarness.reaperClose.mockClear();
      exitProcess.mockClear();

      (shutdown as (() => void) | null)?.();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(giveUp).toHaveBeenCalledOnce();
      expect(reaperRoleCloseHarness.reaperClose).not.toHaveBeenCalled();
      expect(exitProcess).not.toHaveBeenCalled();
    },
  );

  it('exits 0 when signal-requested teardown confirms containment absence', async () => {
    const directory = scopedTempDir('coral-reaper-role-signal-absence-');
    enableRoleSender(pairingCapsule('reaper', directory, randomBytes(32).toString('hex')), {
      exchange: vi.fn(async (): Promise<never> => {
        throw new Error('reaper unexpectedly opened an outbound control exchange');
      }),
      close: vi.fn(),
    });
    reaperRoleCloseHarness.enabled = true;
    reaperRoleCloseHarness.reaperListen.mockResolvedValue();
    reaperRoleCloseHarness.reaperClose.mockResolvedValue();
    const absent = { kind: 'containment-absent', disappearanceReceipt: 'gone' } as const;
    const giveUp = vi.fn(async () => {
      reaperRoleCloseHarness.latchTeardown?.();
      reaperRoleCloseHarness.markContainmentAbsent?.();
      reaperRoleCloseHarness.onOutcome?.(absent);
      return { kind: 'settled', outcome: absent } as const;
    });
    reaperRoleCloseHarness.enforcer.mockReturnValue({ giveUp, retryUnattributable: () => null });

    let shutdown: (() => void) | null = null;
    vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      if (event === 'SIGTERM') shutdown = listener as () => void;
      return process;
    });
    const exitProcess = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await expect(
      runProviderRoleMain({ role: 'reaper', capsulePath: '/unused' }, { pluginRoot: directory }),
    ).resolves.toBe(0);
    reaperRoleCloseHarness.reaperClose.mockClear();
    exitProcess.mockClear();

    (shutdown as (() => void) | null)?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(giveUp).toHaveBeenCalledOnce();
    expect(reaperRoleCloseHarness.reaperClose).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it('relinquishes pairing and proxy control when semantic cancellation is unconfirmed', async () => {
    const directory = scopedTempDir('coral-proxy-role-relinquish-');
    const pairingClose = vi.fn();
    enableRoleSender(pairingCapsule('proxy', directory, randomBytes(32).toString('hex')), {
      exchange: vi.fn(
        async (): Promise<ControlExchange> =>
          controlExchangeForTest({
            kind: 'response',
            response: { kind: 'result', value: { state: 'paired' } },
          }),
      ),
      close: pairingClose,
    });
    proxyRoleCloseHarness.enabled = true;
    proxyRoleCloseHarness.proxyListen.mockResolvedValue();
    proxyRoleCloseHarness.proxyClose.mockResolvedValue();
    const cancellationFailure = Object.assign(new Error('provider did not acknowledge the exact turn'), {
      code: 'semantic_operation_cancellation_unconfirmed',
    });
    proxyRoleCloseHarness.semanticShutdown.mockRejectedValue(cancellationFailure);
    const exitProcess = vi.fn();

    await startProviderProxyRole('/unused', { ...roleSenderPorts(directory), exitProcess });
    const onRelinquish = proxyRoleCloseHarness.onRelinquish as (error: Error) => void;
    onRelinquish(cancellationFailure);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(proxyRoleCloseHarness.semanticShutdown).toHaveBeenCalledOnce();
    expect(pairingClose, 'unconfirmed cancellation did not close the guardian pairing').toHaveBeenCalledOnce();
    expect(proxyRoleCloseHarness.proxyClose).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(1);
  });
});

describe('buildEnforcementOutcomeHandlers', () => {
  it('defers, then exits 0 on containment-absent', async () => {
    const scheduledCallbacks: Array<() => void> = [];
    const markExited = vi.fn();
    const close = vi.fn(async () => undefined);
    const exitProcess = vi.fn();
    const handlers = buildEnforcementOutcomeHandlers({
      role: 'guardian',
      roleIdentity: { pid: 4101, incarnation: testIncarnation(4101) },
      deadlines: { markExited },
      close,
      exitProcess,
      grantWasInstalled: () => true,
      now: () => 1_000,
      retryUnattributable: () => null,
      schedule: (callback) => {
        scheduledCallbacks.push(callback);
      },
    });

    handlers.onOutcome({ kind: 'containment-absent', disappearanceReceipt: 'receipt' });

    // Deferred, not run inline: an in-flight `guardian.containment-commit.v1` caller's own response has to
    // reach the wire before this closes anything out from under it.
    expect(markExited).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
    expect(scheduledCallbacks).toHaveLength(1);

    scheduledCallbacks[0]?.();
    await new Promise((resolve) => setImmediate(resolve));

    expect(markExited).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it('holds a reap-failed outcome for retry instead of ending the role', async () => {
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const markExited = vi.fn();
    const close = vi.fn(async () => undefined);
    const exitProcess = vi.fn();
    const retryUnattributable = vi.fn(() =>
      Promise.resolve<EnforcementOutcome>({
        kind: 'reap-failed',
        reason: 'still stuck',
      }),
    );
    const handlers = buildEnforcementOutcomeHandlers({
      role: 'reaper',
      roleIdentity: { pid: 4102, incarnation: testIncarnation(4102) },
      deadlines: { markExited },
      close,
      exitProcess,
      grantWasInstalled: () => true,
      now: () => 1_000,
      retryUnattributable,
      schedule: (callback, delayMs) => scheduled.push({ callback, delayMs }),
    });

    handlers.onOutcome({ kind: 'reap-failed', reason: 'stuck' });
    scheduled.shift()?.callback();

    expect(handlers.enforcementHoldStatus()).toMatchObject({
      kind: 'reap-failed',
      reason: 'process-containment-reap-failed',
      attempts: 1,
      retry: { state: 'scheduled' },
    });
    scheduled.shift()?.callback();
    expect(retryUnattributable).toHaveBeenCalledOnce();
    expect(markExited).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
  });

  it('still exits when close() itself rejects', async () => {
    const exitProcess = vi.fn();
    const handlers = buildEnforcementOutcomeHandlers({
      role: 'guardian',
      roleIdentity: { pid: 4103, incarnation: testIncarnation(4103) },
      deadlines: { markExited: vi.fn() },
      close: vi.fn(async () => {
        throw new Error('close failed');
      }),
      exitProcess,
      grantWasInstalled: () => true,
      now: () => 1_000,
      retryUnattributable: () => null,
      schedule: (callback) => callback(),
    });

    handlers.onOutcome({ kind: 'containment-absent', disappearanceReceipt: 'receipt' });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it('keeps an unattributable group as durable status through bounded backoff exhaustion', () => {
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const retryUnattributable = vi.fn(() =>
      Promise.resolve({ kind: 'recorded-group-unattributable' as const, reason: 'still held' }),
    );
    const close = vi.fn(async () => undefined);
    const exitProcess = vi.fn();
    const handlers = buildEnforcementOutcomeHandlers({
      role: 'reaper',
      roleIdentity: { pid: 4200, incarnation: testIncarnation(4200) },
      deadlines: { markExited: vi.fn() },
      close,
      exitProcess,
      grantWasInstalled: () => true,
      now: () => 10_000,
      retryUnattributable,
      schedule: (callback, delayMs) => scheduled.push({ callback, delayMs }),
    });

    for (let attempts = 1; attempts < 5; attempts += 1) {
      handlers.onOutcome({ kind: 'recorded-group-unattributable', reason: 'still held' });
      const deferredOutcome = scheduled.shift();
      if (deferredOutcome === undefined) throw new Error('expected a deferred unattributable outcome');
      expect(deferredOutcome.delayMs).toBe(0);
      deferredOutcome.callback();
      expect(handlers.enforcementHoldStatus()).toMatchObject({
        kind: 'recorded-group-unattributable',
        attempts,
        roleIdentity: { role: 'reaper', pid: 4200, incarnation: testIncarnation(4200) },
        retry: { state: 'scheduled' },
      });
      const scheduledRetry = scheduled.shift();
      if (scheduledRetry === undefined) throw new Error('expected a scheduled unattributable retry');
      expect(scheduledRetry.delayMs).toBeGreaterThan(0);
      scheduledRetry.callback();
      expect(handlers.enforcementHoldStatus()?.retry.state).toBe('in-progress');
    }

    handlers.onOutcome({ kind: 'recorded-group-unattributable', reason: 'still held' });
    const deferredOutcome = scheduled.shift();
    if (deferredOutcome === undefined) throw new Error('expected a deferred unattributable outcome');
    expect(deferredOutcome.delayMs).toBe(0);
    deferredOutcome.callback();

    expect(retryUnattributable).toHaveBeenCalledTimes(4);
    expect(handlers.enforcementHoldStatus()).toEqual({
      kind: 'recorded-group-unattributable',
      attempts: 5,
      roleIdentity: { role: 'reaper', pid: 4200, incarnation: testIncarnation(4200) },
      retry: { state: 'operator-action-required' },
    });
    expect(scheduled).toHaveLength(0);
    expect(close).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
  });

  it('keeps retrying at a fixed cadence until an ungranted role confirms absence', async () => {
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const retryUnattributable = vi.fn(() =>
      Promise.resolve({ kind: 'recorded-group-unattributable' as const, reason: 'still held' }),
    );
    const close = vi.fn(async () => undefined);
    const exitProcess = vi.fn();
    const handlers = buildEnforcementOutcomeHandlers({
      role: 'reaper',
      roleIdentity: { pid: 4225, incarnation: testIncarnation(4225) },
      deadlines: { markExited: vi.fn() },
      close,
      exitProcess,
      grantWasInstalled: () => false,
      now: () => 10_000,
      retryUnattributable,
      schedule: (callback, delayMs) => scheduled.push({ callback, delayMs }),
    });
    const retryDelays: number[] = [];

    for (let attempts = 1; attempts <= 7; attempts += 1) {
      handlers.onOutcome({ kind: 'recorded-group-unattributable', reason: 'still held' });
      const deferredOutcome = scheduled.shift();
      if (deferredOutcome === undefined) throw new Error('expected a deferred unattributable outcome');
      deferredOutcome.callback();
      expect(handlers.enforcementHoldStatus()).toMatchObject({
        attempts,
        retry: { state: 'scheduled' },
      });
      const scheduledRetry = scheduled.shift();
      if (scheduledRetry === undefined) throw new Error('expected a scheduled unattributable retry');
      retryDelays.push(scheduledRetry.delayMs);
      scheduledRetry.callback();
    }

    expect(retryDelays.slice(-2)).toEqual([30_000, 30_000]);
    expect(retryUnattributable).toHaveBeenCalledTimes(7);
    expect(handlers.enforcementHoldStatus()).toMatchObject({
      attempts: 7,
      retry: { state: 'in-progress' },
    });
    expect(close).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();

    handlers.onOutcome({ kind: 'containment-absent', disappearanceReceipt: 'observed-absent' });
    scheduled.shift()?.callback();
    await new Promise((resolve) => setImmediate(resolve));

    expect(handlers.enforcementHoldStatus()).toBeNull();
    expect(close).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it('keeps an unattributable hold without operator abandonment', () => {
    const scheduled: Array<() => void> = [];
    const close = vi.fn(async () => undefined);
    const exitProcess = vi.fn();
    const handlers = buildEnforcementOutcomeHandlers({
      role: 'guardian',
      roleIdentity: { pid: 4250, incarnation: testIncarnation(4250) },
      deadlines: { markExited: vi.fn() },
      close,
      exitProcess,
      grantWasInstalled: () => true,
      now: () => 10_000,
      retryUnattributable: () => null,
      schedule: (callback) => scheduled.push(callback),
    });

    handlers.onOutcome({ kind: 'recorded-group-unattributable', reason: 'still held' });
    scheduled[0]?.();

    expect(handlers.enforcementHoldStatus()).toMatchObject({
      kind: 'recorded-group-unattributable',
      attempts: 1,
    });
    expect(close).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
  });

  it('refuses abandonment while an unattributable retry is in-progress', () => {
    const scheduled: Array<() => void> = [];
    const close = vi.fn(async () => undefined);
    const exitProcess = vi.fn();
    const retryUnattributable = vi.fn(() => new Promise<EnforcementOutcome>(() => undefined));
    const handlers = buildEnforcementOutcomeHandlers({
      role: 'guardian',
      roleIdentity: { pid: 4275, incarnation: testIncarnation(4275) },
      deadlines: { markExited: vi.fn() },
      close,
      exitProcess,
      grantWasInstalled: () => true,
      now: () => 10_000,
      retryUnattributable,
      schedule: (callback) => scheduled.push(callback),
    });

    handlers.onOutcome({ kind: 'recorded-group-unattributable', reason: 'still held' });
    scheduled.shift()?.();
    scheduled.shift()?.();

    expect(handlers.enforcementHoldStatus()?.retry.state).toBe('in-progress');
    expect(() => handlers.abandonUnattributable()).toThrow(
      'retry is in-progress and may already have sent a process signal',
    );
    expect(handlers.enforcementHoldStatus()?.retry.state).toBe('in-progress');
    expect(close).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
  });

  it('refuses unattributable abandonment for a reap-failed hold', () => {
    const scheduled: Array<() => void> = [];
    const close = vi.fn(async () => undefined);
    const exitProcess = vi.fn();
    const handlers = buildEnforcementOutcomeHandlers({
      role: 'reaper',
      roleIdentity: { pid: 4280, incarnation: testIncarnation(4280) },
      deadlines: { markExited: vi.fn() },
      close,
      exitProcess,
      grantWasInstalled: () => true,
      now: () => 10_000,
      retryUnattributable: () => null,
      schedule: (callback) => scheduled.push(callback),
    });

    handlers.onOutcome({ kind: 'reap-failed', reason: 'signal failed' });
    scheduled.shift()?.();

    expect(() => handlers.abandonUnattributable()).toThrow(
      'failed containment reap, not an unattributable recorded group',
    );
    expect(handlers.enforcementHoldStatus()).toMatchObject({ kind: 'reap-failed' });
    expect(close).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
  });

  it('uses explicit operator-abandonment authority to exit nonzero after an unattributable reap', async () => {
    const scheduled: Array<() => void> = [];
    const markExited = vi.fn();
    const close = vi.fn(async () => undefined);
    const exitProcess = vi.fn();
    const handlers = buildEnforcementOutcomeHandlers({
      role: 'guardian',
      roleIdentity: { pid: 4300, incarnation: testIncarnation(4300) },
      deadlines: { markExited },
      close,
      exitProcess,
      grantWasInstalled: () => true,
      now: () => 10_000,
      retryUnattributable: () => null,
      schedule: (callback) => scheduled.push(callback),
    });

    handlers.onOutcome({ kind: 'recorded-group-unattributable', reason: 'still held' });
    scheduled[0]?.();
    expect(handlers.abandonUnattributable()).toBe(true);
    expect(handlers.abandonUnattributable()).toBe(false);
    scheduled.at(-1)?.();
    await new Promise((resolve) => setImmediate(resolve));

    expect(handlers.enforcementHoldStatus()).toBeNull();
    expect(markExited).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(1);
  });
});
