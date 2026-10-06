import { setImmediate } from 'node:timers/promises';
import { raceWithSignal } from '../../infra/promise-signal.js';
import type { TimePort } from '../../infra/port-types.js';
import { waitJobHash } from './cursor.js';
import type { WaitAdmission, WaitSelection } from './session.js';
import { WaitSession } from './session.js';
import {
  WAIT_PROGRESS_BYTES,
  WAIT_PROGRESS_LINES,
  type ProgressVisit,
  type WaitCursorEntry,
  type WaitStreamEvent,
  type WaitStreamRequest,
} from './contract.js';

type WaitReadInput = {
  request: WaitStreamRequest;
  time: TimePort;
  read: () => WaitAdmission[];
  visit: ProgressVisit;
  internal?: boolean;
  observe?: (session: WaitSession, signal: AbortSignal) => void | Promise<void>;
};

type DeliveryState = {
  /** The frontier the client folds from this stream: the last cursor frame plus every later progress entry. */
  frontier: Map<string, WaitCursorEntry>;
  /** A client folds from no cursor, so its stream's first frame is its base even when it equals the request cursor. */
  framed: boolean;
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
  return { ...payload, cursor: session.cursor(session.remaining()), exitCode: session.exitCode() };
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
  const session = new WaitSession(request.jobIds, request.cursor, internal);
  const deadline = Number(time.monotonicNow()) + (request.timeoutSeconds ?? 600) * 1000;
  const controller = new AbortController();
  const signal = request.abortSignal ? AbortSignal.any([controller.signal, request.abortSignal]) : controller.signal;
  const bounded = request.drainProgress !== true && !internal;
  const state: DeliveryState = {
    frontier: new Map(),
    framed: false,
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
      const progress = session.withProgress(input.visit, (sources) =>
        session.select(
          sources,
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
      yield* cursorFrame(session, state);
      yield* admissionEvents(session, state);
      yield* progressEvents(progress, state);
      session.commit(progress);
      yield* cursorFrame(session, state);
      if (yield* terminalEvents(session)) return;
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

/** Any entry the client does not already hold, however it changed, reaches the client before the next cut. */
function* cursorFrame(session: WaitSession, state: DeliveryState): Generator<WaitStreamEvent> {
  const cursor = session.cursor();
  const held = (entry: WaitCursorEntry): boolean => state.frontier.get(entry.hash)?.seq === entry.seq;
  if (state.framed && cursor.jobs.length === state.frontier.size && cursor.jobs.every(held)) return;
  state.framed = true;
  state.frontier = new Map(cursor.jobs.map((entry) => [entry.hash, entry]));
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

/** Each delivered row carries the entry it establishes, so a cut after any row resumes after that row. */
function* progressEvents(selection: WaitSelection, state: DeliveryState): Generator<WaitStreamEvent> {
  for (const row of selection.rows) {
    const entry = { hash: waitJobHash(row.jobId), seq: row.seq };
    state.progressLines += row.lines;
    state.progressBytes += row.bytes;
    state.frontier.set(entry.hash, entry);
    yield { type: 'progress', jobId: row.jobId, seq: row.seq, message: row.message, timing: row.timing, entry };
  }
}

function terminalEvent(
  session: WaitSession,
  job: WaitAdmission,
  result: NonNullable<NonNullable<WaitAdmission['detail']>['exit']>,
): WaitStreamEvent {
  const availability = job.availability ?? {
    kind: 'failed',
    reason: 'the retained terminal outcome could not be validated',
  };
  const { content, outcome, durationMs } = result;
  return finalWaitEvent(session, {
    type: 'terminal',
    jobId: job.jobId,
    seq: job.detail?.terminalSeq ?? job.detail?.status.lastSeq ?? 0,
    result: { content, outcome, durationMs },
    usage: result.diagnostics.usage,
    continuity: job.continuity ?? null,
    availability,
    epochKey: job.epochKey,
    remainingJobIds: session.remaining(),
    ...(availability.kind === 'available' ? { resultPath: availability.resultPath } : {}),
  });
}

/**
 * A collected job is requested again only while its artifact was pending; once that settles, its terminal is
 * delivered again with the settled availability.
 */
function* terminalEvents(session: WaitSession): Generator<WaitStreamEvent, boolean> {
  for (const job of session.admissions) {
    if (!job.detail?.exit || !session.terminalDeliverable(job)) continue;
    const collected = session.collected(job);
    if (collected && session.artifactPending(job)) continue;
    if (!collected) session.collect(job);
    yield terminalEvent(session, job, job.detail.exit);
    return true;
  }
  return false;
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
