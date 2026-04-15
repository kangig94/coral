import { EventEmitter } from 'node:events';
import { backendLog } from '../shared/backend-log.js';
import type { JobPhase, TerminalResult } from '../shared/types.js';

/** Events emitted by the execution-layer event bus. */
export type EventBusEvents = {
  'job:created': { jobId: string; sessionId: string; provider: string; projectRoot: string };
  'job:phase_changed': { jobId: string; phase: JobPhase; previousPhase: JobPhase };
  'job:progress': { jobId: string; eventId: number; message: string };
  'job:completed': {
    jobId: string;
    result: TerminalResult;
    costUsd?: number;
    tokenUsage?: {
      inputTokens?: number;
      outputTokens?: number;
    };
  };
  'session:updated': { sessionId: string; shardHash: string; version: number; projectRoot?: string };
  'discuss:updated': { projectRoot: string; sessionId: string; lastSeq: number; status: string };
};

const MAX_EVENT_BUS_LISTENERS = 100;

/** Typed EventEmitter wrapper for execution-layer state changes. */
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
    const listeners = this.emitter.listeners(event) as Array<(payload: EventBusEvents[K]) => unknown>;
    if (listeners.length === 0) return false;

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

  /** Remove all listeners and reset max listener count. For test isolation. */
  reset(): this {
    this.emitter.removeAllListeners();
    this.emitter.setMaxListeners(MAX_EVENT_BUS_LISTENERS);
    return this;
  }
}

export function createEventBus(): TypedEventBus {
  return new TypedEventBus();
}
