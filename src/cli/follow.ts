import { setTimeout as delay } from 'node:timers/promises';

import { streamWait, type WaitCursorRef } from '../client/backend-helpers.js';
import type { AcceptedLaunchResponse } from '../client/http-client.js';
import { ensureBackend } from '../client/backend-lifecycle.js';
import type { TerminalResult, WaitStreamEvent } from '../shared/types.js';
import {
  formatLaunch,
  formatWaitProgress,
  formatWaitQueued,
  formatWaitTerminal,
  formatWaitWaiting,
  renderWaitLine,
  type WaitRenderContext,
} from './format.js';
import { isTransientStreamError } from '../shared/utils.js';

const FOLLOW_TIMEOUT_SECONDS = 600;
const TRANSIENT_RETRY_LIMIT = 2;
const TRANSIENT_RETRY_DELAY_MS = 1_000;

type FollowLaunchDecision = AcceptedLaunchResponse;

type LaunchAndFollowOptions = {
  launchResult: FollowLaunchDecision;
  abortJob: (jobId: string) => Promise<unknown>;
  pluginRoot: string;
  projectRoot: string;
  emitError: (error: unknown) => void;
  isTTY: boolean;
  columns: number;
};

function assertNever(value: never): never {
  throw new Error(`Unhandled value: ${JSON.stringify(value)}`);
}

function emitLaunch(decision: FollowLaunchDecision): void {
  process.stdout.write(formatLaunch(decision) + '\n');
}

function emitWaitEvent(
  event: WaitStreamEvent,
  cursor: string | null,
  renderContext: WaitRenderContext,
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
      line = formatWaitTerminal(event, cursor, false);
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

function toExitCode(result: TerminalResult): number {
  switch (result.outcome.kind) {
    case 'aborted':
    case 'coral_fault':
      return 1;
    case 'provider_exit':
      return normalizeExitCode(result.outcome.code);
    case 'completed':
      return normalizeExitCode(result.exitCode);
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

async function waitForRetry(signal: AbortSignal): Promise<boolean> {
  try {
    await delay(TRANSIENT_RETRY_DELAY_MS, undefined, { signal });
    return true;
  } catch {
    return false;
  }
}

export async function launchAndFollow(options: LaunchAndFollowOptions): Promise<number> {
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
        backend = await ensureBackend(options.pluginRoot);
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

        for await (const event of streamWait(
          [options.launchResult.job],
          FOLLOW_TIMEOUT_SECONDS,
          backend,
          cursorRef.lastEventId,
          controller.signal,
          options.projectRoot,
          cursorRef,
        )) {
          const cursor = cursorRef.lastEventId ?? null;
          emitWaitEvent(event, cursor, renderContext);

          if (event.type === 'waiting') {
            reconnect = true;
            break;
          }

          if (event.type === 'terminal') {
            return toExitCode(event.result);
          }
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

        if (!isTransientStreamError(error) || retriesLeft === 0) {
          options.emitError(error);
          return typeof process.exitCode === 'number' ? process.exitCode : 1;
        }

        retriesLeft -= 1;
        const shouldRetry = await waitForRetry(controller.signal);
        if (!shouldRetry || localAbortRequested) {
          return 1;
        }
      }
    }
  } finally {
    process.off('SIGINT', onSigint);
    if (abortPromise !== null) {
      await (abortPromise as Promise<void>);
    }
  }
}
