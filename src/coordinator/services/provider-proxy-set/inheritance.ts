import {
  currentHandoffCapsulePathBeside,
  handoffCapsuleControllerBuildSetId,
  type HandoffCapsule,
  type RedeemableHandoffCapsule,
} from '../../../provider-proxy/handoff-capsule.js';
import { readAddressedHandoffCapsule } from '../../../provider-proxy/handoff-capsule-discovery.js';
import { PROXY_CONTROL_RPC_TIMEOUT_MS, type CoordinatorIdentity } from '../../../provider-proxy/protocol.js';
import type { ProviderEventHandler } from '../../../provider-proxy/control-client.js';
import type { HeartbeatObservation } from '../../../provider-proxy/heartbeat-observation.js';
import type { Runtime } from '../../../runtime/ports.js';
import { backendLog } from '../../../infra/backend-log.js';
import type { Database } from '../../../store/db.js';
import {
  providerOperationMutationAdmission,
  ProviderOperationMutationSetClosedError,
} from '../../../store/provider-operation-journal.js';
import type { ProviderOperationIdentity, ProviderOperationRecord } from '../../../store/provider-operation-record.js';
import {
  ProviderProxyRoleControlUnavailableError,
  providerProxyRoleControlTeardownIncident,
  type ProviderProxyRoleControlAvailabilityIncident,
} from '../../live/provider-proxy/role-control.js';
import {
  createProviderProxySetAuthority,
  type ProviderProxySetRecoveryAuthority,
} from '../../live/provider-proxy/set-authority.js';
import {
  closeRedeemedProviderProxyControl,
  providerProxyControlRedemptionBundle,
  redeemProviderProxyControl,
  type ProviderProxyControlRedemptionRefusal,
  type RedeemedProviderProxyControl,
  type ProviderProxyGuardianRedemptionAuthority,
} from '../../live/provider-proxy/control-redemption.js';
import {
  createProviderProxyOperationAuthority,
  type DurableProviderProxyOperationAuthority,
  type ProviderProxyOperationAuthority,
} from '../../live/provider-proxy/operation-route.js';
import type { ProviderProxySetAcquisitionIdentity } from '../../live/provider-hosts/proxy-set-acquisition.js';
import type {
  ProviderProxySetPublicationUnknown,
  PublicationReceipt,
} from '../../live/provider-proxy/set-publication.js';
import {
  providerProxySetIdentitiesEqual,
  providerProxySetIdentityFromCapsule,
  providerProxySetIdentityFromRecord,
  providerProxySetKey,
  type ProviderProxySetIdentity,
  type ProviderProxySetProtection,
} from './identity.js';
import type { ProviderProxyOperationSnapshot } from '../operation-registry.js';
import {
  runProviderProxyRecoveryDeadline,
  type ProviderProxyRecoveryArbiter,
  type ProviderProxyRecoveryDispatcher,
  type ProviderProxyRecoveryTurnSinks,
} from '../provider-proxy-recovery-policy.js';
import {
  authorizeProviderProxySetContainmentProof,
  providerProxySetContainmentEvidenceFor,
  releaseProviderProxySetContainmentProofFence,
  verifyProviderProxySetContainmentProofCurrent,
  type ProviderProxySetFencedContainmentProof,
  type ProviderProxySetContainmentProver,
} from './containment-proof.js';
import type {
  ProviderProxySetRecordedContainmentReapResult,
  ProviderProxySetRecordedContainmentReaper,
} from './recorded-containment-reaper.js';

