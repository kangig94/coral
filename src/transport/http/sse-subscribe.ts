export interface TypedEventBus {
  on(event: string, listener: (payload: unknown) => void): unknown;
  off(event: string, listener: (payload: unknown) => void): unknown;
}

// AC10b requires the public helper to accept arbitrary bus payload handlers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function subscribeAll<T extends Record<string, (data: any) => void>>(
  bus: TypedEventBus,
  handlers: Partial<T>,
): () => void {
  const subscriptions: Array<[string, (data: unknown) => void]> = [];

  for (const key of Object.keys(handlers) as Array<keyof T & string>) {
    const handler = handlers[key];
    if (!handler) continue;

    const listener = handler as (data: unknown) => void;
    subscriptions.push([key, listener]);
    bus.on(key, listener);
  }

  return () => {
    for (const [key, listener] of subscriptions) {
      bus.off(key, listener);
    }
  };
}
