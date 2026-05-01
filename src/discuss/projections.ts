import type { Database } from '../store/db.js';

import type { CoralEvent } from '../store/envelope.js';
import { upsertProjection } from '../store/projection-upsert.js';
import type { Reducer } from '../store/reducers.js';
import { makeEmptySnapshot, reduceDiscussEvent } from './reducer.js';
import type { DiscussAuditView, DiscussControlTranscriptEntryDto, DiscussControlView } from './view-types.js';
import {
  discussKindFromEventType,
  type DiscussDomainEvent,
  type DiscussJournalBody,
  type PersistedDiscussSnapshot,
} from './events.js';
import type { TranscriptEntry } from './session-types.js';

type ProjectionDiscussRow = {
  state: PersistedDiscussSnapshot;
  lastSeq: number;
};

type DiscussProjectionBody = DiscussJournalBody;

export function readProjectionDiscuss(db: Database, discussId: string): ProjectionDiscussRow | null {
  const row = db
    .prepare(
      `SELECT state, last_seq
         FROM projection_discuss
        WHERE discuss_id = ?`,
    )
    .get(discussId) as
    | {
        state: string;
        last_seq: number;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    state: JSON.parse(row.state) as PersistedDiscussSnapshot,
    lastSeq: row.last_seq,
  };
}

export function listProjectionDiscussSnapshots(db: Database): ProjectionDiscussRow[] {
  const rows = db
    .prepare(
      `SELECT state, last_seq
         FROM projection_discuss
        ORDER BY discuss_id ASC`,
    )
    .all() as Array<{ state: string; last_seq: number }>;

  return rows.map((row) => ({
    state: JSON.parse(row.state) as PersistedDiscussSnapshot,
    lastSeq: row.last_seq,
  }));
}

function topicForEvent(event: CoralEvent<DiscussProjectionBody>, previous: PersistedDiscussSnapshot | null): string {
  if (typeof previous?.state.topic === 'string' && previous.state.topic.length > 0) {
    return previous.state.topic;
  }

  if (event.type === 'discuss.session.created') {
    const createdTopic = (event.body as { input?: { topic?: unknown } }).input?.topic;
    if (typeof createdTopic === 'string') {
      return createdTopic;
    }
  }

  return '';
}

function toDiscussDomainEvent(
  event: CoralEvent<DiscussProjectionBody>,
  previous: PersistedDiscussSnapshot | null,
): DiscussDomainEvent {
  const { sourceSeq, ...payload } = event.body;
  const kind = discussKindFromEventType(event.type);
  if (kind === null) {
    throw new Error(`Unknown discuss event type '${event.type}'.`);
  }

  return {
    v: 1,
    sessionId: event.stream.id,
    projectRoot: event.project ?? previous?.projectRoot ?? '',
    topic: topicForEvent(event, previous),
    seq: sourceSeq,
    kind,
    ts: event.ts,
    payload,
  } as DiscussDomainEvent;
}

export const reduceDiscussProjection: Reducer<DiscussProjectionBody> = (db, event) => {
  const previous = readProjectionDiscuss(db, event.stream.id)?.state ?? null;
  const seed = previous ?? makeEmptySnapshot(event.stream.id, event.project ?? '');
  const next = reduceDiscussEvent(seed, toDiscussDomainEvent(event, previous));

  upsertProjection(db, {
    table: 'projection_discuss',
    pkColumn: 'discuss_id',
    pkValue: event.stream.id,
    columns: {
      state: JSON.stringify(next),
    },
    lastSeq: event.seq,
  });
};

function cloneTranscriptEntry(entry: TranscriptEntry): TranscriptEntry {
  switch (entry.type) {
    case 'bids':
      return {
        ...entry,
        bids: { ...entry.bids },
        ...(entry.effective_bids === undefined ? {} : { effective_bids: { ...entry.effective_bids } }),
        ...(entry.thoughts === undefined ? {} : { thoughts: { ...entry.thoughts } }),
      };

    default:
      return { ...entry };
  }
}

function redactTranscriptEntry(entry: TranscriptEntry): DiscussControlTranscriptEntryDto {
  if (entry.type !== 'bids') {
    return cloneTranscriptEntry(entry);
  }

  return {
    type: entry.type,
    step: entry.step,
    epoch: entry.epoch,
    ts: entry.ts,
    winner: entry.winner,
    resolve_type: entry.resolve_type,
  };
}

export function buildControlView(snapshot: PersistedDiscussSnapshot): DiscussControlView {
  return {
    transcript: snapshot.state.transcript.map(redactTranscriptEntry),
    lastSeq: snapshot.lastAppliedSeq,
  };
}

export function buildAuditView(snapshot: PersistedDiscussSnapshot): DiscussAuditView {
  return {
    transcript: snapshot.state.transcript.map(cloneTranscriptEntry),
    lastSeq: snapshot.lastAppliedSeq,
  };
}
