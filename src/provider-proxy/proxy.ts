import type { MonotonicClock } from '../infra/monotonic-clock.js';
import type { ProviderEventBody } from '../providers/contract.js';
import { createBootstrapNonceCredential, type ProxyBootstrapCapsule } from './bootstrap-capsule.js';
import { ControlLeaseEvidence } from './control-lease.js';
import {
  createControlEndpoint,
  type ControlChallengeAuthority,
  type ControlEndpoint,
  type ControlEndpointTimer,
  type ControlMethod,
} from './control-endpoint.js';
import {
  createGrantRegistry,
  successionOperationRegisterParamsSchema,
  successionOperationRegisterResultSchema,
  type GrantBinding,
  proxyHandoffInstallParamsSchema as handoffInstallParamsSchema,
  proxyHandoffRedeemParamsSchema as handoffRedeemParamsSchema,
} from './handoff-capsule.js';
import {
  operationActivationFingerprint,
  operationPrepareAttemptKey,
  type OperationLedger,
  type ProviderOperationKey,
} from './ledger.js';
import { OperationSupervisor, type OperationStageHandle, type SemanticOperationHost } from './operation-supervisor.js';
import type { ReplayCapacityReservation } from './replay-budget.js';
import { PROXY_CONTROL_LEASE_MS } from './orphan-deadline.js';
import {
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  PROXY_EVENT_COMMIT_TIMEOUT_MS,
  PROXY_STATUS_RPC_TIMEOUT_MS,
  ProxyControlProtocolError,
  proxyOperationActivateParamsSchema as activateParamsSchema,
  proxyOperationAttachParamsSchema as attachParamsSchema,
  proxyOperationAttachResultSchema as attachResultSchema,
  proxyOperationPrepareParamsSchema as prepareParamsSchema,
  proxyOperationReservationParamsSchema as reservationParamsSchema,
  proxyControlOpenParamsSchema as openParamsSchema,
  proxyOperationInspectParamsSchema as inspectParamsSchema,
  proxyOperationCancelParamsSchema as cancelParamsSchema,
  proxyOperationSettleParamsSchema as settleParamsSchema,
  proxyOperationRenewResultSchema,
  proxyOperationStopParamsSchema as stopParamsSchema,
  type CoordinatorIdentity,
  type OperationIdentity,
  type ProxyIdentity,
  type ProxyPreparedAppServerOperation,
  type Reservation,
} from './protocol.js';

export type ProxyOptions<Scope extends symbol> = Readonly<{
  capsule: ProxyBootstrapCapsule;
  clock: MonotonicClock<Scope>;
  identity: ProxyIdentity;
  host: SemanticOperationHost;
  timer: ControlEndpointTimer;
  mintChallenge(): string;
  mintReceipt(): string;
  mintReservation(): Reservation;
  wallClockNow(): number;
  containment: Readonly<{
    stageProviderRoot(
      key: ProviderOperationKey,
      reserved: Readonly<{ reservation: Reservation; prepared: ProxyPreparedAppServerOperation }>,
    ): OperationStageHandle;
  }>;
}>;

export interface Proxy {
  listen(): Promise<void>;
  close(): Promise<void>;
  ledger(): OperationLedger<ProxyPreparedAppServerOperation>;
  reserveProviderEvent(key: ProviderOperationKey, signal?: AbortSignal): Promise<ReplayCapacityReservation>;
  emitProviderEvent(key: ProviderOperationKey, event: ProviderEventBody, reservation: ReplayCapacityReservation): void;
}

function ledgerKey(operation: OperationIdentity): ProviderOperationKey {
  return { jobId: operation.jobId, operationId: operation.operationId };
}

/**
 * The proxy's control tenancy is operational rather than containment authority: losing it stops mutation,
 * while the guardian and reaper remain solely responsible for bounding the process set.
 */
