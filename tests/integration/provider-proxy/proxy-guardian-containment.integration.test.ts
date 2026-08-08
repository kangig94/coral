import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import { connectControlClient } from '#src/provider-proxy/control-client.js';
import type { EnforcementScheduler } from '#src/provider-proxy/enforcement.js';
import { createGuardian } from '#src/provider-proxy/guardian.js';
import { createOperationLedger } from '#src/provider-proxy/ledger.js';
import type { ProxyIdentity, ProxyPreparedAppServerOperation } from '#src/provider-proxy/protocol.js';
import { createReaper } from '#src/provider-proxy/reaper.js';
import { createProxyGuardianContainment } from '#src/provider-proxy/role-main.js';
import {
  asJointActivationReceipt,
  asJointContainmentReceipt,
  asReservation,
} from '#tests/helpers/provider-proxy-correlation.js';

/**
 * Drives `createProxyGuardianContainment` — the containment closures `startProviderProxyRole` installs on a
 * real `Proxy` — against a *real* `createGuardian`/`createReaper` pair over real control sockets, following
 * the same setup `enforcer-roles.integration.test.ts` uses. Only `ensureProviderRoot` is faked (a canned root,
 * no child process); the reservation, the wire calls, and the guardian/reaper themselves are all real.
 *
 * This is the one path `operation-lifecycle.integration.test.ts` cannot exercise (it injects a stub
 * `containment`) and a full `coral-cli claude` invocation cannot observe either (`launch.ts`'s in-process
 * fallback makes a failed proxy activation behaviourally identical to no proxy at all) — see `role-main.ts`'s
 * `stageProviderRoot` doc for why forwarding the ledger's own reservation, rather than a freshly minted one,
 * is what lets `guardian.operation-activate.v1` ever agree with what the coordinator committed.
 */

const NONCE = 'a'.repeat(64);
const PAIR_SECRET = 'c'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);
const CONTAINMENT = {
  pid: 5_100,
  processStartedAtSeconds: 900,
  processGroupId: 5_100,
  containmentKind: 'posix-group',
};
const ROOT = { pid: 7_001, processStartedAtSeconds: 800 };

const PREPARED: ProxyPreparedAppServerOperation = {
  version: 1,
  provider: 'codex',
  binding: { provider: 'codex', kind: 'account', binding: { account: 'acct-1' } },
  request: {
    action: 'exec',
    sessionId: 'session-1',
    prompt: 'do the thing',
    cwd: '/project',
    bypassPermissions: false,
    coralEnv: {},
  },
  persistedContinuity: null,
  baseEnv: { PATH: '/usr/bin' },
  protectedEnv: {},
  platform: 'linux',
};

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const timer = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: { unref?: () => void }) => clearTimeout(handle as unknown as NodeJS.Timeout),
};

/** Never fires on its own; this test drives every transition through the RPCs themselves. */
const idleScheduler: EnforcementScheduler = { schedule: () => ({}), cancel: () => {} };

/**
 * A real guardian paired with a real reaper over real control sockets, plus a coordinator control connection
 * (`guardian.open.v1`) and the proxy's own paired peer channel (`guardian.pair.v1`) — exactly the
 * `guardianChannel` `startProviderProxyRole` hands to `createProxyGuardianContainment` in production.
 */
