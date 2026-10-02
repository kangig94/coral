import type { AsyncRecordedProcessObserver, ProcessIncarnation } from '../infra/node-process.js';
import { truncate } from '../infra/text.js';
import type { z } from 'zod';

import type { MonotonicClock } from '../infra/monotonic-clock.js';
import type { ProcessContainmentEnvironment, RecordedContainmentIdentity } from '../infra/process-containment.js';
import { createBootstrapNonceCredential, type GuardianBootstrapCapsule } from './bootstrap-capsule.js';
import type { ControlClient, ControlExchange } from './control-client.js';
import {
  activeControlHolder,
  controlTenancyHolderOf,
  createControlEndpoint,
  type ControlEndpoint,
  type ControlEndpointTimer,
  type ControlMethod,
} from './control-endpoint.js';
import {
  EnforcementError,
  createArmedEnforcer,
  type ArmedEnforcer,
  type EnforcementOutcome,
  type EnforcementScheduler,
} from './enforcement.js';
import { mintExplicitTeardownAuthorization, type ControlHolderAuthority } from './holder-lifecycle.js';
import {
  assertCompatibleControlGeneration,
  controllerBuildOf,
  controllerTransferParamsSchema,
  controllerTransferResultSchema,
  createControllerBuildLedger,
  requireInstallerBuild,
} from './controller-succession.js';
import {
  createGrantRegistry,
  grantBindingFromCapsule,
  guardianHandoffRedeemFieldsSchema,
  guardianReaperHandoffInstallParamsSchema,
  guardianHandoffRedeemParamsSchema as handoffRedeemParamsSchema,
  holderStatusParamsSchema,
  reaperRecordRedemptionParamsSchema,
  successionOperationRegisterParamsSchema,
  successionOperationRegisterResultSchema,
  type GrantBinding,
} from './handoff-capsule.js';
import {
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  ProxyControlProtocolError,
  acquisitionPublicationCertificateSchema,
  assertExactRecordedSetAgreement,
  assertNamedCoordinatorBuild,
  assertNamedOrphanTimeout,
  assertNamedProxyIdentity,
  assertNamedReaperIdentity,
  assertNamedTeardownReserve,
  guardianAcquisitionAbortParamsSchema,
  guardianAcquisitionAbortResultSchema,
  guardianAcquisitionPublishParamsSchema,
  guardianAcquisitionPublishResultSchema,
  guardianContainmentCommitParamsSchema as containmentCommitParamsSchema,
  guardianContainmentCommitResultSchema,
  guardianOperationActivateParamsSchema as operationActivateParamsSchema,
  guardianOpenParamsSchema as openParamsSchema,
  guardianOperationActivateResultSchema,
  guardianProxyOperationReleaseParamsSchema as proxyOperationReleaseParamsSchema,
  guardianProxyOperationReleaseResultSchema,
  guardianRegisterProviderRootParamsSchema as registerProviderRootParamsSchema,
  type enforcementHoldStatusSchema,
  holderStatusResultSchema,
  jointContainmentReceiptSchema,
  providerProxyRoleAbandonmentParamsSchema,
  providerProxyRoleAbandonmentResultSchema,
  reaperAcquisitionPublishParamsSchema,
  reaperAcquisitionPublishResultSchema,
  reaperConfirmProviderRootParamsSchema,
  reaperConfirmProviderRootResultSchema,
  reaperContainmentAbortParamsSchema,
  reaperContainmentAbortResultSchema,
  reaperContainmentPrepareParamsSchema,
  reaperContainmentPrepareResultSchema,
  recordedContainmentSchema,
  type AcquisitionPublicationCertificate,
  type ContainmentPrepareToken,
  reaperRecordContainmentResultSchema,
  reaperRecordRedemptionResultSchema,
  reaperRegisterProviderRootParamsSchema,
  reaperRegisterProviderRootResultSchema,
  sameRecordedContainment,
  type guardianIdentitySchema,
  type providerRootSchema,
  type JointContainmentReceipt,
  type JointActivationReceipt,
  type OperationIdentity,
  type ReaperIdentity,
  type Reservation,
} from './protocol.js';

function requireReaperResult(method: string, exchange: ControlExchange): unknown {
  if (exchange.kind === 'response') {
    if (exchange.response.kind === 'result') return exchange.response.value;
    throw exchange.response.error;
  }
  if (exchange.error instanceof Error) throw exchange.error;
  throw new Error(`${method} could not be sent.`, { cause: exchange.error });
}
import { MAX_PROXY_OPERATION_LEDGERS } from './ledger.js';
import { PROXY_TEARDOWN_RESERVE_MS, type EnforcerDeadlineStateMachine } from './orphan-deadline.js';

/**
 * Evidence that the reaper recorded one exact provider root, carrying the root it is evidence about.
 *
 * The joint containment receipt may be minted only after both authorities have recorded the same identity.
 * This makes it structural: the value below cannot be constructed except by `acknowledgeReaperRoot`,
 * which is the only code that checks the reaper's reply, and `mintJointContainmentReceipt` will not mint
 * without one. Reordering the two calls stops compiling rather than silently issuing a receipt for a root the
 * reaper never confirmed.
 *
 * It carries `root` so that "the same identity" is structural too: everything downstream reads the root out
 * of the acknowledgement rather than from a separately-held local that could drift from what was confirmed.
 *
 * Scope, stated plainly: this constrains the guardian's own mint, which is the only authority that issues
 * this receipt. It cannot stop another module from calling the exported schema's `.parse()` — a brand is a
 * compile-time fiction and parse-as-constructor is what creates one. What it does close is the ordering, in
 * the one place the ordering is decided.
 */
declare const reaperAcknowledged: unique symbol;
type ReaperRootAcknowledgement = Readonly<{
  /** Phantom: type-space only, never present at runtime, so this token costs nothing on the wire or in
   *  memory. It exists to make the type unconstructible outside `acknowledgeReaperRoot` below. */
  readonly [reaperAcknowledged]: true;
  readonly root: Readonly<{ pid: number; incarnation: ProcessIncarnation }>;
}>;

