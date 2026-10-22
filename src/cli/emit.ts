import { Option } from 'commander';
import type { Command } from 'commander';

import { HandoffRunError } from '../coordinator/handoff-routing/runner.js';
import { BackendToolHttpError } from '../transport/http/errors.js';
import { acceptedLaunchResponseSchema, type AcceptedLaunchResponse } from '../jobs/launch.js';
import { getWaitInvocation } from './wait-invocation.js';
import { WaitResumeError, buildErrorEnvelope } from './errors.js';
import { formatErrorEnvelope } from './format/error.js';
import { formatDetachedLaunchStatus, formatLaunchWaitHint, formatUnknownLaunchOutcome } from './format/jobs.js';
import { launchAndFollow } from './follow.js';
import { renderHandoffPublicationIncidents } from './handoff-notice.js';
import { clearPendingReadStoreNote, flushPendingReadStoreNote } from './read-store.js';
import { getPluginRoot } from './dispatch.js';

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
  if (originalError instanceof WaitResumeError) getWaitInvocation()?.markContinuationPrinted();
  process.exitCode = exitCode;
}

export function isAcceptedLaunchResponse(value: unknown): value is AcceptedLaunchResponse {
  return acceptedLaunchResponseSchema.safeParse(value).success;
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

export async function handleLaunchResult(result: unknown, detach: boolean | undefined): Promise<void> {
  if (!isAcceptedLaunchResponse(result)) {
    process.stderr.write(formatUnknownLaunchOutcome({ kind: 'launch-outcome-unknown' }) + '\n');
    process.exitCode = 75;
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
    pluginRoot: getPluginRoot(),
    projectRoot: process.cwd(),
    emitError,
    ...getTerminalContext(),
  });
}
