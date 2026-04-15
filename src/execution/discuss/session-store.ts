import { dirname, join } from 'node:path';
import {
  readDiscussSourcesWithStorage,
  listPersistedDiscussSessionsForSourceWithStorage,
  readDiscussEventLogWithStorage,
  readDiscussSnapshotWithStorage,
  readDiscussSummaryIndexForSourceWithStorage,
  resolveDiscussSessionDirForSourceWithStorage,
  type DiscussDiscoveryData,
  type DiscussDiscoverySession,
  type DiscussSummaryIndexData,
  type DiscussSummaryIndexRow,
} from '../../client/readers.js';
import { type DiscussSummaryDto } from '../../discuss/views.js';
import type { DiscussDomainEvent, PersistedDiscussSnapshot } from '../../discuss/events.js';
import { makeEmptySnapshot, reduceDiscussEvent, replayDiscussEvents } from '../../discuss/reducer.js';
import { acquireDirectoryLock, acquireDirectoryLockSync, type DirectoryLockDeps } from '../../shared/fs-lock.js';
import type { DiscussPathResolver, RuntimeStorage, RuntimeTime, RuntimeTimerHandle } from '../runtime.js';

const sessionAppendLocks = new Map<string, Promise<void>>();
const projectDiscoveryLocks = new Map<string, Promise<void>>();
const discussSourcesRegistryLocks = new Map<string, Promise<void>>();

