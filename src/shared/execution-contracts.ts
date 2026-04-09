import type { WorkflowCheckpoint } from './types.js';

export type AbortResult = {
  aborted: string[];
  notFound: string[];
};

export interface WorkflowCheckpointWriter {
  writeWorkflowCheckpoint(jobId: string, checkpoint: WorkflowCheckpoint): void;
}
