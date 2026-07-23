import { sqlPlaceholders, type Database } from '../store/db.js';

import type { DiscussDomainEvent, PersistedDiscussSnapshot } from './events.js';
import { listProjectionDiscussSnapshots, readProjectionDiscuss } from './projections.js';
import type { DiscussDiscoveryData, DiscussSummaryIndexData } from './persistence-types.js';
import { resolveProjectSource } from '../infra/project-source.js';
import { decodeStoredBody, type StoreReadContext } from '../store/body-codec.js';
import type { EventsRow } from '../store/schema.js';

export type DiscussReadRef =
  | string
  | {
      source: string;
      sessionId: string;
    };

const UNIX_EPOCH_ISO = '1970-01-01T00:00:00.000Z';

function discussIdFromRef(ref: DiscussReadRef): string {
  return typeof ref === 'string' ? ref : ref.sessionId;
}

function eventTopic(payload: Record<string, unknown>, snapshot: PersistedDiscussSnapshot | null): string {
  const input = payload.input;
  if (
    input !== null &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    typeof (input as { topic?: unknown }).topic === 'string'
  ) {
    return (input as { topic: string }).topic;
  }

  return snapshot?.state.topic ?? '';
}

function toDiscussDomainEvent(
  row: EventsRow,
  snapshot: PersistedDiscussSnapshot | null,
  ctx: StoreReadContext,
): DiscussDomainEvent {
  const body = decodeStoredBody(row, ctx) as Record<string, unknown>;
  const { sourceSeq, ...payload } = body;
  const projectRoot = row.project ?? snapshot?.projectRoot;
  if (projectRoot === undefined || projectRoot.length === 0) {
    throw new Error(`Discussion '${row.stream_id}' has no durable project scope.`);
  }

  return {
    v: 1,
    sessionId: row.stream_id,
    projectRoot,
    topic: eventTopic(payload, snapshot),
    seq: typeof sourceSeq === 'number' ? sourceSeq : row.seq,
    kind: row.type.startsWith('discuss.')
      ? (row.type.slice('discuss.'.length) as DiscussDomainEvent['kind'])
      : (row.type as DiscussDomainEvent['kind']),
    ts: row.ts,
    payload,
  } as DiscussDomainEvent;
}

function snapshotsForSource(db: Database, source: string): PersistedDiscussSnapshot[] {
  const snapshots: PersistedDiscussSnapshot[] = [];
  for (const row of listProjectionDiscussSnapshots(db)) {
    const snapshot = row.state;
    if (snapshot.projectRoot === source || resolveProjectSource(snapshot.projectRoot) === source) {
      snapshots.push(snapshot);
    }
  }
  return snapshots;
}

function latestUpdatedAt(snapshots: PersistedDiscussSnapshot[]): string {
  let latest = UNIX_EPOCH_ISO;
  for (const snapshot of snapshots) {
    if (snapshot.updatedAt > latest) {
      latest = snapshot.updatedAt;
    }
  }
  return latest;
}

export function readDiscussSnapshot(db: Database, ref: DiscussReadRef): PersistedDiscussSnapshot | null {
  return readProjectionDiscuss(db, discussIdFromRef(ref))?.state ?? null;
}

export function readDiscussEventLog(db: Database, ref: DiscussReadRef, ctx: StoreReadContext): DiscussDomainEvent[] {
  const discussId = discussIdFromRef(ref);
  const snapshot = readProjectionDiscuss(db, discussId)?.state ?? null;
  const eventTypes = [...ctx.streamKinds].filter(([, streamKind]) => streamKind === 'discuss').map(([type]) => type);
  if (eventTypes.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT *
         FROM events
        WHERE stream_id = ?
          AND type IN (${sqlPlaceholders(eventTypes.length)})
        ORDER BY seq ASC`,
    )
    .all(discussId, ...eventTypes) as EventsRow[];

  const events: DiscussDomainEvent[] = [];
  for (const row of rows) {
    events.push(toDiscussDomainEvent(row, snapshot, ctx));
  }
  return events;
}

export function readDiscussDiscovery(db: Database, source: string): DiscussDiscoveryData | null {
  const snapshots = snapshotsForSource(db, source);
  if (snapshots.length === 0) return null;

  const sessions: DiscussDiscoveryData['sessions'] = [];
  for (const snapshot of snapshots) {
    sessions.push({
      sessionId: snapshot.sessionId,
      topic: snapshot.state.topic,
      createdAt: snapshot.state.created_at,
    });
  }

  return {
    source,
    updatedAt: latestUpdatedAt(snapshots),
    sessions,
  };
}

export function readDiscussSummaryIndex(db: Database, source: string): DiscussSummaryIndexData | null {
  const snapshots = snapshotsForSource(db, source);
  if (snapshots.length === 0) return null;

  const sessions: DiscussSummaryIndexData['sessions'] = [];
  for (const snapshot of snapshots) {
    sessions.push({
      sessionId: snapshot.sessionId,
      projectRoot: snapshot.projectRoot,
      topic: snapshot.state.topic,
      status: snapshot.state.status,
      createdAt: snapshot.state.created_at,
      agentCount: Object.keys(snapshot.state.agents).length,
      updatedAt: snapshot.updatedAt,
      lastSeq: snapshot.lastAppliedSeq,
    });
  }

  return {
    source,
    updatedAt: latestUpdatedAt(snapshots),
    sessions,
  };
}
