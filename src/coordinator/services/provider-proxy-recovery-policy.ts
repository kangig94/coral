import { z } from 'zod';
import { ControlClientError } from '../../provider-proxy/control-client.js';
import { isProviderProxyOperationAuthority } from '../live/provider-proxy/operation-route.js';
import type { ProviderProxySetAuthority } from '../live/provider-proxy/authority.js';
import { providerOperationRecordSchema } from '../../store/provider-operation-record.js';
import { ProcessContainmentInvariantError } from '../../infra/process-containment.js';
import type { TimePort } from '../../infra/port-types.js';
import {
  ProviderOperationAtomicTerminalizationError,
  ProviderOperationTerminalMetadataError,
  type ProviderOperationTerminalizationResult,
} from '../../jobs/provider-operation-terminalization.js';
import type { RedeemableHandoffCapsule } from '../../provider-proxy/handoff-capsule.js';
import type { OperationIdentity } from '../../provider-proxy/protocol.js';
import type { Database } from '../../store/db.js';
import {
  ProviderOperationJournalError,
  ProviderOperationMutationSetClosedError,
} from '../../store/provider-operation-journal.js';
import type {
  ProviderOperationRecord,
  ProviderOperationTerminalDirective,
} from '../../store/provider-operation-record.js';
import {
  ProviderProxyRoleControlRemoteError,
  ProviderProxyRoleControlUnavailableError,
  providerProxyRoleControlTeardownIncident,
} from '../live/provider-proxy/role-control.js';
import type { ProviderProxyControlRedemptionOutcome } from '../live/provider-proxy/control-redemption.js';
import {
  disappearanceDeliveryAttemptOutcomeSchema,
  type ContainmentDisappearanceNotice,
  type DisappearanceDeliveryAttemptOutcome,
} from './provider-containment-disappearance.js';
import {
  representationAbandonmentDeliveryAttemptOutcomeSchema,
  type ProviderRepresentationAbandonmentNotice,
  type RepresentationAbandonmentDeliveryAttemptOutcome,
} from './provider-representation-abandonment.js';
import {
  providerHandoffCapsuleRetirementOutcomeSchema,
  type ProviderHandoffCapsuleRetirementOutcome,
} from './provider-proxy-capsule-discovery.js';
import {
  ProviderProxySetInheritanceCorruptionError,
  providerProxySetIdentitySchema,
  providerProxySetCapsuleMatchesIdentity,
  providerProxySetIdentitiesEqual,
  type ProviderProxySetIdentity,
} from './provider-proxy-set/identity.js';
import type {
  ProviderProxySetAvailabilityIncident,
  ProviderProxySetInheritanceOutcome,
  ProviderProxySetLocator,
  ProviderProxySetRedemptionOutcome,
} from './provider-proxy-set/inheritance.js';
import {
  inspectProviderProxySetContainmentProof,
  ProviderProxySetContainmentProofInvariantError,
  type ProviderProxySetFencedContainmentProof,
} from './provider-proxy-set/containment-proof.js';

export const PROVIDER_PROXY_RECOVERY_PRODUCERS = [
  'disappearance-terminalization',
  'role-control',
  'set-inheritance',
  'capsule-redemption',
  'containment-proof',
  'capsule-retirement',
  'disappearance-consumer',
  'representation-abandonment-consumer',
] as const;

export type ProviderProxyRecoveryProducerId = (typeof PROVIDER_PROXY_RECOVERY_PRODUCERS)[number];

export const PROVIDER_PROXY_RECOVERY_CONSUMER_SEAMS = [
  'disappearance-delivery',
  'representation-abandonment-delivery',
  'startup-set-inheritance',
  'ordinary-set-inheritance',
  'containment-attempt',
  'control-reattachment',
  'control-reattachment-hold',
  'exact-capsule-recovery',
  'capsule-retirement',
  'foreign-capsule-retirement',
] as const;

export type ProviderProxyRecoveryConsumerSeam = (typeof PROVIDER_PROXY_RECOVERY_CONSUMER_SEAMS)[number];

type DisappearanceTerminalizationInput = Readonly<{
  record: ProviderOperationRecord;
  directive: ProviderOperationTerminalDirective;
}>;

type RoleControlInput = Readonly<{
  signal: AbortSignal;
  run(signal: AbortSignal): Promise<unknown>;
}>;

type SetInheritanceInput = Readonly<{
  locator: ProviderProxySetLocator;
  db: Database;
  signal: AbortSignal;
}>;

type CapsuleRedemptionInput = Readonly<{
  capsule: RedeemableHandoffCapsule;
  capsulePath: string;
  signal: AbortSignal;
}>;

type ContainmentProofInput = Readonly<{
  identity: ProviderProxySetIdentity;
  signal: AbortSignal;
}>;

type CapsuleRetirementInput = Readonly<{ path: string }>;
type DisappearanceConsumerInput = Readonly<{
  notice: ContainmentDisappearanceNotice;
  mutationProof?: ProviderProxySetFencedContainmentProof;
}>;
type RepresentationAbandonmentConsumerInput = Readonly<{
  notice: ProviderRepresentationAbandonmentNotice;
  mutationProof?: ProviderProxySetFencedContainmentProof;
}>;

export type ProviderProxyRecoveryProducerInput = {
  'disappearance-terminalization': DisappearanceTerminalizationInput;
  'role-control': RoleControlInput;
  'set-inheritance': SetInheritanceInput;
  'capsule-redemption': CapsuleRedemptionInput;
  'containment-proof': ContainmentProofInput;
  'capsule-retirement': CapsuleRetirementInput;
  'disappearance-consumer': DisappearanceConsumerInput;
  'representation-abandonment-consumer': RepresentationAbandonmentConsumerInput;
};

export interface ProviderProxyRecoveryProducerPorts {
  'disappearance-terminalization'(
    input: DisappearanceTerminalizationInput,
  ): Promise<ProviderOperationTerminalizationResult> | ProviderOperationTerminalizationResult;
  'role-control'(input: RoleControlInput): Promise<unknown>;
  'set-inheritance'(input: SetInheritanceInput): Promise<ProviderProxySetInheritanceOutcome>;
  'capsule-redemption'(input: CapsuleRedemptionInput): Promise<ProviderProxySetRedemptionOutcome>;
  'containment-proof'(input: ContainmentProofInput): Promise<ProviderProxySetFencedContainmentProof>;
  'capsule-retirement'(
    input: CapsuleRetirementInput,
  ): Promise<ProviderHandoffCapsuleRetirementOutcome> | ProviderHandoffCapsuleRetirementOutcome;
  'disappearance-consumer'(input: DisappearanceConsumerInput): Promise<DisappearanceDeliveryAttemptOutcome>;
  'representation-abandonment-consumer'(
    input: RepresentationAbandonmentConsumerInput,
  ): Promise<RepresentationAbandonmentDeliveryAttemptOutcome>;
}

