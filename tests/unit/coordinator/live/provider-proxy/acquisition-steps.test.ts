import type * as RoleControlModule from '#src/coordinator/live/provider-proxy/role-control.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { strictControlExchangeResult as strictTestExchange } from '#tests/support/control-exchange.js';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('#src/provider-proxy/bootstrap-capsule.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return { ...original, createProviderBootstrapCapsule: vi.fn() };
});

vi.mock('#src/provider-proxy/role-spawn.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return {
    ...original,
    spawnRoleProcess: vi.fn(() => ({ pid: 101, incarnation: testIncarnation(11) })),
  };
});

vi.mock('#src/coordinator/live/provider-proxy/role-control.js', async (importOriginal) => ({
  ...(await importOriginal<typeof RoleControlModule>()),
  establishRoleControl: vi.fn(),
}));

vi.mock('#src/coordinator/live/provider-proxy/set-authority.js', () => ({
  createProviderProxySetAuthority: vi.fn(),
}));

vi.mock('#src/provider-proxy/handoff-capsule.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return { ...original, readHandoffCapsuleFile: vi.fn() };
});

import { createProviderProxyAcquisitionSteps } from '#src/coordinator/live/provider-proxy/acquisition-steps.js';
import {
  closeProviderProxyAcquisitionSession,
  providerProxyAcquisitionSessionDescriptor,
} from '#src/coordinator/live/provider-proxy/control-session.js';
import {
  exchangeAcquisitionStage,
  runProviderProxySetPublicationTransaction,
} from '#src/coordinator/live/provider-proxy/set-publication.js';
import {
  acquisitionPublicationUnknownResultSchema,
  guardianAcquisitionPublishResultSchema,
  proxyAcquisitionPublishResultSchema,
} from '#src/provider-proxy/protocol.js';
import { readHandoffCapsuleFile, type HandoffCapsuleV3 } from '#src/provider-proxy/handoff-capsule.js';
import {
  isProviderProxyOperationAuthority,
  notifyProviderProxyControlEstablished,
  subscribeProviderProxyControlEstablished,
} from '#src/coordinator/live/provider-proxy/operation-route.js';
import { establishRoleControl } from '#src/coordinator/live/provider-proxy/role-control.js';
import { createProviderProxySetAuthority } from '#src/coordinator/live/provider-proxy/set-authority.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set/claim-mirror.js';
import { ProviderProxySetLifecycle } from '#src/coordinator/services/provider-proxy-set/index.js';
import type { ControlClient, ControlExchange } from '#src/provider-proxy/control-client.js';
import {
  connectControlClient,
  ControlClientError,
  controlExchangeForTest,
} from '#src/provider-proxy/control-client.js';
import { createControlEndpoint, type ControlChallengeAuthority } from '#src/provider-proxy/control-endpoint.js';
import { createControlHolderAuthority } from '#src/provider-proxy/holder-lifecycle.js';
import { ControlLeaseEvidence } from '#src/provider-proxy/control-lease.js';
import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import {
  CORAL_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS_ENV,
  PROXY_CONTROL_HEARTBEAT_MS,
  PROXY_CONTROL_LEASE_MS,
  PROXY_TEARDOWN_RESERVE_MS,
} from '#src/provider-proxy/orphan-deadline.js';
import { spawnRoleProcess } from '#src/provider-proxy/role-spawn.js';
import type { CoordinatorIdentity } from '#src/provider-proxy/protocol.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { flushMicrotasks, VirtualTime } from '#tools/simulation/core/virtual-time.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import {
  createTestProviderProxyContainmentProofProducer,
  createTestProviderProxyRecoveryDispatcher,
} from '#tests/helpers/provider-proxy-recovery-dispatcher.js';

/** The build this fixture lifecycle belongs to — the same one `providerOperationRecord` stamps on its identities, so a discovered capsule is inheritable rather than foreign. */
const FIXTURE_BUILD_SET_ID = '00000000-0000-4000-8000-000000000004';

/** Schema-valid but otherwise unchecked identities for `guardian.acquisition-publish.v1`'s faked reply — the
 *  fixture proxy below does not verify the certificate binding, so these need only satisfy the strict schema. */
