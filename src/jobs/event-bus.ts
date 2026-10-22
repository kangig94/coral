import type { JobProgressTiming } from './event-bodies.js';
import type { JobPhase } from './phase.js';
import type { JobTerminal } from './records.js';
import type { JobLaunchRequestBody } from './launch.js';
import type { JobCreatedEvent } from './contracts/event-stream.js';

export function jobCreatedEvent(jobId: string, launch: JobLaunchRequestBody): JobCreatedEvent {
  if (launch.jobKind === 'provider') {
    return {
      kind: 'provider',
      jobId,
      conversationJobId: launch.conversationJobId,
      provider: launch.provider,
      projectRoot: launch.projectRoot,
    };
  }
  if (launch.jobKind === 'workflow') {
    if (launch.owner.kind !== 'workflow') {
      throw new Error(`Workflow job '${jobId}' has a non-workflow execution owner.`);
    }
    return {
      kind: 'workflow',
      jobId,
      workflowId: launch.owner.id,
      projectRoot: launch.projectRoot,
    };
  }
  if (launch.owner.kind !== 'system-task') {
    throw new Error(`KB job '${jobId}' has a non-system-task execution owner.`);
  }
  return {
    kind: 'kb',
    jobId,
    systemTaskId: launch.owner.id,
    projectRoot: launch.projectRoot,
  };
}

export type JobEventBusEvents = {
  'job:created': JobCreatedEvent;
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

type JobObservedEvents = JobEventBusEvents;

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
