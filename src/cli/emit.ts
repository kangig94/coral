import type { Command } from 'commander';

import { BackendToolHttpError } from '../transport/http/errors.js';
import type { AcceptedLaunchResponse } from '../jobs/launch.js';
import { buildErrorEnvelope } from './errors.js';
import { formatErrorEnvelope } from './format/error.js';
import { formatLaunch } from './format/jobs.js';
import { launchAndFollow } from './follow.js';
import { isJsonObject } from './parse.js';
import { clearPendingReadStoreNote, flushPendingReadStoreNote } from './read-store.js';
import type { AbortCapableClient } from './dispatch.js';
import { getPluginRoot } from './dispatch.js';

type CliOutputFormat = 'text' | 'json';

export function getOutputFormat(command: Command): CliOutputFormat {
  return command.optsWithGlobals<{ outputFormat?: string }>().outputFormat === 'json' ? 'json' : 'text';
}

export function getCliDisplayPrefix(argv: readonly string[] = process.argv): string {
  return argv[0]?.match(/node(\.exe)?$/) ? `node "${argv[1]}"` : (argv[0] ?? 'coral-cli');
}

export function emit<T>(result: T, outputFormat: CliOutputFormat, textFormatter?: (data: T) => string): void {
  const text = outputFormat === 'text' && textFormatter !== undefined ? textFormatter(result) : JSON.stringify(result);
  process.stdout.write(text + '\n');
  flushPendingReadStoreNote(outputFormat);
}

export function emitError(error: unknown): void {
  clearPendingReadStoreNote();
  const { envelope, exitCode } = buildErrorEnvelope(error);
  const statusCode = error instanceof BackendToolHttpError ? error.statusCode : undefined;
  process.stderr.write(formatErrorEnvelope(envelope, statusCode) + '\n');
  process.exitCode = exitCode;
}

export function isAcceptedLaunchResponse(value: unknown): value is AcceptedLaunchResponse {
  if (!isJsonObject(value) || typeof value.launchState !== 'string') {
    return false;
  }

  return (
    (value.launchState === 'running' || value.launchState === 'queued') &&
    typeof value.job === 'string' &&
    typeof value.session === 'string'
  );
}

export function emitAcceptedLaunchResponse(decision: AcceptedLaunchResponse): void {
  process.stdout.write(formatLaunch(decision) + '\n');
}

export function getTerminalContext(): { isTTY: boolean; columns: number } {
  return {
    isTTY: process.stdout.isTTY === true,
    columns: process.stdout.columns ?? 80,
  };
}

export async function handleLaunchResult(
  result: unknown,
  detach: boolean | undefined,
  client: AbortCapableClient,
): Promise<void> {
  if (!isAcceptedLaunchResponse(result)) {
    emitError(new Error(`Expected accepted launch response, received: ${JSON.stringify(result)}`));
    return;
  }

  if (detach) {
    emitAcceptedLaunchResponse(result);
    return;
  }

  // Successful follow returns the terminal job exit code (0-255).
  // Follow-level failures route through emitError and return the envelope exit code instead.
  process.exitCode = await launchAndFollow({
    launchResult: result,
    abortJob: async (jobId) => {
      await client.abortJobs([jobId]);
    },
    pluginRoot: getPluginRoot(),
    projectRoot: process.cwd(),
    emitError,
    ...getTerminalContext(),
  });
}
