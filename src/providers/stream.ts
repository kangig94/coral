import type {
  JobDiagnostics,
  JobTerminal,
  ProviderEventBody,
  ProviderProgressEventBody,
  ProviderTerminalEventBody,
} from './contract.js';

type ProviderEventQueueEntry<TEvent> =
  | { kind: 'event'; event: TEvent }
  | { kind: 'done' }
  | { kind: 'error'; error: unknown };

export const QUEUE_CAP = 1024;

export class ProviderEventBackpressureError extends Error {
  constructor(cap = QUEUE_CAP) {
    super(`Provider event queue exceeded ${cap} buffered events without a consumer.`);
    this.name = 'ProviderEventBackpressureError';
  }
}

export function streamProviderEvents<TEvent>(
  producer: (emit: (event: TEvent) => void) => Promise<void> | void,
): AsyncIterable<TEvent> {
  const queue: ProviderEventQueueEntry<TEvent>[] = [];
  let waiter:
    | {
        resolve: (entry: ProviderEventQueueEntry<TEvent>) => void;
        reject: (error: unknown) => void;
      }
    | null = null;
  let closed = false;

  const dispatch = (entry: ProviderEventQueueEntry<TEvent>): void => {
    if (waiter) {
      const pending = waiter;
      waiter = null;
      if (entry.kind === 'error') {
        pending.reject(entry.error);
        return;
      }
      pending.resolve(entry);
      return;
    }
    queue.push(entry);
  };

  const emit = (event: TEvent): void => {
    if (closed) {
      return;
    }
    if (!waiter && queue.length >= QUEUE_CAP) {
      throw new ProviderEventBackpressureError();
    }
    dispatch({ kind: 'event', event });
  };

  const finish = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    dispatch({ kind: 'done' });
  };

  const fail = (error: unknown): void => {
    if (closed) {
      return;
    }
    closed = true;
    dispatch({ kind: 'error', error });
  };

  void Promise.resolve()
    .then(() => producer(emit))
    .then(() => {
      finish();
    })
    .catch((error: unknown) => {
      fail(error);
    });

  return {
    async *[Symbol.asyncIterator](): AsyncIterator<TEvent> {
      while (true) {
        const entry =
          queue.shift() ??
          (await new Promise<ProviderEventQueueEntry<TEvent>>((resolve, reject) => {
            waiter = { resolve, reject };
          }));
        if (entry.kind === 'event') {
          yield entry.event;
          continue;
        }
        if (entry.kind === 'done') {
          return;
        }
        throw (entry.error instanceof Error ? entry.error : new Error(String(entry.error)));
      }
    },
  };
}

export type ProviderTerminalInput = {
  content: string;
  outcome: JobTerminal['outcome'];
  model?: JobTerminal['model'];
  durationMs?: JobTerminal['durationMs'];
  exitCode?: JobTerminal['exitCode'];
  warnings?: JobTerminal['warnings'];
  usage?: JobTerminal['usage'];
  diagnostics?: JobDiagnostics;
  conversationRef?: string;
  nonResumable?: boolean;
};

export function providerProgressEvent(
  message: string,
  _ts?: string,
): ProviderProgressEventBody {
  return {
    kind: 'progress',
    message,
  };
}

export function providerTerminalEvent(
  event:
    | ProviderTerminalEventBody
    | Omit<ProviderTerminalEventBody, 'kind'>
    | ProviderTerminalInput,
): ProviderTerminalEventBody {
  if ('kind' in event && event.kind === 'terminal') {
    return event;
  }

  if ('terminal' in event) {
    return {
      kind: 'terminal',
      terminal: event.terminal,
      diagnostics: event.diagnostics,
    };
  }

  return {
    kind: 'terminal',
    terminal: {
      content: event.content,
      outcome: event.outcome,
      ...(event.model === undefined ? {} : { model: event.model }),
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
      ...(event.warnings === undefined ? {} : { warnings: [...event.warnings] }),
      ...(event.usage === undefined ? {} : { usage: { ...event.usage } }),
    },
    diagnostics: event.diagnostics ?? {},
  };
}

export function streamProviderTerminal(
  terminal:
    | ProviderTerminalEventBody
    | Omit<ProviderTerminalEventBody, 'kind'>
    | ProviderTerminalInput
    | Promise<
        ProviderTerminalEventBody | Omit<ProviderTerminalEventBody, 'kind'> | ProviderTerminalInput
      >,
): AsyncIterable<ProviderEventBody> {
  return streamProviderEvents(async (emit) => {
    const resolved = await terminal;
    if (
      !('kind' in resolved && resolved.kind === 'terminal') &&
      !('terminal' in resolved) &&
      (resolved.conversationRef !== undefined || resolved.nonResumable !== undefined)
    ) {
      emit({
        kind: 'continuity',
        conversationRef: resolved.conversationRef ?? null,
        resumable: resolved.nonResumable !== true,
        providerContinuity: null,
      });
    }
    emit(providerTerminalEvent(resolved));
  });
}

export async function collectProviderEvents(
  stream: AsyncIterable<ProviderEventBody>,
): Promise<ProviderEventBody[]> {
  const events: ProviderEventBody[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

export async function collectProviderTerminalEvent(
  stream: AsyncIterable<ProviderEventBody>,
): Promise<ProviderTerminalEventBody> {
  let terminal: ProviderTerminalEventBody | null = null;

  for await (const event of stream) {
    if (event.kind !== 'terminal') {
      continue;
    }

    if (terminal !== null) {
      throw new Error('Provider stream emitted multiple terminal events.');
    }
    terminal = event;
  }

  if (terminal === null) {
    throw new Error('Provider stream ended without a terminal event.');
  }

  return terminal;
}