/** The one producer of a `ReaperRootAcknowledgement`, and the only place the reaper's reply is judged. */
function acknowledgeReaperRoot(
  reply: unknown,
  root: Readonly<{ pid: number; incarnation: ProcessIncarnation }>,
): ReaperRootAcknowledgement {
  reaperRegisterProviderRootResultSchema.parse(reply);
  return { root } as unknown as ReaperRootAcknowledgement;
}

/**
 * The guardian's own half of the same fact: its enforcer has recorded this root and will contain it. Separate
 * from the reaper's acknowledgement because they are separate authorities — the whole point of the joint
 * receipt is that neither can be talked into containing something the other never recorded, and a token that
 * proved only one of them would leave half of that rule enforced by statement order.
 */
declare const guardianRecorded: unique symbol;
type GuardianRootRecord = Readonly<{
  readonly [guardianRecorded]: true;
  readonly root: Readonly<{ pid: number; incarnation: ProcessIncarnation }>;
}>;

/** The one producer of a `GuardianRootRecord`, and the only place this guardian's enforcer is told to hold a
 *  root. Translating `EnforcementError` here keeps that internal vocabulary off the wire. */
function recordGuardianRoot(
  armed: Readonly<{ registerProviderRoot(root: Readonly<{ pid: number; incarnation: ProcessIncarnation }>): void }>,
  acknowledgement: ReaperRootAcknowledgement,
): GuardianRootRecord {
  try {
    armed.registerProviderRoot(acknowledgement.root);
  } catch (error: unknown) {
    // The cap was already checked before the reaper was asked, so reaching this is a defect rather than an
    // expected race — but `EnforcementError` is this module's internal vocabulary, not a protocol code, and
    // it must not cross the wire untranslated: the caller would get a message with no code to act on.
    if (error instanceof EnforcementError) {
      throw new ProxyControlProtocolError('invalid_state', error.message);
    }
    throw error;
  }
  return { root: acknowledgement.root } as unknown as GuardianRootRecord;
}

/**
 * The one place a joint containment receipt comes into existence, and it needs both authorities' evidence to
 * do it — which is what makes "only after both recorded the same root" a thing the compiler checks. Both
 * tokens are phantom-typed, so requiring them costs nothing at runtime.
 */
function mintJointContainmentReceipt(
  acknowledgement: ReaperRootAcknowledgement,
  record: GuardianRootRecord,
  mintReceipt: () => string,
): JointContainmentReceipt {
  void acknowledgement;
  void record;
  return jointContainmentReceiptSchema.parse(mintReceipt());
}

/**
 * The caller names the guardian it believes it is tearing down. A disagreement means it is reasoning about
 * a different instance, which teardown must surface rather than silently act against this one.
 */
function assertNamedGuardianIdentity(
  claimed: z.infer<typeof guardianIdentitySchema>,
  actual: z.infer<typeof guardianIdentitySchema>,
): void {
  if (
    claimed.guardianInstanceId !== actual.guardianInstanceId ||
    claimed.pid !== actual.pid ||
    claimed.incarnation !== actual.incarnation ||
    claimed.generation !== actual.generation ||
    claimed.flavor !== actual.flavor ||
    claimed.buildSetId !== actual.buildSetId ||
    claimed.hostFingerprint !== actual.hostFingerprint ||
    claimed.canonicalControlEndpoint !== actual.canonicalControlEndpoint
  ) {
    throw new ProxyControlProtocolError('identity_mismatch', 'Teardown named a different guardian than this one.');
  }
}

/** No `operations` field: the set is bound at install and returned by redemption, never presented by a
 *  redeemer to be checked against — see `GrantRegistry.redeem` in src/provider-proxy/handoff-capsule.ts for why. */
/**
 * Both authorities must ACK the same identity before a root may execute, so the receipt names both.
 * The reservation tuple is recorded, not just parsed, so a caller presenting a different one for a known
 * operation is a disagreement this membership can detect rather than silently accept.
 */
type StagedMembership = {
  operation: OperationIdentity;
  jointContainmentReceipt: JointContainmentReceipt;
  jointActivationReceipt: JointActivationReceipt | null;
  reservation: Reservation;
  root: z.infer<typeof providerRootSchema>;
};

function membershipKey(operation: OperationIdentity): string {
  return `${operation.jobId}\u0000${operation.operationId}`;
}

function sameOperationIdentity(left: OperationIdentity, right: OperationIdentity): boolean {
  return (
    left.jobId === right.jobId &&
    left.operationId === right.operationId &&
    left.proxyInstanceId === right.proxyInstanceId &&
    left.buildSetId === right.buildSetId
  );
}

/** A detached spawn becomes the leader of its own new process group, so its group id equals its own pid —
 *  the one fact Node's `child_process` does not report back directly, and the same equality
 *  `assertRecordedSet` (`infra/process-containment.ts`) requires of every recorded containment. The guardian
 *  is the authority that records a containment's kind, so it is the one that names this value; role
 *  composition and the coordinator's own acquisition steps both import it rather than repeating the string. */
export const DETACHED_CONTAINMENT_KIND = 'posix-group';

