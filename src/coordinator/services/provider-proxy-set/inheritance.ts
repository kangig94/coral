import { probeProcessIncarnation } from '../../../infra/node-process.js';
import {
  currentHandoffCapsulePath,
  readHandoffCapsuleFile,
  type HandoffCapsuleV3,
} from '../../../provider-proxy/handoff-capsule.js';
import { PROXY_CONTROL_RPC_TIMEOUT_MS, type CoordinatorIdentity } from '../../../provider-proxy/protocol.js';
import type { ProviderEventHandler } from '../../../provider-proxy/control-client.js';
import type { HeartbeatObservation } from '../../../provider-proxy/heartbeat-observation.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { Database } from '../../../store/db.js';
import type { ProviderOperationIdentity, ProviderOperationRecord } from '../../../store/provider-operation-record.js';
import {
  ProviderProxyRoleControlUnavailableError,
  type ProviderProxyRoleControlAvailabilityIncident,
} from '../../live/provider-proxy/role-control.js';
import { createProviderProxySetAuthority } from '../../live/provider-proxy/set-authority.js';
import {
  closeRedeemedProviderProxyControl,
  providerProxyControlRedemptionBundle,
  redeemProviderProxyControl,
  type ProviderProxyControlRedemptionRefusal,
  type RedeemedProviderProxyControl,
} from '../../live/provider-proxy/control-redemption.js';
import {
  createProviderProxyOperationAuthority,
  type DurableProviderProxyOperationAuthority,
  type ProviderProxyOperationAuthority,
} from '../../live/provider-proxy/operation-route.js';
import type { ProviderProxySetAcquisitionIdentity } from '../../live/provider-hosts/proxy-set-acquisition.js';
import {
  providerProxySetIdentitiesEqual,
  providerProxySetIdentityFromCapsule,
  providerProxySetIdentityFromRecord,
  providerProxySetKey,
  type ProviderProxySetIdentity,
} from './identity.js';
import type { ProviderProxyOperationSnapshot } from '../operation-registry.js';
import {
  runProviderProxyRecoveryDeadline,
  type ProviderProxyRecoveryArbiter,
  type ProviderProxyRecoveryDispatcher,
  type ProviderProxyRecoveryTurnSinks,
} from '../provider-proxy-recovery-policy.js';
import type { ProviderProxySetContainmentProver } from './containment-proof.js';
import type { ProviderProxySetRecordedContainmentReaper } from './index.js';

/**
 * The branch of proxy-set acquisition that redeems a predecessor's continuously recoverable set instead of
 * spawning a new one. Fresh acquisition installs the role digests and durable capsule before publishing the
 * set; this file is the read half.
 *
 * The capsule is addressable, never discovered: `currentHandoffCapsulePath` hashes `flavor`/`generation`
 * (this successor's own — a grant is build-bound) and `buildSetId`/`hostFingerprint`/`proxyInstanceId` (the
 * locator's — the predecessor's), so there is exactly one path to check, never a scan. Absent, stale, or
 * wrong-identity capsules mean no credential exists for this exact address. Redemption and proof failures
 * remain errors so transport ambiguity cannot be mistaken for authority absence.
 *
 * Lives in `coordinator/services/`, not `coordinator/live/provider-hosts/` (where `DefaultProviderHostManager`,
 * this module's only production caller, itself lives): it composes durable operation locators with a live
 * control capability, which
 * `coordinator/live/**` may not do freely (`architecture-layering.test.ts`'s coordinator-contract-entrypoint
 * rule) — the same reason `provider-proxy-operation-activation.ts` sits here rather than beside the route it
 * backs.
 */

const INHERITANCE_REDEMPTION_DEADLINE_MS = 45_000;

export type ProviderProxySetLocator = Readonly<{
  operation: ProviderOperationIdentity;
  locator: ProviderOperationRecord['locator'];
}>;

export type ProviderProxySetInheritanceDeps = Readonly<{
  runtime: Runtime;
  baseDir?: string;
  /** This successor's own wire identity — `pid`/`incarnation` read fresh, matching
   *  `ensureProviderProxySet`'s own coordinator-identity construction. */
  coordinatorIdentity: CoordinatorIdentity;
  operationRegistry: ProviderProxyOperationSnapshot;
  /** Wired onto the redeemed proxy connection exactly as ordinary acquisition wires it onto a freshly opened
   *  one (`ProviderProxyAcquisitionStepsOptions.onProviderEvent`'s own doc). */
  onProviderEvent?(): ProviderEventHandler;
  collectContainmentEvidence?: ProviderProxySetContainmentProver['collectContainmentEvidence'];
  reapRecordedContainment?: ProviderProxySetRecordedContainmentReaper;
  registerInheritedSet?(set: ProviderProxyOperationAuthority): void;
}>;