export type ProviderProxyRecoveryRetry = Readonly<{
  producerId: ProviderProxyRecoveryProducerId;
  incident: unknown;
}>;

/**
 * Why a foreign capsule retirement could not be completed, as the owner of that capsule path receives it. It
 * retains no part of the rejection itself — nothing downstream of this seam may act on the thrown value.
 *
 * The two answers must stay tellable apart: a producer that broke its own contract is a defect in this build,
 * and reporting that as a refusal an operating system gave sends an operator to the wrong system.
 */
export type ProviderProxyForeignCapsuleRetirementIncident =
  | Readonly<{ kind: 'foreign-capsule-retirement-rejected'; errorCode: string | null }>
  | Readonly<{ kind: 'foreign-capsule-retirement-contract-violation' }>;

/**
 * Every incident the foreign seam's retry may carry, named beside the routing that decides which one it is:
 * an incident that routing can emit and this union does not admit is one no owner has a reported form for.
 */
export type ProviderProxyForeignCapsuleRetirementRetryIncident =
  | ProviderProxyForeignCapsuleRetirementIncident
  | Extract<ProviderHandoffCapsuleRetirementOutcome, { kind: 'temporarily-unavailable' }>['incident'];

const providerProxyRecoveryFatalOrigin: unique symbol = Symbol('provider-proxy-recovery-fatal-origin');

export type ProviderProxySetLifecycleFatalError = Error &
  Readonly<{
    [providerProxyRecoveryFatalOrigin]: true;
    stage:
      | 'set-inheritance'
      | 'disappearance-delivery'
      | 'representation-abandonment-delivery'
      | 'capsule-retirement'
      | 'capsule-recovery';
    seam: ProviderProxyRecoveryConsumerSeam;
    producerId: ProviderProxyRecoveryProducerId;
    operation?: OperationIdentity;
    setIdentity?: ProviderProxySetIdentity;
  }>;

class DispatcherIssuedProviderProxySetLifecycleFatalError extends Error {
  readonly [providerProxyRecoveryFatalOrigin] = true as const;
  readonly stage: ProviderProxySetLifecycleFatalError['stage'];
  readonly seam: ProviderProxyRecoveryConsumerSeam;
  readonly producerId: ProviderProxyRecoveryProducerId;
  readonly operation?: OperationIdentity;
  readonly setIdentity?: ProviderProxySetIdentity;

  constructor(
    stage: ProviderProxySetLifecycleFatalError['stage'],
    message: string,
    options: ErrorOptions & {
      seam: ProviderProxyRecoveryConsumerSeam;
      producerId: ProviderProxyRecoveryProducerId;
      operation?: OperationIdentity;
      setIdentity?: ProviderProxySetIdentity;
    },
  ) {
    super(message, options);
    this.name = 'ProviderProxySetLifecycleFatalError';
    this.stage = stage;
    this.seam = options.seam;
    this.producerId = options.producerId;
    if (options.operation !== undefined) this.operation = options.operation;
    if (options.setIdentity !== undefined) this.setIdentity = options.setIdentity;
    Object.setPrototypeOf(this, DispatcherIssuedProviderProxySetLifecycleFatalError.prototype);
  }
}

export function isProviderProxyRecoveryFatalError(value: unknown): value is ProviderProxySetLifecycleFatalError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { [providerProxyRecoveryFatalOrigin]?: unknown })[providerProxyRecoveryFatalOrigin] === true
  );
}

export interface ProviderProxyRecoveryTurnSinks {
  evidence(value: unknown, sourceId: string): void;
  retry(retry: ProviderProxyRecoveryRetry): void;
  fatal(error: ProviderProxySetLifecycleFatalError): void;
  cancel?(reason: unknown): void;
  disposeLateEvidence?(value: unknown, sourceId: string): void;
}

export interface ProviderProxyRecoveryEffects {
  retry(sinks: ProviderProxyRecoveryTurnSinks, retry: ProviderProxyRecoveryRetry): void;
  fatal(sinks: ProviderProxyRecoveryTurnSinks, error: ProviderProxySetLifecycleFatalError): void;
}

export interface ProviderProxyRecoveryFatalSink {
  fatal(error: ProviderProxySetLifecycleFatalError): void;
}

export type ProviderProxyRecoveryExactContext = Readonly<{
  operation?: OperationIdentity;
  setIdentity?: ProviderProxySetIdentity;
  capsule?: RedeemableHandoffCapsule;
  retiredSources?: Set<string>;
}>;

export type ProviderProxyRecoverySource<ProducerId extends ProviderProxyRecoveryProducerId> = Readonly<{
  sourceId: string;
  producerId: ProducerId;
  input: ProviderProxyRecoveryProducerInput[ProducerId];
  abort?: (reason: unknown) => void;
}>;

export type ProviderProxyRecoveryAnySource = {
  [ProducerId in ProviderProxyRecoveryProducerId]: ProviderProxyRecoverySource<ProducerId>;
}[ProviderProxyRecoveryProducerId];

export interface ProviderProxyRecoveryArbiter {
  start(this: ProviderProxyRecoveryArbiter, source: ProviderProxyRecoveryAnySource): void;
  cancel(reason: unknown): void;
}

export type ProviderProxyRecoveryInvariantError =
  | ProcessContainmentInvariantError
  | ProviderProxySetContainmentProofInvariantError
  | ProviderProxySetInheritanceCorruptionError
  | ProviderOperationJournalError;

export interface ProviderProxyRecoveryDispatcher {
  reportInvariant(
    seam: ProviderProxyRecoveryConsumerSeam,
    context: ProviderProxyRecoveryExactContext,
    producerId: ProviderProxyRecoveryProducerId,
    error: ProviderProxyRecoveryInvariantError,
  ): void;
  begin(
    this: ProviderProxyRecoveryDispatcher,
    seam: ProviderProxyRecoveryConsumerSeam,
    context: ProviderProxyRecoveryExactContext,
    sinks: ProviderProxyRecoveryTurnSinks,
  ): ProviderProxyRecoveryArbiter;
}

