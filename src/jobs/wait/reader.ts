import { setImmediate } from 'node:timers/promises';
import { raceWithSignal } from '../../infra/promise-signal.js';
import type { TimePort } from '../../infra/port-types.js';
import type { WaitAdmission, WaitSelection } from './session.js';
import { WaitSession } from './session.js';
import {
  WAIT_PROGRESS_BYTES,
  WAIT_PROGRESS_LINES,
  type ProgressVisit,
  type WaitCursor,
  type WaitEndedBy,
  type WaitStreamEvent,
  type WaitStreamRequest,
} from './contract.js';

type WaitReadInput = {
  request: WaitStreamRequest;
  activeEpochKey: string;
  time: TimePort;
  read: () => WaitAdmission[];
  visit: ProgressVisit;
  internal?: boolean;
  observe?: (session: WaitSession, signal: AbortSignal) => void | Promise<void>;
};

type DeliveryState = {
  /** The cursor the client holds: the request's, until a frame or the final event replaces it. */
  cursor: WaitCursor | null;
  progressLines: number;
  progressBytes: number;
  dispositions: Map<string, string>;
  queuedReported: Set<string>;
  notices: Set<string>;
  absentReported: Set<string>;
  admissionState?: string;
};

type FinalPayload =
  | Omit<Extract<WaitStreamEvent, { type: 'terminal' }>, 'cursor' | 'exitCode'>
  | { type: 'waiting'; waitingJobIds: string[]; carrierUnknownJobIds?: string[]; endedBy: WaitEndedBy };

function finalWaitEvent(session: WaitSession, payload: FinalPayload): WaitStreamEvent {
  return {
    ...payload,
    cursor: session.cursor(),
    exitCode: session.exitCode(),
    executionSelections: session.executionSelections(),
  };
}

function waitingEvent(session: WaitSession, endedBy: WaitEndedBy): WaitStreamEvent {
  const unknown = session.unknownCarriers();
  return finalWaitEvent(session, {
    type: 'waiting',
    waitingJobIds: session.remaining(),
    ...(unknown.length ? { carrierUnknownJobIds: unknown } : {}),
    endedBy,
  });
}

/** An unknown job holds the cursor still, so resuming past its cut serves the same read again with no delay. */
function resumableCut(session: WaitSession, cut: 'deadline' | 'progress-budget'): WaitEndedBy {
  return session.remaining().some((jobId) => session.unknown(jobId)) ? 'unanswered' : cut;
}

type WaitReadContext = {
  input: WaitReadInput;
  session: WaitSession;
  delivery: DeliveryState;
  signal: AbortSignal;
  internal: boolean;
  bounded: boolean;
  deadline: number;
  observing: boolean;
  observation?: Promise<void>;
  lastObservation: number;
  deadlineObserved: boolean;
  crossedTimer: boolean;
  unknownReadAttempts: number;
};

const UNKNOWN_READ_RETRY_DELAYS = [250, 1000, 5000];

/** Unknown coverage cannot authorize finalization, even when the observer outlives the read. */
export async function* readWaitSession(input: WaitReadInput): AsyncGenerator<WaitStreamEvent> {
  const controller = new AbortController();
  const signal = input.request.abortSignal
    ? AbortSignal.any([controller.signal, input.request.abortSignal])
    : controller.signal;
  const context = createWaitReadContext(input, signal);
  const { session, delivery, bounded, internal, deadline } = context;
  try {
    while (!signal.aborted) {
      const deferred = reconcileWaitAdmissions(input, session);
      const progress = selectWaitProgress(context);
      refreshCarrierObservation(context);
      if (yield* pollEvents(session, delivery, progress, bounded)) return;
      // A backlog is read page by page after a macrotask; a client read still stops at its deadline.
      if (session.hasProgress() && (internal || Number(input.time.monotonicNow()) < deadline)) {
        await setImmediate();
        continue;
      }
      const observedUnknown = classifyUnknownRead(context, deferred);
      if (waitReadLimitReached(context, observedUnknown)) {
        yield await finishWaitRead(context);
        return;
      }
      await sleepBeforeNextRead(context, observedUnknown);
    }
  } finally {
    controller.abort();
  }
}

