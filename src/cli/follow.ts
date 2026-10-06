import { performance } from 'node:perf_hooks';
import { WaitInvocation, WaitInvocationEnded } from './wait-invocation.js';
import { decodeSerializedWaitCursor, WAIT_CURSOR_REPLAY_NOTICE } from '../jobs/wait/cursor.js';
import { setTimeout as delay } from 'node:timers/promises';

import { BackendToolHttpError } from '../transport/http/errors.js';
import type { AcceptedLaunchResponse } from '../jobs/launch.js';
import type { CauseRef } from '../causality/cause-ref.js';
import type { TerminalOutcome } from '../jobs/outcome.js';
import type { JobStatus, JobTerminal } from '../jobs/records.js';
import { isFinalWaitEvent, type WaitCursor, type WaitStreamEvent } from '../jobs/wait/contract.js';
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
import { formatLaunch, formatWorkflowSlot } from './format/jobs.js';
import { openCliCauseRefRenderer } from './cause-renderer.js';
import { openReadCoralStore, type ReadCoralStoreHandle } from './read-store.js';
import { errorCodeToExit, WaitResumeError, WaitOutputError } from './errors.js';
import { renderHandoffNotice, renderHandoffPublicationIncidents } from './handoff-notice.js';
import { mapWaitSubscriptionError, SOFT_CURSOR_REFUSALS } from './wait-stream-error.js';
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
  drainProgress: boolean;
  signal: AbortSignal;
}>;

type FollowJobsOptions = {
  start: FollowStart;
  reconnectPolicy: ReconnectPolicy;
  connect: (request: FollowConnectionRequest) => Promise<FollowConnection>;
  invocation?: WaitInvocation;
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

/** An empty frontier is a fresh collection, which a continuation states by naming no cursor. */
function serializedCursor(cursor: WaitCursor | undefined): string | undefined {
  return cursor && cursor.jobs.length > 0 ? serializeWaitCursor(cursor) : undefined;
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
    renderOptions.isTTY && ['terminal', 'waiting', 'notice', 'disposition'].includes(event.type) ? '\n' : '';
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

function boundedTimeoutSeconds(deadlineMs: number): number {
  const remaining = Math.max(0, deadlineMs - performance.now());
  return Math.max(1, Math.floor(remaining / 1000) - 1);
}

function withWaitRecovery(error: unknown, jobIds: readonly string[], cursor: WaitCursor | undefined): unknown {
  const body = error instanceof BackendToolHttpError && isRecord(error.body) ? error.body : null;
  if (!(error instanceof BackendUnreachableError) && body?.code !== 'backend_unreachable') {
    return error;
  }

  const message = body !== null && typeof body.message === 'string' ? body.message : (error as Error).message;
  return new BackendUnreachableError(
    `${message} Run \`coral-cli backend status\` and follow its recovery guidance, then rerun ` +
      `\`coral-cli wait jobs ${jobIds.join(' ')}${serializedCursor(cursor) ? ` --cursor ${serializedCursor(cursor)}` : ''}\` to continue waiting.`,
  );
}

type FollowSessionState = {
  currentCursor?: WaitCursor;
  lastExitCode?: number;
  remainingJobIds: string[];
  sendCursor: boolean;
  retriesLeft: number;
  hasOpenedSubscription: boolean;
  interrupted: boolean;
  carrierUnknownJobIds: string[];
};

type FollowStep = { kind: 'retry' } | { kind: 'exit'; code: number };

async function connectFollowStream(
  options: FollowJobsOptions,
  state: FollowSessionState,
  controller: AbortController,
  deadlineMs: number,
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
    });
    options.invocation?.check();
    return { kind: 'connected', connection };
  } catch (error) {
    options.invocation?.check();
    if (state.interrupted) {
      return { kind: 'exit', code: finishInterruptedFollow(state) };
    }
    const handledError = mapWaitSubscriptionError(error);
    if (
      handledError instanceof BackendToolHttpError &&
      isRecord(handledError.body) &&
      SOFT_CURSOR_REFUSALS.includes(String(handledError.body.code))
    ) {
      if (!state.sendCursor) {
        options.emitError(withWaitRecovery(handledError, state.remainingJobIds, state.currentCursor));
        return { kind: 'exit', code: fallbackExitCode() };
      }
      writeStdout(`${WAIT_CURSOR_REPLAY_NOTICE}\n`);
      state.currentCursor = undefined;
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
    if (state.interrupted) {
      return { kind: 'exit', code: finishInterruptedFollow(state) };
    }
    return shouldRetry ? { kind: 'retry' } : { kind: 'exit', code: 1 };
  }
}