type Observation<T = unknown> =
  | Readonly<{ kind: 'evidence'; value: T }>
  | Readonly<{ kind: 'unavailable'; producerId: ProviderProxyRecoveryProducerId; incident: unknown }>
  | Readonly<{ kind: 'corrupt'; producerId: ProviderProxyRecoveryProducerId; error: unknown }>
  | Readonly<{ kind: 'refused'; producerId: ProviderProxyRecoveryProducerId; error: unknown }>
  | Readonly<{ kind: 'unknown'; producerId: ProviderProxyRecoveryProducerId; error: unknown }>
  | Readonly<{
      kind: 'retry-safe-unknown';
      producerId: 'disappearance-terminalization';
      error: unknown;
      proof: 'atomic-provider-operation-terminalization';
    }>
  | Readonly<{ kind: 'cancel'; reason: unknown }>
  | Readonly<{ kind: 'forwarded-fatal'; error: ProviderProxySetLifecycleFatalError }>;

const evidence = <T>(value: T): Observation<T> => ({ kind: 'evidence', value });
const unavailable = (producerId: ProviderProxyRecoveryProducerId, incident: unknown): Observation => ({
  kind: 'unavailable',
  producerId,
  incident,
});
const corrupt = (producerId: ProviderProxyRecoveryProducerId, error: unknown): Observation => ({
  kind: 'corrupt',
  producerId,
  error,
});
const refused = (producerId: ProviderProxyRecoveryProducerId, error: unknown): Observation => ({
  kind: 'refused',
  producerId,
  error,
});
const unknown = (producerId: ProviderProxyRecoveryProducerId, error: unknown): Observation => ({
  kind: 'unknown',
  producerId,
  error,
});

function retrySafeTerminalizationUnknown(error: ProviderOperationAtomicTerminalizationError): Observation {
  return {
    kind: 'retry-safe-unknown',
    producerId: 'disappearance-terminalization',
    error,
    proof: error.proof,
  };
}

function callerCancellation(input: { signal?: AbortSignal }, error: unknown): Observation | null {
  return input.signal?.aborted === true && input.signal.reason === error ? { kind: 'cancel', reason: error } : null;
}

function sameOperationIdentity(left: OperationIdentity, right: OperationIdentity): boolean {
  return (
    left.jobId === right.jobId &&
    left.operationId === right.operationId &&
    left.proxyInstanceId === right.proxyInstanceId &&
    left.buildSetId === right.buildSetId
  );
}

function containmentProofRequiresReap(value: unknown): value is ProviderProxySetFencedContainmentProof {
  const proof = inspectProviderProxySetContainmentProof(value);
  return proof?.authorization === 'fenced' && proof.evidence.kind === 'reap-required';
}

