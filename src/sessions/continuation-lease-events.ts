import type { CoralEventInput } from '../store/envelope.js';
import {
  type ClaimedContinuationLease,
  type ClearedContinuationLease,
  type ExpiredContinuationLease,
  type PendingContinuationLease,
  type ProviderSession,
} from './entry.js';
import { normalizeProviderSession } from './entry-normalization.js';
import type {
  SessionContinuationLeaseClaimedBody,
  SessionContinuationLeaseClearedBody,
  SessionContinuationLeaseExpiredBody,
  SessionContinuationLeaseRecordedBody,
} from './event-bodies.js';

export function sessionContinuationLeaseRecordedEvent(
  entry: ProviderSession,
  lease: PendingContinuationLease,
): CoralEventInput<SessionContinuationLeaseRecordedBody> {
  const normalizedEntry = normalizeProviderSession(entry);
  return {
    type: 'session.continuation_lease.recorded',
    stream: { kind: 'session', id: normalizedEntry.sessionId },
    refs: { sessionId: normalizedEntry.sessionId, jobId: lease.staleJobId },
    bodyVersion: 1,
    body: {
      entry: normalizedEntry,
      sessionId: normalizedEntry.sessionId,
      lease,
    },
  };
}

export function sessionContinuationLeaseClaimedEvent(
  entry: ProviderSession,
  lease: ClaimedContinuationLease,
): CoralEventInput<SessionContinuationLeaseClaimedBody> {
  const normalizedEntry = normalizeProviderSession(entry);
  return {
    type: 'session.continuation_lease.claimed',
    stream: { kind: 'session', id: normalizedEntry.sessionId },
    refs: {
      sessionId: normalizedEntry.sessionId,
      jobId: lease.resumedJobId,
    },
    bodyVersion: 1,
    body: {
      entry: normalizedEntry,
      sessionId: normalizedEntry.sessionId,
      lease,
    },
  };
}

export function sessionContinuationLeaseClearedEvent(
  entry: ProviderSession,
  lease: ClearedContinuationLease,
): CoralEventInput<SessionContinuationLeaseClearedBody> {
  const normalizedEntry = normalizeProviderSession(entry);
  return {
    type: 'session.continuation_lease.cleared',
    stream: { kind: 'session', id: normalizedEntry.sessionId },
    refs: {
      sessionId: normalizedEntry.sessionId,
      jobId: lease.clearedByJobId,
    },
    bodyVersion: 1,
    body: {
      entry: normalizedEntry,
      sessionId: normalizedEntry.sessionId,
      lease,
    },
  };
}

export function sessionContinuationLeaseExpiredEvent(
  entry: ProviderSession,
  lease: ExpiredContinuationLease,
): CoralEventInput<SessionContinuationLeaseExpiredBody> {
  const normalizedEntry = normalizeProviderSession(entry);
  return {
    type: 'session.continuation_lease.expired',
    stream: { kind: 'session', id: normalizedEntry.sessionId },
    refs: { sessionId: normalizedEntry.sessionId, jobId: lease.staleJobId },
    bodyVersion: 1,
    body: {
      entry: normalizedEntry,
      sessionId: normalizedEntry.sessionId,
      lease,
    },
  };
}
