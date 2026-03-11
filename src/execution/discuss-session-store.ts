import {
  closeSync,
  fdatasyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  readDiscussProjectRoots,
  listPersistedDiscussSessions,
  readDiscussEventLog,
  readDiscussSnapshot,
  resolveDiscussSessionDir,
  type DiscussDiscoveryData,
  type DiscussDiscoverySession,
} from '../client/readers.js';
import {
  DISCUSS_PROJECT_ROOTS_PATH,
  discussDiscoveryPath,
  discussEventLogPath,
  discussSessionDir,
  discussStatePath,
} from '../client/paths.js';
import {
  buildDiscussSummary,
  type DiscussSummaryDto,
} from '../client/discuss.js';
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

export class DiscussSessionStore {
  private readonly projectRoot: string;
  private readonly onCommit?: DiscussSessionStoreOptions['onCommit'];

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

        const nextSnapshot = events.reduce(
          (snapshot, event) => reduceDiscussEvent(snapshot, event),
          currentSnapshot,
        );

        writeAtomicJson(statePath, nextSnapshot);

        await withPromiseChainLock(projectDiscoveryLocks, this.projectRoot, () => {
          const mergedSessions = new Map<string, DiscussDiscoverySession>();
          for (const session of listPersistedDiscussSessions(this.projectRoot)) {
            mergedSessions.set(session.sessionId, session);
          }
          mergedSessions.set(sessionId, toDiscoverySession(sessionDir, nextSnapshot));

          const discovery: DiscussDiscoveryData = {
            projectRoot: this.projectRoot,
            updatedAt: nextSnapshot.updatedAt,
            sessions: [...mergedSessions.values()].sort((left, right) => {
              if (left.createdAt !== right.createdAt) {
                return left.createdAt.localeCompare(right.createdAt);
              }
              return left.sessionId.localeCompare(right.sessionId);
            }),
          };

          writeAtomicJson(discussDiscoveryPath(this.projectRoot), discovery);
        });

        await withPromiseChainLock(
          discussProjectRootRegistryLocks,
          DISCUSS_PROJECT_ROOTS_PATH,
          () => {
            const projectRoots = new Set(readDiscussProjectRoots());
            projectRoots.add(this.projectRoot);
            writeAtomicJson(DISCUSS_PROJECT_ROOTS_PATH, {
              updatedAt: nextSnapshot.updatedAt,
              projectRoots: [...projectRoots].sort(),
            });
          },
        );

        this.onCommit?.(nextSnapshot, events);
        return nextSnapshot;
      },
    );
  }

  listSummaries(): DiscussSummaryDto[] {
    const summaries: DiscussSummaryDto[] = [];
    for (const session of this.listRecoveryCandidates()) {
      const snapshot = this.load(session.sessionId);
      if (!snapshot) {
        continue;
      }
      summaries.push(buildDiscussSummary(snapshot, 'persisted'));
    }

    return summaries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  listRecoveryCandidates(): DiscussDiscoverySession[] {
    return listPersistedDiscussSessions(this.projectRoot);
  }

  resolveSessionDir(sessionId: string): string {
    const sessionDir = resolveDiscussSessionDir(this.projectRoot, sessionId);
    if (!sessionDir) {
      throw new Error(`Discuss session not found: ${sessionId}`);
    }
    return sessionDir;
  }

  private loadFromSessionDir(
    sessionId: string,
    sessionDir: string,
  ): PersistedDiscussSnapshot | null {
    const statePath = discussStatePath(sessionDir);
    const logPath = discussEventLogPath(sessionDir);
    const snapshot = this.readSessionSnapshot(sessionId, statePath);
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
}
