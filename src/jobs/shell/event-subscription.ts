import type BetterSqlite3 from 'better-sqlite3';

import type { AppendedEvent } from '../../store/append.js';
import type { JobProgressRow } from '../../store/queries/jobs.js';
import type { JobTerminalRecord } from '../records.js';

export type JobEvent = JobProgressRow;

type JobSubscriber = {
  afterSeq: number;
  jobIds: Set<string>;
  push: (event: JobEvent) => void;
  close: () => void;
};

const subscribers = new Set<JobSubscriber>();

function matches(subscriber: JobSubscriber, event: JobEvent): boolean {
  return event.seq > subscriber.afterSeq && subscriber.jobIds.has(event.jobId);
}

function perJobIndexForSeq(
  db: BetterSqlite3.Database,
  jobId: string,
  seq: number,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM events
        WHERE stream_kind = 'job'
          AND stream_id = ?
          AND type IN ('job.progress.emitted', 'job.terminal.recorded')
          AND seq <= ?`,
    )
    .get(jobId, seq) as { count: number };

  return row.count;
}

function toJobEvent(
  db: BetterSqlite3.Database,
  event: AppendedEvent,
): JobEvent | null {
  if (event.stream.kind !== 'job') {
    return null;
  }

  const eventId = perJobIndexForSeq(db, event.stream.id, event.seq);
  const sessionId = typeof event.refs?.sessionId === 'string' ? event.refs.sessionId : '';

  if (event.type === 'job.progress.emitted') {
    const body = event.body as { kind?: string; message?: string };
    if (body.kind !== 'message') {
      return null;
    }

    return {
      jobId: event.stream.id,
      sessionId,
      seq: event.seq,
      perJobIndex: eventId,
      eventId,
      type: 'progress',
      ts: event.ts,
      message: body.message ?? '',
    };
  }

  if (event.type !== 'job.terminal.recorded') {
    return null;
  }

  const body = event.body as {
    content?: string;
    durationMs?: number;
    exitCode?: number | null;
    nonResumable?: boolean;
    warnings?: string[];
    usage?: Record<string, unknown>;
    workflow?: { steps: Array<Record<string, unknown>> };
    outcome: JobTerminalRecord['outcome'];
  };

  return {
    jobId: event.stream.id,
    sessionId,
    seq: event.seq,
    perJobIndex: eventId,
    eventId,
    type: 'terminal',
    ts: event.ts,
      result: {
        content: body.content ?? '',
        durationMs: body.durationMs,
        exitCode: body.exitCode,
        nonResumable: body.nonResumable,
        warnings: body.warnings,
        usage: body.usage as JobTerminalRecord['usage'],
        workflow: body.workflow as JobTerminalRecord['workflow'],
        outcome: body.outcome,
      },
    };
  }

export function publishJobEvents(
  db: BetterSqlite3.Database,
  appended: readonly AppendedEvent[],
): void {
  const projected = appended
    .map((event) => toJobEvent(db, event))
    .filter((event): event is JobEvent => event !== null);

  for (const event of projected) {
    for (const subscriber of [...subscribers]) {
      if (matches(subscriber, event)) {
        subscriber.push(event);
      }
    }
  }
}

export async function* subscribeJobEvents(options: {
  afterSeq: number;
  jobIds: readonly string[];
  abortSignal?: AbortSignal;
}): AsyncIterable<JobEvent> {
  const queue: JobEvent[] = [];
  let pendingResolve: (() => void) | null = null;
  let closed = false;

  const flush = (): void => {
    pendingResolve?.();
    pendingResolve = null;
  };

  const subscriber: JobSubscriber = {
    afterSeq: options.afterSeq,
    jobIds: new Set(options.jobIds),
    push(event) {
      queue.push(event);
      flush();
    },
    close() {
      closed = true;
      flush();
    },
  };

  const onAbort = (): void => {
    subscribers.delete(subscriber);
    subscriber.close();
  };

  subscribers.add(subscriber);
  options.abortSignal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (!closed) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          pendingResolve = resolve;
        });
      }

      while (queue.length > 0) {
        const next = queue.shift();
        if (next) {
          yield next;
        }
      }
    }
  } finally {
    options.abortSignal?.removeEventListener('abort', onAbort);
    subscribers.delete(subscriber);
  }
}
