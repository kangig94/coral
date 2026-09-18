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
import { backendLog } from '#src/infra/backend-log.js';
import type * as NodeProcessMod from '#src/infra/node-process.js';
import { SIGTERM_GRACE_MS } from '#src/infra/process-constants.js';
import { CORAL_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS_ENV } from '#src/provider-proxy/orphan-deadline.js';
import {
  buildEnforcementOutcomeHandlers,
  GuardianConstructionCleanupHeldError,
  runProviderRoleMain,
  startProviderGuardianRole,
  startProviderProxyRole,
  startProviderReaperRole,
  type ProviderRoleMainPorts,
} from '#src/provider-proxy/role-main.js';
import type { ProviderRole } from '#src/provider-proxy/role-argv.js';
import {
  RoleSpawnError,
  type RoleSpawnCleanupDisposition,
  type connectRoleControlWithRetry as connectRoleControlWithRetryType,
  type spawnRoleProcess as spawnRoleProcessType,
} from '#src/provider-proxy/role-spawn.js';
import type { ChildProcessLike } from '#src/infra/port-types.js';
import type * as ProxyMod from '#src/provider-proxy/proxy.js';
import type * as ReaperMod from '#src/provider-proxy/reaper.js';
import type * as GuardianMod from '#src/provider-proxy/guardian.js';
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
  cleanup: vi.fn<(signal?: AbortSignal) => ReturnType<typeof NodeProcessMod.terminateProcessIncarnationProbes>>(),
  subjects: vi.fn<() => ReturnType<typeof NodeProcessMod.snapshotProcessIncarnationProbeSubjects>>(() => []),
}));

const guardianConstructionHarness = vi.hoisted(() => ({
  enabled: false,
  listen: vi.fn<() => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
  recordContainment: vi.fn<() => Promise<void>>(),
}));

