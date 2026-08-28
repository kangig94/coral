import type { z } from 'zod';

import {
  guardianHandoffRedeemFieldsSchema,
  guardianHandoffRedeemParamsSchema,
  proxyHandoffRedeemFieldsSchema,
  proxyHandoffRedeemParamsSchema,
  reaperHandoffRotateFieldsSchema,
  type HandoffCapsuleV3,
} from '../../../provider-proxy/handoff-capsule.js';
import type { ControlClient, ProviderEventHandler } from '../../../provider-proxy/control-client.js';
import {
  controlEpochSchema,
  heartbeatChallengeSchema,
  reaperHandoffRotateParamsSchema,
  type CoordinatorIdentity,
  type OperationIdentity,
} from '../../../provider-proxy/protocol.js';
import { runtimeControlTimer, type RoleConnectRetryOptions } from '../../../provider-proxy/role-spawn.js';
import type { Runtime } from '../../../runtime/ports.js';
import {
  createProviderProxyAuthorityFaultLatch,
  type ProviderProxyAuthorityFaultLatch,
  type ProviderProxyRoleClients,
} from '../../services/provider-proxy-authority-fault.js';
import type { ProviderProxySetIdentity } from '../../services/provider-proxy-set/identity.js';
import {
  ESTABLISH_CONTROL_CONNECT_TIMEOUT_MS,
  ESTABLISH_CONTROL_READY_DEADLINE_MS,
  ESTABLISH_CONTROL_RETRY_INTERVAL_MS,
} from './acquisition-steps.js';
import {
  createProviderProxyAuthorityHeartbeatAssembly,
  type ProviderProxyAuthorityHeartbeatAssembly,
  type ProviderProxyRoleHeartbeats,
} from './heartbeat.js';
import {
  establishRoleControl,
  ProviderProxyRoleControlRemoteError,
  ProviderProxyRoleControlUnavailableError,
  type ProviderProxyRoleControlAvailabilityIncident,
} from './role-control.js';

const redeemedProviderProxyControlBrand: unique symbol = Symbol('RedeemedProviderProxyControl');

const controlSessionFields = {
  controlEpoch: controlEpochSchema,
  heartbeatChallenge: heartbeatChallengeSchema,
} as const;

export const guardianHandoffRedeemResultSchema = guardianHandoffRedeemFieldsSchema.extend(controlSessionFields);
export const reaperHandoffRotateResultSchema = reaperHandoffRotateFieldsSchema.extend(controlSessionFields);
export const proxyHandoffRedeemResultSchema = proxyHandoffRedeemFieldsSchema.extend(controlSessionFields);

type GuardianHandoffRedemption = z.infer<typeof guardianHandoffRedeemResultSchema>;
type ReaperHandoffRotation = z.infer<typeof reaperHandoffRotateResultSchema>;
type ProxyHandoffRedemption = z.infer<typeof proxyHandoffRedeemResultSchema>;

/** The complete replacement control capability produced by one authenticated three-role redemption. */
export type ProviderProxyControlRedemptionBundle = Readonly<{
  setIdentity: ProviderProxySetIdentity;
  clients: ProviderProxyRoleClients<ControlClient>;
  heartbeats: ProviderProxyRoleHeartbeats;
  faults: ProviderProxyAuthorityFaultLatch;
  guardianIdentity: GuardianHandoffRedemption['guardian'];
  reaperIdentity: ReaperHandoffRotation['reaper'];
  proxyIdentity: ProxyHandoffRedemption['proxy'];
  recoveryOperations: readonly OperationIdentity[];
}>;

/** Proof that all three replacement controls were authenticated, heartbeated, and verified as one set. */
export type RedeemedProviderProxyControl = Readonly<{
  kind: 'redeemed';
  [redeemedProviderProxyControlBrand]: ProviderProxyControlRedemptionBundle;
}>;

