import { createHash, randomUUID } from 'node:crypto';

import type { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMonotonicClock, type MonotonicClock } from '#src/infra/monotonic-clock.js';
import type { ControlClient } from '#src/provider-proxy/control-client.js';
import type {
  ControlEndpointOptions,
  ControlMethod,
  createControlEndpoint as createControlEndpointType,
} from '#src/provider-proxy/control-endpoint.js';
import type { EnforcementScheduler } from '#src/provider-proxy/enforcement.js';
import { createGuardian, type GuardianContainmentIdentity } from '#src/provider-proxy/guardian.js';
import {
  guardianHandoffRedeemParamsSchema,
  guardianReaperHandoffInstallParamsSchema,
} from '#src/provider-proxy/handoff-capsule.js';
import type { EnforcerDeadlineStateMachine } from '#src/provider-proxy/orphan-deadline.js';
import {
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
const CONTAINMENT = { pid: 5_100, processStartedAtSeconds: 900, processGroupId: 5_100, containmentKind: 'posix-group' };
const ROOT = { pid: 6_001, processStartedAtSeconds: 800 };
const idleScheduler: EnforcementScheduler = { schedule: () => ({}), cancel: () => {} };
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  endpointHarness.options = undefined;
  vi.restoreAllMocks();
});

function deadlinesFor<Scope extends symbol>(clock: MonotonicClock<Scope>): EnforcerDeadlineStateMachine<Scope> {
  return {
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
    bounds: () => ({
      lastRoundTripEvidenceAt: clock.now(),
      eofAt: null,
      controlLossAt: clock.now(),
      adoptionDeadline: clock.shiftMilliseconds(clock.now(), 60_000),
      exitDeadline: clock.shiftMilliseconds(clock.now(), 74_000),
      firstChallengeExpiresAt: null,
    }),
    state: () => 'accepting-control' as const,
  };
}

function letGuardianIngressYield(schema: z.ZodTypeAny, request: unknown): void {
  vi.spyOn(schema, 'parse').mockReturnValueOnce(request as never);
}

type GuardianHarness = ReturnType<typeof createGuardianHarness>;

function createGuardianHarness() {
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
    processStartedAtSeconds: 700,
    generation: shared.generation,
    flavor: shared.flavor,
    buildSetId: shared.buildSetId,
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
    canonicalEndpoint: '/proxy.sock',
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
    canonicalControlEndpoint: '/reaper.sock',
    containmentKind: CONTAINMENT.containmentKind,
  };
  const reaperCall = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'reaper.record-containment.v1') {
      return { state: 'containment-recorded', reaper: reaperIdentity };
    }
    if (method === 'reaper.record-redemption.v1') return { state: 'redemption-recorded' };
    return { state: 'root-recorded' };
  });
  const reaperChannel: ControlClient = { call: reaperCall, close: vi.fn() };
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
    deadlines: deadlinesFor(clock),
    containmentEnvironment: {
      clock,
      process: { kill: () => true, isAlive: () => true },
      platform: 'linux',
      maxRecordedRoots: 128,
      readProcessStartedAtSeconds: () => CONTAINMENT.processStartedAtSeconds,
    },
    scheduler: idleScheduler,
    timer: {
      setTimeout: () => ({}),
      clearTimeout: () => {},
    },
    mintReceipt,
    reaperChannel,
    self: { pid: 5_102, processStartedAtSeconds: 902 },
    reaperSelf: { pid: reaperIdentity.pid, processStartedAtSeconds: reaperIdentity.processStartedAtSeconds },
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
  const operation = () => ({
    jobId: randomUUID(),
    operationId: randomUUID(),
    proxyInstanceId: shared.proxyInstanceId,
    buildSetId: shared.buildSetId,
  });

  return { guardian, method, reaperCall, mintReceipt, coordinatorIdentity, proxyIdentity, operation };
}

async function armGuardian(harness: GuardianHarness): Promise<void> {
  await harness.guardian.recordContainment(CONTAINMENT);
  harness.reaperCall.mockClear();
}

function refuseReceiverConsultation(harness: GuardianHarness): void {
  harness.reaperCall.mockRejectedValueOnce(new Error('receiver was consulted'));
}

