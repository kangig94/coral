import { setImmediate } from 'node:timers/promises';
import type { WaitProgressLine } from './session.js';
import type { ProgressVisit, WaitCursorEntry } from './contract.js';
import { sameEpoch } from '../../store/epoch/identity.js';
import { raceWithSignal } from '../../infra/promise-signal.js';
import type { TimePort } from '../../infra/port-types.js';
import type { WaitAdmission } from './session.js';
import { shortenWaitLine, WaitSession } from './session.js';
import { WAIT_PROGRESS_BYTES, WAIT_PROGRESS_LINES } from './snapshot.js';
import { type WaitStreamEvent, type WaitStreamRequest } from './contract.js';

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
  progressLost: Set<string>;
};

type FinalPayload =
  | Omit<Extract<WaitStreamEvent, { type: 'terminal' }>, 'cursor' | 'exitCode'>
  | Omit<Extract<WaitStreamEvent, { type: 'artifact' }>, 'cursor' | 'exitCode'>
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
    progressLost: new Set(),
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
      // Drain and internal reads deliver a backlog page by page, never a whole history in one synchronous pass.
      const progress = session.withProgress(input.visit, (sources) => {
        const positioned = session.position(sources, bounded ? 20 : null, WAIT_PROGRESS_LINES, WAIT_PROGRESS_BYTES);
        return session.select(
          sources,
          bounded ? WAIT_PROGRESS_LINES - state.progressLines : WAIT_PROGRESS_LINES,
          bounded ? WAIT_PROGRESS_BYTES - state.progressBytes : WAIT_PROGRESS_BYTES,
          positioned,
        );
      });
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
      yield* progressEvents(session, state, bounded, internal, progress.lines);
      session.advanceSilently(progress.advances);
      yield* cursorFrame(session, state);
      const sliced = progress.cut && !progress.full;
      if (yield* terminalEvents(session, bounded, sliced)) return;
      yield* carrierEvents(session, state.absentReported);
      if (session.remaining().length === 0) {
        yield waitingEvent(session);
        return;
      }
      // A poll cut short by its row allowance resumes after a macrotask; only a spent output budget or the deadline ends it.
      if (sliced && (internal || Number(time.monotonicNow()) < deadline)) {
        await setImmediate();
        continue;
      }
      // An internal reader drains its backlog before its deadline answers; a client drain stops at its deadline.
      if (!bounded && session.hasProgress() && (internal || Number(time.monotonicNow()) < deadline)) {
        await setImmediate();
        continue;
      }
      const unknownRead = session.remaining().every((id) => session.progressState(id) === 'unknown');
      const observedUnknown = unknownRead && session.remaining().some((jobId) => !deferred.has(jobId));
      if (!unknownRead) unknownReadAttempts = 0;
      if (
        (!internal && observedUnknown && unknownReadAttempts === retryDelays.length) ||
        (bounded && session.hasProgress()) ||
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
  const held = (entry: WaitCursorEntry): boolean => {
    const client = state.frontier.get(entry.hash);
    return (
      client !== undefined &&
      client.epoch === entry.epoch &&
      client.seq === entry.seq &&
      client.lineOffset === entry.lineOffset &&
      client.flags === entry.flags
    );
  };
  if (state.framed && cursor.jobs.length === state.frontier.size && cursor.jobs.every(held)) return;
  state.framed = true;
  state.frontier = new Map(cursor.jobs.map((entry) => [entry.hash, entry]));
  yield { type: 'cursor', cursor };
}

