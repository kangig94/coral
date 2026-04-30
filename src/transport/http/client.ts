import type { BackendHealth } from './backend/health.js';
import { isBackendHealth } from './backend/health.js';
import type { DiscussSummaryDto } from '../../discuss/read-contract.js';
import type { JobProgress, JobStatus } from '../../jobs/records.js';

export type AcceptedLaunchResponse = {
  session: string;
  job: string;
  launchState: 'running' | 'queued';
};

export type SessionCreateResponse = AcceptedLaunchResponse;
export type SessionMessageResponse = AcceptedLaunchResponse;
export type SessionForkResponse = AcceptedLaunchResponse;
export type WorkflowLaunchResponse = AcceptedLaunchResponse;

export type JobsListResponse = {
  jobs: Array<{ jobId: string; status: JobStatus }>;
};

export type JobDetailResponse = {
  status: JobStatus;
  events: JobProgress[];
};

export type DiscussStartResponse = {
  session: string;
};

export type DiscussAbortResponse = {
  ok: true;
  session: string;
};

export type DiscussSessionsListResponse = {
  sessions: DiscussSummaryDto[];
};

export type KbMemoResponse = {
  filename: string;
  path: string;
};

export type KbPromoteResponse = {
  path: string;
};

export type KbUpdateResponse = {
  path: string;
};

export type KbDeleteResponse = {
  deleted: string;
};

export type KbSourceImportResponse = {
  status: 'completed';
  job: string;
  readiness: 'commit' | 'base-search' | 'active-vector' | 'all-equipped';
  slug: string;
  path: string;
} | {
  status: 'running' | 'queued';
  job: string;
  readiness: 'commit' | 'base-search' | 'active-vector' | 'all-equipped';
};

export type KbSourceDeleteResponse = {
  deleted: string;
};

export { isBackendHealth };
export type { BackendHealth };
export { BackendToolHttpError } from './errors.js';
export type { InvocationContext } from '../../runtime/invocation-context.js';