const roleSchema = z.enum(['guardian', 'reaper', 'proxy']);
const heartbeatMethodSchema = z.enum(['guardian.heartbeat.v1', 'reaper.heartbeat.v1', 'control.heartbeat.v1']);
const openMethodSchema = z.enum([
  'control.open.v1',
  'guardian.open.v1',
  'reaper.open.v1',
  'guardian.handoff-redeem.v1',
  'reaper.handoff-rotate.v1',
  'handoff.redeem.v1',
]);
const methodSchema = z.union([openMethodSchema, heartbeatMethodSchema]).nullable();
const callableSchema = z.custom<(...args: never[]) => unknown>((value) => typeof value === 'function');
const remoteFailureSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('json-rpc-error'),
    jsonRpcCode: z.number(),
    protocolCode: z.string().nullable(),
    admissionReason: z.enum(['control-active', 'invalid-state', 'teardown-latched']).nullable(),
    heartbeatRefusal: z
      .union([
        z.object({ reason: z.literal('challenge-mismatch'), nextHeartbeatChallenge: z.string() }),
        z.object({ reason: z.literal('teardown-latched'), nextHeartbeatChallenge: z.null() }),
      ])
      .nullable(),
  }),
  z.object({ kind: z.literal('invalid-frame') }),
]);
const controlExchangeSchema = z.union([
  z.object({
    kind: z.literal('response'),
    response: z.union([
      z.object({ kind: z.literal('result'), value: z.unknown() }).refine((value) => Object.hasOwn(value, 'value')),
      z.object({ kind: z.literal('refusal'), failure: remoteFailureSchema, error: z.instanceof(ControlClientError) }),
    ]),
  }),
  z.object({
    kind: z.literal('no-response'),
    cause: z.enum(['timeout', 'connection-closed-after-write']),
    error: z.instanceof(ControlClientError),
  }),
  z.object({
    kind: z.literal('delivery-unconfirmed'),
    cause: z.literal('socket-error-after-write'),
    error: z.instanceof(Error),
  }),
  z
    .object({
      kind: z.literal('not-sent'),
      cause: z.enum(['connection-already-closed', 'encode-failed', 'write-threw']),
      error: z.unknown(),
    })
    .refine((value) => Object.hasOwn(value, 'error')),
  z.object({
    kind: z.literal('channel-fault'),
    cause: z.literal('invalid-unattributable-frame'),
    error: z.instanceof(ControlClientError),
  }),
]);
const heartbeatObservationSchema = z.union([
  z.object({
    kind: z.literal('reply'),
    reply: z.union([
      z.object({ kind: z.literal('accepted'), nextChallenge: z.string() }),
      z.object({ kind: z.literal('challenge-mismatch'), nextChallenge: z.string() }),
      z.object({ kind: z.literal('teardown-latched'), error: z.instanceof(ControlClientError) }),
      z.object({ kind: z.literal('method-not-found'), error: z.instanceof(ControlClientError) }),
      z
        .object({ kind: z.literal('unusable'), error: z.unknown(), exchange: controlExchangeSchema.optional() })
        .refine((value) => Object.hasOwn(value, 'error')),
    ]),
  }),
  z.object({ kind: z.literal('no-response-before-deadline'), error: z.instanceof(ControlClientError) }),
  z
    .object({
      kind: z.literal('locally-unsent'),
      stage: z.enum(['request-encode', 'write', 'channel-not-open']),
      error: z.unknown(),
    })
    .refine((value) => Object.hasOwn(value, 'error')),
  z.object({ kind: z.literal('delivery-unconfirmed'), error: z.instanceof(Error) }),
  z.object({ kind: z.literal('channel-fault'), error: z.instanceof(ControlClientError) }),
]);
const roleAvailabilityIncidentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('role-exchange-unavailable'),
    role: roleSchema,
    method: z.string(),
    exchange: controlExchangeSchema,
  }),
  z.object({
    kind: z.literal('role-result-unusable'),
    role: roleSchema,
    method: z.string(),
    exchange: controlExchangeSchema,
  }),
  z.object({
    kind: z.literal('role-control-channel-fault'),
    role: roleSchema,
    stage: z.enum(['connect', 'open', 'heartbeat']),
    method: methodSchema,
    fault: z.instanceof(ControlClientError),
  }),
  z.object({
    kind: z.literal('role-open-indeterminate'),
    role: roleSchema,
    method: openMethodSchema,
    exchange: controlExchangeSchema.refine((value) => value.kind !== 'response'),
  }),
  z.object({
    kind: z.literal('paired-reaper-unavailable'),
    role: z.literal('guardian'),
    method: z.literal('guardian.handoff-redeem.v1'),
  }),
  z.object({
    kind: z.literal('role-control-teardown-latched'),
    role: roleSchema,
    stage: z.enum(['open', 'heartbeat']),
    method: methodSchema,
  }),
  z.object({
    kind: z.literal('role-control-unavailable'),
    role: roleSchema,
    stage: z.enum(['connect', 'open', 'heartbeat']),
    method: methodSchema,
    origin: z.enum(['timeout', 'write', 'closed']),
    controlCode: z.enum(['control_client_connect_failed', 'control_client_closed', 'control_call_failed']),
  }),
  z.object({
    kind: z.literal('role-control-busy'),
    role: roleSchema,
    method: z.enum(['guardian.handoff-redeem.v1', 'reaper.handoff-rotate.v1', 'handoff.redeem.v1']),
    protocolCode: z.literal('invalid_state'),
    admissionReason: z.literal('control-active'),
  }),
  z.object({
    kind: z.literal('role-heartbeat-indeterminate'),
    role: roleSchema,
    method: heartbeatMethodSchema,
    observation: heartbeatObservationSchema,
  }),
]);
const availabilityIncidentSchema = z.union([
  roleAvailabilityIncidentSchema,
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('observation-refused'), producerId: z.enum(['set-inheritance', 'containment-proof']) }),
    z.object({
      kind: z.literal('observation-unknown'),
      producerId: z.enum(['set-inheritance', 'containment-proof', 'capsule-redemption']),
      diagnostic: z.object({ name: z.string(), code: z.string().nullable(), message: z.string() }),
    }),
    z.object({
      kind: z.literal('lifecycle-owned-pending'),
      owner: z.literal('provider-proxy-set-lifecycle'),
      status: z.string(),
      nextObservation: z.string(),
    }),
    z.object({
      kind: z.literal('inheritance-admission-expired'),
      retryOwner: z.literal('provider-proxy-set-inheritance'),
    }),
    z.object({ kind: z.literal('mutation-set-fenced') }),
    z.object({ kind: z.literal('transfer-status-unconfirmed') }),
    z.object({
      kind: z.literal('publication-unknown'),
      role: z.enum(['guardian', 'proxy']),
      reason: z.string(),
      exchange: controlExchangeSchema.optional(),
    }),
    z.object({ kind: z.literal('publication-not-attempted'), role: z.enum(['guardian', 'proxy']), reason: z.string() }),
    z.object({
      kind: z.literal('recorded-containment-unavailable'),
      reason: z.enum([
        'authorization-missing',
        'authorization-stale',
        'store-unreadable',
        'guardian-containment-unconfirmed',
        'observation-failed',
      ]),
    }),
    z.object({ kind: z.literal('recovery-deadline'), timeoutMs: z.literal(45_000) }),
  ]),
]);
const containmentAuthoritySchema = z.object({
  commitContainment: callableSchema,
  stopHeartbeats: callableSchema,
  initiateControlClose: callableSchema,
});
const recoveryAuthoritySchema = containmentAuthoritySchema
  .extend({
    proxyInstanceId: z.string(),
    setIdentity: providerProxySetIdentitySchema,
    stopAndReap: callableSchema,
    installRecoveryCredential: callableSchema,
    authorizeControllerTransfer: callableSchema,
    registerSuccessionOperation: callableSchema,
    providerHosts: z.object({
      list: callableSchema,
      inspect: callableSchema,
      terminalEviction: callableSchema,
      evict: callableSchema,
    }),
  })
  .passthrough()
  .refine(
    (value) =>
      value.proxyInstanceId === value.setIdentity.proxyInstanceId &&
      isProviderProxyOperationAuthority(value as unknown as ProviderProxySetAuthority),
  );
const guardianAuthoritySchema = containmentAuthoritySchema.extend({
  faulted: z.instanceof(Promise),
  onFault: callableSchema,
  onIncident: callableSchema,
});
const recoveredSetFields = {
  set: recoveryAuthoritySchema,
  publicationReceipt: z.object({ kind: z.literal('provider-proxy-set-published') }),
  protection: z.literal('protected'),
};
const inheritanceOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inherited'), ...recoveredSetFields }),
  z.object({ kind: z.literal('containment-disappeared'), disappearanceReceipt: z.string().min(1) }),
  z.object({ kind: z.literal('recorded-group-unattributable') }),
  z.object({ kind: z.literal('signal-authorization-refused') }),
  z.object({ kind: z.literal('identity-unobservable'), signalDelivered: z.boolean() }),
  z.object({ kind: z.literal('not-bequeathed'), reason: z.string() }),
  z.object({ kind: z.literal('temporarily-unavailable'), incident: availabilityIncidentSchema }),
]);
const redemptionOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('redeemed'), ...recoveredSetFields, capsulePath: z.string().min(1).optional() }),
  z.object({
    kind: z.literal('proxy-unavailable'),
    setIdentity: providerProxySetIdentitySchema,
    guardianAuthority: guardianAuthoritySchema,
    incident: roleAvailabilityIncidentSchema,
  }),
  z.object({ kind: z.literal('protocol-incompatible'), role: roleSchema, method: heartbeatMethodSchema }),
  z.object({ kind: z.literal('temporarily-unavailable'), incident: availabilityIncidentSchema }),
]);
const terminalizationOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('terminalized') }),
  z.object({ kind: z.literal('conflict'), current: providerOperationRecordSchema.nullable() }),
]);