function* admissionEvents(session: WaitSession, state: DeliveryState): Generator<WaitStreamEvent> {
  for (const job of session.admissions) yield* memberAdmissionEvents(job, state);
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

function* memberAdmissionEvents(job: WaitAdmission, state: DeliveryState): Generator<WaitStreamEvent> {
  if (job.disposition !== 'admitted' && state.dispositions.get(job.jobId) !== job.disposition) {
    state.dispositions.set(job.jobId, job.disposition);
    yield { type: 'disposition', jobId: job.jobId, disposition: job.disposition, message: job.message };
  }
  if (job.sourceRead === 'settled-unreadable' && !state.notices.has(`unreadable:${job.jobId}`)) {
    state.notices.add(`unreadable:${job.jobId}`);
    yield {
      type: 'notice',
      message: `Earlier progress for ${job.jobId} cannot be read by this build. ${job.message ?? 'This build cannot read its source; this job leaves the continuation after its retained outcome is delivered.'} Inspect coral-cli jobs detail ${job.jobId} --full.`,
    };
  }
  if (job.progressLost && !state.progressLost.has(job.jobId)) {
    state.progressLost.add(job.jobId);
    yield { type: 'notice', message: `earlier progress for ${job.jobId} is no longer kept` };
  }
}

function terminalSeq(job: WaitAdmission): number {
  return job.detail?.terminalSeq ?? job.detail?.status.lastSeq ?? 0;
}

/** An internal reader receives each row whole, since its consumer acts on messages rather than lines. */
function* progressEvents(
  session: WaitSession,
  state: DeliveryState,
  bounded: boolean,
  internal: boolean,
  selected: WaitProgressLine[],
): Generator<WaitStreamEvent> {
  for (let index = 0; index < selected.length; ) {
    const first = selected[index];
    const group = [first];
    if (internal) {
      while (index + group.length < selected.length) {
        const next = selected[index + group.length];
        if (next.jobId !== first.jobId || !sameEpoch(next.epochKey, first.epochKey) || next.seq !== first.seq) break;
        group.push(next);
      }
    }
    const messages = group.map((line) => (internal ? line.text : shortenWaitLine(line.text)));
    const bytes = messages.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
    if (
      bounded &&
      (state.progressLines + group.length > WAIT_PROGRESS_LINES || state.progressBytes + bytes > WAIT_PROGRESS_BYTES)
    )
      break;
    for (const line of group) session.consume(line);
    state.progressLines += group.length;
    state.progressBytes += bytes;
    index += group.length;
    const entry = session.entry(first.jobId);
    state.frontier.set(entry.hash, entry);
    yield {
      type: 'progress',
      jobId: first.jobId,
      seq: first.seq,
      message: messages.join('\n'),
      timing: first.timing,
      entry,
    };
  }
}

function terminalEvent(
  session: WaitSession,
  job: WaitAdmission,
  result: NonNullable<NonNullable<WaitAdmission['detail']>['exit']>,
): WaitStreamEvent {
  const availability = job.availability ?? { kind: 'failed', cause: 'terminal-unusable', retryScheduled: false };
  const { content, outcome, durationMs } = result;
  return finalWaitEvent(session, {
    type: 'terminal',
    jobId: job.jobId,
    seq: terminalSeq(job),
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
 * An unbounded reader delivers a job's terminal only after its progress, so nothing it reads follows the outcome. A
 * bounded reader holds it while the job's tail is unpositioned or its poll was cut short by the row allowance, so
 * progress the next slice can still deliver within this request never follows the outcome.
 */
function* terminalEvents(session: WaitSession, bounded: boolean, sliced: boolean): Generator<WaitStreamEvent, boolean> {
  for (const job of session.admissions) {
    if (job.disposition !== 'admitted' || !job.detail?.exit) continue;
    if (session.progressState(job.jobId) === 'unread' && (!bounded || sliced || session.positioning(job.jobId)))
      continue;
    if (!session.acknowledged(job.jobId)) {
      session.acknowledge(job);
      yield terminalEvent(session, job, job.detail.exit);
      return true;
    }
    if (session.artifactPending(job.jobId) && job.availability && job.availability.kind !== 'repair-pending') {
      session.settleArtifact(job.jobId);
      yield finalWaitEvent(session, {
        type: 'artifact',
        jobId: job.jobId,
        availability: job.availability,
        remainingJobIds: session.remaining(),
      });
      return true;
    }
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
