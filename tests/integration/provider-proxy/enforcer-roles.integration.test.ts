import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import { connectControlClient } from '#src/provider-proxy/control-client.js';
import { createGuardian } from '#src/provider-proxy/guardian.js';
import { createReaper } from '#src/provider-proxy/reaper.js';
import type { EnforcementOutcome, EnforcementScheduler } from '#src/provider-proxy/enforcement.js';

const NONCE = 'a'.repeat(64);
const PAIR_SECRET = 'c'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);
const CONTAINMENT = { pid: 5_100, processStartedAtSeconds: 900, processGroupId: 5_100, containmentKind: 'posix-group' };
const ROOT = { pid: 6_001, processStartedAtSeconds: 800 };

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

type SetUnderTest = Awaited<ReturnType<typeof startSet>>;

async function startSet() {
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
    bootstrapNonce: NONCE,
  };

  const proxyIdentity = {
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
  const guardianIdentity = {
    guardianInstanceId: shared.guardianInstanceId,
    pid: 5_102,
    processStartedAtSeconds: 902,
    generation: shared.generation,
    flavor: shared.flavor,
    buildSetId: shared.buildSetId,
    hostFingerprint: FINGERPRINT,
    canonicalControlEndpoint: guardianEndpoint,
  };
  const reaperIdentity = {
    reaperInstanceId: shared.reaperInstanceId,
    pid: 5_101,
    processStartedAtSeconds: 901,
    guardianInstanceId: shared.guardianInstanceId,
    generation: shared.generation,
    flavor: shared.flavor,
    buildSetId: shared.buildSetId,
    hostFingerprint: FINGERPRINT,
    canonicalControlEndpoint: reaperEndpoint,
    containmentKind: CONTAINMENT.containmentKind,
  };

  const alive = new Set([CONTAINMENT.pid, ROOT.pid]);
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
        for (const target of pid < 0 ? [...alive] : [pid]) alive.delete(target);
        return true;
      },
      isAlive: (pid: number) => (pid < 0 ? alive.has(-pid) : alive.has(pid)),
    },
    platform: 'linux' as const,
    maxRecordedRoots: 128,
    readProcessStartedAtSeconds: (pid: number) =>
      !alive.has(pid)
        ? null
        : pid === CONTAINMENT.pid
          ? CONTAINMENT.processStartedAtSeconds
          : ROOT.processStartedAtSeconds,
  };

  const boundsOf = () => {
    const start = clock.now();
    return {
      lastRoundTripEvidenceAt: start,
      eofAt: null,
      controlLossAt: start,
      adoptionDeadline: clock.shiftMilliseconds(start, 60_000),
      exitDeadline: clock.shiftMilliseconds(start, 74_000),
      firstChallengeExpiresAt: null,
    };
  };
  const accepting = {
    controlIsLive: () => true,
    issueFirstChallenge: () => ({ accepted: true }) as const,
    admitSuccessor: () => ({ accepted: true }) as const,
    echoChallenge: () => ({ accepted: true }) as const,
    observeEof: () => {},
    dispatchOrdinaryFrame: () => ({ accepted: true }) as const,
    latchTeardown: () => {},
    markContainmentAbsent: () => {},
    markExited: () => {},
  };

  let receipts = 0;
  const mintReceipt = () => {
    receipts += 1;
    return `receipt-${receipts}`;
  };
  const reaperOutcomes: EnforcementOutcome[] = [];
  const guardianOutcomes: EnforcementOutcome[] = [];

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
    deadlines: {
      ...accepting,
      bounds: boundsOf,
      state: () => 'accepting-control' as const,
    },
    containment: CONTAINMENT,
    containmentEnvironment,
    scheduler: idleScheduler,
    timer,
    mintChallenge: () => randomUUID(),
    mintReceipt,
    self: { pid: reaperIdentity.pid, processStartedAtSeconds: reaperIdentity.processStartedAtSeconds },
    onOutcome: (outcome) => reaperOutcomes.push(outcome),
    onProgressViolation: () => {},
  });
  await reaper.listen();
  cleanups.push(() => reaper.close());

  // The guardian reaches the reaper over the capsule-authenticated pairing channel, not the coordinator's
  // control connection — staging must work while control is still provisional.
  const reaperChannel = await connectControlClient(reaperEndpoint, timer, 5_000);
  cleanups.push(() => reaperChannel.close());
  await reaperChannel.call('reaper.pair.v1', { pairingSecret: PAIR_SECRET }, 5_000);

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
    deadlines: {
      ...accepting,
      bounds: boundsOf,
      state: () => 'accepting-control' as const,
    },
    containment: CONTAINMENT,
    containmentEnvironment,
    scheduler: idleScheduler,
    timer,
    mintChallenge: () => randomUUID(),
    mintReceipt,
    reaperChannel,
    self: { pid: guardianIdentity.pid, processStartedAtSeconds: guardianIdentity.processStartedAtSeconds },
    onOutcome: (outcome) => guardianOutcomes.push(outcome),
    onProgressViolation: () => {},
  });
  await guardian.listen();
  cleanups.push(() => guardian.close());

  const control = await connectControlClient(guardianEndpoint, timer, 5_000);
  cleanups.push(() => control.close());
  const opened = (await control.call(
    'guardian.open.v1',
    { bootstrapNonce: NONCE, coordinator: coordinatorIdentity, proxy: proxyIdentity },
    5_000,
  )) as { heartbeatChallenge: string; controlEpoch: number; proxy: unknown };
  await control.call(
    'guardian.heartbeat.v1',
    { controlEpoch: opened.controlEpoch, heartbeatChallenge: opened.heartbeatChallenge },
    5_000,
  );

  // The proxy holds the guardian's peer channel on its own connection: it is the only party that knows the
  // real provider pid, which is why root registration lives there rather than on coordinator control.
  const proxyChannel = await connectControlClient(guardianEndpoint, timer, 5_000);
  cleanups.push(() => proxyChannel.close());
  await proxyChannel.call('guardian.pair.v1', { pairingSecret: PAIR_SECRET }, 5_000);

  const operationFor = (): Record<string, string> => ({
    jobId: randomUUID(),
    operationId: randomUUID(),
    proxyInstanceId: shared.proxyInstanceId,
    buildSetId: shared.buildSetId,
  });

  return {
    control,
    proxyChannel,
    proxyIdentity,
    guardianIdentity,
    reaperIdentity,
    operationFor,
    opened,
    reaperOutcomes,
    guardianOutcomes,
    alive,
  };
}

