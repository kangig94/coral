import type { Database } from '../../store/db.js';
import { decodeBody, type StoreReadContext } from '../../store/body-codec.js';
import type { EventsRow } from '../../store/schema.js';
import { jobExecutionEndedBodySchema, jobExecutionOutcomeAcceptedBodySchema } from '../terminal/result.js';
import type { JobProgressTiming } from '../event-bodies.js';
import type { AppendedEvent } from '../../store/append.js';
import type { JobEvent } from '../records.js';
import { normalizeJobTerminal } from '../terminal/result.js';

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

function toJobEvent(event: AppendedEvent, db: Database, ctx: StoreReadContext): JobEvent | null {
  if (event.stream.kind !== 'job') {
    return null;
  }

  if (event.type === 'job.execution.progress') {
    const body = event.body as { execution: number; kind?: string; message: string; timing: JobProgressTiming };
    if (body.kind !== 'message') {
      return null;
    }

    return {
      jobId: event.stream.id,
      execution: body.execution,
      seq: event.seq,
      type: 'progress',
      ts: event.ts,
      message: body.message,
      timing: body.timing,
    };
  }

  if (event.type !== 'job.execution.ended') {
    return null;
  }

  const end = jobExecutionEndedBodySchema.parse(event.body);
  const row = db
    .prepare<
      [number, string],
      EventsRow
    >("SELECT * FROM events WHERE seq = ? AND stream_kind = 'job' AND stream_id = ? AND type = 'job.execution.outcome.accepted'")
    .get(end.causeRef.seq, event.stream.id);
  if (row === undefined || end.causeRef.stream.kind !== 'job' || end.causeRef.stream.id !== event.stream.id)
    throw new Error('Execution end must cite its accepted outcome.');
  const body = decodeBody(row, jobExecutionOutcomeAcceptedBodySchema, ctx);
  if (body.execution !== end.execution) throw new Error('Execution end must cite its own outcome.');
  const usage = body.diagnostics?.usage;

  return {
    jobId: event.stream.id,
    execution: end.execution,
    seq: event.seq,
    type: 'terminal',
    ts: event.ts,
    result: normalizeJobTerminal(body.terminal),
    ...(usage === undefined ? {} : { usage }),
  };
}

export function publishJobEvents(appended: readonly AppendedEvent[], db: Database, ctx: StoreReadContext): void {
  const projected: JobEvent[] = [];
  for (const appendedEvent of appended) {
    const event = toJobEvent(appendedEvent, db, ctx);
    if (event === null) {
      continue;
    }
    projected.push(event);
  }

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
  if (options.abortSignal?.aborted) onAbort();

  try {
    while (!closed) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          pendingResolve = resolve;
        });
      }

      for (let index = 0; index < queue.length; index += 1) {
        const next = queue[index];
        if (next !== undefined) {
          yield next;
        }
      }
      queue.length = 0;
    }
  } finally {
    options.abortSignal?.removeEventListener('abort', onAbort);
    subscribers.delete(subscriber);
  }
}