export type GuardianOptions<Scope extends symbol> = Readonly<{
  capsule: GuardianBootstrapCapsule;
  clock: MonotonicClock<Scope>;
  deadlines: EnforcerDeadlineStateMachine<Scope>;
  containmentEnvironment: ProcessContainmentEnvironment<Scope>;
  scheduler: EnforcementScheduler;
  timer: ControlEndpointTimer;
  mintReceipt(): string;
  /** The paired reaper channel, held open for the lifetime of the set. */
  reaperChannel: ControlClient;
  self: Readonly<{ pid: number; incarnation: ProcessIncarnation }>;
  /** The reaper this guardian itself spawned. A teardown's `reaper` claim is checked against this — the one
   *  identity the guardian observed directly at spawn time, mirroring how it already checks `self` for its
   *  own claim and the capsule for the proxy's. */
  reaperSelf: Readonly<{ pid: number; incarnation: ProcessIncarnation }>;
  /** Guardian deadlines and endpoint enforcement must share one holder authority. */
  holderAuthority: ControlHolderAuthority;
  /** Holder observation must not block the guardian's answering loop. */
  observeHolder: AsyncRecordedProcessObserver;
  enforcementHoldStatus?(): z.infer<typeof enforcementHoldStatusSchema> | null;
  abandonUnattributable(): boolean;
  onOutcome(outcome: EnforcementOutcome): void;
  /** A late wake is diagnostic and does not itself authorize teardown. */
  onProgressViolation(observedWakeLatencyMs: number): void;
}>;

/** What the guardian records: the proxy group leader it watched being created, plus the reaper's own
 *  identity vocabulary for what kind of containment this is. */
export type GuardianContainmentIdentity = RecordedContainmentIdentity & Readonly<{ containmentKind: string }>;

export interface Guardian {
  listen(): Promise<void>;
  close(): Promise<void>;
  /** Null until `recordContainment` has been called. */
  enforcer(): ArmedEnforcer | null;
  /**
   * Records the proxy containment this guardian watched being created, arms its own enforcer on it, and only
   * then forwards the same identity to the paired reaper over `reaper.record-containment.v1`. Idempotent for
   * the identical identity; throws `identity_mismatch` for a conflicting one, mirroring the reaper's own
   * `reaper.record-containment.v1`.
   */
  recordContainment(containment: GuardianContainmentIdentity): Promise<void>;
}

type GuardianState = {
  recordedContainment: GuardianContainmentIdentity | null;
  enforcer: ArmedEnforcer | null;
  staged: Map<string, StagedMembership>;
  activating: Map<string, Promise<z.infer<typeof guardianOperationActivateResultSchema>>>;
  stagingGateOpen: boolean;
  inFlightStagingRegistrations: number;
  stagingDrainWaiters: Array<() => void>;
  containmentCommit: Promise<z.infer<typeof guardianContainmentCommitResultSchema>> | null;
  acquisitionCertificate: AcquisitionPublicationCertificate | null;
};

type GuardianMethodContext<Scope extends symbol> = {
  options: GuardianOptions<Scope>;
  state: GuardianState;
  identity: z.infer<typeof guardianIdentitySchema>;
  reaperSelfIdentity: ReaperIdentity;
  setIdentity: GrantBinding;
  bootstrapNonce: ReturnType<typeof createBootstrapNonceCredential>;
  grants: ReturnType<typeof createGrantRegistry>;
  controllers: ReturnType<typeof createControllerBuildLedger>;
  requireEnforcer: () => ArmedEnforcer;
  noteStagingRegistrationStart: () => void;
  noteStagingRegistrationEnd: () => void;
  drainStagingRegistrations: () => Promise<void>;
  abortReaperContainmentPrepare: (token: ContainmentPrepareToken) => Promise<void>;
  getEndpoint: () => ControlEndpoint;
};

function guardianOpeningMethods<Scope extends symbol>(
  context: GuardianMethodContext<Scope>,
): Array<[string, ControlMethod]> {
  const { options, state, identity, setIdentity, bootstrapNonce, grants, controllers } = context;
  const { capsule, deadlines } = options;
  return [
    [
      'guardian.open.v1',
      {
        authority: 'establishes-control',
        handle: (params) => {
          const request = openParamsSchema.parse(params);
          // Readiness before the credential, mirroring `reaper.open.v1` exactly, including the ordering: a
          // grant installed on a guardian holding no containment would have nothing behind it to enforce, and
          // spending the one-shot nonce first would burn an unreissuable credential on a retryable race
          // between this open and `recordContainment` rather than on a genuine protocol violation.
          if (state.recordedContainment === null) {
            throw new ProxyControlProtocolError('invalid_state', 'This guardian holds no containment yet.');
          }
          bootstrapNonce.spend(request.bootstrapNonce);

          assertNamedCoordinatorBuild(request.coordinator, capsule);
          const holder = controlTenancyHolderOf(request.coordinator);
          controllers.admit(holder, controllerBuildOf(request.coordinator));
          // The result names the proxy this guardian was issued for, so a coordinator that opened against
          // the wrong set learns it from the response rather than from a later staging failure.
          return {
            holder,
            fields: { guardian: identity, proxy: request.proxy },
          };
        },
      },
    ],
    [
      'guardian.handoff-install.v1',
      {
        authority: 'active',
        handle: (params, authorization) => {
          const request = guardianReaperHandoffInstallParamsSchema.parse(params);
          const controllerBuild = requireInstallerBuild(
            controllers,
            activeControlHolder(authorization),
            controllerBuildOf(request.successor),
          );
          assertNamedTeardownReserve(request.teardownReserveMs, PROXY_TEARDOWN_RESERVE_MS);
          assertNamedOrphanTimeout(request.orphanTimeoutMs, deadlines.orphanTimeoutMs());
          const result = grants.install({
            grantId: request.grantId,
            secretSha256: request.secretSha256,
            ...setIdentity,
            operations: request.operations,
            orphanTimeoutMs: request.orphanTimeoutMs,
            controllerBuild,
          });
          return result;
        },
      },
    ],
    [
      'guardian.controller-transfer.v1',
      {
        authority: 'active',
        handle: (params) => {
          const request = controllerTransferParamsSchema.parse(params);
          assertCompatibleControlGeneration(request.controlGeneration);
          return controllerTransferResultSchema.parse(grants.authorizeTransfer(request));
        },
      },
    ],
  ];
}