const ACQUISITION_PUBLISH_GUARDIAN_IDENTITY = {
  guardianInstanceId: '99999999-9999-4999-8999-999999999991',
  pid: 9_001,
  incarnation: testIncarnation(9_001),
  generation: 'gen2' as const,
  flavor: 'prod' as const,
  buildSetId: '99999999-9999-4999-8999-999999999999',
  hostFingerprint: 'a'.repeat(64),
  canonicalControlEndpoint: '/tmp/coral-acquisition-test-guardian.sock',
};
const ACQUISITION_PUBLISH_REAPER_IDENTITY = {
  reaperInstanceId: '99999999-9999-4999-8999-999999999992',
  pid: 9_002,
  incarnation: testIncarnation(9_002),
  guardianInstanceId: ACQUISITION_PUBLISH_GUARDIAN_IDENTITY.guardianInstanceId,
  generation: 'gen2' as const,
  flavor: 'prod' as const,
  buildSetId: ACQUISITION_PUBLISH_GUARDIAN_IDENTITY.buildSetId,
  hostFingerprint: 'a'.repeat(64),
  canonicalControlEndpoint: '/tmp/coral-acquisition-test-reaper.sock',
  containmentKind: 'detached-process-group',
};
const ACQUISITION_PUBLISH_PROXY_IDENTITY = {
  proxyInstanceId: '99999999-9999-4999-8999-999999999993',
  guardianInstanceId: ACQUISITION_PUBLISH_GUARDIAN_IDENTITY.guardianInstanceId,
  reaperInstanceId: ACQUISITION_PUBLISH_REAPER_IDENTITY.reaperInstanceId,
  pid: 9_003,
  incarnation: testIncarnation(9_003),
  processGroupId: 9_003,
  generation: 'gen2' as const,
  flavor: 'prod' as const,
  buildSetId: ACQUISITION_PUBLISH_GUARDIAN_IDENTITY.buildSetId,
  hostFingerprint: ACQUISITION_PUBLISH_GUARDIAN_IDENTITY.hostFingerprint,
  canonicalEndpoint: '/tmp/coral-acquisition-test-proxy.sock',
};

const mockedEstablishRoleControl = vi.mocked(establishRoleControl);
const mockedCreateSetAuthority = vi.mocked(createProviderProxySetAuthority);
const mockedReadHandoffCapsule = vi.mocked(readHandoffCapsuleFile);
const containmentProofDb = newRawDatabase(':memory:');
applyBundledStoreSchema(containmentProofDb, currentCoralStoreFormat());
afterAll(() => containmentProofDb.close());

const publicationUnknownCapsule: HandoffCapsuleV3 = {
  version: 3,
  grantId: '77777777-7777-4777-8777-777777777777',
  secret: 'c'.repeat(64),
  generation: 'gen2',
  flavor: 'prod',
  buildSetId: ACQUISITION_PUBLISH_GUARDIAN_IDENTITY.buildSetId,
  hostFingerprint: ACQUISITION_PUBLISH_GUARDIAN_IDENTITY.hostFingerprint,
  guardianInstanceId: ACQUISITION_PUBLISH_GUARDIAN_IDENTITY.guardianInstanceId,
  reaperInstanceId: ACQUISITION_PUBLISH_REAPER_IDENTITY.reaperInstanceId,
  proxyInstanceId: '77777777-7777-4777-8777-777777777773',
  guardianControlEndpoint: ACQUISITION_PUBLISH_GUARDIAN_IDENTITY.canonicalControlEndpoint,
  reaperControlEndpoint: ACQUISITION_PUBLISH_REAPER_IDENTITY.canonicalControlEndpoint,
  proxyEndpoint: '/tmp/coral-acquisition-test-proxy.sock',
  orphanTimeoutMs: 30_000,
  teardownReserveMs: 14_000,
  guardianPid: ACQUISITION_PUBLISH_GUARDIAN_IDENTITY.pid,
  guardianIncarnation: ACQUISITION_PUBLISH_GUARDIAN_IDENTITY.incarnation,
  proxyPid: 201,
  reaperPid: ACQUISITION_PUBLISH_REAPER_IDENTITY.pid,
  reaperIncarnation: ACQUISITION_PUBLISH_REAPER_IDENTITY.incarnation,
  containmentKind: 'posix-group',
  proxyIncarnation: testIncarnation(21),
  proxyProcessGroupId: 201,
};
mockedReadHandoffCapsule.mockReturnValue(publicationUnknownCapsule);

function passiveClient(): ControlClient {
  return {
    exchange: async (method) => {
      if (method === 'guardian.acquisition-publish.v1') {
        return controlExchangeForTest({
          kind: 'response',
          response: {
            kind: 'result',
            value: {
              state: 'acquisition-published',
              certificate: 'test-acquisition-certificate',
              guardian: ACQUISITION_PUBLISH_GUARDIAN_IDENTITY,
              reaper: ACQUISITION_PUBLISH_REAPER_IDENTITY,
            },
          },
        });
      }
      if (method === 'proxy.acquisition-publish.v1') {
        return controlExchangeForTest({
          kind: 'response',
          response: { kind: 'result', value: { state: 'acquisition-published' } },
        });
      }
      if (method === 'guardian.containment-commit.v1') {
        return controlExchangeForTest({
          kind: 'response',
          response: { kind: 'result', value: { state: 'containment-absent', disappearanceReceipt: 'gone' } },
        });
      }
      return controlExchangeForTest({
        kind: 'response',
        response: { kind: 'result', value: { state: 'active', nextHeartbeatChallenge: 'next' } },
      });
    },
    faulted: new Promise<never>(() => undefined),
    onFault: () => () => undefined,
    close: () => undefined,
  };
}

