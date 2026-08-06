import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createProviderBootstrapCapsule,
  type GuardianBootstrapCapsule,
  type ProxyBootstrapCapsule,
  type ReaperBootstrapCapsule,
} from '#src/provider-proxy/bootstrap-capsule.js';
import { buildEnforcementOutcomeHandlers, runProviderRoleMain } from '#src/provider-proxy/role-main.js';
import type { ProviderRole } from '#src/provider-proxy/role-argv.js';
import { createRealRuntime } from '#src/runtime/real.js';

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
});

function scopedTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

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
