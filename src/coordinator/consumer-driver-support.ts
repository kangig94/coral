import { documentedCoralSetupError, type CoralSetupError } from '../runtime/errors.js';
import type { ConsumerApplyError, ConsumerRegistrationKind } from '../store/consumer-contract.js';
import type { CorpusInterest, CorpusLaneHint, KbCorpusSnapshot } from '../kb/contracts.js';

export function isCorpusInterest(value: unknown): value is CorpusInterest {
  return value === 'content' || value === 'metadata' || value === 'both';
}

export function isRegistrationKind(value: unknown): value is ConsumerRegistrationKind {
  return value === 'base' || value === 'equipment';
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