describe('guardian outbound schemas', () => {
  it('replays one stable activation receipt for the exact membership tuple', async () => {
    const harness = createGuardianHarness();
    await armGuardian(harness);
    const operation = harness.operation();
    const reservation = randomUUID();
    const staged = (await harness.method('guardian.register-provider-root.v1').handle({
      proxy: harness.proxyIdentity,
      operation,
      reservation,
      providerPid: ROOT.pid,
      providerProcessStartedAtSeconds: ROOT.processStartedAtSeconds,
    })) as { jointContainmentReceipt: string };
    harness.mintReceipt.mockClear();
    harness.reaperCall.mockClear();
    const activation = {
      operation,
      reservation,
      providerRoot: ROOT,
      jointContainmentReceipt: staged.jointContainmentReceipt,
    };

    const first = await harness.method('guardian.operation-activate.v1').handle(activation);
    const replay = await harness.method('guardian.operation-activate.v1').handle(activation);

    expect(replay).toEqual(first);
    expect(harness.mintReceipt).toHaveBeenCalledOnce();
    expect(harness.reaperCall).toHaveBeenCalledOnce();
  });

  it('lets the paired proxy release membership idempotently', async () => {
    const harness = createGuardianHarness();
    await armGuardian(harness);
    const operation = harness.operation();
    const reservation = randomUUID();
    await harness.method('guardian.register-provider-root.v1').handle({
      proxy: harness.proxyIdentity,
      operation,
      reservation,
      providerPid: ROOT.pid,
      providerProcessStartedAtSeconds: ROOT.processStartedAtSeconds,
    });
    const release = { proxy: harness.proxyIdentity, operation, reservation };

    expect(harness.method('guardian.operation-release.v2').authority).toBe('pairing');
    expect(harness.method('guardian.operation-release.v2').handle(release)).toEqual({
      state: 'membership-released',
    });
    expect(harness.method('guardian.operation-release.v2').handle(release)).toEqual({
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
    expect(harness.reaperCall).not.toHaveBeenCalled();
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
      providerProcessStartedAtSeconds: ROOT.processStartedAtSeconds,
    };
    letGuardianIngressYield(guardianRegisterProviderRootParamsSchema, request);

    await expect(harness.method('guardian.register-provider-root.v1').handle(request)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'invalid_type', path: ['providerRoot', 'pid'] })],
    });
    expect(harness.reaperCall).not.toHaveBeenCalled();
  });

  it('refuses malformed confirm-provider-root params before consulting the reaper', async () => {
    const harness = createGuardianHarness();
    await armGuardian(harness);
    const operation = harness.operation();
    const reservation = randomUUID();
    const staged = (await harness.method('guardian.register-provider-root.v1').handle({
      proxy: harness.proxyIdentity,
      operation,
      reservation,
      providerPid: ROOT.pid,
      providerProcessStartedAtSeconds: ROOT.processStartedAtSeconds,
    })) as { jointContainmentReceipt: string };
    harness.reaperCall.mockClear();
    refuseReceiverConsultation(harness);
    const request = {
      operation,
      reservation,
      providerRoot: { ...ROOT, unexpected: true },
      jointContainmentReceipt: staged.jointContainmentReceipt,
    };
    letGuardianIngressYield(guardianOperationActivateParamsSchema, request);

    await expect(harness.method('guardian.operation-activate.v1').handle(request)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'unrecognized_keys', keys: ['unexpected'], path: ['providerRoot'] })],
    });
    expect(harness.reaperCall).not.toHaveBeenCalled();
  });

  it('refuses malformed record-redemption params before consulting the reaper', async () => {
    const harness = createGuardianHarness();
    const grantId = randomUUID();
    const secret = 'f'.repeat(64);
    await harness.method('guardian.handoff-install.v1').handle(
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

    await expect(harness.method('guardian.handoff-redeem.v1').handle(request)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'unrecognized_keys', keys: ['unexpected'], path: ['successor'] })],
    });
    expect(harness.reaperCall).not.toHaveBeenCalled();
  });

  it('refuses a malformed reaper reply before recording the root or minting its receipt', async () => {
    const harness = createGuardianHarness();
    await armGuardian(harness);
    harness.mintReceipt.mockClear();
    harness.reaperCall.mockResolvedValueOnce({ state: 'root-recorded', unexpected: true });

    await expect(
      harness.method('guardian.register-provider-root.v1').handle({
        proxy: harness.proxyIdentity,
        operation: harness.operation(),
        reservation: randomUUID(),
        providerPid: ROOT.pid,
        providerProcessStartedAtSeconds: ROOT.processStartedAtSeconds,
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'unrecognized_keys', keys: ['unexpected'], path: [] })],
    });
    expect(harness.reaperCall).toHaveBeenCalledOnce();
    expect(harness.guardian.enforcer()?.recordedRoots()).toEqual([]);
    expect(harness.mintReceipt).not.toHaveBeenCalled();
  });
});
