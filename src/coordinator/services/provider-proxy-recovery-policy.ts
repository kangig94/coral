import type { TimePort } from '../../infra/port-types.js';
import {
  ProviderOperationAtomicTerminalizationError,
  ProviderOperationTerminalMetadataError,
  ProviderOperationTerminalizationUnavailableError,
  type ProviderOperationTerminalizationResult,
} from '../../jobs/provider-operation-terminalization.js';
import type { HandoffCapsule, HandoffCapsuleV2 } from '../../provider-proxy/handoff-capsule.js';
import type { OperationIdentity } from '../../provider-proxy/protocol.js';
import type { Database } from '../../store/db.js';
import { ProviderOperationJournalError } from '../../store/provider-operation-journal.js';
import type {
  ProviderOperationRecord,
  ProviderOperationTerminalDirective,
} from '../../store/provider-operation-record.js';
import {
  ProviderProxyRoleControlRemoteError,
  ProviderProxyRoleControlUnavailableError,
} from '../live/provider-proxy/role-control.js';
import {
  disappearanceDeliveryAttemptOutcomeSchema,
  type ContainmentDisappearanceNotice,
  type DisappearanceDeliveryAttemptOutcome,
} from './provider-containment-disappearance.js';
import type { ProviderHandoffCapsuleRetirementOutcome } from './provider-proxy-capsule-discovery.js';
import { providerProxySetIdentitiesEqual, type ProviderProxySetIdentity } from './provider-proxy-set/identity.js';
import type {
  ProviderProxySetAvailabilityIncident,
  ProviderProxySetInheritanceOutcome,
  ProviderProxySetLocator,
  ProviderProxySetRedemptionOutcome,
} from './provider-proxy-set/inheritance.js';

export const PROVIDER_PROXY_RECOVERY_PRODUCERS = [
  'disappearance-terminalization',
  'role-control',
  'set-inheritance',
  'capsule-redemption',
  'containment-proof',
  'capsule-rewrite',
  'capsule-retirement',
  'disappearance-consumer',
] as const;

export type ProviderProxyRecoveryProducerId = (typeof PROVIDER_PROXY_RECOVERY_PRODUCERS)[number];

export const PROVIDER_PROXY_RECOVERY_CONSUMER_SEAMS = [
  'disappearance-delivery',
  'startup-set-inheritance',
  'ordinary-set-inheritance',
  'containment-attempt',
  'exact-capsule-recovery',
  'opaque-capsule-redemption',
  'opaque-capsule-rewrite',
  'capsule-retirement',
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
  capsule: HandoffCapsule;
  capsulePath: string;
  signal: AbortSignal;
}>;

type ContainmentProofInput = Readonly<{
  identity: ProviderProxySetIdentity;
  signal: AbortSignal;
}>;

type CapsuleRewriteInput = Readonly<{ path: string; capsule: HandoffCapsuleV2 }>;
type CapsuleRetirementInput = Readonly<{ path: string }>;
type DisappearanceConsumerInput = Readonly<{ notice: ContainmentDisappearanceNotice }>;

export type ProviderProxyRecoveryProducerInput = {
  'disappearance-terminalization': DisappearanceTerminalizationInput;
  'role-control': RoleControlInput;
  'set-inheritance': SetInheritanceInput;
  'capsule-redemption': CapsuleRedemptionInput;
  'containment-proof': ContainmentProofInput;
  'capsule-rewrite': CapsuleRewriteInput;
  'capsule-retirement': CapsuleRetirementInput;
  'disappearance-consumer': DisappearanceConsumerInput;
};

export interface ProviderProxyRecoveryProducerPorts {
  'disappearance-terminalization'(
    input: DisappearanceTerminalizationInput,
  ): Promise<ProviderOperationTerminalizationResult> | ProviderOperationTerminalizationResult;
  'role-control'(input: RoleControlInput): Promise<unknown>;
  'set-inheritance'(input: SetInheritanceInput): Promise<ProviderProxySetInheritanceOutcome>;
  'capsule-redemption'(input: CapsuleRedemptionInput): Promise<ProviderProxySetRedemptionOutcome>;
  'containment-proof'(input: ContainmentProofInput): Promise<string | null>;
  'capsule-rewrite'(input: CapsuleRewriteInput): Promise<void> | void;
  'capsule-retirement'(
    input: CapsuleRetirementInput,
  ): Promise<ProviderHandoffCapsuleRetirementOutcome> | ProviderHandoffCapsuleRetirementOutcome;
  'disappearance-consumer'(input: DisappearanceConsumerInput): Promise<DisappearanceDeliveryAttemptOutcome>;
}