export function createProxy<Scope extends symbol>(options: ProxyOptions<Scope>): Proxy {
  const { capsule, clock, identity, host, timer, mintChallenge, mintReceipt } = options;
  const bootstrapNonce = createBootstrapNonceCredential(capsule.bootstrapNonce);
  const startedAt = clock.now();
  const nowMs = (): number => clock.millisecondsBetween(startedAt, clock.now());
  const evidence = new ControlLeaseEvidence(clock, PROXY_CONTROL_LEASE_MS, startedAt, () => null);
  const grants = createGrantRegistry(mintReceipt, {
    mayReplaceRedemption: () => !evidence.isControlLive(clock.now()),
  });

  const supervisor = new OperationSupervisor({
    host,
    timer,
    mintReservation: options.mintReservation,
    wallClockNow: options.wallClockNow,
    nowMs,
    proxyInstanceId: identity.proxyInstanceId,
    buildSetId: capsule.buildSetId,
    stageProviderRoot: options.containment.stageProviderRoot,
    pushProviderEvent: (frame) => endpoint.pushOnTenancy(frame, PROXY_EVENT_COMMIT_TIMEOUT_MS),
  });

  const challenges: ControlChallengeAuthority = {
    controlIsLive: () => evidence.isControlLive(clock.now()),
    issueFirstChallenge: () => {
      const now = clock.now();
      const challenge = mintChallenge();
      return evidence.issueFirstChallenge(challenge, now)
        ? { accepted: true, challenge }
        : { accepted: false, reason: 'invalid-state' };
    },
    admitSuccessor: () => {
      const now = clock.now();
      if (evidence.isControlLive(now)) return { accepted: false, reason: 'control-active' };
      const challenge = mintChallenge();
      evidence.beginSuccessorControl(challenge, now);
      return { accepted: true, challenge };
    },
    reattachControl: () => {
      evidence.reattachControl();
      supervisor.reattachControl();
      return { accepted: true };
    },
    echoChallenge: (challenge) => {
      const nextChallenge = mintChallenge();
      const recorded = evidence.echoChallenge(clock.now(), challenge, nextChallenge);
      return recorded.accepted ? { accepted: true, nextChallenge } : recorded;
    },
  };

  const setIdentity: GrantBinding = Object.freeze({
    generation: capsule.generation,
    flavor: capsule.flavor,
    buildSetId: capsule.buildSetId,
    hostFingerprint: capsule.hostFingerprint,
    guardianInstanceId: capsule.guardianInstanceId,
    reaperInstanceId: capsule.reaperInstanceId,
    proxyInstanceId: capsule.proxyInstanceId,
  });

  const assertNamedSet = (
    named: Readonly<{ generation: string; hostFingerprint: string; buildSetId: string; proxyInstanceId: string }>,
  ): void => {
    if (
      named.generation !== capsule.generation ||
      named.hostFingerprint !== capsule.hostFingerprint ||
      named.buildSetId !== capsule.buildSetId ||
      named.proxyInstanceId !== capsule.proxyInstanceId
    ) {
      throw new ProxyControlProtocolError('identity_mismatch', 'The named set is not this proxy.');
    }
  };

  const assertNamedCoordinatorBuild = (coordinator: CoordinatorIdentity): void => {
    if (
      coordinator.generation !== capsule.generation ||
      coordinator.flavor !== capsule.flavor ||
      coordinator.buildSetId !== capsule.buildSetId
    ) {
      throw new ProxyControlProtocolError('identity_mismatch', 'The named coordinator belongs to a different build.');
    }
  };

  const assertNamedOperation = (operation: OperationIdentity): void => {
    if (operation.proxyInstanceId !== capsule.proxyInstanceId || operation.buildSetId !== capsule.buildSetId) {
      throw new ProxyControlProtocolError('identity_mismatch', 'The named operation is not held by this proxy.');
    }
  };

  const methods = new Map<string, ControlMethod>([
    [
      'control.open.v1',
      {
        authority: 'establishes-control',
        handle: (params) => {
          const request = openParamsSchema.parse(params);
          bootstrapNonce.spend(request.bootstrapNonce);
          assertNamedCoordinatorBuild(request.coordinator);
          return { holder: request.coordinator.instanceId, fields: { proxy: identity } };
        },
      },
    ],
    [
      'operation.prepare.v1',
      {
        authority: 'active',
        budgetMs: 'caller-deadline',
        handle: (params) => {
          const request = prepareParamsSchema.parse(params);
          assertNamedOperation(request.operation);
          if (request.hostFingerprint !== capsule.hostFingerprint) {
            throw new ProxyControlProtocolError('identity_mismatch', 'Prepare named a different host fingerprint.');
          }
          return supervisor.prepare(request.operation, {
            prepareAttemptNumber: request.prepareAttemptNumber,
            prepareAttemptKey: operationPrepareAttemptKey(request),
            prepared: request.prepared,
          });
        },
      },
    ],
    [
      'operation.renew-activation.v1',
      {
        authority: 'active',
        handle: async (params) => {
          const request = reservationParamsSchema.parse(params);
          assertNamedOperation(request.operation);
          return proxyOperationRenewResultSchema.parse(
            await supervisor.renew(ledgerKey(request.operation), request.reservation),
          );
        },
      },
    ],
    [
      'operation.activate.v1',
      {
        authority: 'active',
        handle: (params) => {
          const request = activateParamsSchema.parse(params);
          assertNamedOperation(request.operation);
          return supervisor.activate(request.operation, {
            reservation: request.reservation,
            jointContainmentReceipt: request.jointContainmentReceipt,
            jointActivationReceipt: request.jointActivationReceipt,
            activationFingerprint: operationActivationFingerprint(request),
          });
        },
      },
    ],
    [
      'operation.cancel.v2',
      {
        authority: 'active',
        handle: async (params) => {
          const request = cancelParamsSchema.parse(params);
          assertNamedOperation(request.operation);
          return supervisor.cancel(request.operation, request.prepareAttemptNumber, request.prepareAttemptKey);
        },
      },
    ],
    [
      'operation.stop.v1',
      {
        authority: 'active',
        handle: async (params) => {
          const request = stopParamsSchema.parse(params);
          assertNamedOperation(request.operation);
          return supervisor.stop(request.operation, request.cause);
        },
      },
    ],
    [
      'operation.settle.v2',
      {
        authority: 'active',
        handle: async (params) => {
          const request = settleParamsSchema.parse(params);
          assertNamedOperation(request.operation);
          return supervisor.settle(request.operation, request.finalProviderSeq);
        },
      },
    ],
    [
      'operation.attach.v1',
      {
        authority: 'active',
        handle: async (params) => {
          const request = attachParamsSchema.parse(params);
          assertNamedOperation(request.operation);
          const redemption = grants.redemption();
          if (
            redemption !== null &&
            !redemption.grant.operations.some(
              (operation) =>
                operation.jobId === request.operation.jobId &&
                operation.operationId === request.operation.operationId &&
                operation.proxyInstanceId === request.operation.proxyInstanceId &&
                operation.buildSetId === request.operation.buildSetId,
            )
          ) {
            throw new ProxyControlProtocolError('unauthorized_control', 'That operation is outside the redeemed set.');
          }
          return attachResultSchema.parse(
            await supervisor.attach(request.operation, request.committedThroughProviderSeq),
          );
        },
      },
    ],
    [
      'operation.inspect.v2',
      {
        authority: 'observation',
        budgetMs: PROXY_STATUS_RPC_TIMEOUT_MS,
        handle: (params) => {
          const request = inspectParamsSchema.parse(params);
          assertNamedOperation(request.operation);
          return supervisor.inspect(request.operation, request.prepareAttemptKey);
        },
      },
    ],
    [
      'handoff.install.v1',
      {
        authority: 'active',
        handle: (params) => {
          const request = handoffInstallParamsSchema.parse(params);
          assertNamedSet(request);
          return grants.install({
            grantId: request.grantId,
            secretSha256: request.secretSha256,
            ...setIdentity,
            operations: request.operations,
            orphanTimeoutMs: request.orphanTimeoutMs,
          });
        },
      },
    ],
    [
      'succession.register-operation.v1',
      {
        authority: 'active',
        handle: (params) => {
          const request = successionOperationRegisterParamsSchema.parse(params);
          assertNamedOperation(request.operation);
          return successionOperationRegisterResultSchema.parse(grants.register(request.operation));
        },
      },
    ],
    [
      'handoff.redeem.v1',
      {
        authority: 'establishes-control',
        handle: (params) => {
          const request = handoffRedeemParamsSchema.parse(params);
          assertNamedSet(request);
          assertNamedCoordinatorBuild(request.successor);
          const redemption = grants.redeem({
            grantId: request.grantId,
            secret: request.secret,
            successorInstanceId: request.successor.instanceId,
            binding: setIdentity,
          });
          return {
            holder: request.successor.instanceId,
            fields: {
              state: 'redeemed-provisional',
              redemptionReceipt: redemption.redemptionReceipt,
              proxy: identity,
              operations: redemption.grant.operations,
            },
          };
        },
      },
    ],
  ]);

  const endpoint: ControlEndpoint = createControlEndpoint({
    socketPath: capsule.canonicalEndpoint,
    role: { heartbeatMethod: 'control.heartbeat.v1', methods },
    challenges,
    observer: { onControlLost: () => evidence.observeEof(clock.now()) },
    timer,
    requestTimeoutMs: PROXY_CONTROL_RPC_TIMEOUT_MS,
  });

  return {
    listen: () => endpoint.listen(),
    close: () => {
      supervisor.close();
      return endpoint.close();
    },
    ledger: () => supervisor.ledger(),
    reserveProviderEvent: (key, signal) => supervisor.reserveProviderEvent(key, signal),
    emitProviderEvent: (key, event, reservation) => supervisor.emitProviderEvent(key, event, reservation),
  };
}
