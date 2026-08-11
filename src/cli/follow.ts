import { setTimeout as delay } from 'node:timers/promises';

import { BackendToolHttpError } from '../transport/http/errors.js';
import type { AcceptedLaunchResponse } from '../jobs/launch.js';
import type { CauseRef } from '../causality/cause-ref.js';
import type { TerminalOutcome } from '../jobs/outcome.js';
import type { JobTerminal } from '../jobs/records.js';
import { parseSerializedWaitCursor, serializeWaitCursor, type WaitCursor, type WaitStreamEvent } from '../jobs/wait.js';
import { advanceWaitRenderCursor, parseWaitStreamEventValue } from '../jobs/wait-stream-event.js';
import { HEALTH_TIMEOUT_MS } from '../transport/http/sse.js';
import { BackendUnreachableError, isTransientStreamError, TransientHttpError } from '../infra/http-errors.js';
import { assertNever } from '../infra/error-format.js';
import { isRecord } from '../infra/json.js';
import { ensure } from '../transport/ipc/ensure.js';
import { childPrincipalAuthFromEnv, childPrincipalAuthOptions } from '../transport/ipc/child-principal-auth.js';
import { runHandoff, type HandoffOutcome } from '../coordinator/handoff-runner.js';
import { formatLaunch } from './format/jobs.js';
import { openCliCauseRefRenderer } from './cause-renderer.js';
import { errorCodeToExit, WaitResumeError } from './errors.js';
import { renderHandoffNotice } from './handoff-notice.js';
import { mapWaitSubscriptionError } from './wait-stream-error.js';
import {
  formatWaitProgress,
  formatWaitQueued,
  formatWaitTerminal,
  formatWaitCarrierInterrupted,
  formatWaitWaiting,
  renderWaitLine,
  type WaitRenderContext,
} from './format/wait.js';

/**
 * A bounded wait has to finish inside the Bash tool's hard ceiling, which `clients/hooks/bash-rewrite.mjs`
 * pins at 600_000 ms — otherwise the process is killed at exactly the moment it is writing the final
 * `waiting` line and its resume cursor, and the caller loses both that cursor and the exit code. So the
 * ceiling is the input and the deadline is derived from it, rather than the two happening to differ by ten
 * seconds. The hook cannot import this (hooks stay self-contained), so the ceiling is restated there.
 */
const BASH_TOOL_TIMEOUT_CEILING_SECONDS = 600;
const WAIT_FLUSH_MARGIN_SECONDS = 10;
const FOLLOW_TIMEOUT_SECONDS = BASH_TOOL_TIMEOUT_CEILING_SECONDS - WAIT_FLUSH_MARGIN_SECONDS;
const TRANSIENT_RETRY_LIMIT = 2;
const TRANSIENT_RETRY_DELAY_MS = 1_000;

type BackoffScheduler = (delayMs: number) => Promise<void>;
type ReconnectPolicy = 'bounded' | 'until-terminal';

type FollowStart =
  | Readonly<{ kind: 'launch'; launchResult: AcceptedLaunchResponse }>
  | Readonly<{ kind: 'jobs'; jobIds: readonly string[]; serializedCursor?: string }>;

// `unknown`, not `WaitStreamEvent`: the wire carries whatever the coordinator's build emits, which can be
// a type this build predates. `followJobs` validates each item through `parseWaitStreamEventValue` before
// it becomes a `WaitStreamEvent` — this type stays honest about what actually crosses the boundary.
type WaitSubscription = AsyncIterable<unknown> & {
  close(): Promise<void>;
};

type FollowConnection =
  | Readonly<{ kind: 'subscription'; subscription: WaitSubscription }>
  | Readonly<{ kind: 'delegated'; outcome: HandoffOutcome }>
  | Readonly<{ kind: 'fatal-error'; error: unknown }>;

type FollowConnectionRequest = Readonly<{
  jobIds: readonly string[];
  cursor?: WaitCursor;
  timeoutSeconds: number;
  signal: AbortSignal;
}>;

type FollowJobsOptions = {
  start: FollowStart;
  reconnectPolicy: ReconnectPolicy;
  connect: (request: FollowConnectionRequest) => Promise<FollowConnection>;
  abortJobs: (jobIds: readonly string[]) => Promise<unknown>;
  projectRoot: string;
  emitError: (error: unknown) => void;
  render: WaitRenderContext & {
    embed: boolean;
    verbose: boolean;
  };
  backoffScheduler?: BackoffScheduler;
};

type FollowOptions = {
  launchResult: AcceptedLaunchResponse;
  abortJob: (jobId: string) => Promise<unknown>;
  pluginRoot: string;
  projectRoot: string;
  emitError: (error: unknown) => void;
  isTTY: boolean;
  columns: number;
  backoffScheduler?: BackoffScheduler;
};

