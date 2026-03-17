import {
  closeSync,
  fdatasyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  readDiscussProjectRoots,
  listPersistedDiscussSessions,
  readDiscussEventLog,
  readDiscussSnapshot,
  readDiscussSummaryIndex,
  resolveDiscussSessionDir,
  type DiscussDiscoveryData,
  type DiscussDiscoverySession,
  type DiscussSummaryIndexData,
  type DiscussSummaryIndexRow,
} from '../client/readers.js';
import {
  discussProjectRootsPath,
  discussDiscoveryPath,
  discussEventLogPath,
  discussSessionDir,
  discussSummaryIndexPath,
  discussStatePath,
} from '../client/paths.js';
import { type DiscussSummaryDto } from '../client/discuss.js';
import type { DiscussDomainEvent, PersistedDiscussSnapshot } from '../discuss/events.js';
import {
  makeEmptySnapshot,
  reduceDiscussEvent,
  replayDiscussEvents,
} from '../discuss/reducer.js';

const sessionAppendLocks = new Map<string, Promise<void>>();
const projectDiscoveryLocks = new Map<string, Promise<void>>();
const discussProjectRootRegistryLocks = new Map<string, Promise<void>>();

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

function sessionLockKey(projectRoot: string, sessionId: string): string {
  return `${projectRoot}\u0000${sessionId}`;
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

function tryWithPromiseChainLockSync<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  work: () => T,
): T | null {
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
  const fd = openSync(tmpPath, 'w');
  try {
    writeAllSync(fd, JSON.stringify(value, null, 2));
    fdatasyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, filePath);
}

function appendEventBatch(logPath: string, events: DiscussDomainEvent[]): void {
  if (events.length === 0) {
    return;
  }

  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'a');
  try {
    writeAllSync(fd, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
    fdatasyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function validateAppendBatch(
  sessionId: string,
  projectRoot: string,
  lastAppliedSeq: number,
  events: DiscussDomainEvent[],
): void {
  let expectedSeq = lastAppliedSeq + 1;
  for (const event of events) {
    if (event.sessionId !== sessionId) {
      throw new Error(`Discuss append batch session mismatch: expected ${sessionId}, got ${event.sessionId}`);
    }
    if (event.projectRoot !== projectRoot) {
      throw new Error(`Discuss append batch project mismatch: expected ${projectRoot}, got ${event.projectRoot}`);
    }
    if (event.seq !== expectedSeq) {
      throw new Error(`Discuss append batch sequence mismatch: expected ${expectedSeq}, got ${event.seq}`);
    }
    expectedSeq += 1;
  }
}

function toDiscoverySession(
  sessionDir: string,
  snapshot: PersistedDiscussSnapshot,
): DiscussDiscoverySession {
  return {
    sessionId: snapshot.sessionId,
    topic: snapshot.state.topic,
    sessionDir,
    createdAt: snapshot.state.created_at,
  };
}

function compareSummaryIndexRows(
  left: DiscussSummaryIndexRow,
  right: DiscussSummaryIndexRow,
): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt.localeCompare(right.createdAt);
  }
  return left.sessionId.localeCompare(right.sessionId);
}

function sortSummaryIndexRows(rows: DiscussSummaryIndexRow[]): DiscussSummaryIndexRow[] {
  return [...rows].sort(compareSummaryIndexRows);
}

function buildSummaryIndexData(
  projectRoot: string,
  rows: DiscussSummaryIndexRow[],
): DiscussSummaryIndexData {
  const sessions = sortSummaryIndexRows(rows);
  const updatedAt = sessions.reduce(
    (latest, session) => (session.updatedAt > latest ? session.updatedAt : latest),
    '',
  );

  return {
    projectRoot,
    updatedAt,
    sessions,
  };
}

