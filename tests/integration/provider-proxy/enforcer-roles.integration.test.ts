import { createDeferred } from '#tools/testing/deferred.js';
import type { ProcessLiveness } from '#src/infra/node-process.js';
import { strictControlExchangeResult as strictTestExchange } from '#tests/support/control-exchange.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import type { RecordedProcessIdentity } from '#src/infra/process-containment.js';
import { connectControlClient, type ControlClient } from '#src/provider-proxy/control-client.js';
import { createGuardian } from '#src/provider-proxy/guardian.js';
import { createReaper } from '#src/provider-proxy/reaper.js';
import { createControlHolderAuthority } from '#src/provider-proxy/holder-lifecycle.js';
import { type EnforcementOutcome, type EnforcementScheduler } from '#src/provider-proxy/enforcement.js';
import { reaperHandoffRotateResultSchema } from '#src/coordinator/live/provider-proxy/control-redemption.js';

const NONCE = 'a'.repeat(64);
const PAIR_SECRET = 'c'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);
const CONTAINMENT = {
  pid: 5_100,
  incarnation: testIncarnation(900),
  processGroupId: 5_100,
  containmentKind: 'posix-group',
};
const ROOT = { pid: 6_001, incarnation: testIncarnation(800) };

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

async function startSet(beforeRootRegistration: () => Promise<void> = async () => {}) {
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
    incarnation: testIncarnation(850),
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
    incarnation: testIncarnation(700),
    generation: shared.generation,
    flavor: shared.flavor,
    buildSetId: shared.buildSetId,
  };
  const guardianIdentity = {
    guardianInstanceId: shared.guardianInstanceId,
    pid: 5_102,
    incarnation: testIncarnation(902),
    generation: shared.generation,
    flavor: shared.flavor,
    buildSetId: shared.buildSetId,
    hostFingerprint: FINGERPRINT,
    canonicalControlEndpoint: guardianEndpoint,
  };
  const reaperIdentity = {
    reaperInstanceId: shared.reaperInstanceId,
    pid: 5_101,
    incarnation: testIncarnation(901),
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
      observeLiveness: (pid: number) =>
        ((pid < 0 ? alive.has(-pid) : alive.has(pid)) ? 'alive' : 'absent') as ProcessLiveness,
      observeRecordedProcessAsync: async (identity: RecordedProcessIdentity) => {
        if (!alive.has(identity.pid)) return 'absent';
        const incarnation = identity.pid === CONTAINMENT.pid ? CONTAINMENT.incarnation : ROOT.incarnation;
        return incarnation === identity.incarnation ? 'alive' : 'absent';
      },
    },
    platform: 'linux' as const,
    maxRecordedRoots: 128,
    readProcessIncarnation: (pid: number) =>
      !alive.has(pid) ? null : pid === CONTAINMENT.pid ? CONTAINMENT.incarnation : ROOT.incarnation,
  };

  const boundsOf = () => {
    const start = clock.now();
    return {
      lastRoundTripEvidenceAt: start,
      eofAt: null,
      controlLossAt: start,
      adoptionDeadline: clock.shiftMilliseconds(start, 60_000),
      exitDeadline: clock.shiftMilliseconds(start, 74_000),
      holderCheckAt: clock.shiftMilliseconds(start, 60_000),
      holderCheckAccelerated: false,
    };
  };
  // Each role must retain an independent holder authority.
  const guardianHolderAuthority = createControlHolderAuthority();
  const reaperHolderAuthority = createControlHolderAuthority();
  const observeHolder = (): Promise<ProcessLiveness> => Promise.resolve('unknown' as const);
  let controlLive = true;
  let challengeCount = 0;
  const mintRoleChallenge = (): string => {
    challengeCount += 1;
    return `roles-challenge-${challengeCount}`;
  };
  const accepting = {
    orphanTimeoutMs: () => 30_000,
    controlIsLive: () => controlLive,
    issueFirstChallenge: () => ({ accepted: true, challenge: mintRoleChallenge() }) as const,
    admitSuccessor: () => ({ accepted: true, challenge: mintRoleChallenge() }) as const,
    reattachControl: () => ({ accepted: true }) as const,
    echoChallenge: () => {
      controlLive = true;
      return { accepted: true, nextChallenge: mintRoleChallenge() } as const;
    },
    observeEof: () => {},
    observePairingLoss: () => {},
    latchTeardown: () => {},
    markContainmentAbsent: () => {},
    markExited: () => {},
    renewHolderCheck: () => {},
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
    containmentEnvironment,
    scheduler: idleScheduler,
    timer,
    mintReceipt,
    self: { pid: reaperIdentity.pid, incarnation: reaperIdentity.incarnation },
    holderAuthority: reaperHolderAuthority,
    observeHolder,
    abandonUnattributable: () => false,
    onOutcome: (outcome) => reaperOutcomes.push(outcome),
    onProgressViolation: () => {},
  });
  await reaper.listen();
  cleanups.push(() => reaper.close());

  // The guardian reaches the reaper over the capsule-authenticated pairing channel, not the coordinator's
  // control connection — staging must work while control is still provisional.
  const reaperChannel = await connectControlClient(reaperEndpoint, timer, 5_000);
  cleanups.push(() => reaperChannel.close());
  await strictTestExchange(reaperChannel, 'reaper.pair.v1', { pairingSecret: PAIR_SECRET }, 5_000);
  // The guardian names the containment it watched being created. Until it does, the reaper holds nothing and
  // arms nothing — there is no identity for it to enforce.
  await strictTestExchange(reaperChannel, 'reaper.record-containment.v1', CONTAINMENT, 5_000);

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
    containmentEnvironment,
    scheduler: idleScheduler,
    timer,
    mintReceipt,
    reaperChannel: {
      ...reaperChannel,
      exchange: async (method, params, timeoutMs) => {
        if (method === 'reaper.register-provider-root.v1') await beforeRootRegistration();
        return reaperChannel.exchange(method, params, timeoutMs);
      },
    },
    self: { pid: guardianIdentity.pid, incarnation: guardianIdentity.incarnation },
    reaperSelf: { pid: reaperIdentity.pid, incarnation: reaperIdentity.incarnation },
    holderAuthority: guardianHolderAuthority,
    observeHolder,
    abandonUnattributable: () => false,
    onOutcome: (outcome) => guardianOutcomes.push(outcome),
    onProgressViolation: () => {},
  });
  await guardian.listen();
  cleanups.push(() => guardian.close());
  await guardian.recordContainment(CONTAINMENT);
  const control = await connectControlClient(guardianEndpoint, timer, 5_000);
  cleanups.push(() => control.close());
  const opened = (await strictTestExchange(
    control,
    'guardian.open.v1',
    { bootstrapNonce: NONCE, coordinator: coordinatorIdentity, proxy: proxyIdentity },
    5_000,
  )) as { heartbeatChallenge: string; controlEpoch: number };
  await strictTestExchange(
    control,
    'guardian.heartbeat.v1',
    { controlEpoch: opened.controlEpoch, heartbeatChallenge: opened.heartbeatChallenge },
    5_000,
  );

  // The proxy holds the guardian's peer channel on its own connection: it is the only party that knows the
  // real provider pid, which is why root registration lives there rather than on coordinator control.
  const proxyChannel = await connectControlClient(guardianEndpoint, timer, 5_000);
  cleanups.push(() => proxyChannel.close());
  await strictTestExchange(proxyChannel, 'guardian.pair.v1', { pairingSecret: PAIR_SECRET }, 5_000);

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
    coordinatorIdentity,
    guardianEndpoint,
    operationFor,
    opened,
    reaperOutcomes,
    guardianOutcomes,
    alive,
    // Exposed for tests that assert directly on the in-process reaper's/guardian's own recorded state — the
    // wire protocol has no read query for either, and none should exist merely to serve a test.
    reaper,
    guardian,
    // The guardian's own pairing channel to the reaper: the reaper accepts exactly one paired peer, and the
    // guardian already holds it, so a test driving `reaper.*` pairing methods directly must reuse this one.
    reaperChannel,
    // The reaper's own control socket, for a test that opens direct coordinator control on it (its bootstrap
    // nonce is otherwise unspent by this helper — only the guardian's is used above).
    reaperEndpoint,
    /** Ends the incumbent's control the way a lapsed lease does, leaving its socket alone. */
    lapseControl: () => {
      controlLive = false;
    },
  };
}

