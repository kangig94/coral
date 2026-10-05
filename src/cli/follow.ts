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
import { raceWithSignal } from '../infra/promise-signal.js';
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
import { errorCodeToExit, WaitResumeError, WaitOutputError } from './errors.js';
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
  drainProgress: boolean;
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
): Promise<void> {
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

  const trailingNewline =
    renderOptions.isTTY && ['terminal', 'waiting', 'notice', 'disposition', 'artifact'].includes(event.type)
      ? '\n'
      : '';
  return new Promise<void>((resolve, reject) => {
    process.stdout.write(renderWaitLine(line, renderOptions) + trailingNewline, (error) => {
      if (error) reject(error);
      else {
        onDelivered?.();
        resolve();
      }
    });
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
  const remaining = Math.max(0, deadlineMs - performance.now());
  return Math.max(1, Math.floor(remaining / 1000) - 1);
}

function withWaitRecovery(error: unknown, jobIds: readonly string[], cursor: WaitCursor): unknown {
  const body = error instanceof BackendToolHttpError && isRecord(error.body) ? error.body : null;
  if (!(error instanceof BackendUnreachableError) && body?.code !== 'backend_unreachable') {
    return error;
  }

  const message = body !== null && typeof body.message === 'string' ? body.message : (error as Error).message;
  return new BackendUnreachableError(
    `${message} Run \`coral-cli backend status\` and follow its recovery guidance, then rerun ` +
      `\`coral-cli wait jobs ${jobIds.join(' ')} --cursor ${serializeWaitCursor(cursor)}\` to continue waiting.`,
  );
}

type FollowSessionState = {
  currentCursor: WaitCursor;
  lastExitCode?: number;
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
    if (options.reconnectPolicy === 'bounded' && deadlineMs - performance.now() <= 1000) {
      options.invocation?.stop();
      throw new WaitInvocationEnded();
    }
    const connection = await options.connect({
      drainProgress: options.reconnectPolicy === 'until-terminal',
      jobIds: state.remainingJobIds,
      ...(state.sendCursor || serializedCursor(state.currentCursor) !== undefined
        ? { cursor: waitCursorForJobs(state.currentCursor, state.remainingJobIds) }
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
      if (!state.sendCursor) {
        options.emitError(withWaitRecovery(handledError, state.remainingJobIds, state.currentCursor));
        return { kind: 'exit', code: fallbackExitCode() };
      }
      writeStdout(`${WAIT_CURSOR_REPLAY_NOTICE}\n`);
      state.currentCursor = { afterSeq: 0 };
      state.sendCursor = false;
      return { kind: 'retry' };
    }
    if (!(handledError instanceof Error) || !isTransientStreamError(handledError)) {
      options.emitError(withWaitRecovery(handledError, state.remainingJobIds, state.currentCursor));
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
      options.emitError(withWaitRecovery(handledError, state.remainingJobIds, state.currentCursor));
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
    if (outcome.exitCode === 75 && state.sigintCount === 1 && options.reconnectPolicy === 'until-terminal')
      return { kind: 'retry' };
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

type FollowContext = {
  options: FollowJobsOptions;
  state: FollowSessionState;
  controller: AbortController;
  abortState: { promise: Promise<AbortAttempt> | null };
  jobLabels: ReturnType<typeof jobLabelsFor>;
  causeRenderer: ReturnType<typeof openCliCauseRefRenderer>;
  deadlineMs: number;
  pendingOutput: Set<Promise<void>>;
  outputFailure: AbortController;
};

function eventRemainingJobs(event: WaitStreamEvent, current: readonly string[]): string[] {
  if (event.type === 'terminal' || event.type === 'artifact') return [...event.remainingJobIds];
  if (event.type === 'waiting') return [...event.waitingJobIds];
  const cursor = event.cursor;
  if (cursor?.version === 'jobs.wait.v3')
    return current.filter((id) => cursor.jobs.some((entry) => entry.hash === waitJobHash(id)));
  if (cursor?.version === 'jobs.wait.v2') return Object.keys(cursor.locations);
  return [...current];
}

function followOriginalCommand(options: FollowJobsOptions): string {
  if (options.invocation) return options.invocation.originalCommand;
  const cursor = initialSerializedCursor(options.start);
  return `coral-cli wait jobs ${jobIdsFromStart(options.start).join(' ')}${cursor === undefined ? '' : ` --cursor ${cursor}`}${options.render.embed ? ' --embed' : ''}${options.render.verbose ? ' --verbose' : ''}`;
}

function deliveredFollowExitCode(event: WaitStreamEvent, context: FollowContext): number | undefined {
  const { options, state } = context;
  if (event.type === 'terminal') {
    if (options.reconnectPolicy === 'until-terminal') return toExitCode(event.result);
    const code = event.exitCode ?? toExitCode(event.result);
    return code !== 0 ? code : event.remainingJobIds.length === 0 ? 0 : 75;
  }
  if (event.type === 'artifact') return event.exitCode;
  if (event.type === 'waiting') {
    if (options.reconnectPolicy === 'bounded') return event.exitCode ?? (event.waitingJobIds.length === 0 ? 0 : 75);
    return event.waitingJobIds.length === 0 ? 0 : undefined;
  }
  if (event.type === 'notice' && state.remainingJobIds.length === 0) return event.exitCode;
  return undefined;
}

async function deliverFollowEvent(event: WaitStreamEvent, context: FollowContext): Promise<void> {
  const { options, state, jobLabels, causeRenderer } = context;
  const renderCursor =
    event.type === 'terminal' ? waitCursorForJobs(state.currentCursor, event.remainingJobIds) : state.currentCursor;
  const cursor =
    serializedCursor(renderCursor) ??
    (event.type === 'waiting' && options.reconnectPolicy === 'bounded' ? serializeWaitCursor(renderCursor) : null);
  state.remainingJobIds = eventRemainingJobs(event, state.remainingJobIds);
  const remaining = state.remainingJobIds;
  const unknown = remaining.filter((id) => state.carrierUnknownJobIds.includes(id));
  const savedContinuation =
    formatWaitWaiting(
      {
        type: 'waiting',
        waitingJobIds: remaining,
        ...(unknown.length === 0 ? {} : { carrierUnknownJobIds: unknown }),
      },
      serializeWaitCursor(waitCursorForJobs(state.currentCursor, remaining)),
      remaining,
    ) + '\n';
  const renderedEvent =
    options.reconnectPolicy === 'until-terminal' && event.type === 'terminal'
      ? {
          ...event,
          remainingJobIds: event.availability?.kind === 'repair-pending' ? [event.jobId] : [],
          exitCode: toExitCode(event.result),
        }
      : event;
  const delivery = emitWaitEvent(
    renderedEvent,
    cursor,
    jobLabels,
    renderedEvent.type === 'terminal' ? renderedEvent.remainingJobIds : remaining,
    options.render,
    causeRenderer.render,
    () => {
      options.invocation?.saveContinuation(
        savedContinuation,
        event.type === 'terminal' ||
          event.type === 'waiting' ||
          event.type === 'artifact' ||
          (event.type === 'notice' && event.exitCode !== undefined),
        true,
        deliveredFollowExitCode(event, context),
      );
    },
  ).catch((error: unknown) => {
    throw new WaitOutputError(error, followOriginalCommand(options));
  });
  if (options.reconnectPolicy === 'bounded') {
    await delivery;
    return;
  }
  const pending = delivery
    .catch((error: unknown) => {
      context.outputFailure.abort(error);
      context.controller.abort();
    })
    .finally(() => context.pendingOutput.delete(pending));
  context.pendingOutput.add(pending);
}

function followEventDecision(event: WaitStreamEvent, context: FollowContext): FollowStep | { kind: 'continue' } {
  const { state } = context;
  if (event.type === 'notice' && event.exitCode !== undefined && state.remainingJobIds.length === 0)
    return { kind: 'exit', code: event.exitCode };
  if (event.type === 'artifact') {
    state.remainingJobIds = event.remainingJobIds;
    return { kind: 'exit', code: event.exitCode };
  }
  if (event.type === 'terminal') {
    const exitCode = deliveredFollowExitCode(event, context) ?? 75;
    if (exitCode !== 0) return { kind: 'exit', code: exitCode };
    state.remainingJobIds = [...event.remainingJobIds];
    state.currentCursor = waitCursorForJobs(state.currentCursor, state.remainingJobIds);
    return { kind: 'exit', code: exitCode };
  }
  if (event.type === 'waiting') {
    state.remainingJobIds = [...event.waitingJobIds];
    state.currentCursor = waitCursorForJobs(state.currentCursor, state.remainingJobIds);
    const code = deliveredFollowExitCode(event, context);
    return code === undefined ? { kind: 'retry' } : { kind: 'exit', code };
  }
  return { kind: 'continue' };
}

async function applyFollowStreamEvent(
  event: WaitStreamEvent,
  context: FollowContext,
): Promise<FollowStep | { kind: 'continue' }> {
  const { options, state } = context;
  options.invocation?.check();
  if (event.type === 'interrupted')
    state.carrierUnknownJobIds = state.carrierUnknownJobIds.filter((id) => id !== event.jobId);
  else if (event.type === 'waiting') state.carrierUnknownJobIds = [...(event.carrierUnknownJobIds ?? [])];
  if ('exitCode' in event && event.exitCode !== undefined) state.lastExitCode = event.exitCode;
  const decision = advanceWaitRenderCursor(state.currentCursor, event);
  state.currentCursor = decision.cursor;
  state.sendCursor ||= serializedCursor(state.currentCursor) !== undefined;
  if (decision.shouldRender) await deliverFollowEvent(event, context);
  return followEventDecision(event, context);
}

async function readFollowSubscription(
  subscription: WaitSubscription,
  context: FollowContext,
): Promise<FollowStep | undefined> {
  const { options, abortState } = context;
  for await (const raw of subscription) {
    if (abortState.promise !== null)
      return { kind: 'exit', code: await finishAbortAttempt(abortState.promise, options.emitError) };
    if (isWaitHandoverNotice(raw)) return { kind: 'retry' };
    options.invocation?.check();
    const event = parseWaitStreamEventValue(raw);
    if (event === null) continue;
    const decision = await applyFollowStreamEvent(event, context);
    if (decision.kind !== 'continue') return decision;
  }
  return undefined;
}

async function followReadFailure(error: unknown, context: FollowContext): Promise<FollowStep> {
  const { options, state, abortState, controller } = context;
  options.invocation?.check();
  if (abortState.promise !== null)
    return { kind: 'exit', code: await finishAbortAttempt(abortState.promise, options.emitError) };
  if (error instanceof WaitOutputError) throw error;
  const handledError = mapWaitSubscriptionError(error);
  if (
    handledError instanceof BackendToolHttpError &&
    isRecord(handledError.body) &&
    ['wait_cursor_epoch_required', 'wait_cursor_unsupported', 'wait_cursor_malformed', 'wait_cursor_mismatch'].includes(
      String(handledError.body.code),
    ) &&
    state.sendCursor
  ) {
    writeStdout(`${WAIT_CURSOR_REPLAY_NOTICE}\n`);
    state.currentCursor = { afterSeq: 0 };
    state.sendCursor = false;
    return { kind: 'retry' };
  }

  if (!(handledError instanceof Error) || !isTransientStreamError(handledError)) {
    options.emitError(withWaitRecovery(handledError, state.remainingJobIds, state.currentCursor));
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
  if (abortState.promise !== null)
    return { kind: 'exit', code: await finishAbortAttempt(abortState.promise, options.emitError) };
  return shouldRetry ? { kind: 'retry' } : { kind: 'exit', code: 1 };
}

async function closeFollowSubscription(subscription: WaitSubscription, options: FollowJobsOptions): Promise<void> {
  if (options.invocation?.signal.aborted) void subscription.close().catch(() => undefined);
  else if (options.invocation) await options.invocation.run(() => subscription.close());
  else await subscription.close();
}

async function consumeFollowSubscription(
  connection: Extract<FollowConnection, { kind: 'subscription' }>,
  context: FollowContext,
): Promise<FollowStep> {
  const { options, state } = context;
  state.hasOpenedSubscription = true;
  try {
    const decision = await readFollowSubscription(connection.subscription, context);
    if (decision) return decision;
  } catch (error) {
    return await followReadFailure(error, context);
  } finally {
    await closeFollowSubscription(connection.subscription, options);
  }
  options.emitError(
    new WaitResumeError(
      'The wait stream ended before a terminal event; the jobs may still be running.',
      state.remainingJobIds,
      serializeWaitCursor(state.currentCursor),
    ),
  );
  return { kind: 'exit', code: errorCodeToExit('transient') };
}

function prepareFollowOptions(options: FollowJobsOptions) {
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
          ...(options.render.embed ? ['--embed'] : []),
          ...(options.render.verbose ? ['--verbose'] : []),
        ])
      : undefined);
  const decoded = rawCursor === undefined ? undefined : decodeSerializedWaitCursor(rawCursor);
  const parsedCursor = decoded?.kind === 'decoded' ? decoded.cursor : undefined;
  if (decoded?.kind === 'rejected') writeStdout(`${WAIT_CURSOR_REPLAY_NOTICE}\n`);
  return { options: { ...options, invocation }, localInvocation, allJobIds, parsedCursor };
}

function installFollowSignals(context: FollowContext, allJobIds: string[]): () => void {
  const { options, state, controller, abortState } = context;
  const onInvocationEnd = () => controller.abort();
  const onSigint = () => {
    if (state.remainingJobIds.length === 0) return;
    state.sigintCount += 1;
    if (state.sigintCount === 1) {
      process.stderr.write('\nPress Ctrl+C again to abort the job.\n');
      return;
    }
    if (abortState.promise !== null || options.abortJobs === undefined) return;
    controller.abort();
    const abortJobs = options.abortJobs;
    abortState.promise = Promise.resolve()
      .then(() => abortJobs(allJobIds))
      .then(classifyAbortResult, (error): AbortAttempt => ({ kind: 'request-failed', error }));
  };
  options.invocation?.signal.addEventListener('abort', onInvocationEnd, { once: true });
  if (options.reconnectPolicy === 'until-terminal') process.on('SIGINT', onSigint);
  return () => {
    options.invocation?.signal.removeEventListener('abort', onInvocationEnd);
    if (options.reconnectPolicy === 'until-terminal') process.off('SIGINT', onSigint);
  };
}

function createFollowContext(prepared: ReturnType<typeof prepareFollowOptions>): FollowContext {
  const { options, allJobIds, parsedCursor } = prepared;
  return {
    options,
    controller: new AbortController(),
    abortState: { promise: null },
    jobLabels: null,
    deadlineMs: performance.now() + (options.invocation?.remainingMs() ?? FOLLOW_TIMEOUT_SECONDS * 1000),
    causeRenderer: openCliCauseRefRenderer(options.projectRoot),
    pendingOutput: new Set(),
    outputFailure: new AbortController(),
    state: {
      currentCursor: parsedCursor ?? { afterSeq: 0 },
      remainingJobIds: allJobIds,
      sendCursor: parsedCursor !== undefined,
      retriesLeft: TRANSIENT_RETRY_LIMIT,
      hasOpenedSubscription: false,
      sigintCount: 0,
      carrierUnknownJobIds: [...allJobIds],
    },
  };
}

async function monitorFollowJobs(context: FollowContext): Promise<number> {
  const { options, state, controller, deadlineMs, abortState } = context;
  options.invocation?.check();
  context.jobLabels = jobLabelsFor(options.projectRoot, jobIdsFromStart(options.start));
  options.invocation?.check();
  while (true) {
    if (abortState.promise !== null) return await finishAbortAttempt(abortState.promise, options.emitError);
    if (state.remainingJobIds.length === 0) return state.lastExitCode ?? 75;
    options.invocation?.check();
    const connected = await connectFollowStream(options, state, controller, deadlineMs, abortState);
    if (connected.kind === 'retry') continue;
    if (connected.kind === 'exit') return connected.code;
    if (abortState.promise !== null) return await finishAbortAttempt(abortState.promise, options.emitError);
    const { connection } = connected;
    if (connection.kind === 'subscription' && options.reconnectPolicy === 'bounded') {
      options.invocation?.saveContinuation(
        formatWaitWaiting(
          { type: 'waiting', waitingJobIds: state.remainingJobIds, carrierUnknownJobIds: state.carrierUnknownJobIds },
          serializedCursor(state.currentCursor) ?? null,
        ) + '\n',
      );
    }
    if (connection.kind === 'fatal-error') {
      options.emitError(withWaitRecovery(connection.error, state.remainingJobIds, state.currentCursor));
      return fallbackExitCode();
    }
    const decision =
      connection.kind === 'delegated'
        ? await finishDelegatedFollow(connection.outcome, options, state, abortState)
        : await consumeFollowSubscription(connection, context);
    if (decision.kind === 'retry') continue;
    return decision.code;
  }
}

export async function followJobs(options: FollowJobsOptions): Promise<number> {
  const prepared = prepareFollowOptions(options);
  const context = createFollowContext(prepared);
  const invocation = context.options.invocation;
  const removeSignals = installFollowSignals(context, prepared.allJobIds);
  if (options.start.kind === 'launch') writeStdout(formatLaunch(options.start.launchResult) + '\n');
  try {
    const monitorAndFlush = async () => {
      const code = await monitorFollowJobs(context);
      await Promise.all(context.pendingOutput);
      await invocation?.flushOutput();
      return code;
    };
    const run = () =>
      raceWithSignal(monitorAndFlush(), context.outputFailure.signal, () => {
        throw context.outputFailure.signal.reason;
      });
    return invocation ? await invocation.run(run) : await run();
  } catch (error: unknown) {
    if (error instanceof WaitOutputError) {
      options.emitError(error);
      return 75;
    }
    if (!(error instanceof WaitInvocationEnded) || !invocation) throw error;
    invocation.flushContinuation();
    return invocation.completedExitCode ?? 75;
  } finally {
    context.causeRenderer.close();
    removeSignals();
    if (prepared.localInvocation) invocation?.dispose();
    if (context.abortState.promise !== null) await context.abortState.promise;
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
    connect: async ({ jobIds, cursor, timeoutSeconds, signal, onCursorReset, drainProgress }) => {
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
            { jobIds, timeoutSeconds, drainProgress, projectRoot: options.projectRoot, ...(cursor ? { cursor } : {}) },
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