function writeStdout(text: string): void {
  process.stdout.write(text);
}

function serializedCursor(cursor: WaitCursor): string | undefined {
  if (cursor.afterSeq === 0) {
    return undefined;
  }
  return serializeWaitCursor(cursor);
}

function jobIdsFromStart(start: FollowStart): readonly string[] {
  return start.kind === 'launch' ? [start.launchResult.jobId] : start.jobIds;
}

function initialSerializedCursor(start: FollowStart): string | undefined {
  return start.kind === 'jobs' ? start.serializedCursor : undefined;
}

function emitWaitEvent(
  event: WaitStreamEvent,
  cursor: string | null,
  jobLabels: ReadonlyMap<string, string> | null,
  resumeJobIds: readonly string[],
  renderOptions: FollowJobsOptions['render'],
  renderCauseRef?: (ref: CauseRef, terminalOutcomeDiagnostic?: TerminalOutcome) => string,
): void {
  let line: string;
  switch (event.type) {
    case 'progress':
      line = formatWaitProgress(event, jobLabels?.get(event.jobId));
      break;
    case 'queued':
      line = formatWaitQueued(event, jobLabels?.get(event.jobId));
      break;
    case 'terminal':
      line = formatWaitTerminal(event, cursor, renderOptions.embed, {
        describeCauseRef: renderCauseRef ? (ref) => renderCauseRef(ref, event.result.outcome) : undefined,
        verbose: renderOptions.verbose,
        exitCode: toExitCode(event.result),
      });
      break;
    case 'interrupted':
      line = formatWaitCarrierInterrupted(event);
      break;
    case 'waiting':
      line = formatWaitWaiting(event, cursor, resumeJobIds);
      break;
  }

  const trailingNewline = (event.type === 'terminal' || event.type === 'waiting') && renderOptions.isTTY ? '\n' : '';
  writeStdout(renderWaitLine(line, renderOptions) + trailingNewline);
}

function toExitCode(result: JobTerminal): number {
  switch (result.outcome.kind) {
    case 'aborted':
    case 'failed':
    case 'job_fault':
      return 1;
    case 'provider_exit':
      return normalizeExitCode(result.outcome.code);
    case 'completed':
      return 0;
    default:
      return assertNever(result.outcome);
  }
}

function normalizeExitCode(exitCode: number | null | undefined): number {
  if (exitCode === undefined) {
    return 0;
  }

  if (exitCode === null) {
    return 1;
  }

  if (!Number.isInteger(exitCode)) {
    return 1;
  }

  if (exitCode < 0 || exitCode > 255) {
    return 1;
  }

  return exitCode;
}

async function waitForRetry(signal: AbortSignal, backoffScheduler?: BackoffScheduler): Promise<boolean> {
  try {
    if (backoffScheduler) {
      await backoffScheduler(TRANSIENT_RETRY_DELAY_MS);
      return !signal.aborted;
    }

    await delay(TRANSIENT_RETRY_DELAY_MS, undefined, { signal });
    return true;
  } catch {
    return false;
  }
}

function fallbackExitCode(): number {
  return typeof process.exitCode === 'number' ? process.exitCode : 1;
}

function boundedTimeoutSeconds(deadlineMs: number): number {
  return Math.max(1, Math.ceil((deadlineMs - Date.now()) / 1_000));
}

function withWaitRecovery(error: unknown, jobIds: readonly string[]): unknown {
  const body = error instanceof BackendToolHttpError && isRecord(error.body) ? error.body : null;
  if (!(error instanceof BackendUnreachableError) && body?.code !== 'backend_unreachable') {
    return error;
  }

  const message = body !== null && typeof body.message === 'string' ? body.message : (error as Error).message;
  return new BackendUnreachableError(
    `${message} Run \`coral-cli backend status\` and follow its recovery guidance, then rerun ` +
      `\`coral-cli wait jobs ${jobIds.join(' ')}\` to continue waiting.`,
  );
}