async function startGuardianAndReaper(): Promise<{
  control: Awaited<ReturnType<typeof connectControlClient>>;
  guardianChannel: Awaited<ReturnType<typeof connectControlClient>>;
  proxyIdentity: ProxyIdentity;
}> {
  const directory = mkdtempSync(join(tmpdir(), 'coral-proxy-containment-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const guardianEndpoint = join(directory, 'g.sock');
  const reaperEndpoint = join(directory, 'r.sock');
  const proxyEndpoint = join(directory, 'p.sock');

  const shared = {
    generation: 'gen2' as const,
    flavor: 'prod' as const,
    buildSetId: randomUUID(),
    hostFingerprint: FINGERPRINT,
    guardianInstanceId: randomUUID(),
    reaperInstanceId: randomUUID(),
    proxyInstanceId: randomUUID(),
    bootstrapNonce: NONCE,
  };

  const proxyIdentity: ProxyIdentity = {
    proxyInstanceId: shared.proxyInstanceId,
    pid: 6_000,
    processStartedAtSeconds: 850,
    processGroupId: CONTAINMENT.processGroupId,
    guardianInstanceId: shared.guardianInstanceId,
    reaperInstanceId: shared.reaperInstanceId,
    generation: shared.generation,
    flavor: shared.flavor,
    buildSetId: shared.buildSetId,
    hostFingerprint: FINGERPRINT,
    canonicalEndpoint: proxyEndpoint,
  };
  const coordinatorIdentity = {
    instanceId: randomUUID(),
    pid: 4_000,
    processStartedAtSeconds: 700,
    generation: shared.generation,
    flavor: shared.flavor,
    buildSetId: shared.buildSetId,
  };

  const alive = new Set([CONTAINMENT.pid]);
  const clock = createMonotonicClock(Symbol('proxy-guardian-containment'), { readMilliseconds: () => 0n });
  const containmentEnvironment = {
    clock,
    process: {
      kill: (pid: number) => {
        for (const target of pid < 0 ? [...alive] : [pid]) alive.delete(target);
        return true;
      },
      isAlive: (pid: number) => (pid < 0 ? alive.has(-pid) : alive.has(pid)),
    },
    platform: 'linux' as const,
    maxRecordedRoots: 128,
    readProcessStartedAtSeconds: (pid: number) => (alive.has(pid) ? CONTAINMENT.processStartedAtSeconds : null),
  };

  const boundsOf = () => {
    const now = clock.now();
    return {
      lastRoundTripEvidenceAt: now,
      eofAt: null,
      controlLossAt: now,
      adoptionDeadline: clock.shiftMilliseconds(now, 60_000),
      exitDeadline: clock.shiftMilliseconds(now, 74_000),
      firstChallengeExpiresAt: null,
    };
  };
  let challengeCount = 0;
  const mintChallenge = (): string => {
    challengeCount += 1;
    return `challenge-${challengeCount}`;
  };
  const deadlines = {
    controlIsLive: () => true,
    issueFirstChallenge: () => ({ accepted: true, challenge: mintChallenge() }) as const,
    admitSuccessor: () => ({ accepted: true, challenge: mintChallenge() }) as const,
    reattachControl: () => ({ accepted: true }) as const,
    echoChallenge: () => ({ accepted: true, nextChallenge: mintChallenge() }) as const,
    observeEof: () => {},
    observePairingLoss: () => {},
    latchTeardown: () => {},
    markContainmentAbsent: () => {},
    markExited: () => {},
    bounds: boundsOf,
    state: () => 'accepting-control' as const,
  };

  let receipts = 0;
  const mintReceipt = (): string => {
    receipts += 1;
    return `receipt-${receipts}`;
  };

  const reaper = createReaper({
    capsule: {
      role: 'reaper',
      ...shared,
      canonicalControlEndpoint: reaperEndpoint,
      guardianControlEndpoint: guardianEndpoint,
      proxyEndpoint,
      guardianReaperAuthSecret: PAIR_SECRET,
    },
    clock,
    deadlines,
    containmentEnvironment,
    scheduler: idleScheduler,
    timer,
    mintReceipt,
    self: { pid: 5_101, processStartedAtSeconds: 901 },
    onOutcome: () => {},
    onProgressViolation: () => {},
  });
  await reaper.listen();
  cleanups.push(() => reaper.close());

  // The guardian reaches the reaper over the capsule-authenticated pairing channel, exactly as
  // `startProviderGuardianRole` does in production.
  const reaperChannel = await connectControlClient(reaperEndpoint, timer, 5_000);
  cleanups.push(() => reaperChannel.close());
  await reaperChannel.call('reaper.pair.v1', { pairingSecret: PAIR_SECRET }, 5_000);
  await reaperChannel.call('reaper.record-containment.v1', CONTAINMENT, 5_000);

  const guardian = createGuardian({
    capsule: {
      role: 'guardian',
      ...shared,
      canonicalControlEndpoint: guardianEndpoint,
      reaperControlEndpoint: reaperEndpoint,
      proxyEndpoint,
      guardianReaperAuthSecret: PAIR_SECRET,
      proxyGuardianAuthSecret: PAIR_SECRET,
    },
    clock,
    deadlines,
    containmentEnvironment,
    scheduler: idleScheduler,
    timer,
    mintReceipt,
    reaperChannel,
    self: { pid: 5_102, processStartedAtSeconds: 902 },
    reaperSelf: { pid: 5_101, processStartedAtSeconds: 901 },
    onOutcome: () => {},
    onProgressViolation: () => {},
  });
  await guardian.listen();
  cleanups.push(() => guardian.close());
  await guardian.recordContainment(CONTAINMENT);

  // The coordinator's own control tenancy — the connection `guardian.operation-activate.v1` below is issued
  // over, exactly as `provider-proxy-operation-activation.ts` issues it in production.
  const control = await connectControlClient(guardianEndpoint, timer, 5_000);
  cleanups.push(() => control.close());
  const opened = (await control.call(
    'guardian.open.v1',
    { bootstrapNonce: NONCE, coordinator: coordinatorIdentity, proxy: proxyIdentity },
    5_000,
  )) as { controlEpoch: number; heartbeatChallenge: string };
  await control.call(
    'guardian.heartbeat.v1',
    { controlEpoch: opened.controlEpoch, heartbeatChallenge: opened.heartbeatChallenge },
    5_000,
  );

  // The proxy's own connection to its guardian: paired, not the coordinator's control tenancy — exactly the
  // `guardianChannel` `startProviderProxyRole` hands to `createProxyGuardianContainment`.
  const guardianChannel = await connectControlClient(guardianEndpoint, timer, 5_000);
  cleanups.push(() => guardianChannel.close());
  await guardianChannel.call('guardian.pair.v1', { pairingSecret: PAIR_SECRET }, 5_000);

  return { control, guardianChannel, proxyIdentity };
}

describe('createProxyGuardianContainment against a real guardian', () => {
  it('forwards the ledger’s own reservation, so a later operation-activate.v1 presenting it is accepted', async () => {
    const { control, guardianChannel, proxyIdentity } = await startGuardianAndReaper();

    // What `operation.prepare.v1` would have already done to the proxy's own ledger before ever calling
    // `stageProviderRoot`: minted a reservation and stored it. This is that same real ledger, not a hand-built
    // stand-in, and `reserved.entry` is exactly what `proxy.ts`'s own handler passes into `stageProviderRoot`.
    const ledger = createOperationLedger<ProxyPreparedAppServerOperation>();
    const key = { jobId: randomUUID(), operationId: randomUUID() };
    const reservation = asReservation(randomUUID());
    const reserved = ledger.prepare({ key, reservation, prepared: PREPARED, nowMs: 0 });
    if (reserved.kind !== 'reserved') throw new Error('unexpected capacity refusal in a fresh ledger');

    const containment = createProxyGuardianContainment({
      identity: proxyIdentity,
      guardianChannel,
      // The one dependency replaced: a canned root instead of spawning a real provider process.
      ensureProviderRoot: async () => ROOT,
    });

    const staged = await containment.stageProviderRoot(key, {
      reservation: reserved.entry.reservation,
      prepared: reserved.entry.prepared,
    });
    expect(staged.providerRoot).toEqual(ROOT);

    // The coordinator's own reservation: exactly the value `operation.prepare.v1` would have echoed back from
    // this same ledger entry — not one this test invents separately. Before the fix, `stageProviderRoot`
    // forwarded a freshly minted value to the guardian instead of this one, so the guardian's stored
    // membership could never agree with what is presented here.
    const activated = (await control.call(
      'guardian.operation-activate.v1',
      {
        operation: {
          jobId: key.jobId,
          operationId: key.operationId,
          proxyInstanceId: proxyIdentity.proxyInstanceId,
          buildSetId: proxyIdentity.buildSetId,
        },
        reservation,
        providerRoot: ROOT,
        jointContainmentReceipt: asJointContainmentReceipt(staged.receipt),
      },
      5_000,
    )) as { state: string; jointActivationReceipt: string };

    expect(activated.state).toBe('activation-authorized');

    // The full local half of activation also succeeds against what this containment wiring itself recognised
    // as staged — the last step `operation.activate.v1` performs before starting the kernel.
    await expect(
      containment.confirmActivation({
        key,
        jointContainmentReceipt: asJointContainmentReceipt(staged.receipt),
        jointActivationReceipt: asJointActivationReceipt(activated.jointActivationReceipt),
      }),
    ).resolves.toBeUndefined();
  });
});