export type ProviderProxySetInheritanceOutcome =
  | Readonly<{ kind: 'inherited'; set: DurableProviderProxyOperationAuthority }>
  | Readonly<{ kind: 'containment-disappeared'; disappearanceReceipt: string }>
  | Readonly<{ kind: 'recorded-group-unattributable' }>
  | Readonly<{ kind: 'not-bequeathed'; reason: string }>
  | Readonly<{ kind: 'temporarily-unavailable'; incident: ProviderProxySetAvailabilityIncident }>;

export type ProviderProxySetRedemptionOutcome =
  | Readonly<{ kind: 'redeemed'; set: DurableProviderProxyOperationAuthority }>
  | Readonly<{
      kind: 'protocol-incompatible';
      role: Extract<ProviderProxyRoleControlAvailabilityIncident, { kind: 'role-heartbeat-indeterminate' }>['role'];
      method: Extract<ProviderProxyRoleControlAvailabilityIncident, { kind: 'role-heartbeat-indeterminate' }>['method'];
    }>
  | Readonly<{ kind: 'temporarily-unavailable'; incident: ProviderProxySetAvailabilityIncident }>;

export type ProviderProxySetAvailabilityIncident =
  | ProviderProxyRoleControlAvailabilityIncident
  | Readonly<{ kind: 'recovery-deadline'; timeoutMs: 45_000 }>;

function dispatchProviderProxySetInheritance(
  createTurn: (sinks: ProviderProxyRecoveryTurnSinks) => ProviderProxyRecoveryArbiter,
  locator: ProviderProxySetLocator,
  db: Database,
  signal: AbortSignal,
): Promise<ProviderProxySetInheritanceOutcome> {
  return new Promise((resolve, reject) => {
    const turn = createTurn({
      evidence: (value) => resolve(value as ProviderProxySetInheritanceOutcome),
      retry: (retry) =>
        resolve({
          kind: 'temporarily-unavailable',
          incident: retry.incident as Extract<
            ProviderProxySetInheritanceOutcome,
            { kind: 'temporarily-unavailable' }
          >['incident'],
        }),
      fatal: reject,
      cancel: reject,
    });
    turn.start({
      sourceId: 'inheritance',
      producerId: 'set-inheritance',
      input: { locator, db, signal },
    });
  });
}

export function recoverProviderProxySetAtStartup(
  dispatcher: ProviderProxyRecoveryDispatcher,
  locator: ProviderProxySetLocator,
  db: Database,
  signal: AbortSignal,
): Promise<ProviderProxySetInheritanceOutcome> {
  return dispatchProviderProxySetInheritance(
    (sinks) =>
      dispatcher.begin('startup-set-inheritance', { setIdentity: providerProxySetIdentityFromRecord(locator) }, sinks),
    locator,
    db,
    signal,
  );
}

export function recoverProviderProxySetOrdinarily(
  dispatcher: ProviderProxyRecoveryDispatcher,
  locator: ProviderProxySetLocator,
  db: Database,
  signal: AbortSignal,
): Promise<ProviderProxySetInheritanceOutcome> {
  return dispatchProviderProxySetInheritance(
    (sinks) =>
      dispatcher.begin('ordinary-set-inheritance', { setIdentity: providerProxySetIdentityFromRecord(locator) }, sinks),
    locator,
    db,
    signal,
  );
}

export class ProviderProxySetInheritanceCorruptionError extends Error {
  readonly code:
    | 'role_operation_set_disagreement'
    | 'role_identity_disagreement'
    | 'capsule_identity_disagreement'
    | 'durable_identity_disagreement';