const GRANT_SECRET = 'f'.repeat(64);

/** Installs one grant over active control and returns the request a successor would redeem it with — the
 *  credential and identity alone: a redeemer never presents the operation set, so it is not part of what this
 *  returns (see `handoff-capsule.ts`'s `GrantRegistry.redeem` doc for why). */
async function installGrant(
  set: SetUnderTest,
  operations: ReadonlyArray<Record<string, string>>,
  control: ControlClient = set.control,
): Promise<Record<string, unknown>> {
  const grantId = randomUUID();
  const handoffOperations = [...operations].sort((left, right) => (left.operationId < right.operationId ? -1 : 1));

  const installed = (await strictTestExchange(
    control,
    'guardian.handoff-install.v1',
    {
      grantId,
      secretSha256: createHash('sha256').update(GRANT_SECRET, 'utf8').digest('hex'),
      successor: set.coordinatorIdentity,
      operations: handoffOperations,
      orphanTimeoutMs: 30_000,
      teardownReserveMs: 14_000,
    },
    5_000,
  )) as { state: string; grantId: string };
  expect(installed).toEqual({ state: 'installed-dormant', grantId });

  return { grantId, secret: GRANT_SECRET, successor: set.coordinatorIdentity };
}

/** Opens direct coordinator control on the reaper's own socket — a separate tenancy from the guardian's
 *  `set.control`, exactly as production's `establishControl` opens all three roles independently. */
