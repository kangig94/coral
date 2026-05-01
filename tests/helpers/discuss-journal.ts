import type { DiscussDomainEvent, PersistedDiscussSnapshot } from '#src/discuss/events.js';
import type { DiscussSessionJournal } from '#src/discuss/shell/session-store.js';

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