/** A decisive answer that prevents this exact redemption attempt from being retried as peer absence. */
export type ProviderProxyControlRedemptionRefusal =
  | Readonly<{ kind: 'role-refused'; error: ProviderProxyRoleControlRemoteError }>
  | Readonly<{
      kind: 'protocol-incompatible';
      incident: Extract<ProviderProxyRoleControlAvailabilityIncident, { kind: 'role-heartbeat-indeterminate' }>;
      error: ProviderProxyRoleControlUnavailableError;
    }>
  | Readonly<{ kind: 'identity-disagreement' }>
  | Readonly<{ kind: 'operation-membership-disagreement' }>;

/** The three observable answers from one authenticated control-redemption attempt. */
export type ProviderProxyControlRedemptionOutcome =
  | RedeemedProviderProxyControl
  | Readonly<{ kind: 'refused'; refusal: ProviderProxyControlRedemptionRefusal }>
  | Readonly<{
      kind: 'unavailable';
      incident: ProviderProxyRoleControlAvailabilityIncident;
      error: ProviderProxyRoleControlUnavailableError;
    }>;

function canonicalOperationSet(operations: readonly OperationIdentity[]): string[] {
  return [
    ...new Set(
      operations.map(
        ({ jobId, operationId, proxyInstanceId, buildSetId }) =>
          `${jobId}:${operationId}:${proxyInstanceId}:${buildSetId}`,
      ),
    ),
  ].sort();
}

function sameOperationSet(left: readonly OperationIdentity[], right: readonly OperationIdentity[]): boolean {
  const canonicalLeft = canonicalOperationSet(left);
  const canonicalRight = canonicalOperationSet(right);
  return (
    canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((operation, index) => operation === canonicalRight[index])
  );
}

function identityFieldsAgree(
  actual: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, string | number>>,
): boolean {
  return Object.entries(expected).every(([field, value]) => actual[field] === value);
}

function returnedIdentitiesMatch(
  target: ProviderProxySetIdentity,
  successor: CoordinatorIdentity,
  guardian: GuardianHandoffRedemption,
  reaper: ReaperHandoffRotation,
  proxy: ProxyHandoffRedemption,
): boolean {
  const shared = {
    generation: successor.generation,
    flavor: successor.flavor,
    buildSetId: target.buildSetId,
    hostFingerprint: target.hostFingerprint,
  };
  const expectedReaper = {
    ...shared,
    reaperInstanceId: target.reaperInstanceId,
    pid: target.reaperPid,
    incarnation: target.reaperIncarnation,
    guardianInstanceId: target.guardianInstanceId,
    canonicalControlEndpoint: target.reaperControlEndpoint,
    containmentKind: target.containmentKind,
  };
  return (
    identityFieldsAgree(guardian.guardian, {
      ...shared,
      guardianInstanceId: target.guardianInstanceId,
      pid: target.guardianPid,
      incarnation: target.guardianIncarnation,
      canonicalControlEndpoint: target.guardianControlEndpoint,
    }) &&
    identityFieldsAgree(guardian.reaper, expectedReaper) &&
    identityFieldsAgree(reaper.reaper, expectedReaper) &&
    identityFieldsAgree(guardian.containment, {
      pid: target.proxyPid,
      incarnation: target.proxyIncarnation,
      processGroupId: target.proxyProcessGroupId,
      containmentKind: target.containmentKind,
    }) &&
    identityFieldsAgree(proxy.proxy, {
      ...shared,
      proxyInstanceId: target.proxyInstanceId,
      pid: target.proxyPid,
      incarnation: target.proxyIncarnation,
      processGroupId: target.proxyProcessGroupId,
      guardianInstanceId: target.guardianInstanceId,
      reaperInstanceId: target.reaperInstanceId,
      canonicalEndpoint: target.canonicalEndpoint,
    })
  );
}

