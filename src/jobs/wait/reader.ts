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
};

type FinalPayload =
  | Omit<Extract<WaitStreamEvent, { type: 'terminal' }>, 'cursor' | 'exitCode'>
  | { type: 'waiting'; waitingJobIds: string[]; carrierUnknownJobIds?: string[] };

function finalWaitEvent(session: WaitSession, payload: FinalPayload): WaitStreamEvent {
  return { ...payload, cursor: session.cursor(), exitCode: session.exitCode() };
}

function waitingEvent(session: WaitSession): WaitStreamEvent {
  const unknown = session.unknownCarriers();
  return finalWaitEvent(session, {
    type: 'waiting',
    waitingJobIds: session.remaining(),
    ...(unknown.length ? { carrierUnknownJobIds: unknown } : {}),
  });
}

/** Unknown coverage cannot authorize finalization, even when the observer outlives the read. */
export async function* readWaitSession(input: WaitReadInput): AsyncGenerator<WaitStreamEvent> {
  const { request, time, read } = input;
  const internal = input.internal === true;
  const session = new WaitSession(request.jobIds, request.cursor, input.activeEpochKey, internal);
  const deadline = Number(time.monotonicNow()) + (request.timeoutSeconds ?? 600) * 1000;
  const controller = new AbortController();
  const signal = request.abortSignal ? AbortSignal.any([controller.signal, request.abortSignal]) : controller.signal;
  const bounded = request.drainProgress !== true && !internal;
  const state: DeliveryState = {
    cursor: request.cursor ?? null,
    progressLines: 0,
    progressBytes: 0,
    dispositions: new Map(),
    queuedReported: new Set(),
    notices: new Set(),
    absentReported: new Set(),
  };
  let observing = false;
  let observation: Promise<void> | undefined;
  let lastObservation = -Infinity;
  let deadlineObserved = false;
  let crossedTimer = false;
  let unknownReadAttempts = 0;
  const retryDelays = [250, 1000, 5000];
  try {
    while (!signal.aborted) {
      const admissions = read();
      const deferred = new Set(admissions.filter((job) => job.observationDeferred).map((job) => job.jobId));
      session.reconcile(admissions);
      // A bounded read spends one budget over the whole request; drain and internal reads spend one per poll.
      const progress = session.withProgress(input.visit, (source) =>
        session.select(
          source,
          bounded
            ? { lines: WAIT_PROGRESS_LINES - state.progressLines, bytes: WAIT_PROGRESS_BYTES - state.progressBytes }
            : { lines: WAIT_PROGRESS_LINES, bytes: WAIT_PROGRESS_BYTES },
          bounded ? 20 : null,
        ),
      );
      const now = Number(time.monotonicNow());
      const nearDeadline: boolean = now >= deadline - 250 && !deadlineObserved;
      if (!observing && (now - lastObservation >= 5000 || nearDeadline) && now < deadline) {
        observing = true;
        lastObservation = now;
        deadlineObserved ||= nearDeadline;
        observation = observeCarriers(input, session, signal).finally(() => {
          observing = false;
        });
      }
      yield* admissionEvents(session, state);
      yield* progressEvents(progress, state);
      session.commit(progress);
      const terminals = yield* terminalEvents(session, !bounded);
      if (terminals === 'final') return;
      if (progress.rows.length > 0 || terminals === 'repeated') yield* cursorFrame(session, state);
      yield* carrierEvents(session, state.absentReported);
      if (session.remaining().length === 0) {
        yield waitingEvent(session);
        return;
      }
      if (session.hasProgress()) {
        if (bounded && progress.full) {
          yield waitingEvent(session);
          return;
        }
        // A backlog is read page by page after a macrotask; a client read still stops at its deadline.
        if (internal || Number(time.monotonicNow()) < deadline) {
          await setImmediate();
          continue;
        }
      }
      const unknownRead = session.remaining().every((id) => session.unknown(id));
      const observedUnknown = unknownRead && session.remaining().some((jobId) => !deferred.has(jobId));
      if (!unknownRead) unknownReadAttempts = 0;
      if (
        (!internal && observedUnknown && unknownReadAttempts === retryDelays.length) ||
        Number(time.monotonicNow()) >= deadline
      ) {
        if (internal && !crossedTimer) await time.sleep(0, { signal });
        if (observing && observation && Number(time.monotonicNow()) < deadline) {
          const observationDeadline = new AbortController();
          const stop = new AbortController();
          const timeout = time.sleep(Math.max(0, deadline - Number(time.monotonicNow())), { signal: stop.signal }).then(
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
        yield waitingEvent(session);
        return;
      }
      await time
        .sleep(
          Math.min(
            observedUnknown ? retryDelays[Math.min(unknownReadAttempts++, retryDelays.length - 1)] : 250,
            Math.max(0, deadline - Number(time.monotonicNow())),
          ),
          { signal },
        )
        .catch(() => undefined);
      crossedTimer = true;
    }
  } finally {
    controller.abort();
  }
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
  yield { type: 'cursor', cursor };
}

function* admissionEvents(session: WaitSession, state: DeliveryState): Generator<WaitStreamEvent> {
  for (const job of session.admissions) {
    if (job.disposition === 'admitted' || state.dispositions.get(job.jobId) === job.disposition) continue;
    state.dispositions.set(job.jobId, job.disposition);
    yield { type: 'disposition', jobId: job.jobId, disposition: job.disposition, message: job.message };
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
    jobId: job.jobId,
    seq: job.detail?.terminalSeq ?? job.detail?.status.lastSeq ?? 0,
    result: { content, outcome, durationMs },
    usage: result.diagnostics.usage,
    continuity: job.continuity ?? null,
    availability,
    epochKey: job.epochKey,
    remainingJobIds: session.remaining(),
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
