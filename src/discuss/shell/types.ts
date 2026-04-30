import type { PersistedDiscussSnapshot } from '../events.js';
import type { WatchEvent } from '../watch.js';
import type { DiscussSessionStore } from './session-store.js';
import type { EnvPort, IdPort, TimePort } from '../../runtime/ports.js';
import type { JobStatus } from '../../jobs/records.js';
import type { JobContinuitySnapshot } from '../../jobs/continuity.js';

export type AgentConfig = {
  name: string;
  persona: string;
  participation?: 'required' | 'observer';
  provider?: string;
  model?: string;
};

export type DiscussConfig = {
  min_bid_delay_ms?: number;
};

export type WatchSubscriber = (event: WatchEvent) => void;

export type WatchBuffer = {
  baseCursor: number;
  events: WatchEvent[];
};

export type LiveDiscussSession = {
  snapshot: PersistedDiscussSnapshot;
  controller: AbortController;
  watchSubscribers: Set<WatchSubscriber>;
  watchBuffer: WatchBuffer;
  abortEnded: boolean;
  loopState: { running: boolean };
};

export type DiscussJobStatusReader = {
  read(jobId: string): JobStatus | null;
};

export type DiscussRuntimePorts = {
  ids: Pick<IdPort, 'uuid'>;
  env: Pick<EnvPort, 'get'>;
  time: Pick<TimePort, 'now' | 'setTimeout' | 'clearTimeout'>;
};

export type DiscussLaunchDecision =
  | {
      status: 'running' | 'queued';
      job: string;
      session: string;
    }
  | {
      status: 'rejected';
      message: string;
      code?: string;
    };

export type DiscussWaitResult = {
  content: string;
  continuity: JobContinuitySnapshot | null;
};

export type DiscussService = {
  start(...args: unknown[]): Promise<DiscussLaunchDecision>;
  resume(...args: unknown[]): Promise<DiscussLaunchDecision>;
  waitStreamOnce(...args: unknown[]): Promise<DiscussWaitResult>;
};

export type DiscussContext = {
  projectRoot: string;
  sessions: Map<string, LiveDiscussSession>;
  service: DiscussService;
  store: DiscussSessionStore;
  runtime: DiscussRuntimePorts;
  jobStatusReader: DiscussJobStatusReader;
};
