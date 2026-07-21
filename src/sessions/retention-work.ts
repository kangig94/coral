import { sqlPlaceholders } from '../store/db.js';
import type { ReadonlyDatabase } from '../store/read-port.js';
import { decodeStoredBody, type StoreReadContext } from '../store/body-codec.js';
import { decodeEventRefs } from '../store/envelope.js';
import type { EventsRow } from '../store/schema.js';
import { hasUnterminalRetentionDiscardRequest, isProtectiveContinuationLease, type SessionEntry } from './entry.js';
import { readProjectionSessionEntriesById } from './projections.js';

export type SessionRetentionPair = {
  readonly sessionId: string;
  readonly jobId: string;
};

export type SessionRetentionWork = SessionRetentionPair & {
  readonly entry: SessionEntry;
};

export type RetentionSelectionOptions = {
  readonly nowMs?: number;
};

export function sessionRetentionWorkKey(sessionId: string, jobId: string): string {
  return `${sessionId}\u0000${jobId}`;
}

export function readSessionRetentionWorkForSessionIds(
  db: ReadonlyDatabase,
  readCtx: StoreReadContext,
  sessionIds: readonly string[],
  options: RetentionSelectionOptions = {},
): SessionRetentionWork[] {
  const entriesBySession = readProjectionSessionEntriesById(db, sessionIds);
  const entries: SessionEntry[] = [];
  for (const sessionId of uniqueStrings(sessionIds)) {
    const entry = entriesBySession.get(sessionId);
    if (entry !== undefined) {
      entries.push(entry);
    }
  }
  return readSessionRetentionWorkForEntries(db, readCtx, entries, options);
}

export function readSessionRetentionWorkForEntries(
  db: ReadonlyDatabase,
  readCtx: StoreReadContext,
  entries: readonly SessionEntry[],
  options: RetentionSelectionOptions = {},
): SessionRetentionWork[] {
  const retainedEntries = uniqueRetainedEntries(entries, retentionSelectionNow(options));
  if (retainedEntries.length === 0) {
    return [];
  }

  const sessionIds = retainedEntries.map((entry) => entry.sessionId);
  const terminalOutcomeSessions = readTerminalOutcomeSessions(db, readCtx, sessionIds);
  const terminalReleasePairs = readTerminalReleasePairsBySession(db, readCtx, sessionIds);
  const work: SessionRetentionWork[] = [];
  for (const entry of retainedEntries) {
    if (terminalOutcomeSessions.has(entry.sessionId)) {
      continue;
    }
    const jobIds = terminalReleasePairs.get(entry.sessionId);
    if (jobIds === undefined) {
      continue;
    }
    for (const jobId of jobIds) {
      work.push({ sessionId: entry.sessionId, jobId, entry });
    }
  }
  return work;
}

export function readSessionRetentionWorkForPairs(
  db: ReadonlyDatabase,
  readCtx: StoreReadContext,
  pairs: readonly SessionRetentionPair[],
  options: RetentionSelectionOptions = {},
): Map<string, SessionRetentionWork> {
  const sessionIds = uniqueStrings(pairs.map((pair) => pair.sessionId));
  if (sessionIds.length === 0) {
    return new Map();
  }

  const entriesBySession = readProjectionSessionEntriesById(db, sessionIds);
  const terminalOutcomeSessions = readTerminalOutcomeSessions(db, readCtx, sessionIds);
  const terminalReleasePairs = readTerminalReleasePairsBySession(db, readCtx, sessionIds);
  const workByPair = new Map<string, SessionRetentionWork>();
  const nowMs = retentionSelectionNow(options);
  for (const pair of pairs) {
    const entry = entriesBySession.get(pair.sessionId);
    if (
      entry === undefined ||
      !isRetentionEligibleEntry(entry, nowMs) ||
      terminalOutcomeSessions.has(pair.sessionId) ||
      !terminalReleasePairs.get(pair.sessionId)?.has(pair.jobId)
    ) {
      continue;
    }
    workByPair.set(sessionRetentionWorkKey(pair.sessionId, pair.jobId), {
      sessionId: pair.sessionId,
      jobId: pair.jobId,
      entry,
    });
  }
  return workByPair;
}