export type ProviderProxyRecoveryRetry = Readonly<{
  producerId: ProviderProxyRecoveryProducerId;
  incident: unknown;
}>;

const providerProxyRecoveryFatalOrigin: unique symbol = Symbol('provider-proxy-recovery-fatal-origin');

export type ProviderProxySetLifecycleFatalError = Error &
  Readonly<{
    [providerProxyRecoveryFatalOrigin]: true;
    stage: 'set-inheritance' | 'disappearance-delivery' | 'capsule-retirement' | 'capsule-recovery';
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
  capsule?: HandoffCapsule;
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

export interface ProviderProxyRecoveryDispatcher {
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

function capsuleMatchesIdentity(capsule: HandoffCapsule, identity: ProviderProxySetIdentity): boolean {
  if (capsule.version === 2) {
    const expected = {
      buildSetId: capsule.buildSetId,
      hostFingerprint: capsule.hostFingerprint,
      guardianInstanceId: capsule.guardianInstanceId,
      guardianPid: capsule.guardianPid,
      guardianIncarnation: capsule.guardianIncarnation,
      guardianControlEndpoint: capsule.guardianControlEndpoint,
      proxyInstanceId: capsule.proxyInstanceId,
      proxyPid: capsule.proxyPid,
      reaperInstanceId: capsule.reaperInstanceId,
      reaperPid: capsule.reaperPid,
      reaperIncarnation: capsule.reaperIncarnation,
      reaperControlEndpoint: capsule.reaperControlEndpoint,
      containmentKind: capsule.containmentKind,
      proxyIncarnation: capsule.proxyIncarnation,
      proxyProcessGroupId: capsule.proxyProcessGroupId,
      canonicalEndpoint: capsule.proxyEndpoint,
    };
    return providerProxySetIdentitiesEqual(expected, identity);
  }
  return (
    capsule.buildSetId === identity.buildSetId &&
    capsule.hostFingerprint === identity.hostFingerprint &&
    capsule.guardianInstanceId === identity.guardianInstanceId &&
    capsule.reaperInstanceId === identity.reaperInstanceId &&
    capsule.proxyInstanceId === identity.proxyInstanceId &&
    capsule.guardianControlEndpoint === identity.guardianControlEndpoint &&
    capsule.reaperControlEndpoint === identity.reaperControlEndpoint &&
    capsule.proxyEndpoint === identity.canonicalEndpoint
  );
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

function classifyFulfillment(
  producerId: ProviderProxyRecoveryProducerId,
  value: unknown,
  context: ProviderProxyRecoveryExactContext,
): Observation {
  if (producerId === 'disappearance-terminalization') {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('kind' in value) ||
      (value.kind !== 'terminalized' && value.kind !== 'conflict')
    ) {
      return unknown(producerId, new Error('provider_proxy_terminalization_contract_violation'));
    }
    return evidence(value);
  }
  if (producerId === 'set-inheritance') {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('kind' in value) ||
      !['inherited', 'containment-disappeared', 'not-bequeathed', 'temporarily-unavailable'].includes(
        String(value.kind),
      )
    ) {
      return unknown(producerId, new Error('provider_proxy_set_inheritance_contract_violation'));
    }
    const outcome = value as ProviderProxySetInheritanceOutcome;
    return outcome.kind === 'temporarily-unavailable' ? unavailable(producerId, outcome.incident) : evidence(outcome);
  }
  if (producerId === 'capsule-redemption') {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('kind' in value) ||
      (value.kind !== 'redeemed' && value.kind !== 'temporarily-unavailable')
    ) {
      return unknown(producerId, new Error('provider_proxy_capsule_redemption_contract_violation'));
    }
    const outcome = value as ProviderProxySetRedemptionOutcome;
    if (outcome.kind === 'temporarily-unavailable') return unavailable(producerId, outcome.incident);
    if (context.capsule !== undefined && !capsuleMatchesIdentity(context.capsule, outcome.set.setIdentity)) {
      return corrupt(producerId, new Error('provider_proxy_capsule_redemption_identity_mismatch'));
    }
    if (
      context.setIdentity !== undefined &&
      !providerProxySetIdentitiesEqual(context.setIdentity, outcome.set.setIdentity)
    ) {
      return corrupt(producerId, new Error('provider_proxy_capsule_redemption_identity_mismatch'));
    }
    return evidence(outcome);
  }
  if (producerId === 'containment-proof' && value !== null && typeof value !== 'string') {
    return unknown(producerId, new Error('provider_proxy_containment_proof_contract_violation'));
  }
  if (producerId === 'capsule-rewrite' && value !== undefined) {
    return unknown(producerId, new Error('provider_proxy_capsule_rewrite_contract_violation'));
  }
  if (producerId === 'capsule-retirement') {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('kind' in value) ||
      (value.kind !== 'retired' && value.kind !== 'temporarily-unavailable')
    ) {
      return unknown(producerId, new Error('provider_proxy_capsule_retirement_contract_violation'));
    }
    const outcome = value as ProviderHandoffCapsuleRetirementOutcome;
    return outcome.kind === 'temporarily-unavailable' ? unavailable(producerId, outcome.incident) : evidence(outcome);
  }
  if (producerId === 'disappearance-consumer') {
    const parsed = disappearanceDeliveryAttemptOutcomeSchema.safeParse(value);
    if (!parsed.success) {
      return unknown(producerId, new Error('provider_proxy_disappearance_consumer_contract_violation'));
    }
    const outcome = parsed.data;
    if (outcome.kind === 'operational-failure') return unavailable(producerId, outcome);
    if (context.operation === undefined || !sameOperationIdentity(outcome.acceptance.operation, context.operation)) {
      return corrupt(producerId, new Error('provider_proxy_disappearance_consumer_identity_mismatch'));
    }
    return evidence(outcome.acceptance);
  }
  return evidence(value);
}

