import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { createHash, randomUUID } from 'node:crypto';
import { Socket } from 'node:net';

import type { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMonotonicClock, type MonotonicClock } from '#src/infra/monotonic-clock.js';
import {
  controlExchangeForTest,
  type ControlClient,
  type ControlExchange,
} from '#src/provider-proxy/control-client.js';
import {
  mintActiveControlAuthorizationForTesting,
  type ActiveControlAuthorization,
  type ControlEndpointOptions,
  type ControlMethod,
  type createControlEndpoint as createControlEndpointType,
} from '#src/provider-proxy/control-endpoint.js';
import type { EnforcementScheduler } from '#src/provider-proxy/enforcement.js';
import { createGuardian, type GuardianContainmentIdentity } from '#src/provider-proxy/guardian.js';
import {
  guardianHandoffRedeemParamsSchema,
  guardianReaperHandoffInstallParamsSchema,
} from '#src/provider-proxy/handoff-capsule.js';
import { createControlHolderAuthority, type ControlHolderAuthority } from '#src/provider-proxy/holder-lifecycle.js';
import type { EnforcerDeadlineStateMachine } from '#src/provider-proxy/orphan-deadline.js';
import {
  enforcementHoldStatusSchema,
  guardianOperationActivateParamsSchema,
  guardianRegisterProviderRootParamsSchema,
} from '#src/provider-proxy/protocol.js';

const endpointHarness = vi.hoisted(() => ({ options: undefined as unknown }));

vi.mock('#src/provider-proxy/control-endpoint.js', async (importOriginal) => {
  const actual = await importOriginal<{ createControlEndpoint: typeof createControlEndpointType }>();
  return {
    ...actual,
    createControlEndpoint: (options: Parameters<typeof actual.createControlEndpoint>[0]) => {
      endpointHarness.options = options;
      return {
        listen: async (): Promise<void> => {},
        close: async (): Promise<void> => {},
        activeControlAuthorizationIsCurrent: () => true,
        pushOnTenancy: async (): Promise<never> => {
          throw new Error('unused tenancy push');
        },
      };
    },
  };
});

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
const idleScheduler: EnforcementScheduler = { schedule: () => ({}), cancel: () => {} };
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  endpointHarness.options = undefined;
  vi.restoreAllMocks();
});

function deadlinesFor<Scope extends symbol>(clock: MonotonicClock<Scope>): EnforcerDeadlineStateMachine<Scope> {
  return {
    orphanTimeoutMs: () => 30_000,
    controlIsLive: () => true,
    issueFirstChallenge: () => ({ accepted: true, challenge: 'challenge' }) as const,
    admitSuccessor: () => ({ accepted: true, challenge: 'challenge' }) as const,
    reattachControl: () => ({ accepted: true }) as const,
    echoChallenge: () => ({ accepted: true, nextChallenge: 'next-challenge' }) as const,
    observeEof: () => {},
    observePairingLoss: () => {},
    latchTeardown: () => {},
    markContainmentAbsent: () => {},
    markExited: () => {},
    renewHolderCheck: () => {},
    bounds: () => ({
      lastRoundTripEvidenceAt: clock.now(),
      eofAt: null,
      controlLossAt: clock.now(),
      adoptionDeadline: clock.shiftMilliseconds(clock.now(), 60_000),
      exitDeadline: clock.shiftMilliseconds(clock.now(), 74_000),
      holderCheckAt: clock.shiftMilliseconds(clock.now(), 60_000),
      holderCheckAccelerated: false,
    }),
    state: () => 'accepting-control' as const,
  };
}

function letGuardianIngressYield(schema: z.ZodTypeAny, request: unknown): void {
  vi.spyOn(schema, 'parse').mockReturnValueOnce(request as never);
}

type GuardianHarness = ReturnType<typeof createGuardianHarness>;

