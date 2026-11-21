import { encodeWaitAllOutcome, type WaitAllOutcome } from './wait-all-outcome.js';
import { formatRecoveryQuarantineCommand } from './format/backend.js';
import type { WaitExecutionSelection } from '../jobs/wait/execution-selection.js';
import { WaitInvocation, WaitInvocationEnded } from './wait-invocation.js';
import { decodeWaitCursor, WAIT_CURSOR_REPLAY_NOTICE } from '../jobs/wait/cursor.js';
import { setTimeout as delay } from 'node:timers/promises';

import { BackendToolHttpError } from '../transport/http/errors.js';
import type { CauseRef } from '../causality/cause-ref.js';
import type { TerminalOutcome } from '../jobs/outcome.js';
import type { JobStatus } from '../jobs/records.js';
import { isFinalWaitEvent, type WaitCursor, type WaitStreamEvent } from '../jobs/wait/contract.js';
import { waitTerminalExitCode } from '../jobs/wait/session.js';
import { advanceWaitRenderCursor, isWaitHandoverNotice, parseWaitStreamEventValue } from '../jobs/wait/stream-event.js';
import { BackendUnreachableError, isTransientStreamError, TransientHttpError } from '../infra/http-errors.js';
import { isRecord } from '../infra/json.js';
import { IpcRequestTimeout } from '../transport/ipc/client.js';
import { formatWorkflowSlot } from './format/jobs.js';
import { openCliCauseRefRenderer } from './cause-renderer.js';
import { openReadCoralStore, type ReadCoralStoreHandle } from './read-store.js';
import { errorCodeToExit, WaitResumeError, WaitOutputError } from './errors.js';
import { mapWaitSubscriptionError, SOFT_CURSOR_REFUSALS } from './wait-stream-error.js';
import {
  formatWaitProgress,
  formatWaitQueued,
  formatWaitTerminal,
  formatWaitCarrierInterrupted,
  formatWaitWaiting,
  renderWaitLine,
  waitContinuationCommand,
  type WaitContinuationMode,
  type WaitRenderContext,
} from './format/wait.js';

const TRANSIENT_RETRY_LIMIT = 2;
const TRANSIENT_RETRY_DELAY_MS = 1_000;

type BackoffScheduler = (delayMs: number) => Promise<void>;

// `unknown`, not `WaitStreamEvent`: the wire carries whatever the coordinator's build emits, which can be
// a type this build predates. `followJobs` validates each item through `parseWaitStreamEventValue` before
// it becomes a `WaitStreamEvent` — this type stays honest about what actually crosses the boundary.
type WaitSubscription = AsyncIterable<unknown> & {
  close(): Promise<void>;
};

type FollowConnectionRequest = Readonly<{
  jobIds: readonly string[];
  cursor?: WaitCursor;
  drainProgress?: true;
  executionSelections: WaitExecutionSelection[];
  signal: AbortSignal;
}>;

type FollowJobsOptions = {
  jobIds: readonly string[];
  serializedCursor?: string;
  waitForAll?: boolean;
  priorOutcome?: WaitAllOutcome;
  connect: (request: FollowConnectionRequest) => Promise<WaitSubscription>;
  invocation?: WaitInvocation;
  projectRoot: string;
  emitError: (error: unknown) => void;
  render: WaitRenderContext & {
    embed: boolean;
    verbose: boolean;
  };
  backoffScheduler?: BackoffScheduler;
};

type FollowRender = FollowJobsOptions['render'] & {
  continuationMode: WaitContinuationMode;
  allOutcome?: WaitAllOutcome;
};

function writeStdout(text: string): void {
  process.stdout.write(text);
}

/** A wait must not hold the epoch lock that a succession needs. */
function readJobStatus(projectRoot: string, jobId: string): JobStatus | undefined {
  let handle: ReadCoralStoreHandle;
  try {
    handle = openReadCoralStore(projectRoot);
  } catch {
    return undefined;
  }
  try {
    return handle.store.jobs.detail(jobId)?.status;
  } catch {
    return undefined;
  } finally {
    handle.close();
  }
}

type JobLabel = Readonly<{
  stream: string;
  terminal: string;
}>;

