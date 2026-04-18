import { join } from 'node:path';
import type { DiscussDomainEvent, PersistedDiscussSnapshot } from '../discuss/events.js';
import type {
  DiscussDiscoveryData,
  DiscussDiscoverySession,
  DiscussSummaryIndexData,
} from './persistence-types.js';
import {
  isValidDiscussDomainEvent,
  isValidPersistedDiscussSnapshot,
  parseDiscussDiscoveryData,
  parseDiscussSourcesRegistry,
  parseDiscussSummaryIndexData,
  parseWithSchema,
  persistedStatusRecordSchema,
} from './persistence-parsers.js';
import type { DiscussPathResolver, RuntimeDirentLike, StoragePort } from '../runtime/ports.js';
import type { JobStatusRecord } from './types.js';
import { isNoEntryError } from './utils.js';

export function parseJsonLines<T>(text: string, parseLine: (value: unknown) => T | null): T[] {
  const entries: T[] = [];
  for (const rawLine of text.split('\n')) {
    if (rawLine.trim().length === 0) continue;
    try {
      const value = parseLine(JSON.parse(rawLine));
      if (value !== null) entries.push(value);
    } catch (error: unknown) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  return entries;
}

export function readJsonFileWithStorage(storage: Pick<StoragePort, 'readFileSync'>, filePath: string): unknown | null {
  try {
    return JSON.parse(storage.readFileSync(filePath, 'utf-8')) as unknown;
  } catch (error: unknown) {
    if (isNoEntryError(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function readTextFileWithStorage(storage: Pick<StoragePort, 'readFileSync'>, filePath: string): string | null {
  try {
    return storage.readFileSync(filePath, 'utf-8');
  } catch (error: unknown) {
    if (isNoEntryError(error)) return null;
    throw error;
  }
}

export function readDirectoryEntriesWithStorage(
  storage: Pick<StoragePort, 'readdirSync'>,
  baseDir: string,
): RuntimeDirentLike[] {
  try {
    return storage.readdirSync(baseDir, { withFileTypes: true });
  } catch (error: unknown) {
    if (isNoEntryError(error)) return [];
    throw error;
  }
}

export function readStatusRecordWithStorage(
  storage: Pick<StoragePort, 'readFileSync'>,
  paths: Pick<DiscussPathResolver, 'jobStatusPath'>,
  jobId: string,
): JobStatusRecord | null {
  const record = readJsonFileWithStorage(storage, paths.jobStatusPath(jobId));
  if (record === null) return null;
  return parseWithSchema(persistedStatusRecordSchema, record) as JobStatusRecord | null;
}

export function readDiscussSnapshotWithStorage(
  storage: Pick<StoragePort, 'readFileSync'>,
  statePath: string,
): PersistedDiscussSnapshot | null {
  const snapshot = readJsonFileWithStorage(storage, statePath);
  if (snapshot === null) return null;
  return isValidPersistedDiscussSnapshot(snapshot) ? snapshot : null;
}

export function readDiscussEventLogWithStorage(
  storage: Pick<StoragePort, 'readFileSync'>,
  logPath: string,
): DiscussDomainEvent[] {
  const log = readTextFileWithStorage(storage, logPath);
  if (log === null) return [];
  return parseJsonLines(log, (lineValue) => (isValidDiscussDomainEvent(lineValue) ? lineValue : null));
}

export function readDiscussDiscoveryForSourceWithStorage(
  storage: Pick<StoragePort, 'readFileSync'>,
  paths: Pick<DiscussPathResolver, 'discussDiscoveryPathForSource'>,
  source: string,
): DiscussDiscoveryData | null {
  const discovery = readJsonFileWithStorage(storage, paths.discussDiscoveryPathForSource(source));
  if (discovery === null) return null;
  return parseDiscussDiscoveryData(discovery, source);
}

export function readDiscussSummaryIndexForSourceWithStorage(
  storage: Pick<StoragePort, 'readFileSync'>,
  paths: Pick<DiscussPathResolver, 'discussSummaryIndexPathForSource'>,
  source: string,
): DiscussSummaryIndexData | null {
  const index = readJsonFileWithStorage(storage, paths.discussSummaryIndexPathForSource(source));
  if (index === null) return null;
  return parseDiscussSummaryIndexData(index, source);
}

export function readDiscussSourcesWithStorage(
  storage: Pick<StoragePort, 'readFileSync'>,
  paths: Pick<DiscussPathResolver, 'discussSourcesPath' | 'projectSource'>,
): string[] {
  return parseDiscussSourcesRegistry(
    readJsonFileWithStorage(storage, paths.discussSourcesPath()),
    paths.projectSource,
  )?.sources ?? [];
}

export function canUseDiscussSessionDirWithStorage(
  storage: Pick<StoragePort, 'existsSync'>,
  paths: Pick<DiscussPathResolver, 'discussStatePath' | 'discussEventLogPath'>,
  sessionDir: string,
): boolean {
  return storage.existsSync(paths.discussStatePath(sessionDir)) || storage.existsSync(paths.discussEventLogPath(sessionDir));
}

export function scanPersistedDiscussSessionsForSourceWithStorage(
  storage: Pick<StoragePort, 'readFileSync' | 'readdirSync'>,
  paths: Pick<DiscussPathResolver, 'discussBaseDirForSource' | 'discussStatePath'>,
  source: string,
): DiscussDiscoverySession[] {
  const baseDir = paths.discussBaseDirForSource(source);
  const entries = readDirectoryEntriesWithStorage(storage, baseDir);

  const sessions: DiscussDiscoverySession[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionDir = join(baseDir, entry.name);
    const snapshot = readDiscussSnapshotWithStorage(storage, paths.discussStatePath(sessionDir));
    if (!snapshot) continue;
    sessions.push({
      sessionId: snapshot.sessionId,
      topic: snapshot.state.topic,
      sessionDir,
      createdAt: snapshot.state.created_at,
    });
  }

  return sessions;
}

export function resolveDiscussSessionDirForSourceWithStorage(
  storage: Pick<StoragePort, 'readFileSync' | 'readdirSync' | 'existsSync'>,
  paths: Pick<
    DiscussPathResolver,
    'discussDiscoveryPathForSource' | 'discussBaseDirForSource' | 'discussStatePath' | 'discussEventLogPath'
  >,
  source: string,
  sessionId: string,
): string | null {
  const discovery = readDiscussDiscoveryForSourceWithStorage(storage, paths, source);
  const discoveredDir = discovery?.sessions.find((session) => session.sessionId === sessionId)?.sessionDir;
  if (discoveredDir && canUseDiscussSessionDirWithStorage(storage, paths, discoveredDir)) {
    return discoveredDir;
  }

  const baseDir = paths.discussBaseDirForSource(source);
  const entries = readDirectoryEntriesWithStorage(storage, baseDir);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionDir = join(baseDir, entry.name);
    if (entry.name === sessionId && canUseDiscussSessionDirWithStorage(storage, paths, sessionDir)) {
      return sessionDir;
    }
    const snapshot = readDiscussSnapshotWithStorage(storage, paths.discussStatePath(sessionDir));
    if (snapshot?.sessionId === sessionId) {
      return sessionDir;
    }
  }

  return null;
}

export function listPersistedDiscussSessionsForSourceWithStorage(
  storage: Pick<StoragePort, 'readFileSync' | 'readdirSync' | 'existsSync'>,
  paths: Pick<
    DiscussPathResolver,
    'discussDiscoveryPathForSource' | 'discussBaseDirForSource' | 'discussStatePath' | 'discussEventLogPath'
  >,
  source: string,
): DiscussDiscoverySession[] {
  const discovered = readDiscussDiscoveryForSourceWithStorage(storage, paths, source);
  const scanned = scanPersistedDiscussSessionsForSourceWithStorage(storage, paths, source);
  if (!discovered) {
    return scanned;
  }

  const usableDiscovered: DiscussDiscoverySession[] = [];
  let stale = false;
  for (const session of discovered.sessions) {
    if (!canUseDiscussSessionDirWithStorage(storage, paths, session.sessionDir)) {
      stale = true;
      continue;
    }
    usableDiscovered.push(session);
  }

  const discoveredIds = new Set(usableDiscovered.map((session) => session.sessionId));
  if (scanned.some((session) => !discoveredIds.has(session.sessionId))) {
    stale = true;
  }

  if (!stale) {
    return usableDiscovered;
  }

  const merged = new Map<string, DiscussDiscoverySession>();
  for (const session of usableDiscovered) {
    merged.set(session.sessionId, session);
  }
  for (const session of scanned) {
    if (!merged.has(session.sessionId)) {
      merged.set(session.sessionId, session);
    }
  }
  return [...merged.values()];
}