function createGuardianHarness(
  holderAuthority: ControlHolderAuthority = createControlHolderAuthority(),
  containmentFailure?: Readonly<{ latchTeardown: () => void; observeLiveness: () => never }>,
  enforcementHoldStatus?: () => z.infer<typeof enforcementHoldStatusSchema> | null,
) {
  const clock = createMonotonicClock(Symbol('guardian-outbound'), { readMilliseconds: () => 0n });
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
  const coordinatorIdentity = {
    instanceId: randomUUID(),
    pid: 4_000,
    incarnation: testIncarnation(700),
    generation: shared.generation,
    flavor: shared.flavor,
    buildSetId: shared.buildSetId,
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
    canonicalEndpoint: '/proxy.sock',
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
    canonicalControlEndpoint: '/reaper.sock',
    containmentKind: CONTAINMENT.containmentKind,
  };
  const reaperExchange = vi.fn(async (method: string): Promise<ControlExchange> => {
    let value: unknown;
    if (method === 'reaper.record-containment.v1') {
      value = { state: 'containment-recorded', reaper: reaperIdentity };
    } else if (method === 'reaper.record-redemption.v1') {
      value = { state: 'redemption-recorded' };
    } else if (method === 'reaper.acquisition-publish.v1') {
      value = { state: 'acquisition-published' };
    } else if (method === 'reaper.containment-prepare.v1') {
      value = { state: 'containment-prepared', token: 'prepare-token', providerRoots: [] };
    } else {
      value = { state: 'root-recorded' };
    }
    return controlExchangeForTest({ kind: 'response', response: { kind: 'result', value } });
  });
  const reaperChannel: ControlClient = {
    exchange: reaperExchange,
    faulted: new Promise<never>(() => undefined),
    onFault: () => () => undefined,
    close: vi.fn(),
  };
  let receipt = 0;
  const mintReceipt = vi.fn(() => {
    receipt += 1;
    return `receipt-${receipt}`;
  });
  const guardian = createGuardian({
    capsule: {
      role: 'guardian',
      ...shared,
      canonicalControlEndpoint: '/guardian.sock',
      reaperControlEndpoint: '/reaper.sock',
      proxyEndpoint: '/proxy.sock',
      guardianReaperAuthSecret: PAIR_SECRET,
      proxyGuardianAuthSecret: PAIR_SECRET,
    },
    clock,
    deadlines: {
      ...deadlinesFor(clock),
      ...(containmentFailure === undefined ? {} : { latchTeardown: containmentFailure.latchTeardown }),
    },
    containmentEnvironment: {
      clock,
      process: {
        kill: () => true,
        observeLiveness: containmentFailure?.observeLiveness ?? (() => 'alive' as const),
      },
      platform: 'linux',
      maxRecordedRoots: 128,
      readProcessIncarnation: () => CONTAINMENT.incarnation,
    },
    scheduler: idleScheduler,
    timer: {
      setTimeout: () => ({}),
      clearTimeout: () => {},
    },
    mintReceipt,
    reaperChannel,
    self: { pid: 5_102, incarnation: testIncarnation(902) },
    reaperSelf: { pid: reaperIdentity.pid, incarnation: reaperIdentity.incarnation },
    holderAuthority,
    observeHolder: () => Promise.resolve('unknown' as const),
    ...(enforcementHoldStatus === undefined ? {} : { enforcementHoldStatus }),
    onOutcome: () => {},
    onProgressViolation: () => {},
  });
  cleanups.push(() => guardian.close());

  const endpoint = endpointHarness.options as ControlEndpointOptions;
  const method = (name: string): ControlMethod => {
    const found = endpoint.role.methods.get(name);
    if (found === undefined) throw new Error(`Guardian method ${name} was not registered.`);
    return found;
  };
  // This harness drives a handler directly, with no live tenancy of its own to admit one — so an `active`
  // handler still needs a genuine `ActiveControlAuthorization`, minted the same way `dispatch` mints one, not
  // a same-shaped value cast into the brand.
  const activeAuthorization: ActiveControlAuthorization = mintActiveControlAuthorizationForTesting(new Socket(), 1, {
    instanceId: coordinatorIdentity.instanceId,
    pid: coordinatorIdentity.pid,
    incarnation: coordinatorIdentity.incarnation,
  });
  // `ControlMethod.handle`'s union has no common call signature — `active` requires a second argument the
  // other two authorities' handler types don't declare — so a caller must narrow on `authority` before
  // calling at all; this is what makes every call below well-typed, not merely convenient.
  const call = (name: string, params: unknown): Promise<unknown> | unknown => {
    const entry = method(name);
    if (entry.authority === 'active') return entry.handle(params, activeAuthorization);
    return entry.handle(params);
  };
  const operation = () => ({
    jobId: randomUUID(),
    operationId: randomUUID(),
    proxyInstanceId: shared.proxyInstanceId,
    buildSetId: shared.buildSetId,
  });

  const guardianIdentity = {
    guardianInstanceId: shared.guardianInstanceId,
    pid: 5_102,
    incarnation: testIncarnation(902),
    generation: shared.generation,
    flavor: shared.flavor,
    buildSetId: shared.buildSetId,
    hostFingerprint: FINGERPRINT,
    canonicalControlEndpoint: '/guardian.sock',
  };

  return {
    guardian,
    method,
    call,
    reaperExchange,
    mintReceipt,
    coordinatorIdentity,
    guardianIdentity,
    reaperIdentity,
    proxyIdentity,
    operation,
  };
}