function retryBefore(deadline: number, runtime: Runtime): RoleConnectRetryOptions {
  return {
    connectTimeoutMs: ESTABLISH_CONTROL_CONNECT_TIMEOUT_MS,
    retryIntervalMs: ESTABLISH_CONTROL_RETRY_INTERVAL_MS,
    overallDeadlineMs: Math.max(0, deadline - runtime.time.now()),
    now: () => runtime.time.now(),
    sleep: (ms: number) => runtime.time.sleep(ms),
  };
}

function abandonAttempt(
  heartbeatAssembly: ProviderProxyAuthorityHeartbeatAssembly,
  opened: readonly ControlClient[],
): void {
  heartbeatAssembly.stop();
  for (const client of opened) client.close();
}

/** Returns the atomically promotable control bundle carried by an owner-minted redemption success. */
export function providerProxyControlRedemptionBundle(
  redemption: RedeemedProviderProxyControl,
): ProviderProxyControlRedemptionBundle {
  return redemption[redeemedProviderProxyControlBrand];
}

/** Closes a redeemed bundle that its caller could not promote to an authority. */
export function closeRedeemedProviderProxyControl(redemption: RedeemedProviderProxyControl): void {
  const bundle = providerProxyControlRedemptionBundle(redemption);
  bundle.heartbeats.guardian.stop();
  bundle.heartbeats.reaper.stop();
  bundle.heartbeats.proxy.stop();
  bundle.clients.guardian.close();
  bundle.clients.reaper.close();
  bundle.clients.proxy.close();
}

/**
 * Redeems one stored grant against guardian, reaper, and proxy under one absolute connection deadline.
 * Success is published only after all three roles have completed their initial heartbeat and agreed on the
 * target identity and operation membership.
 */
