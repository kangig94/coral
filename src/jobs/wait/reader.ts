import type { WaitProgressLine } from './session.js';
import { LegacyWaitDelivery } from './legacy.js';
import type { ProgressVisit } from './contract.js';
import { sameEpoch } from '../../store/epoch/identity.js';
import { raceWithSignal } from '../../infra/promise-signal.js';
import type { TimePort } from '../../infra/port-types.js';
import type { WaitAdmission } from './session.js';
import { shortenWaitLine, WaitSession, WaitSessionError } from './session.js';
import { WAIT_PROGRESS_BYTES, WAIT_PROGRESS_LINES } from './snapshot.js';
import { type WaitStreamEvent, type WaitStreamRequest } from './contract.js';

type WaitReadInput = {
  request: WaitStreamRequest;
  time: TimePort;
  activeEpochKey: string;
  read: () => WaitAdmission[];
  visit: ProgressVisit;
  internal?: boolean;
  observe?: (session: WaitSession, signal: AbortSignal) => void | Promise<void>;
};

type DeliveryState = {
  progressLines: number;
  progressBytes: number;
  dispositions: Map<string, string>;
  queuedReported: Set<string>;
  notices: Set<string>;
  absentReported: Set<string>;
  progressLost: Set<string>;
};

type FinalPayload =
  | Omit<Extract<WaitStreamEvent, { type: 'terminal'; version: 'jobs.wait.v3' }>, 'version' | 'cursor' | 'exitCode'>
  | Omit<Extract<WaitStreamEvent, { type: 'artifact' }>, 'version' | 'cursor' | 'exitCode'>
  | { type: 'waiting'; waitingJobIds: string[]; carrierUnknownJobIds?: string[] };

function finalWaitEvent(
  session: WaitSession,
  request: WaitStreamRequest,
  legacy: LegacyWaitDelivery,
  payload: FinalPayload,
): WaitStreamEvent {
  if (request.supportsWaitV3 === true)
    return {
      ...payload,
      version: 'jobs.wait.v3',
      cursor: session.cursor(session.remaining()),
      exitCode: session.exitCode(),
    };
  if (request.supportsWaitV2 !== true) request.onLegacyCursor?.(legacy.cursor(false));
  const cursor = request.supportsWaitV2 === true ? legacy.cursor(true) : undefined;
  if (payload.type === 'waiting') return { ...payload, ...(cursor ? { cursor } : {}) };
  if (payload.type === 'artifact' || payload.availability.kind !== 'available')
    throw new WaitSessionError('wait_epoch_unsupported', 'This result requires a V3 reader.');
  const { availability, ...terminal } = payload;
  return { ...terminal, resultPath: availability.resultPath, ...(cursor ? { version: 'jobs.wait.v2', cursor } : {}) };
}

function waitingEvent(session: WaitSession, request: WaitStreamRequest, legacy: LegacyWaitDelivery): WaitStreamEvent {
  const unknown = session.unknownCarriers();
  return finalWaitEvent(session, request, legacy, {
    type: 'waiting',
    waitingJobIds: session.remaining(),
    ...(unknown.length ? { carrierUnknownJobIds: unknown } : {}),
  });
}

