import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { type DiscussDomainEvent, type PersistedDiscussSnapshot } from '../discuss/events.js';
import type { DiscussState } from '../discuss/types.js';
import { parseWithSchema } from '../shared/persistence-parsers.js';
import {
  listPersistedDiscussSessionsForSourceWithStorage,
  parseJsonLines,
  readDiscussDiscoveryForSourceWithStorage,
  readDiscussEventLogWithStorage,
  readDiscussSnapshotWithStorage,
  readDiscussSourcesWithStorage,
  readDiscussSummaryIndexForSourceWithStorage,
  readJsonFileWithStorage,
  readStatusRecordWithStorage,
  readTextFileWithStorage,
  resolveDiscussSessionDirForSourceWithStorage,
} from '../shared/persistence-readers.js';
import type {
  DiscussDiscoveryData,
  DiscussDiscoverySession,
  DiscussSummaryIndexData,
} from '../shared/persistence-types.js';
import type { DiscussPathResolver, StoragePort } from '../runtime/ports.js';
import {
  discussSourcesPath,
  discussBaseDirForSource,
  discussDiscoveryPathForSource,
  discussEventLogPath,
  discussSessionDirForSource,
  discussStatePath,
  discussSummaryIndexPathForSource,
  jobsDir,
  resolveProjectSource,
} from '../infra/paths.js';
import type { PersistedProgressRecord, PersistedStatusRecord } from '../shared/types.js';

export { isValidSessionEntry, readSessionEntry, readSessionEntryLenient } from '../shared/session-entry.js';
export type { LenientSessionEntry, ProvenanceState } from '../shared/session-entry.js';
export type {
  DiscussDiscoveryData,
  DiscussDiscoverySession,
  DiscussSummaryIndexData,
  DiscussSummaryIndexRow,
} from '../shared/persistence-types.js';

function readJsonFile(filePath: string): unknown | null {
  return readJsonFileWithStorage(nodeDiscussReaderStorage, filePath);
}

function readTextFile(filePath: string): string | null {
  return readTextFileWithStorage(nodeDiscussReaderStorage, filePath);
}

/** Structural schema for persisted progress records. */
const persistedProgressRecordSchema = z
  .object({
    jobId: z.string(),
    sessionId: z.string(),
    eventId: z.number(),
    type: z.string(),
    ts: z.string(),
  })
  .passthrough();

function isValidDiscussState(value: unknown): value is DiscussState {
  const discussStateSchema = z
    .object({
      session_id: z.string(),
      topic: z.string(),
      status: z.string(),
      agents: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]),
    })
    .passthrough();
  return discussStateSchema.safeParse(value).success;
}

const nodeDiscussReaderStorage: Pick<StoragePort, 'readFileSync' | 'readdirSync' | 'existsSync'> = {
  readFileSync: (filePath, encoding) => readFileSync(filePath, encoding),
  readdirSync: (dirPath, options) => readdirSync(dirPath, options),
  existsSync: (filePath) => existsSync(filePath),
};

const nodeDiscussReaderPaths: Pick<
  DiscussPathResolver,
  | 'projectSource'
  | 'discussSourcesPath'
  | 'discussBaseDirForSource'
  | 'discussDiscoveryPathForSource'
  | 'discussSummaryIndexPathForSource'
  | 'discussSessionDirForSource'
  | 'discussStatePath'
  | 'discussEventLogPath'
  | 'jobStatusPath'
> = {
  projectSource: resolveProjectSource,
  discussSourcesPath,
  discussBaseDirForSource,
  discussDiscoveryPathForSource,
  discussSummaryIndexPathForSource,
  discussSessionDirForSource,
  discussStatePath,
  discussEventLogPath,
  jobStatusPath: (jobId) => join(jobsDir(), jobId, 'status.json'),
};

/**
 * Persisted discuss event log entry.
 */
export type DiscussEventLogEntry = DiscussDomainEvent;

/**
 * Reads and parses a persisted job status record.
 */
