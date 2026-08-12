import type { PersistedDiscussSnapshot } from '../events.js';
import type { WatchEvent } from '../watch.js';
import type { DiscussSessionStore } from './session-store.js';
import type { EnvPort, StoragePort, TimePort } from '../../infra/port-types.js';
import type { IdPort } from '../../runtime/ports.js';
import type { JobExit, JobStatus } from '../../jobs/records.js';
import type { JobLaunch } from '../../jobs/records.js';
import type { ContinuitySnapshot } from '../../sessions/continuity.js';
import type { ProviderBindingCatalog } from '../../providers/catalog.js';
import type { JobLaunchRequest, JobResumeRequest, ProviderSessionLaunchDecision } from '../../jobs/launch.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type { CanonicalWorkDir } from '../../runtime/canonical-work-dir.js';

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
  readExit(jobId: string): JobExit | null;
  listOwned(discussionId: string): Array<{ launch: JobLaunch; status: JobStatus }>;
};

export type DiscussRuntimePorts = {
  ids: Pick<IdPort, 'uuid'>;
  env: Pick<EnvPort, 'get'>;
  time: Pick<TimePort, 'now' | 'setTimeout' | 'clearTimeout'>;
  storage: Pick<StoragePort, 'mkdirSync' | 'writeAtomicSync'>;
  /** Resolves a project's data dir (`runtime.paths.projectData`); where the completed-discussion record is written. */
  projectData: (projectRoot: string) => string;
};

export type DiscussLaunchDecision = ProviderSessionLaunchDecision;

export type DiscussWaitResult = {
  content: string;
  continuity: ContinuitySnapshot | null;
};

export type DiscussService = {
  start(provider: string, input: JobLaunchRequest, ctx: InvocationContext): Promise<DiscussLaunchDecision>;
  resume(provider: string, input: JobResumeRequest, ctx: InvocationContext): Promise<DiscussLaunchDecision>;
  waitStreamOnce(jobId: string, timeoutMs?: number): Promise<DiscussWaitResult>;
};

export type DiscussContext = {
  projectRoot: CanonicalWorkDir;
  sessions: Map<string, LiveDiscussSession>;
  service: DiscussService;
  store: DiscussSessionStore;
  runtime: DiscussRuntimePorts;
  jobStatusReader: DiscussJobStatusReader;
  providerRegistry: ProviderBindingCatalog;
  /**
   * Discards a participant session's provider native log. Wired from the lifecycle
   * reactor at composition; absent in lightweight harnesses, so callers guard with `?.`.
   */
  discardSessionArtifacts?: (sessionId: string) => Promise<void>;
};
