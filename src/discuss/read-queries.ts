import type { Database } from 'better-sqlite3';

import type { DiscussDomainEvent, PersistedDiscussSnapshot } from './events.js';
import {
  listProjectionDiscussSnapshots,
  readProjectionDiscuss,
} from './projections.js';
import type {
  DiscussDiscoveryData,
  DiscussSummaryIndexData,
} from './persistence-types.js';
import { resolveProjectSource } from "../infra/project-source.js";
import { decodeStoredBody, type StoreReadContext } from '../store/body-codec.js';
import type { EventsRow } from '../store/schema.js';

export type DiscussSnapshotRow = PersistedDiscussSnapshot;
export type DiscussEventLogEntry = DiscussDomainEvent;
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
    input !== null
    && typeof input === 'object'
    && !Array.isArray(input)
    && typeof (input as { topic?: unknown }).topic === 'string'
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

  return {
    v: 1,
    sessionId: row.stream_id,
    projectRoot: row.project ?? snapshot?.projectRoot ?? '',
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
  return listProjectionDiscussSnapshots(db)
    .map((row) => row.state)
    .filter((snapshot) => snapshot.projectRoot === source || resolveProjectSource(snapshot.projectRoot) === source);
}

function latestUpdatedAt(snapshots: PersistedDiscussSnapshot[]): string {
  return snapshots
    .map((snapshot) => snapshot.updatedAt)
    .sort()
    .at(-1) ?? UNIX_EPOCH_ISO;
}

export function readDiscussSnapshot(
  db: Database,
  ref: DiscussReadRef,
): DiscussSnapshotRow | null {
  return readProjectionDiscuss(db, discussIdFromRef(ref))?.state ?? null;
}

export function readDiscussEventLog(
  db: Database,
  ref: DiscussReadRef,
  ctx: StoreReadContext,
): DiscussEventLogEntry[] {
  const discussId = discussIdFromRef(ref);
  const snapshot = readProjectionDiscuss(db, discussId)?.state ?? null;
  const rows = db
    .prepare(
      `SELECT *
         FROM events
        WHERE stream_kind = 'discuss'
          AND stream_id = ?
        ORDER BY seq ASC`,
    )
    .all(discussId) as EventsRow[];

  return rows.map((row) => toDiscussDomainEvent(row, snapshot, ctx));
}

export function readDiscussDiscovery(
  db: Database,
  source: string,
): DiscussDiscoveryData | null {
  const snapshots = snapshotsForSource(db, source);
  if (snapshots.length === 0) return null;

  return {
    source,
    updatedAt: latestUpdatedAt(snapshots),
    sessions: snapshots.map((snapshot) => ({
      sessionId: snapshot.sessionId,
      topic: snapshot.state.topic,
      journalRef: snapshot.sessionId,
      createdAt: snapshot.state.created_at,
    })),
  };
}

export function readDiscussSummaryIndex(
  db: Database,
  source: string,
): DiscussSummaryIndexData | null {
  const snapshots = snapshotsForSource(db, source);
  if (snapshots.length === 0) return null;

  return {
    source,
    updatedAt: latestUpdatedAt(snapshots),
    sessions: snapshots.map((snapshot) => ({
      sessionId: snapshot.sessionId,
      projectRoot: snapshot.projectRoot,
      topic: snapshot.state.topic,
      status: snapshot.state.status,
      createdAt: snapshot.state.created_at,
      agentCount: Object.keys(snapshot.state.agents).length,
      updatedAt: snapshot.updatedAt,
      lastSeq: snapshot.lastAppliedSeq,
    })),
  };
}