async function proxyLeaseSession(
  time: VirtualTime,
  publicationHandler: (params: unknown) => Promise<unknown> | unknown = () => ({
    state: 'acquisition-published',
  }),
  requestTimeoutMs = 5_000,
) {
  const socketPath = `/tmp/coral-acquisition-heartbeat-${randomUUID()}.sock`;
  const scope = Symbol('acquisition-heartbeat');
  const clock = createMonotonicClock(scope, { readMilliseconds: () => BigInt(time.now()) });
  const lease = new ControlLeaseEvidence(clock, PROXY_CONTROL_LEASE_MS, clock.now());
  let challengeNumber = 0;
  let acceptedEchoes = 0;
  const mintChallenge = () => `acquisition-challenge-${challengeNumber++}`;
  const challenges: ControlChallengeAuthority = {
    issueFirstChallenge: () => {
      const challenge = mintChallenge();
      return lease.issueFirstChallenge(challenge)
        ? { accepted: true, challenge }
        : { accepted: false, reason: 'already-issued' };
    },
    admitSuccessor: () => ({ accepted: false, reason: 'not-used' }),
    reattachControl: () => ({ accepted: true }),
    controlIsLive: () => lease.isControlLive(clock.now()),
    echoChallenge: (challenge) => {
      const nextChallenge = mintChallenge();
      const result = lease.echoChallenge(clock.now(), challenge, nextChallenge);
      if (!result.accepted) return result;
      acceptedEchoes += 1;
      return { accepted: true, nextChallenge };
    },
  };
  const endpoint = createControlEndpoint({
    socketPath,
    role: {
      heartbeatMethod: 'control.heartbeat.v1',
      methods: new Map([
        [
          'role.open.v1',
          {
            authority: 'establishes-control' as const,
            handle: async () => ({
              holder: { instanceId: 'coordinator', pid: 1, incarnation: testIncarnation(1) },
              fields: {},
            }),
          },
        ],
        [
          'proxy.acquisition-publish.v1',
          {
            // The real `proxy.acquisition-publish.v1` verifies the certificate binding structurally; this
            // fixture proxy is not under test for that check, so it accepts unconditionally.
            authority: 'active' as const,
            handle: publicationHandler,
          },
        ],
      ]),
    },
    challenges,
    observer: { onControlLost: () => undefined },
    timer: time,
    holderAuthority: createControlHolderAuthority(),
    requestTimeoutMs,
  });
  await endpoint.listen();
  const client = await connectControlClient(socketPath, time, 5_000);
  const opened = (await strictTestExchange(client, 'role.open.v1', {})) as {
    controlEpoch: number;
    heartbeatChallenge: string;
  };
  const first = (await strictTestExchange(client, 'control.heartbeat.v1', {
    controlEpoch: opened.controlEpoch,
    heartbeatChallenge: opened.heartbeatChallenge,
  })) as { nextHeartbeatChallenge: string };
  const watchdog = time.setInterval(() => {
    if (!lease.isControlLive(clock.now())) void endpoint.close();
  }, 1_000);
  return {
    client,
    opened,
    nextHeartbeatChallenge: first.nextHeartbeatChallenge,
    acceptedEchoes: () => acceptedEchoes,
    controlIsLive: () => lease.isControlLive(clock.now()),
    close: async () => {
      time.clearInterval(watchdog);
      client.close();
      await endpoint.close();
    },
  };
}

async function advanceEndpointClock(
  time: VirtualTime,
  durationMs: number,
  heartbeatOriginMs: number,
  acceptedEchoes: () => number,
): Promise<void> {
  let remaining = durationMs;
  while (remaining > 0) {
    const step = Math.min(1_000, remaining);
    time.tick(step);
    remaining -= step;
    const expectedEchoes = 1 + Math.floor((time.now() - heartbeatOriginMs) / PROXY_CONTROL_HEARTBEAT_MS);
    if (acceptedEchoes() < expectedEchoes) {
      await vi.waitFor(() => expect(acceptedEchoes()).toBe(expectedEchoes));
    }
  }
}

