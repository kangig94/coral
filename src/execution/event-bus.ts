import { EventEmitter } from 'node:events';
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

/** Typed EventEmitter wrapper for execution-layer state changes. */
export class TypedEventBus {
  private readonly emitter = new EventEmitter({ captureRejections: false });

  constructor() {
    this.emitter.setMaxListeners(100);
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
    return this.emitter.emit(event, payload);
  }

  removeAllListeners(): this {
    this.emitter.removeAllListeners();
    return this;
  }
}

/** Singleton event bus for execution-layer state changes. */
export const eventBus = new TypedEventBus();