type DiscussSessionStoreOptions = {
  storage: RuntimeStorage;
  time: Pick<RuntimeTime, 'now' | 'sleep' | 'setTimeout' | 'clearTimeout'>;
  paths: DiscussPathResolver;
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

async function withFilesystemLock<T>(
  lockDir: string,
  deps: DirectoryLockDeps,
  work: () => Promise<T>,
): Promise<T> {
  deps.storage.mkdirSync(dirname(lockDir), { recursive: true });
  const release = await acquireDirectoryLock(lockDir, deps);
  try {
    return await work();
  } finally {
    release();
  }
}

function withFilesystemLockSync<T>(lockDir: string, deps: DirectoryLockDeps, work: () => T): T {
  deps.storage.mkdirSync(dirname(lockDir), { recursive: true });
  const release = acquireDirectoryLockSync(lockDir, deps);
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
  private readonly storage: RuntimeStorage;
  private readonly time: Pick<RuntimeTime, 'now' | 'sleep' | 'setTimeout' | 'clearTimeout'>;
  private readonly paths: DiscussPathResolver;
  private readonly lockDeps: DirectoryLockDeps;
  private readonly onCommit?: DiscussSessionStoreOptions['onCommit'];
  private coldStartHydrated = false;
  private dirtyDiscovery = false;
  private dirtySummaryIndex = false;
  private dirtySources = false;
  private pendingSnapshots = new Map<string, { sessionDir: string; snapshot: PersistedDiscussSnapshot }>();
  private flushTimer: RuntimeTimerHandle | null = null;

  constructor(source: string, options: DiscussSessionStoreOptions) {
    this.source = source;
    this.storage = options.storage;
    this.time = options.time;
    this.paths = options.paths;
    this.lockDeps = {
      storage: this.storage,
      time: this.time,
    };
    this.onCommit = options.onCommit;
  }

  private sessionFilesystemLockPath(sessionDir: string): string {
    return join(sessionDir, '.lock');
  }

  private sourceFilesystemLockPath(): string {
    return this.paths.discussDiscoveryLockPathForSource(this.source);
  }

  private readSources(): string[] {
    return readDiscussSourcesWithStorage(this.storage, this.paths);
  }

  private readSummaryIndex(): DiscussSummaryIndexData | null {
    return readDiscussSummaryIndexForSourceWithStorage(this.storage, this.paths, this.source);
  }

  private listPersistedSessions(): DiscussDiscoverySession[] {
    return listPersistedDiscussSessionsForSourceWithStorage(this.storage, this.paths, this.source);
  }

  private writeAtomicJson(filePath: string, value: unknown): void {
    this.storage.mkdirSync(dirname(filePath), { recursive: true });
    if (!this.storage.writeAtomicDurableSync(filePath, JSON.stringify(value, null, 2))) {
      return;
    }
  }

  private appendEventBatch(logPath: string, events: DiscussDomainEvent[]): void {
    if (events.length === 0) {
      return;
    }
    this.storage.mkdirSync(dirname(logPath), { recursive: true });
    if (!this.storage.appendFileDurableSync(logPath, events.map((event) => JSON.stringify(event)).join('\n') + '\n')) {
      return;
    }
  }

  load(sessionId: string): PersistedDiscussSnapshot | null {
    const sessionDir = resolveDiscussSessionDirForSourceWithStorage(this.storage, this.paths, this.source, sessionId);
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
    const sessionDir = this.paths.discussSessionDirForSource(this.source, sessionId);
    this.storage.mkdirSync(sessionDir, { recursive: true });

    return withPromiseChainLock(sessionAppendLocks, sessionLockKey(this.source, sessionId), () =>
      withFilesystemLock(this.sessionFilesystemLockPath(sessionDir), this.lockDeps, async () => {
        const logPath = this.paths.discussEventLogPath(sessionDir);
        const statePath = this.paths.discussStatePath(sessionDir);

        const currentSnapshot =
          this.loadFromSessionDir(sessionId, sessionDir) ?? makeEmptySnapshot(sessionId, events[0]?.projectRoot ?? '');

        if (expectedSeq !== null && expectedSeq !== currentSnapshot.lastAppliedSeq) {
          throw new DiscussStaleWriteError(expectedSeq, currentSnapshot.lastAppliedSeq);
        }

        if (events.length === 0) {
          return currentSnapshot;
        }

        validateAppendBatch(sessionId, currentSnapshot.lastAppliedSeq, events);

        this.appendEventBatch(logPath, events);
        const logByteOffset = this.storage.statSync(logPath).size;

        const nextSnapshot = events.reduce((snapshot, event) => reduceDiscussEvent(snapshot, event), currentSnapshot);
        nextSnapshot.logByteOffset = logByteOffset;

        this.writeAtomicJson(statePath, nextSnapshot);

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
    const currentIndex = this.readSummaryIndex();
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
    const hydratedIndex = this.readSummaryIndex();
    if (!hydratedIndex) {
      return repair.summaries;
    }
    return this.buildSummariesFromIndex(hydratedIndex);
  }

  listRecoveryCandidates(): DiscussDiscoverySession[] {
    this.flushDirtyIndexes();
    return this.listPersistedSessions();
  }

  resolveSessionDir(sessionId: string): string {
    const sessionDir = resolveDiscussSessionDirForSourceWithStorage(this.storage, this.paths, this.source, sessionId);
    if (!sessionDir) {
      throw new Error(`Discuss session not found: ${sessionId}`);
    }
    return sessionDir;
  }

  readSessionEvents(sessionId: string): DiscussDomainEvent[] {
    try {
      const sessionDir = this.resolveSessionDir(sessionId);
      return readDiscussEventLogWithStorage(this.storage, this.paths.discussEventLogPath(sessionDir)).filter(
        (event) => event.sessionId === sessionId,
      );
    } catch {
      return [];
    }
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
    withFilesystemLockSync(this.sourceFilesystemLockPath(), this.lockDeps, () => {
      const mergedSessions = new Map<string, DiscussDiscoverySession>();
      for (const session of this.listPersistedSessions()) {
        mergedSessions.set(session.sessionId, session);
      }

      const mergedSummaryRows = new Map<string, DiscussSummaryIndexRow>();
      for (const summary of this.readSummaryIndex()?.sessions ?? []) {
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
        this.writeAtomicJson(this.paths.discussDiscoveryPathForSource(this.source), discovery);
        this.dirtyDiscovery = false;
      }

      if (this.dirtySummaryIndex) {
        this.writeAtomicJson(
          this.paths.discussSummaryIndexPathForSource(this.source),
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
    const wroteSources = tryWithPromiseChainLockSync(discussSourcesRegistryLocks, this.paths.discussSourcesPath(), () => {
      return withFilesystemLockSync(this.paths.discussSourcesLockPath(), this.lockDeps, () => {
        const sources = new Set(this.readSources());
        sources.add(this.source);
        this.writeAtomicJson(this.paths.discussSourcesPath(), {
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
      this.time.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushDirtyIndexes();
  }

  private markIndexesDirty(): void {
    this.dirtyDiscovery = true;
    this.dirtySummaryIndex = true;
    this.dirtySources = true;
    if (this.flushTimer === null) {
      this.flushTimer = this.time.setTimeout(() => {
        this.flushTimer = null;
        this.flushDirtyIndexes();
      }, 500);
      this.flushTimer.unref?.();
    }
  }

  private loadFromSessionDir(sessionId: string, sessionDir: string): PersistedDiscussSnapshot | null {
    const statePath = this.paths.discussStatePath(sessionDir);
    const logPath = this.paths.discussEventLogPath(sessionDir);
    const snapshot = this.readSessionSnapshot(sessionId, statePath);

    // Skip log read if snapshot records the log size and the log hasn't grown
    if (snapshot?.logByteOffset !== undefined) {
      try {
        if (this.storage.statSync(logPath).size === snapshot.logByteOffset) {
          return snapshot;
        }
      } catch {
        // ENOENT or other stat error — fall through to full log read
      }
    }

    // Fallback: read log and replay (crash recovery, legacy snapshots without logByteOffset, stat failure)
    const eventLog = readDiscussEventLogWithStorage(this.storage, logPath).filter((event) => event.sessionId === sessionId);

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
    const snapshot = readDiscussSnapshotWithStorage(this.storage, statePath);
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
    const currentIndex = this.readSummaryIndex();
    if (!summaryIndexDataEquals(currentIndex, repair.index)) {
      const wroteSummaryIndex = tryWithPromiseChainLockSync(projectDiscoveryLocks, this.source, () => {
        return withFilesystemLockSync(this.sourceFilesystemLockPath(), this.lockDeps, () => {
          const latestIndex = this.readSummaryIndex();
          if (summaryIndexDataEquals(latestIndex, repair.index)) {
            return true;
          }
          this.writeAtomicJson(this.paths.discussSummaryIndexPathForSource(this.source), repair.index);
          return true;
        });
      });
      if (wroteSummaryIndex === null) {
        return false;
      }
    }

    if (repair.index.sessions.length === 0 || this.readSources().includes(this.source)) {
      return true;
    }

    const updatedRegistry = tryWithPromiseChainLockSync(discussSourcesRegistryLocks, this.paths.discussSourcesPath(), () => {
      return withFilesystemLockSync(this.paths.discussSourcesLockPath(), this.lockDeps, () => {
        const sources = new Set(this.readSources());
        if (sources.has(this.source)) {
          return true;
        }
        sources.add(this.source);
        this.writeAtomicJson(this.paths.discussSourcesPath(), {
          updatedAt: repair.index.updatedAt,
          sources: [...sources].sort(),
        });
        return true;
      });
    });

    return updatedRegistry !== null;
  }
}
