import { setTimeout as delay } from 'node:timers/promises';

import { BackendToolHttpError } from '../transport/http/errors.js';
import type { AcceptedLaunchResponse } from '../transport/http/client.js';
import type { CauseRef } from '../causality/cause-ref.js';
import type { TerminalOutcome } from '../jobs/outcome.js';
import type { JobTerminal } from '../jobs/records.js';
import type { WaitStreamEvent } from '../jobs/wait.js';
import { parseSerializedWaitCursor, serializeWaitCursor } from '../jobs/wait.js';
import { HEALTH_TIMEOUT_MS } from '../transport/http/sse.js';
import { TransientHttpError, isTransientStreamError } from '../infra/http-errors.js';
import { assertNever } from '../infra/error-format.js';
import { isRecord } from '../infra/json.js';
import { ensure } from '../transport/ipc/ensure.js';
import { formatLaunch } from './format/jobs.js';
import { openCliCauseRefRenderer } from './cause-renderer.js';
import {
  formatWaitProgress,
  formatWaitQueued,
  formatWaitTerminal,
  formatWaitWaiting,
  renderWaitLine,
  type WaitRenderContext,
} from './format/wait.js';

const FOLLOW_TIMEOUT_SECONDS = 600;
const TRANSIENT_RETRY_LIMIT = 2;
const TRANSIENT_RETRY_DELAY_MS = 1_000;

type FollowLaunchDecision = AcceptedLaunchResponse;
type WaitCursorRef = { serializedCursor?: string };
type BackoffScheduler = (delayMs: number) => Promise<void>;

type FollowOptions = {
  launchResult: FollowLaunchDecision;
  abortJob: (jobId: string) => Promise<unknown>;
  pluginRoot: string;
  projectRoot: string;
  emitError: (error: unknown) => void;
  isTTY: boolean;
  columns: number;
  backoffScheduler?: BackoffScheduler;
};

function emitLaunch(decision: FollowLaunchDecision): void {
  process.stdout.write(formatLaunch(decision) + '\n');
}

function emitWaitEvent(
  event: WaitStreamEvent,
  cursor: string | null,
  renderContext: WaitRenderContext,
  renderCauseRef?: (ref: CauseRef, terminalOutcomeDiagnostic?: TerminalOutcome) => string,
): void {
  let line: string;
  switch (event.type) {
    case 'progress':
      line = formatWaitProgress(event);
      break;
    case 'queued':
      line = formatWaitQueued(event);
      break;
    case 'terminal':
      line = formatWaitTerminal(event, cursor, false, {
        describeCauseRef: renderCauseRef ? (ref) => renderCauseRef(ref, event.result.outcome) : undefined,
      });
      break;
    case 'waiting':
      line = formatWaitWaiting(event, cursor);
      break;
  }

  process.stdout.write(renderWaitLine(line, renderContext));
  if ((event.type === 'terminal' || event.type === 'waiting') && renderContext.isTTY) {
    process.stdout.write('\n');
  }
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

function waitSubscriptionStatusCode(body: Record<string, unknown>): number {
  switch (body.code) {
    case 'scope_mismatch':
      return 403;
    case 'jobs_not_found':
      return 404;
    case 'backend_recovering':
    case 'backend_shutting_down':
      return 503;
    default:
      return 400;
  }
}

function mapWaitSubscriptionError(error: unknown): unknown {
  if (!(error instanceof Error) || !isRecord(error.cause) || typeof error.cause.message !== 'string') {
    return error;
  }

  if (error.cause.code === 'backend_recovering' || error.cause.code === 'backend_shutting_down') {
    return new TransientHttpError(503, error.cause.message);
  }

  return new BackendToolHttpError(
    error.cause.message,
    waitSubscriptionStatusCode(error.cause),
    error.cause,
  );
}

export async function launchAndFollow(options: FollowOptions): Promise<number> {
  const renderContext: WaitRenderContext = {
    isTTY: options.isTTY,
    columns: options.columns,
  };
  const cursorRef: WaitCursorRef = {};
  const controller = new AbortController();
  let retriesLeft = TRANSIENT_RETRY_LIMIT;
  let localAbortRequested = false;
  let sigintCount = 0;
  let abortPromise: Promise<void> | null = null;
  const causeRenderer = openCliCauseRefRenderer(options.projectRoot);

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
        .then(() => options.abortJob(options.launchResult.job))
        .then(() => undefined, () => undefined);
  };

  emitLaunch(options.launchResult);
  process.on('SIGINT', onSigint);

  try {
    while (true) {
      if (localAbortRequested) {
        return 1;
      }

      let backend;
      try {
        backend = await ensure(options.pluginRoot);
      } catch (error) {
        if (localAbortRequested) {
          return 1;
        }

        options.emitError(error);
        return typeof process.exitCode === 'number' ? process.exitCode : 1;
      }

      if (localAbortRequested) {
        return 1;
      }

      try {
        let reconnect = false;
        const inputCursor = parseSerializedWaitCursor(cursorRef.serializedCursor);
        if (cursorRef.serializedCursor && !inputCursor) {
          throw new BackendToolHttpError('Invalid Last-Event-ID cursor', 400, {
            code: 'invalid_request',
            message: 'Invalid Last-Event-ID cursor',
          });
        }

        const subscription = await backend.subscribe<WaitStreamEvent>(
          'jobs.wait',
          {
            jobIds: [options.launchResult.job],
            timeoutSeconds: FOLLOW_TIMEOUT_SECONDS,
            projectRoot: options.projectRoot,
            ...(inputCursor ? { cursor: inputCursor } : {}),
          },
          {
            timeoutMs: HEALTH_TIMEOUT_MS,
            signal: controller.signal,
          },
        );

        try {
          const currentCursor = { afterSeq: inputCursor?.afterSeq ?? 0 };
          for await (const event of subscription) {
            if (event.type === 'progress' || event.type === 'terminal') {
              currentCursor.afterSeq = event.seq;
              cursorRef.serializedCursor = serializeWaitCursor(currentCursor);
            }

            const cursor = cursorRef.serializedCursor ?? null;
            emitWaitEvent(event, cursor, renderContext, causeRenderer.render);

            if (event.type === 'waiting') {
              reconnect = true;
              break;
            }

            if (event.type === 'terminal') {
              return toExitCode(event.result);
            }
          }
        } finally {
          await subscription.close();
        }

        if (reconnect) {
          continue;
        }

        options.emitError(new Error('wait stream ended without a terminal event'));
        return typeof process.exitCode === 'number' ? process.exitCode : 1;
      } catch (error) {
        if (localAbortRequested) {
          return 1;
        }

        const handledError = mapWaitSubscriptionError(error);
        if (!isTransientStreamError(handledError) || retriesLeft === 0) {
          options.emitError(handledError);
          return typeof process.exitCode === 'number' ? process.exitCode : 1;
        }

        retriesLeft -= 1;
        const shouldRetry = await waitForRetry(controller.signal, options.backoffScheduler);
        if (!shouldRetry || localAbortRequested) {
          return 1;
        }
      }
    }
  } finally {
    causeRenderer.close();
    process.off('SIGINT', onSigint);
    if (abortPromise !== null) {
      await (abortPromise as Promise<void>);
    }
  }
}