describe('exchangeAcquisitionStage', () => {
  const publicationRoles = ['guardian', 'proxy'] as const;

  function clientAnswering(value: unknown): ControlClient {
    return {
      exchange: async () => controlExchangeForTest({ kind: 'response', response: { kind: 'result', value } }),
      faulted: new Promise<never>(() => undefined),
      onFault: () => () => undefined,
      close: () => undefined,
    };
  }

  function publicationSuccess(role: (typeof publicationRoles)[number]): ControlExchange {
    return controlExchangeForTest({
      kind: 'response',
      response: {
        kind: 'result',
        value:
          role === 'guardian'
            ? {
                state: 'acquisition-published',
                certificate: 'test-acquisition-certificate',
                guardian: ACQUISITION_PUBLISH_GUARDIAN_IDENTITY,
                reaper: ACQUISITION_PUBLISH_REAPER_IDENTITY,
              }
            : { state: 'acquisition-published' },
      },
    });
  }

  async function runPublicationWith(role: (typeof publicationRoles)[number], exchange: ControlClient['exchange']) {
    const stageClient = { ...passiveClient(), exchange };
    return runProviderProxySetPublicationTransaction(
      role === 'guardian' ? stageClient : passiveClient(),
      role === 'proxy' ? stageClient : passiveClient(),
      ACQUISITION_PUBLISH_GUARDIAN_IDENTITY,
      ACQUISITION_PUBLISH_REAPER_IDENTITY,
      ACQUISITION_PUBLISH_PROXY_IDENTITY,
    );
  }

  it('classifies an explicit acquisition-publication-unknown reply as unknown, never not-attempted, never ok', async () => {
    // The guardian's own reply schema for this stage is a discriminated union that includes this exact
    // shape — proving the check fires before `resultSchema.safeParse` would otherwise read it as `'ok'`.
    const client = clientAnswering({
      state: 'acquisition-publication-unknown',
      reason: 'reaper.acquisition-publish.v1 could not be confirmed',
    });

    const outcome = await exchangeAcquisitionStage(
      client,
      'guardian.acquisition-publish.v1',
      {},
      guardianAcquisitionPublishResultSchema,
    );

    expect(outcome).toEqual({
      kind: 'unknown',
      reason: 'reaper.acquisition-publish.v1 could not be confirmed',
    });
  });

  it.each(publicationRoles)('keeps a first-attempt %s publication non-attempt without retrying', async (role) => {
    const exchange = vi.fn(async () =>
      controlExchangeForTest({
        kind: 'not-sent',
        cause: 'connection-already-closed',
        error: new Error(`${role} connection was already closed`),
      }),
    );
    const outcome = await runPublicationWith(role, exchange);

    expect(outcome).toEqual({
      kind: 'not-attempted',
      role,
      reason: `${role} connection was already closed`,
    });
    expect(exchange).toHaveBeenCalledOnce();
  });

  it.each(publicationRoles)('keeps %s publication unknown when its retry was not sent', async (role) => {
    const exchange = vi
      .fn<ControlClient['exchange']>()
      .mockResolvedValueOnce(
        controlExchangeForTest({
          kind: 'no-response',
          cause: 'connection-closed-after-write',
          error: new ControlClientError('control_client_closed', `${role} reply was lost`, 'closed'),
        }),
      )
      .mockResolvedValueOnce(
        controlExchangeForTest({
          kind: 'not-sent',
          cause: 'connection-already-closed',
          error: new Error(`${role} retry was not sent`),
        }),
      );

    const outcome = await runPublicationWith(role, exchange);

    expect(outcome).toEqual({
      kind: 'publication-unknown',
      role,
      reason: `First attempt was unknown: ${role} reply was lost; retry was not-attempted: ${role} retry was not sent`,
    });
    expect(exchange).toHaveBeenCalledTimes(2);
  });

  it.each(publicationRoles)('accepts confirmed %s publication success on retry', async (role) => {
    const exchange = vi
      .fn<ControlClient['exchange']>()
      .mockResolvedValueOnce(
        controlExchangeForTest({
          kind: 'no-response',
          cause: 'timeout',
          error: new ControlClientError('control_call_failed', `${role} reply timed out`, 'timeout'),
        }),
      )
      .mockResolvedValueOnce(publicationSuccess(role));

    await expect(runPublicationWith(role, exchange)).resolves.toMatchObject({ kind: 'published' });
    expect(exchange).toHaveBeenCalledTimes(2);
  });

  it(
    'still classifies a confirmed published reply as ok, and an undecodable reply as unknown via the ' +
      'untouched safeParse fallback',
    async () => {
      const published = {
        state: 'acquisition-published',
        certificate: 'cert-1',
        guardian: ACQUISITION_PUBLISH_GUARDIAN_IDENTITY,
        reaper: ACQUISITION_PUBLISH_REAPER_IDENTITY,
      };
      const publishedOutcome = await exchangeAcquisitionStage(
        clientAnswering(published),
        'guardian.acquisition-publish.v1',
        {},
        guardianAcquisitionPublishResultSchema,
      );
      expect(publishedOutcome).toEqual({ kind: 'ok', value: published });

      const undecodableOutcome = await exchangeAcquisitionStage(
        clientAnswering({ state: 'something-else' }),
        'guardian.acquisition-publish.v1',
        {},
        guardianAcquisitionPublishResultSchema,
      );
      expect(undecodableOutcome.kind).toBe('unknown');
    },
  );

  it('parses the same acquisition-publication-unknown shape via its own standalone schema', () => {
    const value = { state: 'acquisition-publication-unknown', reason: 'x' };
    expect(acquisitionPublicationUnknownResultSchema.safeParse(value).success).toBe(true);
  });

  it('keeps an endpoint budget refusal unknown when the dispatched handler later mutates', async () => {
    const time = new VirtualTime();
    let releaseHandler = (): void => {
      throw new Error('publication handler did not start');
    };
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let handlerStarted = false;
    let mutated = false;
    const proxy = await proxyLeaseSession(
      time,
      async () => {
        handlerStarted = true;
        await handlerGate;
        mutated = true;
        return { state: 'acquisition-published' };
      },
      100,
    );

    try {
      const pending = exchangeAcquisitionStage(
        proxy.client,
        'proxy.acquisition-publish.v1',
        {},
        proxyAcquisitionPublishResultSchema,
      );
      await vi.waitFor(() => expect(handlerStarted).toBe(true));
      time.tick(100);

      await expect(pending).resolves.toMatchObject({ kind: 'unknown' });
      releaseHandler();
      await flushMicrotasks();
      expect(mutated).toBe(true);
    } finally {
      releaseHandler();
      await proxy.close();
    }
  });

  it('classifies an endpoint-certified pre-dispatch refusal as not attempted', async () => {
    const time = new VirtualTime();
    const socketPath = `/tmp/coral-acquisition-refusal-${randomUUID()}.sock`;
    const handler = vi.fn(() => ({ state: 'acquisition-published' }));
    const endpoint = createControlEndpoint({
      socketPath,
      role: {
        heartbeatMethod: 'control.heartbeat.v1',
        methods: new Map([
          [
            'proxy.acquisition-publish.v1',
            {
              authority: 'active' as const,
              handle: handler,
            },
          ],
        ]),
      },
      challenges: {
        issueFirstChallenge: () => ({ accepted: false }),
        admitSuccessor: () => ({ accepted: false }),
        reattachControl: () => ({ accepted: false }),
        controlIsLive: () => false,
        echoChallenge: () => ({ accepted: false, reason: 'teardown-latched' }),
      },
      observer: { onControlLost: () => undefined },
      timer: time,
      holderAuthority: createControlHolderAuthority(),
      requestTimeoutMs: 5_000,
    });
    await endpoint.listen();
    const client = await connectControlClient(socketPath, time, 5_000);

    try {
      const outcome = await exchangeAcquisitionStage(
        client,
        'proxy.acquisition-publish.v1',
        {},
        proxyAcquisitionPublishResultSchema,
      );

      expect(outcome).toMatchObject({ kind: 'not-attempted' });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      client.close();
      await endpoint.close();
    }
  });
});