/** Unknown coverage cannot authorize finalization, even when the observer outlives the read. */
export async function* readWaitSession(input: WaitReadInput): AsyncGenerator<WaitStreamEvent> {
  const { request, time, activeEpochKey, read } = input;
  const session = new WaitSession(request.jobIds, request.cursor, activeEpochKey, input.internal);
  const legacy = new LegacyWaitDelivery(session, activeEpochKey);
  const deadline = Number(time.monotonicNow()) + (request.timeoutSeconds ?? 600) * 1000;
  const controller = new AbortController();
  const signal = request.abortSignal ? AbortSignal.any([controller.signal, request.abortSignal]) : controller.signal;
  const state: DeliveryState = {
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
      if (request.supportsWaitV3 !== true) {
        legacy.reconcile();
        validateLegacyAdmission(session);
      }
      const bounded = !request.drainProgress && !input.internal && request.supportsWaitV3 === true;
      const progress = session.withProgress(input.visit, (sources) => {
        const selectedSources = request.supportsWaitV3 === true ? sources : legacy.sources(sources);
        session.position(selectedSources, bounded ? 20 : null, WAIT_PROGRESS_LINES, WAIT_PROGRESS_BYTES);
        return session.select(
          selectedSources,
          bounded ? WAIT_PROGRESS_LINES - state.progressLines : Infinity,
          bounded ? WAIT_PROGRESS_BYTES - state.progressBytes : Infinity,
        );
      });
      session.observeEmpty(progress.exhaustedJobIds);
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
      yield* admissionEvents(session, request, state);
      const terminals = pendingTerminals(session, request);
      yield* progressEvents(session, request, state, terminals, input.internal === true, progress.lines, legacy);
      if (yield* terminalEvents(session, request, terminals, legacy)) return;
      yield* carrierEvents(session, request, state.absentReported);
      if (session.remaining().length === 0) {
        yield waitingEvent(session, request, legacy);
        return;
      }
      const unknownRead = session.remaining().every((id) => session.progressState(id) === 'unknown');
      const observedUnknown = unknownRead && session.remaining().some((jobId) => !deferred.has(jobId));
      if (!unknownRead) unknownReadAttempts = 0;
      if (
        (!input.internal && observedUnknown && unknownReadAttempts === retryDelays.length) ||
        (!input.internal &&
          request.drainProgress !== true &&
          request.supportsWaitV3 === true &&
          session.hasProgress()) ||
        Number(time.monotonicNow()) >= deadline
      ) {
        if (input.internal && !crossedTimer) await time.sleep(0, { signal });
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
        yield waitingEvent(session, request, legacy);
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

function validateLegacyAdmission(session: WaitSession): void {
  const missing = session.admissions.filter((job) => job.disposition === 'missing').map((job) => job.jobId);
  if (missing.length > 0)
    throw new WaitSessionError(
      'jobs_not_found',
      `Jobs not found: ${missing.join(', ')}. Remove those IDs to collect the remaining jobs.`,
    );
  const refused = session.admissions.find(
    (job) => job.disposition !== 'admitted' && job.disposition !== 'discovery-unknown',
  );
  if (refused)
    throw new WaitSessionError(
      'wait_epoch_unsupported',
      `Job ${refused.jobId}: ${refused.disposition}. Read coral-cli jobs detail ${refused.jobId} for its retained outcome.`,
    );
}

function* admissionEvents(
  session: WaitSession,
  request: WaitStreamRequest,
  state: DeliveryState,
): Generator<WaitStreamEvent> {
  for (const job of session.admissions) yield* memberAdmissionEvents(job, session, request, state);
  for (const message of session.notices) {
    if (state.notices.has(message)) continue;
    state.notices.add(message);
    if (request.supportsWaitV3 === true)
      yield {
        type: 'notice',
        version: 'jobs.wait.v3',
        message,
      };
  }
  for (const job of session.admissions) {
    if (job.disposition === 'admitted' && job.queued && !state.queuedReported.has(job.jobId)) {
      state.queuedReported.add(job.jobId);
      yield job.queued;
    }
  }
}

function* memberAdmissionEvents(
  job: WaitAdmission,
  session: WaitSession,
  request: WaitStreamRequest,
  state: DeliveryState,
): Generator<WaitStreamEvent> {
  if (job.disposition !== 'admitted' && state.dispositions.get(job.jobId) !== job.disposition) {
    state.dispositions.set(job.jobId, job.disposition);
    if (request.supportsWaitV3 === true)
      yield {
        type: 'disposition',
        version: 'jobs.wait.v3',
        jobId: job.jobId,
        disposition: job.disposition,
        message: job.message,
      };
  }
  if (job.sourceRead === 'settled-unreadable' && !state.notices.has(`unreadable:${job.jobId}`)) {
    state.notices.add(`unreadable:${job.jobId}`);
    if (request.supportsWaitV3 === true)
      yield {
        type: 'notice',
        version: 'jobs.wait.v3',
        message: `Earlier progress for ${job.jobId} cannot be read by this build. ${job.message ?? 'This build cannot read its source; this job leaves the continuation after its retained outcome is delivered.'} Inspect coral-cli jobs detail ${job.jobId} --full.`,
      };
  }
  if (job.progressLost && !state.progressLost.has(job.jobId)) {
    state.progressLost.add(job.jobId);
    if (request.supportsWaitV3 === true)
      yield {
        type: 'notice',
        version: 'jobs.wait.v3',
        message: `earlier progress for ${job.jobId} is no longer kept`,
      };
  }
}

function terminalSeq(job: WaitAdmission): number {
  return job.detail?.terminalSeq ?? job.detail?.status.lastSeq ?? 0;
}

function pendingTerminals(session: WaitSession, request: WaitStreamRequest): WaitAdmission[] {
  const terminals = session.admissions.filter((job) => job.disposition === 'admitted' && job.detail?.exit);
  const versionless = request.supportsWaitV3 !== true && request.supportsWaitV2 !== true;
  if (versionless) {
    terminals.sort((a, b) => terminalSeq(a) - terminalSeq(b));
    const hidden = terminals.find(
      (job) =>
        !session.acknowledged(job.jobId) &&
        request.cursor?.version === undefined &&
        request.cursor !== undefined &&
        terminalSeq(job) <= request.cursor.afterSeq,
    );
    if (hidden)
      throw new WaitSessionError(
        'wait_epoch_unsupported',
        `The legacy cursor cannot represent the uncollected outcome for ${hidden.jobId}. Run coral-cli jobs detail ${hidden.jobId}.`,
      );
  }
  if (request.supportsWaitV3 !== true)
    terminals.sort((a, b) => Number(a.availability?.kind === 'failed') - Number(b.availability?.kind === 'failed'));
  return terminals;
}

function* progressEvents(
  session: WaitSession,
  request: WaitStreamRequest,
  state: DeliveryState,
  terminals: WaitAdmission[],
  internal: boolean,
  selected: WaitProgressLine[],
  legacy: LegacyWaitDelivery,
): Generator<WaitStreamEvent> {
  const versionless = request.supportsWaitV3 !== true && request.supportsWaitV2 !== true;
  const nextTerminal = terminals.find((job) => !session.acknowledged(job.jobId));
  const terminalLimit = nextTerminal ? terminalSeq(nextTerminal) : Infinity;
  const unread = selected.filter((line) => !versionless || !nextTerminal || line.seq <= terminalLimit);
  for (let index = 0; index < unread.length; ) {
    const first = unread[index];
    const group = [first];
    if (internal || request.supportsWaitV3 !== true) {
      while (index + group.length < unread.length) {
        const next = unread[index + group.length];
        if (!sameEpoch(next.epochKey, first.epochKey) || next.seq !== first.seq) break;
        group.push(next);
      }
    }
    const messages = group.map((line) =>
      request.supportsWaitV3 === true && !internal ? shortenWaitLine(line.text) : line.text,
    );
    const bytes = messages.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
    if (
      !internal &&
      request.drainProgress !== true &&
      request.supportsWaitV3 === true &&
      (state.progressLines + group.length > WAIT_PROGRESS_LINES || state.progressBytes + bytes > WAIT_PROGRESS_BYTES)
    )
      break;
    for (const line of group) {
      session.consume(line);
      legacy.consume(line);
    }
    state.progressLines += group.length;
    state.progressBytes += bytes;
    index += group.length;
    if (request.supportsWaitV3 !== true && request.supportsWaitV2 !== true)
      request.onLegacyCursor?.(legacy.cursor(false));
    const progress = {
      type: 'progress' as const,
      jobId: first.jobId,
      seq: first.seq,
      message: messages.join('\n'),
      timing: first.timing,
    };
    if (request.supportsWaitV3 === true)
      yield { ...progress, version: 'jobs.wait.v3', entry: session.entry(first.jobId) };
    else if (request.supportsWaitV2 === true)
      yield { ...progress, version: 'jobs.wait.v2', epochKey: first.epochKey, cursor: legacy.cursor(true) };
    else yield progress;
  }
}

function terminalEvent(
  session: WaitSession,
  request: WaitStreamRequest,
  job: WaitAdmission,
  result: NonNullable<NonNullable<WaitAdmission['detail']>['exit']>,
  legacy: LegacyWaitDelivery,
): WaitStreamEvent {
  const availability = job.availability ?? { kind: 'failed', cause: 'terminal-unusable', retryScheduled: false };
  const { content, outcome, durationMs } = result;
  return finalWaitEvent(session, request, legacy, {
    type: 'terminal',
    jobId: job.jobId,
    seq: terminalSeq(job),
    result: { content, outcome, durationMs },
    usage: result.diagnostics.usage,
    continuity: job.continuity ?? null,
    availability,
    epochKey: job.epochKey,
    remainingJobIds:
      request.supportsWaitV3 === true
        ? session.remaining()
        : session.admissions
            .filter(
              (job) =>
                job.disposition === 'discovery-unknown' ||
                (job.disposition === 'admitted' && !session.acknowledged(job.jobId)),
            )
            .map((job) => job.jobId),
    ...(availability.kind === 'available' ? { resultPath: availability.resultPath } : {}),
  });
}

function* terminalEvents(
  session: WaitSession,
  request: WaitStreamRequest,
  terminals: WaitAdmission[],
  legacy: LegacyWaitDelivery,
): Generator<WaitStreamEvent, boolean> {
  for (const job of terminals) {
    if (!job.detail?.exit) continue;
    const availability = job.availability;
    if (session.acknowledged(job.jobId) && !session.artifactPending(job.jobId)) continue;
    if (request.supportsWaitV3 !== true && availability?.kind === 'repair-pending') {
      if (request.supportsWaitV2 !== true) return false;
      continue;
    }
    if (session.acknowledged(job.jobId) && request.supportsWaitV3 !== true && availability?.kind !== 'repair-pending') {
      session.settleArtifact(job.jobId);
      continue;
    }
    if (request.supportsWaitV3 !== true && availability?.kind !== 'available')
      throw new WaitSessionError(
        'wait_epoch_unsupported',
        `Job ${job.jobId} has a final outcome but its result artifact is ${availability?.kind ?? 'unavailable'}. Run coral-cli jobs detail ${job.jobId}.`,
      );
    if (!session.acknowledged(job.jobId)) {
      if (request.supportsWaitV3 !== true && legacy.held(job)) {
        const warningSeq = terminalSeq(job) - (request.supportsWaitV2 === true ? 0 : 1);
        if (request.supportsWaitV2 !== true && legacy.cursor(false).afterSeq >= warningSeq)
          throw new WaitSessionError(
            'wait_epoch_unsupported',
            `Earlier progress for ${job.jobId} is held. Run coral-cli jobs detail ${job.jobId} to inspect its retained outcome.`,
          );
        yield {
          type: 'progress',
          jobId: job.jobId,
          seq: warningSeq,
          message: `Earlier progress for ${job.jobId} is held and was not shown before this terminal. Run coral-cli jobs detail ${job.jobId} to inspect its retained outcome.`,
          timing: {
            origin: 'runtime',
            originAt: job.detail.status.updatedAt,
            emittedAt: job.detail.status.updatedAt,
            elapsedMs: job.detail.exit.durationMs,
          },
          ...(request.supportsWaitV2 === true
            ? { version: 'jobs.wait.v2', epochKey: job.epochKey, cursor: legacy.cursor(true) }
            : {}),
        };
      }
      session.acknowledge(job);
      if (request.supportsWaitV3 !== true && request.supportsWaitV2 !== true) legacy.terminal(job);
      yield terminalEvent(session, request, job, job.detail.exit, legacy);
      return true;
    }
    if (session.artifactPending(job.jobId) && availability && availability.kind !== 'repair-pending') {
      if (request.supportsWaitV3 !== true)
        throw new WaitSessionError('wait_epoch_unsupported', `Run coral-cli jobs detail ${job.jobId}.`);
      session.settleArtifact(job.jobId);
      yield finalWaitEvent(session, request, legacy, {
        type: 'artifact',
        jobId: job.jobId,
        availability,
        remainingJobIds: session.remaining(),
      });
      return true;
    }
  }
  return false;
}

function* carrierEvents(
  session: WaitSession,
  request: WaitStreamRequest,
  absentReported: Set<string>,
): Generator<WaitStreamEvent> {
  for (const [jobId, coverage] of session.carrierCoverage()) {
    if (coverage.kind !== 'absent' || absentReported.has(jobId)) continue;
    const job = session.admissions.find((job) => job.jobId === jobId);
    if (!job?.detail || job.detail.exit) continue;
    absentReported.add(jobId);
    yield {
      type: 'interrupted',
      ...(request.supportsWaitV3 === true ? { version: 'jobs.wait.v3' as const } : {}),
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
