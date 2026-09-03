import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import type { ReaperBootstrapCapsule } from '#src/provider-proxy/bootstrap-capsule.js';
import {
  type ControlEndpointOptions,
  type ControlMethod,
  type createControlEndpoint as createControlEndpointType,
} from '#src/provider-proxy/control-endpoint.js';
import type { EnforcementScheduler } from '#src/provider-proxy/enforcement.js';
import { createControlHolderAuthority } from '#src/provider-proxy/holder-lifecycle.js';
import type { EnforcerDeadlineStateMachine } from '#src/provider-proxy/orphan-deadline.js';
import { ProxyControlProtocolError, type CoordinatorIdentity } from '#src/provider-proxy/protocol.js';
import { createReaper } from '#src/provider-proxy/reaper.js';

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

const FINGERPRINT = 'b'.repeat(64);
const SECRET = 'c'.repeat(64);
const reaperTestClockScope: unique symbol = Symbol('reaper-test');

function createHarness(): {
  recordRedemption(params: unknown): unknown;
  rotate(params: unknown): unknown;
  successor: CoordinatorIdentity;
} {
  const clock = createMonotonicClock(reaperTestClockScope, { readMilliseconds: () => 0n });
  const capsule: ReaperBootstrapCapsule = {
    role: 'reaper',
    generation: 'gen2',
    flavor: 'prod',
    buildSetId: randomUUID(),
    hostFingerprint: FINGERPRINT,
    guardianInstanceId: randomUUID(),
    reaperInstanceId: randomUUID(),
    proxyInstanceId: randomUUID(),
    bootstrapNonce: SECRET,
    canonicalControlEndpoint: '/reaper.sock',
    guardianControlEndpoint: '/guardian.sock',
    proxyEndpoint: '/proxy.sock',
    guardianReaperAuthSecret: SECRET,
  };
  const deadlines: EnforcerDeadlineStateMachine<typeof reaperTestClockScope> = {
    state: () => 'accepting-control',
    orphanTimeoutMs: () => 30_000,
    bounds: () => {
      const now = clock.now();
      return {
        lastRoundTripEvidenceAt: now,
        eofAt: null,
        controlLossAt: now,
        adoptionDeadline: clock.shiftMilliseconds(now, 60_000),
        exitDeadline: clock.shiftMilliseconds(now, 74_000),
        holderCheckAt: clock.shiftMilliseconds(now, 60_000),
        holderCheckAccelerated: false,
      };
    },
    issueFirstChallenge: () => ({ accepted: true, challenge: 'challenge' }),
    controlIsLive: () => true,
    echoChallenge: () => ({ accepted: true, nextChallenge: 'next-challenge' }),
    reattachControl: () => ({ accepted: true }),
    observeEof: () => {},
    admitSuccessor: () => ({ accepted: true, challenge: 'challenge' }),
    observePairingLoss: () => {},
    renewHolderCheck: () => {},
    latchTeardown: () => {},
    markContainmentAbsent: () => {},
    markExited: () => {},
  };
  const scheduler: EnforcementScheduler = { schedule: () => ({}), cancel: () => {} };

  createReaper({
    capsule,
    clock,
    deadlines,
    containmentEnvironment: {
      clock,
      process: { kill: () => true, observeLiveness: () => 'absent' },
      platform: 'linux',
      maxRecordedRoots: 128,
      readProcessIncarnation: () => null,
    },
    scheduler,
    timer: { setTimeout: () => ({}), clearTimeout: () => {} },
    mintReceipt: () => 'reaper-receipt',
    self: { pid: 5_001, incarnation: testIncarnation('reaper') },
    holderAuthority: createControlHolderAuthority(),
    observeHolder: () => Promise.resolve('unknown'),
    abandonUnattributable: () => false,
    onOutcome: () => {},
    onProgressViolation: () => {},
  });

  const method = (name: string): ControlMethod => {
    const found = (endpointHarness.options as ControlEndpointOptions).role.methods.get(name);
    if (found === undefined) throw new Error(`Reaper method ${name} was not registered.`);
    return found;
  };
  const recordRedemption = (params: unknown): unknown => {
    const entry = method('reaper.record-redemption.v1');
    if (entry.authority !== 'pairing') throw new Error('record-redemption must require pairing authority');
    return entry.handle(params);
  };
  const rotate = (params: unknown): unknown => {
    const entry = method('reaper.handoff-rotate.v1');
    if (entry.authority !== 'establishes-control') throw new Error('handoff-rotate must establish control');
    return entry.handle(params);
  };
  const successor: CoordinatorIdentity = {
    instanceId: randomUUID(),
    pid: 4_001,
    incarnation: testIncarnation('successor'),
    generation: capsule.generation,
    flavor: capsule.flavor,
    buildSetId: capsule.buildSetId,
  };

  return { recordRedemption, rotate, successor };
}

function refusalCode(action: () => unknown): ProxyControlProtocolError['code'] {
  try {
    action();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ProxyControlProtocolError);
    return (error as ProxyControlProtocolError).code;
  }
  throw new Error('Expected the reaper handler to refuse the request.');
}

function changedPid(successor: CoordinatorIdentity): CoordinatorIdentity {
  return { ...successor, pid: successor.pid + 1 };
}

function changedIncarnation(successor: CoordinatorIdentity): CoordinatorIdentity {
  return { ...successor, incarnation: testIncarnation('different-successor') };
}

describe('reaper redemption successor identity', () => {
  it('accepts an identical repeat recording of the full successor holder', () => {
    const harness = createHarness();
    const request = {
      grantId: randomUUID(),
      successor: harness.successor,
      operations: [],
      redemptionReceipt: 'guardian-redemption',
    };

    expect(harness.recordRedemption(request)).toEqual({ state: 'redemption-recorded' });
    expect(harness.recordRedemption(request)).toEqual({ state: 'redemption-recorded' });
  });

  it.each([
    ['pid', changedPid],
    ['incarnation', changedIncarnation],
  ] as const)('refuses a repeat recording with the same instance id but a different %s', (_field, change) => {
    const harness = createHarness();
    const request = {
      grantId: randomUUID(),
      successor: harness.successor,
      operations: [],
      redemptionReceipt: 'guardian-redemption',
    };
    harness.recordRedemption(request);

    expect(refusalCode(() => harness.recordRedemption({ ...request, successor: change(harness.successor) }))).toBe(
      'identity_mismatch',
    );
  });

  it.each([
    ['pid', changedPid],
    ['incarnation', changedIncarnation],
  ] as const)('refuses rotation with the same instance id but a different %s', (_field, change) => {
    const harness = createHarness();
    const grantId = randomUUID();
    const redemptionReceipt = 'guardian-redemption';
    harness.recordRedemption({
      grantId,
      successor: harness.successor,
      operations: [],
      redemptionReceipt,
    });

    expect(
      refusalCode(() =>
        harness.rotate({
          grantId,
          successor: change(harness.successor),
          guardianRedemptionReceipt: redemptionReceipt,
        }),
      ),
    ).toBe('grant_invalid');
  });
});
