import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import { connectControlClient, type ControlClient } from '#src/provider-proxy/control-client.js';
import { createGuardian } from '#src/provider-proxy/guardian.js';
import { createReaper } from '#src/provider-proxy/reaper.js';
import type { EnforcementOutcome, EnforcementScheduler } from '#src/provider-proxy/enforcement.js';

const SECRET = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);
const CONTAINMENT = { pid: 5_100, processStartedAtSeconds: 900, processGroupId: 5_100, containmentKind: 'posix-group' };

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const timer = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: { unref?: () => void }) => clearTimeout(handle as unknown as NodeJS.Timeout),
};

/** Never fires on its own; these tests drive teardown through the RPC, not the deadline. */
const idleScheduler: EnforcementScheduler = { schedule: () => ({}), cancel: () => {} };

function bounds(clock: ReturnType<typeof createMonotonicClock>) {
  const start = clock.now();
  return {
    lastRoundTripEvidenceAt: start,
    eofAt: null,
    controlLossAt: start,
    adoptionDeadline: clock.shiftMilliseconds(start, 60_000),
    exitDeadline: clock.shiftMilliseconds(start, 74_000),
    firstChallengeExpiresAt: null,
  };
}

async function startSet(): Promise<{
  guardianClient: ControlClient;
  reaperOutcomes: EnforcementOutcome[];
  guardianOutcomes: EnforcementOutcome[];
  alive: Set<number>;
}> {
  const directory = mkdtempSync(join(tmpdir(), 'coral-roles-'));
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
    bootstrapNonce: SECRET,
  };

  const alive = new Set<number>([CONTAINMENT.pid, 6_001]);
  const stubborn = new Set<number>();
  let elapsed = 0n;
  const clock = createMonotonicClock(Symbol('roles'), {
    readMilliseconds: () => elapsed,
    sleep: (ms: number) => {
      elapsed += BigInt(ms);
      return Promise.resolve();
    },
  });
  const containmentEnvironment = {
    clock,
    process: {
      kill: (pid: number) => {
        for (const target of pid < 0 ? [...alive] : [pid]) {
          if (!stubborn.has(target)) alive.delete(target);
        }
        return true;
      },
      isAlive: (pid: number) => (pid < 0 ? alive.has(-pid) : alive.has(pid)),
    },
    platform: 'linux' as const,
    readProcessStartedAtSeconds: (pid: number) =>
      !alive.has(pid) ? null : pid === CONTAINMENT.pid ? CONTAINMENT.processStartedAtSeconds : 800,
  };

  const reaperBounds = bounds(clock);
  const guardianBounds = bounds(clock);
  const reaperOutcomes: EnforcementOutcome[] = [];
  const guardianOutcomes: EnforcementOutcome[] = [];
  let receipts = 0;
  const mintReceipt = () => {
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
      guardianReaperAuthSecret: SECRET,
    },
    clock,
    deadlines: {
      state: () => 'armed',
      bounds: () => reaperBounds,
      issueFirstChallenge: () => ({ accepted: true }),
      echoChallenge: () => ({ accepted: true }),
      observeEof: () => {},
      dispatchOrdinaryFrame: () => ({ accepted: true }),
      rotateSuccessor: () => ({ accepted: true }),
      latchTeardown: () => {},
      markContainmentAbsent: () => {},
      markExited: () => {},
    },
    containment: CONTAINMENT,
    containmentEnvironment,
    scheduler: idleScheduler,
    timer,
    mintChallenge: () => randomUUID(),
    mintReceipt,
    self: { pid: 5_101, processStartedAtSeconds: 901 },
    onOutcome: (outcome) => reaperOutcomes.push(outcome),
    onProgressViolation: () => {},
  });
  await reaper.listen();
  cleanups.push(() => reaper.close());

  const reaperChannel = await connectControlClient(reaperEndpoint, timer, 5_000);
  cleanups.push(() => reaperChannel.close());
  // The guardian reaches the reaper over the capsule-authenticated pairing channel, not the coordinator's
  // control connection — staging must work while control is still provisional.
  await reaperChannel.call('reaper.pair.v1', { pairingSecret: SECRET }, 5_000);

  const guardian = createGuardian({
    capsule: {
      role: 'guardian',
      ...shared,
      canonicalControlEndpoint: guardianEndpoint,
      reaperControlEndpoint: reaperEndpoint,
      proxyEndpoint,
      guardianReaperAuthSecret: SECRET,
      proxyGuardianAuthSecret: SECRET,
    },
    clock,
    deadlines: {
      state: () => 'accepting-control',
      bounds: () => guardianBounds,
      issueFirstChallenge: () => ({ accepted: true }),
      echoChallenge: () => ({ accepted: true }),
      observeEof: () => {},
      dispatchOrdinaryFrame: () => ({ accepted: true }),
      redeemSuccessor: () => ({ accepted: true }),
      latchTeardown: () => {},
      markContainmentAbsent: () => {},
      markExited: () => {},
    },
    containment: CONTAINMENT,
    containmentEnvironment,
    scheduler: idleScheduler,
    timer,
    mintChallenge: () => randomUUID(),
    mintReceipt,
    reaperChannel,
    self: { pid: 5_102, processStartedAtSeconds: 902 },
    onOutcome: (outcome) => guardianOutcomes.push(outcome),
    onProgressViolation: () => {},
  });
  await guardian.listen();
  cleanups.push(() => guardian.close());

  const guardianClient = await connectControlClient(guardianEndpoint, timer, 5_000);
  cleanups.push(() => guardianClient.close());
  const opened = (await guardianClient.call('guardian.open.v1', { bootstrapNonce: SECRET }, 5_000)) as {
    heartbeatChallenge: string;
    controlEpoch: number;
  };
  await guardianClient.call(
    'guardian.heartbeat.v1',
    { controlEpoch: opened.controlEpoch, heartbeatChallenge: opened.heartbeatChallenge },
    5_000,
  );

  return { guardianClient, reaperOutcomes, guardianOutcomes, alive };
}

