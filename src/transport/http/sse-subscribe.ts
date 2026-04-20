import type { EventBusEvents, TypedEventBus } from '../../coordinator/event-bus.js';

export function subscribeAll<K extends keyof EventBusEvents>(
  bus: TypedEventBus,
  handlers: Partial<{ [E in K]: (data: EventBusEvents[E]) => void }>,
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