/**
 * Absent, stale, or wrong-identity capsules grant no authority at that address. Redemption and proof failures
 * must remain errors so transport ambiguity cannot be mistaken for authority absence.
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
  collectContainmentProof: ProviderProxySetContainmentProver['collectContainmentProof'];
  reapRecordedContainment: ProviderProxySetRecordedContainmentReaper;
  acceptsControllerTransfer?(capsule: RedeemableHandoffCapsule): ControllerTransferAcceptance;
  registerInheritedSet?(
    set: ProviderProxyOperationAuthority,
    publicationReceipt: PublicationReceipt,
    protection: ProviderProxySetProtection,
  ): void;
}>;

export type ProviderProxySetInheritanceOutcome =
  | Readonly<{
      kind: 'inherited';
      set: DurableProviderProxyOperationAuthority;
      publicationReceipt: PublicationReceipt;
      protection: ProviderProxySetProtection;
    }>
  | Readonly<{ kind: 'containment-disappeared'; disappearanceReceipt: string }>
  | Readonly<{ kind: 'recorded-group-unattributable' }>
  | Readonly<{ kind: 'signal-authorization-refused' }>
  | Readonly<{ kind: 'identity-unobservable'; signalDelivered: boolean }>
  | Readonly<{ kind: 'not-bequeathed'; reason: string }>
  | Readonly<{ kind: 'temporarily-unavailable'; incident: ProviderProxySetAvailabilityIncident }>;

export type ProviderProxySetProxyUnavailable = Readonly<{
  kind: 'proxy-unavailable';
  setIdentity: ProviderProxySetIdentity;
  guardianAuthority: ProviderProxyGuardianRedemptionAuthority;
  incident: ProviderProxyRoleControlAvailabilityIncident;
}>;

export type ProviderProxySetRedemptionOutcome =
  | ProviderProxySetProxyUnavailable
  | Readonly<{
      kind: 'redeemed';
      set: DurableProviderProxyOperationAuthority;
      publicationReceipt: PublicationReceipt;
      protection: ProviderProxySetProtection;
      capsulePath?: string;
    }>
  | Readonly<{
      kind: 'protocol-incompatible';
      role: Extract<ProviderProxyRoleControlAvailabilityIncident, { kind: 'role-heartbeat-indeterminate' }>['role'];
      method: Extract<ProviderProxyRoleControlAvailabilityIncident, { kind: 'role-heartbeat-indeterminate' }>['method'];
    }>
  | Readonly<{ kind: 'temporarily-unavailable'; incident: ProviderProxySetAvailabilityIncident }>;

async function collectFencedContainmentProof(
  identity: ProviderProxySetIdentity,
  db: Database,
  deps: ProviderProxySetInheritanceDeps,
  signal: AbortSignal,
): Promise<ProviderProxySetFencedContainmentProof> {
  const mutationFence = providerOperationMutationAdmission(db).closeSet(identity);
  return deps.collectContainmentProof(
    authorizeProviderProxySetContainmentProof(identity, {
      mutationFence,
      closeAdmission: async () => {
        signal.throwIfAborted();
        if (mutationFence.kind !== 'holding') return;
        let onAbort!: () => void;
        const aborted = new Promise<void>((resolve) => {
          onAbort = resolve;
          signal.addEventListener('abort', onAbort, { once: true });
        });
        try {
          await Promise.race([mutationFence.retryAfter, aborted]);
          signal.throwIfAborted();
        } finally {
          signal.removeEventListener('abort', onAbort);
        }
      },
    }),
    db,
    signal,
  );
}

type ProviderProxySetRedemptionAttempt = Exclude<ProviderProxySetRedemptionOutcome, { kind: 'protocol-incompatible' }>;

export type ProviderProxySetAvailabilityIncident =
  | Readonly<{ kind: 'mutation-set-fenced' }>
  | ProviderProxyRoleControlAvailabilityIncident
  | ProviderProxySetPublicationUnknown
  | Readonly<{ kind: 'transfer-status-unconfirmed' }>
  | Readonly<{ kind: 'publication-not-attempted'; role: 'guardian' | 'proxy'; reason: string }>
  | Readonly<{
      kind: 'recorded-containment-unavailable';
      reason: 'authorization-missing' | 'authorization-stale' | 'store-unreadable' | 'guardian-containment-unconfirmed';
    }>
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
    case 'role-control-teardown-latched':
      return [incident.kind, incident.role, incident.stage, incident.method ?? 'none'].join(':');
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
    case 'mutation-set-fenced':
    case 'transfer-status-unconfirmed':
      return incident.kind;
    case 'publication-unknown':
    case 'publication-not-attempted':
      return `${incident.kind}:${incident.role}:${incident.reason}`;
    case 'recorded-containment-unavailable':
      return `${incident.kind}:${incident.reason}`;
  }
}

const NOTHING_TO_INHERIT_REASON = 'no capsule at this address';

export type ProviderProxySetInheritanceRefusal = 'other-build' | 'unreadable-identity';

/**
 * A set whose grant does not authorize this build must never be dialed. A capsule without a derivable set
 * identity may be represented only.
 */