export async function redeemProviderProxyControl(
  capsule: HandoffCapsuleV3,
  setIdentity: ProviderProxySetIdentity,
  deps: Readonly<{
    runtime: Runtime;
    coordinatorIdentity: CoordinatorIdentity;
    onProviderEvent?(): ProviderEventHandler;
  }>,
  signal: AbortSignal,
): Promise<ProviderProxyControlRedemptionOutcome> {
  const { runtime, coordinatorIdentity } = deps;
  signal.throwIfAborted();

  const deadline = runtime.time.now() + ESTABLISH_CONTROL_READY_DEADLINE_MS;
  const timer = runtimeControlTimer(runtime);
  const opened: ControlClient[] = [];
  const faults = createProviderProxyAuthorityFaultLatch();
  const heartbeatAssembly = createProviderProxyAuthorityHeartbeatAssembly(runtime, faults);

  try {
    const guardianSession = await establishRoleControl(opened, timer, retryBefore(deadline, runtime), {
      role: 'guardian',
      endpoint: capsule.guardianControlEndpoint,
      openMethod: 'guardian.handoff-redeem.v1',
      openParams: { grantId: capsule.grantId, secret: capsule.secret, successor: coordinatorIdentity },
      openParamsSchema: guardianHandoffRedeemParamsSchema,
      openResultSchema: guardianHandoffRedeemResultSchema,
      identity: (result) => result.guardian,
      heartbeatMethod: 'guardian.heartbeat.v1',
      expectedIdentity: {},
    });
    heartbeatAssembly.startRole('guardian', {
      client: guardianSession.client,
      controlEpoch: guardianSession.opened.controlEpoch,
      nextHeartbeatChallenge: guardianSession.nextHeartbeatChallenge,
      instanceId: guardianSession.opened.guardian.guardianInstanceId,
    });
    signal.throwIfAborted();

    const reaperSession = await establishRoleControl(opened, timer, retryBefore(deadline, runtime), {
      role: 'reaper',
      endpoint: capsule.reaperControlEndpoint,
      openMethod: 'reaper.handoff-rotate.v1',
      openParams: {
        grantId: capsule.grantId,
        successor: coordinatorIdentity,
        guardianRedemptionReceipt: guardianSession.opened.redemptionReceipt,
      },
      openParamsSchema: reaperHandoffRotateParamsSchema,
      openResultSchema: reaperHandoffRotateResultSchema,
      identity: (result) => result.reaper,
      heartbeatMethod: 'reaper.heartbeat.v1',
      expectedIdentity: {},
    });
    heartbeatAssembly.startRole('reaper', {
      client: reaperSession.client,
      controlEpoch: reaperSession.opened.controlEpoch,
      nextHeartbeatChallenge: reaperSession.nextHeartbeatChallenge,
      instanceId: reaperSession.opened.reaper.reaperInstanceId,
    });
    signal.throwIfAborted();

    const proxySession = await establishRoleControl(opened, timer, retryBefore(deadline, runtime), {
      role: 'proxy',
      endpoint: capsule.proxyEndpoint,
      openMethod: 'handoff.redeem.v1',
      openParams: {
        grantId: capsule.grantId,
        secret: capsule.secret,
        successor: coordinatorIdentity,
        generation: coordinatorIdentity.generation,
        hostFingerprint: capsule.hostFingerprint,
        buildSetId: capsule.buildSetId,
        proxyInstanceId: capsule.proxyInstanceId,
      },
      openParamsSchema: proxyHandoffRedeemParamsSchema,
      openResultSchema: proxyHandoffRedeemResultSchema,
      identity: (result) => result.proxy,
      heartbeatMethod: 'control.heartbeat.v1',
      expectedIdentity: {},
      ...(deps.onProviderEvent === undefined ? {} : { onProviderEvent: deps.onProviderEvent() }),
    });
    heartbeatAssembly.startRole('proxy', {
      client: proxySession.client,
      controlEpoch: proxySession.opened.controlEpoch,
      nextHeartbeatChallenge: proxySession.nextHeartbeatChallenge,
      instanceId: proxySession.opened.proxy.proxyInstanceId,
    });

    if (
      !sameOperationSet(guardianSession.opened.operations, reaperSession.opened.operations) ||
      !sameOperationSet(guardianSession.opened.operations, proxySession.opened.operations)
    ) {
      abandonAttempt(heartbeatAssembly, opened);
      return { kind: 'refused', refusal: { kind: 'operation-membership-disagreement' } };
    }
    if (
      !returnedIdentitiesMatch(
        setIdentity,
        coordinatorIdentity,
        guardianSession.opened,
        reaperSession.opened,
        proxySession.opened,
      )
    ) {
      abandonAttempt(heartbeatAssembly, opened);
      return { kind: 'refused', refusal: { kind: 'identity-disagreement' } };
    }

    signal.throwIfAborted();
    const bundle: ProviderProxyControlRedemptionBundle = {
      setIdentity,
      clients: {
        proxy: proxySession.client,
        guardian: guardianSession.client,
        reaper: reaperSession.client,
      },
      heartbeats: heartbeatAssembly.complete(),
      faults,
      guardianIdentity: guardianSession.opened.guardian,
      reaperIdentity: reaperSession.opened.reaper,
      proxyIdentity: proxySession.opened.proxy,
      recoveryOperations: guardianSession.opened.operations,
    };
    return { kind: 'redeemed', [redeemedProviderProxyControlBrand]: bundle };
  } catch (error: unknown) {
    abandonAttempt(heartbeatAssembly, opened);
    if (error instanceof ProviderProxyRoleControlUnavailableError) {
      if (
        error.incident.kind === 'role-heartbeat-indeterminate' &&
        error.incident.observation.kind === 'reply' &&
        error.incident.observation.reply.kind === 'method-not-found'
      ) {
        return {
          kind: 'refused',
          refusal: { kind: 'protocol-incompatible', incident: error.incident, error },
        };
      }
      return { kind: 'unavailable', incident: error.incident, error };
    }
    if (error instanceof ProviderProxyRoleControlRemoteError) {
      return { kind: 'refused', refusal: { kind: 'role-refused', error } };
    }
    throw error;
  }
}
