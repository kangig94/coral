import { setTimeout as delay } from 'node:timers/promises';

import { streamWait, type WaitCursorRef } from '../client/backend-helpers.js';
import type { AcceptedLaunchResponse } from '../client/http-client.js';
import { ensureBackend } from '../client/backend-lifecycle.js';
import type { TerminalResult, WaitStreamEvent } from '../shared/types.js';
import {
  formatError,
  formatLaunch,
  formatWaitProgress,
  formatWaitQueued,
  formatWaitTerminal,
  formatWaitRunning,
  renderWaitLine,
  type WaitRenderContext,
} from './format.js';
import { errorMessage, isTransientStreamError } from '../shared/utils.js';
import type { CliStreamEvent } from './types.js';

const FOLLOW_TIMEOUT_SECONDS = 600;
const TRANSIENT_RETRY_LIMIT = 2;
const TRANSIENT_RETRY_DELAY_MS = 1_000;

type FollowLaunchDecision = AcceptedLaunchResponse;

type LaunchAndFollowOptions = {
  launchResult: FollowLaunchDecision;
  abortJob: (jobId: string) => Promise<unknown>;
  pluginRoot: string;
  projectRoot: string;
  outputFormat: 'text' | 'json';
  isTTY: boolean;
  columns: number;
};

function toLaunchEvent(decision: FollowLaunchDecision): Extract<CliStreamEvent, { type: 'launch' }> {
  return {
    type: 'launch',
    jobId: decision.job,
    sessionId: decision.session,
    status: decision.launchState,
  };
}

function toCliStreamEvent(event: WaitStreamEvent): Exclude<CliStreamEvent, { type: 'launch' }> {
  switch (event.type) {
    case 'progress':
      return {
        type: 'progress',
        jobId: event.jobId,
        sessionId: event.sessionId,
        message: event.message,
      };
    case 'queued':
      return {
        type: 'queued',
        jobId: event.jobId,
        sessionId: event.sessionId,
        queuePosition: event.queuePosition,
        runningJobIds: event.runningJobIds,
      };
    case 'terminal': {
      const { content: _content, ...resultMeta } = event.result;
      return {
        type: 'terminal',
        completedJobId: event.completedJobId,
        sessionId: event.sessionId,
        remainingJobIds: event.remainingJobIds,
        result: {
          ...resultMeta,
          path: event.resultPath,
        },
      };
    }
    case 'running':
      return {
        type: 'running',
        runningJobIds: event.runningJobIds,
      };
  }
}

function emitLaunch(decision: FollowLaunchDecision, outputFormat: 'text' | 'json'): void {
  if (outputFormat === 'json') {
    process.stdout.write(JSON.stringify(toLaunchEvent(decision)) + '\n');
    return;
  }

  process.stdout.write(formatLaunch(decision) + '\n');
}

function emitWaitEvent(
  event: WaitStreamEvent,
  cursor: string | null,
  outputFormat: 'text' | 'json',
  renderContext: WaitRenderContext,
): void {
  if (outputFormat === 'json') {
    process.stdout.write(JSON.stringify(toCliStreamEvent(event)) + '\n');
    return;
  }

  let line: string;
  switch (event.type) {
    case 'progress':
      line = formatWaitProgress(event, cursor);
      break;
    case 'queued':
      line = formatWaitQueued(event, cursor);
      break;
    case 'terminal':
      line = formatWaitTerminal(event, cursor, false);
      break;
    case 'running':
      line = formatWaitRunning(event, cursor);
      break;
  }

  process.stdout.write(renderWaitLine(line, renderContext));
  if ((event.type === 'terminal' || event.type === 'running') && renderContext.isTTY) {
    process.stdout.write('\n');
  }
}

function emitFollowError(error: unknown, outputFormat: 'text' | 'json'): void {
  if (outputFormat === 'json') {
    const message = errorMessage(error);
    process.stderr.write(JSON.stringify({ error: true, message }) + '\n');
    return;
  }

  process.stderr.write(formatError(error) + '\n');
}

function toExitCode(result: TerminalResult): number {
  if (result.aborted === true) {
    return 1;
  }

  const exitCode = result.exitCode;

  if (exitCode === undefined) {
    return 0;
  }

  if (exitCode === null || !Number.isInteger(exitCode)) {
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

  emitLaunch(options.launchResult, options.outputFormat);
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

        emitFollowError(error, options.outputFormat);
        return 1;
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
          emitWaitEvent(event, cursor, options.outputFormat, renderContext);

          if (event.type === 'running') {
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

        emitFollowError(new Error('wait stream ended without a terminal event'), options.outputFormat);
        return 1;
      } catch (error) {
        if (localAbortRequested) {
          return 1;
        }

        if (!isTransientStreamError(error) || retriesLeft === 0) {
          emitFollowError(error, options.outputFormat);
          return 1;
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
