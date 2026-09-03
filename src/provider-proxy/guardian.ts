import type { AsyncRecordedProcessObserver, ProcessIncarnation } from '../infra/node-process.js';
import { truncate } from '../infra/text.js';
import type { z } from 'zod';

import type { MonotonicClock } from '../infra/monotonic-clock.js';
import type { ProcessContainmentEnvironment, RecordedContainmentIdentity } from '../infra/process-containment.js';
import { createBootstrapNonceCredential, type GuardianBootstrapCapsule } from './bootstrap-capsule.js';
import type { ControlClient, ControlExchange } from './control-client.js';
import {
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
  /** The one home for this guardian process's holder identity (§7) — constructed once by the composer and
   *  shared with the deadline machine already injected into `createControlEndpoint`'s `challenges`. This
   *  module must not construct a second instance. */
  holderAuthority: ControlHolderAuthority;
  /** The non-blocking identity-bound observer the guardian's own enforcer schedules holder checks through. */
  observeHolder: AsyncRecordedProcessObserver;
  enforcementHoldStatus?(): z.infer<typeof enforcementHoldStatusSchema> | null;
  abandonUnattributable(): boolean;
  onOutcome(outcome: EnforcementOutcome): void;
  /** A wake later than the model's bound. Reported, but teardown still proceeds. */
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

/**
 * The guardian owns recovery-credential redemption admission. It mirrors the reaper's recorded set so
 * it can enforce the same disappearance condition, but it can neither move nor extend the reaper's deadline.
 */
export function createGuardian<Scope extends symbol>(options: GuardianOptions<Scope>): Guardian {
  const { capsule, clock, deadlines, scheduler, timer, mintReceipt, self, holderAuthority, observeHolder } = options;

  // The guardian creates the containment by spawning the proxy — it cannot know what to enforce until
  // `recordContainment` reports what it watched being created. Until then there is nothing to enforce, so
  // there is no enforcer, exactly as the reaper holds none before `reaper.record-containment.v1`.
  let recordedContainment: GuardianContainmentIdentity | null = null;
  let enforcer: ArmedEnforcer | null = null;

  const requireEnforcer = (): ArmedEnforcer => {
    if (enforcer === null) {
      throw new ProxyControlProtocolError('invalid_state', 'This guardian has not recorded a containment to hold.');
    }
    return enforcer;
  };

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

  /** The reaper identity a teardown's `reaper` claim is checked against: the pid and incarnation this
   *  guardian itself observed at spawn time, plus the same capsule-derived fields the reaper's own identity
   *  uses. The guardian never learns this from the reaper directly — pairing carries no identity, only a
   *  shared secret — so this is reconstructed from what the guardian itself watched come into being. */
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

  const bootstrapNonce = createBootstrapNonceCredential(capsule.bootstrapNonce);
  const grants = createGrantRegistry(mintReceipt, {
    mayReplaceRedemption: () => !deadlines.controlIsLive(),
  });
  const staged = new Map<string, StagedMembership>();
  const activating = new Map<string, Promise<z.infer<typeof guardianOperationActivateResultSchema>>>();

  // The reversible half of `guardian.containment-commit.v1`'s membership barrier: closing this gate refuses
  // a new `guardian.register-provider-root.v1` admission outright, and draining lets one already forwarding a
  // root to the reaper finish before this guardian asks the reaper to snapshot its own cumulative roots.
  let stagingGateOpen = true;
  let inFlightStagingRegistrations = 0;
  let stagingDrainWaiters: Array<() => void> = [];
  let containmentCommit: Promise<z.infer<typeof guardianContainmentCommitResultSchema>> | null = null;

  const noteStagingRegistrationStart = (): void => {
    inFlightStagingRegistrations += 1;
  };
  const noteStagingRegistrationEnd = (): void => {
    inFlightStagingRegistrations -= 1;
    if (inFlightStagingRegistrations === 0) {
      const waiters = stagingDrainWaiters;
      stagingDrainWaiters = [];
      for (const resolve of waiters) resolve();
    }
  };
  const drainStagingRegistrations = (): Promise<void> =>
    inFlightStagingRegistrations === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          stagingDrainWaiters.push(resolve);
        });

  /** Best-effort reopen of the reaper's own prepared gate after a pre-commit refusal or fault. Its own
   *  failure never overrides the caller's original error: `guardian.containment-commit.v1`'s catch always
   *  re-throws what it caught, so a lost abort surfaces as the commit's own refusal rather than a masked one. */
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
      // The reaper's own gate then waits for this guardian's next successful prepare to supersede it, or for
      // the coordinator to observe this commit's refusal and retry.
    }
  };

  let acquisitionCertificate: AcquisitionPublicationCertificate | null = null;

  const methods = new Map<string, ControlMethod>([
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
          if (recordedContainment === null) {
            throw new ProxyControlProtocolError('invalid_state', 'This guardian holds no containment yet.');
          }
          bootstrapNonce.spend(request.bootstrapNonce);
          assertNamedCoordinatorBuild(request.coordinator, capsule);
          // The result names the proxy this guardian was issued for, so a coordinator that opened against
          // the wrong set learns it from the response rather than from a later staging failure.
          return {
            holder: controlTenancyHolderOf(request.coordinator),
            fields: { guardian: identity, proxy: request.proxy },
          };
        },
      },
    ],
    [
      'guardian.handoff-install.v1',
      {
        authority: 'active',
        handle: (params) => {
          const request = guardianReaperHandoffInstallParamsSchema.parse(params);
          assertNamedCoordinatorBuild(request.successor, capsule);
          assertNamedTeardownReserve(request.teardownReserveMs, PROXY_TEARDOWN_RESERVE_MS);
          assertNamedOrphanTimeout(request.orphanTimeoutMs, deadlines.orphanTimeoutMs());
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
      'guardian.handoff-redeem.v1',
      {
        // The grant is the credential, and it is checked and spent by the registry that owns it — the
        // endpoint only learns that a tenancy was earned. Admission can still refuse: an incumbent holding
        // live control is not displaced by a successor that merely presents a valid grant.
        authority: 'establishes-control',
        handle: async (params) => {
          const request = handoffRedeemParamsSchema.parse(params);
          assertNamedCoordinatorBuild(request.successor, capsule);
          const redemption = grants.redeem({
            grantId: request.grantId,
            secret: request.secret,
            successor: controlTenancyHolderOf(request.successor),
            binding: setIdentity,
          });
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
              containment: recordedContainment,
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
    [
      'guardian.register-provider-root.v1',
      {
        // The proxy is the only party that knows the real provider pid, and it reaches the guardian over
        // its own capsule-authenticated channel — not the coordinator's control tenancy.
        authority: 'pairing',
        handle: async (params) => {
          if (!stagingGateOpen) {
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
            // Idempotent by stable identity: the same operation reporting the same root gets the receipt it
            // already holds, rather than a fresh one that silently invalidates it.
            const key = membershipKey(request.operation);
            const already = staged.get(key);
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
            if (staged.size >= MAX_PROXY_OPERATION_LEDGERS) {
              throw new ProxyControlProtocolError(
                'invalid_state',
                'This guardian holds its maximum staged operations.',
              );
            }
            // Checked before the reaper round trip, not after: this guardian's own enforcer can refuse a root
            // on its own cap too, and finding that out only after the reaper has already staged it would leave
            // the two authorities disagreeing about what this containment holds.
            if (armed.wouldExceedProviderRootCap(root)) {
              throw new ProxyControlProtocolError(
                'invalid_state',
                'This guardian holds its maximum recorded provider roots.',
              );
            }
            // Forward the exact root; the joint receipt is only minted once both authorities ACK the same
            // identity, so neither can be talked into containing something the other never recorded. The
            // reaper is asked to record a root, not an operation — it has no operation vocabulary to forward.
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
            // Minted here and nowhere else, and only from both authorities' evidence — which is what makes
            // "after both recorded the same root" a thing the compiler checks rather than a thing this
            // handler's statement order happens to arrange.
            const jointContainmentReceipt = mintJointContainmentReceipt(acknowledgement, record, mintReceipt);
            staged.set(key, {
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
    [
      'guardian.operation-activate.v1',
      {
        authority: 'active',
        handle: async (params) => {
          const request = operationActivateParamsSchema.parse(params);
          const key = membershipKey(request.operation);
          const membership = staged.get(key);
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
          const inFlight = activating.get(key);
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
            const result = guardianOperationActivateResultSchema.parse({
              state: 'activation-authorized',
              jointActivationReceipt: mintReceipt(),
            });
            membership.jointActivationReceipt = result.jointActivationReceipt;
            return result;
          })();
          activating.set(key, promise);
          try {
            return await promise;
          } finally {
            if (activating.get(key) === promise) activating.delete(key);
          }
        },
      },
    ],
    [
      'guardian.operation-release.v1',
      {
        authority: 'pairing',
        handle: (params) => {
          const request = proxyOperationReleaseParamsSchema.parse(params);
          assertNamedProxyIdentity('guardian', request.proxy, capsule);
          const key = membershipKey(request.operation);
          const membership = staged.get(key);
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
          staged.delete(key);
          activating.delete(key);
          return guardianProxyOperationReleaseResultSchema.parse({ state: 'membership-released' });
        },
      },
    ],
    [
      'guardian.containment-commit.v1',
      {
        authority: 'active',
        budgetMs: 'caller-deadline',
        handle: async (params, authorization) => {
          const request = containmentCommitParamsSchema.parse(params);
          const armed = requireEnforcer();
          // The caller must be naming this exact guardian, the reaper it itself spawned and paired with, and
          // this guardian's own proxy — so a commit request either authority would refuse can never be
          // accepted by the other, and this guardian is never talked into reaping a set some other process
          // spawned.
          assertNamedGuardianIdentity(request.guardian, identity);
          assertNamedReaperIdentity(request.reaper, reaperSelfIdentity);
          assertNamedProxyIdentity('guardian', request.proxy, capsule);

          if (containmentCommit !== null) return containmentCommit;
          const attempt = (async (): Promise<z.infer<typeof guardianContainmentCommitResultSchema>> => {
            if (!stagingGateOpen) {
              throw new ProxyControlProtocolError('invalid_state', 'A containment commit is already in progress.');
            }
            stagingGateOpen = false;
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
              // Only after both drains: this guardian's own gate closed and drained above, the reaper's
              // closed and drained inside `reaper.containment-prepare.v1` before it returned this snapshot.
              assertExactRecordedSetAgreement('guardian', armed.recordedRoots(), prepared.providerRoots);
              if (!endpoint.activeControlAuthorizationIsCurrent(authorization)) {
                throw new ProxyControlProtocolError(
                  'unauthorized_control',
                  'Active control changed before this commit could latch.',
                );
              }
            } catch (error: unknown) {
              stagingGateOpen = true;
              if (prepared !== null) await abortReaperContainmentPrepare(prepared.token);
              throw error;
            }

            // Minted from this guardian's own current holder: the revalidation immediately above just
            // confirmed the socket, holder, and epoch dispatch admitted this call under are still current.
            const teardown = mintExplicitTeardownAuthorization(holderAuthority);
            if (teardown === null) {
              throw new ProxyControlProtocolError(
                'invalid_state',
                'This guardian holds no admitted holder to tear down.',
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
          containmentCommit = attempt;
          try {
            return await attempt;
          } catch (error: unknown) {
            if (stagingGateOpen && containmentCommit === attempt) containmentCommit = null;
            throw error;
          }
        },
      },
    ],
    [
      'guardian.acquisition-publish.v1',
      {
        authority: 'active',
        budgetMs: 'caller-deadline',
        handle: async (params) => {
          const request = guardianAcquisitionPublishParamsSchema.parse(params);
          assertNamedGuardianIdentity(request.guardian, identity);
          assertNamedReaperIdentity(request.reaper, reaperSelfIdentity);
          assertNamedProxyIdentity('guardian', request.proxy, capsule);

          if (acquisitionCertificate !== null) {
            return guardianAcquisitionPublishResultSchema.parse({
              state: 'acquisition-published',
              certificate: acquisitionCertificate,
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
          holderAuthority.publish();
          acquisitionCertificate = acquisitionPublicationCertificateSchema.parse(mintReceipt());
          return guardianAcquisitionPublishResultSchema.parse({
            state: 'acquisition-published',
            certificate: acquisitionCertificate,
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
      enforcer?.disarm();
      options.reaperChannel.close();
      await endpoint.close();
    },
    enforcer(): ArmedEnforcer | null {
      return enforcer;
    },
    async recordContainment(containment: GuardianContainmentIdentity): Promise<void> {
      if (recordedContainment !== null) {
        // Idempotent for the identical containment, a mismatch otherwise: revising it would silently move
        // what this guardian is holding, and only one proxy group was ever created for this set.
        if (!sameRecordedContainment(recordedContainment, containment)) {
          throw new ProxyControlProtocolError('identity_mismatch', 'This guardian already holds a containment.');
        }
        return;
      }
      // Recorded and armed locally FIRST, then forwarded — the reverse of `guardian.register-provider-root.v1`,
      // and deliberately so: that method's guardian is a *relay* for a root only the proxy actually knows, so
      // it must not commit ahead of the reaper it is relaying to. Here the guardian is the *origin* — it is
      // the one party that watched this exact group come into being, so there is no peer for it to disagree
      // with by recording first. Forwarding before the local commit would instead risk the one failure mode
      // this ordering exists to close: the forward drops, the reaper is never told and arms nothing, and the
      // proxy — a live, detached process-group leader — is held by no one and reapable by nothing.
      //
      // The window between the proxy spawn returning and this arm is real (a crash inside it is a genuine
      // gap), but it is irreducible and synchronous: no `await` may land between them, and none does below.
      recordedContainment = containment;
      enforcer = createArmedEnforcer({
        clock,
        deadlines,
        containment,
        containmentEnvironment: options.containmentEnvironment,
        scheduler,
        holderAuthority,
        observeHolder,
        // The guardian's pairing peer is the proxy, not the redemption linearizer — the guardian itself
        // linearizes redemption and may still be installing a valid successor when its own pairing is lost,
        // so an accelerated check may prefetch but must not authorize absence.
        acceleratedCheckMayAuthorizeAbsence: false,
        onOutcome: options.onOutcome,
        onProgressViolation: options.onProgressViolation,
      });
      // Armed the moment it knows what to enforce, so a coordinator — or this guardian's own peer, the
      // reaper, if the forward below never lands — that dies immediately afterwards is already bounded by
      // this guardian's own deadline.
      enforcer.arm();

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