async function armGuardian(harness: GuardianHarness): Promise<void> {
  await harness.guardian.recordContainment(CONTAINMENT);
  harness.reaperExchange.mockClear();
}

function refuseReceiverConsultation(harness: GuardianHarness): void {
  harness.reaperExchange.mockRejectedValueOnce(new Error('receiver was consulted'));
}

describe('guardian outbound schemas', () => {
  it('leaves acquisition publication bounded only by the caller deadline', () => {
    createGuardianHarness();

    expect(
      (endpointHarness.options as ControlEndpointOptions).role.methods.get('guardian.acquisition-publish.v1')?.budgetMs,
    ).toBe('caller-deadline');
  });

  it('returns holder identity and disposition from one status snapshot', async () => {
    const statusIdentity = {
      controlEpoch: 7,
      holder: { instanceId: randomUUID(), pid: 4_007, incarnation: testIncarnation('status-holder') },
    };
    const holderAuthority: ControlHolderAuthority = {
      install: () => {},
      current: () => {
        throw new Error('holder status performed a separate current-holder read');
      },
      phase: () => 'published',
      publish: () => {},
      recordObservation: () => {},
      status: () => ({
        identity: statusIdentity,
        disposition: 'alive',
        transitionSequence: 9,
        changedAtMs: 12_000,
      }),
    };
    const enforcementHold = enforcementHoldStatusSchema.parse({
      kind: 'recorded-group-unattributable',
      attempts: 2,
      roleIdentity: { role: 'guardian', pid: 5_102, incarnation: testIncarnation(902) },
      retry: { state: 'scheduled', nextProbeAtMs: 14_000 },
    });
    const harness = createGuardianHarness(holderAuthority, undefined, () => enforcementHold);
    const grantId = randomUUID();
    const secret = 'f'.repeat(64);
    await harness.call(
      'guardian.handoff-install.v1',
      guardianReaperHandoffInstallParamsSchema.parse({
        grantId,
        secretSha256: createHash('sha256').update(secret, 'utf8').digest('hex'),
        successor: harness.coordinatorIdentity,
        operations: [],
        orphanTimeoutMs: 30_000,
        teardownReserveMs: 14_000,
      }),
    );

    const result = await harness.call('guardian.holder-status.v1', {
      grantId,
      secret,
      generation: harness.guardianIdentity.generation,
      flavor: harness.guardianIdentity.flavor,
      buildSetId: harness.guardianIdentity.buildSetId,
      hostFingerprint: harness.guardianIdentity.hostFingerprint,
      guardianInstanceId: harness.guardianIdentity.guardianInstanceId,
      reaperInstanceId: harness.reaperIdentity.reaperInstanceId,
      proxyInstanceId: harness.proxyIdentity.proxyInstanceId,
    });

    expect(result).toEqual({
      disposition: 'alive',
      phase: 'published',
      holder: statusIdentity.holder,
      controlEpoch: statusIdentity.controlEpoch,
      transitionSequence: 9,
      changedAtMs: 12_000,
      enforcementHold,
    });
  });

  it('replays one stable activation receipt for the exact membership tuple', async () => {
    const harness = createGuardianHarness();
    await armGuardian(harness);
    const operation = harness.operation();
    const reservation = randomUUID();
    const staged = (await harness.call('guardian.register-provider-root.v1', {
      proxy: harness.proxyIdentity,
      operation,
      reservation,
      providerPid: ROOT.pid,
      providerIncarnation: ROOT.incarnation,
    })) as { jointContainmentReceipt: string };
    harness.mintReceipt.mockClear();
    harness.reaperExchange.mockClear();
    const activation = {
      operation,
      reservation,
      providerRoot: ROOT,
      jointContainmentReceipt: staged.jointContainmentReceipt,
    };

    const first = await harness.call('guardian.operation-activate.v1', activation);
    const replay = await harness.call('guardian.operation-activate.v1', activation);

    expect(replay).toEqual(first);
    expect(harness.mintReceipt).toHaveBeenCalledOnce();
    expect(harness.reaperExchange).toHaveBeenCalledOnce();
  });

  it('returns a result with the enforcer reason when teardown latches but absence is not confirmed', async () => {
    const latchTeardown = vi.fn();
    const holderAuthority = createControlHolderAuthority();
    const harness = createGuardianHarness(holderAuthority, {
      latchTeardown,
      observeLiveness: () => {
        throw new Error('absence could not be observed');
      },
    });
    holderAuthority.install({
      controlEpoch: 1,
      holder: {
        instanceId: harness.coordinatorIdentity.instanceId,
        pid: harness.coordinatorIdentity.pid,
        incarnation: harness.coordinatorIdentity.incarnation,
      },
    });
    await armGuardian(harness);

    const result = await harness.call('guardian.containment-commit.v1', {
      guardian: harness.guardianIdentity,
      reaper: harness.reaperIdentity,
      proxy: harness.proxyIdentity,
    });

    expect(latchTeardown).toHaveBeenCalledOnce();
    expect(result).toEqual({
      state: 'teardown-latched-absence-unconfirmed',
      reason: 'absence could not be observed',
    });
  });

  it('throws a pre-latch containment-prepare failure without latching teardown', async () => {
    const latchTeardown = vi.fn();
    const holderAuthority = createControlHolderAuthority();
    const harness = createGuardianHarness(holderAuthority, {
      latchTeardown,
      observeLiveness: () => {
        throw new Error('teardown must not run');
      },
    });
    holderAuthority.install({
      controlEpoch: 1,
      holder: {
        instanceId: harness.coordinatorIdentity.instanceId,
        pid: harness.coordinatorIdentity.pid,
        incarnation: harness.coordinatorIdentity.incarnation,
      },
    });
    await armGuardian(harness);
    harness.reaperExchange.mockRejectedValueOnce(new Error('prepare refused'));

    await expect(
      harness.call('guardian.containment-commit.v1', {
        guardian: harness.guardianIdentity,
        reaper: harness.reaperIdentity,
        proxy: harness.proxyIdentity,
      }),
    ).rejects.toThrow('prepare refused');
    expect(latchTeardown).not.toHaveBeenCalled();
  });

  it('lets the paired proxy release membership idempotently', async () => {
    const harness = createGuardianHarness();
    await armGuardian(harness);
    const operation = harness.operation();
    const reservation = randomUUID();
    await harness.call('guardian.register-provider-root.v1', {
      proxy: harness.proxyIdentity,
      operation,
      reservation,
      providerPid: ROOT.pid,
      providerIncarnation: ROOT.incarnation,
    });
    const release = { proxy: harness.proxyIdentity, operation, reservation };

    expect(harness.method('guardian.operation-release.v1').authority).toBe('pairing');
    expect(harness.call('guardian.operation-release.v1', release)).toEqual({
      state: 'membership-released',
    });
    expect(harness.call('guardian.operation-release.v1', release)).toEqual({
      state: 'membership-absent',
    });
  });

  it('refuses malformed record-containment params before consulting the reaper', async () => {
    const harness = createGuardianHarness();
    refuseReceiverConsultation(harness);

    await expect(
      harness.guardian.recordContainment({
        ...CONTAINMENT,
        unexpected: true,
      } as unknown as GuardianContainmentIdentity),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'unrecognized_keys', keys: ['unexpected'], path: [] })],
    });
    expect(harness.reaperExchange).not.toHaveBeenCalled();
  });

  it('refuses malformed register-provider-root params before consulting the reaper', async () => {
    const harness = createGuardianHarness();
    await armGuardian(harness);
    refuseReceiverConsultation(harness);
    const request = {
      proxy: harness.proxyIdentity,
      operation: harness.operation(),
      reservation: randomUUID(),
      providerPid: 'not-a-pid',
      providerIncarnation: ROOT.incarnation,
    };
    letGuardianIngressYield(guardianRegisterProviderRootParamsSchema, request);

    await expect(harness.call('guardian.register-provider-root.v1', request)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'invalid_type', path: ['providerRoot', 'pid'] })],
    });
    expect(harness.reaperExchange).not.toHaveBeenCalled();
  });

  it('refuses malformed confirm-provider-root params before consulting the reaper', async () => {
    const harness = createGuardianHarness();
    await armGuardian(harness);
    const operation = harness.operation();
    const reservation = randomUUID();
    const staged = (await harness.call('guardian.register-provider-root.v1', {
      proxy: harness.proxyIdentity,
      operation,
      reservation,
      providerPid: ROOT.pid,
      providerIncarnation: ROOT.incarnation,
    })) as { jointContainmentReceipt: string };
    harness.reaperExchange.mockClear();
    refuseReceiverConsultation(harness);
    const request = {
      operation,
      reservation,
      providerRoot: { ...ROOT, unexpected: true },
      jointContainmentReceipt: staged.jointContainmentReceipt,
    };
    letGuardianIngressYield(guardianOperationActivateParamsSchema, request);

    await expect(harness.call('guardian.operation-activate.v1', request)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'unrecognized_keys', keys: ['unexpected'], path: ['providerRoot'] })],
    });
    expect(harness.reaperExchange).not.toHaveBeenCalled();
  });

  it('refuses malformed record-redemption params before consulting the reaper', async () => {
    const harness = createGuardianHarness();
    const grantId = randomUUID();
    const secret = 'f'.repeat(64);
    await harness.call(
      'guardian.handoff-install.v1',
      guardianReaperHandoffInstallParamsSchema.parse({
        grantId,
        secretSha256: createHash('sha256').update(secret, 'utf8').digest('hex'),
        successor: harness.coordinatorIdentity,
        operations: [],
        orphanTimeoutMs: 30_000,
        teardownReserveMs: 14_000,
      }),
    );
    refuseReceiverConsultation(harness);
    const request = {
      grantId,
      secret,
      successor: { ...harness.coordinatorIdentity, unexpected: true },
    };
    letGuardianIngressYield(guardianHandoffRedeemParamsSchema, request);

    await expect(harness.call('guardian.handoff-redeem.v1', request)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'unrecognized_keys', keys: ['unexpected'], path: ['successor'] })],
    });
    expect(harness.reaperExchange).not.toHaveBeenCalled();
  });

  it('refuses a malformed reaper reply before recording the root or minting its receipt', async () => {
    const harness = createGuardianHarness();
    await armGuardian(harness);
    harness.mintReceipt.mockClear();
    harness.reaperExchange.mockResolvedValueOnce(
      controlExchangeForTest({
        kind: 'response',
        response: { kind: 'result', value: { state: 'root-recorded', unexpected: true } },
      }),
    );

    await expect(
      harness.call('guardian.register-provider-root.v1', {
        proxy: harness.proxyIdentity,
        operation: harness.operation(),
        reservation: randomUUID(),
        providerPid: ROOT.pid,
        providerIncarnation: ROOT.incarnation,
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'unrecognized_keys', keys: ['unexpected'], path: [] })],
    });
    expect(harness.reaperExchange).toHaveBeenCalledOnce();
    expect(harness.guardian.enforcer()?.recordedRoots()).toEqual([]);
    expect(harness.mintReceipt).not.toHaveBeenCalled();
  });

  it(
    "answers acquisition-publication-unknown, never a refusal, when reaper.acquisition-publish.v1's own " +
      "reply cannot be confirmed — the reaper's handler publishes before it replies, so a refusal here would " +
      'read as proof of the one thing that did not happen',
    async () => {
      const harness = createGuardianHarness();
      const publishRequest = {
        guardian: harness.guardianIdentity,
        reaper: harness.reaperIdentity,
        proxy: harness.proxyIdentity,
      };
      harness.reaperExchange.mockResolvedValueOnce(
        controlExchangeForTest({
          kind: 'response',
          response: { kind: 'result', value: { state: 'acquisition-published', unexpected: true } },
        }),
      );

      const unconfirmed = (await harness.call('guardian.acquisition-publish.v1', publishRequest)) as {
        state: string;
        reason: string;
      };

      expect(unconfirmed.state).toBe('acquisition-publication-unknown');
      expect(unconfirmed.reason).toEqual(expect.any(String));
      expect(harness.mintReceipt).not.toHaveBeenCalled();

      // Idempotent recovery: a retry after the transient reply problem clears still succeeds, because nothing
      // above committed this guardian to a certificate the first, unconfirmed attempt never minted.
      const published = (await harness.call('guardian.acquisition-publish.v1', publishRequest)) as {
        state: string;
        certificate: string;
      };
      expect(published.state).toBe('acquisition-published');
      expect(published.certificate).toEqual(expect.any(String));
    },
  );

  it(
    'answers acquisition-publication-unknown, never a refusal, when reaper.acquisition-publish.v1 could not ' +
      'be sent at all',
    async () => {
      const harness = createGuardianHarness();
      const publishRequest = {
        guardian: harness.guardianIdentity,
        reaper: harness.reaperIdentity,
        proxy: harness.proxyIdentity,
      };
      harness.reaperExchange.mockRejectedValueOnce(new Error('reaper channel unavailable'));

      const unconfirmed = (await harness.call('guardian.acquisition-publish.v1', publishRequest)) as {
        state: string;
        reason: string;
      };

      expect(unconfirmed.state).toBe('acquisition-publication-unknown');
      expect(unconfirmed.reason).toEqual(expect.any(String));
      expect(harness.mintReceipt).not.toHaveBeenCalled();
    },
  );
});
