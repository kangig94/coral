import { z } from 'zod';

import type { MonotonicClock } from '../infra/monotonic-clock.js';
import type { ProcessContainmentEnvironment, RecordedContainmentIdentity } from '../infra/process-containment.js';
import { createBootstrapNonceCredential, type GuardianBootstrapCapsule } from './bootstrap-capsule.js';
import type { ControlClient } from './control-client.js';
import {
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
import {
  createGrantRegistry,
  grantSecretDigestSchema,
  grantSecretSchema,
  handoffOperationSetSchema,
  type GrantBinding,
} from './handoff-capsule.js';
import {
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  ProxyControlProtocolError,
  canonicalUuidSchema,
  coordinatorIdentitySchema,
  guardianIdentitySchema,
  operationIdentitySchema,
  proxyIdentitySchema,
  reaperIdentitySchema,
  type CoordinatorIdentity,
} from './protocol.js';
import { MAX_PROXY_OPERATION_LEDGERS } from './ledger.js';
import { PROXY_TEARDOWN_RESERVE_MS, type EnforcerDeadlineStateMachine } from './orphan-deadline.js';

const providerRootSchema = z
  .object({ pid: z.number().int().nonnegative(), processStartedAtSeconds: z.number().int().nonnegative() })
  .strict();

const registerProviderRootParamsSchema = z
  .object({
    proxy: proxyIdentitySchema,
    operation: operationIdentitySchema,
    reservationId: canonicalUuidSchema,
    activationNonce: canonicalUuidSchema,
    providerPid: z.number().int().nonnegative(),
    providerProcessStartedAtSeconds: z.number().int().nonnegative(),
  })
  .strict();

const operationActivateParamsSchema = z
  .object({
    operation: operationIdentitySchema,
    reservationId: canonicalUuidSchema,
    activationNonce: canonicalUuidSchema,
    providerRoot: providerRootSchema,
    jointContainmentReceipt: z.string().min(1),
  })
  .strict();

const operationReleaseParamsSchema = z
  .object({
    operation: operationIdentitySchema,
    reservationId: canonicalUuidSchema,
    activationNonce: canonicalUuidSchema,
    jointContainmentReceipt: z.string().min(1),
  })
  .strict();

/** The plan's `guardian.open.v1` request. Parsing it is what makes identity disagreement reportable. */
const openParamsSchema = z
  .object({
    bootstrapNonce: z.string().min(1),
    coordinator: coordinatorIdentitySchema,
    proxy: proxyIdentitySchema,
  })
  .strict();

const stopAndReapParamsSchema = z
  .object({
    guardian: guardianIdentitySchema,
    reaper: reaperIdentitySchema,
    proxy: proxyIdentitySchema,
    providerRoots: z.array(providerRootSchema).max(MAX_PROXY_OPERATION_LEDGERS),
  })
  .strict();

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
    claimed.processStartedAtSeconds !== actual.processStartedAtSeconds ||
    claimed.generation !== actual.generation ||
    claimed.flavor !== actual.flavor ||
    claimed.buildSetId !== actual.buildSetId ||
    claimed.hostFingerprint !== actual.hostFingerprint ||
    claimed.canonicalControlEndpoint !== actual.canonicalControlEndpoint
  ) {
    throw new ProxyControlProtocolError('identity_mismatch', 'Teardown named a different guardian than this one.');
  }
}

/**
 * The caller names the roots it believes are recorded. A disagreement means one side is reasoning about a
 * different containment, which teardown must surface rather than silently reap its own view of — the same
 * check the reaper performs on its own stop-and-reap request.
 */
function assertRecordedSetAgreement(
  claimed: readonly { pid: number; processStartedAtSeconds: number }[],
  recorded: readonly { pid: number; processStartedAtSeconds: number }[],
): void {
  const key = (root: { pid: number; processStartedAtSeconds: number }): string =>
    `${root.pid}@${root.processStartedAtSeconds}`;
  const recordedKeys = new Set(recorded.map(key));
  const claimedKeys = new Set(claimed.map(key));
  if (recordedKeys.size !== claimedKeys.size || [...claimedKeys].some((entry) => !recordedKeys.has(entry))) {
    throw new ProxyControlProtocolError(
      'identity_mismatch',
      'Teardown named a different provider-root set than this guardian recorded.',
    );
  }
}

const handoffInstallParamsSchema = z
  .object({
    grantId: canonicalUuidSchema,
    secretSha256: grantSecretDigestSchema,
    successor: coordinatorIdentitySchema,
    operations: handoffOperationSetSchema,
    orphanTimeoutMs: z.number().int().positive(),
    teardownReserveMs: z.number().int().positive(),
  })
  .strict();