function createWaitReadContext(input: WaitReadInput, signal: AbortSignal): WaitReadContext {
  const { request } = input;
  const internal = input.internal === true;
  const session = new WaitSession(
    request.jobIds,
    request.cursor,
    input.activeEpochKey,
    internal,
    request.executionSelections,
  );
  return {
    input,
    session,
    signal,
    internal,
    bounded: request.drainProgress !== true && !internal,
    deadline: Number(input.time.monotonicNow()) + (request.timeoutSeconds ?? 600) * 1000,
    delivery: {
      cursor: request.cursor ?? null,
      progressLines: 0,
      progressBytes: 0,
      dispositions: new Map(),
      queuedReported: new Set(),
      notices: new Set(),
      absentReported: new Set(),
    },
    observing: false,
    lastObservation: -Infinity,
    deadlineObserved: false,
    crossedTimer: false,
    unknownReadAttempts: 0,
  };
}

function reconcileWaitAdmissions(input: WaitReadInput, session: WaitSession): Set<string> {
  const admissions = input.read();
  const deferred = new Set(admissions.filter((job) => job.observationDeferred).map((job) => job.jobId));
  session.reconcile(admissions);
  for (const admission of session.admissions)
    if (admission.disposition === 'admitted' && !admission.observationDeferred) input.request.onAdmission?.(admission);
  return deferred;
}

function selectWaitProgress({ input, session, delivery, bounded }: WaitReadContext): WaitSelection {
  // A bounded read spends one budget over the whole request; drain and internal reads spend one per poll.
  return session.withProgress(input.visit, (source) =>
    session.select(
      source,
      bounded
        ? { lines: WAIT_PROGRESS_LINES - delivery.progressLines, bytes: WAIT_PROGRESS_BYTES - delivery.progressBytes }
        : { lines: WAIT_PROGRESS_LINES, bytes: WAIT_PROGRESS_BYTES },
      bounded ? 20 : null,
    ),
  );
}

function refreshCarrierObservation(context: WaitReadContext): void {
  const { input, session, signal, deadline } = context;
  const now = Number(input.time.monotonicNow());
  const nearDeadline = now >= deadline - 250 && !context.deadlineObserved;
  if (!context.observing && (now - context.lastObservation >= 5000 || nearDeadline) && now < deadline) {
    context.observing = true;
    context.lastObservation = now;
    context.deadlineObserved ||= nearDeadline;
    context.observation = observeCarriers(input, session, signal).finally(() => {
      context.observing = false;
    });
  }
}

function classifyUnknownRead(context: WaitReadContext, deferred: Set<string>): boolean {
  const { session } = context;
  const unknownRead = session.remaining().every((id) => session.unknown(id));
  const observedUnknown = unknownRead && session.remaining().some((jobId) => !deferred.has(jobId));
  if (!unknownRead) context.unknownReadAttempts = 0;
  return observedUnknown;
}

function waitReadLimitReached(context: WaitReadContext, observedUnknown: boolean): boolean {
  return (
    (!context.internal && observedUnknown && context.unknownReadAttempts === UNKNOWN_READ_RETRY_DELAYS.length) ||
    Number(context.input.time.monotonicNow()) >= context.deadline
  );
}

async function finishWaitRead(context: WaitReadContext): Promise<WaitStreamEvent> {
  const { input, session, signal, internal, deadline } = context;
  const timedOut = Number(input.time.monotonicNow()) >= deadline;
  if (internal && !context.crossedTimer) await input.time.sleep(0, { signal });
  if (context.observing && context.observation && Number(input.time.monotonicNow()) < deadline)
    await waitForCarrierObservation(context, context.observation);
  return waitingEvent(session, timedOut ? resumableCut(session, 'deadline') : 'unanswered');
}

