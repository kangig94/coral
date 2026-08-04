import { setTimeout as delay } from 'node:timers/promises';

import { BackendToolHttpError } from '../transport/http/errors.js';
import type { AcceptedLaunchResponse } from '../jobs/launch.js';
import type { CauseRef } from '../causality/cause-ref.js';
import type { TerminalOutcome } from '../jobs/outcome.js';
import type { JobTerminal } from '../jobs/records.js';
import type { WaitStreamEvent } from '../jobs/wait.js';
import {
  advanceWaitRenderCursor,
  parseWaitRenderCursor,
  serializeWaitRenderCursor,
  type WaitRenderCursor,
} from '../jobs/wait-stream-event.js';
import { HEALTH_TIMEOUT_MS } from '../transport/http/sse.js';
import { isTransientStreamError } from '../infra/http-errors.js';
import { assertNever } from '../infra/error-format.js';
import type { BackendRoutingResult } from '../infra/backend-routing.js';
import { ensure } from '../transport/ipc/ensure.js';
import { childPrincipalAuthFromEnv, childPrincipalAuthOptions } from '../transport/ipc/child-principal-auth.js';
import { resolveCliHandoffRouting, runHandoff } from '../coordinator/handoff-runner.js';
import { createRealRuntime } from '../runtime/real.js';
import { formatLaunch } from './format/jobs.js';
import { openCliCauseRefRenderer } from './cause-renderer.js';
import { renderHandoffNotice } from './handoff-notice.js';
import { mapWaitSubscriptionError } from './wait-stream-error.js';
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
export const STABLE_SNAPSHOT_ACK_TIMEOUT_MS = 3_000;

type WaitCursorRef = { serializedCursor?: string };
type BackoffScheduler = (delayMs: number) => Promise<void>;

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

function writeStdout(text: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let writeReturned = false;
    let callbackComplete = false;
    let drainComplete = false;
    let needsDrain = false;

    const finish = (): void => {
      if (writeReturned && callbackComplete && (!needsDrain || drainComplete)) {
        resolve(true);
      }
    };

    const accepted = process.stdout.write(text, (error) => {
      if (error) {
        resolve(false);
        return;
      }
      callbackComplete = true;
      finish();
    });
    needsDrain = !accepted;
    drainComplete = accepted;
    writeReturned = true;

    if (!accepted) {
      process.stdout.once('drain', () => {
        drainComplete = true;
        finish();
      });
    }
    finish();
  });
}

function appendStdoutAcknowledgement(
  current: Promise<boolean>,
  next: Promise<boolean>,
  acknowledge?: () => void,
): Promise<boolean> {
  return Promise.all([current, next]).then(([currentStable, nextStable]) => {
    const stable = currentStable && nextStable;
    if (stable) {
      acknowledge?.();
    }
    return stable;
  });
}

async function isStdoutSnapshotStable(acknowledgement: Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return false;
  }

  const timeoutController = new AbortController();
  const onAbort = (): void => timeoutController.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([
      acknowledgement,
      delay(STABLE_SNAPSHOT_ACK_TIMEOUT_MS, false, { signal: timeoutController.signal, ref: false }).catch(() => false),
    ]);
  } finally {
    signal.removeEventListener('abort', onAbort);
    timeoutController.abort();
  }
}

function serializedCursor(cursor: WaitRenderCursor): string | undefined {
  if (cursor.afterSeq === 0 && (cursor.snapshotAcks?.length ?? 0) === 0) {
    return undefined;
  }
  return serializeWaitRenderCursor(cursor);
}

async function resolveMidFollowRouting(pluginRoot: string): Promise<BackendRoutingResult> {
  return resolveCliHandoffRouting(pluginRoot);
}