function classifyRejection(
  producerId: ProviderProxyRecoveryProducerId,
  input: ProviderProxyRecoveryProducerInput[ProviderProxyRecoveryProducerId],
  error: unknown,
): Observation {
  if (isProviderProxyRecoveryFatalError(error)) return { kind: 'forwarded-fatal', error };
  const cancelled = callerCancellation(input as { signal?: AbortSignal }, error);
  if (cancelled !== null) return cancelled;
  if (producerId === 'disappearance-terminalization') {
    if (error instanceof ProviderOperationTerminalizationUnavailableError) {
      return unavailable(producerId, error.incident);
    }
    if (error instanceof ProviderOperationAtomicTerminalizationError) {
      return retrySafeTerminalizationUnknown(error);
    }
    if (error instanceof ProviderOperationTerminalMetadataError || error instanceof ProviderOperationJournalError) {
      return corrupt(producerId, error);
    }
    return unknown(producerId, error);
  }
  if (producerId === 'disappearance-consumer') return unknown(producerId, error);
  if (error instanceof ProviderProxyRoleControlUnavailableError) return unavailable(producerId, error.incident);
  if (error instanceof ProviderProxyRoleControlRemoteError) return refused(producerId, error);
  if (
    error instanceof ProviderOperationJournalError ||
    (error instanceof Error && error.name === 'ProviderProxySetInheritanceCorruptionError')
  ) {
    return corrupt(producerId, error);
  }
  return unknown(producerId, error);
}

function fatalStage(seam: ProviderProxyRecoveryConsumerSeam): ProviderProxySetLifecycleFatalError['stage'] {
  if (seam === 'startup-set-inheritance' || seam === 'ordinary-set-inheritance') return 'set-inheritance';
  if (seam === 'disappearance-delivery') return 'disappearance-delivery';
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
    case 'capsule-rewrite':
      return producers['capsule-rewrite'](source.input);
    case 'capsule-retirement':
      return producers['capsule-retirement'](source.input);
    case 'disappearance-consumer':
      return producers['disappearance-consumer'](source.input);
  }
}