function guardianRedemptionMethods<Scope extends symbol>(
  context: GuardianMethodContext<Scope>,
): Array<[string, ControlMethod]> {
  const { options, state, identity, reaperSelfIdentity, setIdentity, grants, controllers } = context;
  return [
    [
      'guardian.handoff-redeem.v1',
      {
        // The grant is the credential, and it is checked and spent by the registry that owns it — the
        // endpoint only learns that a tenancy was earned. Admission can still refuse: an incumbent holding
        // live control is not displaced by a successor that merely presents a valid grant.
        authority: 'establishes-control',
        handle: async (params) => {
          const request = handoffRedeemParamsSchema.parse(params);
          const holder = controlTenancyHolderOf(request.successor);
          const redemption = grants.redeem({
            grantId: request.grantId,
            secret: request.secret,
            successor: holder,
            successorBuild: controllerBuildOf(request.successor),
            binding: setIdentity,
          });
          controllers.admit(holder, redemption.successorBuild);
          // The guardian is the sole linearization point: it is the only party that ever sees the plaintext
          // secret, so it is the only party that can tell a genuine redemption from a replay. Pushing the
          // receipt over the paired channel — the same shape `register-provider-root.v1`/`record-containment.v1`
          // already use for guardian→reaper facts — is what lets the reaper trust "a successor was admitted"
          // without ever checking the secret itself. Without this forward, a second successor holding the
          // same plaintext secret from the same capsule could rotate the reaper directly after this one is
          // refused by the (already-spent) grant here, splitting one set between two coordinators.
          //
          // `operations` here is this guardian's own installed record (`redemption.grant.operations`), not
          // anything the request carried — the redeemer never presented one (see `handoffRedeemParamsSchema`),
          // so this is the reaper's only source for the set, and it is an authoritative one.
          const reaperParams = reaperRecordRedemptionParamsSchema.parse({
            grantId: request.grantId,
            successor: request.successor,
            operations: redemption.grant.operations,
            redemptionReceipt: redemption.redemptionReceipt,
          });
          const reaperResult = requireReaperResult(
            'reaper.record-redemption.v1',
            await options.reaperChannel.exchange(
              'reaper.record-redemption.v1',
              reaperParams,
              PROXY_CONTROL_RPC_TIMEOUT_MS,
            ),
          );
          reaperRecordRedemptionResultSchema.parse(reaperResult);
          return {
            holder: controlTenancyHolderOf(request.successor),
            fields: guardianHandoffRedeemFieldsSchema.parse({
              state: 'redeemed-provisional',
              redemptionReceipt: redemption.redemptionReceipt,
              operations: redemption.grant.operations,
              guardian: identity,
              reaper: reaperSelfIdentity,
              containment: state.recordedContainment,
            }),
          };
        },
      },
    ],
    [
      'guardian.succession-register-operation.v1',
      {
        authority: 'active',
        handle: (params) => {
          const request = successionOperationRegisterParamsSchema.parse(params);
          return successionOperationRegisterResultSchema.parse(grants.register(request.operation));
        },
      },
    ],
  ];
}

function guardianRootRegistrationMethods<Scope extends symbol>(
  context: GuardianMethodContext<Scope>,
): Array<[string, ControlMethod]> {
  const { options, state, requireEnforcer, noteStagingRegistrationStart, noteStagingRegistrationEnd } = context;
  const { capsule, mintReceipt } = options;
  return [
    [
      'guardian.register-provider-root.v1',
      {
        // The proxy is the only party that knows the real provider pid, and it reaches the guardian over
        // its own capsule-authenticated channel — not the coordinator's control tenancy.
        authority: 'pairing',
        handle: async (params) => {
          if (!state.stagingGateOpen) {
            throw new ProxyControlProtocolError(
              'invalid_state',
              'Provider-root staging is closed for a containment commit in progress.',
            );
          }
          noteStagingRegistrationStart();
          try {
            const request = registerProviderRootParamsSchema.parse(params);
            const armed = requireEnforcer();
            assertNamedProxyIdentity('guardian', request.proxy, capsule);
            const root = { pid: request.providerPid, incarnation: request.providerIncarnation };
            // Stable operation identity must make repeated root registration idempotent.
            const key = membershipKey(request.operation);
            const already = state.staged.get(key);
            if (already !== undefined) {
              if (
                !sameOperationIdentity(already.operation, request.operation) ||
                already.reservation !== request.reservation ||
                already.root.pid !== root.pid ||
                already.root.incarnation !== root.incarnation
              ) {
                throw new ProxyControlProtocolError(
                  'identity_mismatch',
                  'This operation already reported a different provider root.',
                );
              }
              return {
                state: 'staged-contained',
                providerRoot: already.root,
                jointContainmentReceipt: already.jointContainmentReceipt,
              };
            }
            if (state.staged.size >= MAX_PROXY_OPERATION_LEDGERS) {
              throw new ProxyControlProtocolError(
                'invalid_state',
                'This guardian holds its maximum staged operations.',
              );
            }
            // Both enforcers' root caps must be checked before a root is forwarded.
            if (armed.wouldExceedProviderRootCap(root)) {
              throw new ProxyControlProtocolError(
                'invalid_state',
                'This guardian holds its maximum recorded provider roots.',
              );
            }
            // A joint receipt must bind both authorities' acknowledgements to the same root identity.
            const reaperParams = reaperRegisterProviderRootParamsSchema.parse({ providerRoot: root });
            const acknowledgement = acknowledgeReaperRoot(
              requireReaperResult(
                'reaper.register-provider-root.v1',
                await options.reaperChannel.exchange(
                  'reaper.register-provider-root.v1',
                  reaperParams,
                  PROXY_CONTROL_RPC_TIMEOUT_MS,
                ),
              ),
              root,
            );
            const record = recordGuardianRoot(armed, acknowledgement);
            // Only evidence that both authorities recorded the same root may mint the joint receipt.
            const jointContainmentReceipt = mintJointContainmentReceipt(acknowledgement, record, mintReceipt);
            state.staged.set(key, {
              operation: request.operation,
              jointContainmentReceipt,
              jointActivationReceipt: null,
              reservation: request.reservation,
              root: record.root,
            });
            return { state: 'staged-contained', providerRoot: record.root, jointContainmentReceipt };
          } finally {
            noteStagingRegistrationEnd();
          }
        },
      },
    ],
  ];
}

