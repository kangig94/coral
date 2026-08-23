import { Option } from 'commander';
import type { Command } from 'commander';

import { HandoffRunError } from '../coordinator/handoff-runner.js';
import { BackendToolHttpError } from '../transport/http/errors.js';
import type { AcceptedLaunchResponse } from '../jobs/launch.js';
import { buildErrorEnvelope } from './errors.js';
import { formatErrorEnvelope } from './format/error.js';
import { formatDetachedLaunchStatus, formatLaunchWaitHint } from './format/jobs.js';
import { launchAndFollow } from './follow.js';
import { renderHandoffPublicationIncidents } from './handoff-notice.js';
import { isJsonObject } from './parse.js';
import { clearPendingReadStoreNote, flushPendingReadStoreNote } from './read-store.js';
import { type AbortCapableClient, getPluginRoot } from './dispatch.js';

type CliOutputFormat = 'text' | 'json';

/**
 * Register it ONLY on commands whose response is meant for machine consumption (search, list,
 * read, diagnose). Mutate commands intentionally omit it so future agents
 * cannot "discover" a JSON affordance and propagate it across write ops —
 * a leaky JSON response would expose internal `path` fields the text
 * formatter deliberately hides.
 */
export function createOutputFormatOption(): Option {
  return new Option('-f, --output-format <format>', 'Output format').choices(['text', 'json']).default('text');
}

export function getOutputFormat(command: Command): CliOutputFormat {
  return command.optsWithGlobals<{ outputFormat?: string }>().outputFormat === 'json' ? 'json' : 'text';
}

export function getCliDisplayPrefix(argv: readonly string[] = process.argv): string {
  const executable = argv[0];
  if (executable?.match(/node(\.exe)?$/)) {
    return `node "${argv[1]}"`;
  }
  return executable ?? 'coral-cli';
}

export function emit<T>(result: T, outputFormat: CliOutputFormat, textFormatter?: (data: T) => string): void {
  const text = outputFormat === 'text' && textFormatter !== undefined ? textFormatter(result) : JSON.stringify(result);
  process.stdout.write(text + '\n');
  flushPendingReadStoreNote(outputFormat);
}

/**
 * Always-text emitter for mutate commands. Use this instead of `emit` when
 * the command does NOT register `--output-format` — keeping the call sites
 * uniformly JSON-free signals intent to future agents.
 */
export function emitText<T>(result: T, textFormatter: (data: T) => string): void {
  process.stdout.write(textFormatter(result) + '\n');
  flushPendingReadStoreNote('text');
}

export function emitError(error: unknown): void {
  clearPendingReadStoreNote();
  const originalError = error instanceof HandoffRunError ? error.originalError : error;
  if (error instanceof HandoffRunError) {
    renderHandoffPublicationIncidents(error.incidents);
  }
  const { envelope, exitCode } = buildErrorEnvelope(originalError);
  const statusCode = originalError instanceof BackendToolHttpError ? originalError.statusCode : undefined;
  process.stderr.write(formatErrorEnvelope(envelope, statusCode) + '\n');
  process.exitCode = exitCode;
}

export function isAcceptedLaunchResponse(value: unknown): value is AcceptedLaunchResponse {
  if (!isJsonObject(value) || typeof value.launchState !== 'string') {
    return false;
  }

  if (
    (value.launchState !== 'running' && value.launchState !== 'queued') ||
    typeof value.jobId !== 'string' ||
    value.jobId.length === 0
  ) {
    return false;
  }

  if (value.kind === 'provider-session') {
    return (
      typeof value.sessionId === 'string' &&
      value.sessionId.length > 0 &&
      Object.keys(value).every((key) => ['kind', 'launchState', 'jobId', 'sessionId'].includes(key))
    );
  }

  return (
    value.kind === 'workflow' &&
    typeof value.workflowId === 'string' &&
    value.workflowId.length > 0 &&
    Object.keys(value).every((key) => ['kind', 'launchState', 'jobId', 'workflowId'].includes(key))
  );
}

function emitAcceptedLaunchResponse(decision: AcceptedLaunchResponse): void {
  process.stdout.write(`${formatDetachedLaunchStatus(decision)}\n${formatLaunchWaitHint(decision)}\n`);
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
