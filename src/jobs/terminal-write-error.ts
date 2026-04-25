import { errorMessage } from '../infra/error-format.js';

export class TerminalWriteError extends Error {
  constructor(
    readonly jobId: string,
    readonly cause: unknown,
  ) {
    super(`Failed to append terminal event for ${jobId}: ${errorMessage(cause)}`);
    this.name = 'TerminalWriteError';
  }
}
