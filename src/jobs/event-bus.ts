import type { JobPhase } from './phase.js';
import type { JobTerminal } from './views.js';

export type JobEventBusEvents = {
  'job:created': { jobId: string; sessionId: string; provider: string; projectRoot: string };
  'job:phase_changed': { jobId: string; phase: JobPhase; previousPhase: JobPhase };
  'job:progress': { jobId: string; eventId: number; message: string };
  'job:completed': {
    jobId: string;
    result: JobTerminal;
    costUsd?: number;
    tokenUsage?: {
      inputTokens?: number;
      outputTokens?: number;
    };
  };
  'session:released': { sessionId: string; jobId: string };
};

export interface JobEventBus {
  on<K extends keyof JobEventBusEvents>(event: K, listener: (payload: JobEventBusEvents[K]) => void): this;
  off<K extends keyof JobEventBusEvents>(event: K, listener: (payload: JobEventBusEvents[K]) => void): this;
  emit<K extends keyof JobEventBusEvents>(event: K, payload: JobEventBusEvents[K]): boolean;
}

class NoopJobEventBus implements JobEventBus {
  on<K extends keyof JobEventBusEvents>(
    _event: K,
    _listener: (payload: JobEventBusEvents[K]) => void,
  ): this {
    return this;
  }

  off<K extends keyof JobEventBusEvents>(
    _event: K,
    _listener: (payload: JobEventBusEvents[K]) => void,
  ): this {
    return this;
  }

  emit<K extends keyof JobEventBusEvents>(_event: K, _payload: JobEventBusEvents[K]): boolean {
    return false;
  }
}

export function createNoopJobEventBus(): JobEventBus {
  return new NoopJobEventBus();
}