export async function followJobs(options: FollowJobsOptions): Promise<number> {
  const allJobIds = [...jobIdsFromStart(options.start)];
  const rawCursor = initialSerializedCursor(options.start);
  const parsedCursor = parseSerializedWaitCursor(rawCursor);
  if (rawCursor && !parsedCursor) {
    options.emitError(
      mapWaitSubscriptionError(
        new BackendToolHttpError('Invalid Last-Event-ID cursor', 400, {
          code: 'invalid_request',
          message: 'Invalid Last-Event-ID cursor',
        }),
      ),
    );
    return fallbackExitCode();
  }

  const currentCursor: WaitCursor = parsedCursor ?? { afterSeq: 0 };
  const controller = new AbortController();
  const jobLabels = allJobIds.length > 1 ? new Map(allJobIds.map((id, index) => [id, `j${index}`])) : null;
  const deadlineMs = Date.now() + FOLLOW_TIMEOUT_SECONDS * 1_000;
  const causeRenderer = openCliCauseRefRenderer(options.projectRoot);
  let remainingJobIds = allJobIds;
  let sendCursor = rawCursor !== undefined;
  let retriesLeft = TRANSIENT_RETRY_LIMIT;
  let hasOpenedSubscription = false;
  let localAbortRequested = false;
  let sigintCount = 0;
  let abortPromise: Promise<void> | null = null;

  const onSigint = () => {
    sigintCount += 1;
    if (sigintCount === 1) {
      process.stderr.write('\nPress Ctrl+C again to abort the job.\n');
      return;
    }

    if (localAbortRequested) {
      return;
    }

    localAbortRequested = true;
    controller.abort();
    abortPromise =
      abortPromise ??
      Promise.resolve()
        .then(() => options.abortJobs(allJobIds))
        .then(
          () => undefined,
          () => undefined,
        );
  };

  if (options.start.kind === 'launch') {
    writeStdout(formatLaunch(options.start.launchResult) + '\n');
  }
  process.on('SIGINT', onSigint);

  try {
    followLoop: while (true) {
      if (localAbortRequested) {
        return 1;
      }

      if (remainingJobIds.length === 0) {
        return 0;
      }

      if (options.reconnectPolicy === 'bounded' && Date.now() >= deadlineMs) {
        const waitingEvent: Extract<WaitStreamEvent, { type: 'waiting' }> = {
          type: 'waiting',
          waitingJobIds: remainingJobIds,
        };
        emitWaitEvent(
          waitingEvent,
          serializeWaitCursor(currentCursor),
          jobLabels,
          remainingJobIds,
          options.render,
          causeRenderer.render,
        );
        return errorCodeToExit('transient');
      }

      let connection: FollowConnection;
      try {
        connection = await options.connect({
          jobIds: remainingJobIds,
          ...(sendCursor || currentCursor.afterSeq > 0 ? { cursor: { afterSeq: currentCursor.afterSeq } } : {}),
          timeoutSeconds:
            options.reconnectPolicy === 'bounded' ? boundedTimeoutSeconds(deadlineMs) : FOLLOW_TIMEOUT_SECONDS,
          signal: controller.signal,
        });
      } catch (error) {
        if (localAbortRequested) {
          return 1;
        }

        const handledError = mapWaitSubscriptionError(error);
        if (!(handledError instanceof Error) || !isTransientStreamError(handledError)) {
          options.emitError(withWaitRecovery(handledError, remainingJobIds));
          return fallbackExitCode();
        }
        if (retriesLeft === 0) {
          if (hasOpenedSubscription || handledError instanceof TransientHttpError) {
            options.emitError(
              new WaitResumeError(
                handledError.message,
                remainingJobIds,
                hasOpenedSubscription ? serializeWaitCursor(currentCursor) : undefined,
              ),
            );
            return errorCodeToExit('transient');
          }
          options.emitError(withWaitRecovery(handledError, remainingJobIds));
          return fallbackExitCode();
        }

        retriesLeft -= 1;
        const shouldRetry = await waitForRetry(controller.signal, options.backoffScheduler);
        if (!shouldRetry || localAbortRequested) {
          return 1;
        }
        continue;
      }

      if (localAbortRequested) {
        return 1;
      }

      if (connection.kind === 'fatal-error') {
        options.emitError(withWaitRecovery(connection.error, remainingJobIds));
        return fallbackExitCode();
      }

      if (connection.kind === 'delegated') {
        const { outcome } = connection;

        if (localAbortRequested) {
          return 1;
        }
        if (outcome.kind === 'handoff-success') {
          renderHandoffNotice(outcome);
          return 0;
        }
        if (outcome.kind === 'handoff-exit') {
          return normalizeExitCode(outcome.exitCode);
        }
        if (outcome.signal === 'SIGINT' && sigintCount === 1) {
          continue followLoop;
        }
        options.emitError(
          new WaitResumeError(
            `Delegated wait command ended from signal ${outcome.signal}; the jobs may still be running.`,
            remainingJobIds,
            serializeWaitCursor(currentCursor),
          ),
        );
        return errorCodeToExit('transient');
      }

      hasOpenedSubscription = true;
      let reconnect = false;
      try {
        for await (const raw of connection.subscription) {
          const event = parseWaitStreamEventValue(raw);
          if (event === null) {
            // Unrecognized event type: a newer coordinator emitted something this build predates.
            // Cross-version tolerance means skipping it, not crashing the wait — the stream stays open.
            continue;
          }

          const decision = advanceWaitRenderCursor(currentCursor, event);
          currentCursor.afterSeq = decision.cursor.afterSeq;
          sendCursor ||= currentCursor.afterSeq > 0;

          if (decision.shouldRender) {
            const cursor =
              serializedCursor(currentCursor) ??
              (event.type === 'waiting' && options.reconnectPolicy === 'bounded'
                ? serializeWaitCursor(currentCursor)
                : null);
            emitWaitEvent(
              event,
              cursor,
              jobLabels,
              event.type === 'waiting' ? event.waitingJobIds : remainingJobIds,
              options.render,
              causeRenderer.render,
            );
          }

          if (event.type === 'terminal') {
            const exitCode = toExitCode(event.result);
            if (exitCode !== 0) {
              return exitCode;
            }
            remainingJobIds = [...event.remainingJobIds];
            if (remainingJobIds.length === 0) {
              return 0;
            }
            reconnect = true;
            break;
          }

          if (event.type === 'waiting') {
            remainingJobIds = [...event.waitingJobIds];
            if (remainingJobIds.length === 0) {
              return 0;
            }
            if (options.reconnectPolicy === 'bounded') {
              return errorCodeToExit('transient');
            }
            reconnect = true;
            break;
          }
        }
      } catch (error) {
        if (localAbortRequested) {
          return 1;
        }

        const handledError = mapWaitSubscriptionError(error);
        if (!(handledError instanceof Error) || !isTransientStreamError(handledError)) {
          options.emitError(withWaitRecovery(handledError, remainingJobIds));
          return fallbackExitCode();
        }
        if (retriesLeft === 0) {
          options.emitError(
            new WaitResumeError(handledError.message, remainingJobIds, serializeWaitCursor(currentCursor)),
          );
          return errorCodeToExit('transient');
        }

        retriesLeft -= 1;
        const shouldRetry = await waitForRetry(controller.signal, options.backoffScheduler);
        if (!shouldRetry || localAbortRequested) {
          return 1;
        }
        reconnect = true;
      } finally {
        await connection.subscription.close();
      }

      if (reconnect) {
        continue;
      }

      options.emitError(
        new WaitResumeError(
          'The wait stream ended before a terminal event; the jobs may still be running.',
          remainingJobIds,
          serializeWaitCursor(currentCursor),
        ),
      );
      return errorCodeToExit('transient');
    }
  } finally {
    causeRenderer.close();
    process.off('SIGINT', onSigint);
    if (abortPromise !== null) {
      await (abortPromise as Promise<void>);
    }
  }
}