async function stage(
  set: SetUnderTest,
): Promise<{ jointContainmentReceipt: string; operation: Record<string, string> }> {
  const operation = set.operationFor();
  const staged = (await set.proxyChannel.call(
    'guardian.register-provider-root.v1',
    {
      proxy: set.proxyIdentity,
      operation,
      reservationId: randomUUID(),
      activationNonce: randomUUID(),
      providerPid: ROOT.pid,
      providerProcessStartedAtSeconds: ROOT.processStartedAtSeconds,
    },
    5_000,
  )) as { state: string; jointContainmentReceipt: string };
  expect(staged.state).toBe('staged-contained');
  return { jointContainmentReceipt: staged.jointContainmentReceipt, operation };
}

describe('provider-proxy guardian and reaper', () => {
  it('issues a joint containment receipt only after the reaper stages the same root', async () => {
    const set = await startSet();

    const { jointContainmentReceipt } = await stage(set);

    expect(jointContainmentReceipt).toMatch(/^receipt-/u);
  });

  it('serves root registration on the peer channel only, never on coordinator control', async () => {
    const set = await startSet();

    // The coordinator holds active control and still cannot stage a root: the proxy's channel is a separate
    // authority, which is what keeps the two-authority staging rule meaningful.
    await expect(
      set.control.call(
        'guardian.register-provider-root.v1',
        {
          proxy: set.proxyIdentity,
          operation: set.operationFor(),
          reservationId: randomUUID(),
          activationNonce: randomUUID(),
          providerPid: ROOT.pid,
          providerProcessStartedAtSeconds: ROOT.processStartedAtSeconds,
        },
        5_000,
      ),
    ).rejects.toThrow(/paired peer channel/u);
  });

  it('names the proxy it was opened for in the open result', async () => {
    const set = await startSet();

    expect(set.opened.proxy).toEqual(set.proxyIdentity);
  });

  it('refuses an open that omits the documented identities', async () => {
    const set = await startSet();

    await expect(set.control.call('guardian.open.v1', { bootstrapNonce: NONCE }, 5_000)).rejects.toThrow();
  });

  it('refuses activation that does not present the joint receipt', async () => {
    const set = await startSet();

    await expect(
      set.control.call(
        'guardian.operation-activate.v1',
        {
          operation: set.operationFor(),
          reservationId: randomUUID(),
          activationNonce: randomUUID(),
          providerRoot: ROOT,
          jointContainmentReceipt: 'forged',
        },
        5_000,
      ),
    ).rejects.toThrow(/joint containment receipt/u);
  });

  it('keeps a released membership recorded so only teardown may conclude absence', async () => {
    const set = await startSet();
    const { jointContainmentReceipt, operation } = await stage(set);

    const released = (await set.control.call(
      'guardian.operation-release.v1',
      { operation, reservationId: randomUUID(), activationNonce: randomUUID(), jointContainmentReceipt },
      5_000,
    )) as { state: string };
    expect(released.state).toBe('membership-released');

    const reaped = (await set.control.call(
      'guardian.stop-and-reap.v1',
      {
        guardian: set.guardianIdentity,
        reaper: set.reaperIdentity,
        proxy: set.proxyIdentity,
        providerRoots: [ROOT],
      },
      5_000,
    )) as { disappearanceReceipt: string };

    // The root stays recorded, so teardown still names it rather than assuming release meant absence.
    expect(reaped.disappearanceReceipt).toContain(`root:${ROOT.pid}@${ROOT.processStartedAtSeconds}`);
  });

  it('reaps the recorded set through the documented stop-and-reap request', async () => {
    const set = await startSet();

    const reaped = (await set.control.call(
      'guardian.stop-and-reap.v1',
      {
        guardian: set.guardianIdentity,
        reaper: set.reaperIdentity,
        proxy: set.proxyIdentity,
        providerRoots: [],
      },
      5_000,
    )) as { state: string; disappearanceReceipt: string };

    expect(reaped.state).toBe('containment-absent');
    expect(reaped.disappearanceReceipt).toContain(`group:${CONTAINMENT.processGroupId}`);
    expect(set.alive.has(CONTAINMENT.pid)).toBe(false);
  });

  it('refuses a teardown that names a provider-root set the reaper never recorded', async () => {
    const set = await startSet();
    // Reach the reaper directly so its own set-agreement check is the one under test.
    const reaperControl = await connectControlClient(set.reaperIdentity.canonicalControlEndpoint, timer, 5_000);
    cleanups.push(() => reaperControl.close());
    const opened = (await reaperControl.call(
      'reaper.open.v1',
      {
        bootstrapNonce: NONCE,
        coordinator: {
          instanceId: randomUUID(),
          pid: 4_000,
          processStartedAtSeconds: 700,
          generation: 'gen2',
          flavor: 'prod',
          buildSetId: set.reaperIdentity.buildSetId,
        },
        guardian: set.guardianIdentity,
        proxy: set.proxyIdentity,
        containment: CONTAINMENT,
      },
      5_000,
    )) as { controlEpoch: number; heartbeatChallenge: string };
    await reaperControl.call(
      'reaper.heartbeat.v1',
      { controlEpoch: opened.controlEpoch, heartbeatChallenge: opened.heartbeatChallenge },
      5_000,
    );

    await expect(
      reaperControl.call(
        'reaper.stop-and-reap.v1',
        {
          reaper: set.reaperIdentity,
          proxy: set.proxyIdentity,
          providerRoots: [{ pid: 9_999, processStartedAtSeconds: 1 }],
        },
        5_000,
      ),
    ).rejects.toThrow(/different provider-root set/u);
  });
});