function guardianOperationActivationMethods<Scope extends symbol>(
  context: GuardianMethodContext<Scope>,
): Array<[string, ControlMethod]> {
  const { options, state } = context;
  const { holderAuthority, mintReceipt } = options;
  return [
    [
      'guardian.operation-activate.v1',
      {
        authority: 'active',
        handle: async (params, authorization) => {
          const request = operationActivateParamsSchema.parse(params);
          const key = membershipKey(request.operation);
          const membership = state.staged.get(key);
          if (membership === undefined || membership.jointContainmentReceipt !== request.jointContainmentReceipt) {
            throw new ProxyControlProtocolError(
              'unauthorized_control',
              'Activation must present the joint containment receipt.',
            );
          }
          // A known operation staged under a specific reservation; a caller presenting a different one is
          // reasoning about a different prepare than the one this membership records, not a legitimate retry.
          if (membership.reservation !== request.reservation) {
            throw new ProxyControlProtocolError(
              'identity_mismatch',
              'Activation named a different reservation than this operation staged.',
            );
          }
          if (!sameOperationIdentity(membership.operation, request.operation)) {
            throw new ProxyControlProtocolError('identity_mismatch', 'Activation named a different operation.');
          }
          if (
            membership.root.pid !== request.providerRoot.pid ||
            membership.root.incarnation !== request.providerRoot.incarnation
          ) {
            throw new ProxyControlProtocolError('identity_mismatch', 'Activation named a different provider root.');
          }
          if (membership.jointActivationReceipt !== null) {
            return guardianOperationActivateResultSchema.parse({
              state: 'activation-authorized',
              jointActivationReceipt: membership.jointActivationReceipt,
            });
          }
          const inFlight = state.activating.get(key);
          if (inFlight !== undefined) return inFlight;

          const promise = (async () => {
            const reaperParams = reaperConfirmProviderRootParamsSchema.parse({
              providerRoot: request.providerRoot,
            });
            const reaperResult = requireReaperResult(
              'reaper.confirm-provider-root.v1',
              await options.reaperChannel.exchange(
                'reaper.confirm-provider-root.v1',
                reaperParams,
                PROXY_CONTROL_RPC_TIMEOUT_MS,
              ),
            );
            reaperConfirmProviderRootResultSchema.parse(reaperResult);
            if (!context.getEndpoint().activeControlAuthorizationIsCurrent(authorization, holderAuthority.current())) {
              throw new ProxyControlProtocolError(
                'unauthorized_control',
                'Active control changed before this activation could latch.',
              );
            }
            const result = guardianOperationActivateResultSchema.parse({
              state: 'activation-authorized',
              jointActivationReceipt: mintReceipt(),
            });
            membership.jointActivationReceipt = result.jointActivationReceipt;
            return result;
          })();
          state.activating.set(key, promise);
          try {
            return await promise;
          } finally {
            if (state.activating.get(key) === promise) state.activating.delete(key);
          }
        },
      },
    ],
  ];
}

function guardianOperationReleaseMethods<Scope extends symbol>(
  context: GuardianMethodContext<Scope>,
): Array<[string, ControlMethod]> {
  const { options, state } = context;
  const { capsule } = options;
  return [
    [
      'guardian.operation-release.v1',
      {
        authority: 'pairing',
        handle: (params) => {
          const request = proxyOperationReleaseParamsSchema.parse(params);
          assertNamedProxyIdentity('guardian', request.proxy, capsule);
          const key = membershipKey(request.operation);
          const membership = state.staged.get(key);
          if (membership === undefined) {
            return guardianProxyOperationReleaseResultSchema.parse({ state: 'membership-absent' });
          }
          if (!sameOperationIdentity(membership.operation, request.operation)) {
            throw new ProxyControlProtocolError('identity_mismatch', 'Release named a different operation.');
          }
          if (membership.reservation !== request.reservation) {
            throw new ProxyControlProtocolError(
              'identity_mismatch',
              'Release named a different reservation than this operation staged.',
            );
          }
          state.staged.delete(key);
          state.activating.delete(key);
          return guardianProxyOperationReleaseResultSchema.parse({ state: 'membership-released' });
        },
      },
    ],
  ];
}

