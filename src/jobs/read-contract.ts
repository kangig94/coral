import type { JobExit, JobLaunch, JobRuntime, JobStatus } from './records.js';

export type JobProjectionDetail = {
  status: JobStatus | null;
  launch: JobLaunch | null;
  runtime: JobRuntime | null;
  exit: JobExit | null;
};