function admittedJobLabel(event: WaitStreamEvent, context: FollowContext): JobLabel | undefined {
  if (event.type !== 'progress' && event.type !== 'queued' && event.type !== 'terminal' && event.type !== 'interrupted')
    return undefined;
  const { jobId } = event;
  const { options, jobLabels } = context;
  if (jobLabels.has(jobId)) return jobLabels.get(jobId);
  const index = options.jobIds.indexOf(jobId);
  if (index === -1) return undefined;

  const slot = formatWorkflowSlot(readJobStatus(options.projectRoot, jobId) ?? {});
  const numbered = options.jobIds.length > 1;
  const label =
    slot === null
      ? numbered
        ? { stream: `j${index}`, terminal: jobId }
        : undefined
      : { stream: numbered ? `j${index} · slot ${slot}` : `slot ${slot}`, terminal: `${jobId} (slot ${slot})` };
  jobLabels.set(jobId, label);
  return label;
}

function formatFollowWaitEvent(
  event: WaitStreamEvent,
  cursor: string | null,
  jobLabel: JobLabel | undefined,
  resumeJobIds: readonly string[],
  renderOptions: FollowRender,
  renderCauseRef?: (ref: CauseRef, terminalOutcomeDiagnostic?: TerminalOutcome, epochKey?: string) => string,
): string {
  let line!: string;
  switch (event.type) {
    case 'admission':
    case 'cursor':
      return '';
    case 'notice':
      line =
        event.remedy?.kind === 'recovery-quarantine-list'
          ? `${event.message}\n${formatRecoveryQuarantineCommand({ kind: 'list' })}`
          : event.message;
      break;
    case 'disposition':
      line = `Job ${event.jobId}: ${event.disposition}${event.message ? ` — ${event.message}` : ''}`;
      break;
    case 'progress':
      line = formatWaitProgress(event, jobLabel?.stream);
      break;
    case 'queued':
      line = formatWaitQueued(event, jobLabel?.stream);
      break;
    case 'terminal':
      line = formatWaitTerminal(event, cursor, renderOptions.embed, {
        describeCauseRef: renderCauseRef
          ? (ref) => renderCauseRef(ref, event.result.outcome, 'epochKey' in event ? event.epochKey : undefined)
          : undefined,
        verbose: renderOptions.verbose,
        label: jobLabel?.terminal,
        continuationMode: renderOptions.continuationMode,
        allOutcome: renderOptions.allOutcome,
      });
      break;
    case 'interrupted':
      line = formatWaitCarrierInterrupted({
        ...event,
        jobId: jobLabel?.terminal ?? event.jobId,
      });
      break;
    case 'waiting':
      line = formatWaitWaiting(event, cursor, resumeJobIds, renderOptions.continuationMode, renderOptions.allOutcome);
      break;
  }

  return line;
}

