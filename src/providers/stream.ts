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
