export type JobOperatorRemedy =
  | Readonly<{ kind: 'abort-job'; jobId: string }>
  | Readonly<{ kind: 'jobs-detail'; jobId: string }>;
