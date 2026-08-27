import type { ProcessLiveness } from '#src/infra/node-process.js';
import { strictControlExchangeResult as strictTestExchange } from '#tests/support/control-exchange.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createMonotonicClock, type MonotonicClock } from '#src/infra/monotonic-clock.js';
import { createProviderProxySetAuthority } from '#src/coordinator/live/provider-proxy/set-authority.js';
import { LocalOperationRegistry } from '#src/coordinator/services/operation-registry.js';
import { providerOperationRecordSchema } from '#src/store/provider-operation-record.js';
import type { Runtime } from '#src/runtime/ports.js';
import {
  connectControlClient,
  controlExchangeForTest,
  type ControlClient,
} from '#src/provider-proxy/control-client.js';
import { createGuardian } from '#src/provider-proxy/guardian.js';
import { createReaper, type Reaper } from '#src/provider-proxy/reaper.js';
import {
  MAX_PROXY_RECORDED_PROVIDER_ROOTS,
  type EnforcementOutcome,
  type EnforcementScheduler,
} from '#src/provider-proxy/enforcement.js';
import { MAX_PROXY_OPERATION_LEDGERS } from '#src/provider-proxy/ledger.js';
import {
  guardianHandoffRedeemResultSchema,
  reaperHandoffRotateResultSchema,
} from '#src/coordinator/services/provider-proxy-set/inheritance.js';
import {
  createEnforcerDeadlineStateMachine,
  PROXY_ENFORCER_MAX_WAKE_LATENCY_MS,
  resolveProviderProxyDeadlineConfiguration,
  type EnforcerDeadlineStateMachine,
} from '#src/provider-proxy/orphan-deadline.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

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

