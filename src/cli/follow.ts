import { performance } from 'node:perf_hooks';
import { WaitInvocation, WaitInvocationEnded } from './wait-invocation.js';
import { decodeSerializedWaitCursor, waitJobHash, WAIT_CURSOR_REPLAY_NOTICE } from '../jobs/wait/cursor.js';
import { setTimeout as delay } from 'node:timers/promises';

import { BackendToolHttpError } from '../transport/http/errors.js';
import type { AcceptedLaunchResponse } from '../jobs/launch.js';
import type { AbortResult } from '../jobs/contracts/abort-registry.js';
import type { CauseRef } from '../causality/cause-ref.js';
import type { TerminalOutcome } from '../jobs/outcome.js';
import type { JobStatus, JobTerminal } from '../jobs/records.js';
import { type WaitCursor, type WaitStreamEvent } from '../jobs/wait/contract.js';
import { serializeWaitCursor, waitCursorForJobs } from '../jobs/wait/cursor.js';
import { advanceWaitRenderCursor, isWaitHandoverNotice, parseWaitStreamEventValue } from '../jobs/wait/stream-event.js';
import { HEALTH_TIMEOUT_MS } from '../transport/health.js';
import { jobsWaitRequest } from '../transport/rpc/jobs.js';
import { BackendUnreachableError, isTransientStreamError, TransientHttpError } from '../infra/http-errors.js';
import { assertNever } from '../infra/error-format.js';
import { isRecord } from '../infra/json.js';
import { IpcRequestTimeout } from '../transport/ipc/client.js';
import { ensure } from '../transport/ipc/ensure.js';
import { childPrincipalAuthFromEnv, childPrincipalAuthOptions } from '../transport/ipc/child-principal-auth.js';
import {
  HandoffRunError,
  consumeHandoffRunResult,
  runHandoff,
  type HandoffOutcome,
} from '../coordinator/handoff-routing/runner.js';
import { formatAbortResult, formatLaunch, formatWorkflowSlot } from './format/jobs.js';
import { openCliCauseRefRenderer } from './cause-renderer.js';
import { openReadCoralStore, type ReadCoralStoreHandle } from './read-store.js';
import { errorCodeToExit, WaitResumeError } from './errors.js';
import { renderHandoffNotice, renderHandoffPublicationIncidents } from './handoff-notice.js';
import { mapWaitSubscriptionError } from './wait-stream-error.js';
import {
  formatWaitProgress,
  formatWaitContinuation,
  formatWaitQueued,
  formatWaitTerminal,
  formatWaitCarrierInterrupted,
  formatWaitWaiting,
  renderWaitLine,
  type WaitRenderContext,
} from './format/wait.js';
import { formatResultAvailability } from './format/result-availability.js';

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
const ABORT_SUCCEEDED_EXIT_CODE = 1;
export const ABORT_REFUSED_EXIT_CODE = 3;
const ABORT_REQUEST_FAILED_FALLBACK_EXIT_CODE = 70;

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
  onCursorReset: () => void;
}>;

type FollowJobsOptions = {
  start: FollowStart;
  reconnectPolicy: ReconnectPolicy;
  connect: (request: FollowConnectionRequest) => Promise<FollowConnection>;
  abortJobs?: (jobIds: readonly string[]) => Promise<AbortResult>;
  invocation?: WaitInvocation;
  projectRoot: string;
  emitError: (error: unknown) => void;
  render: WaitRenderContext & {
    embed: boolean;
    verbose: boolean;
  };
  backoffScheduler?: BackoffScheduler;
};

type AbortAttempt =
  | Readonly<{ kind: 'succeeded' }>
  | Readonly<{ kind: 'refused'; result: AbortResult }>
  | Readonly<{ kind: 'request-failed'; error: unknown }>;