function emitWaitEvent(
  event: WaitStreamEvent,
  cursor: string | null,
  jobLabel: JobLabel | undefined,
  resumeJobIds: readonly string[],
  renderOptions: FollowRender,
  renderCauseRef?: (ref: CauseRef, terminalOutcomeDiagnostic?: TerminalOutcome, epochKey?: string) => string,
  onDelivered?: () => void,
): Promise<void> {
  const line = formatFollowWaitEvent(event, cursor, jobLabel, resumeJobIds, renderOptions, renderCauseRef);

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

function withWaitRecovery(error: unknown, state: FollowSessionState): unknown {
  const body = error instanceof BackendToolHttpError && isRecord(error.body) ? error.body : null;
  if (!(error instanceof BackendUnreachableError) && body?.code !== 'backend_unreachable') {
    return error;
  }

  const message = body !== null && typeof body.message === 'string' ? body.message : (error as Error).message;
  return new BackendUnreachableError(
    `${message} Run \`coral-cli backend status\` and follow its recovery guidance, then rerun ` +
      `\`${waitContinuationCommand(state.remainingJobIds, state.currentCursor ?? null, state.continuationMode, continuationOutcome(state))}\`` +
      ` to continue waiting.`,
  );
}

type FollowSessionState = {
  readonly continuationMode: WaitContinuationMode;
  readonly requestJobIds: readonly string[];
  readonly absentCarriers: Set<string>;
  allOutcome?: WaitAllOutcome;
  executionSelections: WaitExecutionSelection[];
  currentCursor?: WaitCursor;
  openedCursor?: WaitCursor;
  remainingJobIds: string[];
  sendCursor: boolean;
  retriesLeft: number;
  hasOpenedSubscription: boolean;
  carrierUnknownJobIds: string[];
};

type FollowStep = { kind: 'retry' } | { kind: 'exit'; code: number };

async function connectFollowStream(
  options: FollowContext['options'],
  state: FollowSessionState,
): Promise<FollowStep | { kind: 'connected'; subscription: WaitSubscription }> {
  try {
    return await openFollowConnection(options, state);
  } catch (error) {
    return recoverFollowConnection(options, state, error);
  }
}

type FollowContext = {
  options: FollowJobsOptions & { invocation: WaitInvocation };
  state: FollowSessionState;
  jobLabels: Map<string, JobLabel | undefined>;
  causeRenderer: ReturnType<typeof openCliCauseRefRenderer>;
};

function eventRemainingJobs(event: WaitStreamEvent, current: readonly string[]): string[] {
  if (event.type === 'terminal') return [...event.remainingJobIds];
  if (event.type === 'waiting') return [...event.waitingJobIds];
  if (event.type === 'disposition' && event.disposition !== 'unknown')
    return current.filter((id) => id !== event.jobId);
  return [...current];
}

function continuationOutcome(state: FollowSessionState): WaitAllOutcome | undefined {
  const outcome = state.allOutcome;
  if (outcome?.kind !== 'terminal') return outcome;
  const idsBeforeFailure = state.requestJobIds.slice(0, outcome.precedingJobs);
  return { ...outcome, precedingJobs: state.remainingJobIds.filter((id) => idsBeforeFailure.includes(id)).length };
}

function foldedContinuation(state: FollowSessionState): string {
  const remaining = state.remainingJobIds;
  const unknown = remaining.filter((id) => state.carrierUnknownJobIds.includes(id));
  return (
    formatWaitWaiting(
      {
        type: 'waiting',
        waitingJobIds: remaining,
        ...(unknown.length === 0 ? {} : { carrierUnknownJobIds: unknown }),
        carrierAbsentJobIds: remaining.filter((id) => state.absentCarriers.has(id)),
      },
      state.currentCursor ?? null,
      remaining,
      state.continuationMode,
      continuationOutcome(state),
    ) + '\n'
  );
}

function followEventDecision(event: WaitStreamEvent, context: FollowContext): FollowStep | { kind: 'continue' } {
  const { options, state } = context;
  if (options.waitForAll) {
    if (event.type === 'terminal') {
      const code = waitTerminalExitCode(event.result);
      const precedingJobs = state.requestJobIds.indexOf(event.jobId);
      if (
        code !== 0 &&
        precedingJobs !== -1 &&
        (state.allOutcome?.kind !== 'terminal' || precedingJobs < state.allOutcome.precedingJobs)
      )
        state.allOutcome = { kind: 'terminal', code, precedingJobs };
    }
    if (event.type === 'disposition' && event.disposition !== 'unknown') state.allOutcome ??= { kind: 'refused' };
  }
  if (!isFinalWaitEvent(event)) return { kind: 'continue' };
  if (state.remainingJobIds.length > 0) {
    if (event.type === 'terminal' && options.waitForAll) return { kind: 'retry' };
    if (
      event.type === 'waiting' &&
      (event.exitCode === 75 || options.waitForAll) &&
      ((event.endedBy === 'deadline' &&
        state.remainingJobIds.every(
          (id) => !state.absentCarriers.has(id) && !event.carrierUnknownJobIds?.includes(id),
        )) ||
        (event.endedBy === 'progress-budget' && event.cursor !== null && event.cursor !== state.openedCursor))
    )
      return { kind: 'retry' };
  }
  const outcome = state.allOutcome;
  if (outcome?.kind === 'terminal') return { kind: 'exit', code: outcome.code };
  if (outcome?.kind === 'refused') return { kind: 'exit', code: 1 };
  return { kind: 'exit', code: event.exitCode };
}

async function applyFollowStreamEvent(
  event: WaitStreamEvent,
  context: FollowContext,
): Promise<FollowStep | { kind: 'continue' }> {
  const { options, state, causeRenderer } = context;
  options.invocation.check();
  state.remainingJobIds = eventRemainingJobs(event, state.remainingJobIds);
  if (event.type === 'interrupted') {
    state.carrierUnknownJobIds = state.carrierUnknownJobIds.filter((id) => id !== event.jobId);
    state.absentCarriers.add(event.jobId);
  } else if (event.type === 'terminal') state.absentCarriers.delete(event.jobId);
  else if (event.type === 'waiting') {
    state.carrierUnknownJobIds = [...(event.carrierUnknownJobIds ?? [])];
    if (event.carrierAbsentJobIds !== undefined) {
      state.absentCarriers.clear();
      for (const id of event.carrierAbsentJobIds) state.absentCarriers.add(id);
    }
  }
  if ('executionSelections' in event && event.executionSelections !== undefined)
    state.executionSelections = event.executionSelections;
  const { cursor, shouldRender } = advanceWaitRenderCursor(state.currentCursor, event);
  state.currentCursor = cursor;
  const step = followEventDecision(event, context);
  const continuation = foldedContinuation(state);
  if (step.kind === 'retry') {
    state.retriesLeft = TRANSIENT_RETRY_LIMIT;
    if (event.type === 'waiting') {
      options.invocation.saveContinuation(continuation);
      return step;
    }
  }
  if (shouldRender) {
    const renderedEvent =
      step.kind === 'retry' && event.type === 'terminal' ? { ...event, exitCode: undefined } : event;
    await emitWaitEvent(
      renderedEvent.type === 'waiting'
        ? { ...renderedEvent, carrierAbsentJobIds: [...state.absentCarriers] }
        : renderedEvent,
      cursor ?? null,
      admittedJobLabel(event, context),
      state.remainingJobIds,
      { ...options.render, continuationMode: state.continuationMode, allOutcome: continuationOutcome(state) },
      causeRenderer.render,
      () =>
        options.invocation.saveContinuation(
          continuation,
          step.kind === 'exit',
          true,
          step.kind === 'exit' ? step.code : undefined,
        ),
    ).catch((error: unknown) => {
      throw new WaitOutputError(error, options.invocation.originalCommand);
    });
  } else {
    options.invocation.saveContinuation(continuation);
  }
  return step;
}

async function readFollowSubscription(
  subscription: WaitSubscription,
  context: FollowContext,
): Promise<FollowStep | undefined> {
  for await (const raw of subscription) {
    context.options.invocation.check();
    if (isWaitHandoverNotice(raw)) return { kind: 'retry' };
    const event = parseWaitStreamEventValue(raw);
    if (event === null) continue;
    const decision = await applyFollowStreamEvent(event, context);
    if (decision.kind !== 'continue') return decision;
  }
  return undefined;
}

async function followReadFailure(error: unknown, context: FollowContext): Promise<FollowStep> {
  const { options, state } = context;
  options.invocation.check();
  if (error instanceof WaitOutputError) throw error;
  const handledError = mapWaitSubscriptionError(error, state.continuationMode, continuationOutcome(state));
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
    options.emitError(withWaitRecovery(handledError, state));
    return { kind: 'exit', code: fallbackExitCode() };
  }
  if (state.retriesLeft === 0) {
    options.emitError(
      new WaitResumeError(
        handledError.message,
        state.remainingJobIds,
        state.currentCursor,
        state.continuationMode,
        continuationOutcome(state),
      ),
    );
    return { kind: 'exit', code: errorCodeToExit('transient') };
  }
  state.retriesLeft -= 1;
  const shouldRetry = await waitForRetry(options.invocation.signal, options.backoffScheduler);
  return shouldRetry ? { kind: 'retry' } : { kind: 'exit', code: 1 };
}