function summaryIndexDataEquals(
  left: DiscussSummaryIndexData | null,
  right: DiscussSummaryIndexData,
): boolean {
  if (!left) {
    return false;
  }
  if (left.projectRoot !== right.projectRoot
    || left.updatedAt !== right.updatedAt
    || left.sessions.length !== right.sessions.length) {
    return false;
  }

  return left.sessions.every((session, index) => {
    const expected = right.sessions[index];
    return session.sessionId === expected.sessionId
      && session.projectRoot === expected.projectRoot
      && session.topic === expected.topic
      && session.status === expected.status
      && session.createdAt === expected.createdAt
      && session.agentCount === expected.agentCount
      && session.updatedAt === expected.updatedAt
      && session.lastSeq === expected.lastSeq;
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
  private readonly projectRoot: string;
  private readonly onCommit?: DiscussSessionStoreOptions['onCommit'];
  private coldStartHydrated = false;
  private dirtyDiscovery = false;
  private dirtySummaryIndex = false;
  private dirtyProjectRoots = false;
  private pendingSnapshots = new Map<string, { sessionDir: string; snapshot: PersistedDiscussSnapshot }>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(projectRoot: string, options: DiscussSessionStoreOptions = {}) {
    this.projectRoot = projectRoot;
    this.onCommit = options.onCommit;
  }

  load(sessionId: string): PersistedDiscussSnapshot | null {
    const sessionDir = resolveDiscussSessionDir(this.projectRoot, sessionId);
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
    return withPromiseChainLock(
      sessionAppendLocks,
      sessionLockKey(this.projectRoot, sessionId),
      async () => {
        const sessionDir = discussSessionDir(this.projectRoot, sessionId);
        const logPath = discussEventLogPath(sessionDir);
        const statePath = discussStatePath(sessionDir);

        mkdirSync(sessionDir, { recursive: true });

        const currentSnapshot = this.loadFromSessionDir(sessionId, sessionDir)
          ?? makeEmptySnapshot(sessionId, this.projectRoot);

        if (expectedSeq !== null && expectedSeq !== currentSnapshot.lastAppliedSeq) {
          throw new DiscussStaleWriteError(expectedSeq, currentSnapshot.lastAppliedSeq);
        }

        if (events.length === 0) {
          return currentSnapshot;
        }

        validateAppendBatch(sessionId, this.projectRoot, currentSnapshot.lastAppliedSeq, events);

        appendEventBatch(logPath, events);
        const logByteOffset = statSync(logPath).size;

        const nextSnapshot = events.reduce(
          (snapshot, event) => reduceDiscussEvent(snapshot, event),
          currentSnapshot,
        );
        nextSnapshot.logByteOffset = logByteOffset;

        writeAtomicJson(statePath, nextSnapshot);

        this.pendingSnapshots.set(sessionId, { sessionDir, snapshot: nextSnapshot });
        this.markIndexesDirty();

        this.onCommit?.(nextSnapshot, events);
        return nextSnapshot;
      },
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
    const currentIndex = readDiscussSummaryIndex(this.projectRoot);
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
    const hydratedIndex = readDiscussSummaryIndex(this.projectRoot);
    if (!hydratedIndex) {
      return repair.summaries;
    }
    return this.buildSummariesFromIndex(hydratedIndex);
  }

  listRecoveryCandidates(): DiscussDiscoverySession[] {
    this.flushDirtyIndexes();
    return listPersistedDiscussSessions(this.projectRoot);
  }

  resolveSessionDir(sessionId: string): string {
    const sessionDir = resolveDiscussSessionDir(this.projectRoot, sessionId);
    if (!sessionDir) {
      throw new Error(`Discuss session not found: ${sessionId}`);
    }
    return sessionDir;
  }

  flushDirtyIndexes(): void {
    if (!this.dirtyDiscovery && !this.dirtySummaryIndex && !this.dirtyProjectRoots) {
      return;
    }

    tryWithPromiseChainLockSync(projectDiscoveryLocks, this.projectRoot, () => {
      const flushedKeys: string[] = [];

      if (this.dirtyDiscovery || this.dirtySummaryIndex) {
        const mergedSessions = new Map<string, DiscussDiscoverySession>();
        for (const session of listPersistedDiscussSessions(this.projectRoot)) {
          mergedSessions.set(session.sessionId, session);
        }

        const mergedSummaryRows = new Map<string, DiscussSummaryIndexRow>();
        for (const summary of readDiscussSummaryIndex(this.projectRoot)?.sessions ?? []) {
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
            projectRoot: this.projectRoot,
            updatedAt: latestUpdatedAt,
            sessions: [...mergedSessions.values()].sort((left, right) => {
              if (left.createdAt !== right.createdAt) {
                return left.createdAt.localeCompare(right.createdAt);
              }
              return left.sessionId.localeCompare(right.sessionId);
            }),
          };
          writeAtomicJson(discussDiscoveryPath(this.projectRoot), discovery);
          this.dirtyDiscovery = false;
        }

        if (this.dirtySummaryIndex) {
          writeAtomicJson(
            discussSummaryIndexPath(this.projectRoot),
            buildSummaryIndexData(this.projectRoot, [...mergedSummaryRows.values()]),
          );
          this.dirtySummaryIndex = false;
        }
      }

      if (this.dirtyProjectRoots) {
        const latestSnapshot = [...this.pendingSnapshots.values()].reduce(
          (latest, { snapshot }) => (snapshot.updatedAt > latest.updatedAt ? snapshot : latest),
          { updatedAt: '' } as { updatedAt: string },
        );
        const wroteRoots = tryWithPromiseChainLockSync(
          discussProjectRootRegistryLocks,
          discussProjectRootsPath(),
          () => {
            const projectRoots = new Set(readDiscussProjectRoots());
            projectRoots.add(this.projectRoot);
            writeAtomicJson(discussProjectRootsPath(), {
              updatedAt: latestSnapshot.updatedAt,
              projectRoots: [...projectRoots].sort(),
            });
            return true;
          },
        );
        if (wroteRoots !== null) {
          this.dirtyProjectRoots = false;
        }
      }

      for (const key of flushedKeys) {
        this.pendingSnapshots.delete(key);
      }
    });
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
    this.dirtyProjectRoots = true;
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushDirtyIndexes();
      }, 500);
      this.flushTimer.unref?.();
    }
  }

  private loadFromSessionDir(
    sessionId: string,
    sessionDir: string,
  ): PersistedDiscussSnapshot | null {
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
    const eventLog = readDiscussEventLog(logPath).filter((event) =>
      event.sessionId === sessionId && event.projectRoot === this.projectRoot,
    );

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

    return replayDiscussEvents(eventLog, makeEmptySnapshot(sessionId, this.projectRoot));
  }

  private readSessionSnapshot(
    sessionId: string,
    statePath: string,
  ): PersistedDiscussSnapshot | null {
    const snapshot = readDiscussSnapshot(statePath);
    if (!snapshot) {
      return null;
    }
    if (snapshot.sessionId !== sessionId || snapshot.projectRoot !== this.projectRoot) {
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

    const index = buildSummaryIndexData(this.projectRoot, rows);
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
    const currentIndex = readDiscussSummaryIndex(this.projectRoot);
    if (!summaryIndexDataEquals(currentIndex, repair.index)) {
      const wroteSummaryIndex = tryWithPromiseChainLockSync(
        projectDiscoveryLocks,
        this.projectRoot,
        () => {
          const latestIndex = readDiscussSummaryIndex(this.projectRoot);
          if (summaryIndexDataEquals(latestIndex, repair.index)) {
            return true;
          }
          writeAtomicJson(discussSummaryIndexPath(this.projectRoot), repair.index);
          return true;
        },
      );
      if (wroteSummaryIndex === null) {
        return false;
      }
    }

    if (repair.index.sessions.length === 0 || readDiscussProjectRoots().includes(this.projectRoot)) {
      return true;
    }

    const updatedRegistry = tryWithPromiseChainLockSync(
      discussProjectRootRegistryLocks,
      discussProjectRootsPath(),
      () => {
        const projectRoots = new Set(readDiscussProjectRoots());
        if (projectRoots.has(this.projectRoot)) {
          return true;
        }
        projectRoots.add(this.projectRoot);
        writeAtomicJson(discussProjectRootsPath(), {
          updatedAt: repair.index.updatedAt,
          projectRoots: [...projectRoots].sort(),
        });
        return true;
      },
    );

    return updatedRegistry !== null;
  }
}