export type ControllerTransferAcceptance = 'not-accepted' | 'before-serving' | 'served' | 'unconfirmed';

/** Before the successor serves, transfer must keep the incumbent build’s recovery grant valid. */
export type ProviderProxySetInheritanceRoute = 'controller' | 'transfer-before-serving' | 'transfer-served';

export type ProviderProxySetInheritanceVerdict =
  | Readonly<{ kind: 'inheritable'; candidate: RedeemableHandoffCapsule; via: ProviderProxySetInheritanceRoute }>
  | Readonly<{ kind: 'held'; candidate: RedeemableHandoffCapsule; reason: 'transfer-status-unconfirmed' }>
  | Readonly<{ kind: 'refused'; reason: ProviderProxySetInheritanceRefusal }>;

export function classifyProviderProxySetInheritance(
  capsule: HandoffCapsule,
  ownBuildSetId: string,
  acceptsControllerTransfer: (capsule: RedeemableHandoffCapsule) => ControllerTransferAcceptance = () => 'not-accepted',
): ProviderProxySetInheritanceVerdict {
  if (capsule.version === 1 || capsule.version === 2) {
    return { kind: 'refused', reason: 'unreadable-identity' };
  }
  if (handoffCapsuleControllerBuildSetId(capsule) === ownBuildSetId) {
    return { kind: 'inheritable', candidate: capsule, via: 'controller' };
  }
  switch (acceptsControllerTransfer(capsule)) {
    case 'before-serving':
      return { kind: 'inheritable', candidate: capsule, via: 'transfer-before-serving' };
    case 'served':
      return { kind: 'inheritable', candidate: capsule, via: 'transfer-served' };
    case 'unconfirmed':
      return { kind: 'held', candidate: capsule, reason: 'transfer-status-unconfirmed' };
    case 'not-accepted':
      return { kind: 'refused', reason: 'other-build' };
  }
}

/** Every field a capsule read back from disk must agree with the locator that named its address, plus this
 *  successor's own build, because bytes for any other set cannot establish authority over this one. */