type FollowOptions = {
  launchResult: AcceptedLaunchResponse;
  abortJob: (jobId: string) => Promise<AbortResult>;
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
  if (cursor.version === undefined && cursor.afterSeq === 0) {
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

/** A wait must not hold the epoch lock that a succession needs. */
function readJobStatuses(projectRoot: string, jobIds: readonly string[]): Map<string, JobStatus> {
  let handle: ReadCoralStoreHandle;
  try {
    handle = openReadCoralStore(projectRoot);
  } catch {
    return new Map();
  }
  try {
    return new Map(
      jobIds.flatMap((jobId) => {
        const status = handle.store.jobs.detail(jobId)?.status;
        return status === undefined ? [] : [[jobId, status] as const];
      }),
    );
  } catch {
    return new Map();
  } finally {
    handle.close();
  }
}

type JobLabel = Readonly<{
  stream: string;
  terminal: string;
}>;

function jobLabelsFor(projectRoot: string, jobIds: readonly string[]): Map<string, JobLabel> | null {
  const statuses = readJobStatuses(projectRoot, jobIds);
  const labels = new Map<string, JobLabel>();
  let hasWorkflowLabel = false;

  jobIds.forEach((jobId, index) => {
    const workflowSlot = formatWorkflowSlot(statuses.get(jobId) ?? {});
    if (workflowSlot === null) {
      labels.set(jobId, { stream: `j${index}`, terminal: jobId });
      return;
    }

    hasWorkflowLabel = true;
    const slotLabel = `slot ${workflowSlot}`;
    labels.set(jobId, {
      stream: jobIds.length > 1 ? `j${index} · ${slotLabel}` : slotLabel,
      terminal: `${jobId} (${slotLabel})`,
    });
  });

  return jobIds.length > 1 || hasWorkflowLabel ? labels : null;
}

function emitWaitEvent(
  event: WaitStreamEvent,
  cursor: string | null,
  jobLabels: ReadonlyMap<string, JobLabel> | null,
  resumeJobIds: readonly string[],
  renderOptions: FollowJobsOptions['render'],
  renderCauseRef?: (ref: CauseRef, terminalOutcomeDiagnostic?: TerminalOutcome, epochKey?: string) => string,
  onDelivered?: () => void,
): void {
  let line: string;
  switch (event.type) {
    case 'notice':
      line = event.message;
      break;
    case 'disposition':
      line = `Job ${event.jobId}: ${event.disposition}${event.message ? ` — ${event.message}` : ''}`;
      break;
    case 'artifact':
      line = `Job ${event.jobId}: ${formatResultAvailability(event.availability, true)}\n${formatWaitContinuation(event.remainingJobIds, cursor)}`;
      break;
    case 'progress':
      line = formatWaitProgress(event, jobLabels?.get(event.jobId)?.stream);
      break;
    case 'queued':
      line = formatWaitQueued(event, jobLabels?.get(event.jobId)?.stream);
      break;
    case 'terminal':
      line = formatWaitTerminal(event, cursor, renderOptions.embed, {
        describeCauseRef: renderCauseRef
          ? (ref) => renderCauseRef(ref, event.result.outcome, 'epochKey' in event ? event.epochKey : undefined)
          : undefined,
        verbose: renderOptions.verbose,
        label: jobLabels?.get(event.jobId)?.terminal,
      });
      break;
    case 'interrupted':
      line = formatWaitCarrierInterrupted({
        ...event,
        jobId: jobLabels?.get(event.jobId)?.terminal ?? event.jobId,
      });
      break;
    case 'waiting':
      line = formatWaitWaiting(event, cursor, resumeJobIds);
      break;
  }

  const trailingNewline = (event.type === 'terminal' || event.type === 'waiting') && renderOptions.isTTY ? '\n' : '';
  process.stdout.write(renderWaitLine(line, renderOptions) + trailingNewline, (error) => {
    if (!error) onDelivered?.();
  });
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

function classifyAbortResult(result: AbortResult): AbortAttempt {
  return (result.refused?.length ?? 0) + (result.held?.length ?? 0) + (result.abandoned?.length ?? 0) > 0
    ? { kind: 'refused', result }
    : { kind: 'succeeded' };
}

async function finishAbortAttempt(
  abortPromise: Promise<AbortAttempt>,
  emitError: (error: unknown) => void,
): Promise<number> {
  const attempt = await abortPromise;
  if (attempt.kind === 'succeeded') {
    return ABORT_SUCCEEDED_EXIT_CODE;
  }
  if (attempt.kind === 'refused') {
    writeStdout(formatAbortResult(attempt.result) + '\n');
    return ABORT_REFUSED_EXIT_CODE;
  }

  emitError(attempt.error);
  const exitCode = fallbackExitCode();
  return exitCode === ABORT_SUCCEEDED_EXIT_CODE || exitCode === ABORT_REFUSED_EXIT_CODE
    ? ABORT_REQUEST_FAILED_FALLBACK_EXIT_CODE
    : exitCode;
}

function boundedTimeoutSeconds(deadlineMs: number): number {
  return Math.max(1, Math.ceil((deadlineMs - performance.now()) / 1_000));
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

type FollowSessionState = {
  currentCursor: WaitCursor;
  remainingJobIds: string[];
  sendCursor: boolean;
  retriesLeft: number;
  hasOpenedSubscription: boolean;
  sigintCount: number;
  carrierUnknownJobIds: string[];
};

type FollowStep = { kind: 'retry' } | { kind: 'exit'; code: number };

async function connectFollowStream(
  options: FollowJobsOptions,
  state: FollowSessionState,
  controller: AbortController,
  deadlineMs: number,
  abortState: { promise: Promise<AbortAttempt> | null },
): Promise<FollowStep | { kind: 'connected'; connection: FollowConnection }> {
  try {
    const connection = await options.connect({
      jobIds: state.remainingJobIds,
      ...(state.sendCursor || serializedCursor(state.currentCursor) !== undefined
        ? { cursor: state.currentCursor }
        : {}),
      timeoutSeconds:
        options.reconnectPolicy === 'bounded' ? boundedTimeoutSeconds(deadlineMs) : FOLLOW_TIMEOUT_SECONDS,
      signal: controller.signal,
      onCursorReset: () => {
        options.invocation?.check();
        writeStdout(`${WAIT_CURSOR_REPLAY_NOTICE}\n`);
        state.currentCursor = { afterSeq: 0 };
        state.sendCursor = false;
      },
    });
    options.invocation?.check();
    return { kind: 'connected', connection };
  } catch (error) {
    options.invocation?.check();
    if (abortState.promise !== null) {
      return { kind: 'exit', code: await finishAbortAttempt(abortState.promise, options.emitError) };
    }
    const handledError = mapWaitSubscriptionError(error);
    if (
      handledError instanceof BackendToolHttpError &&
      isRecord(handledError.body) &&
      [
        'wait_cursor_epoch_required',
        'wait_cursor_unsupported',
        'wait_cursor_malformed',
        'wait_cursor_mismatch',
      ].includes(String(handledError.body.code))
    ) {
      writeStdout(`${WAIT_CURSOR_REPLAY_NOTICE}\n`);
      state.currentCursor = { afterSeq: 0 };
      state.sendCursor = false;
      return { kind: 'retry' };
    }
    if (!(handledError instanceof Error) || !isTransientStreamError(handledError)) {
      options.emitError(withWaitRecovery(handledError, state.remainingJobIds));
      return { kind: 'exit', code: fallbackExitCode() };
    }
    if (state.retriesLeft === 0) {
      if (
        state.hasOpenedSubscription ||
        handledError instanceof TransientHttpError ||
        handledError instanceof IpcRequestTimeout
      ) {
        options.emitError(
          new WaitResumeError(handledError.message, state.remainingJobIds, serializedCursor(state.currentCursor)),
        );
        return { kind: 'exit', code: errorCodeToExit('transient') };
      }
      options.emitError(withWaitRecovery(handledError, state.remainingJobIds));
      return { kind: 'exit', code: fallbackExitCode() };
    }
    state.retriesLeft -= 1;
    const shouldRetry = await waitForRetry(controller.signal, options.backoffScheduler);
    if (abortState.promise !== null) {
      return { kind: 'exit', code: await finishAbortAttempt(abortState.promise, options.emitError) };
    }
    return shouldRetry ? { kind: 'retry' } : { kind: 'exit', code: 1 };
  }
}

async function finishDelegatedFollow(
  outcome: HandoffOutcome,
  options: FollowJobsOptions,
  state: FollowSessionState,
  abortState: { promise: Promise<AbortAttempt> | null },
): Promise<FollowStep> {
  if (abortState.promise !== null) {
    return { kind: 'exit', code: await finishAbortAttempt(abortState.promise, options.emitError) };
  }
  if (outcome.kind === 'handoff-success') {
    renderHandoffNotice(outcome);
    return { kind: 'exit', code: 0 };
  }
  if (outcome.kind === 'handoff-exit') {
    return { kind: 'exit', code: normalizeExitCode(outcome.exitCode) };
  }
  if (outcome.signal === 'SIGINT' && state.sigintCount === 1) return { kind: 'retry' };
  options.emitError(
    new WaitResumeError(
      `Delegated wait command ended from signal ${outcome.signal}; the jobs may still be running.`,
      state.remainingJobIds,
      serializeWaitCursor(state.currentCursor),
    ),
  );
  return { kind: 'exit', code: errorCodeToExit('transient') };
}

function applyFollowStreamEvent(
  event: WaitStreamEvent,
  options: FollowJobsOptions,
  state: FollowSessionState,
  jobLabels: ReturnType<typeof jobLabelsFor>,
  causeRenderer: ReturnType<typeof openCliCauseRefRenderer>,
): FollowStep | { kind: 'continue' } {
  options.invocation?.check();
  if (event.type === 'interrupted') {
    state.carrierUnknownJobIds = state.carrierUnknownJobIds.filter((id) => id !== event.jobId);
  } else if (event.type === 'waiting' && event.carrierUnknownJobIds !== undefined) {
    state.carrierUnknownJobIds = [...event.carrierUnknownJobIds];
  }
  const decision = advanceWaitRenderCursor(state.currentCursor, event);
  state.currentCursor = decision.cursor;
  state.sendCursor ||= serializedCursor(state.currentCursor) !== undefined;

  if (decision.shouldRender) {
    const renderCursor =
      event.type === 'terminal' ? waitCursorForJobs(state.currentCursor, event.remainingJobIds) : state.currentCursor;
    const cursor =
      serializedCursor(renderCursor) ??
      (event.type === 'waiting' && options.reconnectPolicy === 'bounded' ? serializeWaitCursor(renderCursor) : null);
    const remaining =
      event.type === 'terminal'
        ? event.remainingJobIds
        : event.type === 'waiting'
          ? event.waitingJobIds
          : event.type === 'artifact'
            ? event.remainingJobIds
            : event.cursor?.version === 'jobs.wait.v3'
              ? state.remainingJobIds.filter(
                  (id) =>
                    event.cursor?.version === 'jobs.wait.v3' &&
                    event.cursor.jobs.some((entry) => entry.hash === waitJobHash(id)),
                )
              : event.cursor?.version === 'jobs.wait.v2'
                ? Object.keys(event.cursor.locations)
                : state.remainingJobIds;
    state.remainingJobIds = [...remaining];
    const unknown = remaining.filter((id) => state.carrierUnknownJobIds.includes(id));
    const savedCursor = waitCursorForJobs(state.currentCursor, remaining);
    const savedContinuation =
      formatWaitWaiting(
        {
          type: 'waiting',
          waitingJobIds: [...remaining],
          ...(unknown.length === 0 ? {} : { carrierUnknownJobIds: unknown }),
        },
        serializeWaitCursor(savedCursor),
        remaining,
      ) + '\n';
    emitWaitEvent(
      event,
      cursor,
      jobLabels,
      event.type === 'waiting' ? event.waitingJobIds : state.remainingJobIds,
      options.render,
      causeRenderer.render,
      () => {
        options.invocation?.saveContinuation(savedContinuation, event.type === 'terminal' || event.type === 'waiting');
      },
    );
  }

  if (event.type === 'artifact') {
    state.remainingJobIds = event.remainingJobIds;
    return { kind: 'exit', code: event.exitCode };
  }
  if (event.type === 'terminal') {
    const exitCode = event.exitCode ?? toExitCode(event.result);
    if (exitCode !== 0) return { kind: 'exit', code: exitCode };
    state.remainingJobIds = [...event.remainingJobIds];
    state.currentCursor = waitCursorForJobs(state.currentCursor, state.remainingJobIds);
    return { kind: 'exit', code: state.remainingJobIds.length === 0 ? 0 : errorCodeToExit('transient') };
  }

  if (event.type === 'waiting') {
    state.remainingJobIds = [...event.waitingJobIds];
    state.currentCursor = waitCursorForJobs(state.currentCursor, state.remainingJobIds);
    if (event.exitCode !== undefined) return { kind: 'exit', code: event.exitCode };
    if (state.remainingJobIds.length === 0) return { kind: 'exit', code: 0 };
    return options.reconnectPolicy === 'bounded'
      ? { kind: 'exit', code: errorCodeToExit('transient') }
      : { kind: 'retry' };
  }
  return { kind: 'continue' };
}

async function consumeFollowSubscription(
  connection: Extract<FollowConnection, { kind: 'subscription' }>,
  options: FollowJobsOptions,
  state: FollowSessionState,
  controller: AbortController,
  abortState: { promise: Promise<AbortAttempt> | null },
  jobLabels: ReturnType<typeof jobLabelsFor>,
  causeRenderer: ReturnType<typeof openCliCauseRefRenderer>,
): Promise<FollowStep> {
  state.hasOpenedSubscription = true;
  let reconnect = false;
  try {
    for await (const raw of connection.subscription) {
      if (abortState.promise !== null) {
        return { kind: 'exit', code: await finishAbortAttempt(abortState.promise, options.emitError) };
      }

      if (isWaitHandoverNotice(raw)) {
        reconnect = true;
        break;
      }
      options.invocation?.check();
      const event = parseWaitStreamEventValue(raw);
      if (event === null) {
        continue;
      }

      const decision = applyFollowStreamEvent(event, options, state, jobLabels, causeRenderer);
      if (decision.kind === 'exit') return { kind: 'exit', code: decision.code };
      if (decision.kind === 'retry') {
        reconnect = true;
        break;
      }
    }
  } catch (error) {
    options.invocation?.check();
    if (abortState.promise !== null) {
      return { kind: 'exit', code: await finishAbortAttempt(abortState.promise, options.emitError) };
    }

    const handledError = mapWaitSubscriptionError(error);
    if (!(handledError instanceof Error) || !isTransientStreamError(handledError)) {
      options.emitError(withWaitRecovery(handledError, state.remainingJobIds));
      return { kind: 'exit', code: fallbackExitCode() };
    }
    if (state.retriesLeft === 0) {
      options.emitError(
        new WaitResumeError(handledError.message, state.remainingJobIds, serializeWaitCursor(state.currentCursor)),
      );
      return { kind: 'exit', code: errorCodeToExit('transient') };
    }

    state.retriesLeft -= 1;
    const shouldRetry = await waitForRetry(controller.signal, options.backoffScheduler);
    if (abortState.promise !== null) {
      return { kind: 'exit', code: await finishAbortAttempt(abortState.promise, options.emitError) };
    }
    if (!shouldRetry) {
      return { kind: 'exit', code: 1 };
    }
    reconnect = true;
  } finally {
    if (options.invocation?.signal.aborted) {
      void connection.subscription.close().catch(() => undefined);
    } else if (options.invocation) {
      await options.invocation.run(() => connection.subscription.close());
    } else {
      await connection.subscription.close();
    }
  }

  if (reconnect) return { kind: 'retry' };

  options.emitError(
    new WaitResumeError(
      'The wait stream ended before a terminal event; the jobs may still be running.',
      state.remainingJobIds,
      serializeWaitCursor(state.currentCursor),
    ),
  );
  return { kind: 'exit', code: errorCodeToExit('transient') };
}

export async function followJobs(options: FollowJobsOptions): Promise<number> {
  const allJobIds = [...jobIdsFromStart(options.start)];
  const rawCursor = initialSerializedCursor(options.start);
  const localInvocation = options.reconnectPolicy === 'bounded' && options.invocation === undefined;
  const invocation =
    options.invocation ??
    (localInvocation
      ? new WaitInvocation('bounded', [
          'node',
          'coral-cli',
          'wait',
          'jobs',
          ...allJobIds,
          ...(rawCursor === undefined ? [] : ['--cursor', rawCursor]),
        ])
      : undefined);
  options = { ...options, invocation };
  const decoded = rawCursor === undefined ? undefined : decodeSerializedWaitCursor(rawCursor);
  const parsedCursor = decoded?.kind === 'decoded' ? decoded.cursor : undefined;
  if (decoded?.kind === 'rejected') writeStdout(`${WAIT_CURSOR_REPLAY_NOTICE}\n`);

  const controller = new AbortController();
  const onInvocationEnd = () => controller.abort();
  invocation?.signal.addEventListener('abort', onInvocationEnd, { once: true });
  const deadlineMs = performance.now() + (invocation?.remainingMs() ?? FOLLOW_TIMEOUT_SECONDS * 1_000);
  let jobLabels: ReturnType<typeof jobLabelsFor> = null;
  const causeRenderer = openCliCauseRefRenderer(options.projectRoot);
  const state: FollowSessionState = {
    currentCursor: parsedCursor ?? { afterSeq: 0 },
    remainingJobIds: allJobIds,
    sendCursor: parsedCursor !== undefined,
    retriesLeft: TRANSIENT_RETRY_LIMIT,
    hasOpenedSubscription: false,
    sigintCount: 0,
    carrierUnknownJobIds: [...allJobIds],
  };
  const abortState: { promise: Promise<AbortAttempt> | null } = { promise: null };

  const onSigint = () => {
    state.sigintCount += 1;
    if (state.sigintCount === 1) {
      process.stderr.write('\nPress Ctrl+C again to abort the job.\n');
      return;
    }

    if (abortState.promise !== null || options.abortJobs === undefined) {
      return;
    }

    controller.abort();
    const abortJobs = options.abortJobs;
    abortState.promise =
      abortState.promise ??
      Promise.resolve()
        .then(() => abortJobs(allJobIds))
        .then(classifyAbortResult, (error): AbortAttempt => ({ kind: 'request-failed', error }));
  };

  if (options.start.kind === 'launch') {
    writeStdout(formatLaunch(options.start.launchResult) + '\n');
  }
  if (options.reconnectPolicy === 'until-terminal') process.on('SIGINT', onSigint);

  const monitor = async (): Promise<number> => {
    invocation?.check();
    jobLabels = jobLabelsFor(options.projectRoot, allJobIds);
    invocation?.check();
    followLoop: while (true) {
      if (abortState.promise !== null) {
        return await finishAbortAttempt(abortState.promise, options.emitError);
      }

      if (state.remainingJobIds.length === 0) {
        return 0;
      }

      invocation?.check();

      const connected = await connectFollowStream(options, state, controller, deadlineMs, abortState);
      if (connected.kind === 'retry') continue;
      if (connected.kind === 'exit') return connected.code;
      const { connection } = connected;

      if (abortState.promise !== null) {
        return await finishAbortAttempt(abortState.promise, options.emitError);
      }

      if (connection.kind === 'fatal-error') {
        options.emitError(withWaitRecovery(connection.error, state.remainingJobIds));
        return fallbackExitCode();
      }

      if (connection.kind === 'delegated') {
        const decision = await finishDelegatedFollow(connection.outcome, options, state, abortState);
        if (decision.kind === 'retry') continue followLoop;
        return decision.code;
      }

      const decision = await consumeFollowSubscription(
        connection,
        options,
        state,
        controller,
        abortState,
        jobLabels,
        causeRenderer,
      );
      if (decision.kind === 'retry') continue;
      return decision.code;
    }
  };
  try {
    const code = invocation ? await invocation.run(monitor) : await monitor();
    await invocation?.flushOutput();
    return code;
  } catch (error: unknown) {
    if (!(error instanceof WaitInvocationEnded) || !invocation) throw error;
    invocation.flushContinuation();
    return 75;
  } finally {
    causeRenderer.close();
    invocation?.signal.removeEventListener('abort', onInvocationEnd);
    if (localInvocation) invocation?.dispose();
    if (options.reconnectPolicy === 'until-terminal') process.off('SIGINT', onSigint);
    if (abortState.promise !== null) {
      await abortState.promise;
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
      const results = await Promise.all(jobIds.map((jobId) => options.abortJob(jobId)));
      return {
        aborted: results.flatMap((result) => result.aborted),
        notFound: results.flatMap((result) => result.notFound),
        refused: results.flatMap((result) => result.refused ?? []),
        held: results.flatMap((result) => result.held ?? []),
        abandoned: results.flatMap((result) => result.abandoned ?? []),
      };
    },
    connect: async ({ jobIds, cursor, timeoutSeconds, signal, onCursorReset }) => {
      let backend;
      try {
        backend = await ensure('jobs.wait', options.pluginRoot);
        const result = await runHandoff(
          {
            kind: 'wait-jobs',
            jobId: options.launchResult.jobId,
            serializedCursor: serializeWaitCursor(cursor ?? { afterSeq: 0 }),
          },
          {
            pluginRoot: options.pluginRoot,
            signal,
            onSelectionPublicationIncident: (incident) => renderHandoffPublicationIncidents([incident]),
          },
        );
        const continuation = consumeHandoffRunResult(result, (incidents) =>
          renderHandoffPublicationIncidents(incidents.filter((incident) => incident.phase === 'terminal')),
        );
        if (continuation.kind === 'delegated') {
          return continuation;
        }
      } catch (error) {
        if (error instanceof HandoffRunError) {
          renderHandoffPublicationIncidents(error.incidents.filter((incident) => incident.phase === 'terminal'));
          return { kind: 'fatal-error', error: error.originalError };
        }
        return { kind: 'fatal-error', error };
      }

      return {
        kind: 'subscription',
        // Wire boundary: see `WaitSubscription`'s definition — validation happens once the item is pulled
        // from the iterator, not here.
        subscription: await backend.subscribe<unknown>(
          'jobs.wait',
          jobsWaitRequest(
            { jobIds, timeoutSeconds, projectRoot: options.projectRoot, ...(cursor ? { cursor } : {}) },
            backend.jobsWaitExtensions,
            onCursorReset,
          ),
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
