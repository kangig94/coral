import { EventEmitter } from 'node:events';
import type { DiscussEventBusEvents } from '../discuss/event-bus.js';
import { backendLog } from '../infra/backend-log.js';
import type { JobEventBusEvents } from '../jobs/event-bus.js';
import type { SessionEventBusEvents } from '../sessions/event-bus.js';

export type EventBusEvents = JobEventBusEvents & SessionEventBusEvents & DiscussEventBusEvents;

const MAX_EVENT_BUS_LISTENERS = 100;

export class TypedEventBus {
  private readonly emitter = new EventEmitter({ captureRejections: false });

  constructor() {
    this.emitter.setMaxListeners(MAX_EVENT_BUS_LISTENERS);
  }

  on<K extends keyof EventBusEvents>(event: K, listener: (payload: EventBusEvents[K]) => void): this {
    this.emitter.on(event, listener);
    return this;
  }

  off<K extends keyof EventBusEvents>(event: K, listener: (payload: EventBusEvents[K]) => void): this {
    this.emitter.off(event, listener);
    return this;
  }

  emit<K extends keyof EventBusEvents>(event: K, payload: EventBusEvents[K]): boolean {
    const listeners = this.emitter.listeners(event) as Array<(value: EventBusEvents[K]) => unknown>;
    if (listeners.length === 0) {
      return false;
    }

    for (const listener of listeners) {
      try {
        const result = listener(payload);
        if (result instanceof Promise) {
          void result.catch((error: unknown) => {
            backendLog.error(`EventBus listener for ${String(event)} failed`, error);
          });
        }
      } catch (error: unknown) {
        backendLog.error(`EventBus listener for ${String(event)} failed`, error);
      }
    }

    return true;
  }

  removeAllListeners(): this {
    this.emitter.removeAllListeners();
    return this;
  }

  reset(): this {
    return this.removeAllListeners();
  }
}