async function consumeFollowSubscription(subscription: WaitSubscription, context: FollowContext): Promise<FollowStep> {
  const { options, state } = context;
  state.hasOpenedSubscription = true;
  try {
    const decision = await readFollowSubscription(subscription, context);
    if (decision) return decision;
  } catch (error) {
    return await followReadFailure(error, context);
  } finally {
    if (options.invocation.signal.aborted) void subscription.close().catch(() => undefined);
    else await options.invocation.run(() => subscription.close());
  }
  options.invocation.check();
  options.emitError(
    new WaitResumeError(
      'The wait stream ended before a terminal event; the jobs may still be running.',
      state.remainingJobIds,
      state.currentCursor,
      state.continuationMode,
      continuationOutcome(state),
    ),
  );
  return { kind: 'exit', code: errorCodeToExit('transient') };
}

async function monitorFollowJobs(context: FollowContext): Promise<number> {
  const { options, state } = context;
  options.invocation.check();
  while (state.remainingJobIds.length > 0) {
    options.invocation.check();
    const connected = await connectFollowStream(options, state);
    if (connected.kind === 'retry') continue;
    if (connected.kind === 'exit') return connected.code;
    options.invocation.saveContinuation(foldedContinuation(state));
    const decision = await consumeFollowSubscription(connected.subscription, context);
    if (decision.kind === 'exit') return decision.code;
  }
  return 75;
}