export function createProviderProxyRecoveryDispatcher(
  options: Readonly<{
    producers: ProviderProxyRecoveryProducerPorts;
    fatalSink: ProviderProxyRecoveryFatalSink;
  }>,
): ProviderProxyRecoveryDispatcher {
  const effects: ProviderProxyRecoveryEffects = {
    retry: (sinks, retry) => sinks.retry(retry),
    fatal: (sinks, error) => {
      try {
        sinks.fatal(error);
      } finally {
        options.fatalSink.fatal(error);
      }
    },
  };

  return {
    begin(seam, context, sinks) {
      let retired = false;
      const aborters = new Set<(reason: unknown) => void>();
      const exactSources = new Map<string, Observation>();

      const retireFatal = (observation: Extract<Observation, { kind: 'corrupt' | 'refused' | 'unknown' }>): void => {
        if (retired) return;
        retired = true;
        const error = fatalError(seam, context, observation);
        for (const abort of aborters) abort(error);
        effects.fatal(sinks, error);
      };

      const reduceExactCapsule = (): void => {
        if (retired || exactSources.size < 2) return;
        const redemption = exactSources.get('redemption');
        const absence = exactSources.get('absence');
        if (redemption === undefined || absence === undefined) return;
        if (redemption.kind === 'evidence' && absence.kind === 'evidence' && absence.value !== null) {
          retireFatal(
            corrupt('capsule-redemption', new Error('provider_proxy_capsule_recovery_evidence_conflict')) as Extract<
              Observation,
              { kind: 'corrupt' }
            >,
          );
          return;
        }
        retired = true;
        if (redemption.kind === 'evidence') {
          sinks.evidence(redemption.value, 'redemption');
          return;
        }
        if (absence.kind === 'evidence' && absence.value !== null) {
          sinks.evidence(absence.value, 'absence');
          return;
        }
        if (redemption.kind === 'unavailable') {
          effects.retry(sinks, { producerId: redemption.producerId, incident: redemption.incident });
          return;
        }
        throw new Error('provider_proxy_exact_capsule_reducer_incomplete');
      };

      const submit = (sourceId: string, observation: Observation): void => {
        if (retired) return;
        if (observation.kind === 'forwarded-fatal') {
          retired = true;
          for (const abort of aborters) abort(observation.error);
          sinks.fatal(observation.error);
          return;
        }
        if (observation.kind === 'cancel') {
          retired = true;
          sinks.cancel?.(observation.reason);
          return;
        }
        if (observation.kind === 'corrupt' || observation.kind === 'refused' || observation.kind === 'unknown') {
          retireFatal(observation);
          return;
        }
        if (seam === 'exact-capsule-recovery') {
          exactSources.set(sourceId, observation);
          reduceExactCapsule();
          return;
        }
        if (seam === 'containment-attempt') {
          if (observation.kind === 'evidence') {
            sinks.evidence(observation.value, sourceId);
          } else {
            effects.retry(sinks, {
              producerId: observation.producerId,
              incident:
                observation.kind === 'unavailable'
                  ? observation.incident
                  : { kind: observation.kind, proof: observation.proof },
            });
          }
          return;
        }
        retired = true;
        if (observation.kind === 'evidence') {
          sinks.evidence(observation.value, sourceId);
          return;
        }
        effects.retry(sinks, {
          producerId: observation.producerId,
          incident:
            observation.kind === 'unavailable'
              ? observation.incident
              : { kind: observation.kind, proof: observation.proof },
        });
      };

      return {
        start(source) {
          if (retired) return;
          if (source.abort !== undefined) aborters.add(source.abort);
          let produced: unknown;
          try {
            produced = invokeProducer(options.producers, source);
          } catch (error: unknown) {
            submit(source.sourceId, classifyRejection(source.producerId, source.input, error));
            return;
          }
          void Promise.resolve(produced).then(
            (value) => submit(source.sourceId, classifyFulfillment(source.producerId, value, context)),
            (error: unknown) => submit(source.sourceId, classifyRejection(source.producerId, source.input, error)),
          );
        },
        cancel(reason) {
          if (retired) return;
          retired = true;
          for (const abort of aborters) abort(reason);
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