describe('provider-proxy guardian and reaper', () => {
  it('issues a joint containment receipt only after the reaper stages the same root', async () => {
    const set = await startSet();
    const operationId = randomUUID();

    const staged = (await set.guardianClient.call(
      'guardian.register-provider-root.v1',
      {
        proxy: {
          proxyInstanceId: randomUUID(),
          pid: 6_001,
          processStartedAtSeconds: 800,
          processGroupId: 5_100,
          guardianInstanceId: randomUUID(),
          reaperInstanceId: randomUUID(),
          generation: 'gen2',
          flavor: 'prod',
          buildSetId: randomUUID(),
          hostFingerprint: FINGERPRINT,
          canonicalEndpoint: '/tmp/p.sock',
        },
        operation: { operationId },
        reservationId: randomUUID(),
        activationNonce: randomUUID(),
        providerPid: 6_001,
        providerProcessStartedAtSeconds: 800,
      },
      5_000,
    )) as { state: string; jointContainmentReceipt: string };

    expect(staged.state).toBe('staged-contained');
    expect(staged.jointContainmentReceipt).toMatch(/^receipt-/u);
  });

  it('refuses activation that does not present the joint receipt', async () => {
    const set = await startSet();
    const operationId = randomUUID();

    await expect(
      set.guardianClient.call(
        'guardian.operation-activate.v1',
        {
          operation: { operationId },
          reservationId: randomUUID(),
          activationNonce: randomUUID(),
          providerRoot: { pid: 6_001, processStartedAtSeconds: 800 },
          jointContainmentReceipt: 'forged',
        },
        5_000,
      ),
    ).rejects.toThrow(/unstaged/u);
  });

  it('keeps a released membership recorded so only teardown may conclude absence', async () => {
    const set = await startSet();
    const operationId = randomUUID();
    const proxy = {
      proxyInstanceId: randomUUID(),
      pid: 6_001,
      processStartedAtSeconds: 800,
      processGroupId: 5_100,
      guardianInstanceId: randomUUID(),
      reaperInstanceId: randomUUID(),
      generation: 'gen2' as const,
      flavor: 'prod' as const,
      buildSetId: randomUUID(),
      hostFingerprint: FINGERPRINT,
      canonicalEndpoint: '/tmp/p.sock',
    };
    const reservationId = randomUUID();
    const activationNonce = randomUUID();
    const staged = (await set.guardianClient.call(
      'guardian.register-provider-root.v1',
      {
        proxy,
        operation: { operationId },
        reservationId,
        activationNonce,
        providerPid: 6_001,
        providerProcessStartedAtSeconds: 800,
      },
      5_000,
    )) as { jointContainmentReceipt: string };

    const released = (await set.guardianClient.call(
      'guardian.operation-release.v1',
      {
        operation: { operationId },
        reservationId,
        activationNonce,
        jointContainmentReceipt: staged.jointContainmentReceipt,
      },
      5_000,
    )) as { state: string };
    expect(released.state).toBe('membership-released');

    // The root stays recorded, so teardown still names it rather than assuming release meant absence.
    const reaped = (await set.guardianClient.call('guardian.stop-and-reap.v1', {}, 5_000)) as {
      disappearanceReceipt: string;
    };
    expect(reaped.disappearanceReceipt).toContain('root:6001@800');
  });

  it('reaps the recorded set through stop-and-reap', async () => {
    const set = await startSet();

    const reaped = (await set.guardianClient.call('guardian.stop-and-reap.v1', {}, 5_000)) as {
      state: string;
      disappearanceReceipt: string;
    };

    expect(reaped.state).toBe('containment-absent');
    expect(reaped.disappearanceReceipt).toContain('group:5100');
    expect(set.alive.has(CONTAINMENT.pid)).toBe(false);
  });

  it('refuses a paired call that never presented the pairing secret', async () => {
    const set = await startSet();

    await expect(
      set.guardianClient.call(
        'guardian.register-provider-root.v1',
        { operation: { operationId: randomUUID() } },
        5_000,
      ),
    ).rejects.toThrow();
  });
});