describe('createProviderProxyAcquisitionSteps', () => {
  it('keeps proxy control live while guardian and reaper each consume 8500ms', async () => {
    const time = new VirtualTime();
    const realRuntime = createRealRuntime('prod');
    const runtime = {
      ...realRuntime,
      time,
      env: {
        ...realRuntime.env,
        get: (key: string) => (key === CORAL_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS_ENV ? '74000' : realRuntime.env.get(key)),
      },
    };
    const proxy = await proxyLeaseSession(time);
    const guardian = passiveClient();
    const guardianExchange = vi.spyOn(guardian, 'exchange');
    const reaper = passiveClient();
    const heartbeatOriginMs = time.now();
    mockedEstablishRoleControl.mockImplementation(async (opened, _timer, _retry, plan) => {
      const role = plan.role;
      if (role === 'guardian') await advanceEndpointClock(time, 8_500, heartbeatOriginMs, proxy.acceptedEchoes);
      if (role === 'reaper') await advanceEndpointClock(time, 8_500, heartbeatOriginMs, proxy.acceptedEchoes);
      const client = role === 'proxy' ? proxy.client : role === 'guardian' ? guardian : reaper;
      opened.push(client);
      const identity =
        role === 'proxy'
          ? { ...plan.expectedIdentity, pid: 201, incarnation: testIncarnation(21), processGroupId: 201 }
          : role === 'reaper'
            ? { ...plan.expectedIdentity, pid: 301, incarnation: testIncarnation(31) }
            : plan.expectedIdentity;
      return {
        client,
        opened: {
          controlEpoch: role === 'proxy' ? proxy.opened.controlEpoch : role === 'guardian' ? 2 : 3,
          heartbeatChallenge: `${role}-first`,
          [role]: identity,
        },
        nextHeartbeatChallenge: role === 'proxy' ? proxy.nextHeartbeatChallenge : `${role}-next`,
      } as never;
    });
    mockedCreateSetAuthority.mockImplementation((options) => ({
      proxyInstanceId: options.proxyInstanceId,
      autonomousDeadline: {
        orphanTimeoutMs: Number.MAX_SAFE_INTEGER,
        adoptionWindowMs: Number.MAX_SAFE_INTEGER,
        heartbeatHoldBound: {
          spanMs: Number.MAX_SAFE_INTEGER,
          materialSchedulerLatenessMs: Number.MAX_SAFE_INTEGER,
        },
      },
      stopHeartbeats: () => {
        options.heartbeats.proxy.stop();
        options.heartbeats.guardian.stop();
        options.heartbeats.reaper.stop();
      },
      stopAndReap: () => new Promise<never>(() => undefined),
      commitContainment: () => new Promise<never>(() => undefined),
      initiateControlClose: async () => undefined,
      controlReattachment: {} as never,
      installRecoveryCredential: async () =>
        ({
          kind: 'installed',
          receipt: { kind: 'installed-recovery-credential', grantId: randomUUID() },
        }) as never,
      registerSuccessionOperation: async () => ({ kind: 'registered' as const }),
    }));
    const coordinatorIdentity: CoordinatorIdentity = {
      instanceId: randomUUID(),
      pid: 1,
      incarnation: testIncarnation(1),
      generation: 'gen2',
      flavor: 'prod',
      buildSetId: randomUUID(),
    };
    const steps = createProviderProxyAcquisitionSteps({
      runtime,
      pluginRoot: '/tmp/coral-acquisition-test',
      baseDir: '/tmp/coral-acquisition-test',
      coordinatorIdentity,
      hostFingerprint: 'a'.repeat(64),
      operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
    });
    await steps.createCapsules();
    const guardianUndo = await steps.spawnGuardian();
    expect(vi.mocked(spawnRoleProcess).mock.calls.at(-1)?.[3].envAdditions).toMatchObject({
      [CORAL_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS_ENV]: '74000',
    });
    const registerUndo = vi.fn();
    const established = await steps.establishControl(registerUndo, () => undefined);
    if (established.kind !== 'established') throw new Error(`expected established, received ${established.kind}`);
    expect(mockedCreateSetAuthority.mock.calls[0]?.[0]?.registerAcquisitionUndo).toBe(registerUndo);

    const observation = { recurringEchoes: proxy.acceptedEchoes() - 1, controlIsLive: proxy.controlIsLive() };
    await established.set.initiateControlClose();
    await established.undo.run();
    await guardianUndo.run();
    await proxy.close();
    expect(guardianExchange).toHaveBeenCalledWith(
      'guardian.containment-commit.v1',
      expect.any(Object),
      PROXY_TEARDOWN_RESERVE_MS,
    );
    expect({
      acceptedRecurringEchoes: observation.recurringEchoes > 1,
      controlIsLive: observation.controlIsLive,
    }).toEqual({ acceptedRecurringEchoes: true, controlIsLive: true });
  });

  it('removes fresh authority when the reaper heartbeat genuinely rejects', async () => {
    const time = new VirtualTime();
    const runtime = { ...createRealRuntime('prod'), time };
    const clients = {
      proxy: passiveClient(),
      guardian: passiveClient(),
      reaper: passiveClient(),
    };
    let reaperHeartbeats = 0;
    clients.reaper.exchange = async () => {
      reaperHeartbeats += 1;
      const error = new ControlClientError(
        'control_call_failed',
        'Heartbeat echo was not accepted (teardown-latched).',
        'remote-response',
        {
          kind: 'json-rpc-error',
          jsonRpcCode: -32600,
          protocolCode: 'invalid_request',
          admissionReason: null,
          heartbeatRefusal: { reason: 'teardown-latched', nextHeartbeatChallenge: null },
        },
      );
      if (error.remoteFailure === null) throw new Error('test refusal lacks remote failure');
      return controlExchangeForTest({
        kind: 'response',
        response: { kind: 'refusal', failure: error.remoteFailure, error },
      });
    };
    mockedEstablishRoleControl.mockImplementation(async (opened, _timer, _retry, plan) => {
      const role = plan.role;
      const client = clients[role];
      opened.push(client);
      const identity =
        role === 'proxy'
          ? { ...plan.expectedIdentity, pid: 201, incarnation: testIncarnation(21), processGroupId: 201 }
          : role === 'reaper'
            ? { ...plan.expectedIdentity, pid: 301, incarnation: testIncarnation(31) }
            : plan.expectedIdentity;
      return {
        client,
        opened: {
          controlEpoch: role === 'proxy' ? 1 : role === 'guardian' ? 2 : 3,
          heartbeatChallenge: `${role}-first`,
          [role]: identity,
        },
        nextHeartbeatChallenge: `${role}-next`,
      } as never;
    });
    mockedCreateSetAuthority.mockImplementation((options) => ({
      proxyInstanceId: options.proxyInstanceId,
      autonomousDeadline: {
        orphanTimeoutMs: Number.MAX_SAFE_INTEGER,
        adoptionWindowMs: Number.MAX_SAFE_INTEGER,
        heartbeatHoldBound: {
          spanMs: Number.MAX_SAFE_INTEGER,
          materialSchedulerLatenessMs: Number.MAX_SAFE_INTEGER,
        },
      },
      stopHeartbeats: () => {
        options.heartbeats.proxy.stop();
        options.heartbeats.guardian.stop();
        options.heartbeats.reaper.stop();
      },
      stopAndReap: () => new Promise<never>(() => undefined),
      commitContainment: () => new Promise<never>(() => undefined),
      initiateControlClose: async () => undefined,
      controlReattachment: {} as never,
      installRecoveryCredential: async () =>
        ({
          kind: 'installed',
          receipt: { kind: 'installed-recovery-credential', grantId: randomUUID() },
        }) as never,
      registerSuccessionOperation: async () => ({ kind: 'registered' as const }),
    }));
    const coordinatorIdentity: CoordinatorIdentity = {
      instanceId: randomUUID(),
      pid: 1,
      incarnation: testIncarnation(1),
      generation: 'gen2',
      flavor: 'prod',
      buildSetId: randomUUID(),
    };
    const steps = createProviderProxyAcquisitionSteps({
      runtime,
      pluginRoot: '/tmp/coral-acquisition-test',
      baseDir: '/tmp/coral-acquisition-test',
      coordinatorIdentity,
      hostFingerprint: 'a'.repeat(64),
      operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
    });
    await steps.createCapsules();
    await steps.spawnGuardian();
    const establishedEvents = vi.fn();
    const unsubscribe = subscribeProviderProxyControlEstablished(establishedEvents);
    const established = await steps.establishControl(
      () => undefined,
      () => undefined,
    );
    if (established.kind !== 'established') throw new Error(`expected established, received ${established.kind}`);
    if (!isProviderProxyOperationAuthority(established.set)) throw new Error('expected durable authority');

    // The address the real writer produced, checked here because this is the only place it is produced. The
    // generation lives in the filename precisely so a v0.10.8 build never opens what this build writes, and a
    // capsule handed to the authority under the wrong name is that build refusing to boot. Asserting the
    // suffix that v0.10.8's own discovery pattern cannot match is the whole property.
    expect(mockedCreateSetAuthority.mock.calls[0]?.[0]?.handoffCapsulePath).toMatch(
      /\/provider-1[0-9a-f]{23}\.handoff\.v3\.json$/u,
    );
    const set = established.set;
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const lifecycle = new ProviderProxySetLifecycle({
      buildSetId: FIXTURE_BUILD_SET_ID,
      claims,
      controlEstablished: notifyProviderProxyControlEstablished,
      time,
      recoveryDispatcher: createTestProviderProxyRecoveryDispatcher({
        'containment-proof': createTestProviderProxyContainmentProofProducer(runtime, containmentProofDb),
        'disappearance-consumer': async ({ notice }) => ({
          kind: 'accepted',
          acceptance: { kind: 'accepted', operation: notice.operation, disposition: 'record-absent' },
        }),
      }),
      reapRecordedContainment: () => {
        throw new Error('provider proxy acquisition fixture unexpectedly requested recorded containment reaping');
      },
      reportLifecycle: () => undefined,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    const routeKey = 'fresh-reaper-heartbeat';
    const admission = lifecycle.beginFreshAcquisition(routeKey);
    if (admission.kind !== 'accepted') throw new Error(`fresh set was not admitted: ${admission.kind}`);
    lifecycle.acquisitionSucceeded(admission.slotId, set, established.publicationReceipt);
    expect(lifecycle.routeFor(routeKey)).toBe(set);
    expect(establishedEvents).toHaveBeenCalledTimes(1);

    time.tick(1_000);
    await flushMicrotasks();

    const observation = {
      reaperHeartbeats,
      routeAvailable: lifecycle.routeFor(routeKey) !== null,
    };
    set.stopHeartbeats();
    await set.initiateControlClose();
    unsubscribe();
    expect(observation).toEqual({ reaperHeartbeats: 1, routeAvailable: false });
  });

  it('preserves the capsule and every open client when a publication stage response is lost, never unwinding as an ordinary failure', async () => {
    const time = new VirtualTime();
    const runtime = { ...createRealRuntime('prod'), time };
    const guardianClosed = { value: false };
    const guardian: ControlClient = {
      exchange: async (method: string) => {
        if (method === 'guardian.acquisition-publish.v1') {
          // The response is lost after the request may have reached the guardian.
          return controlExchangeForTest({
            kind: 'no-response',
            cause: 'connection-closed-after-write',
            error: new ControlClientError('control_client_closed', 'closed after write', 'closed'),
          });
        }
        return controlExchangeForTest({
          kind: 'response',
          response: { kind: 'result', value: { state: 'active', nextHeartbeatChallenge: 'next' } },
        });
      },
      faulted: new Promise<never>(() => undefined),
      onFault: () => () => undefined,
      close: () => {
        guardianClosed.value = true;
      },
    };
    const reaper = passiveClient();
    const proxy = passiveClient();
    mockedEstablishRoleControl.mockImplementation(async (opened, _timer, _retry, plan) => {
      const role = plan.role;
      const client = role === 'proxy' ? proxy : role === 'guardian' ? guardian : reaper;
      opened.push(client);
      const identity =
        role === 'proxy'
          ? { ...plan.expectedIdentity, pid: 201, incarnation: testIncarnation(21), processGroupId: 201 }
          : role === 'reaper'
            ? { ...plan.expectedIdentity, pid: 301, incarnation: testIncarnation(31) }
            : plan.expectedIdentity;
      return {
        client,
        opened: { controlEpoch: 1, heartbeatChallenge: `${role}-first`, [role]: identity },
        nextHeartbeatChallenge: `${role}-next`,
      } as never;
    });
    mockedCreateSetAuthority.mockImplementation((options) => ({
      proxyInstanceId: options.proxyInstanceId,
      autonomousDeadline: {
        orphanTimeoutMs: Number.MAX_SAFE_INTEGER,
        adoptionWindowMs: Number.MAX_SAFE_INTEGER,
        heartbeatHoldBound: { spanMs: Number.MAX_SAFE_INTEGER, materialSchedulerLatenessMs: Number.MAX_SAFE_INTEGER },
      },
      stopHeartbeats: () => {
        options.heartbeats.proxy.stop();
        options.heartbeats.guardian.stop();
        options.heartbeats.reaper.stop();
      },
      stopAndReap: () => new Promise<never>(() => undefined),
      commitContainment: () => new Promise<never>(() => undefined),
      initiateControlClose: async () => undefined,
      controlReattachment: {} as never,
      installRecoveryCredential: async () =>
        ({
          kind: 'installed',
          receipt: { kind: 'installed-recovery-credential', grantId: randomUUID() },
        }) as never,
      registerSuccessionOperation: async () => ({ kind: 'registered' as const }),
    }));
    const coordinatorIdentity: CoordinatorIdentity = {
      instanceId: randomUUID(),
      pid: 1,
      incarnation: testIncarnation(1),
      generation: 'gen2',
      flavor: 'prod',
      buildSetId: randomUUID(),
    };
    const steps = createProviderProxyAcquisitionSteps({
      runtime,
      pluginRoot: '/tmp/coral-acquisition-test',
      baseDir: '/tmp/coral-acquisition-test',
      coordinatorIdentity,
      hostFingerprint: 'a'.repeat(64),
      operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
    });
    await steps.createCapsules();
    await steps.spawnGuardian();

    const disposition = await steps.establishControl(
      () => undefined,
      () => undefined,
    );
    if (disposition.kind !== 'handed-over') {
      throw new Error(`expected publication handoff, received ${disposition.kind}`);
    }
    expect(providerProxyAcquisitionSessionDescriptor(disposition.session)).toMatchObject({
      capsulePath: expect.stringMatching(/\.handoff\.v3\.json$/u),
      capsuleBinding: publicationUnknownCapsule,
    });
    expect(guardianClosed.value).toBe(false);
    closeProviderProxyAcquisitionSession(disposition.session, 'test complete');
  });
});