async function waitForCarrierObservation(
  { input, signal, deadline }: WaitReadContext,
  observation: Promise<void>,
): Promise<void> {
  const observationDeadline = new AbortController();
  const stop = new AbortController();
  const timeout = input.time
    .sleep(Math.max(0, deadline - Number(input.time.monotonicNow())), { signal: stop.signal })
    .then(
      () => observationDeadline.abort(),
      () => undefined,
    );
  try {
    await raceWithSignal(observation, AbortSignal.any([signal, observationDeadline.signal]), () => undefined);
  } finally {
    stop.abort();
    void timeout;
  }
}

async function sleepBeforeNextRead(context: WaitReadContext, observedUnknown: boolean): Promise<void> {
  const { input, signal, deadline } = context;
  await input.time
    .sleep(
      Math.min(
        observedUnknown
          ? UNKNOWN_READ_RETRY_DELAYS[Math.min(context.unknownReadAttempts++, UNKNOWN_READ_RETRY_DELAYS.length - 1)]
          : 250,
        Math.max(0, deadline - Number(input.time.monotonicNow())),
      ),
      { signal },
    )
    .catch(() => undefined);
  context.crossedTimer = true;
}

async function observeCarriers(input: WaitReadInput, session: WaitSession, signal: AbortSignal): Promise<void> {
  const pending = session.admissions
    .filter((job) => job.disposition === 'admitted' && !job.detail?.exit)
    .map((job) => job.jobId);
  try {
    await raceWithSignal(Promise.resolve(input.observe?.(session, signal)), signal, () => undefined);
  } catch {
    if (!signal.aborted) session.observeCoverage(pending, pending, 0);
  }
}

/** A poll that delivered something moves the client's cursor before the next cut; one that delivered nothing need not. */
function* cursorFrame(session: WaitSession, state: DeliveryState): Generator<WaitStreamEvent> {
  const cursor = session.cursor();
  if (cursor === null || cursor === state.cursor) return;
  state.cursor = cursor;
  yield { type: 'cursor', cursor, executionSelections: session.executionSelections() };
}

function* admissionEvents(session: WaitSession, state: DeliveryState): Generator<WaitStreamEvent> {
  const selections = session.executionSelections();
  const admissionState = JSON.stringify(selections);
  if (
    selections.length > 0 &&
    session.admissions.some((job) => job.disposition === 'admitted' && job.selection && !job.observationDeferred) &&
    state.admissionState !== admissionState
  ) {
    state.admissionState = admissionState;
    yield { type: 'admission', executionSelections: selections };
  }
  for (const job of session.admissions) {
    if (job.disposition === 'admitted' || state.dispositions.get(job.jobId) === job.disposition) continue;
    state.dispositions.set(job.jobId, job.disposition);
    yield { type: 'disposition', jobId: job.jobId, disposition: job.disposition, message: job.message };
  }
  for (const job of session.admissions) {
    const status = job.detail?.status.finishingStatus;
    if (status === undefined) continue;
    const message = `Execution ${job.jobId}#${job.detail?.status.execution} is finishing: ${status.kind}; ${status.reason}; successor=${status.successor}.`;
    if (state.notices.has(message)) continue;
    state.notices.add(message);
    yield {
      type: 'notice',
      message,
      ...(status.kind === 'blocked' ? { remedy: { kind: 'recovery-quarantine-list' as const } } : {}),
    };
  }
  for (const message of session.notices) {
    if (state.notices.has(message)) continue;
    state.notices.add(message);
    yield { type: 'notice', message };
  }
  for (const job of session.admissions) {
    if (job.disposition === 'admitted' && job.queued && !state.queuedReported.has(job.jobId)) {
      state.queuedReported.add(job.jobId);
      yield job.queued;
    }
  }
}

function* progressEvents(selection: WaitSelection, state: DeliveryState): Generator<WaitStreamEvent> {
  for (const row of selection.rows) {
    state.progressLines += row.lines;
    state.progressBytes += row.bytes;
    yield { type: 'progress', jobId: row.jobId, seq: row.seq, message: row.message, timing: row.timing };
  }
}

