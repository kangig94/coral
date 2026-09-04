import type { AsyncRecordedProcessObserver, ProcessIncarnation } from '../infra/node-process.js';
import type { z } from 'zod';

import type { MonotonicClock } from '../infra/monotonic-clock.js';
import type { ProcessContainmentEnvironment, RecordedContainmentIdentity } from '../infra/process-containment.js';
import { createBootstrapNonceCredential, type ReaperBootstrapCapsule } from './bootstrap-capsule.js';
import {
  controlTenancyHolderOf,
  createControlEndpoint,
  sameControlTenancyHolder,
  type ControlTenancyHolder,
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
import {
  createGrantRegistry,
  grantBindingFromCapsule,
  guardianReaperHandoffInstallParamsSchema,
  handoffOperationSetSchema,
  holderStatusParamsSchema,
  reaperHandoffRotateFieldsSchema,
  reaperRecordRedemptionParamsSchema,
  sameOperations,
  successionOperationRegisterParamsSchema,
  successionOperationRegisterResultSchema,
  type GrantBinding,
} from './handoff-capsule.js';
import {
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  ProxyControlProtocolError,
  assertNamedCoordinatorBuild,
  assertNamedOrphanTimeout,
  assertNamedProxyIdentity,
  assertNamedTeardownReserve,
  containmentPrepareTokenSchema,
  type enforcementHoldStatusSchema,
  holderStatusResultSchema,
  providerProxyRoleAbandonmentParamsSchema,
  providerProxyRoleAbandonmentResultSchema,
  reaperAcquisitionPublishParamsSchema,
  reaperAcquisitionPublishResultSchema,
  type guardianIdentitySchema,
  reaperConfirmProviderRootParamsSchema,
  reaperConfirmProviderRootResultSchema,
  reaperContainmentAbortParamsSchema,
  reaperContainmentAbortResultSchema,
  reaperContainmentPrepareParamsSchema,
  reaperContainmentPrepareResultSchema,
  type reaperIdentitySchema,
  recordedContainmentSchema,
  reaperRecordContainmentResultSchema,
  reaperRecordRedemptionResultSchema,
  reaperRegisterProviderRootParamsSchema,
  reaperRegisterProviderRootResultSchema,
  sameRecordedContainment,
  type ContainmentPrepareToken,
  type OperationIdentity,
  reaperHandoffRotateParamsSchema,
  reaperOpenParamsSchema as openParamsSchema,
} from './protocol.js';
import type { ControlHolderAuthority } from './holder-lifecycle.js';
import { PROXY_TEARDOWN_RESERVE_MS, type EnforcerDeadlineStateMachine } from './orphan-deadline.js';

/**
 * `reaper.handoff-rotate.v1`'s request: no secret, because this reaper trusts the receipt
 * `reaper.record-redemption.v1` already recorded rather than re-deriving trust from the grant itself. No
 * `operations` either, for the same reason `handoffRedeemParamsSchema` (`guardian.ts`) has none: the set was
 * recorded by `reaper.record-redemption.v1`'s own guardian-authoritative push, and a rotation caller echoing
 * it back here would only be checked against itself.
 */
/**
 * The caller names the guardian it believes paired with this reaper. Checked against the stable fields this
 * reaper's own bootstrap capsule holds — pid and incarnation are deliberately excluded, since unlike the
 * guardian (which spawned this reaper itself and observed both directly) this reaper never independently
 * learns them: pairing carries only a shared secret, no identity.
 */
function assertNamedGuardianCapsuleIdentity(
  claimed: z.infer<typeof guardianIdentitySchema>,
  capsule: ReaperBootstrapCapsule,
): void {
  if (
    claimed.guardianInstanceId !== capsule.guardianInstanceId ||
    claimed.generation !== capsule.generation ||
    claimed.flavor !== capsule.flavor ||
    claimed.buildSetId !== capsule.buildSetId ||
    claimed.hostFingerprint !== capsule.hostFingerprint ||
    claimed.canonicalControlEndpoint !== capsule.guardianControlEndpoint
  ) {
    throw new ProxyControlProtocolError('identity_mismatch', 'The named guardian does not match this reaper.');
  }
}

export type ReaperOptions<Scope extends symbol> = Readonly<{
  capsule: ReaperBootstrapCapsule;
  clock: MonotonicClock<Scope>;
  deadlines: EnforcerDeadlineStateMachine<Scope>;
  containmentEnvironment: ProcessContainmentEnvironment<Scope>;
  scheduler: EnforcementScheduler;
  timer: ControlEndpointTimer;
  mintReceipt(): string;
  /** The reaper's own pid/start identity, reported in `ReaperIdentity`. */
  self: Readonly<{ pid: number; incarnation: ProcessIncarnation }>;
  /** The one home for this reaper process's holder identity (§7) — constructed once by the composer and
   *  shared with the deadline machine already injected into `createControlEndpoint`'s `challenges`. This
   *  module must not construct a second instance. */
  holderAuthority: ControlHolderAuthority;
  /** The non-blocking identity-bound observer the reaper's own enforcer schedules holder checks through. */
  observeHolder: AsyncRecordedProcessObserver;
  enforcementHoldStatus?(): z.infer<typeof enforcementHoldStatusSchema> | null;
  abandonUnattributable(): boolean;
  onOutcome(outcome: EnforcementOutcome): void;
  /** A late wake is diagnostic and does not itself authorize teardown. */
  onProgressViolation(observedWakeLatencyMs: number): void;
}>;

export interface Reaper {
  listen(): Promise<void>;
  close(): Promise<void>;
  /** Null until the guardian has recorded the containment this reaper is to enforce. */
  enforcer(): ArmedEnforcer | null;
}

/**
 * The reaper is armed as soon as it knows what to enforce, and stays armed while the guardian is healthy. It
 * accepts a successor rotation only through the guardian's redemption receipt; ordinary traffic never
 * refreshes it.
 *
 * Containment arrives from the guardian over the pairing channel rather than in the capsule or at
 * `reaper.open.v1`, because of when each party knows it. The guardian spawns the reaper *before* the proxy —
 * so no capsule written at spawn time can name a process group that does not exist yet — and the coordinator
 * only learns the group from the guardian's readiness, so having it supply the value at open would let the
 * reaper be told to enforce a containment nobody verified. The guardian is the one party that observes the
 * group being created, so it is the one party that may name it.
 */
export function createReaper<Scope extends symbol>(options: ReaperOptions<Scope>): Reaper {
  const { capsule, clock, deadlines, scheduler, timer, mintReceipt, self, holderAuthority, observeHolder } = options;
  let recorded: (RecordedContainmentIdentity & { readonly containmentKind: string }) | null = null;
  let enforcer: ArmedEnforcer | null = null;
  let pairingLost = false;

  /** Every field a grant is bound to except the orphan timeout, mirroring `guardian.ts`'s own `setIdentity`:
   *  built from this reaper's own capsule so a coordinator can never install a grant for a set it does not
   *  belong to. */
  const setIdentity: GrantBinding = grantBindingFromCapsule(capsule);
  const grants = createGrantRegistry(mintReceipt, {
    mayReplaceRedemption: () => !deadlines.controlIsLive(),
  });
  // What `reaper.record-redemption.v1` records and `reaper.handoff-rotate.v1` checks: the guardian is the
  // only party that can ever produce this, so its presence alone is what authorizes rotation here — this
  // reaper never independently verifies the grant's secret. `operations` is the guardian's own
  // `redemption.grant.operations` (`guardian.ts`), forwarded here — not a value `reaper.handoff-rotate.v1`'s
  // own caller presents, which is why that method's own request carries none to check it against.
  let recordedRedemption: Readonly<{
    grantId: string;
    successor: ControlTenancyHolder;
    operations: readonly OperationIdentity[];
    redemptionReceipt: string;
  }> | null = null;

  const requireEnforcer = (): ArmedEnforcer => {
    if (enforcer === null) {
      throw new ProxyControlProtocolError('invalid_state', 'This reaper has not been given a containment to hold.');
    }
    return enforcer;
  };

  const identityOf = (
    containment: RecordedContainmentIdentity & { readonly containmentKind: string },
  ): z.infer<typeof reaperIdentitySchema> =>
    Object.freeze({
      reaperInstanceId: capsule.reaperInstanceId,
      pid: self.pid,
      incarnation: self.incarnation,
      guardianInstanceId: capsule.guardianInstanceId,
      generation: capsule.generation,
      flavor: capsule.flavor,
      buildSetId: capsule.buildSetId,
      hostFingerprint: capsule.hostFingerprint,
      canonicalControlEndpoint: capsule.canonicalControlEndpoint,
      containmentKind: containment.containmentKind,
    });

  const bootstrapNonce = createBootstrapNonceCredential(capsule.bootstrapNonce);

  // The reaper's own half of `guardian.containment-commit.v1`'s reversible membership barrier: closing this
  // gate refuses a new `reaper.register-provider-root.v1` admission outright. Nothing drains it — that
  // handler contains no `await`, so no call can still be running when a later `reaper.containment-prepare.v1`
  // takes its snapshot — but the gate itself is real and load-bearing.
  let registrationGateOpen = true;
  let preparedToken: ContainmentPrepareToken | null = null;

  // Staging arrives over the guardian pairing channel, not the coordinator's control connection: the
  // guardian must be able to stage a root while the coordinator's own control is still provisional.
  const methods = new Map<string, ControlMethod>([
    [
      'reaper.open.v1',
      {
        authority: 'establishes-control',
        handle: (params) => {
          const request = openParamsSchema.parse(params);
          // Readiness before the credential — deliberately not credential-first. Credential-first exists so
          // an unauthenticated caller learns nothing it should not; "not ready yet" leaks nothing, because
          // every caller gets the identical answer regardless of what nonce it presented, or whether it
          // presented one at all. Spending first would instead burn the one-shot nonce on a pure ordering
          // race between the coordinator's open and the guardian's containment record, after which this
          // reaper could never be opened by anyone — a retryable race must not cost a credential that
          // cannot be reissued.
          if (recorded === null) {
            throw new ProxyControlProtocolError('invalid_state', 'This reaper holds no containment yet.');
          }
          bootstrapNonce.spend(request.bootstrapNonce);
          // The coordinator's `containment` is an agreement check, not the source: it learned the group from
          // the guardian's readiness, and a disagreement means the two are reasoning about different sets.
          if (!sameRecordedContainment(request.containment, recorded)) {
            throw new ProxyControlProtocolError(
              'identity_mismatch',
              'The coordinator named a different containment than the guardian recorded.',
            );
          }
          assertNamedGuardianCapsuleIdentity(request.guardian, capsule);
          assertNamedProxyIdentity('reaper', request.proxy, capsule);
          return {
            holder: controlTenancyHolderOf(request.coordinator),
            fields: { reaper: identityOf(recorded) },
          };
        },
      },
    ],
    [
      'reaper.record-containment.v1',
      {
        // The guardian's channel, because the guardian is the party that watched the group come into being.
        authority: 'pairing',
        handle: (params) => {
          const request = recordedContainmentSchema.parse(params);
          if (recorded !== null) {
            // Idempotent for the identical containment, a mismatch otherwise: revising it would silently
            // move what this reaper is holding, and only one group was ever created for this set.
            if (!sameRecordedContainment(recorded, request)) {
              throw new ProxyControlProtocolError('identity_mismatch', 'This reaper already holds a containment.');
            }
            return reaperRecordContainmentResultSchema.parse({
              state: 'containment-recorded',
              reaper: identityOf(recorded),
            });
          }
          recorded = request;
          enforcer = createArmedEnforcer({
            clock,
            deadlines,
            containment: request,
            containmentEnvironment: options.containmentEnvironment,
            scheduler,
            holderAuthority,
            observeHolder,
            // The reaper's pairing peer is the guardian — the redemption linearizer. Its loss means no
            // successor can still be in flight, so the reaper may consume a decisive result at an
            // accelerated check, unlike the guardian's own stricter rule.
            acceleratedCheckMayAuthorizeAbsence: true,
            pairingLossObserved: () => pairingLost,
            onOutcome: options.onOutcome,
            onProgressViolation: options.onProgressViolation,
          });
          // Armed the moment it knows what to enforce, so a coordinator that dies immediately afterwards is
          // already bounded by this reaper's own deadline.
          enforcer.arm();
          return reaperRecordContainmentResultSchema.parse({
            state: 'containment-recorded',
            reaper: identityOf(request),
          });
        },
      },
    ],
    [
      'reaper.register-provider-root.v1',
      {
        authority: 'pairing',
        handle: (params) => {
          if (!registrationGateOpen) {
            throw new ProxyControlProtocolError(
              'invalid_state',
              'Provider-root registration is closed for a containment commit in progress.',
            );
          }
          const request = reaperRegisterProviderRootParamsSchema.parse(params);
          try {
            // Idempotent by construction, not by a receipt this handler manages: the enforcer's own record
            // returns early when this exact root is already held, so a repeat costs nothing and a long-lived
            // set re-presenting the same root every prepare/cancel cycle never approaches the cap below.
            requireEnforcer().registerProviderRoot(request.providerRoot);
          } catch (error: unknown) {
            // `EnforcementError` is this module's internal vocabulary, not a protocol code, and must not
            // cross the wire untranslated: the caller would get a message with no code to act on.
            if (error instanceof EnforcementError) {
              throw new ProxyControlProtocolError('invalid_state', error.message);
            }
            throw error;
          }
          return reaperRegisterProviderRootResultSchema.parse({ state: 'root-recorded' });
        },
      },
    ],
    [
      'reaper.confirm-provider-root.v1',
      {
        authority: 'pairing',
        handle: (params) => {
          const request = reaperConfirmProviderRootParamsSchema.parse(params);
          const isRecorded = requireEnforcer()
            .recordedRoots()
            .some(
              (root) => root.pid === request.providerRoot.pid && root.incarnation === request.providerRoot.incarnation,
            );
          if (!isRecorded) {
            throw new ProxyControlProtocolError('invalid_state', 'This reaper never recorded the named provider root.');
          }
          return reaperConfirmProviderRootResultSchema.parse({ state: 'root-recorded' });
        },
      },
    ],
    [
      'reaper.handoff-install.v1',
      {
        authority: 'active',
        handle: (params) => {
          const request = guardianReaperHandoffInstallParamsSchema.parse(params);
          assertNamedCoordinatorBuild(request.successor, capsule);
          assertNamedTeardownReserve(request.teardownReserveMs, PROXY_TEARDOWN_RESERVE_MS);
          assertNamedOrphanTimeout(request.orphanTimeoutMs, deadlines.orphanTimeoutMs());
          const result = grants.install({
            grantId: request.grantId,
            secretSha256: request.secretSha256,
            ...setIdentity,
            operations: request.operations,
            orphanTimeoutMs: request.orphanTimeoutMs,
          });
          return result;
        },
      },
    ],
    [
      'reaper.record-redemption.v1',
      {
        // The guardian's own channel, the instant `guardian.handoff-redeem.v1` validates the credential — the same
        // shape `reaper.record-containment.v1`/`reaper.register-provider-root.v1` already use for guardian→
        // reaper facts.
        authority: 'pairing',
        handle: (params) => {
          const request = reaperRecordRedemptionParamsSchema.parse(params);
          const successor = controlTenancyHolderOf(request.successor);
          if (recordedRedemption !== null) {
            const different =
              recordedRedemption.grantId !== request.grantId ||
              !sameControlTenancyHolder(recordedRedemption.successor, successor) ||
              recordedRedemption.redemptionReceipt !== request.redemptionReceipt ||
              !sameOperations(recordedRedemption.operations, request.operations);
            if (different && deadlines.controlIsLive()) {
              throw new ProxyControlProtocolError(
                'identity_mismatch',
                'This reaper already recorded a different live control epoch.',
              );
            }
            if (!different) {
              return reaperRecordRedemptionResultSchema.parse({ state: 'redemption-recorded' });
            }
          }
          recordedRedemption = {
            grantId: request.grantId,
            successor,
            operations: request.operations,
            redemptionReceipt: request.redemptionReceipt,
          };
          return reaperRecordRedemptionResultSchema.parse({ state: 'redemption-recorded' });
        },
      },
    ],
    [
      'reaper.succession-register-operation.v1',
      {
        authority: 'active',
        handle: (params) => {
          const request = successionOperationRegisterParamsSchema.parse(params);
          const alreadyRecorded = recordedRedemption?.operations.find(
            (operation) => operation.operationId === request.operation.operationId,
          );
          if (alreadyRecorded !== undefined && !sameOperations([alreadyRecorded], [request.operation])) {
            throw new ProxyControlProtocolError(
              'identity_mismatch',
              'The operation id is already registered to a different full identity.',
            );
          }
          const result = successionOperationRegisterResultSchema.parse(grants.register(request.operation));
          if (recordedRedemption !== null && alreadyRecorded === undefined) {
            const operations = handoffOperationSetSchema.parse(
              [...recordedRedemption.operations, request.operation].sort((left, right) =>
                left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0,
              ),
            );
            recordedRedemption = { ...recordedRedemption, operations };
          }
          return result;
        },
      },
    ],
    [
      'reaper.handoff-rotate.v1',
      {
        // Authorized by the redemption `reaper.record-redemption.v1` recorded, not by an independent secret
        // check: admission can still refuse an incumbent holding live control the same way
        // `guardian.handoff-redeem.v1` and `handoff.redeem.v1` do — a matching receipt does not by itself
        // displace a coordinator this reaper's own deadline machine still considers live.
        authority: 'establishes-control',
        handle: (params) => {
          const request = reaperHandoffRotateParamsSchema.parse(params);
          assertNamedCoordinatorBuild(request.successor, capsule);
          const successor = controlTenancyHolderOf(request.successor);
          if (
            recordedRedemption === null ||
            recordedRedemption.grantId !== request.grantId ||
            !sameControlTenancyHolder(recordedRedemption.successor, successor) ||
            recordedRedemption.redemptionReceipt !== request.guardianRedemptionReceipt
          ) {
            throw new ProxyControlProtocolError(
              'grant_invalid',
              'Rotation did not present a redemption this reaper recorded.',
            );
          }
          return {
            holder: successor,
            fields: reaperHandoffRotateFieldsSchema.parse({
              // A wire result describing what this call did, not a deadline-model state — the deadline
              // machine this endpoint shares with the guardian has exactly one enum, and this is not a
              // member of it.
              state: 'successor-rotated',
              reaperRotationReceipt: mintReceipt(),
              operations: recordedRedemption.operations,
              reaper: identityOf(recorded as RecordedContainmentIdentity & { readonly containmentKind: string }),
            }),
          };
        },
      },
    ],
    [
      'reaper.containment-prepare.v1',
      {
        // The guardian's own channel: it is the sole destructive containment owner and the sole caller of
        // this method, closing this reaper's registration gate before asking it to snapshot its own
        // cumulative roots.
        authority: 'pairing',
        handle: (params) => {
          reaperContainmentPrepareParamsSchema.parse(params);
          const armed = requireEnforcer();
          registrationGateOpen = false;
          const token = containmentPrepareTokenSchema.parse(mintReceipt());
          preparedToken = token;
          return reaperContainmentPrepareResultSchema.parse({
            state: 'containment-prepared',
            token,
            providerRoots: armed.recordedRoots(),
          });
        },
      },
    ],
    [
      'reaper.containment-abort.v1',
      {
        authority: 'pairing',
        handle: (params) => {
          const request = reaperContainmentAbortParamsSchema.parse(params);
          if (preparedToken === request.token) {
            preparedToken = null;
            registrationGateOpen = true;
          } else if (preparedToken !== null) {
            // A stale or replayed token names a prepare this reaper has already superseded — refused rather
            // than silently reopening the *current* one out from under it.
            throw new ProxyControlProtocolError(
              'identity_mismatch',
              'This reaper holds a different prepared containment token.',
            );
          }
          // `preparedToken === null` and the presented token matches nothing current: idempotent no-op,
          // either an already-aborted retry or a gate that was never closed.
          return reaperContainmentAbortResultSchema.parse({ state: 'containment-registration-reopened' });
        },
      },
    ],
    [
      'reaper.acquisition-publish.v1',
      {
        authority: 'pairing',
        handle: (params) => {
          reaperAcquisitionPublishParamsSchema.parse(params);
          holderAuthority.publish();
          return reaperAcquisitionPublishResultSchema.parse({ state: 'acquisition-published' });
        },
      },
    ],
    [
      'reaper.holder-status.v1',
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
            throw new ProxyControlProtocolError('invalid_state', 'This reaper holds no observed holder yet.');
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
      'reaper.abandon-unattributable.v1',
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
            request.roleIdentity.role !== 'reaper' ||
            request.roleIdentity.pid !== self.pid ||
            request.roleIdentity.incarnation !== self.incarnation
          ) {
            throw new ProxyControlProtocolError('identity_mismatch', 'Abandonment named a different reaper.');
          }
          if (!options.abandonUnattributable()) {
            throw new ProxyControlProtocolError('invalid_state', 'This reaper has no unattributable hold to abandon.');
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
      heartbeatMethod: 'reaper.heartbeat.v1',
      methods,
      pairing: { openMethod: 'reaper.pair.v1', secret: capsule.guardianReaperAuthSecret },
    },
    // The deadline machine is the challenge authority: it compares the echo, records the round-trip
    // evidence that moves this enforcer's deadlines, and installs the replacement.
    challenges: deadlines,
    observer: {
      onControlLost: () => deadlines.observeEof(),
      // The guardian pairing peer is a separate authority from the coordinator's control (see `pairing`
      // above): its death proves nothing about the coordinator's own heartbeats, which must keep working.
      // What it does mean is that the party that linearizes an ordered redemption is gone, so admitting a
      // successor can now only fail — hence its own vocabulary, `observePairingLoss`, rather than folding
      // it into `observeEof` and collapsing two separate authorities into one.
      onPairingLost: () => {
        pairingLost = true;
        deadlines.observePairingLoss();
      },
    },
    timer,
    holderAuthority,
    requestTimeoutMs: PROXY_CONTROL_RPC_TIMEOUT_MS,
    // Teardown may legitimately spend the TERM and KILL graces plus the disappearance confirmation, which
    // is longer than a mutation RPC's budget. Cutting it off would report a failure for a reap in progress.
  });

  return {
    async listen(): Promise<void> {
      // Arming waits for `reaper.record-containment.v1`: before it, there is no identity to enforce, and an
      // enforcer without one could only ever confirm the absence of nothing.
      await endpoint.listen();
    },
    async close(): Promise<void> {
      enforcer?.disarm();
      await endpoint.close();
    },
    enforcer(): ArmedEnforcer | null {
      return enforcer;
    },
  };
}