function capsuleMatchesLocator(
  capsule: RedeemableHandoffCapsule,
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

function inheritanceRefusalError(
  refusal: Exclude<ProviderProxyControlRedemptionRefusal, { kind: 'publication-refused' }>,
): Error {
  switch (refusal.kind) {
    case 'guardian-role-refused':
    case 'downstream-role-refused':
    case 'downstream-role-unavailable':
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

const INSTALL_RETRY_BASE_MS = 1_000;
const INSTALL_RETRY_MAX_MS = 30_000;

async function completeServedTransfer(
  authority: Pick<ProviderProxySetRecoveryAuthority, 'installRecoveryCredential'>,
  runtime: Pick<Runtime, 'time'>,
): Promise<void> {
  let reportedFailure = false;
  let reportedRefusal = false;
  for (let delayMs = INSTALL_RETRY_BASE_MS; ; delayMs = Math.min(delayMs * 2, INSTALL_RETRY_MAX_MS)) {
    await runtime.time.sleep(delayMs);
    let installed: Awaited<ReturnType<typeof authority.installRecoveryCredential>> | null;
    try {
      installed = await authority.installRecoveryCredential(AbortSignal.timeout(PROXY_CONTROL_RPC_TIMEOUT_MS * 2));
    } catch {
      installed = null;
    }
    if (installed === null && !reportedFailure) {
      backendLog.warn('Provider host recovery grant install failed after a served transfer; retrying.');
      reportedFailure = true;
    }
    if (installed?.kind === 'installed') return;
    if (installed?.kind === 'refused' && !reportedRefusal) {
      backendLog.warn(
        `Provider ${installed.incident.role} refused this controller's recovery grant after a served transfer; retrying.`,
      );
      reportedRefusal = true;
    }
    if (
      installed?.kind === 'retryable' &&
      installed.incident.exchange.kind === 'not-sent' &&
      installed.incident.exchange.cause === 'connection-already-closed'
    ) {
      return;
    }
  }
}

async function buildInheritedAuthority(
  redemption: RedeemedProviderProxyControl,
  capsulePath: string,
  capsule: RedeemableHandoffCapsule,
  expectedIdentity: ProviderProxySetIdentity | null,
  deps: ProviderProxySetInheritanceDeps,
  signal: AbortSignal,
  via: ProviderProxySetInheritanceRoute,
): Promise<
  Readonly<{
    set: DurableProviderProxyOperationAuthority;
    publicationReceipt: PublicationReceipt;
    protection: ProviderProxySetProtection;
    capsulePath: string;
  }>
> {
  const bundle = providerProxyControlRedemptionBundle(redemption);
  let installedCapsulePath = capsulePath;
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
    if (via !== 'transfer-before-serving') {
      const installation = await base.installRecoveryCredential(signal);
      switch (installation.kind) {
        case 'retryable':
          if (via === 'transfer-served') void completeServedTransfer(base, deps.runtime);
          break;
        case 'installed':
          if (handoffCapsuleControllerBuildSetId(capsule) !== deps.coordinatorIdentity.buildSetId) {
            installedCapsulePath = currentHandoffCapsulePathBeside(capsulePath, capsule.version);
          }
          break;
        case 'refused':
          if (via === 'transfer-served') void completeServedTransfer(base, deps.runtime);
          break;
        case 'cancelled':
          signal.throwIfAborted();
          throw new Error('provider_proxy_recovery_credential_install_cancelled');
      }
    }
    const set = createProviderProxyOperationAuthority({
      base,
      setIdentity: bundle.setIdentity,
      clients: bundle.clients,
      faults: bundle.faults,
      mutationRpcTimeoutMs: PROXY_CONTROL_RPC_TIMEOUT_MS,
    });
    deps.registerInheritedSet?.(set, bundle.publicationReceipt, 'protected');
    return {
      set,
      publicationReceipt: bundle.publicationReceipt,
      protection: 'protected',
      capsulePath: installedCapsulePath,
    };
  } catch (error: unknown) {
    closeRedeemedProviderProxyControl(redemption);
    throw error;
  }
}

async function redeemCapsule(
  capsulePath: string,
  capsule: RedeemableHandoffCapsule,
  expectedIdentity: ProviderProxySetIdentity | null,
  deps: ProviderProxySetInheritanceDeps,
  signal: AbortSignal,
  via: ProviderProxySetInheritanceRoute,
): Promise<ProviderProxySetRedemptionAttempt> {
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
  if (redemption.kind === 'unavailable') {
    if ('error' in redemption) throw redemption.error;
    return { kind: 'temporarily-unavailable', incident: redemption.incident };
  }
  if (redemption.kind === 'refused') {
    if (redemption.refusal.kind === 'downstream-role-unavailable') {
      return {
        kind: 'proxy-unavailable',
        setIdentity: providerProxySetIdentityFromCapsule(capsule),
        guardianAuthority: redemption.refusal.guardianAuthority,
        incident: redemption.refusal.error.incident,
      };
    }
    if (redemption.refusal.kind === 'publication-refused') {
      return {
        kind: 'temporarily-unavailable',
        incident: {
          kind: 'publication-not-attempted',
          role: redemption.refusal.role,
          reason: redemption.refusal.reason,
        },
      };
    }
    if (redemption.refusal.kind === 'downstream-role-refused') {
      redemption.refusal.guardianAuthority.stopHeartbeats();
      await redemption.refusal.guardianAuthority.initiateControlClose();
    }
    throw inheritanceRefusalError(redemption.refusal);
  }
  const inherited = await buildInheritedAuthority(
    redemption,
    capsulePath,
    capsule,
    expectedIdentity,
    deps,
    signal,
    via,
  );
  return { kind: 'redeemed', ...inherited };
}

async function redeem(
  reference: ProviderProxySetLocator,
  db: Database,
  deps: ProviderProxySetInheritanceDeps,
  signal: AbortSignal,
): Promise<ProviderProxySetInheritanceOutcome> {
  const { operation, locator } = reference;
  const addressed = readAddressedHandoffCapsule(
    {
      generation: deps.coordinatorIdentity.generation,
      flavor: deps.coordinatorIdentity.flavor,
      buildSetId: operation.buildSetId,
      hostFingerprint: locator.hostFingerprint,
      proxyInstanceId: operation.proxyInstanceId,
    },
    deps.baseDir === undefined ? undefined : { baseDir: deps.baseDir },
    { storage: deps.runtime.storage, uid: process.getuid?.() ?? 0 },
  );
  if (addressed === null) return { kind: 'not-bequeathed', reason: NOTHING_TO_INHERIT_REASON };
  const { path: capsulePath, capsule } = addressed;
  const verdict = classifyProviderProxySetInheritance(
    capsule,
    deps.coordinatorIdentity.buildSetId,
    deps.acceptsControllerTransfer,
  );
  if (verdict.kind === 'held') {
    return { kind: 'temporarily-unavailable', incident: { kind: 'transfer-status-unconfirmed' } };
  }
  if (verdict.kind === 'refused') {
    return {
      kind: 'not-bequeathed',
      reason:
        verdict.reason === 'other-build'
          ? 'the set is controlled by another build'
          : 'the capsule predates the process incarnation token',
    };
  }
  const inheritableCapsule = verdict.candidate;
  if (!capsuleMatchesLocator(inheritableCapsule, reference, deps.coordinatorIdentity)) {
    return { kind: 'not-bequeathed', reason: 'capsule identity disagrees with the committed locator' };
  }
  const redemption = await redeemCapsule(
    capsulePath,
    inheritableCapsule,
    providerProxySetIdentityFromRecord(reference),
    deps,
    signal,
    verdict.via,
  );
  if (redemption.kind === 'proxy-unavailable') {
    const identity = providerProxySetIdentityFromRecord(reference);
    let proof: ProviderProxySetFencedContainmentProof | null = null;
    try {
      proof = await collectFencedContainmentProof(identity, db, deps, signal);
      const evidence = providerProxySetContainmentEvidenceFor(proof, identity);
      if (evidence.kind !== 'proxy-absent') return { kind: 'temporarily-unavailable', incident: redemption.incident };
      const currentness = verifyProviderProxySetContainmentProofCurrent(proof, identity);
      if (currentness.kind !== 'current')
        return {
          kind: 'temporarily-unavailable',
          incident: { kind: 'recorded-containment-unavailable', reason: currentness.kind },
        };
      const commit = await redemption.guardianAuthority.commitContainment(signal);
      if (
        commit.kind === 'containment-absent' &&
        verifyProviderProxySetContainmentProofCurrent(proof, identity).kind === 'current'
      ) {
        return { kind: 'containment-disappeared', disappearanceReceipt: commit.disappearanceReceipt };
      }
      return {
        kind: 'temporarily-unavailable',
        incident: { kind: 'recorded-containment-unavailable', reason: 'guardian-containment-unconfirmed' },
      };
    } finally {
      if (proof !== null) releaseProviderProxySetContainmentProofFence(proof);
      redemption.guardianAuthority.stopHeartbeats();
      await redemption.guardianAuthority.initiateControlClose();
    }
  }
  if (redemption.kind !== 'redeemed') return redemption;
  return {
    kind: 'inherited',
    set: redemption.set,
    publicationReceipt: redemption.publicationReceipt,
    protection: redemption.protection,
  };
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
    outcome = await redeem(locator, db, deps, signal);
  } catch (error: unknown) {
    const incident =
      error instanceof ProviderProxyRoleControlUnavailableError
        ? error.incident
        : providerProxyRoleControlTeardownIncident(error);
    if (incident === null) throw error;
    try {
      const proof = await collectFencedContainmentProof(identity, db, deps, signal);
      const evidence = providerProxySetContainmentEvidenceFor(proof, identity);
      if (evidence.kind === 'reap-required') {
        let reapResult: ProviderProxySetRecordedContainmentReapResult;
        try {
          reapResult = await deps.reapRecordedContainment(identity, proof, signal, () => undefined);
        } finally {
          releaseProviderProxySetContainmentProofFence(proof);
        }
        if (reapResult.kind === 'containment-absent') {
          return { kind: 'containment-disappeared', disappearanceReceipt: reapResult.disappearanceReceipt };
        }
        if (
          reapResult.kind === 'recorded-group-unattributable' ||
          reapResult.kind === 'signal-authorization-refused' ||
          reapResult.kind === 'identity-unobservable'
        ) {
          return reapResult;
        }
        return {
          kind: 'temporarily-unavailable',
          incident: { kind: 'recorded-containment-unavailable', reason: reapResult.kind },
        };
      }
      releaseProviderProxySetContainmentProofFence(proof);
    } catch (proofError: unknown) {
      if (signal.aborted && proofError === signal.reason) throw proofError;
      if (proofError instanceof ProviderOperationMutationSetClosedError) throw proofError;
      throw new AggregateError(
        [error, proofError],
        'Provider proxy role control was unavailable and containment proof failed.',
        { cause: proofError },
      );
    }
    return { kind: 'temporarily-unavailable', incident };
  }
  if (outcome.kind !== 'not-bequeathed') return outcome;
  const proof = await collectFencedContainmentProof(identity, db, deps, signal);
  const evidence = providerProxySetContainmentEvidenceFor(proof, identity);
  if (evidence.kind !== 'reap-required') {
    releaseProviderProxySetContainmentProofFence(proof);
    return outcome;
  }
  let reapResult: ProviderProxySetRecordedContainmentReapResult;
  try {
    reapResult = await deps.reapRecordedContainment(identity, proof, signal, () => undefined);
  } finally {
    releaseProviderProxySetContainmentProofFence(proof);
  }
  if (reapResult.kind === 'containment-absent') {
    return { kind: 'containment-disappeared', disappearanceReceipt: reapResult.disappearanceReceipt };
  }
  if (
    reapResult.kind === 'recorded-group-unattributable' ||
    reapResult.kind === 'signal-authorization-refused' ||
    reapResult.kind === 'identity-unobservable'
  ) {
    return reapResult;
  }
  return {
    kind: 'temporarily-unavailable',
    incident: { kind: 'recorded-containment-unavailable', reason: reapResult.kind },
  };
}

function discoveredCapsuleRoute(
  capsule: RedeemableHandoffCapsule,
  deps: ProviderProxySetInheritanceDeps,
): ProviderProxySetInheritanceRoute | 'unconfirmed' {
  const verdict = classifyProviderProxySetInheritance(
    capsule,
    deps.coordinatorIdentity.buildSetId,
    deps.acceptsControllerTransfer,
  );
  if (verdict.kind === 'held') return 'unconfirmed';
  if (verdict.kind === 'refused') throw new Error('provider_proxy_discovered_capsule_no_longer_inheritable');
  return verdict.via;
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
    capsule: RedeemableHandoffCapsule,
    capsulePath: string,
    signal: AbortSignal,
  ): Promise<ProviderProxySetRedemptionOutcome>;
}

