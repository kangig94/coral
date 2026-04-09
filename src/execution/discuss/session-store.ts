import { closeSync, fdatasyncSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  readDiscussSources,
  listPersistedDiscussSessionsForSource,
  readDiscussEventLog,
  readDiscussSnapshot,
  readDiscussSummaryIndexForSource,
  resolveDiscussSessionDirForSource,
  type DiscussDiscoveryData,
  type DiscussDiscoverySession,
  type DiscussSummaryIndexData,
  type DiscussSummaryIndexRow,
} from '../../client/readers.js';
import {
  discussBaseDirForSource,
  discussSourcesPath,
  discussDiscoveryPathForSource,
  discussEventLogPath,
  discussSessionDirForSource,
  discussSummaryIndexPathForSource,
  discussStatePath,
} from '../../infra/paths.js';
import { type DiscussSummaryDto } from '../../discuss/views.js';
import type { DiscussDomainEvent, PersistedDiscussSnapshot } from '../../discuss/events.js';
import { makeEmptySnapshot, reduceDiscussEvent, replayDiscussEvents } from '../../discuss/reducer.js';
import { acquireDirectoryLock, acquireDirectoryLockSync } from '../../shared/fs-lock.js';

const sessionAppendLocks = new Map<string, Promise<void>>();
const projectDiscoveryLocks = new Map<string, Promise<void>>();
const discussSourcesRegistryLocks = new Map<string, Promise<void>>();

type DiscussSessionStoreOptions = {
  onCommit?: (snapshot: PersistedDiscussSnapshot, events: DiscussDomainEvent[]) => void;
};

type PersistedSummaryRepair = {
  index: DiscussSummaryIndexData;
  summaries: DiscussSummaryDto[];
};

export class DiscussStaleWriteError extends Error {
  readonly expectedSeq: number;
  readonly actualSeq: number;

  constructor(expectedSeq: number, actualSeq: number) {
    super(`Discuss session append rejected due to stale expectedSeq: expected ${expectedSeq}, actual ${actualSeq}`);
    this.name = 'DiscussStaleWriteError';
    this.expectedSeq = expectedSeq;
    this.actualSeq = actualSeq;
  }
}

function sessionLockKey(source: string, sessionId: string): string {
  return `${source}\u0000${sessionId}`;
}

function sessionFilesystemLockPath(sessionDir: string): string {
  return join(sessionDir, '.lock');
}

function sourceFilesystemLockPath(source: string): string {
  return join(discussBaseDirForSource(source), '.lock');
}

function discussSourcesRegistryLockPath(): string {
  return `${discussSourcesPath()}.lock`;
}

async function withFilesystemLock<T>(lockDir: string, work: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(lockDir), { recursive: true });
  const release = await acquireDirectoryLock(lockDir);
  try {
    return await work();
  } finally {
    release();
  }
}

function withFilesystemLockSync<T>(lockDir: string, work: () => T): T {
  mkdirSync(dirname(lockDir), { recursive: true });
  const release = acquireDirectoryLockSync(lockDir);
  try {
    return work();
  } finally {
    release();
  }
}

async function withPromiseChainLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  work: () => T | Promise<T>,
): Promise<T> {
  const previous = (locks.get(key) ?? Promise.resolve()).catch(() => undefined);
  let releaseLock!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const current = previous.then(() => gate);
  locks.set(key, current);

  await previous;

  try {
    return await work();
  } finally {
    releaseLock();
    if (locks.get(key) === current) {
      locks.delete(key);
    }
  }
}

function tryWithPromiseChainLockSync<T>(locks: Map<string, Promise<void>>, key: string, work: () => T): T | null {
  if (locks.has(key)) {
    return null;
  }

  let releaseLock!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  locks.set(key, gate);

  try {
    return work();
  } finally {
    releaseLock();
    if (locks.get(key) === gate) {
      locks.delete(key);
    }
  }
}

