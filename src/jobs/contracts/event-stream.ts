export type JobCreatedEvent =
  | { kind: 'provider'; jobId: string; conversationJobId: string; provider: string; projectRoot: string }
  | { kind: 'workflow'; jobId: string; workflowId: string; projectRoot: string }
  | { kind: 'kb'; jobId: string; systemTaskId: string; projectRoot: string };
