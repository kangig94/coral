import type { JobProgressTiming } from '../event-bodies.js';
import type { AppendedEvent } from '../../store/append.js';
import type { JobEvent, JobTerminal, JobTerminalDiagnostics } from '../records.js';
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

function toJobEvent(event: AppendedEvent): JobEvent | null {
  if (event.stream.kind !== 'job') {
    return null;
  }

  const sessionId = typeof event.refs?.sessionId === 'string' ? event.refs.sessionId : null;

  if (event.type === 'job.progress.emitted') {
    const body = event.body as { kind?: string; message: string; timing: JobProgressTiming };
    if (body.kind !== 'message') {
      return null;
    }

    return {
      jobId: event.stream.id,
      sessionId,
      seq: event.seq,
      type: 'progress',
      ts: event.ts,
      message: body.message,
      timing: body.timing,
    };
  }

  if (event.type !== 'job.terminal.recorded') {
    return null;
  }

  const body = event.body as {
    terminal: JobTerminal;
    diagnostics?: JobTerminalDiagnostics;
  };
  const usage = body.diagnostics?.usage;

  return {
    jobId: event.stream.id,
    sessionId,
    seq: event.seq,
    type: 'terminal',
    ts: event.ts,
    result: normalizeJobTerminal(body.terminal),
    // Appended terminal events do not carry jobKind; the wait coordinator
    // replaces workflow terminal usage with the read-time aggregate.
    ...(usage === undefined ? {} : { usage }),
  };
}

export function publishJobEvents(appended: readonly AppendedEvent[]): void {
  const projected: JobEvent[] = [];
  for (const appendedEvent of appended) {
    const event = toJobEvent(appendedEvent);
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