function emitWaitEvent(
  event: WaitStreamEvent,
  cursor: string | null,
  renderContext: WaitRenderContext,
  renderCauseRef?: (ref: CauseRef, terminalOutcomeDiagnostic?: TerminalOutcome) => string,
): Promise<boolean> {
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

  const trailingNewline = (event.type === 'terminal' || event.type === 'waiting') && renderContext.isTTY ? '\n' : '';
  return writeStdout(renderWaitLine(line, renderContext) + trailingNewline);
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
  let requiresStableCursor = false;
  const causeRenderer = openCliCauseRefRenderer(options.projectRoot);
  const ipcAuthOptions = childPrincipalAuthOptions(childPrincipalAuthFromEnv());

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
        .then(() => options.abortJob(options.launchResult.jobId))
        .then(
          () => undefined,
          () => undefined,
        );
  };

  let stdoutAcknowledgement = writeStdout(formatLaunch(options.launchResult) + '\n');
  process.on('SIGINT', onSigint);

  try {
    followLoop: while (true) {
      if (localAbortRequested) {
        return 1;
      }

      let backend;
      try {
        backend = await ensure(options.pluginRoot);

        const routing = await resolveMidFollowRouting(options.pluginRoot);
        if (routing.kind === 'handoff') {
          if (!(await isStdoutSnapshotStable(stdoutAcknowledgement, controller.signal))) {
            throw new Error(
              `Timed out waiting ${STABLE_SNAPSHOT_ACK_TIMEOUT_MS}ms for stable follow output before handoff`,
            );
          }
          requiresStableCursor = false;

          const handoffCursor = cursorRef.serializedCursor ?? serializeWaitRenderCursor({ afterSeq: 0 });
          const args = ['wait', 'jobs', options.launchResult.jobId, '--cursor', handoffCursor];
          const outcome = await runHandoff({
            runtime: createRealRuntime(backend.flavor),
            target: routing.target,
            operation: { entrypoint: 'cli', args },
          });

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

          options.emitError(new Error(`Delegated wait command ended from signal ${outcome.signal}`));
          return fallbackExitCode();
        }

        if (requiresStableCursor) {
          if (!(await isStdoutSnapshotStable(stdoutAcknowledgement, controller.signal))) {
            throw new Error(`Timed out waiting ${STABLE_SNAPSHOT_ACK_TIMEOUT_MS}ms for stable follow output`);
          }
          requiresStableCursor = false;
        }
      } catch (error) {
        if (localAbortRequested) {
          return 1;
        }

        options.emitError(error);
        return fallbackExitCode();
      }

      if (localAbortRequested) {
        return 1;
      }

      try {
        let reconnect = false;
        const inputCursor = parseWaitRenderCursor(cursorRef.serializedCursor);
        if (cursorRef.serializedCursor && !inputCursor) {
          throw new BackendToolHttpError('Invalid Last-Event-ID cursor', 400, {
            code: 'invalid_request',
            message: 'Invalid Last-Event-ID cursor',
          });
        }

        const subscription = await backend.subscribe<WaitStreamEvent>(
          'jobs.wait',
          {
            jobIds: [options.launchResult.jobId],
            timeoutSeconds: FOLLOW_TIMEOUT_SECONDS,
            projectRoot: options.projectRoot,
            ...(inputCursor ? { cursor: inputCursor } : {}),
          },
          {
            timeoutMs: HEALTH_TIMEOUT_MS,
            signal: controller.signal,
            ...ipcAuthOptions,
          },
        );

        try {
          let currentCursor: WaitRenderCursor = inputCursor ?? { afterSeq: 0 };
          for await (const event of subscription) {
            const decision = advanceWaitRenderCursor(currentCursor, event);
            currentCursor = decision.cursor;

            if (decision.shouldRender) {
              const acknowledgedCursor = serializedCursor(currentCursor);
              const cursor = acknowledgedCursor ?? null;
              requiresStableCursor = true;
              stdoutAcknowledgement = appendStdoutAcknowledgement(
                stdoutAcknowledgement,
                emitWaitEvent(event, cursor, renderContext, causeRenderer.render),
                () => {
                  cursorRef.serializedCursor = acknowledgedCursor;
                },
              );
            }

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
          return fallbackExitCode();
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