function terminalEvent(
  session: WaitSession,
  job: WaitAdmission,
  result: NonNullable<NonNullable<WaitAdmission['detail']>['exit']>,
  final: boolean,
): WaitStreamEvent {
  const availability = job.availability ?? {
    kind: 'failed',
    reason: 'the retained terminal outcome could not be validated',
  };
  const { content, outcome, durationMs } = result;
  const block = {
    type: 'terminal' as const,
    cursor: session.cursor(),
    jobId: job.jobId,
    ...(typeof job.detail?.status.execution === 'number' ? { execution: job.detail.status.execution } : {}),
    seq: job.detail?.terminalSeq ?? job.detail?.status.lastSeq ?? 0,
    result: { content, outcome, durationMs },
    usage: result.diagnostics.usage,
    continuity: job.continuity ?? null,
    availability,
    epochKey: job.epochKey,
    remainingJobIds: session.remaining(),
    executionSelections: session.executionSelections(),
    ...(availability.kind === 'available' ? { resultPath: availability.resultPath } : {}),
  };
  return final ? finalWaitEvent(session, block) : block;
}

/** A bounded read delivers every observed terminal before its single final event. */
function* terminalEvents(
  session: WaitSession,
  drainProgress: boolean,
): Generator<WaitStreamEvent, 'final' | 'repeated' | 'none'> {
  const deliveries = session.admissions.flatMap((job) => {
    if (!job.detail?.exit || !session.terminalDeliverable(job, drainProgress)) return [];
    const delivery = session.terminalDelivery(job);
    return delivery === null ? [] : [{ job, exit: job.detail.exit, delivery }];
  });
  for (const { job, exit } of deliveries.filter(({ delivery }) => delivery === 'repeat')) {
    session.deliverTerminal(job);
    yield terminalEvent(session, job, exit, false);
  }
  const final = deliveries.filter(({ delivery }) => delivery === 'final').at(drainProgress ? 0 : -1);
  if (final === undefined) return deliveries.length > 0 ? 'repeated' : 'none';
  for (const { job, exit } of deliveries.filter(({ delivery }) => delivery === 'final')) {
    session.deliverTerminal(job);
    yield terminalEvent(session, job, exit, job === final.job);
    if (job === final.job) break;
  }
  return 'final';
}

function* carrierEvents(session: WaitSession, absentReported: Set<string>): Generator<WaitStreamEvent> {
  for (const [jobId, coverage] of session.carrierCoverage()) {
    if (coverage.kind !== 'absent' || absentReported.has(jobId)) continue;
    const job = session.admissions.find((job) => job.jobId === jobId);
    if (!job?.detail || job.detail.exit) continue;
    absentReported.add(jobId);
    yield {
      type: 'interrupted',
      jobId,
      storedPhase: job.detail.status.phase,
      observedMaxJournalSeq: coverage.frontier,
      remainingJobIds: session.remaining(),
      observation: { kind: 'carrier_interrupted', reason: 'carrier_absent' },
      continuity: 'unavailable',
      outcome: 'unknown',
    };
  }
}

function* pollEvents(
  session: WaitSession,
  state: DeliveryState,
  progress: WaitSelection,
  bounded: boolean,
): Generator<WaitStreamEvent, boolean> {
  yield* admissionEvents(session, state);
  yield* progressEvents(progress, state);
  session.commit(progress);
  const terminals = yield* terminalEvents(session, !bounded);
  if (terminals === 'final') return true;
  if (progress.rows.length > 0 || terminals === 'repeated') yield* cursorFrame(session, state);
  yield* carrierEvents(session, state.absentReported);
  if (session.remaining().length === 0) {
    yield waitingEvent(session, 'settled');
    return true;
  }
  if (session.hasProgress() && bounded && progress.full) {
    yield waitingEvent(session, resumableCut(session, 'progress-budget'));
    return true;
  }
  return false;
}