function guardianContainmentCommitMethods<Scope extends symbol>(
  context: GuardianMethodContext<Scope>,
): Array<[string, ControlMethod]> {
  const {
    options,
    state,
    identity,
    reaperSelfIdentity,
    requireEnforcer,
    drainStagingRegistrations,
    abortReaperContainmentPrepare,
  } = context;
  const { capsule, holderAuthority } = options;
  return [
    [
      'guardian.containment-commit.v1',
      {
        authority: 'active',
        budgetMs: 'caller-deadline',
        handle: async (params, authorization) => {
          const request = containmentCommitParamsSchema.parse(params);
          const armed = requireEnforcer();
          // A containment commit must bind this guardian, its paired reaper, and its current proxy.
          assertNamedGuardianIdentity(request.guardian, identity);
          assertNamedReaperIdentity(request.reaper, reaperSelfIdentity);
          assertNamedProxyIdentity('guardian', request.proxy, capsule);

          if (state.containmentCommit !== null) return state.containmentCommit;
          const attempt = (async (): Promise<z.infer<typeof guardianContainmentCommitResultSchema>> => {
            if (!state.stagingGateOpen) {
              throw new ProxyControlProtocolError('invalid_state', 'A containment commit is already in progress.');
            }
            state.stagingGateOpen = false;
            await drainStagingRegistrations();

            let prepared: z.infer<typeof reaperContainmentPrepareResultSchema> | null = null;
            try {
              prepared = reaperContainmentPrepareResultSchema.parse(
                requireReaperResult(
                  'reaper.containment-prepare.v1',
                  await options.reaperChannel.exchange(
                    'reaper.containment-prepare.v1',
                    reaperContainmentPrepareParamsSchema.parse({}),
                    PROXY_CONTROL_RPC_TIMEOUT_MS,
                  ),
                ),
              );
              // Both registration gates must close and drain before containment snapshots are compared.
              assertExactRecordedSetAgreement('guardian', armed.recordedRoots(), prepared.providerRoots);
              if (
                !context.getEndpoint().activeControlAuthorizationIsCurrent(authorization, holderAuthority.current())
              ) {
                throw new ProxyControlProtocolError(
                  'unauthorized_control',
                  'Active control changed before this commit could latch.',
                );
              }
            } catch (error: unknown) {
              state.stagingGateOpen = true;
              if (prepared !== null) await abortReaperContainmentPrepare(prepared.token);
              throw error;
            }

            // Commit authority must bind to the revalidated current holder.
            const teardown = mintExplicitTeardownAuthorization(holderAuthority, authorization, (candidate, subject) =>
              context.getEndpoint().activeControlAuthorizationIsCurrent(candidate, subject),
            );
            if (teardown === null) {
              throw new ProxyControlProtocolError(
                'unauthorized_control',
                'Active control changed before teardown authorization could be minted.',
              );
            }
            const disposition = await armed.stopAndReap(teardown);
            if (disposition.kind === 'authorization-superseded') {
              throw new ProxyControlProtocolError('invalid_state', 'The teardown authorization was no longer current.');
            }
            const outcome = disposition.outcome;
            if (outcome.kind !== 'containment-absent') {
              return guardianContainmentCommitResultSchema.parse({
                state: 'teardown-latched-absence-unconfirmed',
                reason: outcome.reason,
              });
            }
            return guardianContainmentCommitResultSchema.parse({
              state: 'containment-absent',
              disappearanceReceipt: outcome.disappearanceReceipt,
            });
          })();
          state.containmentCommit = attempt;
          try {
            return await attempt;
          } catch (error: unknown) {
            if (state.stagingGateOpen && state.containmentCommit === attempt) state.containmentCommit = null;
            throw error;
          }
        },
      },
    ],
  ];
}

function guardianAcquisitionMethods<Scope extends symbol>(
  context: GuardianMethodContext<Scope>,
): Array<[string, ControlMethod]> {
  const { options, state, identity, reaperSelfIdentity } = context;
  const { capsule, holderAuthority, mintReceipt } = options;
  return [
    [
      'guardian.acquisition-publish.v1',
      {
        authority: 'active',
        budgetMs: 'caller-deadline',
        handle: async (params, authorization) => {
          const request = guardianAcquisitionPublishParamsSchema.parse(params);
          assertNamedGuardianIdentity(request.guardian, identity);
          assertNamedReaperIdentity(request.reaper, reaperSelfIdentity);
          assertNamedProxyIdentity('guardian', request.proxy, capsule);

          if (state.acquisitionCertificate !== null) {
            return guardianAcquisitionPublishResultSchema.parse({
              state: 'acquisition-published',
              certificate: state.acquisitionCertificate,
              guardian: identity,
              reaper: reaperSelfIdentity,
            });
          }

          try {
            const exchange = await options.reaperChannel.exchange(
              'reaper.acquisition-publish.v1',
              reaperAcquisitionPublishParamsSchema.parse({}),
              PROXY_CONTROL_RPC_TIMEOUT_MS,
            );
            // Only proof that the request never crossed the transport may authorize a not-attempted result.
            if (exchange.kind === 'not-sent') {
              const reason =
                exchange.error instanceof Error && exchange.error.message.length > 0
                  ? exchange.error.message
                  : 'reaper.acquisition-publish.v1 was not sent';
              return guardianAcquisitionPublishResultSchema.parse({
                state: 'acquisition-publication-not-attempted',
                reason: truncate(reason, 500),
              });
            }
            reaperAcquisitionPublishResultSchema.parse(requireReaperResult('reaper.acquisition-publish.v1', exchange));
          } catch (error: unknown) {
            // Delivery or response ambiguity may not authorize either publication or non-attempt.
            const reason =
              error instanceof Error ? error.message : 'reaper.acquisition-publish.v1 could not be confirmed';
            return guardianAcquisitionPublishResultSchema.parse({
              state: 'acquisition-publication-unknown',
              reason: truncate(reason, 500),
            });
          }
          if (!context.getEndpoint().activeControlAuthorizationIsCurrent(authorization, holderAuthority.current())) {
            return guardianAcquisitionPublishResultSchema.parse({
              state: 'acquisition-publication-unknown',
              reason: 'Active control changed after reaper publication was confirmed.',
            });
          }
          holderAuthority.publish();
          state.acquisitionCertificate = acquisitionPublicationCertificateSchema.parse(mintReceipt());
          return guardianAcquisitionPublishResultSchema.parse({
            state: 'acquisition-published',
            certificate: state.acquisitionCertificate,
            guardian: identity,
            reaper: reaperSelfIdentity,
          });
        },
      },
    ],
    [
      'guardian.acquisition-abort.v1',
      {
        authority: 'active',
        handle: (params) => {
          const request = guardianAcquisitionAbortParamsSchema.parse(params);
          assertNamedGuardianIdentity(request.guardian, identity);
          assertNamedReaperIdentity(request.reaper, reaperSelfIdentity);
          assertNamedProxyIdentity('guardian', request.proxy, capsule);
          // Acquisition abort is best-effort and cannot reverse publication; definitive cleanup remains with
          // the guardian teardown owner.
          return guardianAcquisitionAbortResultSchema.parse({
            state: holderAuthority.phase() === 'published' ? 'already-published' : 'acquisition-aborted',
          });
        },
      },
    ],
  ];
}

