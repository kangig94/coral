import type { SessionEventBusEvents } from '../sessions/event-bus.js';
import type { JobProgressTiming } from './event-bodies.js';
import type { JobPhase } from './phase.js';
import type { JobTerminal } from './records.js';

export type JobEventBusEvents = {
  'job:created': { jobId: string; sessionId: string; provider: string; projectRoot: string };
  'job:phase_changed': { jobId: string; phase: JobPhase; previousPhase: JobPhase };
  'job:progress': { jobId: string; seq: number; message: string; timing: JobProgressTiming };
  'job:completed': {
    jobId: string;
    result: JobTerminal;
    costUsd?: number;
    tokenUsage?: {
      inputTokens?: number;
      outputTokens?: number;
    };
  };
};

// JobStore listens for session releases to drive wait-stream completion. The
// event itself is owned by the sessions domain; the bus surface accepts the
// union of slices that jobs subscribers actually observe.
type JobObservedEvents = JobEventBusEvents & Pick<SessionEventBusEvents, 'session:released'>;

export interface JobEventBus {
  on<K extends keyof JobObservedEvents>(event: K, listener: (payload: JobObservedEvents[K]) => void): this;
  off<K extends keyof JobObservedEvents>(event: K, listener: (payload: JobObservedEvents[K]) => void): this;
  emit<K extends keyof JobObservedEvents>(event: K, payload: JobObservedEvents[K]): boolean;
}

class NoopJobEventBus implements JobEventBus {
  on<K extends keyof JobObservedEvents>(_event: K, _listener: (payload: JobObservedEvents[K]) => void): this {
    return this;
  }

  off<K extends keyof JobObservedEvents>(_event: K, _listener: (payload: JobObservedEvents[K]) => void): this {
    return this;
  }

  emit<K extends keyof JobObservedEvents>(_event: K, _payload: JobObservedEvents[K]): boolean {
    return false;
  }
}

export function createNoopJobEventBus(): JobEventBus {
  return new NoopJobEventBus();
}