export function readStatusRecord(jobId: string): PersistedStatusRecord | null {
  return readStatusRecordWithStorage(nodeDiscussReaderStorage, nodeDiscussReaderPaths, jobId);
}

/**
 * Reads and parses all persisted progress records for a job.
 */
export function readProgressLog(jobId: string): PersistedProgressRecord[] {
  const log = readTextFile(join(jobsDir(), jobId, 'progress.jsonl'));
  if (log === null) return [];
  return parseJsonLines(
    log,
    (lineValue) => parseWithSchema(persistedProgressRecordSchema, lineValue) as PersistedProgressRecord | null,
  );
}

/**
 * Reads and minimally validates a persisted discuss state file.
 */
export function readDiscussState(statePath: string): DiscussState | null {
  const state = readJsonFile(statePath);
  if (state === null) return null;
  return isValidDiscussState(state) ? state : null;
}

/**
 * Reads and validates a v2 persisted discuss snapshot.
 */
export function readDiscussSnapshot(statePath: string): PersistedDiscussSnapshot | null {
  return readDiscussSnapshotWithStorage(nodeDiscussReaderStorage, statePath);
}

/**
 * Reads and parses a discuss JSONL event log, skipping malformed lines.
 */
export function readDiscussEventLog(logPath: string): DiscussDomainEvent[] {
  return readDiscussEventLogWithStorage(nodeDiscussReaderStorage, logPath);
}

/**
 * Reads and validates the discuss discovery metadata for a project.
 */
export function readDiscussDiscoveryForSource(source: string): DiscussDiscoveryData | null {
  return readDiscussDiscoveryForSourceWithStorage(nodeDiscussReaderStorage, nodeDiscussReaderPaths, source);
}

/**
 * Reads and validates the discuss discovery metadata for a project.
 */
export function readDiscussDiscovery(projectRoot: string): DiscussDiscoveryData | null {
  return readDiscussDiscoveryForSource(resolveProjectSource(projectRoot));
}

/**
 * Reads and validates the discuss summary index for a project.
 */
export function readDiscussSummaryIndexForSource(source: string): DiscussSummaryIndexData | null {
  return readDiscussSummaryIndexForSourceWithStorage(nodeDiscussReaderStorage, nodeDiscussReaderPaths, source);
}

/**
 * Reads and validates the discuss summary index for a project.
 */
export function readDiscussSummaryIndex(projectRoot: string): DiscussSummaryIndexData | null {
  return readDiscussSummaryIndexForSource(resolveProjectSource(projectRoot));
}

export function readDiscussSources(): string[] {
  return readDiscussSourcesWithStorage(nodeDiscussReaderStorage, nodeDiscussReaderPaths);
}

export function readDiscussProjectRoots(): string[] {
  return readDiscussSources();
}

/**
 * Resolves a discuss session directory using discovery first, then directory scan fallback.
 */
export function resolveDiscussSessionDirForSource(source: string, sessionId: string): string | null {
  return resolveDiscussSessionDirForSourceWithStorage(nodeDiscussReaderStorage, nodeDiscussReaderPaths, source, sessionId);
}

/**
 * Resolves a discuss session directory using discovery first, then directory scan fallback.
 */
export function resolveDiscussSessionDir(projectRoot: string, sessionId: string): string | null {
  return resolveDiscussSessionDirForSource(resolveProjectSource(projectRoot), sessionId);
}

/**
 * Lists persisted discuss sessions using discovery first with state-based fallback repair.
 */
export function listPersistedDiscussSessionsForSource(source: string): DiscussDiscoverySession[] {
  return listPersistedDiscussSessionsForSourceWithStorage(nodeDiscussReaderStorage, nodeDiscussReaderPaths, source);
}

/**
 * Lists persisted discuss sessions using discovery first with state-based fallback repair.
 */
export function listPersistedDiscussSessions(projectRoot: string): DiscussDiscoverySession[] {
  return listPersistedDiscussSessionsForSource(resolveProjectSource(projectRoot));
}