function guardianObservationMethods<Scope extends symbol>(
  context: GuardianMethodContext<Scope>,
): [string, ControlMethod][] {
  const { options, grants, identity } = context;
  const { holderAuthority } = options;
  return [
    [
      'guardian.holder-status.v1',
      {
        authority: 'observation',
        handle: (params) => {
          const request = holderStatusParamsSchema.parse(params);
          const verified = grants.verifyInstalledGrant({
            grantId: request.grantId,
            secret: request.secret,
            binding: {
              generation: request.generation,
              flavor: request.flavor,
              buildSetId: request.buildSetId,
              hostFingerprint: request.hostFingerprint,
              guardianInstanceId: request.guardianInstanceId,
              reaperInstanceId: request.reaperInstanceId,
              proxyInstanceId: request.proxyInstanceId,
            },
          });
          if (!verified) {
            throw new ProxyControlProtocolError('grant_invalid', 'Status did not present the installed grant.');
          }
          const current = holderAuthority.status();
          if (current === null) {
            throw new ProxyControlProtocolError('invalid_state', 'This guardian holds no observed holder yet.');
          }
          return holderStatusResultSchema.parse({
            disposition: current.disposition,
            phase: holderAuthority.phase(),
            holder: {
              instanceId: current.identity.holder.instanceId,
              pid: current.identity.holder.pid,
              incarnation: current.identity.holder.incarnation,
            },
            controlEpoch: current.identity.controlEpoch,
            transitionSequence: current.transitionSequence,
            changedAtMs: current.changedAtMs,
            enforcementHold: options.enforcementHoldStatus?.() ?? null,
          });
        },
      },
    ],
    [
      'guardian.abandon-unattributable.v1',
      {
        authority: 'operator',
        handle: (params) => {
          const request = providerProxyRoleAbandonmentParamsSchema.parse(params);
          const credential = holderStatusParamsSchema.parse(request.credential);
          const verified = grants.verifyInstalledGrant({
            grantId: credential.grantId,
            secret: credential.secret,
            binding: {
              generation: credential.generation,
              flavor: credential.flavor,
              buildSetId: credential.buildSetId,
              hostFingerprint: credential.hostFingerprint,
              guardianInstanceId: credential.guardianInstanceId,
              reaperInstanceId: credential.reaperInstanceId,
              proxyInstanceId: credential.proxyInstanceId,
            },
          });
          if (!verified) {
            throw new ProxyControlProtocolError('grant_invalid', 'Abandonment did not present the installed grant.');
          }
          if (
            request.roleIdentity.role !== 'guardian' ||
            request.roleIdentity.pid !== identity.pid ||
            request.roleIdentity.incarnation !== identity.incarnation
          ) {
            throw new ProxyControlProtocolError('identity_mismatch', 'Abandonment named a different guardian.');
          }
          if (!options.abandonUnattributable()) {
            throw new ProxyControlProtocolError(
              'invalid_state',
              'This guardian has no unattributable hold to abandon.',
            );
          }
          return providerProxyRoleAbandonmentResultSchema.parse({
            state: 'unattributable-containment-abandoned',
          });
        },
      },
    ],
  ];
}

function armGuardianContainment<Scope extends symbol>(
  options: GuardianOptions<Scope>,
  state: GuardianState,
  containment: GuardianContainmentIdentity,
): boolean {
  if (state.recordedContainment !== null) {
    if (!sameRecordedContainment(state.recordedContainment, containment)) {
      throw new ProxyControlProtocolError('identity_mismatch', 'This guardian already holds a containment.');
    }
    return false;
  }

  state.recordedContainment = containment;
  state.enforcer = createArmedEnforcer({
    clock: options.clock,
    deadlines: options.deadlines,
    containment,
    containmentEnvironment: options.containmentEnvironment,
    scheduler: options.scheduler,
    holderAuthority: options.holderAuthority,
    observeHolder: options.observeHolder,
    // Guardian pairing loss must not authorize absence while redemption can still install a successor.
    acceleratedCheckMayAuthorizeAbsence: false,
    onOutcome: options.onOutcome,
    onProgressViolation: options.onProgressViolation,
  });

  state.enforcer.arm();

  return true;
}

function createGuardianIdentities<Scope extends symbol>(
  options: GuardianOptions<Scope>,
): {
  identity: z.infer<typeof guardianIdentitySchema>;
  reaperSelfIdentity: ReaperIdentity;
  setIdentity: GrantBinding;
} {
  const { capsule, self } = options;
  const identity = Object.freeze({
    guardianInstanceId: capsule.guardianInstanceId,
    pid: self.pid,
    incarnation: self.incarnation,
    generation: capsule.generation,
    flavor: capsule.flavor,
    buildSetId: capsule.buildSetId,
    hostFingerprint: capsule.hostFingerprint,
    canonicalControlEndpoint: capsule.canonicalControlEndpoint,
  });

  const reaperSelfIdentity: ReaperIdentity = Object.freeze({
    reaperInstanceId: capsule.reaperInstanceId,
    pid: options.reaperSelf.pid,
    incarnation: options.reaperSelf.incarnation,
    guardianInstanceId: capsule.guardianInstanceId,
    generation: capsule.generation,
    flavor: capsule.flavor,
    buildSetId: capsule.buildSetId,
    hostFingerprint: capsule.hostFingerprint,
    canonicalControlEndpoint: capsule.reaperControlEndpoint,
    containmentKind: DETACHED_CONTAINMENT_KIND,
  });

  /**
   * Every field a grant is bound to except the orphan timeout, which the installer names because it is the
   * budget a successor plans its attach against; the guardian supplies the rest from its own capsule so a
   * coordinator can never install a grant for a set it does not belong to.
   */
  const setIdentity: GrantBinding = grantBindingFromCapsule(capsule);

  return { identity, reaperSelfIdentity, setIdentity };
}