export type CreateProviderProxySetInheritanceOptions = Readonly<{
  runtime: Runtime;
  identity: ProviderProxySetAcquisitionIdentity;
  operationRegistry: ProviderProxyOperationSnapshot;
  containmentProver: ProviderProxySetContainmentProver;
  reapRecordedContainment: ProviderProxySetRecordedContainmentReaper;
  onProviderEvent?(): ProviderEventHandler;
  acceptsControllerTransfer?(capsule: RedeemableHandoffCapsule): ControllerTransferAcceptance;
  /** Where a successfully inherited set is folded in so it participates in this coordinator's own later
   *  shutdown. */
  registerInheritedSet(
    set: ProviderProxyOperationAuthority,
    publicationReceipt: PublicationReceipt,
    protection: ProviderProxySetProtection,
  ): void;
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
    registerInheritedSet?: (
      set: ProviderProxyOperationAuthority,
      publicationReceipt: PublicationReceipt,
      protection: ProviderProxySetProtection,
    ) => void,
  ): ProviderProxySetInheritanceDeps | null => {
    const pid = options.runtime.env.pid();
    const platform = options.runtime.env.platform() as NodeJS.Platform;
    const incarnation = options.runtime.process.readProcessIncarnation(pid, platform);
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
      collectContainmentProof: options.containmentProver.collectContainmentProof,
      reapRecordedContainment: options.reapRecordedContainment,
      ...(options.acceptsControllerTransfer === undefined
        ? {}
        : { acceptsControllerTransfer: options.acceptsControllerTransfer }),
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
        produce: (bounded) => {
          const route = discoveredCapsuleRoute(capsule, inheritanceDeps);
          return route === 'unconfirmed'
            ? Promise.resolve({
                kind: 'temporarily-unavailable' as const,
                incident: { kind: 'transfer-status-unconfirmed' as const },
              })
            : redeemCapsule(capsulePath, capsule, null, inheritanceDeps, bounded, route);
        },
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
        ? deadline.value
        : { kind: 'temporarily-unavailable', incident: deadline.incident };
    },
  };
}