function writeAllSync(fd: number, content: string): void {
  const buffer = Buffer.from(content, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

function writeAtomicJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  let fd: number;
  try {
    fd = openSync(tmpPath, 'w');
  } catch {
    return; // directory deleted between mkdirSync and openSync
  }
  try {
    writeAllSync(fd, JSON.stringify(value, null, 2));
    fdatasyncSync(fd);
  } catch {
    closeSync(fd);
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best effort */
    }
    return;
  }
  closeSync(fd);
  try {
    renameSync(tmpPath, filePath);
  } catch {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best effort */
    }
  }
}

function appendEventBatch(logPath: string, events: DiscussDomainEvent[]): void {
  if (events.length === 0) {
    return;
  }

  mkdirSync(dirname(logPath), { recursive: true });
  let fd: number;
  try {
    fd = openSync(logPath, 'a');
  } catch {
    return; // directory deleted between mkdirSync and openSync
  }
  try {
    writeAllSync(fd, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
    fdatasyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function validateAppendBatch(sessionId: string, lastAppliedSeq: number, events: DiscussDomainEvent[]): void {
  let expectedSeq = lastAppliedSeq + 1;
  for (const event of events) {
    if (event.sessionId !== sessionId) {
      throw new Error(`Discuss append batch session mismatch: expected ${sessionId}, got ${event.sessionId}`);
    }
    if (event.seq !== expectedSeq) {
      throw new Error(`Discuss append batch sequence mismatch: expected ${expectedSeq}, got ${event.seq}`);
    }
    expectedSeq += 1;
  }
}

function toDiscoverySession(sessionDir: string, snapshot: PersistedDiscussSnapshot): DiscussDiscoverySession {
  return {
    sessionId: snapshot.sessionId,
    topic: snapshot.state.topic,
    sessionDir,
    createdAt: snapshot.state.created_at,
  };
}

function compareSummaryIndexRows(left: DiscussSummaryIndexRow, right: DiscussSummaryIndexRow): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt.localeCompare(right.createdAt);
  }
  return left.sessionId.localeCompare(right.sessionId);
}

function sortSummaryIndexRows(rows: DiscussSummaryIndexRow[]): DiscussSummaryIndexRow[] {
  return [...rows].sort(compareSummaryIndexRows);
}

function buildSummaryIndexData(source: string, rows: DiscussSummaryIndexRow[]): DiscussSummaryIndexData {
  const sessions = sortSummaryIndexRows(rows);
  let updatedAt = '';
  for (const session of sessions) {
    if (session.updatedAt > updatedAt) {
      updatedAt = session.updatedAt;
    }
  }

  return {
    source,
    updatedAt,
    sessions,
  };
}

function summaryIndexDataEquals(left: DiscussSummaryIndexData | null, right: DiscussSummaryIndexData): boolean {
  if (!left) {
    return false;
  }
  if (
    left.source !== right.source ||
    left.updatedAt !== right.updatedAt ||
    left.sessions.length !== right.sessions.length
  ) {
    return false;
  }

  return left.sessions.every((session, index) => {
    const expected = right.sessions[index];
    return (
      session.sessionId === expected.sessionId &&
      session.projectRoot === expected.projectRoot &&
      session.topic === expected.topic &&
      session.status === expected.status &&
      session.createdAt === expected.createdAt &&
      session.agentCount === expected.agentCount &&
      session.updatedAt === expected.updatedAt &&
      session.lastSeq === expected.lastSeq
    );
  });
}

function toSummaryIndexRow(snapshot: PersistedDiscussSnapshot): DiscussSummaryIndexRow {
  return {
    sessionId: snapshot.sessionId,
    projectRoot: snapshot.projectRoot,
    topic: snapshot.state.topic,
    status: snapshot.state.status,
    createdAt: snapshot.state.created_at,
    agentCount: Object.keys(snapshot.state.agents).length,
    updatedAt: snapshot.updatedAt,
    lastSeq: snapshot.lastAppliedSeq,
  };
}

function buildPersistedSummary(row: DiscussSummaryIndexRow): DiscussSummaryDto {
  return {
    sessionId: row.sessionId,
    projectRoot: row.projectRoot,
    topic: row.topic,
    status: row.status,
    createdAt: row.createdAt,
    agentCount: row.agentCount,
    authority: 'persisted',
  };
}

export class DiscussSessionStore {
  private readonly source: string;
  private readonly onCommit?: DiscussSessionStoreOptions['onCommit'];
  private coldStartHydrated = false;
  private dirtyDiscovery = false;
  private dirtySummaryIndex = false;
  private dirtySources = false;
  private pendingSnapshots = new Map<string, { sessionDir: string; snapshot: PersistedDiscussSnapshot }>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(source: string, options: DiscussSessionStoreOptions = {}) {
    this.source = source;
    this.onCommit = options.onCommit;
  }

  load(sessionId: string): PersistedDiscussSnapshot | null {
    const sessionDir = resolveDiscussSessionDirForSource(this.source, sessionId);
    if (!sessionDir) {
      return null;
    }
    return this.loadFromSessionDir(sessionId, sessionDir);
  }

  async append(
    sessionId: string,
    expectedSeq: number | null,
    events: DiscussDomainEvent[],
  ): Promise<PersistedDiscussSnapshot> {
    const sessionDir = discussSessionDirForSource(this.source, sessionId);
    mkdirSync(sessionDir, { recursive: true });

    return withPromiseChainLock(sessionAppendLocks, sessionLockKey(this.source, sessionId), () =>
      withFilesystemLock(sessionFilesystemLockPath(sessionDir), async () => {
        const logPath = discussEventLogPath(sessionDir);
        const statePath = discussStatePath(sessionDir);

        const currentSnapshot =
          this.loadFromSessionDir(sessionId, sessionDir) ?? makeEmptySnapshot(sessionId, events[0]?.projectRoot ?? '');

        if (expectedSeq !== null && expectedSeq !== currentSnapshot.lastAppliedSeq) {
          throw new DiscussStaleWriteError(expectedSeq, currentSnapshot.lastAppliedSeq);
        }

        if (events.length === 0) {
          return currentSnapshot;
        }

        validateAppendBatch(sessionId, currentSnapshot.lastAppliedSeq, events);

        appendEventBatch(logPath, events);
        const logByteOffset = statSync(logPath).size;

        const nextSnapshot = events.reduce((snapshot, event) => reduceDiscussEvent(snapshot, event), currentSnapshot);
        nextSnapshot.logByteOffset = logByteOffset;

        writeAtomicJson(statePath, nextSnapshot);

        this.pendingSnapshots.set(sessionId, { sessionDir, snapshot: nextSnapshot });
        this.markIndexesDirty();

        this.onCommit?.(nextSnapshot, events);
        return nextSnapshot;
      }),
    );
  }

  listSummaries(): DiscussSummaryDto[] {
    this.flushDirtyIndexes();
    const repair = this.buildPersistedSummaryRepair();
    if (this.persistPersistedSummaryRepair(repair)) {
      this.coldStartHydrated = true;
    }
    return repair.summaries;
  }

  listSummariesFromIndex(): DiscussSummaryDto[] {
    this.flushDirtyIndexes();
    const currentIndex = readDiscussSummaryIndexForSource(this.source);
    if (this.coldStartHydrated && currentIndex) {
      return this.buildSummariesFromIndex(currentIndex);
    }

    if (this.coldStartHydrated && currentIndex === null) {
      this.coldStartHydrated = false;
    }

    const repair = this.buildPersistedSummaryRepair();
    if (!this.persistPersistedSummaryRepair(repair)) {
      return repair.summaries;
    }

    this.coldStartHydrated = true;
    const hydratedIndex = readDiscussSummaryIndexForSource(this.source);
    if (!hydratedIndex) {
      return repair.summaries;
    }
    return this.buildSummariesFromIndex(hydratedIndex);
  }

  listRecoveryCandidates(): DiscussDiscoverySession[] {
    this.flushDirtyIndexes();
    return listPersistedDiscussSessionsForSource(this.source);
  }

  resolveSessionDir(sessionId: string): string {
    const sessionDir = resolveDiscussSessionDirForSource(this.source, sessionId);
    if (!sessionDir) {
      throw new Error(`Discuss session not found: ${sessionId}`);
    }
    return sessionDir;
  }

  flushDirtyIndexes(): void {
    if (!this.dirtyDiscovery && !this.dirtySummaryIndex && !this.dirtySources) {
      return;
    }

    tryWithPromiseChainLockSync(projectDiscoveryLocks, this.source, () => {
      const flushedKeys = this.flushDiscoveryAndSummaryIndex();
      this.flushSourcesRegistry();

      for (const key of flushedKeys) {
        this.pendingSnapshots.delete(key);
      }
    });
  }

  private flushDiscoveryAndSummaryIndex(): string[] {
    if (!this.dirtyDiscovery && !this.dirtySummaryIndex) {
      return [];
    }

    const flushedKeys: string[] = [];
    withFilesystemLockSync(sourceFilesystemLockPath(this.source), () => {
      const mergedSessions = new Map<string, DiscussDiscoverySession>();
      for (const session of listPersistedDiscussSessionsForSource(this.source)) {
        mergedSessions.set(session.sessionId, session);
      }

      const mergedSummaryRows = new Map<string, DiscussSummaryIndexRow>();
      for (const summary of readDiscussSummaryIndexForSource(this.source)?.sessions ?? []) {
        mergedSummaryRows.set(summary.sessionId, summary);
      }

      let latestUpdatedAt = '';
      for (const [sessionId, { sessionDir, snapshot }] of this.pendingSnapshots) {
        mergedSessions.set(sessionId, toDiscoverySession(sessionDir, snapshot));
        mergedSummaryRows.set(sessionId, toSummaryIndexRow(snapshot));
        if (snapshot.updatedAt > latestUpdatedAt) {
          latestUpdatedAt = snapshot.updatedAt;
        }
        flushedKeys.push(sessionId);
      }

      if (this.dirtyDiscovery) {
        const discovery: DiscussDiscoveryData = {
          source: this.source,
          updatedAt: latestUpdatedAt,
          sessions: [...mergedSessions.values()].sort((left, right) => {
            if (left.createdAt !== right.createdAt) {
              return left.createdAt.localeCompare(right.createdAt);
            }
            return left.sessionId.localeCompare(right.sessionId);
          }),
        };
        writeAtomicJson(discussDiscoveryPathForSource(this.source), discovery);
        this.dirtyDiscovery = false;
      }

      if (this.dirtySummaryIndex) {
        writeAtomicJson(
          discussSummaryIndexPathForSource(this.source),
          buildSummaryIndexData(this.source, [...mergedSummaryRows.values()]),
        );
        this.dirtySummaryIndex = false;
      }
    });
    return flushedKeys;
  }

  private flushSourcesRegistry(): void {
    if (!this.dirtySources) {
      return;
    }

    const latestSnapshot = [...this.pendingSnapshots.values()].reduce(
      (latest, { snapshot }) => (snapshot.updatedAt > latest.updatedAt ? snapshot : latest),
      { updatedAt: '' } as { updatedAt: string },
    );
    const wroteSources = tryWithPromiseChainLockSync(discussSourcesRegistryLocks, discussSourcesPath(), () => {
      return withFilesystemLockSync(discussSourcesRegistryLockPath(), () => {
        const sources = new Set(readDiscussSources());
        sources.add(this.source);
        writeAtomicJson(discussSourcesPath(), {
          updatedAt: latestSnapshot.updatedAt,
          sources: [...sources].sort(),
        });
        return true;
      });
    });
    if (wroteSources !== null) {
      this.dirtySources = false;
    }
  }

  dispose(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushDirtyIndexes();
  }

  private markIndexesDirty(): void {
    this.dirtyDiscovery = true;
    this.dirtySummaryIndex = true;
    this.dirtySources = true;
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushDirtyIndexes();
      }, 500);
      this.flushTimer.unref?.();
    }
  }

  private loadFromSessionDir(sessionId: string, sessionDir: string): PersistedDiscussSnapshot | null {
    const statePath = discussStatePath(sessionDir);
    const logPath = discussEventLogPath(sessionDir);
    const snapshot = this.readSessionSnapshot(sessionId, statePath);

    // Skip log read if snapshot records the log size and the log hasn't grown
    if (snapshot?.logByteOffset !== undefined) {
      try {
        if (statSync(logPath).size === snapshot.logByteOffset) {
          return snapshot;
        }
      } catch {
        // ENOENT or other stat error — fall through to full log read
      }
    }

    // Fallback: read log and replay (crash recovery, legacy snapshots without logByteOffset, stat failure)
    const eventLog = readDiscussEventLog(logPath).filter((event) => event.sessionId === sessionId);

    if (snapshot) {
      const tailEvents = eventLog.filter((event) => event.seq > snapshot.lastAppliedSeq);
      if (tailEvents.length === 0) {
        return snapshot;
      }
      return replayDiscussEvents(tailEvents, snapshot);
    }

    if (eventLog.length === 0) {
      return null;
    }

    return replayDiscussEvents(eventLog, makeEmptySnapshot(sessionId, eventLog[0]?.projectRoot ?? ''));
  }

  private readSessionSnapshot(sessionId: string, statePath: string): PersistedDiscussSnapshot | null {
    const snapshot = readDiscussSnapshot(statePath);
    if (!snapshot) {
      return null;
    }
    if (snapshot.sessionId !== sessionId) {
      return null;
    }
    return snapshot;
  }

  private buildPersistedSummaryRepair(): PersistedSummaryRepair {
    const rows: DiscussSummaryIndexRow[] = [];
    for (const session of this.listRecoveryCandidates()) {
      const snapshot = this.loadFromSessionDir(session.sessionId, session.sessionDir);
      if (!snapshot) {
        continue;
      }
      rows.push(toSummaryIndexRow(snapshot));
    }

    const index = buildSummaryIndexData(this.source, rows);
    return {
      index,
      summaries: this.buildSummariesFromIndex(index),
    };
  }

  private buildSummariesFromIndex(index: DiscussSummaryIndexData): DiscussSummaryDto[] {
    return index.sessions
      .map(buildPersistedSummary)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private persistPersistedSummaryRepair(repair: PersistedSummaryRepair): boolean {
    const currentIndex = readDiscussSummaryIndexForSource(this.source);
    if (!summaryIndexDataEquals(currentIndex, repair.index)) {
      const wroteSummaryIndex = tryWithPromiseChainLockSync(projectDiscoveryLocks, this.source, () => {
        return withFilesystemLockSync(sourceFilesystemLockPath(this.source), () => {
          const latestIndex = readDiscussSummaryIndexForSource(this.source);
          if (summaryIndexDataEquals(latestIndex, repair.index)) {
            return true;
          }
          writeAtomicJson(discussSummaryIndexPathForSource(this.source), repair.index);
          return true;
        });
      });
      if (wroteSummaryIndex === null) {
        return false;
      }
    }

    if (repair.index.sessions.length === 0 || readDiscussSources().includes(this.source)) {
      return true;
    }

    const updatedRegistry = tryWithPromiseChainLockSync(discussSourcesRegistryLocks, discussSourcesPath(), () => {
      return withFilesystemLockSync(discussSourcesRegistryLockPath(), () => {
        const sources = new Set(readDiscussSources());
        if (sources.has(this.source)) {
          return true;
        }
        sources.add(this.source);
        writeAtomicJson(discussSourcesPath(), {
          updatedAt: repair.index.updatedAt,
          sources: [...sources].sort(),
        });
        return true;
      });
    });

    return updatedRegistry !== null;
  }
}