function createGuardianStagingGate(
  state: GuardianState,
): Pick<
  GuardianMethodContext<symbol>,
  'noteStagingRegistrationStart' | 'noteStagingRegistrationEnd' | 'drainStagingRegistrations'
> {
  // Root registration must be closed and drained before either enforcer snapshots containment.

  const noteStagingRegistrationStart = (): void => {
    state.inFlightStagingRegistrations += 1;
  };
  const noteStagingRegistrationEnd = (): void => {
    state.inFlightStagingRegistrations -= 1;
    if (state.inFlightStagingRegistrations === 0) {
      const waiters = state.stagingDrainWaiters;
      state.stagingDrainWaiters = [];
      for (const resolve of waiters) resolve();
    }
  };
  const drainStagingRegistrations = (): Promise<void> =>
    state.inFlightStagingRegistrations === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          state.stagingDrainWaiters.push(resolve);
        });

  return { noteStagingRegistrationStart, noteStagingRegistrationEnd, drainStagingRegistrations };
}

export function createGuardian<Scope extends symbol>(options: GuardianOptions<Scope>): Guardian {
  const { capsule, deadlines, timer, mintReceipt, holderAuthority } = options;

  const state: GuardianState = {
    recordedContainment: null,
    enforcer: null,
    staged: new Map(),
    activating: new Map(),
    stagingGateOpen: true,
    inFlightStagingRegistrations: 0,
    stagingDrainWaiters: [],
    containmentCommit: null,
    acquisitionCertificate: null,
  };

  const requireEnforcer = (): ArmedEnforcer => {
    if (state.enforcer === null) {
      throw new ProxyControlProtocolError('invalid_state', 'This guardian has not recorded a containment to hold.');
    }
    return state.enforcer;
  };

  const { identity, reaperSelfIdentity, setIdentity } = createGuardianIdentities(options);

  const bootstrapNonce = createBootstrapNonceCredential(capsule.bootstrapNonce);
  const grants = createGrantRegistry(mintReceipt, {
    mayReplaceRedemption: () => !deadlines.controlIsLive(),
  });
  const controllers = createControllerBuildLedger(controllerBuildOf(capsule));

  const { noteStagingRegistrationStart, noteStagingRegistrationEnd, drainStagingRegistrations } =
    createGuardianStagingGate(state);

  /** Reopening a prepared gate must not mask the original pre-commit failure. */
  const abortReaperContainmentPrepare = async (token: ContainmentPrepareToken): Promise<void> => {
    try {
      reaperContainmentAbortResultSchema.parse(
        requireReaperResult(
          'reaper.containment-abort.v1',
          await options.reaperChannel.exchange(
            'reaper.containment-abort.v1',
            reaperContainmentAbortParamsSchema.parse({ token }),
            PROXY_CONTROL_RPC_TIMEOUT_MS,
          ),
        ),
      );
    } catch {
      // A failed abort must retain a retry exit that can supersede the prepared gate.
    }
  };

  const methodContext: GuardianMethodContext<Scope> = {
    options,
    state,
    identity,
    reaperSelfIdentity,
    setIdentity,
    bootstrapNonce,
    grants,
    controllers,
    requireEnforcer,
    noteStagingRegistrationStart,
    noteStagingRegistrationEnd,
    drainStagingRegistrations,
    abortReaperContainmentPrepare,
    getEndpoint: () => endpoint,
  };
  const methods = new Map<string, ControlMethod>([
    ...guardianOpeningMethods(methodContext),
    ...guardianRedemptionMethods(methodContext),
    ...guardianRootRegistrationMethods(methodContext),
    ...guardianOperationActivationMethods(methodContext),
    ...guardianOperationReleaseMethods(methodContext),
    ...guardianContainmentCommitMethods(methodContext),
    ...guardianAcquisitionMethods(methodContext),
    ...guardianObservationMethods(methodContext),
  ]);

  const endpoint: ControlEndpoint = createControlEndpoint({
    socketPath: capsule.canonicalControlEndpoint,
    role: {
      heartbeatMethod: 'guardian.heartbeat.v1',
      methods,
      // The proxy→guardian channel the plan gives root registration its own authority on.
      pairing: { openMethod: 'guardian.pair.v1', secret: capsule.proxyGuardianAuthSecret },
    },
    challenges: deadlines,
    observer: {
      onControlLost: () => deadlines.observeEof(),
      onPairingLost: () => deadlines.observePairingLoss(),
    },
    timer,
    holderAuthority,
    requestTimeoutMs: PROXY_CONTROL_RPC_TIMEOUT_MS,
    // Teardown may legitimately spend the TERM and KILL graces plus the disappearance confirmation, which
    // is longer than a mutation RPC's budget. Cutting it off would report a failure for a reap in progress.
  });

  return {
    async listen(): Promise<void> {
      // Arming waits for `recordContainment`: before it, there is no identity to enforce, and the proxy has
      // not been spawned yet — the whole reason this endpoint must be up before that spawn happens.
      await endpoint.listen();
    },
    async close(): Promise<void> {
      state.enforcer?.disarm();
      options.reaperChannel.close();
      await endpoint.close();
    },
    enforcer(): ArmedEnforcer | null {
      return state.enforcer;
    },
    async recordContainment(containment: GuardianContainmentIdentity): Promise<void> {
      if (!armGuardianContainment(options, state, containment)) return;
      const reaperParams = recordedContainmentSchema.parse(containment);
      const reaperResult = requireReaperResult(
        'reaper.record-containment.v1',
        await options.reaperChannel.exchange(
          'reaper.record-containment.v1',
          reaperParams,
          PROXY_CONTROL_RPC_TIMEOUT_MS,
        ),
      );
      reaperRecordContainmentResultSchema.parse(reaperResult);
    },
  };
}