function retentionSelectionNow(options: RetentionSelectionOptions): number {
  return options.nowMs ?? Date.now();
}

function isRetentionEligibleEntry(entry: SessionEntry, nowMs: number): boolean {
  return (
    entry.retention === 'discard_provider_artifacts_on_terminal' &&
    entry.activeJobId === undefined &&
    !isProtectiveContinuationLease(entry.continuationLease, nowMs) &&
    !hasUnterminalRetentionDiscardRequest(entry)
  );
}

function uniqueRetainedEntries(entries: readonly SessionEntry[], nowMs: number): SessionEntry[] {
  const retainedEntries: SessionEntry[] = [];
  const seenSessionIds = new Set<string>();
  for (const entry of entries) {
    if (!isRetentionEligibleEntry(entry, nowMs) || seenSessionIds.has(entry.sessionId)) {
      continue;
    }
    retainedEntries.push(entry);
    seenSessionIds.add(entry.sessionId);
  }
  return retainedEntries;
}

function readTerminalOutcomeSessions(
  db: ReadonlyDatabase,
  readCtx: StoreReadContext,
  sessionIds: readonly string[],
): Set<string> {
  if (sessionIds.length === 0) {
    return new Set();
  }

  const rows = db
    .prepare<unknown[], EventsRow>(
      `SELECT *
         FROM events
        WHERE stream_kind = 'session'
          AND type IN ('session.retention.discard.failed', 'session.retention.discard.completed')
          AND stream_id IN (${sqlPlaceholders(sessionIds.length)})`,
    )
    .all(...sessionIds);

  const terminalSessionIds = new Set<string>();
  for (const row of rows) {
    const body = decodeStoredBody(row, readCtx) as { outcome?: unknown };
    if (row.type === 'session.retention.discard.failed' || body.outcome !== 'skipped_protected') {
      terminalSessionIds.add(row.stream_id);
    }
  }
  return terminalSessionIds;
}

function readTerminalReleasePairsBySession(
  db: ReadonlyDatabase,
  readCtx: StoreReadContext,
  sessionIds: readonly string[],
): Map<string, Set<string>> {
  if (sessionIds.length === 0) {
    return new Map();
  }

  const sessionIdSet = new Set(sessionIds);
  const releaseRows = db
    .prepare<unknown[], EventsRow>(
      `SELECT * FROM events
        WHERE type = 'session.claim.released'
          AND stream_kind = 'session'
          AND stream_id IN (${sqlPlaceholders(sessionIds.length)})
        ORDER BY seq ASC`,
    )
    .all(...sessionIds);
  const releasedPairs = new Set<string>();
  const releasedJobIds = new Set<string>();
  for (const row of releaseRows) {
    decodeStoredBody(row, readCtx);
    const refs = decodeEventRefs(row);
    const sessionId = refs?.sessionId ?? row.stream_id;
    if (!sessionIdSet.has(sessionId)) continue;
    if (refs?.jobId === undefined) {
      throw new Error(`Stored session.claim.released event ${row.seq} has no refs.jobId.`);
    }
    releasedPairs.add(sessionRetentionWorkKey(sessionId, refs.jobId));
    releasedJobIds.add(refs.jobId);
  }

  if (releasedJobIds.size === 0) return new Map();

  const candidateJobIds = [...releasedJobIds];
  const terminalRows = db
    .prepare<unknown[], EventsRow>(
      `SELECT * FROM events
        WHERE type = 'job.terminal.recorded'
          AND stream_kind = 'job'
          AND stream_id IN (${sqlPlaceholders(candidateJobIds.length)})
        ORDER BY seq ASC`,
    )
    .all(...candidateJobIds);

  const pairsBySession = new Map<string, Set<string>>();
  for (const row of terminalRows) {
    decodeStoredBody(row, readCtx);
    const sessionId = decodeEventRefs(row)?.sessionId;
    if (sessionId === undefined || !sessionIdSet.has(sessionId)) continue;
    if (!releasedPairs.has(sessionRetentionWorkKey(sessionId, row.stream_id))) continue;
    const jobIds = pairsBySession.get(sessionId) ?? new Set<string>();
    jobIds.add(row.stream_id);
    pairsBySession.set(sessionId, jobIds);
  }
  return pairsBySession;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