export async function followJobs(options: FollowJobsOptions): Promise<number> {
  const mode = options.waitForAll ? 'all' : 'stream';
  const rawCursor = options.serializedCursor;
  const invocation =
    options.invocation ??
    new WaitInvocation('stream', [
      'node',
      'coral-cli',
      'jobs',
      'wait',
      ...options.jobIds,
      ...(options.waitForAll ? ['--all'] : []),
      ...(options.priorOutcome === undefined ? [] : ['--all-outcome', encodeWaitAllOutcome(options.priorOutcome)]),
      ...(rawCursor === undefined ? [] : ['--cursor', rawCursor]),
      ...(options.render.embed ? ['--embed'] : []),
      ...(options.render.verbose ? ['--verbose'] : []),
    ]);
  const decoded = rawCursor === undefined ? undefined : decodeWaitCursor(rawCursor);
  const parsedCursor = decoded?.kind === 'decoded' ? rawCursor : undefined;
  if (decoded?.kind === 'rejected') writeStdout(`${WAIT_CURSOR_REPLAY_NOTICE}\n`);
  const context: FollowContext = {
    options: { ...options, invocation },
    jobLabels: new Map(),
    causeRenderer: openCliCauseRefRenderer(options.projectRoot),
    state: {
      continuationMode: mode,
      requestJobIds: options.jobIds,
      absentCarriers: new Set(),
      allOutcome: options.priorOutcome,
      currentCursor: parsedCursor,
      executionSelections: [],
      remainingJobIds: [...options.jobIds],
      sendCursor: parsedCursor !== undefined,
      retriesLeft: TRANSIENT_RETRY_LIMIT,
      hasOpenedSubscription: false,
      carrierUnknownJobIds: [...options.jobIds],
    },
  };
  try {
    return await invocation.run(() => monitorFollowJobs(context));
  } catch (error: unknown) {
    if (error instanceof WaitOutputError) {
      options.emitError(error);
      return 75;
    }
    if (!(error instanceof WaitInvocationEnded)) throw error;
    invocation.flushContinuation();
    return invocation.completedExitCode ?? 75;
  } finally {
    context.causeRenderer.close();
    if (options.invocation === undefined) invocation.dispose();
  }
}

async function openFollowConnection(
  options: FollowContext['options'],
  state: FollowSessionState,
): Promise<{ kind: 'connected'; subscription: WaitSubscription }> {
  const cursor = state.currentCursor;
  state.openedCursor = cursor;
  state.sendCursor = cursor !== undefined;
  const subscription = await options.connect({
    jobIds: state.remainingJobIds,
    executionSelections: state.executionSelections,
    ...(options.waitForAll ? { drainProgress: true } : {}),
    ...(cursor === undefined ? {} : { cursor }),
    signal: options.invocation.signal,
  });
  if (options.invocation.signal.aborted) {
    void subscription.close().catch(() => undefined);
    options.invocation.check();
  }
  return { kind: 'connected', subscription };
}

async function recoverFollowConnection(
  options: FollowContext['options'],
  state: FollowSessionState,
  error: unknown,
): Promise<FollowStep> {
  options.invocation.check();
  const handledError = mapWaitSubscriptionError(error, state.continuationMode, continuationOutcome(state));
  const cursorRecovery = recoverFollowCursor(handledError, options, state);
  if (cursorRecovery !== null) return cursorRecovery;
  if (!(handledError instanceof Error) || !isTransientStreamError(handledError)) {
    options.emitError(withWaitRecovery(handledError, state));
    return { kind: 'exit', code: fallbackExitCode() };
  }
  if (state.retriesLeft === 0) return exhaustedFollowConnection(handledError, options, state);
  state.retriesLeft -= 1;
  const shouldRetry = await waitForRetry(options.invocation.signal, options.backoffScheduler);
  return shouldRetry ? { kind: 'retry' } : { kind: 'exit', code: 1 };
}

function recoverFollowCursor(error: unknown, options: FollowJobsOptions, state: FollowSessionState): FollowStep | null {
  if (
    !(error instanceof BackendToolHttpError) ||
    !isRecord(error.body) ||
    !SOFT_CURSOR_REFUSALS.includes(String(error.body.code))
  )
    return null;
  if (!state.sendCursor) {
    options.emitError(withWaitRecovery(error, state));
    return { kind: 'exit', code: fallbackExitCode() };
  }
  writeStdout(`${WAIT_CURSOR_REPLAY_NOTICE}\n`);
  state.currentCursor = undefined;
  state.sendCursor = false;
  return { kind: 'retry' };
}

function exhaustedFollowConnection(error: Error, options: FollowJobsOptions, state: FollowSessionState): FollowStep {
  if (state.hasOpenedSubscription || error instanceof TransientHttpError || error instanceof IpcRequestTimeout) {
    options.emitError(
      new WaitResumeError(
        error.message,
        state.remainingJobIds,
        state.currentCursor,
        state.continuationMode,
        continuationOutcome(state),
      ),
    );
    return { kind: 'exit', code: errorCodeToExit('transient') };
  }
  options.emitError(withWaitRecovery(error, state));
  return { kind: 'exit', code: fallbackExitCode() };
}
