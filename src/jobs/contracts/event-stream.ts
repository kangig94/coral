export type JobCreatedEvent =
  | { kind: 'provider'; jobId: string; provider: string; projectRoot: string }
  | { kind: 'workflow'; jobId: string; workflowId: string; projectRoot: string }
  | { kind: 'kb'; jobId: string; systemTaskId: string; projectRoot: string };
