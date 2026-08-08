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
import type { ControlClient } from '#src/provider-proxy/control-client.js';
import {
  buildEnforcementOutcomeHandlers,
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
import { createRealRuntime } from '#src/runtime/real.js';

const roleSenderHarness = vi.hoisted(() => ({
  enabled: false,
  capsule: undefined as unknown,
  channel: undefined as unknown,
  spawnRoleProcess: undefined as unknown,
}));

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
});

function scopedTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function pairingCapsule(role: 'guardian' | 'proxy', directory: string, pairingSecret: unknown): unknown {
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
  return {
    role,
    ...shared,
    canonicalEndpoint: join(directory, 'p.sock'),
    guardianControlEndpoint: join(directory, 'g.sock'),
    proxyGuardianAuthSecret: pairingSecret,
  };
}

function roleSenderPorts(directory: string): ProviderRoleMainPorts {
  return {
    runtime: createRealRuntime('prod'),
    pluginRoot: directory,
    baseDir: directory,
    readProcessStartedAtSeconds: (pid) => (pid === process.pid ? 1 : null),
  };
}

function fakeSpawnedRole(): unknown {
  return {
    child: {},
    pid: 2_000_000_000,
    processStartedAtSeconds: 1,
    spawnFailed: new Promise<never>(() => {}),
  };
}

function enableRoleSender(capsule: unknown, channel: ControlClient, spawnRoleProcess = vi.fn(fakeSpawnedRole)): void {
  roleSenderHarness.enabled = true;
  roleSenderHarness.capsule = capsule;
  roleSenderHarness.channel = channel;
  roleSenderHarness.spawnRoleProcess = spawnRoleProcess;
}

describe('role pairing sender schemas', () => {
  it('refuses malformed guardian-to-reaper pairing params before consulting the reaper', async () => {
    const directory = scopedTempDir('coral-guardian-pair-sender-');
    const call = vi.fn(async (): Promise<never> => {
      throw new Error('receiver was consulted');
    });
    enableRoleSender(pairingCapsule('guardian', directory, { unexpected: true }), { call, close: vi.fn() });

    await expect(startProviderGuardianRole('/unused', roleSenderPorts(directory))).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'invalid_type', path: ['pairingSecret'] })],
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('refuses malformed proxy-to-guardian pairing params before consulting the guardian', async () => {
    const directory = scopedTempDir('coral-proxy-pair-sender-');
    const call = vi.fn(async (): Promise<never> => {
      throw new Error('receiver was consulted');
    });
    enableRoleSender(pairingCapsule('proxy', directory, { unexpected: true }), { call, close: vi.fn() });

    await expect(startProviderProxyRole('/unused', roleSenderPorts(directory))).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'invalid_type', path: ['pairingSecret'] })],
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('refuses a malformed reaper pairing reply before spawning or constructing the proxy', async () => {
    const directory = scopedTempDir('coral-reaper-pair-reply-');
    const call = vi.fn(async () => ({ state: 'paired', unexpected: true }));
    const spawnRoleProcess = vi
      .fn()
      .mockImplementationOnce(fakeSpawnedRole)
      .mockImplementation(() => {
        throw new Error('malformed pairing reply was acted on');
      });
    enableRoleSender(
      pairingCapsule('guardian', directory, randomBytes(32).toString('hex')),
      { call, close: vi.fn() },
      spawnRoleProcess,
    );

    await expect(startProviderGuardianRole('/unused', roleSenderPorts(directory))).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'unrecognized_keys', keys: ['unexpected'], path: [] })],
    });
    expect(call).toHaveBeenCalledOnce();
    expect(spawnRoleProcess).toHaveBeenCalledOnce();
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
});

describe('buildEnforcementOutcomeHandlers', () => {
  it('defers past the current continuation, then marks exited, closes, and exits 0 on containment-absent', async () => {
    const scheduledCallbacks: Array<() => void> = [];
    const markExited = vi.fn();
    const close = vi.fn(async () => undefined);
    const exitProcess = vi.fn();
    const handlers = buildEnforcementOutcomeHandlers({
      role: 'guardian',
      deadlines: { markExited },
      close,
      exitProcess,
      schedule: (callback) => {
        scheduledCallbacks.push(callback);
      },
    });

    handlers.onOutcome({ kind: 'containment-absent', disappearanceReceipt: 'receipt' });

    // Deferred, not run inline: an in-flight `*.stop-and-reap.v1` caller's own response has to reach the
    // wire before this closes anything out from under it.
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

  it('exits nonzero without claiming the exited state on a reap-failed outcome', async () => {
    const markExited = vi.fn();
    const close = vi.fn(async () => undefined);
    const exitProcess = vi.fn();
    const handlers = buildEnforcementOutcomeHandlers({
      role: 'reaper',
      deadlines: { markExited },
      close,
      exitProcess,
      schedule: (callback) => callback(),
    });

    handlers.onOutcome({ kind: 'reap-failed', reason: 'stuck' });
    await new Promise((resolve) => setImmediate(resolve));

    // `markExited()` throws unless teardown actually confirmed absence; asserting it was never called is what
    // tells this outcome apart from `containment-absent` rather than merely tolerating either.
    expect(markExited).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(1);
  });

  it('still exits when close() itself rejects', async () => {
    const exitProcess = vi.fn();
    const handlers = buildEnforcementOutcomeHandlers({
      role: 'guardian',
      deadlines: { markExited: vi.fn() },
      close: vi.fn(async () => {
        throw new Error('close failed');
      }),
      exitProcess,
      schedule: (callback) => callback(),
    });

    handlers.onOutcome({ kind: 'containment-absent', disappearanceReceipt: 'receipt' });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(exitProcess).toHaveBeenCalledWith(0);
  });
});