async function startSet(options: { recordContainment?: boolean } = {}) {
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
    };
  };
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
    reaperChannel,
    self: { pid: guardianIdentity.pid, incarnation: guardianIdentity.incarnation },
    reaperSelf: { pid: reaperIdentity.pid, incarnation: reaperIdentity.incarnation },
    onOutcome: (outcome) => guardianOutcomes.push(outcome),
    onProgressViolation: () => {},
  });
  await guardian.listen();
  cleanups.push(() => guardian.close());
  // The guardian must already be listening before the proxy it will contain even exists, so recording the
  // containment is a step after `listen()`, not part of construction — mirroring the reaper's own
  // `reaper.record-containment.v1`. Tests covering the window before this call pass `recordContainment: false`.
  if (options.recordContainment ?? true) {
    await guardian.recordContainment(CONTAINMENT);
  }

  // `guardian.open.v1` now refuses while no containment is recorded (mirroring `reaper.open.v1`), so a set
  // built with `recordContainment: false` cannot open control at all. Neither test using that option reaches
  // into `control`/`opened` — they exercise the window before containment exists through `guardian` and
  // `proxyChannel` (pairing, a separate authority) instead — so both are a throw-on-touch placeholder rather
  // than a real connection, making an accidental future use fail loudly instead of hanging on a refused open.
  const unreachableBeforeContainment = <T extends object>(what: string): T =>
    new Proxy({} as T, {
      get(): never {
        throw new Error(`${what} is unavailable: guardian.open.v1 refuses while no containment is recorded.`);
      },
    });
  let control: ControlClient;
  let opened: { heartbeatChallenge: string; controlEpoch: number; proxy: unknown };
  if (options.recordContainment ?? true) {
    control = await connectControlClient(guardianEndpoint, timer, 5_000);
    cleanups.push(() => control.close());
    opened = (await strictTestExchange(
      control,
      'guardian.open.v1',
      { bootstrapNonce: NONCE, coordinator: coordinatorIdentity, proxy: proxyIdentity },
      5_000,
    )) as { heartbeatChallenge: string; controlEpoch: number; proxy: unknown };
    await strictTestExchange(
      control,
      'guardian.heartbeat.v1',
      { controlEpoch: opened.controlEpoch, heartbeatChallenge: opened.heartbeatChallenge },
      5_000,
    );
  } else {
    control = unreachableBeforeContainment('set.control');
    opened = unreachableBeforeContainment('set.opened');
  }

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
): Promise<Record<string, unknown>> {
  const grantId = randomUUID();
  const handoffOperations = [...operations].sort((left, right) => (left.operationId < right.operationId ? -1 : 1));

  const installed = (await strictTestExchange(
    set.control,
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

type BareSharedIdentity = Readonly<{
  generation: 'gen2';
  flavor: 'prod';
  buildSetId: string;
  hostFingerprint: string;
  guardianInstanceId: string;
  reaperInstanceId: string;
  proxyInstanceId: string;
  bootstrapNonce: string;
}>;

/** A fresh build/instance identity set for a reaper driven directly, with no guardian or proxy alongside it. */
function bareSharedIdentity(): BareSharedIdentity {
  return {
    generation: 'gen2',
    flavor: 'prod',
    buildSetId: randomUUID(),
    hostFingerprint: FINGERPRINT,
    guardianInstanceId: randomUUID(),
    reaperInstanceId: randomUUID(),
    proxyInstanceId: randomUUID(),
    bootstrapNonce: NONCE,
  };
}

/** The `reaper.open.v1` request an authentic coordinator would send for `CONTAINMENT`. Rebuildable per call. */
function bareOpenRequest(directory: string, shared: BareSharedIdentity): Record<string, unknown> {
  return {
    bootstrapNonce: NONCE,
    coordinator: {
      instanceId: randomUUID(),
      pid: 4_000,
      incarnation: testIncarnation(700),
      generation: shared.generation,
      flavor: shared.flavor,
      buildSetId: shared.buildSetId,
    },
    guardian: {
      guardianInstanceId: shared.guardianInstanceId,
      pid: 5_102,
      incarnation: testIncarnation(902),
      generation: shared.generation,
      flavor: shared.flavor,
      buildSetId: shared.buildSetId,
      hostFingerprint: FINGERPRINT,
      canonicalControlEndpoint: join(directory, 'g.sock'),
    },
    proxy: {
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
      canonicalEndpoint: join(directory, 'p.sock'),
    },
    containment: CONTAINMENT,
  };
}

/** A deadline machine that never itself refuses, for tests driving one reaper's raw protocol directly. */
function bareDeadlines<Scope extends symbol>(clock: MonotonicClock<Scope>): EnforcerDeadlineStateMachine<Scope> {
  let challengeCount = 0;
  const mintChallenge = (): string => {
    challengeCount += 1;
    return `bare-challenge-${challengeCount}`;
  };
  return {
    orphanTimeoutMs: () => 30_000,
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
    bounds: () => ({
      lastRoundTripEvidenceAt: clock.now(),
      eofAt: null,
      controlLossAt: clock.now(),
      adoptionDeadline: clock.shiftMilliseconds(clock.now(), 60_000),
      exitDeadline: clock.shiftMilliseconds(clock.now(), 74_000),
    }),
    state: () => 'accepting-control' as const,
  };
}

/** A reaper with no guardian or coordinator wired up yet, for tests that drive its raw protocol directly. */
async function startBareReaper<Scope extends symbol>(
  directory: string,
  shared: BareSharedIdentity,
  clock: MonotonicClock<Scope>,
  deadlines: EnforcerDeadlineStateMachine<Scope>,
): Promise<{ reaperEndpoint: string; reaper: Reaper<Scope> }> {
  const reaperEndpoint = join(directory, 'r.sock');
  const reaper = createReaper({
    capsule: {
      role: 'reaper',
      ...shared,
      canonicalControlEndpoint: reaperEndpoint,
      guardianControlEndpoint: join(directory, 'g.sock'),
      proxyEndpoint: join(directory, 'p.sock'),
      guardianReaperAuthSecret: PAIR_SECRET,
    },
    clock,
    deadlines,
    containmentEnvironment: {
      clock,
      process: { kill: () => true, observeLiveness: () => 'alive' as const },
      platform: 'linux' as const,
      maxRecordedRoots: 128,
      readProcessIncarnation: () => CONTAINMENT.incarnation,
    },
    scheduler: idleScheduler,
    timer,
    mintReceipt: () => randomUUID(),
    self: { pid: 5_101, incarnation: testIncarnation(901) },
    onOutcome: () => {},
    onProgressViolation: () => {},
  });
  await reaper.listen();
  return { reaperEndpoint, reaper };
}

describe('provider-proxy guardian and reaper', () => {
  it('issues a joint containment receipt only after the reaper stages the same root', async () => {
    const set = await startSet();

    const { jointContainmentReceipt } = await stage(set);

    expect(jointContainmentReceipt).toMatch(/^receipt-/u);
  });

  it('refuses guardian.register-provider-root.v1 naming a proxy instance that is not this guardian’s own', async () => {
    const set = await startSet();

    // The paired channel is proxy-authenticated only by its pairing secret, not by proxy identity — a caller
    // presenting some other proxy's instance id must be refused rather than staging a root against it.
    await expect(
      strictTestExchange(
        set.proxyChannel,
        'guardian.register-provider-root.v1',
        {
          proxy: { ...set.proxyIdentity, proxyInstanceId: randomUUID() },
          operation: set.operationFor(),
          reservation: randomUUID(),
          providerPid: ROOT.pid,
          providerIncarnation: ROOT.incarnation,
        },
        5_000,
      ),
    ).rejects.toThrow(/does not match this guardian/u);
  });

  it('serves root registration on the peer channel only, never on coordinator control', async () => {
    const set = await startSet();

    // The coordinator holds active control and still cannot stage a root: the proxy's channel is a separate
    // authority, which is what keeps the two-authority staging rule meaningful.
    await expect(
      strictTestExchange(
        set.control,
        'guardian.register-provider-root.v1',
        {
          proxy: set.proxyIdentity,
          operation: set.operationFor(),
          reservation: randomUUID(),
          providerPid: ROOT.pid,
          providerIncarnation: ROOT.incarnation,
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

    await expect(
      strictTestExchange(set.control, 'guardian.open.v1', { bootstrapNonce: NONCE }, 5_000),
    ).rejects.toMatchObject({ remoteFailure: { protocolCode: 'protocol_violation' } });
  });

  it('refuses activation that does not present the joint receipt', async () => {
    const set = await startSet();

    await expect(
      strictTestExchange(
        set.control,
        'guardian.operation-activate.v1',
        {
          operation: set.operationFor(),
          reservation: randomUUID(),
          providerRoot: ROOT,
          jointContainmentReceipt: 'forged',
        },
        5_000,
      ),
    ).rejects.toThrow(/joint containment receipt/u);
  });

  it('holds nothing until the guardian itself records the containment it watched being created', async () => {
    const set = await startSet({ recordContainment: false });

    // An enforcer without a containment could only ever confirm the absence of nothing, so there is none —
    // the same guarantee the reaper makes before `reaper.record-containment.v1`.
    expect(set.guardian.enforcer()).toBeNull();
  });

  it('refuses guardian.register-provider-root.v1 with a typed protocol error while no containment is recorded', async () => {
    const set = await startSet({ recordContainment: false });

    // The whole reason the guardian loses its constructor containment is that it must be listening before
    // the proxy it will contain even exists — so this window is real behaviour, not an edge case, and the
    // refusal in it must be the closed protocol vocabulary, not whatever the catch-all maps an uncaught throw to.
    await expect(
      strictTestExchange(
        set.proxyChannel,
        'guardian.register-provider-root.v1',
        {
          proxy: set.proxyIdentity,
          operation: set.operationFor(),
          reservation: randomUUID(),
          providerPid: ROOT.pid,
          providerIncarnation: ROOT.incarnation,
        },
        5_000,
      ),
    ).rejects.toMatchObject({ remoteFailure: { protocolCode: 'invalid_state' } });
  });

  // `guardian.stop-and-reap.v1` still refuses via its own `requireEnforcer()` while no containment is
  // recorded (unchanged), but that state is no longer reachable through active control at all: control
  // cannot open in the first place without a recorded containment (see the `guardian.open.v1` test below),
  // and `stop-and-reap.v1` is an `authority: 'active'` method — reachable only once open already succeeded,
  // which by then guarantees containment is recorded. The equivalent guarantee for a method reachable
  // without active control (`authority: 'pairing'`) is still exercised directly, above.

  it('refuses guardian.open.v1 while no containment is recorded, and the nonce survives for a later successful open', async () => {
    const set = await startSet({ recordContainment: false });

    // Mirrors `reaper.open.v1` exactly, including the ordering: readiness is checked before the one-shot
    // bootstrap nonce is spent, so a retryable race between this open and `recordContainment` cannot burn a
    // credential that can never be reissued.
    const firstAttempt = await connectControlClient(set.guardianEndpoint, timer, 5_000);
    cleanups.push(() => firstAttempt.close());
    await expect(
      strictTestExchange(
        firstAttempt,
        'guardian.open.v1',
        { bootstrapNonce: NONCE, coordinator: set.coordinatorIdentity, proxy: set.proxyIdentity },
        5_000,
      ),
    ).rejects.toMatchObject({ remoteFailure: { protocolCode: 'invalid_state' } });

    await set.guardian.recordContainment(CONTAINMENT);

    // The same nonce the refusal above did not spend still opens control now that this guardian actually
    // holds something to enforce.
    const secondAttempt = await connectControlClient(set.guardianEndpoint, timer, 5_000);
    cleanups.push(() => secondAttempt.close());
    const opened = (await strictTestExchange(
      secondAttempt,
      'guardian.open.v1',
      { bootstrapNonce: NONCE, coordinator: set.coordinatorIdentity, proxy: set.proxyIdentity },
      5_000,
    )) as { controlEpoch: number };
    expect(opened.controlEpoch).toBe(1);
  });

  it('arms its own enforcer on the observed containment even when the forward to the reaper fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'coral-arm-before-forward-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const shared = bareSharedIdentity();
    const clock = createMonotonicClock(Symbol('arm-before-forward'), { readMilliseconds: () => 0n });
    const containmentEnvironment = {
      clock,
      process: { kill: () => true, observeLiveness: () => 'alive' as const },
      platform: 'linux' as const,
      maxRecordedRoots: 128,
      readProcessIncarnation: () => CONTAINMENT.incarnation,
    };
    // The peer this guardian is the *origin* for, not a relay of: the forward below always fails, standing
    // in for a reaper that is unreachable (crashed, network partition, anything short of a normal reply).
    const unreachableReaperChannel = {
      exchange: async (): Promise<never> => {
        throw new Error('reaper unreachable');
      },
      faulted: new Promise<never>(() => undefined),
      onFault: () => () => undefined,
      close: (): void => {},
    };
    const guardian = createGuardian({
      capsule: {
        role: 'guardian',
        ...shared,
        canonicalControlEndpoint: join(directory, 'g.sock'),
        reaperControlEndpoint: join(directory, 'r.sock'),
        proxyEndpoint: join(directory, 'p.sock'),
        guardianReaperAuthSecret: PAIR_SECRET,
        proxyGuardianAuthSecret: PAIR_SECRET,
      },
      clock,
      deadlines: bareDeadlines(clock),
      containmentEnvironment,
      scheduler: idleScheduler,
      timer,
      mintReceipt: () => 'receipt-arm-before-forward',
      reaperChannel: unreachableReaperChannel,
      self: { pid: 5_102, incarnation: testIncarnation(902) },
      reaperSelf: { pid: 5_101, incarnation: testIncarnation(901) },
      onOutcome: () => {},
      onProgressViolation: () => {},
    });
    cleanups.push(() => guardian.close());

    await expect(guardian.recordContainment(CONTAINMENT)).rejects.toThrow(/reaper unreachable/u);

    // BLOCKING 1: the guardian is the party that watched this exact group come into being — it must hold
    // what it saw regardless of whether the reaper ever learned it. The old ordering forwarded first, so a
    // failed forward left neither party holding the proxy: no enforcer here, and nothing armed on the peer
    // either, for a live detached process-group leader that nothing could ever reap.
    expect(guardian.enforcer()).not.toBeNull();
  });

  it('re-records an identical containment idempotently and refuses a mismatched one', async () => {
    const set = await startSet();

    // `startSet()` already recorded `CONTAINMENT` once; the identical value again must be a no-op, not a
    // second commitment that could silently move what this guardian holds.
    await expect(set.guardian.recordContainment(CONTAINMENT)).resolves.toBeUndefined();
    await expect(set.guardian.recordContainment({ ...CONTAINMENT, processGroupId: 9_999 })).rejects.toThrow(
      /already holds a containment/u,
    );
  });

  it('never exhausts the reaper across many prepare-then-release cycles for the same provider root', async () => {
    const set = await startSet();

    // Well past MAX_PROXY_OPERATION_LEDGERS: the defect capped registrations by operation count, so this
    // loop would have leaked one reaper slot per cycle and failed near iteration 128 under the old code.
    const cycles = MAX_PROXY_OPERATION_LEDGERS + 40;
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      const { operation, reservation } = await stage(set);
      const released = (await strictTestExchange(
        set.proxyChannel,
        'guardian.operation-release.v1',
        { proxy: set.proxyIdentity, operation, reservation },
        5_000,
      )) as { state: string };
      expect(released.state).toBe('membership-released');
    }

    // The reaper's unit of account is the provider root: every cycle re-presented the same one, so exactly
    // one is ever recorded no matter how many operations came and went.
    expect(set.reaper.enforcer()?.recordedRoots()).toEqual([ROOT]);
  });

  it('lets a retried guardian.operation-activate.v1 succeed rather than being refused by the reaper', async () => {
    const set = await startSet();
    const { jointContainmentReceipt, operation, reservation } = await stage(set);
    const activate = () =>
      strictTestExchange(
        set.control,
        'guardian.operation-activate.v1',
        { operation, reservation, providerRoot: ROOT, jointContainmentReceipt },
        5_000,
      ) as Promise<{ state: string }>;

    const first = await activate();
    expect(first.state).toBe('activation-authorized');

    // A retry presents the exact identity that already succeeded. The old reaper deleted its staging entry
    // on the first activation, so this would be refused rather than repeated.
    const retried = await activate();
    expect(retried.state).toBe('activation-authorized');
  });

  it('refuses guardian.operation-activate.v1 presenting a different reservation for a known operation', async () => {
    const set = await startSet();
    const { jointContainmentReceipt, operation } = await stage(set);

    await expect(
      strictTestExchange(
        set.control,
        'guardian.operation-activate.v1',
        {
          operation,
          reservation: randomUUID(),
          providerRoot: ROOT,
          jointContainmentReceipt,
        },
        5_000,
      ),
    ).rejects.toThrow(/different reservation/u);
  });

  it('refuses guardian.operation-activate.v1 presenting a different provider root than the one staged', async () => {
    const set = await startSet();
    const { jointContainmentReceipt, operation, reservation } = await stage(set);

    await expect(
      strictTestExchange(
        set.control,
        'guardian.operation-activate.v1',
        {
          operation,
          reservation,
          providerRoot: { pid: ROOT.pid + 1, incarnation: ROOT.incarnation },
          jointContainmentReceipt,
        },
        5_000,
      ),
    ).rejects.toThrow(/different provider root/u);
  });

  it('refuses guardian.operation-release.v1 presenting a different reservation for a known operation', async () => {
    const set = await startSet();
    const { operation } = await stage(set);

    await expect(
      strictTestExchange(
        set.proxyChannel,
        'guardian.operation-release.v1',
        { proxy: set.proxyIdentity, operation, reservation: randomUUID() },
        5_000,
      ),
    ).rejects.toThrow(/different reservation/u);
  });

  it('refuses reaper.confirm-provider-root.v1 for a root the reaper never recorded', async () => {
    // The reaper accepts exactly one paired peer, and the guardian already holds it — reuse that channel
    // rather than opening a second one, which the reaper would refuse outright.
    const set = await startSet();

    await expect(
      strictTestExchange(set.reaperChannel, 'reaper.confirm-provider-root.v1', { providerRoot: ROOT }, 5_000),
    ).rejects.toThrow(/never recorded/u);
  });

  it('strictly rejects unknown fields on every guardian-to-reaper request family', async () => {
    const set = await startSet();
    const calls: Array<() => Promise<unknown>> = [
      () =>
        strictTestExchange(
          set.reaperChannel,
          'reaper.record-containment.v1',
          { ...CONTAINMENT, unexpected: true },
          5_000,
        ),
      () =>
        strictTestExchange(
          set.reaperChannel,
          'reaper.register-provider-root.v1',
          { providerRoot: ROOT, unexpected: true },
          5_000,
        ),
      () =>
        strictTestExchange(
          set.reaperChannel,
          'reaper.confirm-provider-root.v1',
          { providerRoot: ROOT, unexpected: true },
          5_000,
        ),
      () =>
        strictTestExchange(
          set.reaperChannel,
          'reaper.record-redemption.v1',
          {
            grantId: randomUUID(),
            successor: set.coordinatorIdentity,
            operations: [],
            redemptionReceipt: 'redemption-receipt',
            unexpected: true,
          },
          5_000,
        ),
    ];

    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ remoteFailure: { protocolCode: 'protocol_violation' } });
    }
  });

  it('translates an EnforcementError from the root cap into a closed-set protocol code, not the catch-all', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'coral-root-cap-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const shared = bareSharedIdentity();
    const clock = createMonotonicClock(Symbol('root-cap'), { readMilliseconds: () => 0n });
    const { reaperEndpoint, reaper } = await startBareReaper(directory, shared, clock, bareDeadlines(clock));
    cleanups.push(() => reaper.close());

    const pairing = await connectControlClient(reaperEndpoint, timer, 5_000);
    cleanups.push(() => pairing.close());
    await strictTestExchange(pairing, 'reaper.pair.v1', { pairingSecret: PAIR_SECRET }, 5_000);
    await strictTestExchange(pairing, 'reaper.record-containment.v1', CONTAINMENT, 5_000);

    for (let index = 0; index < MAX_PROXY_RECORDED_PROVIDER_ROOTS; index += 1) {
      await strictTestExchange(
        pairing,
        'reaper.register-provider-root.v1',
        { providerRoot: { pid: 20_000 + index, incarnation: testIncarnation(1) } },
        5_000,
      );
    }

    await expect(
      strictTestExchange(
        pairing,
        'reaper.register-provider-root.v1',
        { providerRoot: { pid: 999_999, incarnation: testIncarnation(1) } },
        5_000,
      ),
      // The rejection is a `ControlClientError` carrying the server's closed-set code in `remoteFailure`;
      // the pre-fix behavior let `EnforcementError` escape untranslated, which reads as `protocol_violation`.
    ).rejects.toMatchObject({ remoteFailure: { protocolCode: 'invalid_state' } });
  });

  it('refuses guardian.register-provider-root.v1 once this guardian holds its maximum staged operations', async () => {
    const set = await startSet();

    // Every registration reuses the same root, so only the staged-operation count — never the reaper's own
    // root count — can be what refuses the one past the cap.
    for (let index = 0; index < MAX_PROXY_OPERATION_LEDGERS; index += 1) {
      const staged = (await strictTestExchange(
        set.proxyChannel,
        'guardian.register-provider-root.v1',
        {
          proxy: set.proxyIdentity,
          operation: set.operationFor(),
          reservation: randomUUID(),
          providerPid: ROOT.pid,
          providerIncarnation: ROOT.incarnation,
        },
        5_000,
      )) as { state: string };
      expect(staged.state).toBe('staged-contained');
    }

    await expect(
      strictTestExchange(
        set.proxyChannel,
        'guardian.register-provider-root.v1',
        {
          proxy: set.proxyIdentity,
          operation: set.operationFor(),
          reservation: randomUUID(),
          providerPid: ROOT.pid,
          providerIncarnation: ROOT.incarnation,
        },
        5_000,
      ),
    ).rejects.toThrow(/maximum staged operations/u);
  });

  it('refuses guardian.register-provider-root.v1 once this guardian holds its maximum recorded provider roots', async () => {
    const set = await startSet();

    // Each cycle stages a *distinct* root, then releases the membership — dropping the staged-operation count
    // back to zero while the enforcer keeps every root it has ever recorded ("nothing is ever removed"). That
    // is what lets this reach the provider-root cap without ever also tripping the staged-operation cap.
    for (let index = 0; index < MAX_PROXY_RECORDED_PROVIDER_ROOTS; index += 1) {
      const operation = set.operationFor();
      const reservation = randomUUID();
      const staged = (await strictTestExchange(
        set.proxyChannel,
        'guardian.register-provider-root.v1',
        {
          proxy: set.proxyIdentity,
          operation,
          reservation,
          providerPid: 40_000 + index,
          providerIncarnation: testIncarnation(1),
        },
        5_000,
      )) as { state: string; jointContainmentReceipt: string };
      expect(staged.state).toBe('staged-contained');
      const released = (await strictTestExchange(
        set.proxyChannel,
        'guardian.operation-release.v1',
        { proxy: set.proxyIdentity, operation, reservation },
        5_000,
      )) as { state: string };
      expect(released.state).toBe('membership-released');
    }

    await expect(
      strictTestExchange(
        set.proxyChannel,
        'guardian.register-provider-root.v1',
        {
          proxy: set.proxyIdentity,
          operation: set.operationFor(),
          reservation: randomUUID(),
          providerPid: 999_999,
          providerIncarnation: testIncarnation(1),
        },
        5_000,
      ),
    ).rejects.toThrow(/maximum recorded provider roots/u);
  });

  /**
   * A guardian with no real reaper behind it. Setup supplies the complete method-specific containment reply
   * the guardian now requires; later calls are controlled by `stubReaperCall`, letting tests return malformed
   * replies a real reaper's own handler would never emit.
   */
  async function startBareGuardianWithStubReaper(
    stubReaperCall: (method: string, params: unknown) => Promise<unknown>,
  ): Promise<{
    control: ControlClient;
    proxyChannel: ControlClient;
    proxyIdentity: Record<string, unknown>;
    operationFor(): Record<string, string>;
  }> {
    const directory = mkdtempSync(join(tmpdir(), 'coral-bare-guardian-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const shared = bareSharedIdentity();
    const clock = createMonotonicClock(Symbol('bare-guardian'), { readMilliseconds: () => 0n });
    const containmentEnvironment = {
      clock,
      process: { kill: () => true, observeLiveness: () => 'alive' as const },
      platform: 'linux' as const,
      maxRecordedRoots: 128,
      readProcessIncarnation: () => CONTAINMENT.incarnation,
    };
    const guardianEndpoint = join(directory, 'g.sock');
    const reaperIdentity = {
      reaperInstanceId: shared.reaperInstanceId,
      pid: 5_101,
      incarnation: testIncarnation(901),
      guardianInstanceId: shared.guardianInstanceId,
      generation: shared.generation,
      flavor: shared.flavor,
      buildSetId: shared.buildSetId,
      hostFingerprint: FINGERPRINT,
      canonicalControlEndpoint: join(directory, 'r.sock'),
      containmentKind: CONTAINMENT.containmentKind,
    };
    const guardian = createGuardian({
      capsule: {
        role: 'guardian',
        ...shared,
        canonicalControlEndpoint: guardianEndpoint,
        reaperControlEndpoint: join(directory, 'r.sock'),
        proxyEndpoint: join(directory, 'p.sock'),
        guardianReaperAuthSecret: PAIR_SECRET,
        proxyGuardianAuthSecret: PAIR_SECRET,
      },
      clock,
      deadlines: bareDeadlines(clock),
      containmentEnvironment,
      scheduler: idleScheduler,
      timer,
      mintReceipt: () => 'receipt-bare-guardian',
      reaperChannel: {
        exchange: async (method, params) =>
          method === 'reaper.record-containment.v1'
            ? controlExchangeForTest({
                kind: 'response' as const,
                response: {
                  kind: 'result' as const,
                  value: { state: 'containment-recorded', reaper: reaperIdentity },
                },
              })
            : controlExchangeForTest({
                kind: 'response' as const,
                response: { kind: 'result' as const, value: await stubReaperCall(method, params) },
              }),
        faulted: new Promise<never>(() => undefined),
        onFault: () => () => undefined,
        close: (): void => {},
      },
      self: { pid: 5_102, incarnation: testIncarnation(902) },
      reaperSelf: { pid: 5_101, incarnation: testIncarnation(901) },
      onOutcome: () => {},
      onProgressViolation: () => {},
    });
    await guardian.listen();
    cleanups.push(() => guardian.close());
    await guardian.recordContainment(CONTAINMENT);

    const proxyChannel = await connectControlClient(guardianEndpoint, timer, 5_000);
    cleanups.push(() => proxyChannel.close());
    await strictTestExchange(proxyChannel, 'guardian.pair.v1', { pairingSecret: PAIR_SECRET }, 5_000);

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
      canonicalEndpoint: join(directory, 'p.sock'),
    };

    // A second, separate connection: pairing and control are different authorities, and
    // `guardian.operation-activate.v1` requires the latter.
    const control = await connectControlClient(guardianEndpoint, timer, 5_000);
    cleanups.push(() => control.close());
    const coordinatorIdentity = {
      instanceId: randomUUID(),
      pid: 4_000,
      incarnation: testIncarnation(700),
      generation: shared.generation,
      flavor: shared.flavor,
      buildSetId: shared.buildSetId,
    };
    const opened = (await strictTestExchange(
      control,
      'guardian.open.v1',
      { bootstrapNonce: NONCE, coordinator: coordinatorIdentity, proxy: proxyIdentity },
      5_000,
    )) as { controlEpoch: number; heartbeatChallenge: string };
    await strictTestExchange(
      control,
      'guardian.heartbeat.v1',
      { controlEpoch: opened.controlEpoch, heartbeatChallenge: opened.heartbeatChallenge },
      5_000,
    );

    const operationFor = (): Record<string, string> => ({
      jobId: randomUUID(),
      operationId: randomUUID(),
      proxyInstanceId: shared.proxyInstanceId,
      buildSetId: shared.buildSetId,
    });

    return { control, proxyChannel, proxyIdentity, operationFor };
  }

  it('refuses guardian.register-provider-root.v1 when the reaper does not confirm it recorded the root', async () => {
    const bare = await startBareGuardianWithStubReaper(async (method) =>
      method === 'reaper.record-containment.v1' ? { state: 'containment-recorded' } : { state: 'not-recorded' },
    );

    await expect(
      strictTestExchange(
        bare.proxyChannel,
        'guardian.register-provider-root.v1',
        {
          proxy: bare.proxyIdentity,
          operation: bare.operationFor(),
          reservation: randomUUID(),
          providerPid: ROOT.pid,
          providerIncarnation: ROOT.incarnation,
        },
        5_000,
      ),
    ).rejects.toMatchObject({ remoteFailure: { protocolCode: 'protocol_violation' } });

    // Deliberately not followed by "and no receipt was minted". A black-box activation call cannot tell that
    // apart from "this operation was never staged" — the guardian answers `unauthorized_control` either way —
    // so such an assertion would pass whether or not the mint is ordered behind the reaper's acknowledgement.
    // That ordering is held by `mintJointContainmentReceipt`'s signature instead: it takes both authorities'
    // tokens, so reordering the source does not compile.
  });

  it('refuses guardian.operation-activate.v1 when the reaper does not confirm it still holds the root', async () => {
    const bare = await startBareGuardianWithStubReaper(async (method) => {
      if (method === 'reaper.record-containment.v1') return { state: 'containment-recorded' };
      if (method === 'reaper.register-provider-root.v1') return { state: 'root-recorded' };
      return { state: 'not-recorded' };
    });
    const operation = bare.operationFor();
    const reservation = randomUUID();
    const staged = (await strictTestExchange(
      bare.proxyChannel,
      'guardian.register-provider-root.v1',
      {
        proxy: bare.proxyIdentity,
        operation,
        reservation,
        providerPid: ROOT.pid,
        providerIncarnation: ROOT.incarnation,
      },
      5_000,
    )) as { jointContainmentReceipt: string };

    await expect(
      strictTestExchange(
        bare.control,
        'guardian.operation-activate.v1',
        {
          operation,
          reservation,
          providerRoot: ROOT,
          jointContainmentReceipt: staged.jointContainmentReceipt,
        },
        5_000,
      ),
    ).rejects.toMatchObject({ remoteFailure: { protocolCode: 'protocol_violation' } });
  });

  it('keeps a released membership recorded so only teardown may conclude absence', async () => {
    const set = await startSet();
    const { operation, reservation } = await stage(set);

    const released = (await strictTestExchange(
      set.proxyChannel,
      'guardian.operation-release.v1',
      { proxy: set.proxyIdentity, operation, reservation },
      5_000,
    )) as { state: string };
    expect(released.state).toBe('membership-released');

    const reaped = (await strictTestExchange(
      set.control,
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
    expect(reaped.disappearanceReceipt).toContain(`root:${ROOT.pid}@${ROOT.incarnation}`);
  });

  it('reaps the recorded set through the documented stop-and-reap request', async () => {
    const set = await startSet();

    const reaped = (await strictTestExchange(
      set.control,
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

  it('refuses a teardown that names a provider-root set the guardian never recorded', async () => {
    const set = await startSet();

    // The same set-agreement the reaper enforces on its own half of this request — one authority must not
    // accept a teardown the other would refuse.
    await expect(
      strictTestExchange(
        set.control,
        'guardian.stop-and-reap.v1',
        {
          guardian: set.guardianIdentity,
          reaper: set.reaperIdentity,
          proxy: set.proxyIdentity,
          providerRoots: [{ pid: 9_999, incarnation: testIncarnation(1) }],
        },
        5_000,
      ),
    ).rejects.toThrow(/different provider-root set/u);
  });

  it('refuses a teardown that names a different guardian than this one', async () => {
    const set = await startSet();

    await expect(
      strictTestExchange(
        set.control,
        'guardian.stop-and-reap.v1',
        {
          guardian: { ...set.guardianIdentity, pid: set.guardianIdentity.pid + 1 },
          reaper: set.reaperIdentity,
          proxy: set.proxyIdentity,
          providerRoots: [],
        },
        5_000,
      ),
    ).rejects.toThrow(/different guardian than this one/u);
  });

  it('refuses a teardown at the guardian that names a different reaper than the one it spawned', async () => {
    const set = await startSet();

    await expect(
      strictTestExchange(
        set.control,
        'guardian.stop-and-reap.v1',
        {
          guardian: set.guardianIdentity,
          reaper: { ...set.reaperIdentity, pid: set.reaperIdentity.pid + 1 },
          proxy: set.proxyIdentity,
          providerRoots: [],
        },
        5_000,
      ),
    ).rejects.toThrow(/different reaper than this one/u);
  });

  it('refuses a teardown that names a provider-root set the reaper never recorded', async () => {
    const set = await startSet();
    // Reach the reaper directly so its own set-agreement check is the one under test.
    const reaperControl = await connectControlClient(set.reaperIdentity.canonicalControlEndpoint, timer, 5_000);
    cleanups.push(() => reaperControl.close());
    const opened = (await strictTestExchange(
      reaperControl,
      'reaper.open.v1',
      {
        bootstrapNonce: NONCE,
        coordinator: {
          instanceId: randomUUID(),
          pid: 4_000,
          incarnation: testIncarnation(700),
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
    await strictTestExchange(
      reaperControl,
      'reaper.heartbeat.v1',
      { controlEpoch: opened.controlEpoch, heartbeatChallenge: opened.heartbeatChallenge },
      5_000,
    );

    await expect(
      strictTestExchange(
        reaperControl,
        'reaper.stop-and-reap.v1',
        {
          reaper: set.reaperIdentity,
          proxy: set.proxyIdentity,
          providerRoots: [{ pid: 9_999, incarnation: testIncarnation(1) }],
        },
        5_000,
      ),
    ).rejects.toThrow(/different provider-root set/u);
  });

  it('refuses a teardown that names a different reaper than this one', async () => {
    const set = await startSet();
    // Reach the reaper directly so its own identity check is the one under test.
    const reaperControl = await connectControlClient(set.reaperIdentity.canonicalControlEndpoint, timer, 5_000);
    cleanups.push(() => reaperControl.close());
    const opened = (await strictTestExchange(
      reaperControl,
      'reaper.open.v1',
      {
        bootstrapNonce: NONCE,
        coordinator: {
          instanceId: randomUUID(),
          pid: 4_000,
          incarnation: testIncarnation(700),
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
    await strictTestExchange(
      reaperControl,
      'reaper.heartbeat.v1',
      { controlEpoch: opened.controlEpoch, heartbeatChallenge: opened.heartbeatChallenge },
      5_000,
    );

    await expect(
      strictTestExchange(
        reaperControl,
        'reaper.stop-and-reap.v1',
        {
          reaper: { ...set.reaperIdentity, pid: set.reaperIdentity.pid + 1 },
          proxy: set.proxyIdentity,
          providerRoots: [],
        },
        5_000,
      ),
    ).rejects.toThrow(/different reaper than this one/u);
  });

  it('replies containment-absent when reaper.stop-and-reap.v1 succeeds directly on its own control', async () => {
    // Every other direct call to this method above asserts a refusal; `guardian.stop-and-reap.v1`'s own
    // success path (`armed.stopAndReap` on the guardian's own enforcer) never reaches this reaper's handler
    // at all — the two roles hold separate enforcers over the same containment — so this is the only place
    // the reaper's own success reply is exercised.
    const set = await startSet();
    const reaperControl = await openReaperControl(set);

    const reaped = (await strictTestExchange(
      reaperControl,
      'reaper.stop-and-reap.v1',
      { reaper: set.reaperIdentity, proxy: set.proxyIdentity, providerRoots: [] },
      5_000,
    )) as { state: string; disappearanceReceipt: string };

    expect(reaped.state).toBe('containment-absent');
    expect(reaped.disappearanceReceipt).toContain(`group:${CONTAINMENT.processGroupId}`);
    expect(set.alive.has(CONTAINMENT.pid)).toBe(false);
  });

  it('installs a dormant grant and lets exactly one successor redeem it into control', async () => {
    const set = await startSet();
    const { operation } = await stage(set);
    const request = await installGrant(set, [operation]);
    // The grant is dormant while the incumbent holds control; loss is what makes it redeemable.
    set.lapseControl();
    set.control.close();

    const successor = await connectControlClient(set.guardianEndpoint, timer, 5_000);
    cleanups.push(() => successor.close());
    const redeemed = (await strictTestExchange(successor, 'guardian.handoff-redeem.v1', request, 5_000)) as {
      state: string;
      redemptionReceipt: string;
      controlEpoch: number;
      operations: Record<string, string>[];
      heartbeatChallenge: string;
    };

    expect(redeemed.state).toBe('redeemed-provisional');
    const redeemedFields = guardianHandoffRedeemResultSchema.parse(redeemed);
    expect(redeemedFields.guardian).toEqual(set.guardianIdentity);
    expect(redeemedFields.reaper).toEqual(set.reaperIdentity);
    expect(redeemedFields.containment).toEqual(CONTAINMENT);
    // Nowhere in `request` above did this successor name an operation set — it was never asked to. This is
    // the installed set coming back from the guardian's own authoritative record, not an echo.
    expect(redeemed.operations).toEqual([operation]);
    // Redemption yields a tenancy that is provisional until echoed, exactly like a bootstrap open — the
    // endpoint adds the epoch and first challenge; the grant only proves the successor earned them.
    expect(redeemed.controlEpoch).toBe(2);
    const beat = (await strictTestExchange(
      successor,
      'guardian.heartbeat.v1',
      { controlEpoch: redeemed.controlEpoch, heartbeatChallenge: redeemed.heartbeatChallenge },
      5_000,
    )) as { state: string };
    expect(beat.state).toBe('active');
  });

  it('returns the same redemption to an identical retry and refuses a different successor', async () => {
    const set = await startSet();
    const { operation } = await stage(set);
    const request = await installGrant(set, [operation]);
    set.lapseControl();
    set.control.close();

    const redeemOn = async (
      request_: Record<string, unknown>,
    ): Promise<{
      client: ControlClient;
      redemptionReceipt: string;
      controlEpoch: number;
      heartbeatChallenge: string;
    }> => {
      // A lost reply means the connection broke, so the retry necessarily arrives on a fresh one.
      const client = await connectControlClient(set.guardianEndpoint, timer, 5_000);
      cleanups.push(() => client.close());
      const opened = (await strictTestExchange(client, 'guardian.handoff-redeem.v1', request_, 5_000)) as {
        redemptionReceipt: string;
        controlEpoch: number;
        heartbeatChallenge: string;
      };
      return { client, ...opened };
    };
    const first = await redeemOn(request);

    // A retry whose first reply was lost must get back what it earned. A fresh receipt would silently
    // invalidate the one the successor may already be holding.
    const retried = await redeemOn(request);
    expect(retried.redemptionReceipt).toBe(first.redemptionReceipt);
    await strictTestExchange(
      retried.client,
      'guardian.heartbeat.v1',
      { controlEpoch: retried.controlEpoch, heartbeatChallenge: retried.heartbeatChallenge },
      5_000,
    );

    const other = { ...set.coordinatorIdentity, instanceId: randomUUID() };
    // The endpoint answers a foreign successor by destroying the channel, so the caller sees a transport
    // death; which errno reaches it first depends on whether the write or the read loses the race.
    await expect(redeemOn({ ...request, successor: other })).rejects.toThrow(
      /control channel closed|EPIPE|ECONNRESET/u,
    );
  });

  it('refuses a redemption request that still names an operation set — the field no longer exists on the wire', async () => {
    const set = await startSet();
    const { operation } = await stage(set);
    const request = await installGrant(set, [operation]);
    set.lapseControl();
    set.control.close();

    const successor = await connectControlClient(set.guardianEndpoint, timer, 5_000);
    cleanups.push(() => successor.close());

    // The old redeem contract took `operations` and checked it against what was installed — a check that
    // could never fail in a legitimate flow, since a redeemer only ever echoed back what the capsule told it.
    // The new contract takes none: a caller still sending one is refused by the strict schema itself.
    await expect(
      strictTestExchange(successor, 'guardian.handoff-redeem.v1', { ...request, operations: [] }, 5_000),
    ).rejects.toMatchObject({ remoteFailure: { protocolCode: 'protocol_violation' } });
  });

  it('refuses installing a grant for a coordinator of another build', async () => {
    const set = await startSet();

    await expect(
      strictTestExchange(
        set.control,
        'guardian.handoff-install.v1',
        {
          grantId: randomUUID(),
          secretSha256: createHash('sha256').update(GRANT_SECRET, 'utf8').digest('hex'),
          successor: { ...set.coordinatorIdentity, buildSetId: randomUUID() },
          operations: [],
          orphanTimeoutMs: 30_000,
          teardownReserveMs: 14_000,
        },
        5_000,
      ),
    ).rejects.toThrow(/different build/u);
  });

  it('refuses guardian.handoff-install.v1 naming a teardown reserve that is not this build’s own', async () => {
    const set = await startSet();

    await expect(
      strictTestExchange(
        set.control,
        'guardian.handoff-install.v1',
        {
          grantId: randomUUID(),
          secretSha256: createHash('sha256').update(GRANT_SECRET, 'utf8').digest('hex'),
          successor: set.coordinatorIdentity,
          operations: [],
          orphanTimeoutMs: 30_000,
          teardownReserveMs: 15_000,
        },
        5_000,
      ),
    ).rejects.toThrow(/teardown reserve/u);
  });

  it('refuses guardian.handoff-install.v1 naming an orphan timeout that is not its enforcer’s own', async () => {
    const set = await startSet();

    await expect(
      strictTestExchange(
        set.control,
        'guardian.handoff-install.v1',
        {
          grantId: randomUUID(),
          secretSha256: createHash('sha256').update(GRANT_SECRET, 'utf8').digest('hex'),
          successor: set.coordinatorIdentity,
          operations: [],
          orphanTimeoutMs: 30_001,
          teardownReserveMs: 14_000,
        },
        5_000,
      ),
    ).rejects.toThrow(/orphan timeout/u);
  });

  it('refuses an unsorted or duplicated operation set at guardian.handoff-install.v1 ingress', async () => {
    const set = await startSet();
    const a = set.operationFor();
    const b = set.operationFor();
    // Deliberately descending: whichever of the two sorts later goes first.
    const [first, second] = a.operationId < b.operationId ? [b, a] : [a, b];
    const install = (operations: Record<string, string>[]): Promise<unknown> =>
      strictTestExchange(
        set.control,
        'guardian.handoff-install.v1',
        {
          grantId: randomUUID(),
          secretSha256: createHash('sha256').update(GRANT_SECRET, 'utf8').digest('hex'),
          successor: set.coordinatorIdentity,
          operations,
          orphanTimeoutMs: 30_000,
          teardownReserveMs: 14_000,
        },
        5_000,
      );

    // The wire schema this method parses carries the same byte-sort refinement the installed grant's own
    // idempotency check depends on, so an unsorted or duplicated set is refused right here, at ingress.
    await expect(install([first, second])).rejects.toMatchObject({
      remoteFailure: { protocolCode: 'protocol_violation' },
    });
    // Duplicated is refused for the same reason, not merely unsorted.
    await expect(install([first, first])).rejects.toMatchObject({
      remoteFailure: { protocolCode: 'protocol_violation' },
    });
  });

  it("installs the same grant on the reaper's own active control, independent of the guardian's tenancy", async () => {
    const set = await startSet();
    const { operation } = await stage(set);
    const reaperControl = await openReaperControl(set);
    const grantId = randomUUID();
    const handoffOperations = [operation];

    const installed = (await strictTestExchange(
      reaperControl,
      'reaper.handoff-install.v1',
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
  });

  it('refuses reaper.handoff-install.v1 for a coordinator of another build, like the guardian does', async () => {
    const set = await startSet();
    const reaperControl = await openReaperControl(set);

    await expect(
      strictTestExchange(
        reaperControl,
        'reaper.handoff-install.v1',
        {
          grantId: randomUUID(),
          secretSha256: createHash('sha256').update(GRANT_SECRET, 'utf8').digest('hex'),
          successor: { ...set.coordinatorIdentity, buildSetId: randomUUID() },
          operations: [],
          orphanTimeoutMs: 30_000,
          teardownReserveMs: 14_000,
        },
        5_000,
      ),
    ).rejects.toThrow(/different build/u);
  });

  it('refuses reaper.handoff-install.v1 naming a teardown reserve that is not this build’s own', async () => {
    const set = await startSet();
    const reaperControl = await openReaperControl(set);

    await expect(
      strictTestExchange(
        reaperControl,
        'reaper.handoff-install.v1',
        {
          grantId: randomUUID(),
          secretSha256: createHash('sha256').update(GRANT_SECRET, 'utf8').digest('hex'),
          successor: set.coordinatorIdentity,
          operations: [],
          orphanTimeoutMs: 30_000,
          teardownReserveMs: 15_000,
        },
        5_000,
      ),
    ).rejects.toThrow(/teardown reserve/u);
  });

  it('refuses reaper.handoff-install.v1 naming an orphan timeout that is not its enforcer’s own', async () => {
    const set = await startSet();
    const reaperControl = await openReaperControl(set);

    await expect(
      strictTestExchange(
        reaperControl,
        'reaper.handoff-install.v1',
        {
          grantId: randomUUID(),
          secretSha256: createHash('sha256').update(GRANT_SECRET, 'utf8').digest('hex'),
          successor: set.coordinatorIdentity,
          operations: [],
          orphanTimeoutMs: 30_001,
          teardownReserveMs: 14_000,
        },
        5_000,
      ),
    ).rejects.toThrow(/orphan timeout/u);
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

  it('carries a multi-operation grant through guardian redemption and reaper rotation byte-sorted and intact', async () => {
    // Real-socket set recovery may attach more than one operation from the same membership proof: the
    // guardian never re-derives the set (only the successor's grantId/secret), and the reaper never receives
    // it directly either (only the guardian's own authoritative forward) — so this is the one place both
    // hops of that forward can be checked against the exact same multi-operation set at once.
    const set = await startSet();
    const first = set.operationFor();
    const second = set.operationFor();
    const unsorted = first.operationId < second.operationId ? [second, first] : [first, second];
    const sorted = [...unsorted].sort((left, right) => (left.operationId < right.operationId ? -1 : 1));
    const request = await installGrant(set, unsorted);
    const reaperControl = await openReaperControl(set);
    set.lapseControl();
    set.control.close();
    reaperControl.close();

    const successorGuardian = await connectControlClient(set.guardianEndpoint, timer, 5_000);
    cleanups.push(() => successorGuardian.close());
    const redeemed = (await strictTestExchange(successorGuardian, 'guardian.handoff-redeem.v1', request, 5_000)) as {
      redemptionReceipt: string;
      operations: Record<string, string>[];
    };
    expect(redeemed.operations).toEqual(sorted);

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
    )) as { state: string; operations: Record<string, string>[]; controlEpoch: number; heartbeatChallenge: string };

    // Both authorities report the identical byte-sorted set the guardian alone forwarded — the reaper never
    // independently re-derives it, and the successor never presented one for either to check against.
    expect(rotated.operations).toEqual(sorted);
    const beat = (await strictTestExchange(
      successorReaper,
      'reaper.heartbeat.v1',
      { controlEpoch: rotated.controlEpoch, heartbeatChallenge: rotated.heartbeatChallenge },
      5_000,
    )) as { state: string };
    expect(beat.state).toBe('active');
  });

  it('refuses reaper.record-redemption.v1 when a second push disagrees with the one already recorded', async () => {
    const set = await startSet();
    const first = {
      grantId: randomUUID(),
      successor: set.coordinatorIdentity,
      operations: [],
      redemptionReceipt: 'redemption-receipt-one',
    };

    // The guardian's own pairing channel is the only authority that ever pushes this fact — reused here
    // rather than opened fresh, since the reaper accepts exactly one paired peer.
    const recorded = (await strictTestExchange(set.reaperChannel, 'reaper.record-redemption.v1', first, 5_000)) as {
      state: string;
    };
    expect(recorded.state).toBe('redemption-recorded');

    // An identical repeat is idempotent (a retried guardian forward whose own reply was lost), so the
    // mismatch below has to change a field, not merely resend the same fact.
    const repeat = (await strictTestExchange(set.reaperChannel, 'reaper.record-redemption.v1', first, 5_000)) as {
      state: string;
    };
    expect(repeat.state).toBe('redemption-recorded');

    await expect(
      strictTestExchange(
        set.reaperChannel,
        'reaper.record-redemption.v1',
        { ...first, redemptionReceipt: 'redemption-receipt-two' },
        5_000,
      ),
    ).rejects.toThrow(/different live control epoch/u);
  });

  it('refuses reaper.record-redemption.v1 when a second push repeats the receipt but disagrees on operations', async () => {
    const set = await startSet();
    const { operation } = await stage(set);
    const first = {
      grantId: randomUUID(),
      successor: set.coordinatorIdentity,
      operations: [],
      redemptionReceipt: 'redemption-receipt-shared',
    };

    const recorded = (await strictTestExchange(set.reaperChannel, 'reaper.record-redemption.v1', first, 5_000)) as {
      state: string;
    };
    expect(recorded.state).toBe('redemption-recorded');

    // Same receipt as `first`, but a different operation set — the receipt alone must not be read as
    // "the same fact repeated" when the set it names has moved.
    await expect(
      strictTestExchange(
        set.reaperChannel,
        'reaper.record-redemption.v1',
        { ...first, operations: [operation] },
        5_000,
      ),
    ).rejects.toThrow(/different live control epoch/u);
  });

  it('refuses reaper.handoff-rotate.v1 before the guardian has ever redeemed the grant', async () => {
    const set = await startSet();
    const { operation } = await stage(set);
    const request = await installGrant(set, [operation]);
    const reaperControl = await openReaperControl(set);
    set.lapseControl();
    reaperControl.close();

    const successorReaper = await connectControlClient(set.reaperEndpoint, timer, 5_000);
    cleanups.push(() => successorReaper.close());

    // This successor holds the plaintext secret from the same capsule the guardian would check, but never
    // presented it there — closing exactly the gap a secret-checking reaper would leave open: two
    // successors, one still-unspent capsule, and no guardian involved yet.
    await expect(
      strictTestExchange(
        successorReaper,
        'reaper.handoff-rotate.v1',
        {
          grantId: request.grantId,
          successor: set.coordinatorIdentity,
          guardianRedemptionReceipt: 'never-forwarded',
        },
        5_000,
      ),
    ).rejects.toMatchObject({ remoteFailure: { protocolCode: 'grant_invalid' } });
  });

  it('refuses reaper.handoff-rotate.v1 presenting a receipt this reaper never recorded', async () => {
    const set = await startSet();
    const { operation } = await stage(set);
    const request = await installGrant(set, [operation]);
    const reaperControl = await openReaperControl(set);
    set.lapseControl();
    set.control.close();
    reaperControl.close();

    const successorGuardian = await connectControlClient(set.guardianEndpoint, timer, 5_000);
    cleanups.push(() => successorGuardian.close());
    await strictTestExchange(successorGuardian, 'guardian.handoff-redeem.v1', request, 5_000);

    const successorReaper = await connectControlClient(set.reaperEndpoint, timer, 5_000);
    cleanups.push(() => successorReaper.close());

    await expect(
      strictTestExchange(
        successorReaper,
        'reaper.handoff-rotate.v1',
        {
          grantId: request.grantId,
          successor: set.coordinatorIdentity,
          guardianRedemptionReceipt: 'a-forged-receipt-nobody-issued',
        },
        5_000,
      ),
    ).rejects.toMatchObject({ remoteFailure: { protocolCode: 'grant_invalid' } });
  });

  it('holds nothing until the guardian names the containment it watched being created', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'coral-unrecorded-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const reaperEndpoint = join(directory, 'r.sock');
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
    const clock = createMonotonicClock(Symbol('unrecorded'), { readMilliseconds: () => 0n });
    const reaper = createReaper({
      capsule: {
        role: 'reaper',
        ...shared,
        canonicalControlEndpoint: reaperEndpoint,
        guardianControlEndpoint: join(directory, 'g.sock'),
        proxyEndpoint: join(directory, 'p.sock'),
        guardianReaperAuthSecret: PAIR_SECRET,
      },
      clock,
      deadlines: {
        orphanTimeoutMs: () => 74_000,
        controlIsLive: () => true,
        issueFirstChallenge: () => ({ accepted: true, challenge: randomUUID() }) as const,
        admitSuccessor: () => ({ accepted: true, challenge: randomUUID() }) as const,
        reattachControl: () => ({ accepted: true }) as const,
        echoChallenge: () => ({ accepted: true, nextChallenge: randomUUID() }) as const,
        observeEof: () => {},
        observePairingLoss: () => {},
        latchTeardown: () => {},
        markContainmentAbsent: () => {},
        markExited: () => {},
        bounds: () => ({
          lastRoundTripEvidenceAt: clock.now(),
          eofAt: null,
          controlLossAt: clock.now(),
          adoptionDeadline: clock.shiftMilliseconds(clock.now(), 60_000),
          exitDeadline: clock.shiftMilliseconds(clock.now(), 74_000),
        }),
        state: () => 'accepting-control' as const,
      },
      containmentEnvironment: {
        clock,
        process: { kill: () => true, observeLiveness: () => 'absent' as const },
        platform: 'linux' as const,
        maxRecordedRoots: 128,
        readProcessIncarnation: () => null,
      },
      scheduler: idleScheduler,
      timer,
      mintReceipt: () => randomUUID(),
      self: { pid: 5_101, incarnation: testIncarnation(901) },
      onOutcome: () => {},
      onProgressViolation: () => {},
    });
    await reaper.listen();
    cleanups.push(() => reaper.close());

    // An enforcer without a containment could only ever confirm the absence of nothing, so there is none.
    expect(reaper.enforcer()).toBeNull();

    const control = await connectControlClient(reaperEndpoint, timer, 5_000);
    cleanups.push(() => control.close());
    await expect(
      strictTestExchange(
        control,
        'reaper.open.v1',
        {
          bootstrapNonce: NONCE,
          coordinator: {
            instanceId: randomUUID(),
            pid: 4_000,
            incarnation: testIncarnation(700),
            generation: shared.generation,
            flavor: shared.flavor,
            buildSetId: shared.buildSetId,
          },
          guardian: {
            guardianInstanceId: shared.guardianInstanceId,
            pid: 5_102,
            incarnation: testIncarnation(902),
            generation: shared.generation,
            flavor: shared.flavor,
            buildSetId: shared.buildSetId,
            hostFingerprint: FINGERPRINT,
            canonicalControlEndpoint: join(directory, 'g.sock'),
          },
          proxy: {
            proxyInstanceId: shared.proxyInstanceId,
            pid: 6_000,
            incarnation: testIncarnation(850),
            processGroupId: 6_000,
            guardianInstanceId: shared.guardianInstanceId,
            reaperInstanceId: shared.reaperInstanceId,
            generation: shared.generation,
            flavor: shared.flavor,
            buildSetId: shared.buildSetId,
            hostFingerprint: FINGERPRINT,
            canonicalEndpoint: join(directory, 'p.sock'),
          },
          containment: CONTAINMENT,
        },
        5_000,
      ),
    ).rejects.toThrow(/holds no containment yet/u);
  });

  it('refuses a coordinator that names a different containment than the guardian recorded', async () => {
    const set = await startSet();
    const control = await connectControlClient(set.reaperIdentity.canonicalControlEndpoint, timer, 5_000);
    cleanups.push(() => control.close());

    // The coordinator's `containment` is an agreement check, not the source. A disagreement means the two
    // are reasoning about different sets, which teardown must surface rather than silently act on.
    await expect(
      strictTestExchange(
        control,
        'reaper.open.v1',
        {
          bootstrapNonce: NONCE,
          coordinator: set.coordinatorIdentity,
          guardian: set.guardianIdentity,
          proxy: set.proxyIdentity,
          containment: { ...CONTAINMENT, processGroupId: 9_999 },
        },
        5_000,
      ),
    ).rejects.toThrow(/different containment than the guardian recorded/u);
  });

  it('refuses reaper.open.v1 naming a guardian that does not match this reaper’s own capsule', async () => {
    const set = await startSet();
    const control = await connectControlClient(set.reaperIdentity.canonicalControlEndpoint, timer, 5_000);
    cleanups.push(() => control.close());

    // `assertNamedGuardianCapsuleIdentity` checks the caller's claimed guardian against this reaper's own
    // bootstrap capsule — pid/incarnation are deliberately excluded (see its doc), so the mismatch has to land
    // on a capsule-stable field such as `guardianInstanceId`.
    await expect(
      strictTestExchange(
        control,
        'reaper.open.v1',
        {
          bootstrapNonce: NONCE,
          coordinator: set.coordinatorIdentity,
          guardian: { ...set.guardianIdentity, guardianInstanceId: randomUUID() },
          proxy: set.proxyIdentity,
          containment: CONTAINMENT,
        },
        5_000,
      ),
    ).rejects.toThrow(/does not match this reaper/u);
  });

  it('reaps guardian containment when only proxy pairing is lost while coordinator heartbeats remain live', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'coral-guardian-pairing-loss-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const shared = bareSharedIdentity();
    const guardianEndpoint = join(directory, 'g.sock');
    const reaperEndpoint = join(directory, 'r.sock');
    const proxyEndpoint = join(directory, 'p.sock');
    let elapsed = 0n;
    const clock = createMonotonicClock(Symbol('guardian-pairing-loss'), {
      readMilliseconds: () => elapsed,
      sleep: (milliseconds) => {
        elapsed += BigInt(milliseconds);
        return Promise.resolve();
      },
    });
    const configuration = resolveProviderProxyDeadlineConfiguration({ get: () => undefined });
    const deadlines = createEnforcerDeadlineStateMachine(clock, configuration, {
      mintChallenge: () => randomUUID(),
    });
    let teardownLatchedAt: bigint | null = null;
    const watchedDeadlines = {
      ...deadlines,
      latchTeardown: (): void => {
        teardownLatchedAt ??= elapsed;
        deadlines.latchTeardown();
      },
    };
    const scheduled: Array<{
      callback: () => void;
      cancelled: boolean;
      dueAt: bigint;
      unref(): void;
    }> = [];
    const scheduler: EnforcementScheduler = {
      schedule: (callback, delayMs) => {
        const entry = { callback, cancelled: false, dueAt: elapsed + BigInt(delayMs), unref: () => {} };
        scheduled.push(entry);
        return entry;
      },
      cancel: (handle) => {
        (handle as (typeof scheduled)[number]).cancelled = true;
      },
    };
    const runDue = (): void => {
      while (true) {
        const index = scheduled.findIndex((entry) => !entry.cancelled && entry.dueAt <= elapsed);
        if (index < 0) return;
        const [entry] = scheduled.splice(index, 1);
        entry?.callback();
      }
    };

    const alive = new Set([CONTAINMENT.pid]);
    const containmentEnvironment = {
      clock,
      process: {
        kill: (pid: number) => {
          for (const target of pid < 0 ? [...alive] : [pid]) alive.delete(target);
          return true;
        },
        observeLiveness: (pid: number) =>
          ((pid < 0 ? alive.has(-pid) : alive.has(pid)) ? 'alive' : 'absent') as ProcessLiveness,
      },
      platform: 'linux' as const,
      maxRecordedRoots: MAX_PROXY_RECORDED_PROVIDER_ROOTS,
      readProcessIncarnation: (pid: number) => (alive.has(pid) ? CONTAINMENT.incarnation : null),
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
      deadlines: watchedDeadlines,
      containmentEnvironment,
      scheduler,
      timer,
      mintReceipt: () => randomUUID(),
      reaperChannel: {
        exchange: async (method) => {
          if (method !== 'reaper.record-containment.v1') throw new Error(`Unexpected reaper exchange: ${method}`);
          return controlExchangeForTest({
            kind: 'response' as const,
            response: {
              kind: 'result' as const,
              value: { state: 'containment-recorded', reaper: reaperIdentity },
            },
          });
        },
        faulted: new Promise<never>(() => undefined),
        onFault: () => () => undefined,
        close: () => {},
      },
      self: { pid: 5_102, incarnation: testIncarnation(902) },
      reaperSelf: { pid: reaperIdentity.pid, incarnation: reaperIdentity.incarnation },
      onOutcome: () => {},
      onProgressViolation: () => {},
    });
    await guardian.listen();
    cleanups.push(() => guardian.close());
    await guardian.recordContainment(CONTAINMENT);

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
    const control = await connectControlClient(guardianEndpoint, timer, 5_000);
    cleanups.push(() => control.close());
    const opened = (await strictTestExchange(
      control,
      'guardian.open.v1',
      { bootstrapNonce: NONCE, coordinator: coordinatorIdentity, proxy: proxyIdentity },
      5_000,
    )) as { controlEpoch: number; heartbeatChallenge: string };
    let heartbeatChallenge = opened.heartbeatChallenge;
    let lastAcceptedHeartbeatAt = clock.now();
    const sendHeartbeat = async (): Promise<void> => {
      const response = (await strictTestExchange(
        control,
        'guardian.heartbeat.v1',
        { controlEpoch: opened.controlEpoch, heartbeatChallenge },
        5_000,
      )) as { state: string; nextHeartbeatChallenge: string };
      expect(response.state).toBe('active');
      heartbeatChallenge = response.nextHeartbeatChallenge;
      lastAcceptedHeartbeatAt = clock.now();
    };
    await sendHeartbeat();

    const pairing = await connectControlClient(guardianEndpoint, timer, 5_000);
    cleanups.push(() => pairing.close());
    await strictTestExchange(pairing, 'guardian.pair.v1', { pairingSecret: PAIR_SECRET }, 5_000);

    // The lease records the challenge's issuance time rather than its echo time, so stay one millisecond
    // inside half a lease: two consecutive in-flight round trips can never land exactly on expiry.
    const heartbeatIntervalMs = configuration.leaseMs / 2 - 1;
    for (let nextHeartbeatAt = heartbeatIntervalMs; nextHeartbeatAt < configuration.leaseMs; ) {
      elapsed = BigInt(nextHeartbeatAt);
      runDue();
      await Promise.resolve();
      await sendHeartbeat();
      nextHeartbeatAt += heartbeatIntervalMs;
    }
    const pairingLostAtMs = elapsed;
    const pairingLostAt = clock.now();
    pairing.close();
    // Let the endpoint consume the peer EOF while fake monotonic time remains pinned at `pairingLostAt`.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(clock.millisecondsBetween(lastAcceptedHeartbeatAt, pairingLostAt)).toBeLessThanOrEqual(heartbeatIntervalMs);
    const absoluteExitAt = pairingLostAtMs + BigInt(configuration.orphanTimeoutMs);
    let nextHeartbeatAt = elapsed + BigInt(heartbeatIntervalMs);
    while (elapsed < absoluteExitAt) {
      const nextTickAt = elapsed + 500n;
      elapsed = [nextTickAt, nextHeartbeatAt, absoluteExitAt]
        .filter((candidate) => candidate > elapsed)
        .reduce((earliest, candidate) => (candidate < earliest ? candidate : earliest));
      runDue();
      await Promise.resolve();
      if (elapsed < nextHeartbeatAt) continue;
      try {
        await sendHeartbeat();
      } catch (error: unknown) {
        // Once pairing loss latches teardown, the still-open coordinator socket correctly refuses heartbeats.
        if (deadlines.state() === 'accepting-control') {
          throw new Error(`heartbeat failed at ${elapsed}ms while control was live`, { cause: error });
        }
      }
      nextHeartbeatAt += BigInt(heartbeatIntervalMs);
    }
    await Promise.resolve();

    expect(alive.has(CONTAINMENT.pid), 'contained child survived the pairing-loss exit deadline').toBe(false);
    expect(teardownLatchedAt).not.toBeNull();
    expect(Number((teardownLatchedAt ?? absoluteExitAt) - pairingLostAtMs)).toBeLessThanOrEqual(
      PROXY_ENFORCER_MAX_WAKE_LATENCY_MS,
    );
  });

  it('keeps the coordinator’s earned control evidence intact when its pairing peer disconnects', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'coral-pairing-loss-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const shared = bareSharedIdentity();
    const clock = createMonotonicClock(Symbol('pairing-loss'), { readMilliseconds: () => 0n });
    const deadlines = createEnforcerDeadlineStateMachine(
      clock,
      resolveProviderProxyDeadlineConfiguration({ get: () => undefined }),
      { mintChallenge: () => randomUUID() },
    );
    // Whichever of these two the reaper's pairing-close observer actually calls resolves this — the
    // assertions below are what tell the fixed wiring apart from the defect, so the synchronization itself
    // must not presume which one fires.
    let observePairingClose: () => void = () => undefined;
    const pairingClosed = new Promise<void>((resolve) => {
      observePairingClose = resolve;
    });
    const watchedDeadlines = {
      ...deadlines,
      observeEof: (): void => {
        deadlines.observeEof();
        observePairingClose();
      },
      observePairingLoss: (): void => {
        deadlines.observePairingLoss();
        observePairingClose();
      },
    };

    const { reaperEndpoint, reaper } = await startBareReaper(directory, shared, clock, watchedDeadlines);
    cleanups.push(() => reaper.close());

    const pairing = await connectControlClient(reaperEndpoint, timer, 5_000);
    cleanups.push(() => pairing.close());
    await strictTestExchange(pairing, 'reaper.pair.v1', { pairingSecret: PAIR_SECRET }, 5_000);
    await strictTestExchange(pairing, 'reaper.record-containment.v1', CONTAINMENT, 5_000);

    const coordinator = await connectControlClient(reaperEndpoint, timer, 5_000);
    cleanups.push(() => coordinator.close());
    const opened = (await strictTestExchange(
      coordinator,
      'reaper.open.v1',
      bareOpenRequest(directory, shared),
      5_000,
    )) as {
      controlEpoch: number;
      heartbeatChallenge: string;
    };
    const firstBeat = (await strictTestExchange(
      coordinator,
      'reaper.heartbeat.v1',
      { controlEpoch: opened.controlEpoch, heartbeatChallenge: opened.heartbeatChallenge },
      5_000,
    )) as { state: string; nextHeartbeatChallenge: string };
    expect(firstBeat.state).toBe('active');

    // The guardian pairing peer disappears — a crash, not a graceful close — while the coordinator's own
    // control connection stays open and current, having just earned live control.
    pairing.close();
    await pairingClosed;

    // The defect collapses the coordinator's own round-trip evidence too, because both losses wrote the
    // same field. Fixed, pairing loss must leave it exactly as the coordinator left it: live.
    expect(deadlines.controlIsLive()).toBe(true);

    // The containment is now retiring — every deadline collapses once *any* authority is touched again, by
    // the very design that makes the acceleration real — but the coordinator did nothing wrong, so that
    // refusal must read as the containment retiring, never as this coordinator having lost control.
    await expect(
      strictTestExchange(
        coordinator,
        'reaper.heartbeat.v1',
        { controlEpoch: opened.controlEpoch, heartbeatChallenge: firstBeat.nextHeartbeatChallenge },
        5_000,
      ),
    ).rejects.toThrow(/teardown-latched/u);
  });

  it('does not spend the bootstrap nonce when reaper.open.v1 is refused for missing containment', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'coral-nonce-retry-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const shared = bareSharedIdentity();
    const clock = createMonotonicClock(Symbol('nonce-retry'), { readMilliseconds: () => 0n });
    const { reaperEndpoint, reaper } = await startBareReaper(directory, shared, clock, bareDeadlines(clock));
    cleanups.push(() => reaper.close());

    const first = await connectControlClient(reaperEndpoint, timer, 5_000);
    cleanups.push(() => first.close());
    await expect(
      strictTestExchange(first, 'reaper.open.v1', bareOpenRequest(directory, shared), 5_000),
    ).rejects.toThrow(/holds no containment yet/u);

    const pairing = await connectControlClient(reaperEndpoint, timer, 5_000);
    cleanups.push(() => pairing.close());
    await strictTestExchange(pairing, 'reaper.pair.v1', { pairingSecret: PAIR_SECRET }, 5_000);
    await strictTestExchange(pairing, 'reaper.record-containment.v1', CONTAINMENT, 5_000);

    // The refusal above must not have spent the one-shot nonce: the same value still opens control once
    // this reaper actually has something to enforce.
    const second = await connectControlClient(reaperEndpoint, timer, 5_000);
    cleanups.push(() => second.close());
    const opened = (await strictTestExchange(second, 'reaper.open.v1', bareOpenRequest(directory, shared), 5_000)) as {
      controlEpoch: number;
    };
    expect(opened.controlEpoch).toBe(1);
  });

  it('re-records an identical containment idempotently and refuses a mismatched one', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'coral-containment-repeat-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const shared = bareSharedIdentity();
    const clock = createMonotonicClock(Symbol('containment-repeat'), { readMilliseconds: () => 0n });
    const { reaperEndpoint, reaper } = await startBareReaper(directory, shared, clock, bareDeadlines(clock));
    cleanups.push(() => reaper.close());

    const pairing = await connectControlClient(reaperEndpoint, timer, 5_000);
    cleanups.push(() => pairing.close());
    await strictTestExchange(pairing, 'reaper.pair.v1', { pairingSecret: PAIR_SECRET }, 5_000);

    const first = (await strictTestExchange(pairing, 'reaper.record-containment.v1', CONTAINMENT, 5_000)) as {
      state: string;
    };
    expect(first.state).toBe('containment-recorded');

    const repeat = (await strictTestExchange(pairing, 'reaper.record-containment.v1', CONTAINMENT, 5_000)) as {
      state: string;
    };
    expect(repeat.state).toBe('containment-recorded');

    await expect(
      strictTestExchange(pairing, 'reaper.record-containment.v1', { ...CONTAINMENT, processGroupId: 9_999 }, 5_000),
    ).rejects.toThrow(/already holds a containment/u);
  });
});

describe('provider-proxy/set-authority: stopAndReap against a real guardian', () => {
  /** `stopAndReap`'s own `proxyClient` is never touched by it. */
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

  it('supplies the coordinator’s own recorded provider roots, not the empty claim the guardian refuses', async () => {
    const set = await startSet();
    const reaperControl = await openReaperControl(set);
    // Stages ROOT with the real guardian's own enforcer (`guardian.register-provider-root.v1`), exactly as
    // `operation.prepare.v1` does in production — this is the fact `providerRoots: []` disagreed with.
    await stage(set);

    const authority = createProviderProxySetAuthority({
      proxyInstanceId: set.proxyIdentity.proxyInstanceId,
      guardianClient: set.control,
      proxyClient: unreachableClient(),
      reaperClient: reaperControl,
      guardianIdentity: set.guardianIdentity,
      reaperIdentity: set.reaperIdentity,
      proxyIdentityFields: set.proxyIdentity,
      heartbeats: {
        proxy: { stop: () => undefined },
        guardian: { stop: () => undefined },
        reaper: { stop: () => undefined },
      },
      coordinatorIdentity: set.coordinatorIdentity,
      handoffCapsulePath: '/dev/null/unused-handoff-capsule.json',
      runtime: { ids: undefined, env: { get: () => undefined }, storage: undefined } as unknown as Pick<
        Runtime,
        'ids' | 'env' | 'storage'
      >,
      operationRegistry: { operationsFor: () => [], providerRootsFor: () => [ROOT] },
    });

    const result = await authority.stopAndReap(new AbortController().signal);

    // The real, driving proof: `guardian.stop-and-reap.v1`'s own `assertRecordedSetAgreement` accepted this
    // call and reaped for real — a hardcoded `providerRoots: []` would instead have come back `unconfirmed`
    // with "different provider-root set" (see the raw-wire coverage above proving that refusal directly).
    expect(result).toEqual({
      disappearanceReceipt: expect.stringMatching(
        new RegExp(
          `guardian:.*root:${ROOT.pid}@${ROOT.incarnation}.*reaper:.*root:${ROOT.pid}@${ROOT.incarnation}`,
          'u',
        ),
      ),
    });
    expect(set.alive.has(CONTAINMENT.pid)).toBe(false);
  });

  it('threads an attached operation’s real provider root through stopAndReap on the recovery registry shape', async () => {
    const set = await startSet();
    const reaperControl = await openReaperControl(set);
    await stage(set);

    // Use a real `LocalOperationRegistry`, because a successor's attachment must retain the provider root
    // needed for exact set disappearance. This proves `attach()` populates `providerRootsFor` correctly,
    // not merely that a caller can hand-supply the right value.
    const operationRegistry = new LocalOperationRegistry();
    const operation = {
      jobId: randomUUID(),
      operationId: randomUUID(),
      buildSetId: set.coordinatorIdentity.buildSetId,
      proxyInstanceId: set.proxyIdentity.proxyInstanceId,
    };
    const executing = providerOperationRecord('executing', {
      operation,
      locator: {
        hostFingerprint: FINGERPRINT,
        guardian: {
          instanceId: set.guardianIdentity.guardianInstanceId,
          pid: set.guardianIdentity.pid,
          incarnation: set.guardianIdentity.incarnation,
          controlEndpoint: set.guardianIdentity.canonicalControlEndpoint,
        },
        proxy: {
          instanceId: set.proxyIdentity.proxyInstanceId,
          pid: set.proxyIdentity.pid,
          incarnation: set.proxyIdentity.incarnation,
          controlEndpoint: set.proxyIdentity.canonicalEndpoint,
        },
        reaper: {
          instanceId: set.reaperIdentity.reaperInstanceId,
          pid: set.reaperIdentity.pid,
          incarnation: set.reaperIdentity.incarnation,
          controlEndpoint: set.reaperIdentity.canonicalControlEndpoint,
        },
        containment: {
          pid: set.proxyIdentity.pid,
          incarnation: set.proxyIdentity.incarnation,
          processGroupId: set.proxyIdentity.processGroupId,
          kind: set.reaperIdentity.containmentKind,
        },
      },
    });
    const record = providerOperationRecordSchema.parse({ ...executing, providerRoot: ROOT });
    if (record.phase !== 'executing') throw new Error('expected executing provider operation');
    operationRegistry.attach(record, { stop: async () => {} }, { jobId: record.operation.jobId, pool: 'default' });

    const authority = createProviderProxySetAuthority({
      proxyInstanceId: set.proxyIdentity.proxyInstanceId,
      guardianClient: set.control,
      proxyClient: unreachableClient(),
      reaperClient: reaperControl,
      guardianIdentity: set.guardianIdentity,
      reaperIdentity: set.reaperIdentity,
      proxyIdentityFields: set.proxyIdentity,
      heartbeats: {
        proxy: { stop: () => undefined },
        guardian: { stop: () => undefined },
        reaper: { stop: () => undefined },
      },
      coordinatorIdentity: set.coordinatorIdentity,
      handoffCapsulePath: '/dev/null/unused-handoff-capsule.json',
      runtime: { ids: undefined, env: { get: () => undefined }, storage: undefined } as unknown as Pick<
        Runtime,
        'ids' | 'env' | 'storage'
      >,
      operationRegistry,
    });

    const result = await authority.stopAndReap(new AbortController().signal);

    // Same real, driving proof as the acquisition-path test above, reached through the inheritance path's
    // own write instead of a hand-supplied closure: the guardian's `assertRecordedSetAgreement` accepted
    // this call and reaped for real.
    expect(result).toEqual({
      disappearanceReceipt: expect.stringMatching(
        new RegExp(
          `guardian:.*root:${ROOT.pid}@${ROOT.incarnation}.*reaper:.*root:${ROOT.pid}@${ROOT.incarnation}`,
          'u',
        ),
      ),
    });
    expect(set.alive.has(CONTAINMENT.pid)).toBe(false);
  });
});