  constructor(code: ProviderProxySetInheritanceCorruptionError['code'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderProxySetInheritanceCorruptionError';
    this.code = code;
    Object.setPrototypeOf(this, ProviderProxySetInheritanceCorruptionError.prototype);
  }
}

function heartbeatObservationAvailabilityReason(observation: HeartbeatObservation): string {
  switch (observation.kind) {
    case 'reply':
      return observation.reply.kind;
    case 'no-response-before-deadline':
    case 'delivery-unconfirmed':
    case 'channel-fault':
      return observation.kind;
    case 'locally-unsent':
      return `${observation.kind}:${observation.stage}`;
  }
}

export function providerProxySetAvailabilityReason(incident: ProviderProxySetAvailabilityIncident): string {
  switch (incident.kind) {
    case 'role-control-unavailable':
      return [
        incident.kind,
        incident.role,
        incident.stage,
        incident.method ?? 'none',
        incident.origin,
        incident.controlCode,
      ].join(':');
    case 'role-control-busy':
      return [incident.kind, incident.role, incident.method, incident.protocolCode, incident.admissionReason].join(':');
    case 'role-heartbeat-indeterminate':
      return [
        incident.kind,
        incident.role,
        incident.method,
        heartbeatObservationAvailabilityReason(incident.observation),
      ].join(':');
    case 'recovery-deadline':
      return `${incident.kind}:${incident.timeoutMs}`;
  }
}

const NOTHING_TO_INHERIT_REASON = 'no capsule at this address';

export type ProviderProxySetInheritanceRefusal = 'other-build' | 'unreadable-identity';

/**
 * Whether this build may inherit a set, and why not when it may not. One home because the rule is enforced at
 * two entry points that cannot be merged — discovery classifying a capsule it found, and a claimed record
 * deriving its capsule's address for itself — and the two disagreeing is how a foreign set gets dialed.
 *
 * Dialing one is not a failed attempt but a fatal one: `handoff.redeem` is gated on build identity at the role
 * (`assertNamedCoordinatorBuild`), a foreign set answers `identity_mismatch`, and the recovery policy retires
 * that fatally — taking this coordinator down over a set it never owned. `capsuleMatchesLocator` cannot catch
 * it either, because it compares a capsule against the *record's* build, and for a foreign set those agree.
 *
 * The rule has no version exceptions, and that is the whole of it: **a capsule this build cannot derive a set
 * identity from is represented, never dialed.** `providerProxySetIdentityFromCapsule` accepts V3 alone, so V1
 * and V2 both fail it and both are refused here.
 */
export type ProviderProxySetInheritanceVerdict<T> =
  | Readonly<{ kind: 'inheritable'; candidate: T }>
  | Readonly<{ kind: 'refused'; reason: ProviderProxySetInheritanceRefusal }>;

export function classifyProviderProxySetInheritance<T extends Readonly<{ buildSetId: string; version?: number }>>(
  candidate: T,
  ownBuildSetId: string,
): ProviderProxySetInheritanceVerdict<Exclude<T, { version: 1 | 2 }>> {
  if (candidate.buildSetId !== ownBuildSetId) return { kind: 'refused', reason: 'other-build' };
  if (candidate.version === 1 || candidate.version === 2) {
    return { kind: 'refused', reason: 'unreadable-identity' };
  }
  // The verdict carries the narrowing so callers need no cast: refusing every generation whose identity this
  // build cannot read is what leaves the shapes it can actually act on, and saying so in the return type is
  // what keeps it true.
  return { kind: 'inheritable', candidate: candidate as Exclude<T, { version: 1 | 2 }> };
}

/** Every field a capsule read back from disk must agree with the locator that named its address, plus this
 *  successor's own build, because bytes for any other set cannot establish authority over this one. */
function capsuleMatchesLocator(
  capsule: HandoffCapsuleV3,
  reference: ProviderProxySetLocator,
  successor: CoordinatorIdentity,
): boolean {
  const { operation, locator } = reference;
  return (
    capsule.generation === successor.generation &&
    capsule.flavor === successor.flavor &&
    capsule.buildSetId === operation.buildSetId &&
    capsule.hostFingerprint === locator.hostFingerprint &&
    capsule.proxyInstanceId === operation.proxyInstanceId &&
    capsule.guardianInstanceId === locator.guardian.instanceId &&
    capsule.reaperInstanceId === locator.reaper.instanceId &&
    capsule.guardianControlEndpoint === locator.guardian.controlEndpoint &&
    capsule.reaperControlEndpoint === locator.reaper.controlEndpoint &&
    capsule.proxyEndpoint === locator.proxy.controlEndpoint
  );
}

function inheritanceRefusalError(refusal: ProviderProxyControlRedemptionRefusal): Error {
  switch (refusal.kind) {
    case 'role-refused':
      return refusal.error;
    case 'protocol-incompatible':
      return refusal.error;
    case 'operation-membership-disagreement':
      return new ProviderProxySetInheritanceCorruptionError(
        'role_operation_set_disagreement',
        'Guardian, reaper, and proxy redeemed different operation sets.',
      );
    case 'identity-disagreement':
      return new ProviderProxySetInheritanceCorruptionError(
        'capsule_identity_disagreement',
        'Provider proxy redemption identities disagree with the handoff capsule.',
      );
  }
}

async function buildInheritedAuthority(
  redemption: RedeemedProviderProxyControl,
  capsulePath: string,
  capsule: HandoffCapsuleV3,
  expectedIdentity: ProviderProxySetIdentity | null,
  deps: ProviderProxySetInheritanceDeps,
  signal: AbortSignal,
): Promise<DurableProviderProxyOperationAuthority> {
  const bundle = providerProxyControlRedemptionBundle(redemption);
  try {
    if (expectedIdentity !== null && !providerProxySetIdentitiesEqual(expectedIdentity, bundle.setIdentity)) {
      throw new ProviderProxySetInheritanceCorruptionError(
        'durable_identity_disagreement',
        'Provider proxy redemption identity disagrees with the durable operation record.',
      );
    }

    const base = createProviderProxySetAuthority({
      proxyInstanceId: bundle.proxyIdentity.proxyInstanceId,
      guardianClient: bundle.clients.guardian,
      proxyClient: bundle.clients.proxy,
      reaperClient: bundle.clients.reaper,
      guardianIdentity: bundle.guardianIdentity,
      reaperIdentity: bundle.reaperIdentity,
      proxyIdentityFields: bundle.proxyIdentity,
      heartbeats: bundle.heartbeats,
      coordinatorIdentity: deps.coordinatorIdentity,
      handoffCapsulePath: capsulePath,
      runtime: deps.runtime,
      recoveryCapsule: capsule,
      recoveryOperations: bundle.recoveryOperations,
      operationRegistry: deps.operationRegistry,
      ...(deps.onProviderEvent === undefined ? {} : { onProviderEvent: deps.onProviderEvent }),
    });
    const installation = await base.installRecoveryCredential(signal);
    switch (installation.kind) {
      case 'installed':
      case 'retryable':
      case 'refused':
        break;
      case 'cancelled':
        signal.throwIfAborted();
        throw new Error('provider_proxy_recovery_credential_install_cancelled');
    }
    const set = createProviderProxyOperationAuthority({
      base,
      setIdentity: bundle.setIdentity,
      clients: bundle.clients,
      faults: bundle.faults,
      mutationRpcTimeoutMs: PROXY_CONTROL_RPC_TIMEOUT_MS,
    });
    deps.registerInheritedSet?.(set);
    return set;
  } catch (error: unknown) {
    closeRedeemedProviderProxyControl(redemption);
    throw error;
  }
}

async function redeemCapsule(
  capsulePath: string,
  capsule: HandoffCapsuleV3,
  expectedIdentity: ProviderProxySetIdentity | null,
  deps: ProviderProxySetInheritanceDeps,
  signal: AbortSignal,
): Promise<DurableProviderProxyOperationAuthority> {
  const redemption = await redeemProviderProxyControl(
    capsule,
    providerProxySetIdentityFromCapsule(capsule),
    {
      runtime: deps.runtime,
      coordinatorIdentity: deps.coordinatorIdentity,
      ...(deps.onProviderEvent === undefined ? {} : { onProviderEvent: deps.onProviderEvent }),
    },
    signal,
  );
  if (redemption.kind === 'unavailable') throw redemption.error;
  if (redemption.kind === 'refused') throw inheritanceRefusalError(redemption.refusal);
  return buildInheritedAuthority(redemption, capsulePath, capsule, expectedIdentity, deps, signal);
}

async function redeem(
  reference: ProviderProxySetLocator,
  deps: ProviderProxySetInheritanceDeps,
  signal: AbortSignal,
): Promise<ProviderProxySetInheritanceOutcome> {
  const { operation, locator } = reference;
  // Refused before the capsule is even read, because reading it is one step from dialing it. Not-bequeathed is
  // the honest outcome rather than an error: there is genuinely nothing here this build may inherit, and the
  // caller already knows how to settle a set it could not take over.
  if (classifyProviderProxySetInheritance(operation, deps.coordinatorIdentity.buildSetId).kind === 'refused') {
    return { kind: 'not-bequeathed', reason: 'the recorded set belongs to another build' };
  }
  const capsulePath = currentHandoffCapsulePath(
    {
      generation: deps.coordinatorIdentity.generation,
      flavor: deps.coordinatorIdentity.flavor,
      buildSetId: operation.buildSetId,
      hostFingerprint: locator.hostFingerprint,
      proxyInstanceId: operation.proxyInstanceId,
    },
    deps.baseDir === undefined ? undefined : { baseDir: deps.baseDir },
  );
  const capsule = readHandoffCapsuleFile(capsulePath, {
    storage: deps.runtime.storage,
    uid: process.getuid?.() ?? 0,
  });
  if (capsule === null) return { kind: 'not-bequeathed', reason: NOTHING_TO_INHERIT_REASON };
  const verdict = classifyProviderProxySetInheritance(capsule, deps.coordinatorIdentity.buildSetId);
  if (verdict.kind === 'refused') {
    return { kind: 'not-bequeathed', reason: 'the capsule predates the process incarnation token' };
  }
  const inheritableCapsule = verdict.candidate;
  if (!capsuleMatchesLocator(inheritableCapsule, reference, deps.coordinatorIdentity)) {
    return { kind: 'not-bequeathed', reason: 'capsule identity disagrees with the committed locator' };
  }
  const set = await redeemCapsule(
    capsulePath,
    inheritableCapsule,
    providerProxySetIdentityFromRecord(reference),
    deps,
    signal,
  );
  return { kind: 'inherited', set };
}

export async function attemptProviderProxySetInheritance(
  locator: ProviderProxySetLocator,
  db: Database,
  deps: ProviderProxySetInheritanceDeps,
  signal: AbortSignal,
): Promise<ProviderProxySetInheritanceOutcome> {
  const identity = providerProxySetIdentityFromRecord(locator);
  let outcome: ProviderProxySetInheritanceOutcome;
  try {
    outcome = await redeem(locator, deps, signal);
  } catch (error: unknown) {
    if (!(error instanceof ProviderProxyRoleControlUnavailableError)) throw error;
    try {
      const evidence = await deps.collectContainmentEvidence?.(identity, db, signal);
      if (evidence?.kind === 'reap-required') {
        if (deps.reapRecordedContainment === undefined) {
          throw new Error('provider_proxy_set_containment_reaper_unavailable', { cause: error });
        }
        const reapResult = await deps.reapRecordedContainment(evidence, signal, () => undefined);
        if (reapResult.kind === 'containment-absent') {
          return { kind: 'containment-disappeared', disappearanceReceipt: reapResult.disappearanceReceipt };
        }
        return reapResult;
      }
    } catch (proofError: unknown) {
      throw new AggregateError(
        [error, proofError],
        'Provider proxy role control was unavailable and containment proof failed.',
        { cause: proofError },
      );
    }
    return { kind: 'temporarily-unavailable', incident: error.incident };
  }
  if (outcome.kind !== 'not-bequeathed') return outcome;
  const evidence = await deps.collectContainmentEvidence?.(identity, db, signal);
  if (evidence?.kind !== 'reap-required') return outcome;
  if (deps.reapRecordedContainment === undefined) {
    throw new Error('provider_proxy_set_containment_reaper_unavailable');
  }
  const reapResult = await deps.reapRecordedContainment(evidence, signal, () => undefined);
  return reapResult.kind === 'containment-absent'
    ? { kind: 'containment-disappeared', disappearanceReceipt: reapResult.disappearanceReceipt }
    : reapResult;
}

/**
 * The narrow capability startup saga reconciliation and generic running-job recovery drive: attempt
 * inheritance for one locator, given only the locator, store, and caller signal. Everything
 * `attemptProviderProxySetInheritance` itself needs beyond that — this coordinator's own wire identity, the
 * operation registry, `onProviderEvent`, and where a
 * successfully redeemed set is registered — is closed over by `createProviderProxySetInheritance` at
 * composition time, mirroring `ProviderProxySetAcquisitionConfig`'s own composed-once shape.
 */
export interface ProviderProxySetInheritance {
  inheritProviderProxySet(
    locator: ProviderProxySetLocator,
    db: Database,
    signal: AbortSignal,
  ): Promise<ProviderProxySetInheritanceOutcome>;
  redeemDiscoveredCapsule(
    capsule: HandoffCapsuleV3,
    capsulePath: string,
    signal: AbortSignal,
  ): Promise<ProviderProxySetRedemptionOutcome>;
}

export type CreateProviderProxySetInheritanceOptions = Readonly<{
  runtime: Runtime;
  identity: ProviderProxySetAcquisitionIdentity;
  operationRegistry: ProviderProxyOperationSnapshot;
  containmentProver: ProviderProxySetContainmentProver;
  reapRecordedContainment?: ProviderProxySetRecordedContainmentReaper;
  onProviderEvent?(): ProviderEventHandler;
  /** Where a successfully inherited set is folded in so it participates in this coordinator's own later
   *  shutdown. */
  registerInheritedSet(set: ProviderProxyOperationAuthority): void;
}>;

/**
 * Composes `attemptProviderProxySetInheritance` with this coordinator's own identity and registries, the same
 * way `world.ts` composes `ProviderProxySetAcquisitionConfig` for ordinary acquisition. This is the one
 * production constructor for `ProviderProxySetInheritance`.
 */
export function createProviderProxySetInheritance(
  options: CreateProviderProxySetInheritanceOptions,
): ProviderProxySetInheritance {
  const inFlightByIdentity = new Map<string, Promise<ProviderProxySetInheritanceOutcome>>();

  const deps = (
    registerInheritedSet?: (set: ProviderProxyOperationAuthority) => void,
  ): ProviderProxySetInheritanceDeps | null => {
    const pid = options.runtime.env.pid();
    const platform = options.runtime.env.platform() as NodeJS.Platform;
    const incarnation = probeProcessIncarnation(pid, platform);
    if (incarnation === null) return null;
    return {
      runtime: options.runtime,
      coordinatorIdentity: {
        instanceId: options.identity.instanceId,
        pid,
        incarnation,
        generation: 'gen2',
        flavor: options.identity.flavor,
        buildSetId: options.identity.buildSetId,
      },
      operationRegistry: options.operationRegistry,
      collectContainmentEvidence: options.containmentProver.collectContainmentEvidence,
      ...(options.reapRecordedContainment === undefined
        ? {}
        : { reapRecordedContainment: options.reapRecordedContainment }),
      ...(registerInheritedSet === undefined ? {} : { registerInheritedSet }),
      ...(options.onProviderEvent === undefined ? {} : { onProviderEvent: options.onProviderEvent }),
    };
  };

  return {
    async inheritProviderProxySet(locator, db, signal) {
      const identityKey = providerProxySetKey(providerProxySetIdentityFromRecord(locator));
      const existing = inFlightByIdentity.get(identityKey);
      if (existing !== undefined) return existing;
      const attempt = (async (): Promise<ProviderProxySetInheritanceOutcome> => {
        try {
          const inheritanceDeps = deps(options.registerInheritedSet);
          let outcome: ProviderProxySetInheritanceOutcome;
          if (inheritanceDeps === null) {
            outcome = { kind: 'not-bequeathed', reason: 'could not read this coordinator process’s own incarnation' };
          } else {
            const deadline = await runProviderProxyRecoveryDeadline({
              time: options.runtime.time,
              signal,
              timeoutMs: INHERITANCE_REDEMPTION_DEADLINE_MS,
              produce: (bounded) => attemptProviderProxySetInheritance(locator, db, inheritanceDeps, bounded),
            });
            outcome =
              deadline.kind === 'settled'
                ? deadline.value
                : { kind: 'temporarily-unavailable', incident: deadline.incident };
          }
          return outcome;
        } finally {
          inFlightByIdentity.delete(identityKey);
        }
      })();
      inFlightByIdentity.set(identityKey, attempt);
      return attempt;
    },
    async redeemDiscoveredCapsule(capsule, capsulePath, signal) {
      const inheritanceDeps = deps();
      if (inheritanceDeps === null) {
        throw new Error('could not read this coordinator process’s own incarnation');
      }
      const deadline = await runProviderProxyRecoveryDeadline({
        time: options.runtime.time,
        signal,
        timeoutMs: INHERITANCE_REDEMPTION_DEADLINE_MS,
        produce: (bounded) => redeemCapsule(capsulePath, capsule, null, inheritanceDeps, bounded),
      });
      if (
        deadline.kind === 'unavailable' &&
        deadline.incident.kind === 'role-heartbeat-indeterminate' &&
        deadline.incident.observation.kind === 'reply' &&
        deadline.incident.observation.reply.kind === 'method-not-found'
      ) {
        return {
          kind: 'protocol-incompatible',
          role: deadline.incident.role,
          method: deadline.incident.method,
        };
      }
      return deadline.kind === 'settled'
        ? { kind: 'redeemed', set: deadline.value }
        : { kind: 'temporarily-unavailable', incident: deadline.incident };
    },
  };
}