const handoffRedeemParamsSchema = z
  .object({
    grantId: canonicalUuidSchema,
    secret: grantSecretSchema,
    successor: coordinatorIdentitySchema,
    operations: handoffOperationSetSchema,
  })
  .strict();

/**
 * Both authorities must ACK the same identity before a root may execute, so the receipt names both — the
 * reaper's own ACK is no longer a separate receipt, because the reaper holds nothing to revise it against.
 * The reservation tuple is recorded, not just parsed, so a caller presenting a different one for a known
 * operation is a disagreement this membership can detect rather than silently accept.
 */
type StagedMembership = Readonly<{
  jointContainmentReceipt: string;
  reservationId: string;
  activationNonce: string;
  root: z.infer<typeof providerRootSchema>;
}>;

export type GuardianOptions<Scope extends symbol> = Readonly<{
  capsule: GuardianBootstrapCapsule;
  clock: MonotonicClock<Scope>;
  deadlines: EnforcerDeadlineStateMachine<Scope>;
  containment: RecordedContainmentIdentity;
  containmentEnvironment: ProcessContainmentEnvironment<Scope>;
  scheduler: EnforcementScheduler;
  timer: ControlEndpointTimer;
  mintReceipt(): string;
  /** The paired reaper channel, held open for the lifetime of the set. */
  reaperChannel: ControlClient;
  self: Readonly<{ pid: number; processStartedAtSeconds: number }>;
  onOutcome(outcome: EnforcementOutcome): void;
  /** A wake later than the model's bound. Reported, but teardown still proceeds. */
  onProgressViolation(observedWakeLatencyMs: number): void;
}>;

export interface Guardian<Scope extends symbol> {
  listen(): Promise<void>;
  close(): Promise<void>;
  enforcer(): ArmedEnforcer<Scope>;
}

/**
 * The guardian owns grant-redemption admission and adoption state. It mirrors the reaper's recorded set so
 * it can enforce the same disappearance condition, but it can neither move nor extend the reaper's deadline.
 */
