import { errorMessage } from '../../infra/error-format.js';

export class TerminalWriteError extends Error {
  readonly jobId: string;
  readonly cause: unknown;
  constructor(jobId: string, cause: unknown) {
    super(`Failed to append terminal event for ${jobId}: ${errorMessage(cause)}`);
    this.jobId = jobId;
    this.cause = cause;
    this.name = 'TerminalWriteError';
  }
}
