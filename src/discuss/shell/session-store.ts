import { type DiscussSummaryDto } from '../read-contract.js';
import type { DiscussDomainEvent, PersistedDiscussSnapshot } from '../events.js';
import type { DiscussDiscoverySession } from '../persistence-types.js';
import { makeEmptySnapshot, reduceDiscussEvent } from '../reducer.js';

type DiscussSessionStoreOptions = {
  journal: DiscussSessionJournal;
  onCommit?: (snapshot: PersistedDiscussSnapshot, events: DiscussDomainEvent[]) => void;
};

export type DiscussSessionJournal = {
  append(source: string, snapshot: PersistedDiscussSnapshot, events: readonly DiscussDomainEvent[]): void;
  readSnapshot(sessionId: string): PersistedDiscussSnapshot | null;
  readEvents(sessionId: string): DiscussDomainEvent[];
  listSnapshots(source: string): PersistedDiscussSnapshot[];
  listSources(): string[];
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

function validateAppendBatch(sessionId: string, lastAppliedSeq: number, events: readonly DiscussDomainEvent[]): void {
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

function toSummary(snapshot: PersistedDiscussSnapshot): DiscussSummaryDto {
  return {
    sessionId: snapshot.sessionId,
    projectRoot: snapshot.projectRoot,
    topic: snapshot.state.topic,
    status: snapshot.state.status,
    createdAt: snapshot.state.created_at,
    agentCount: Object.keys(snapshot.state.agents).length,
    authority: 'persisted',
  };
}

function toRecoveryCandidate(snapshot: PersistedDiscussSnapshot): DiscussDiscoverySession {
  return {
    sessionId: snapshot.sessionId,
    topic: snapshot.state.topic,
    journalRef: snapshot.sessionId,
    createdAt: snapshot.state.created_at,
  };
}

export function createInMemoryDiscussJournal(): DiscussSessionJournal {
  const snapshots = new Map<string, PersistedDiscussSnapshot>();
  const eventLog = new Map<string, DiscussDomainEvent[]>();
  const sourceBySession = new Map<string, string>();

  return {
    append(source, snapshot, events) {
      snapshots.set(snapshot.sessionId, snapshot);
      sourceBySession.set(snapshot.sessionId, source);
      const currentEvents = eventLog.get(snapshot.sessionId) ?? [];
      eventLog.set(snapshot.sessionId, [...currentEvents, ...events]);
    },
    readSnapshot(sessionId) {
      return snapshots.get(sessionId) ?? null;
    },
    readEvents(sessionId) {
      return [...(eventLog.get(sessionId) ?? [])];
    },
    listSnapshots(source) {
      return [...snapshots.values()].filter((snapshot) => sourceBySession.get(snapshot.sessionId) === source);
    },
    listSources() {
      return [...new Set(sourceBySession.values())].sort();
    },
  };
}

export class DiscussSessionStore {
  private readonly source: string;
  private readonly journal: DiscussSessionJournal;
  private readonly onCommit?: DiscussSessionStoreOptions['onCommit'];

  constructor(source: string, options: DiscussSessionStoreOptions) {
    this.source = source;
    this.journal = options.journal;
    this.onCommit = options.onCommit;
  }

  load(sessionId: string): PersistedDiscussSnapshot | null {
    return this.journal.readSnapshot(sessionId);
  }

  async append(
    sessionId: string,
    expectedSeq: number | null,
    events: DiscussDomainEvent[],
  ): Promise<PersistedDiscussSnapshot> {
    const currentSnapshot =
      this.journal.readSnapshot(sessionId) ?? makeEmptySnapshot(sessionId, events[0]?.projectRoot ?? '');

    if (expectedSeq !== null && expectedSeq !== currentSnapshot.lastAppliedSeq) {
      throw new DiscussStaleWriteError(expectedSeq, currentSnapshot.lastAppliedSeq);
    }

    if (events.length === 0) {
      return currentSnapshot;
    }

    validateAppendBatch(sessionId, currentSnapshot.lastAppliedSeq, events);

    const nextSnapshot = events.reduce((snapshot, event) => reduceDiscussEvent(snapshot, event), currentSnapshot);
    this.journal.append(this.source, nextSnapshot, events);
    this.onCommit?.(nextSnapshot, events);
    return nextSnapshot;
  }

  listSummaries(): DiscussSummaryDto[] {
    return this.journal
      .listSnapshots(this.source)
      .map(toSummary)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  listSummariesFromIndex(): DiscussSummaryDto[] {
    return this.listSummaries();
  }

  listRecoveryCandidates(): DiscussDiscoverySession[] {
    return this.journal
      .listSnapshots(this.source)
      .map(toRecoveryCandidate)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  readSessionEvents(sessionId: string): DiscussDomainEvent[] {
    return this.journal.readEvents(sessionId).filter((event) => event.sessionId === sessionId);
  }

  dispose(): void {}
}
