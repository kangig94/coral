import { setTimeout as delay } from 'node:timers/promises';

import { streamWait, type WaitCursorRef } from '../client/backend-helpers.js';
import type { AcceptedLaunchResponse } from '../client/http-client.js';
import { ensureBackend } from './backend-lifecycle.js';
import { describeCauseRef } from '../jobs/read/cause-ref-render.js';
import type { CauseRef, TerminalOutcome } from '../jobs/outcome.js';
import { createRealRuntime } from '../runtime/real.js';
import type { JobTerminalRecord } from '../jobs/records.js';
import type { WaitStreamEvent } from '../jobs/wait.js';
import { readBuildFlavor } from '../shared/utils.js';
import { CoralStore, openStoreDatabase } from '../store/index.js';
import { storePaths } from '../store/paths.js';
import {
  formatLaunch,
  formatWaitProgress,
  formatWaitQueued,
  formatWaitTerminal,
  formatWaitWaiting,
  renderWaitLine,
  type WaitRenderContext,
} from './format.js';
import { assertNever, isTransientStreamError } from '../shared/utils.js';

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

function emitLaunch(decision: FollowLaunchDecision): void {
  process.stdout.write(formatLaunch(decision) + '\n');
}

function emitWaitEvent(
  event: WaitStreamEvent,
  cursor: string | null,
  renderContext: WaitRenderContext,
  renderCauseRef?: (ref: CauseRef, fallbackOutcome?: TerminalOutcome) => string,
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

function toExitCode(result: JobTerminalRecord): number {
  switch (result.outcome.kind) {
    case 'aborted':
    case 'failed':
    case 'job_fault':
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

function openCauseRenderer(pluginRoot: string): {
  readonly render?: (ref: CauseRef, fallbackOutcome?: TerminalOutcome) => string;
  close(): void;
} {
  try {
    const runtime = createRealRuntime();
    const db = openStoreDatabase({
      path: storePaths(readBuildFlavor(pluginRoot)).dbFile,
      storage: runtime.storage,
      readonly: true,
    });
    const store = new CoralStore(db);
    return {
      render: (ref, fallbackOutcome) => describeCauseRef(ref, store, fallbackOutcome),
      close: () => db.close(),
    };
  } catch {
    return {
      close: () => {},
    };
  }
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
  const causeRenderer = openCauseRenderer(options.pluginRoot);

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
          emitWaitEvent(event, cursor, renderContext, causeRenderer.render);

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
    causeRenderer.close();
    process.off('SIGINT', onSigint);
    if (abortPromise !== null) {
      await (abortPromise as Promise<void>);
    }
  }
}