export async function launchAndFollow(options: FollowOptions): Promise<number> {
  const ipcAuthOptions = childPrincipalAuthOptions(childPrincipalAuthFromEnv());

  return followJobs({
    start: { kind: 'launch', launchResult: options.launchResult },
    reconnectPolicy: 'until-terminal',
    projectRoot: options.projectRoot,
    emitError: options.emitError,
    render: {
      isTTY: options.isTTY,
      columns: options.columns,
      embed: false,
      verbose: false,
    },
    abortJobs: async (jobIds) => {
      await Promise.all(jobIds.map((jobId) => options.abortJob(jobId)));
    },
    connect: async ({ jobIds, cursor, timeoutSeconds, signal }) => {
      let backend;
      try {
        backend = await ensure(options.pluginRoot);
        const continuation = await runHandoff(
          {
            kind: 'wait-jobs',
            jobId: options.launchResult.jobId,
            serializedCursor: serializeWaitCursor(cursor ?? { afterSeq: 0 }),
          },
          { pluginRoot: options.pluginRoot, signal },
        );
        if (continuation.kind === 'delegated') {
          return continuation;
        }
      } catch (error) {
        return { kind: 'fatal-error', error };
      }

      return {
        kind: 'subscription',
        // Wire boundary: see `WaitSubscription`'s definition — validation happens once the item is pulled
        // from the iterator, not here.
        subscription: await backend.subscribe<unknown>(
          'jobs.wait',
          {
            jobIds: [...jobIds],
            timeoutSeconds,
            projectRoot: options.projectRoot,
            ...(cursor ? { cursor } : {}),
            // `emitWaitEvent` above has a case for `interrupted`; declaring that here is what lets a
            // coordinator new enough to derive it actually put one on the wire.
            supportsInterrupted: true,
          },
          {
            timeoutMs: HEALTH_TIMEOUT_MS,
            signal,
            ...ipcAuthOptions,
          },
        ),
      };
    },
    ...(options.backoffScheduler ? { backoffScheduler: options.backoffScheduler } : {}),
  });
}
