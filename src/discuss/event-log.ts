import { appendFileSync, readFileSync } from 'node:fs';

/**
 * Durable machine event kinds emitted by the discuss state machine.
 */
export type DiscussMachineEventKind =
  | 'created'
  | 'bidding_started'
  | 'bid_recorded'
  | 'round_resolved'
  | 'speech_recorded'
  | 'speech_timeout'
  | 'agents_expelled'
  | 'epoch_summary_recorded'
  | 'session_ended';

/**
 * One JSONL event-log record for a discuss session.
 */
export interface DiscussMachineEvent {
  sessionId: string;
  topic: string;
  projectRoot: string;
  seq: number;
  kind: DiscussMachineEventKind;
  ts: string;
  payload: Record<string, unknown>;
}

/**
 * Snapshot-to-log handoff metadata embedded in `state.json`.
 */
export interface WatermarkMeta {
  lastDurableSeq: number;
  pendingSeqStart: number | null;
  pendingSeqEnd: number | null;
}

/**
 * Append machine events to the event log as JSONL records.
 */
export function appendEvents(eventLogPath: string, events: DiscussMachineEvent[]): void {
  if (events.length === 0) {
    return;
  }

  const lines = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
  appendFileSync(eventLogPath, lines, 'utf8');
}

/**
 * Read the current max sequence number from the event log.
 */
export function readMaxSeq(eventLogPath: string): number {
  let content: string;
  try {
    content = readFileSync(eventLogPath, 'utf8');
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return 0;
    }
    throw error;
  }

  if (content.trim() === '') {
    return 0;
  }

  let maxSeq = 0;
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.trim() === '') {
      continue;
    }

    const parsed = JSON.parse(line) as Record<string, unknown>;
    const rawSeq = parsed['seq'];
    if (!Number.isInteger(rawSeq)) {
      throw new Error(`Invalid discuss event log entry in ${eventLogPath} at line ${index + 1}: missing integer seq`);
    }
    const seq = rawSeq as number;
    maxSeq = Math.max(maxSeq, seq);
  }

  return maxSeq;
}

/**
 * Read the event log once and return both the next sequence number and
 * watermark metadata for the current mutation batch. Callers must determine
 * eventCount before calling so that readMaxSeq() is invoked exactly once.
 *
 * For empty batches (eventCount === 0), pendingSeqStart and pendingSeqEnd
 * are null — the watermark records only that no durable events were emitted.
 */
export function prepareMutation(eventLogPath: string, eventCount: number): { nextSeq: number; watermark: WatermarkMeta } {
  const lastDurableSeq = readMaxSeq(eventLogPath);
  const nextSeq = lastDurableSeq + 1;
  const watermark: WatermarkMeta = {
    lastDurableSeq,
    pendingSeqStart: eventCount > 0 ? nextSeq : null,
    pendingSeqEnd: eventCount > 0 ? lastDurableSeq + eventCount : null,
  };
  return { nextSeq, watermark };
}