function classifyFulfillmentUnchecked(
  producerId: ProviderProxyRecoveryProducerId,
  value: unknown,
  context: ProviderProxyRecoveryExactContext,
): Observation {
  if (producerId === 'disappearance-terminalization') {
    return terminalizationOutcomeSchema.safeParse(value).success
      ? evidence(value)
      : corrupt(producerId, new Error('provider_proxy_terminalization_contract_violation'));
  }
  if (producerId === 'set-inheritance') {
    if (!inheritanceOutcomeSchema.safeParse(value).success) {
      return corrupt(producerId, new Error('provider_proxy_set_inheritance_contract_violation'));
    }
    const outcome = value as ProviderProxySetInheritanceOutcome;
    if (
      outcome.kind === 'inherited' &&
      context.setIdentity !== undefined &&
      !providerProxySetIdentitiesEqual(context.setIdentity, outcome.set.setIdentity)
    ) {
      return corrupt(producerId, new Error('provider_proxy_set_inheritance_identity_mismatch'));
    }
    return outcome.kind === 'temporarily-unavailable' ? unavailable(producerId, outcome.incident) : evidence(outcome);
  }
  if (producerId === 'capsule-redemption') {
    if (!redemptionOutcomeSchema.safeParse(value).success) {
      return corrupt(producerId, new Error('provider_proxy_capsule_redemption_contract_violation'));
    }
    const outcome = value as ProviderProxySetRedemptionOutcome;
    if (outcome.kind === 'temporarily-unavailable') return unavailable(producerId, outcome.incident);
    if (outcome.kind === 'protocol-incompatible') return evidence(outcome);
    const identity = outcome.kind === 'proxy-unavailable' ? outcome.setIdentity : outcome.set.setIdentity;
    if (context.capsule !== undefined && !providerProxySetCapsuleMatchesIdentity(context.capsule, identity)) {
      return corrupt(producerId, new Error('provider_proxy_capsule_redemption_identity_mismatch'));
    }
    if (context.setIdentity !== undefined && !providerProxySetIdentitiesEqual(context.setIdentity, identity)) {
      return corrupt(producerId, new Error('provider_proxy_capsule_redemption_identity_mismatch'));
    }
    return evidence(outcome);
  }
  if (producerId === 'containment-proof') {
    const proof = inspectProviderProxySetContainmentProof(value);
    if (proof === null) {
      return corrupt(producerId, new Error('provider_proxy_containment_proof_contract_violation'));
    }
    if (proof.authorization !== 'fenced') {
      return corrupt(producerId, new Error('provider_proxy_containment_proof_authorization_missing'));
    }
    if (context.setIdentity === undefined || !providerProxySetIdentitiesEqual(context.setIdentity, proof.identity)) {
      return corrupt(producerId, new Error('provider_proxy_containment_proof_identity_mismatch'));
    }
    return evidence(value);
  }
  if (producerId === 'capsule-retirement') {
    const parsed = providerHandoffCapsuleRetirementOutcomeSchema.safeParse(value);
    if (!parsed.success) {
      return corrupt(producerId, new Error('provider_proxy_capsule_retirement_contract_violation'));
    }
    return parsed.data.kind === 'temporarily-unavailable'
      ? unavailable(producerId, parsed.data.incident)
      : evidence(parsed.data);
  }
  if (producerId === 'disappearance-consumer') {
    const parsed = disappearanceDeliveryAttemptOutcomeSchema.safeParse(value);
    if (!parsed.success) {
      return corrupt(producerId, new Error('provider_proxy_disappearance_consumer_contract_violation'));
    }
    const outcome = parsed.data;
    if (outcome.kind === 'operational-failure') return unavailable(producerId, outcome);
    if (context.operation === undefined || !sameOperationIdentity(outcome.acceptance.operation, context.operation)) {
      return corrupt(producerId, new Error('provider_proxy_disappearance_consumer_identity_mismatch'));
    }
    return evidence(outcome.acceptance);
  }
  if (producerId === 'representation-abandonment-consumer') {
    const parsed = representationAbandonmentDeliveryAttemptOutcomeSchema.safeParse(value);
    if (!parsed.success) {
      return corrupt(producerId, new Error('provider_proxy_representation_abandonment_consumer_contract_violation'));
    }
    const outcome = parsed.data;
    if (outcome.kind === 'operational-failure') return unavailable(producerId, outcome);
    if (context.operation === undefined || !sameOperationIdentity(outcome.acceptance.operation, context.operation)) {
      return corrupt(producerId, new Error('provider_proxy_representation_abandonment_consumer_identity_mismatch'));
    }
    return evidence(outcome.acceptance);
  }
  return evidence(value);
}

function classifyFulfillment(
  producerId: ProviderProxyRecoveryProducerId,
  value: unknown,
  context: ProviderProxyRecoveryExactContext,
): Observation {
  try {
    return classifyFulfillmentUnchecked(producerId, value, context);
  } catch (error: unknown) {
    return corrupt(producerId, error);
  }
}

/**
 * Reading `code` off a rejection must never fail: the value is an arbitrary thrown thing, a getter may throw,
 * and this answer is operator metadata rather than a decision input. A rejection this cannot describe must
 * still be describable.
 */
