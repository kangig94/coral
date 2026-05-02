import type { KbCorpusSnapshot } from '../../kb/contract.js';
import { documentedCoralSetupError, type CoralSetupError } from '../../runtime/errors.js';
import type { TimerHandle, TimePort } from '../../infra/port-types.js';
import type {
  ConsumerApplyError,
  ConsumerHandle,
  ConsumerRegistration,
  ConsumerRegistrationKind,
  CorpusConsumerRegistration,
  CorpusInterest,
  CorpusLaneHint,
  JournalConsumerRegistration,
  StatelessProviderLifecycleRegistration,
} from '../../store/consumer-contract.js';

export type Authority = 'journal' | 'corpus';

export type ConsumerDriverTimers = Pick<TimePort, 'setTimeout' | 'clearTimeout'>;

export type ForcedCorpusFreshnessTarget = {
  readonly snapshot: KbCorpusSnapshot;
  readonly atLeastGeneration: number;
};

export interface Waiter {
  target: number | KbCorpusSnapshot | ForcedCorpusFreshnessTarget;
  resolve: () => void;
  reject: (err: Error) => void;
  timeoutHandle: TimerHandle;
  settled: boolean;
}

interface ConsumerStateCommon {
  readonly handle: ConsumerHandle;
  readonly registrationKind: ConsumerRegistrationKind;
  stopped: boolean;
  stopPromise: Promise<void> | null;
  stopRequestedAt: number | null;
  unregistered: boolean;
}

export type JournalConsumerState = ConsumerStateCommon & {
  readonly kind: 'journal';
  readonly reg: JournalConsumerRegistration;
  inFlight: Promise<void> | null;
  pendingTarget: number | null;
  waiters: Set<Waiter>;
  activeController: AbortController | null;
  lastApplyError: ConsumerApplyError | null;
};

export type CorpusConsumerState = ConsumerStateCommon & {
  readonly kind: 'corpus';
  readonly reg: CorpusConsumerRegistration;
  inFlight: Promise<void> | null;
  pendingCorpusSnapshot: KbCorpusSnapshot | null;
  pendingForcedCorpusApply: { snapshot: KbCorpusSnapshot; generation: number } | null;
  waiters: Set<Waiter>;
  activeController: AbortController | null;
  lastApplyError: ConsumerApplyError | null;
  lastAppliedForceGeneration: number;
};

export type StatelessConsumerState = ConsumerStateCommon & {
  readonly kind: 'stateless';
  readonly reg: StatelessProviderLifecycleRegistration;
  readonly registrationKind: 'stateless';
  readonly lastApplyError: null;
};

export type ConsumerState = JournalConsumerState | CorpusConsumerState | StatelessConsumerState;

export type FreshnessConsumerState = JournalConsumerState | CorpusConsumerState;

export function createConsumerState(
  reg: ConsumerRegistration,
  registrationKind: ConsumerRegistrationKind,
  handle: ConsumerHandle,
): ConsumerState {
  const common = {
    handle,
    registrationKind,
    stopped: false,
    stopPromise: null,
    stopRequestedAt: null,
    unregistered: false,
  };

  if (reg.kind === 'stateless') {
    return {
      ...common,
      kind: 'stateless',
      reg,
      registrationKind: 'stateless',
      lastApplyError: null,
    };
  }

  if (registrationKind === 'stateless') {
    throw consumerRegistrationKindMismatchError(reg.id, reg.registrationKind, registrationKind);
  }

  if (reg.authority === 'journal') {
    return {
      ...common,
      kind: 'journal',
      reg,
      registrationKind,
      inFlight: null,
      pendingTarget: null,
      waiters: new Set(),
      activeController: null,
      lastApplyError: null,
    };
  }

  return {
    ...common,
    kind: 'corpus',
    reg,
    registrationKind,
    inFlight: null,
    pendingCorpusSnapshot: null,
    pendingForcedCorpusApply: null,
    waiters: new Set(),
    activeController: null,
    lastApplyError: null,
    lastAppliedForceGeneration: 0,
  };
}

export function isCorpusInterest(value: unknown): value is CorpusInterest {
  return value === 'content' || value === 'metadata' || value === 'both';
}

export function isRegistrationKind(value: unknown): value is ConsumerRegistrationKind {
  return value === 'base' || value === 'expansion' || value === 'stateless';
}

export function laneHintFromInterest(interest: CorpusInterest): CorpusLaneHint | null {
  return interest === 'both' ? null : interest;
}

export function parseStoredCorpusInterest(row: {
  readonly corpus_interest: string | null;
  readonly lane: string | null;
}): CorpusInterest | null {
  const raw = row.corpus_interest ?? row.lane;
  return isCorpusInterest(raw) ? raw : null;
}

export function shouldNotifyCorpusConsumer(interest: CorpusInterest, laneHint: CorpusLaneHint | undefined): boolean {
  return laneHint === undefined || interest === 'both' || interest === laneHint;
}

export function isKbCorpusSnapshot(value: unknown): value is KbCorpusSnapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as KbCorpusSnapshot).snapshotId === 'string' &&
    typeof (value as KbCorpusSnapshot).contentSeq === 'number' &&
    typeof (value as KbCorpusSnapshot).metadataSeq === 'number' &&
    typeof (value as KbCorpusSnapshot).contentManifestHash === 'string' &&
    typeof (value as KbCorpusSnapshot).metadataManifestHash === 'string'
  );
}

export function isForcedCorpusFreshnessTarget(value: unknown): value is ForcedCorpusFreshnessTarget {
  return (
    typeof value === 'object' &&
    value !== null &&
    isKbCorpusSnapshot((value as ForcedCorpusFreshnessTarget).snapshot) &&
    typeof (value as ForcedCorpusFreshnessTarget).atLeastGeneration === 'number' &&
    Number.isInteger((value as ForcedCorpusFreshnessTarget).atLeastGeneration) &&
    (value as ForcedCorpusFreshnessTarget).atLeastGeneration >= 0
  );
}

export function corpusSnapshotFromTarget(target: KbCorpusSnapshot | ForcedCorpusFreshnessTarget): KbCorpusSnapshot {
  return isForcedCorpusFreshnessTarget(target) ? target.snapshot : target;
}

export function toConsumerApplyError(err: unknown, at: string): ConsumerApplyError {
  if (err instanceof Error && err.message.trim().length > 0) {
    return { message: err.message, at, cause: err };
  }
  if (typeof err === 'string' && err.trim().length > 0) {
    return { message: err, at, cause: err };
  }
  return { message: 'Consumer apply failed', at, cause: err };
}

export function consumerNotRegisteredError(consumerId: string): CoralSetupError {
  return documentedCoralSetupError('consumer_not_registered', { id: consumerId });
}

export function consumerAuthorityMismatchError(consumerId: string, expected: string, actual: string): CoralSetupError {
  return documentedCoralSetupError('consumer_authority_mismatch', {
    id: consumerId,
    expected,
    actual,
  });
}

export function consumerInterestMismatchError(consumerId: string): CoralSetupError {
  return documentedCoralSetupError('consumer_interest_mismatch', { id: consumerId });
}

export function consumerRegistrationKindMismatchError(
  consumerId: string,
  expected: ConsumerRegistrationKind | undefined,
  actual: ConsumerRegistrationKind,
): CoralSetupError {
  return documentedCoralSetupError('consumer_registration_kind_mismatch', {
    id: consumerId,
    expected,
    actual,
  });
}

export function renderConsumerId(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return `${value}`;
  }
  return 'invalid';
}