export function createGuardian<Scope extends symbol>(options: GuardianOptions<Scope>): Guardian<Scope> {
  const { capsule, clock, deadlines, containment, scheduler, timer, mintReceipt, self } = options;

  const enforcer = createArmedEnforcer({
    clock,
    deadlines,
    containment,
    containmentEnvironment: options.containmentEnvironment,
    scheduler,
    onOutcome: options.onOutcome,
    onProgressViolation: options.onProgressViolation,
  });

  const identity = Object.freeze({
    guardianInstanceId: capsule.guardianInstanceId,
    pid: self.pid,
    processStartedAtSeconds: self.processStartedAtSeconds,
    generation: capsule.generation,
    flavor: capsule.flavor,
    buildSetId: capsule.buildSetId,
    hostFingerprint: capsule.hostFingerprint,
    canonicalControlEndpoint: capsule.canonicalControlEndpoint,
  });

  /**
   * Every grant this guardian issues is bound to its own set, taken from its own capsule. A coordinator
   * therefore cannot install a grant naming a set it does not belong to — it never supplies the binding.
   */
  /**
   * Every field a grant is bound to except the orphan timeout, which the installer names because it is the
   * budget a successor plans its attach against; the guardian supplies the rest from its own capsule so a
   * coordinator can never install a grant for a set it does not belong to.
   */
  const setIdentity: GrantBinding = Object.freeze({
    generation: capsule.generation,
    flavor: capsule.flavor,
    buildSetId: capsule.buildSetId,
    hostFingerprint: capsule.hostFingerprint,
    guardianInstanceId: capsule.guardianInstanceId,
    reaperInstanceId: capsule.reaperInstanceId,
    proxyInstanceId: capsule.proxyInstanceId,
  });

  /** A grant is build-bound, so only a coordinator of this exact build may install or redeem one. */
  const assertNamedCoordinatorBuild = (coordinator: CoordinatorIdentity): void => {
    if (
      coordinator.generation !== capsule.generation ||
      coordinator.flavor !== capsule.flavor ||
      coordinator.buildSetId !== capsule.buildSetId
    ) {
      throw new ProxyControlProtocolError('identity_mismatch', 'The named coordinator belongs to a different build.');
    }
  };

  const bootstrapNonce = createBootstrapNonceCredential(capsule.bootstrapNonce);
  const grants = createGrantRegistry(mintReceipt);
  const staged = new Map<string, StagedMembership>();

  const methods = new Map<string, ControlMethod>([
    [
      'guardian.open.v1',
      {
        authority: 'establishes-control',
        handle: (params) => {
          const request = openParamsSchema.parse(params);
          bootstrapNonce.spend(request.bootstrapNonce);
          assertNamedCoordinatorBuild(request.coordinator);
          // The result names the proxy this guardian was issued for, so a coordinator that opened against
          // the wrong set learns it from the response rather than from a later staging failure.
          return { holder: request.coordinator.instanceId, fields: { guardian: identity, proxy: request.proxy } };
        },
      },
    ],
    [
      'guardian.handoff-install.v1',
      {
        authority: 'active',
        handle: (params) => {
          const request = handoffInstallParamsSchema.parse(params);
          assertNamedCoordinatorBuild(request.successor);
          // The reserve is derived from this build's own process constants, not chosen per grant. A caller
          // naming a different one disagrees about arithmetic both sides compute, which is a mismatch to
          // report rather than a value to accept.
          if (request.teardownReserveMs !== PROXY_TEARDOWN_RESERVE_MS) {
            throw new ProxyControlProtocolError(
              'identity_mismatch',
              `The named teardown reserve is not this build's ${PROXY_TEARDOWN_RESERVE_MS}ms.`,
            );
          }
          return grants.install({
            grantId: request.grantId,
            secretSha256: request.secretSha256,
            ...setIdentity,
            operationIds: request.operations.map((entry) => entry.operation.operationId),
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
        handle: (params) => {
          const request = handoffRedeemParamsSchema.parse(params);
          assertNamedCoordinatorBuild(request.successor);
          const redemption = grants.redeem({
            grantId: request.grantId,
            secret: request.secret,
            successorInstanceId: request.successor.instanceId,
            operationIds: request.operations.map((entry) => entry.operation.operationId),
            binding: setIdentity,
          });
          return {
            holder: request.successor.instanceId,
            fields: {
              state: 'redeemed-provisional',
              redemptionReceipt: redemption.redemptionReceipt,
              operations: redemption.grant.operationIds,
            },
          };
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
          const request = registerProviderRootParamsSchema.parse(params);
          const root = { pid: request.providerPid, processStartedAtSeconds: request.providerProcessStartedAtSeconds };
          // Idempotent by stable identity: the same operation reporting the same root gets the receipt it
          // already holds, rather than a fresh one that silently invalidates it.
          const already = staged.get(request.operation.operationId);
          if (already !== undefined) {
            if (
              already.root.pid !== root.pid ||
              already.root.processStartedAtSeconds !== root.processStartedAtSeconds
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
            throw new ProxyControlProtocolError('invalid_state', 'This guardian holds its maximum staged operations.');
          }
          // Checked before the reaper round trip, not after: this guardian's own enforcer can refuse a root
          // on its own cap too, and finding that out only after the reaper has already staged it would leave
          // the two authorities disagreeing about what this containment holds.
          if (enforcer.wouldExceedProviderRootCap(root)) {
            throw new ProxyControlProtocolError(
              'invalid_state',
              'This guardian holds its maximum recorded provider roots.',
            );
          }
          // Forward the exact root; the joint receipt is only minted once both authorities ACK the same
          // identity, so neither can be talked into containing something the other never recorded. The
          // reaper is asked to record a root, not an operation — it has no operation vocabulary to forward.
          const reaperResult = (await options.reaperChannel.call(
            'reaper.register-provider-root.v1',
            { providerRoot: root },
            PROXY_CONTROL_RPC_TIMEOUT_MS,
          )) as { state?: string };
          if (reaperResult.state !== 'root-recorded') {
            throw new ProxyControlProtocolError(
              'invalid_state',
              'The reaper did not record the reported provider root.',
            );
          }
          try {
            enforcer.registerProviderRoot(root);
          } catch (error: unknown) {
            // The cap was already checked above, so reaching this is a defect rather than an expected race —
            // but `EnforcementError` is this module's internal vocabulary, not a protocol code, and it must
            // not cross the wire untranslated: the caller would get a message with no code to act on.
            if (error instanceof EnforcementError) {
              throw new ProxyControlProtocolError('invalid_state', error.message);
            }
            throw error;
          }
          const jointContainmentReceipt = mintReceipt();
          staged.set(request.operation.operationId, {
            jointContainmentReceipt,
            reservationId: request.reservationId,
            activationNonce: request.activationNonce,
            root,
          });
          return { state: 'staged-contained', providerRoot: root, jointContainmentReceipt };
        },
      },
    ],
    [
      'guardian.operation-activate.v1',
      {
        authority: 'active',
        handle: async (params) => {
          const request = operationActivateParamsSchema.parse(params);
          const membership = staged.get(request.operation.operationId);
          if (membership === undefined || membership.jointContainmentReceipt !== request.jointContainmentReceipt) {
            throw new ProxyControlProtocolError(
              'unauthorized_control',
              'Activation must present the joint containment receipt.',
            );
          }
          // A known operation staged under a specific reservation; a caller presenting a different one is
          // reasoning about a different prepare than the one this membership records, not a legitimate retry.
          if (
            membership.reservationId !== request.reservationId ||
            membership.activationNonce !== request.activationNonce
          ) {
            throw new ProxyControlProtocolError(
              'identity_mismatch',
              'Activation named a different reservation than this operation staged.',
            );
          }
          if (
            membership.root.pid !== request.providerRoot.pid ||
            membership.root.processStartedAtSeconds !== request.providerRoot.processStartedAtSeconds
          ) {
            throw new ProxyControlProtocolError('identity_mismatch', 'Activation named a different provider root.');
          }
          // Activation authority is converted only after the reaper confirms it still holds the same root —
          // proof this reaper is alive and still containing the target at the instant of activation. There is
          // no operation for it to authorize, so a retry that reaches an unchanged root always succeeds.
          const reaperResult = (await options.reaperChannel.call(
            'reaper.confirm-provider-root.v1',
            { providerRoot: request.providerRoot },
            PROXY_CONTROL_RPC_TIMEOUT_MS,
          )) as { state?: string };
          if (reaperResult.state !== 'root-recorded') {
            throw new ProxyControlProtocolError('invalid_state', 'The reaper did not confirm the provider root.');
          }
          return { state: 'activation-authorized', jointActivationReceipt: mintReceipt() };
        },
      },
    ],
    [
      'guardian.operation-release.v1',
      {
        authority: 'active',
        handle: (params) => {
          const request = operationReleaseParamsSchema.parse(params);
          const membership = staged.get(request.operation.operationId);
          if (membership === undefined || membership.jointContainmentReceipt !== request.jointContainmentReceipt) {
            throw new ProxyControlProtocolError(
              'unauthorized_control',
              'Release must present the joint containment receipt.',
            );
          }
          // Same disagreement `guardian.operation-activate.v1` refuses: a different reservation for a known
          // operation is reasoning about a different prepare, not the one this membership records.
          if (
            membership.reservationId !== request.reservationId ||
            membership.activationNonce !== request.activationNonce
          ) {
            throw new ProxyControlProtocolError(
              'identity_mismatch',
              'Release named a different reservation than this operation staged.',
            );
          }
          // The membership record is dropped, but the recorded root stays in the enforcer: a released
          // operation does not prove its process is gone, and only teardown may conclude absence.
          staged.delete(request.operation.operationId);
          return { state: 'membership-released' };
        },
      },
    ],
    [
      'guardian.stop-and-reap.v1',
      {
        authority: 'active',
        budgetMs: 'caller-deadline',
        handle: async (params) => {
          const request = stopAndReapParamsSchema.parse(params);
          // Both agreements the reaper's own handler already makes on its half of the same request: the
          // caller must be naming this guardian and this containment's own recorded roots, so one authority
          // can never accept a teardown request the other would refuse.
          assertNamedGuardianIdentity(request.guardian, identity);
          assertRecordedSetAgreement(request.providerRoots, enforcer.recordedRoots());
          const outcome = await enforcer.stopAndReap(deadlines.bounds().exitDeadline);
          if (outcome.kind !== 'containment-absent') {
            throw new ProxyControlProtocolError(
              'invalid_state',
              `Guardian teardown did not complete: ${outcome.kind}.`,
            );
          }
          return { state: 'containment-absent', disappearanceReceipt: outcome.disappearanceReceipt };
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
    },
    timer,
    requestTimeoutMs: PROXY_CONTROL_RPC_TIMEOUT_MS,
    // Teardown may legitimately spend the TERM and KILL graces plus the disappearance confirmation, which
    // is longer than a mutation RPC's budget. Cutting it off would report a failure for a reap in progress.
  });

  return {
    async listen(): Promise<void> {
      await endpoint.listen();
      enforcer.arm();
    },
    async close(): Promise<void> {
      enforcer.disarm();
      options.reaperChannel.close();
      await endpoint.close();
    },
    enforcer(): ArmedEnforcer<Scope> {
      return enforcer;
    },
  };
}