function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  try {
    const code = Reflect.get(error, 'code');
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

function observationDiagnostic(error: unknown): Readonly<{ name: string; code: string | null; message: string }> {
  const code = errorCode(error)?.slice(0, 128) ?? null;
  try {
    return {
      name: (error instanceof Error ? error.name : 'Unknown').slice(0, 128),
      code,
      message: (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, ' ').slice(0, 512),
    };
  } catch {
    return { name: 'Unknown', code, message: 'The thrown value could not be inspected.' };
  }
}

function foreignCapsuleRetirementRejection(error: unknown): ProviderProxyForeignCapsuleRetirementIncident {
  return { kind: 'foreign-capsule-retirement-rejected', errorCode: errorCode(error) };
}

const foreignCapsuleRetirementContractViolation: ProviderProxyForeignCapsuleRetirementIncident = {
  kind: 'foreign-capsule-retirement-contract-violation',
};

function classifyRejection(
  producerId: ProviderProxyRecoveryProducerId,
  input: ProviderProxyRecoveryProducerInput[ProviderProxyRecoveryProducerId],
  error: unknown,
  seam: ProviderProxyRecoveryConsumerSeam,
): Observation {
  if (isProviderProxyRecoveryFatalError(error)) return { kind: 'forwarded-fatal', error };
  const cancelled = callerCancellation(input as { signal?: AbortSignal }, error);
  if (cancelled !== null) return cancelled;
  if (error instanceof ProviderOperationMutationSetClosedError) {
    if (producerId === 'disappearance-consumer' || producerId === 'representation-abandonment-consumer') {
      return unavailable(producerId, {
        kind: 'operational-failure',
        code:
          producerId === 'disappearance-consumer'
            ? 'disappearance_consumer_unavailable'
            : 'representation_abandonment_consumer_unavailable',
        reason: error.message,
      });
    }
    return unavailable(producerId, { kind: 'mutation-set-fenced' });
  }
  // Retiring a capsule this build may not dial is one boot's housekeeping, not a claim on any authority. No
  // way it can fail is evidence about this coordinator, so no way it can fail may end this coordinator.
  if (seam === 'foreign-capsule-retirement') {
    return unavailable(producerId, foreignCapsuleRetirementRejection(error));
  }
  if (producerId === 'disappearance-terminalization') {
    if (error instanceof ProviderOperationAtomicTerminalizationError) {
      return retrySafeTerminalizationUnknown(error);
    }
    if (error instanceof ProviderOperationTerminalMetadataError || error instanceof ProviderOperationJournalError) {
      return corrupt(producerId, error);
    }
    return unknown(producerId, error);
  }
  if (producerId === 'disappearance-consumer' || producerId === 'representation-abandonment-consumer') {
    return unknown(producerId, error);
  }
  if (error instanceof ProviderProxyRoleControlUnavailableError) return unavailable(producerId, error.incident);
  if (error instanceof ProviderProxyRoleControlRemoteError) {
    const teardown = providerProxyRoleControlTeardownIncident(error);
    if (teardown !== null) return unavailable(producerId, teardown);
    if (
      (producerId === 'set-inheritance' || producerId === 'containment-proof') &&
      error.remoteFailure.kind === 'json-rpc-error' &&
      (error.remoteFailure.protocolCode === 'grant_replayed' || error.remoteFailure.protocolCode === 'grant_invalid')
    ) {
      return unavailable(producerId, { kind: 'observation-refused', producerId });
    }
    return refused(producerId, error);
  }
  if (
    error instanceof ProcessContainmentInvariantError ||
    error instanceof ProviderProxySetContainmentProofInvariantError ||
    error instanceof ProviderOperationJournalError ||
    error instanceof ProviderProxySetInheritanceCorruptionError
  ) {
    return corrupt(producerId, error);
  }
  if (producerId === 'set-inheritance' || producerId === 'containment-proof' || producerId === 'capsule-redemption') {
    return unavailable(producerId, {
      kind: 'observation-unknown',
      producerId,
      diagnostic: observationDiagnostic(error),
    });
  }
  return unknown(producerId, error);
}

function fatalStage(seam: ProviderProxyRecoveryConsumerSeam): ProviderProxySetLifecycleFatalError['stage'] {
  if (seam === 'startup-set-inheritance' || seam === 'ordinary-set-inheritance') return 'set-inheritance';
  if (seam === 'disappearance-delivery') return 'disappearance-delivery';
  if (seam === 'representation-abandonment-delivery') return 'representation-abandonment-delivery';
  if (seam === 'capsule-retirement') return 'capsule-retirement';
  return 'capsule-recovery';
}

function fatalError(
  seam: ProviderProxyRecoveryConsumerSeam,
  context: ProviderProxyRecoveryExactContext,
  observation: Extract<Observation, { kind: 'corrupt' | 'refused' | 'unknown' }>,
): ProviderProxySetLifecycleFatalError {
  return new DispatcherIssuedProviderProxySetLifecycleFatalError(
    fatalStage(seam),
    `Provider proxy recovery '${seam}' received ${observation.kind} evidence from '${observation.producerId}'.`,
    {
      cause: observation.error,
      seam,
      producerId: observation.producerId,
      ...(context.operation === undefined ? {} : { operation: context.operation }),
      ...(context.setIdentity === undefined ? {} : { setIdentity: context.setIdentity }),
    },
  );
}

function invokeProducer(
  producers: ProviderProxyRecoveryProducerPorts,
  source: ProviderProxyRecoveryAnySource,
): unknown {
  switch (source.producerId) {
    case 'disappearance-terminalization':
      return producers['disappearance-terminalization'](source.input);
    case 'role-control':
      return producers['role-control'](source.input);
    case 'set-inheritance':
      return producers['set-inheritance'](source.input);
    case 'capsule-redemption':
      return producers['capsule-redemption'](source.input);
    case 'containment-proof':
      return producers['containment-proof'](source.input);
    case 'capsule-retirement':
      return producers['capsule-retirement'](source.input);
    case 'disappearance-consumer':
      return producers['disappearance-consumer'](source.input);
    case 'representation-abandonment-consumer':
      return producers['representation-abandonment-consumer'](source.input);
  }
}

export function createProviderProxyRecoveryDispatcher(
  options: Readonly<{
    producers: ProviderProxyRecoveryProducerPorts;
    fatalSink: ProviderProxyRecoveryFatalSink;
  }>,
): ProviderProxyRecoveryDispatcher {
  const publishFatal = (error: ProviderProxySetLifecycleFatalError): void => {
    try {
      options.fatalSink.fatal(error);
    } catch {
      // A failed terminal sink must not create a secondary unhandled rejection.
    }
  };
  const effects: ProviderProxyRecoveryEffects = {
    retry: (sinks, retry) => sinks.retry(retry),
    fatal: (sinks, error) => {
      try {
        sinks.fatal(error);
      } catch {
        // The global fatal owner must still receive the incident when a turn sink fails.
      }
      publishFatal(error);
    },
  };

  return {
    reportInvariant(seam, context, producerId, error) {
      publishFatal(fatalError(seam, context, { kind: 'corrupt', producerId, error }));
    },
    begin(seam, context, sinks) {
      let retired = false;
      const aborters = new Map<string, (reason: unknown) => void>();
      const retiredSources = context.retiredSources ?? new Set<string>();
      const retiredSourceFatals = new Map<string, ProviderProxySetLifecycleFatalError>();
      const exactSources = new Map<string, Observation>();
      const reattachmentSources = new Map<string, Observation>();
      const abortAll = (reason: unknown): void => {
        for (const abort of aborters.values()) abort(reason);
      };
      const disposeCachedEvidence = ({
        transferred,
        sourceScope,
      }: Readonly<{
        transferred?: Readonly<{ sourceId: string; value: unknown }>;
        sourceScope?: string;
      }> = {}): void => {
        for (const sources of [exactSources, reattachmentSources]) {
          for (const [sourceId, observation] of sources) {
            if (sourceScope !== undefined && sourceId !== sourceScope) continue;
            if (
              observation.kind === 'evidence' &&
              (transferred === undefined ||
                sourceId !== transferred.sourceId ||
                observation.value !== transferred.value)
            ) {
              sinks.disposeLateEvidence?.(observation.value, sourceId);
            }
            sources.delete(sourceId);
          }
        }
      };

      function retireFatal(
        sourceId: string,
        observation: Extract<Observation, { kind: 'corrupt' | 'refused' | 'unknown' }>,
      ): void {
        if (retired || retiredSources.has(sourceId)) return;
        const error = fatalError(seam, context, observation);
        if (seam === 'control-reattachment' || seam === 'control-reattachment-hold') {
          retiredSources.add(sourceId);
          retiredSourceFatals.set(sourceId, error);
          aborters.get(sourceId)?.(error);
          disposeCachedEvidence({ sourceScope: sourceId });
          try {
            effects.fatal(sinks, error);
          } finally {
            reduceControlReattachment();
          }
          return;
        }
        retired = true;
        abortAll(error);
        disposeCachedEvidence();
        effects.fatal(sinks, error);
      }

      const reduceExactCapsule = (): void => {
        if (retired || exactSources.size < 2) return;
        const redemption = exactSources.get('redemption');
        const absence = exactSources.get('absence');
        if (redemption === undefined || absence === undefined) return;
        const redeemed =
          redemption.kind === 'evidence' && (redemption.value as ProviderProxySetRedemptionOutcome).kind === 'redeemed';
        if (redeemed && absence.kind === 'evidence' && containmentProofRequiresReap(absence.value)) {
          retireFatal(
            'redemption',
            corrupt('capsule-redemption', new Error('provider_proxy_capsule_recovery_evidence_conflict')) as Extract<
              Observation,
              { kind: 'corrupt' }
            >,
          );
          return;
        }
        retired = true;
        if (absence.kind === 'evidence' && containmentProofRequiresReap(absence.value)) {
          disposeCachedEvidence({ transferred: { sourceId: 'absence', value: absence.value } });
          sinks.evidence(absence.value, 'absence');
          return;
        }
        if (redemption.kind === 'evidence') {
          disposeCachedEvidence({ transferred: { sourceId: 'redemption', value: redemption.value } });
          sinks.evidence(redemption.value, 'redemption');
          return;
        }
        if (redemption.kind === 'unavailable') {
          disposeCachedEvidence();
          effects.retry(sinks, { producerId: redemption.producerId, incident: redemption.incident });
          return;
        }
        throw new Error('provider_proxy_exact_capsule_reducer_incomplete');
      };

      const retireReattachment = (value: unknown, sourceId: string): void => {
        if (retired) return;
        retired = true;
        const reason = new Error(`provider_proxy_control_reattachment_decided:${sourceId}`);
        abortAll(reason);
        disposeCachedEvidence({ transferred: { sourceId, value } });
        sinks.evidence(value, sourceId);
      };

      function reduceControlReattachment(): void {
        if (retired) return;
        const absence = reattachmentSources.get('absence');
        if (absence?.kind === 'evidence' && containmentProofRequiresReap(absence.value)) {
          retireReattachment(absence.value, 'absence');
          return;
        }
        const redemption = reattachmentSources.get('redemption');
        if (redemption === undefined && !retiredSources.has('redemption')) return;
        let redemptionUnavailable: Extract<Observation, { kind: 'unavailable' }> | undefined;
        if (redemption?.kind === 'evidence') {
          const value = redemption.value;
          if (typeof value !== 'object' || value === null || !('kind' in value)) {
            retireFatal(
              'redemption',
              unknown('role-control', new Error('provider_proxy_control_redemption_contract_violation')) as Extract<
                Observation,
                { kind: 'unknown' }
              >,
            );
            return;
          }
          const outcome = value as ProviderProxyControlRedemptionOutcome;
          if (outcome.kind === 'redeemed' || outcome.kind === 'refused') {
            retireReattachment(outcome, 'redemption');
            return;
          }
          if (outcome.kind !== 'unavailable') {
            retireFatal(
              'redemption',
              unknown('role-control', new Error('provider_proxy_control_redemption_contract_violation')) as Extract<
                Observation,
                { kind: 'unknown' }
              >,
            );
            return;
          }
          redemptionUnavailable = unavailable('role-control', outcome.incident) as Extract<
            Observation,
            { kind: 'unavailable' }
          >;
        }
        const redemptionSettled = redemption !== undefined || retiredSources.has('redemption');
        const absenceSettled = absence !== undefined || retiredSources.has('absence');
        if (!redemptionSettled || !absenceSettled) return;
        if (absence?.kind === 'evidence') {
          const proof = inspectProviderProxySetContainmentProof(absence.value);
          if (proof?.authorization === 'fenced' && proof.evidence.kind === 'proxy-absent') {
            retireReattachment(absence.value, 'absence');
            return;
          }
        }
        if (retiredSources.has('redemption') && retiredSources.has('absence')) {
          retired = true;
          return;
        }
        const unavailableObservation =
          redemptionUnavailable ??
          (redemption?.kind === 'unavailable' ? redemption : absence?.kind === 'unavailable' ? absence : undefined);
        const sourceFatal = retiredSourceFatals.get('redemption') ?? retiredSourceFatals.get('absence');
        const reason = new Error('provider_proxy_control_reattachment_retry');
        retired = true;
        abortAll(reason);
        disposeCachedEvidence();
        effects.retry(sinks, {
          producerId: unavailableObservation?.producerId ?? sourceFatal?.producerId ?? 'role-control',
          incident: unavailableObservation?.incident ?? sourceFatal ?? reason,
        });
      }

      const submit = (sourceId: string, observation: Observation): void => {
        if (retired || retiredSources.has(sourceId)) {
          if (observation.kind === 'evidence') sinks.disposeLateEvidence?.(observation.value, sourceId);
          return;
        }
        if (observation.kind === 'forwarded-fatal') {
          retired = true;
          abortAll(observation.error);
          disposeCachedEvidence();
          sinks.fatal(observation.error);
          return;
        }
        if (observation.kind === 'cancel') {
          retired = true;
          disposeCachedEvidence();
          sinks.cancel?.(observation.reason);
          return;
        }
        if (observation.kind === 'corrupt' || observation.kind === 'refused' || observation.kind === 'unknown') {
          // The foreign seam holds a path and nothing else, so every way its producer can disappoint it is a
          // hold this build carries locally rather than evidence about this coordinator. A fulfillment that
          // breaks the producer's own contract must not be reported as a refusal the filesystem gave.
          if (seam === 'foreign-capsule-retirement') {
            retired = true;
            effects.retry(sinks, {
              producerId: observation.producerId,
              incident: foreignCapsuleRetirementContractViolation,
            });
            return;
          }
          retireFatal(sourceId, observation);
          return;
        }
        if (seam === 'exact-capsule-recovery') {
          exactSources.set(sourceId, observation);
          reduceExactCapsule();
          return;
        }
        if (seam === 'control-reattachment' || seam === 'control-reattachment-hold') {
          reattachmentSources.set(sourceId, observation);
          reduceControlReattachment();
          return;
        }
        if (seam === 'containment-attempt') {
          if (observation.kind === 'evidence') {
            sinks.evidence(observation.value, sourceId);
          } else {
            effects.retry(sinks, {
              producerId: observation.producerId,
              incident: observation.kind === 'unavailable' ? observation.incident : observation.error,
            });
          }
          return;
        }
        retired = true;
        if (observation.kind === 'evidence') {
          sinks.evidence(observation.value, sourceId);
          return;
        }
        // Constraint: a retry-safe uncertainty is reported by the error that proved it retry-safe. Replacing it
        // with a label drops the cause, which is the only thing separating one retry-safe failure from another.
        effects.retry(sinks, {
          producerId: observation.producerId,
          incident: observation.kind === 'unavailable' ? observation.incident : observation.error,
        });
      };

      const settle = (source: ProviderProxyRecoveryAnySource, classify: () => Observation): void => {
        try {
          submit(source.sourceId, classify());
        } catch (error: unknown) {
          retired = true;
          const fatal = fatalError(seam, context, { kind: 'corrupt', producerId: source.producerId, error });
          try {
            abortAll(fatal);
          } catch {
            /* Every cleanup refusal must still reach the fatal owner. */
          }
          try {
            disposeCachedEvidence();
          } catch {
            /* Every cleanup refusal must still reach the fatal owner. */
          }
          effects.fatal(sinks, fatal);
        }
      };

      return {
        start(source) {
          if (retired || retiredSources.has(source.sourceId)) return;
          if (source.abort !== undefined) aborters.set(source.sourceId, source.abort);
          let produced: unknown;
          try {
            produced = invokeProducer(options.producers, source);
          } catch (error: unknown) {
            settle(source, () => classifyRejection(source.producerId, source.input, error, seam));
            return;
          }
          void Promise.resolve(produced).then(
            (value) => settle(source, () => classifyFulfillment(source.producerId, value, context)),
            (error: unknown) => settle(source, () => classifyRejection(source.producerId, source.input, error, seam)),
          );
        },
        cancel(reason) {
          if (retired) return;
          retired = true;
          abortAll(reason);
          disposeCachedEvidence();
          sinks.cancel?.(reason);
        },
      };
    },
  };
}

class ProviderProxyRecoveryDeadlineError extends Error {
  constructor() {
    super('Provider proxy recovery deadline expired.');
    this.name = 'ProviderProxyRecoveryDeadlineError';
    Object.setPrototypeOf(this, ProviderProxyRecoveryDeadlineError.prototype);
  }
}

export type ProviderProxyRecoveryDeadlineResult<T> =
  | Readonly<{ kind: 'settled'; value: T }>
  | Readonly<{ kind: 'unavailable'; incident: ProviderProxySetAvailabilityIncident }>;

export async function runProviderProxyRecoveryDeadline<T>(
  options: Readonly<{
    time: Pick<TimePort, 'setTimeout' | 'clearTimeout'>;
    signal: AbortSignal;
    timeoutMs: 45_000;
    produce(signal: AbortSignal): Promise<T>;
  }>,
): Promise<ProviderProxyRecoveryDeadlineResult<T>> {
  const deadlineAbort = new AbortController();
  const deadlineReason = new ProviderProxyRecoveryDeadlineError();
  let deadlineExpired = false;
  const timer = options.time.setTimeout(() => {
    deadlineExpired = true;
    deadlineAbort.abort(deadlineReason);
  }, options.timeoutMs);
  timer.unref?.();
  try {
    let value: T;
    try {
      value = await options.produce(AbortSignal.any([options.signal, deadlineAbort.signal]));
    } catch (error: unknown) {
      if (options.signal.aborted && options.signal.reason === error) throw error;
      if (error instanceof ProviderProxyRoleControlUnavailableError) {
        return deadlineExpired
          ? { kind: 'unavailable', incident: { kind: 'recovery-deadline', timeoutMs: options.timeoutMs } }
          : { kind: 'unavailable', incident: error.incident };
      }
      if (error === deadlineReason) {
        return { kind: 'unavailable', incident: { kind: 'recovery-deadline', timeoutMs: options.timeoutMs } };
      }
      throw error;
    }
    return deadlineExpired
      ? { kind: 'unavailable', incident: { kind: 'recovery-deadline', timeoutMs: options.timeoutMs } }
      : { kind: 'settled', value };
  } finally {
    options.time.clearTimeout(timer);
  }
}

export function providerProxyRecoveryRoleControlPort(input: RoleControlInput): Promise<unknown> {
  return input.run(input.signal);
}
