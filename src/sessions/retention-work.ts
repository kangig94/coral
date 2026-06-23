import { sqlPlaceholders } from '../store/db.js';
import type { ReadonlyDatabase } from '../store/read-port.js';
import { hasUnterminalRetentionDiscardRequest, isProtectiveContinuationLease, type SessionEntry } from './entry.js';
import { readProjectionSessionEntriesById } from './projections.js';

export type SessionRetentionPair = {
  readonly sessionId: string;
  readonly jobId: string;
};

export type SessionRetentionWork = SessionRetentionPair & {
  readonly entry: SessionEntry;
};

type TerminalReleaseRow = {
  session_id: string | null;
  job_id: string;
  terminal_seq: number;
};

type TerminalOutcomeRow = {
  session_id: string;
};

export type RetentionSelectionOptions = {
  readonly nowMs?: number;
};

export function sessionRetentionWorkKey(sessionId: string, jobId: string): string {
  return `${sessionId}\u0000${jobId}`;
}

export function readSessionRetentionWorkForSessionIds(
  db: ReadonlyDatabase,
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
  return readSessionRetentionWorkForEntries(db, entries, options);
}

export function readSessionRetentionWorkForEntries(
  db: ReadonlyDatabase,
  entries: readonly SessionEntry[],
  options: RetentionSelectionOptions = {},
): SessionRetentionWork[] {
  const retainedEntries = uniqueRetainedEntries(entries, retentionSelectionNow(options));
  if (retainedEntries.length === 0) {
    return [];
  }

  const sessionIds = retainedEntries.map((entry) => entry.sessionId);
  const terminalOutcomeSessions = readTerminalOutcomeSessions(db, sessionIds);
  const terminalReleasePairs = readTerminalReleasePairsBySession(db, sessionIds);
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
  pairs: readonly SessionRetentionPair[],
  options: RetentionSelectionOptions = {},
): Map<string, SessionRetentionWork> {
  const sessionIds = uniqueStrings(pairs.map((pair) => pair.sessionId));
  if (sessionIds.length === 0) {
    return new Map();
  }

  const entriesBySession = readProjectionSessionEntriesById(db, sessionIds);
  const terminalOutcomeSessions = readTerminalOutcomeSessions(db, sessionIds);
  const terminalReleasePairs = readTerminalReleasePairsBySession(db, sessionIds);
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

function readTerminalOutcomeSessions(db: ReadonlyDatabase, sessionIds: readonly string[]): Set<string> {
  if (sessionIds.length === 0) {
    return new Set();
  }

  const rows = db
    .prepare(
      `SELECT DISTINCT stream_id AS session_id
         FROM events
        WHERE stream_kind = 'session'
          AND (
            type = 'session.retention.discard.failed'
            OR (
              type = 'session.retention.discard.completed'
              AND COALESCE(json_extract(CAST(body AS TEXT), '$.outcome'), '') != 'skipped_protected'
            )
          )
          AND stream_id IN (${sqlPlaceholders(sessionIds.length)})`,
    )
    .all(...sessionIds) as TerminalOutcomeRow[];

  return new Set(rows.map((row) => row.session_id));
}

function readTerminalReleasePairsBySession(
  db: ReadonlyDatabase,
  sessionIds: readonly string[],
): Map<string, Set<string>> {
  if (sessionIds.length === 0) {
    return new Map();
  }

  const rows = db
    .prepare(
      `SELECT DISTINCT
              json_extract(t.refs, '$.sessionId') AS session_id,
              t.stream_id AS job_id,
              t.seq AS terminal_seq
         FROM events AS t
         JOIN events AS r
           ON r.type = 'session.claim.released'
          AND r.stream_kind = 'session'
          AND COALESCE(json_extract(r.refs, '$.sessionId'), r.stream_id) = json_extract(t.refs, '$.sessionId')
          AND COALESCE(json_extract(r.refs, '$.jobId'), json_extract(CAST(r.body AS TEXT), '$.jobId')) = t.stream_id
        WHERE t.type = 'job.terminal.recorded'
          AND t.stream_kind = 'job'
          AND json_extract(t.refs, '$.sessionId') IN (${sqlPlaceholders(sessionIds.length)})
        ORDER BY t.seq ASC, t.stream_id ASC`,
    )
    .all(...sessionIds) as TerminalReleaseRow[];

  const pairsBySession = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.session_id === null) {
      continue;
    }
    const jobIds = pairsBySession.get(row.session_id) ?? new Set<string>();
    jobIds.add(row.job_id);
    pairsBySession.set(row.session_id, jobIds);
  }
  return pairsBySession;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
