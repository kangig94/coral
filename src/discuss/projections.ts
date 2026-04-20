import type { Database } from 'better-sqlite3';

import type { CoralEvent } from '../store/envelope.js';
import { upsertProjection } from '../store/projection-upsert.js';
import type { Reducer } from '../store/reducers.js';
import { makeEmptySnapshot, reduceDiscussEvent } from './reducer.js';
import type {
  DiscussAuditView,
  DiscussControlTranscriptEntryDto,
  DiscussControlView,
} from './view-types.js';
import type { WatchEvent } from './watch.js';
import type { DiscussDomainEvent, PersistedDiscussSnapshot } from './events.js';
import type { TranscriptEntry } from './session-types.js';

type ProjectionDiscussRow = {
  state: PersistedDiscussSnapshot;
  lastSeq: number;
};

type DiscussProjectionBody = Record<string, unknown> & {
  legacySeq: number;
};

function readProjectionDiscuss(db: Database, discussId: string): ProjectionDiscussRow | null {
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

function topicForEvent(
  event: CoralEvent<DiscussProjectionBody>,
  previous: PersistedDiscussSnapshot | null,
): string {
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
  const { legacySeq, ...payload } = event.body;

  return {
    v: 1,
    sessionId: event.stream.id,
    projectRoot: event.project ?? previous?.projectRoot ?? '',
    topic: topicForEvent(event, previous),
    seq: legacySeq,
    kind: event.type.slice('discuss.'.length) as DiscussDomainEvent['kind'],
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

function parseWatchEventTs(ts: string): number {
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : 0;
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

export function buildWatchEvents(events: DiscussDomainEvent[]): WatchEvent[] {
  const watchEvents: WatchEvent[] = [];

  for (const event of events) {
    const ts = parseWatchEventTs(event.ts);

    switch (event.kind) {
      case 'bid.round.closed':
        if ('winner' in event.payload.outcome) {
          watchEvents.push({
            type: 'bid_resolved',
            data: {
              winner: event.payload.outcome.winner,
              speaker_type: event.payload.outcome.speaker_type,
            },
            ts,
          });
          break;
        }

        if (event.payload.outcome.reason !== 'epoch_transition') break;

        watchEvents.push({
          type: 'epoch_transition',
          data: {
            epoch: event.payload.stateMutations.epoch ?? null,
          },
          ts,
        });
        break;

      case 'speech.recorded':
        watchEvents.push({
          type: 'speech_done',
          data: {
            speaker: event.payload.agent,
            content: event.payload.content,
          },
          ts,
        });
        break;

      case 'session.ended':
        watchEvents.push({
          type: 'session_ended',
          data: event.payload.force
            ? {
                reason: 'force_end',
                detail: event.payload.reason ?? event.payload.endReasonContent ?? null,
              }
            : {
                reason: event.payload.endReason ?? null,
              },
          ts,
        });
        break;

      default:
        break;
    }
  }

  return watchEvents;
}