function finishDelegatedFollow(
  outcome: HandoffOutcome,
  options: FollowJobsOptions,
  state: FollowSessionState,
): FollowStep {
  if (outcome.kind === 'handoff-success') {
    renderHandoffNotice(outcome);
    return { kind: 'exit', code: 0 };
  }
  // A delegated wait already ran to its own end; its 75 may be a provider terminal's code, so it is never retried.
  if (outcome.kind === 'handoff-exit') return { kind: 'exit', code: normalizeExitCode(outcome.exitCode) };
  if (outcome.signal === 'SIGINT') return { kind: 'exit', code: finishInterruptedFollow(state) };
  options.emitError(
    new WaitResumeError(
      `Delegated wait command ended from signal ${outcome.signal}; the jobs may still be running.`,
      state.remainingJobIds,
      serializedCursor(state.currentCursor),
    ),
  );
  return { kind: 'exit', code: errorCodeToExit('transient') };
}

type FollowContext = {
  options: FollowJobsOptions;
  state: FollowSessionState;
  controller: AbortController;
  jobLabels: ReturnType<typeof jobLabelsFor>;
  causeRenderer: ReturnType<typeof openCliCauseRefRenderer>;
  deadlineMs: number;
  pendingOutput: Set<Promise<void>>;
  outputFailure: AbortController;
};

function eventRemainingJobs(event: WaitStreamEvent, current: readonly string[]): string[] {
  if (event.type === 'terminal') return [...event.remainingJobIds];
  if (event.type === 'waiting') return [...event.waitingJobIds];
  if (event.type === 'disposition' && event.disposition !== 'unknown')
    return current.filter((id) => id !== event.jobId);
  return [...current];
}

function followOriginalCommand(options: FollowJobsOptions): string {
  if (options.invocation) return options.invocation.originalCommand;
  const cursor = initialSerializedCursor(options.start);
  return `coral-cli wait jobs ${jobIdsFromStart(options.start).join(' ')}${cursor === undefined ? '' : ` --cursor ${cursor}`}${options.render.embed ? ' --embed' : ''}${options.render.verbose ? ' --verbose' : ''}`;
}

function deliveredFollowExitCode(event: WaitStreamEvent, context: FollowContext): number | undefined {
  const { options } = context;
  // Following a launch ends at its terminal with the outcome's code; a pending artifact is reported, not awaited.
  if (event.type === 'terminal')
    return options.reconnectPolicy === 'until-terminal' ? toExitCode(event.result) : event.exitCode;
  // An empty set is final under either policy, and a refused member makes it a failure that must not read as success.
  if (event.type === 'waiting')
    return options.reconnectPolicy === 'bounded' || event.waitingJobIds.length === 0 ? event.exitCode : undefined;
  return undefined;
}

/** The continuation a cut at this point prints: the remaining jobs and the frontier the client has folded. */
function foldedContinuation(state: FollowSessionState): string {
  const remaining = state.remainingJobIds;
  const unknown = remaining.filter((id) => state.carrierUnknownJobIds.includes(id));
  return (
    formatWaitWaiting(
      {
        type: 'waiting',
        waitingJobIds: remaining,
        ...(unknown.length === 0 ? {} : { carrierUnknownJobIds: unknown }),
      },
      serializedCursor(waitCursorForJobs(state.currentCursor, remaining)) ?? null,
      remaining,
    ) + '\n'
  );
}

/** Ctrl+C must never abort a job: jobs belong to the backend and outlive this follow, so the cut stays resumable. */
function finishInterruptedFollow(state: FollowSessionState): number {
  writeStdout(foldedContinuation(state));
  return 75;
}

async function deliverFollowEvent(event: WaitStreamEvent, context: FollowContext): Promise<void> {
  const { options, state, jobLabels, causeRenderer } = context;
  const renderCursor =
    event.type === 'terminal' ? waitCursorForJobs(state.currentCursor, event.remainingJobIds) : state.currentCursor;
  const cursor = serializedCursor(renderCursor) ?? null;
  state.remainingJobIds = eventRemainingJobs(event, state.remainingJobIds);
  const remaining = state.remainingJobIds;
  const savedContinuation = foldedContinuation(state);
  const renderedEvent = event;
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
        isFinalWaitEvent(event),
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
  if (!isFinalWaitEvent(event)) return { kind: 'continue' };
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
  // A frame renders nothing, so no delivery saves it, yet a cut before the next rendered event must print it; it is
  // never saved ahead of a rendered event that is still being written.
  else if (context.pendingOutput.size === 0) options.invocation?.saveContinuation(foldedContinuation(state));
  return followEventDecision(event, context);
}

