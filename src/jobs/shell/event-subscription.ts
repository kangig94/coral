import type { JobContinuitySnapshot } from '../continuity.js';
import type { AppendedEvent } from '../../store/append.js';
import type { JobProgress, JobTerminal } from '../records.js';
import { normalizeJobTerminal } from '../terminal/result.js';

export type JobEvent = JobProgress;

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

function toJobEvent(event: AppendedEvent): JobEvent | null {
  if (event.stream.kind !== 'job') {
    return null;
  }

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
      type: 'progress',
      ts: event.ts,
      message: body.message ?? '',
    };
  }

  if (event.type !== 'job.terminal.recorded') {
    return null;
  }

  const body = event.body as {
    terminal: JobTerminal;
    continuity?: JobContinuitySnapshot | null;
  };

  return {
    jobId: event.stream.id,
    sessionId,
    seq: event.seq,
    type: 'terminal',
    ts: event.ts,
    result: normalizeJobTerminal(body.terminal),
    continuity: body.continuity ?? null,
  };
}

export function publishJobEvents(appended: readonly AppendedEvent[]): void {
  const projected = appended
    .map((event) => toJobEvent(event))
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