vi.mock('#src/infra/node-process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeProcessMod>();
  return {
    ...actual,
    processIncarnationProbeRegistrySize: () =>
      processIncarnationProbeCleanupHarness.enabled
        ? processIncarnationProbeCleanupHarness.subjects().length
        : actual.processIncarnationProbeRegistrySize(),
    terminateProcessIncarnationProbes: (signal?: AbortSignal) =>
      processIncarnationProbeCleanupHarness.enabled
        ? processIncarnationProbeCleanupHarness.cleanup(signal)
        : actual.terminateProcessIncarnationProbes(signal),
    snapshotProcessIncarnationProbeSubjects: () =>
      processIncarnationProbeCleanupHarness.enabled
        ? processIncarnationProbeCleanupHarness.subjects()
        : actual.snapshotProcessIncarnationProbeSubjects(),
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
            forceClose: async () => undefined,
            evictHost: async () => ({ kind: 'stale' as const }),
            evictHostV1: async () => ({ kind: 'stale' as const }),
            admissionSnapshot: () => ({ state: new Map(), tombstones: [] }),
            listProviderHosts: () => [],
            inspectProviderHost: () => null,
            terminalEviction: () => null,
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

vi.mock('#src/provider-proxy/guardian.js', async (importOriginal) => {
  const actual = await importOriginal<typeof GuardianMod>();
  return {
    ...actual,
    createGuardian: (...args: Parameters<typeof actual.createGuardian>) =>
      guardianConstructionHarness.enabled
        ? ({
            listen: guardianConstructionHarness.listen,
            close: guardianConstructionHarness.close,
            recordContainment: guardianConstructionHarness.recordContainment,
            enforcer: () => null,
          } as unknown as ReturnType<typeof actual.createGuardian>)
        : actual.createGuardian(...args),
  };
});

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
  processIncarnationProbeCleanupHarness.subjects.mockReset().mockReturnValue([]);
  guardianConstructionHarness.enabled = false;
  guardianConstructionHarness.listen.mockReset();
  guardianConstructionHarness.close.mockReset();
  guardianConstructionHarness.recordContainment.mockReset();
  vi.restoreAllMocks();
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

function fakeChild(pid: number): ChildProcessLike {
  const child: ChildProcessLike = {
    pid,
    exitCode: null,
    signalCode: null,
    stdin: null,
    stdout: null,
    stderr: null,
    on() {
      return this;
    },
    kill: () => true,
  };
  return child;
}

function fakeSpawnedRoleFor(pid: number): ReturnType<typeof spawnRoleProcessType> {
  return {
    kind: 'spawned',
    child: fakeChild(pid),
    pid,
    incarnation: testIncarnation(1),
    spawnFailed: new Promise<never>(() => {}),
  };
}

function fakeSpawnedRole(): ReturnType<typeof spawnRoleProcessType> {
  return fakeSpawnedRoleFor(2_000_000_000);
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

function constructionHoldRuntime(readProcessIncarnation: (pid: number) => NodeProcessMod.ProcessIncarnation | null): {
  runtime: ReturnType<typeof createRealRuntime>;
  kill: ReturnType<typeof vi.fn>;
} {
  const base = createRealRuntime('prod');
  const kill = vi.fn();
  return {
    runtime: {
      ...base,
      time: { ...base.time, sleep: async () => undefined },
      process: {
        ...base.process,
        kill,
        observeLiveness: () => 'unknown' as const,
        observeRecordedProcessAsync: async () => 'unknown' as const,
        readProcessIncarnation,
      },
    },
    kill,
  };
}

describe('role pairing sender schemas', () => {
  it('publishes an attached spawn hold without waiting for child close', async () => {
    const directory = scopedTempDir('coral-guardian-reaper-spawn-hold-');
    const subject = { kind: 'process', pid: 2_000_000_000 } as const;
    const operatorExit = {
      kind: 'abandon-provider-proxy-acquisition' as const,
      subject,
      abandon: () => ({
        kind: 'operator-abandoned' as const,
        subject,
        processAbsenceProven: false as const,
        successor: { owner: 'operator-command' as const, acceptance: 'accepted' as const },
      }),
    };
    const settled = new Promise<void>(() => undefined);
    const retry = vi.fn<(signal?: AbortSignal) => Promise<RoleSpawnCleanupDisposition<typeof subject>>>();
    retry.mockImplementation(async () => ({
      kind: 'held-alive',
      subject,
      observation: 'alive',
      operatorExit,
      settled,
      retry,
    }));
    const spawnRoleProcess = vi.fn(() => ({
      kind: 'held' as const,
      child: fakeChild(subject.pid),
      error: new RoleSpawnError(
        'role_spawn_incarnation_unavailable',
        'reaper',
        'Could not identify the attached reaper.',
      ),
      subject,
      settled,
      operatorExit,
      retry,
    }));
    const exchange = vi.fn();
    enableRoleSender(
      pairingCapsule('guardian', directory, randomBytes(32).toString('hex')),
      { exchange, close: vi.fn() },
      spawnRoleProcess,
    );

    const failure = await startProviderGuardianRole('/unused', roleSenderPorts(directory)).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(GuardianConstructionCleanupHeldError);
    expect((failure as GuardianConstructionCleanupHeldError).message).toContain(
      'failed-role-spawn process pid=2000000000',
    );
    const hold = (failure as GuardianConstructionCleanupHeldError).hold;
    expect(hold.pending).toMatchObject([
      {
        kind: 'failed-role-spawn',
        subject,
        operatorExit: { kind: 'abandon-provider-proxy-acquisition' },
        settled,
      },
    ]);
    expect(retry).toHaveBeenCalledOnce();
    const retried = await hold.retry();
    expect(retried).toMatchObject({
      kind: 'holding',
      pending: [{ kind: 'failed-role-spawn', subject, reason: 'process:alive' }],
    });
    if (retried.kind !== 'holding') throw new Error('Expected construction cleanup to remain held.');
    expect(retried.pending).toMatchObject([{ settled }]);
    expect(exchange).not.toHaveBeenCalled();
  });

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
    expect((failure as GuardianConstructionCleanupHeldError).message).toContain(
      `reaper-process pid=2000000000 incarnation=${testIncarnation(1)}`,
    );
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
    expect((failure as GuardianConstructionCleanupHeldError).message).toContain(
      `reaper-process pid=2000000000 incarnation=${testIncarnation(1)}`,
    );
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

  it('unwinds construction when containment recording completes without arming an enforcer', async () => {
    const directory = scopedTempDir('coral-guardian-enforcer-invariant-');
    const reaperPid = 2_000_000_000;
    const proxyPid = 2_000_000_001;
    const channelClose = vi.fn();
    enableRoleSender(
      pairingCapsule('guardian', directory, randomBytes(32).toString('hex')),
      {
        exchange: vi.fn(
          async (): Promise<ControlExchange> =>
            controlExchangeForTest({ kind: 'response', response: { kind: 'result', value: { state: 'paired' } } }),
        ),
        close: channelClose,
      },
      vi.fn().mockReturnValueOnce(fakeSpawnedRoleFor(reaperPid)).mockReturnValueOnce(fakeSpawnedRoleFor(proxyPid)),
    );
    guardianConstructionHarness.enabled = true;
    guardianConstructionHarness.listen.mockResolvedValue();
    guardianConstructionHarness.close.mockResolvedValue();
    guardianConstructionHarness.recordContainment.mockResolvedValue();
    const baseRuntime = createRealRuntime('prod');
    const readProcessIncarnation = (pid: number) => (pid === process.pid ? testIncarnation(1) : testIncarnation(2));
    const runtime = {
      ...baseRuntime,
      process: {
        ...baseRuntime.process,
        kill: vi.fn(() => true),
        observeLiveness: () => 'absent' as const,
        observeRecordedProcessAsync: async () => 'absent' as const,
        readProcessIncarnation,
      },
    };

    const failure = await startProviderGuardianRole('/unused', {
      ...roleSenderPorts(directory),
      runtime,
      readProcessIncarnation,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      message: 'Guardian containment recording completed without an armed enforcer.',
    });
    expect(guardianConstructionHarness.recordContainment).toHaveBeenCalledOnce();
    expect(channelClose).toHaveBeenCalledOnce();
    expect(guardianConstructionHarness.close).toHaveBeenCalledOnce();
    expect(runtime.process.kill).not.toHaveBeenCalled();
  });

  it('closes an unarmed reaper without claiming containment absence', async () => {
    const directory = scopedTempDir('coral-reaper-unarmed-close-');
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
    const exitProcess = vi.fn();

    const handle = await startProviderReaperRole('/unused', {
      ...roleSenderPorts(directory),
      exitProcess,
    });

    await expect(handle.giveUp()).resolves.toEqual({ kind: 'closed-without-containment' });
    expect(reaperRoleCloseHarness.reaperClose).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(0);
  });
});

describe('runProviderRoleMain', () => {
  it("returns 0 for 'none' without constructing a runtime or touching a capsule", async () => {
    // No capsule path is even given — reaching a non-zero result, or a throw, would prove this fell through
    // to a role branch rather than staying the documented no-op.
    await expect(runProviderRoleMain({ role: 'none' }, { pluginRoot: '/unused' })).resolves.toBe(0);
  });

  it('ignores a closed parent pipe but rethrows every other output stream error', async () => {
    const stdoutGuards: Array<(error: Error) => void> = [];
    const stderrGuards: Array<(error: Error) => void> = [];
    vi.spyOn(process.stdout, 'on').mockImplementation(((event: string, listener: (error: Error) => void) => {
      if (event === 'error') stdoutGuards.push(listener);
      return process.stdout;
    }) as typeof process.stdout.on);
    vi.spyOn(process.stderr, 'on').mockImplementation(((event: string, listener: (error: Error) => void) => {
      if (event === 'error') stderrGuards.push(listener);
      return process.stderr;
    }) as typeof process.stderr.on);

    await runProviderRoleMain(
      { role: 'guardian', capsulePath: '/missing-provider-role-capsule' },
      { pluginRoot: '/unused' },
    ).catch(() => undefined);

    const stdoutGuard = stdoutGuards[0];
    const stderrGuard = stderrGuards[0];
    if (stdoutGuard === undefined || stderrGuard === undefined) {
      throw new Error('role stream guards were not installed');
    }
    expect(stderrGuard).toBe(stdoutGuard);
    const brokenPipe = Object.assign(new Error('parent pipe closed'), { code: 'EPIPE' });
    expect(() => stdoutGuard(brokenPipe)).not.toThrow();

    const unexpected = Object.assign(new Error('unexpected stream failure'), { code: 'EIO' });
    let observed: unknown;
    try {
      stderrGuard(unexpected);
    } catch (error: unknown) {
      observed = error;
    }
    expect(observed).toBe(unexpected);
  });

  it('ends a held guardian construction after bounded retries without waiting for a signal', async () => {
    const directory = scopedTempDir('coral-guardian-construction-operator-exit-');
    const subject = { kind: 'process', pid: 2_000_000_000 } as const;
    const abandonment = {
      kind: 'operator-abandoned' as const,
      subject,
      processAbsenceProven: false as const,
      successor: { owner: 'operator-command' as const, acceptance: 'accepted' as const },
    };
    const operatorExit = {
      kind: 'abandon-provider-proxy-acquisition' as const,
      subject,
      abandon: vi
        .fn<() => typeof abandonment>()
        .mockReturnValueOnce({
          ...abandonment,
          subject: { kind: 'process' as const, pid: subject.pid + 1 },
        } as unknown as typeof abandonment)
        .mockReturnValue(abandonment),
    };
    const settled = new Promise<void>(() => undefined);
    const retry = vi.fn<(signal?: AbortSignal) => Promise<RoleSpawnCleanupDisposition<typeof subject>>>();
    retry.mockImplementation(async () => ({
      kind: 'held-alive',
      subject,
      observation: 'alive',
      operatorExit,
      settled,
      retry,
    }));
    enableRoleSender(
      pairingCapsule('guardian', directory, randomBytes(32).toString('hex')),
      { exchange: vi.fn(), close: vi.fn() },
      vi.fn(() => ({
        kind: 'held' as const,
        child: fakeChild(subject.pid),
        error: new RoleSpawnError(
          'role_spawn_incarnation_unavailable',
          'reaper',
          'Could not identify the attached reaper.',
        ),
        subject,
        settled,
        operatorExit,
        retry,
      })),
    );
    const { runtime } = constructionHoldRuntime((pid) => (pid === process.pid ? testIncarnation(1) : null));
    processIncarnationProbeCleanupHarness.enabled = true;
    processIncarnationProbeCleanupHarness.cleanup.mockResolvedValue({ disposition: 'settled' });
    const exitProcess = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    const running = runProviderRoleMain(
      { role: 'guardian', capsulePath: '/unused' },
      { pluginRoot: directory, runtime },
    );

    await expect(running).resolves.toBe(1);
    expect(retry).toHaveBeenCalledTimes(5);
    expect(operatorExit.abandon).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
  });

  it('ends an unobservable construction reaper after bounded retries without claiming absence', async () => {
    const directory = scopedTempDir('coral-guardian-construction-reaper-exit-');
    enableRoleSender(pairingCapsule('guardian', directory, { unexpected: true }), {
      exchange: vi.fn(),
      close: vi.fn(),
    });
    const { runtime, kill } = constructionHoldRuntime((pid) => {
      if (pid === process.pid) return testIncarnation(1);
      throw new Error('reaper identity is unobservable');
    });
    processIncarnationProbeCleanupHarness.enabled = true;
    processIncarnationProbeCleanupHarness.cleanup.mockResolvedValue({ disposition: 'settled' });
    const exitProcess = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    const running = runProviderRoleMain(
      { role: 'guardian', capsulePath: '/unused' },
      { pluginRoot: directory, runtime },
    );
    await expect(running).resolves.toBe(1);
    expect(kill).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
  });

  it('ends an unobservable construction proxy group after bounded retries without claiming absence', async () => {
    const directory = scopedTempDir('coral-guardian-construction-proxy-exit-');
    const reaperPid = 2_000_000_000;
    const proxyPid = 2_000_000_001;
    const exchange = vi.fn(
      async (): Promise<ControlExchange> =>
        controlExchangeForTest({ kind: 'response', response: { kind: 'result', value: { state: 'paired' } } }),
    );
    const spawnRoleProcess = vi
      .fn()
      .mockReturnValueOnce({ ...(fakeSpawnedRole() as object), pid: reaperPid })
      .mockReturnValueOnce({ ...(fakeSpawnedRole() as object), pid: proxyPid });
    enableRoleSender(
      pairingCapsule('guardian', directory, randomBytes(32).toString('hex')),
      { exchange, close: vi.fn() },
      spawnRoleProcess,
    );
    guardianConstructionHarness.enabled = true;
    guardianConstructionHarness.listen.mockResolvedValue();
    guardianConstructionHarness.close.mockResolvedValue();
    guardianConstructionHarness.recordContainment.mockRejectedValue(new Error('containment publication failed'));
    const { runtime, kill } = constructionHoldRuntime((pid) => {
      if (pid === process.pid) return testIncarnation(1);
      if (pid === reaperPid) return testIncarnation(2);
      throw new Error('proxy identity is unobservable');
    });
    processIncarnationProbeCleanupHarness.enabled = true;
    processIncarnationProbeCleanupHarness.cleanup.mockResolvedValue({ disposition: 'settled' });
    const exitProcess = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errorLog = vi.spyOn(backendLog, 'error').mockImplementation(() => undefined);

    const running = runProviderRoleMain(
      { role: 'guardian', capsulePath: '/unused' },
      { pluginRoot: directory, runtime },
    );
    await expect(running).resolves.toBe(1);
    expect(errorLog).toHaveBeenCalledWith(
      'guardian: construction failed and spawned process cleanup remains held',
      expect.objectContaining({
        message: expect.stringContaining(
          `proxy-process-group pgid=${proxyPid} pid=${proxyPid} incarnation=${testIncarnation(1)}`,
        ),
      }),
    );
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining(
        `guardian: construction cleanup remained held after 5 attempts; exiting: proxy-process-group pgid=${proxyPid} ` +
          `pid=${proxyPid} incarnation=${testIncarnation(1)}`,
      ),
    );
    expect(kill).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
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

  it('exits after the probe-cleanup grace when observation helpers never settle', async () => {
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
    processIncarnationProbeCleanupHarness.subjects.mockReturnValue([{ pid: 4_242 }, { key: 'provider-probe:job-17' }]);
    processIncarnationProbeCleanupHarness.cleanup.mockImplementation(
      (signal) =>
        new Promise((resolve) => {
          signal?.addEventListener(
            'abort',
            () =>
              resolve({
                disposition: 'hold',
                unsettled: [
                  {
                    child: {} as never,
                    pid: 4_242,
                    reason: 'close-unobserved',
                    exit: 'child-close',
                  },
                  {
                    child: null,
                    pid: undefined,
                    key: 'provider-probe:job-17',
                    reason: 'probe-unsettled',
                    exit: 'probe-settlement',
                  },
                ],
                untilSettled: new Promise<void>(() => undefined),
              }),
            { once: true },
          );
        }),
    );

    let shutdown: (() => void) | null = null;
    vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      if (event === 'SIGTERM') shutdown = listener as () => void;
      return process;
    });
    const exitProcess = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errorLog = vi.spyOn(backendLog, 'error').mockImplementation(() => undefined);

    vi.useFakeTimers();
    try {
      await expect(
        runProviderRoleMain({ role: 'proxy', capsulePath: '/unused' }, { pluginRoot: directory }),
      ).resolves.toBe(0);
      exitProcess.mockClear();

      (shutdown as (() => void) | null)?.();
      await Promise.resolve();
      expect(processIncarnationProbeCleanupHarness.cleanup).toHaveBeenCalledWith(expect.any(AbortSignal));
      expect(exitProcess).not.toHaveBeenCalled();

      settleSemanticShutdown();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(SIGTERM_GRACE_MS);

      expect(errorLog).toHaveBeenCalledWith(
        'proxy: exit proceeding with unsettled process-incarnation probes: ' +
          'pid=4242 reason=close-unobserved exit=child-close; ' +
          'key=provider-probe:job-17 reason=probe-unsettled exit=probe-settlement',
      );
      expect(processIncarnationProbeCleanupHarness.cleanup).toHaveBeenCalledOnce();
      expect(exitProcess).toHaveBeenCalledOnce();
      expect(exitProcess).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exits after requested probe cleanup rejects without waiting for another signal', async () => {
    const directory = scopedTempDir('coral-proxy-role-probe-cleanup-rejection-');
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
    processIncarnationProbeCleanupHarness.subjects.mockReturnValue([{ pid: 4_242 }]);
    const cleanupFailure = new Error('probe termination crashed');
    let rejectCleanup!: (error: unknown) => void;
    processIncarnationProbeCleanupHarness.cleanup.mockReturnValue(
      new Promise((_, reject) => {
        rejectCleanup = reject;
      }),
    );

    let shutdown: (() => void) | null = null;
    vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      if (event === 'SIGTERM') shutdown = listener as () => void;
      return process;
    });
    const exitProcess = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errorLog = vi.spyOn(backendLog, 'error').mockImplementation(() => undefined);

    await expect(
      runProviderRoleMain({ role: 'proxy', capsulePath: '/unused' }, { pluginRoot: directory }),
    ).resolves.toBe(0);
    exitProcess.mockClear();

    (shutdown as (() => void) | null)?.();
    settleSemanticShutdown();
    await new Promise<void>((resolve) => setImmediate(resolve));
    rejectCleanup(cleanupFailure);

    await vi.waitFor(() => expect(exitProcess).toHaveBeenCalledWith(0));
    expect(errorLog).toHaveBeenCalledWith(
      'proxy: exit proceeding after process-incarnation probe cleanup failed; registered subjects: pid=4242',
      cleanupFailure,
    );
    expect(processIncarnationProbeCleanupHarness.cleanup).toHaveBeenCalledOnce();
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

  it('closes and exits with enforcement failure when signal teardown rejects', async () => {
    const directory = scopedTempDir('coral-reaper-role-signal-rejection-');
    enableRoleSender(pairingCapsule('reaper', directory, randomBytes(32).toString('hex')), {
      exchange: vi.fn(async (): Promise<never> => {
        throw new Error('reaper unexpectedly opened an outbound control exchange');
      }),
      close: vi.fn(),
    });
    reaperRoleCloseHarness.enabled = true;
    reaperRoleCloseHarness.reaperListen.mockResolvedValue();
    reaperRoleCloseHarness.reaperClose.mockResolvedValue();
    const failure = new Error('signal teardown rejected');
    const giveUp = vi.fn().mockRejectedValue(failure);
    reaperRoleCloseHarness.enforcer.mockReturnValue({ giveUp, retryUnattributable: () => null });

    let shutdown: (() => void) | null = null;
    vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      if (event === 'SIGTERM') shutdown = listener as () => void;
      return process;
    });
    const exitProcess = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errorLog = vi.spyOn(backendLog, 'error').mockImplementation(() => undefined);

    await expect(
      runProviderRoleMain({ role: 'reaper', capsulePath: '/unused' }, { pluginRoot: directory }),
    ).resolves.toBe(0);
    reaperRoleCloseHarness.reaperClose.mockClear();
    exitProcess.mockClear();

    (shutdown as (() => void) | null)?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(giveUp).toHaveBeenCalledOnce();
    expect(errorLog).toHaveBeenCalledWith(
      'reaper: give-up on shutdown failed; releasing role authority and exiting',
      failure,
    );
    expect(reaperRoleCloseHarness.reaperClose).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(reaperRoleCloseHarness.reaperClose.mock.invocationCallOrder[0]).toBeLessThan(
      exitProcess.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

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

    // Close-and-exit must remain deferred until an in-flight control response can be written.
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

  it('closes and exits with enforcement failure after bounded unattributable retries are exhausted', async () => {
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const retryUnattributable = vi.fn(() =>
      Promise.resolve({ kind: 'recorded-group-unattributable' as const, reason: 'still held' }),
    );
    const close = vi.fn(async () => undefined);
    const exitProcess = vi.fn();
    const markExited = vi.fn();
    const handlers = buildEnforcementOutcomeHandlers({
      role: 'reaper',
      roleIdentity: { pid: 4200, incarnation: testIncarnation(4200) },
      deadlines: { markExited },
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
    expect(handlers.enforcementHoldStatus()).toBeNull();
    expect(scheduled).toHaveLength(0);
    await new Promise((resolve) => setImmediate(resolve));

    expect(markExited).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(
      exitProcess.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
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
