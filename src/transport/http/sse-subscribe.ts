import type { EventStreamBus, EventStreamEventMap } from '../server-ports.js';

export function subscribeAll<K extends keyof EventStreamEventMap>(
  bus: EventStreamBus,
  handlers: Partial<{ [E in K]: (data: EventStreamEventMap[E]) => void }>,
): () => void {
  const keys = Object.keys(handlers) as K[];
  for (const key of keys) {
    const handler = handlers[key];
    if (handler) bus.on(key, handler);
  }

  return () => {
    for (const key of keys) {
      const handler = handlers[key];
      if (handler) bus.off(key, handler);
    }
  };
}