async function readFollowSubscription(
  subscription: WaitSubscription,
  context: FollowContext,
): Promise<FollowStep | undefined> {
  const { options, state } = context;
  for await (const raw of subscription) {
    if (state.interrupted) return { kind: 'exit', code: finishInterruptedFollow(state) };
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
  const { options, state, controller } = context;
  options.invocation?.check();
  if (state.interrupted) return { kind: 'exit', code: finishInterruptedFollow(state) };
  if (error instanceof WaitOutputError) throw error;
  const handledError = mapWaitSubscriptionError(error);
  if (
    handledError instanceof BackendToolHttpError &&
    isRecord(handledError.body) &&
    SOFT_CURSOR_REFUSALS.includes(String(handledError.body.code)) &&
    state.sendCursor
  ) {
    writeStdout(`${WAIT_CURSOR_REPLAY_NOTICE}\n`);
    state.currentCursor = undefined;
    state.sendCursor = false;
    return { kind: 'retry' };
  }

  if (!(handledError instanceof Error) || !isTransientStreamError(handledError)) {
    options.emitError(withWaitRecovery(handledError, state.remainingJobIds, state.currentCursor));
    return { kind: 'exit', code: fallbackExitCode() };
  }
  if (state.retriesLeft === 0) {
    options.emitError(
      new WaitResumeError(handledError.message, state.remainingJobIds, serializedCursor(state.currentCursor)),
    );
    return { kind: 'exit', code: errorCodeToExit('transient') };
  }
  state.retriesLeft -= 1;
  const shouldRetry = await waitForRetry(controller.signal, options.backoffScheduler);
  if (state.interrupted) return { kind: 'exit', code: finishInterruptedFollow(state) };
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
  if (state.interrupted) return { kind: 'exit', code: finishInterruptedFollow(state) };
  options.emitError(
    new WaitResumeError(
      'The wait stream ended before a terminal event; the jobs may still be running.',
      state.remainingJobIds,
      serializedCursor(state.currentCursor),
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

function installFollowSignals(context: FollowContext): () => void {
  const { options, state, controller } = context;
  const onInvocationEnd = () => controller.abort();
  const onSigint = () => {
    if (state.remainingJobIds.length === 0) return;
    // A stop that hangs must still be leavable.
    if (state.interrupted) process.exit(75);
    state.interrupted = true;
    controller.abort();
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
    jobLabels: null,
    deadlineMs: performance.now() + (options.invocation?.remainingMs() ?? FOLLOW_TIMEOUT_SECONDS * 1000),
    causeRenderer: openCliCauseRefRenderer(options.projectRoot),
    pendingOutput: new Set(),
    outputFailure: new AbortController(),
    state: {
      currentCursor: parsedCursor,
      remainingJobIds: allJobIds,
      sendCursor: parsedCursor !== undefined,
      retriesLeft: TRANSIENT_RETRY_LIMIT,
      hasOpenedSubscription: false,
      interrupted: false,
      carrierUnknownJobIds: [...allJobIds],
    },
  };
}

async function monitorFollowJobs(context: FollowContext): Promise<number> {
  const { options, state, controller, deadlineMs } = context;
  options.invocation?.check();
  context.jobLabels = jobLabelsFor(options.projectRoot, jobIdsFromStart(options.start));
  options.invocation?.check();
  while (true) {
    if (state.interrupted) return finishInterruptedFollow(state);
    if (state.remainingJobIds.length === 0) return state.lastExitCode ?? 75;
    options.invocation?.check();
    const connected = await connectFollowStream(options, state, controller, deadlineMs);
    if (connected.kind === 'retry') continue;
    if (connected.kind === 'exit') return connected.code;
    const { connection } = connected;
    // A delegated child answers the interrupt with its own continuation, and a second one must not follow it.
    if (state.interrupted && connection.kind !== 'delegated') return finishInterruptedFollow(state);
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
        ? finishDelegatedFollow(connection.outcome, options, state)
        : await consumeFollowSubscription(connection, context);
    if (decision.kind === 'retry') continue;
    return decision.code;
  }
}

export async function followJobs(options: FollowJobsOptions): Promise<number> {
  const prepared = prepareFollowOptions(options);
  const context = createFollowContext(prepared);
  const invocation = context.options.invocation;
  const removeSignals = installFollowSignals(context);
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
    connect: async ({ jobIds, cursor, timeoutSeconds, signal, drainProgress }) => {
      const probeStarted = performance.now();
      let backend;
      try {
        backend = await ensure('jobs.wait', options.pluginRoot);
        const result = await runHandoff(
          {
            kind: 'wait-jobs',
            jobId: options.launchResult.jobId,
            serializedCursor: serializeWaitCursor(cursor ?? { jobs: [] }),
          },
          {
            pluginRoot: options.pluginRoot,
            signal,
            waitProbeRemainingMs: () => Math.max(0, timeoutSeconds * 1000 - (performance.now() - probeStarted)),
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
          jobsWaitRequest({
            jobIds,
            timeoutSeconds,
            drainProgress,
            projectRoot: options.projectRoot,
            ...(cursor ? { cursor } : {}),
          }),
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