async function openReaperControl(set: SetUnderTest): Promise<ControlClient> {
  const control = await connectControlClient(set.reaperEndpoint, timer, 5_000);
  cleanups.push(() => control.close());
  const opened = (await strictTestExchange(
    control,
    'reaper.open.v1',
    {
      bootstrapNonce: NONCE,
      coordinator: set.coordinatorIdentity,
      guardian: set.guardianIdentity,
      proxy: set.proxyIdentity,
      containment: CONTAINMENT,
    },
    5_000,
  )) as { heartbeatChallenge: string; controlEpoch: number };
  await strictTestExchange(
    control,
    'reaper.heartbeat.v1',
    { controlEpoch: opened.controlEpoch, heartbeatChallenge: opened.heartbeatChallenge },
    5_000,
  );
  return control;
}

async function stage(set: SetUnderTest): Promise<{
  jointContainmentReceipt: string;
  operation: Record<string, string>;
  reservation: string;
}> {
  const operation = set.operationFor();
  const reservation = randomUUID();
  const staged = (await strictTestExchange(
    set.proxyChannel,
    'guardian.register-provider-root.v1',
    {
      proxy: set.proxyIdentity,
      operation,
      reservation,
      providerPid: ROOT.pid,
      providerIncarnation: ROOT.incarnation,
    },
    5_000,
  )) as { state: string; jointContainmentReceipt: string };
  expect(staged.state).toBe('staged-contained');
  return { jointContainmentReceipt: staged.jointContainmentReceipt, operation, reservation };
}

describe('provider-proxy guardian and reaper', () => {
  it('issues a joint containment receipt only after the reaper stages the same root', async () => {
    const reachedReaper = createDeferred<void>();
    const releaseReaper = createDeferred<void>();
    const set = await startSet(async () => {
      reachedReaper.resolve();
      await releaseReaper.promise;
    });
    let receivedReceipt = false;
    const staging = stage(set).then((result) => {
      receivedReceipt = true;
      return result;
    });
    await reachedReaper.promise;
    try {
      expect(set.reaper.enforcer()?.recordedRoots()).not.toContainEqual(ROOT);
      expect(receivedReceipt).toBe(false);
    } finally {
      releaseReaper.resolve();
      await staging;
    }
    const { jointContainmentReceipt } = await staging;
    expect(set.reaper.enforcer()?.recordedRoots()).toContainEqual(ROOT);
    expect(jointContainmentReceipt).toMatch(/^receipt-/u);
  });

  it('rotates reaper control once the guardian forwards the redemption receipt over the paired channel', async () => {
    const set = await startSet();
    const { operation } = await stage(set);
    const request = await installGrant(set, [operation]);
    const reaperControl = await openReaperControl(set);
    // The grant is dormant while the incumbent holds control; loss is what makes it redeemable.
    set.lapseControl();
    set.control.close();
    reaperControl.close();

    const successorGuardian = await connectControlClient(set.guardianEndpoint, timer, 5_000);
    cleanups.push(() => successorGuardian.close());
    const redeemed = (await strictTestExchange(successorGuardian, 'guardian.handoff-redeem.v1', request, 5_000)) as {
      redemptionReceipt: string;
    };

    // Only the guardian ever forwarded this reaper the fact that a redemption happened — the receipt below
    // is that push's evidence, not a value this successor derives from the grant itself.
    const successorReaper = await connectControlClient(set.reaperEndpoint, timer, 5_000);
    cleanups.push(() => successorReaper.close());
    const rotated = (await strictTestExchange(
      successorReaper,
      'reaper.handoff-rotate.v1',
      {
        grantId: request.grantId,
        successor: set.coordinatorIdentity,
        guardianRedemptionReceipt: redeemed.redemptionReceipt,
      },
      5_000,
    )) as {
      state: string;
      reaperRotationReceipt: string;
      controlEpoch: number;
      operations: Record<string, string>[];
      heartbeatChallenge: string;
    };

    expect(rotated.state).toBe('successor-rotated');
    expect(reaperHandoffRotateResultSchema.parse(rotated).reaper).toEqual(set.reaperIdentity);
    // This reaper never received the set from the rotation request (there is no `operations` field to send)
    // — it comes back from the guardian's own authoritative forward, recorded earlier by
    // `reaper.record-redemption.v1`.
    expect(rotated.operations).toEqual([operation]);
    expect(rotated.controlEpoch).toBe(2);
    const beat = (await strictTestExchange(
      successorReaper,
      'reaper.heartbeat.v1',
      { controlEpoch: rotated.controlEpoch, heartbeatChallenge: rotated.heartbeatChallenge },
      5_000,
    )) as { state: string };
    expect(beat.state).toBe('active');
  });
});
