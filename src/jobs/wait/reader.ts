import { raceWithSignal } from '../../infra/promise-signal.js';
import type { TimePort } from '../../infra/port-types.js';
import type { WaitAdmission } from './session.js';
import { WaitSession, WaitSessionError } from './session.js';
import { WAIT_PROGRESS_BYTES, WAIT_PROGRESS_LINES } from './snapshot.js';
import { type WaitStreamEvent, type WaitStreamRequest } from './contract.js';
import { waitCursorForJobs } from './cursor.js';

type WaitReadInput = {
  request: WaitStreamRequest;
  time: TimePort;
  activeEpochKey: string;
  read: () => WaitAdmission[];
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

function eventCursor(session: WaitSession, request: WaitStreamRequest) {
  return request.supportsWaitV3 === true
    ? session.cursor(session.remaining())
    : request.supportsWaitV2 === true
      ? waitCursorForJobs(session.legacyCursor(true), session.remaining())
      : undefined;
}

function waitingEvent(session: WaitSession, request: WaitStreamRequest): WaitStreamEvent {
  const remaining = session.remaining();
  const unknown = session.unknownCarriers();
  const cursor =
    request.supportsWaitV3 === true
      ? session.cursor(remaining)
      : request.supportsWaitV2 === true
        ? session.legacyCursor(true)
        : undefined;
  return {
    type: 'waiting',
    waitingJobIds: remaining,
    ...(request.supportsWaitV3 === true ? { version: 'jobs.wait.v3', exitCode: session.exitCode() } : {}),
    ...(cursor?.version === undefined ? {} : { cursor }),
    ...(unknown.length === 0 ? {} : { carrierUnknownJobIds: unknown }),
  };
}

/** Unknown coverage cannot authorize finalization, even when the observer outlives the read. */
export async function* readWaitSession(input: WaitReadInput): AsyncGenerator<WaitStreamEvent> {
  const { request, time, activeEpochKey, read } = input;
  const session = new WaitSession(request.jobIds, request.cursor, activeEpochKey);
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
  try {
    while (!signal.aborted) {
      session.reconcile(read());
      if (request.supportsWaitV3 !== true) validateLegacyAdmission(session);
      if (!observing && Number(time.monotonicNow()) < deadline) {
        observing = true;
        void observeCarriers(input, session, signal).finally(() => {
          observing = false;
        });
      }
      yield* admissionEvents(session, request, state);
      const terminals = pendingTerminals(session, request);
      yield* progressEvents(session, request, state, terminals);
      if (yield* terminalEvents(session, request, terminals)) return;
      yield* carrierEvents(session, request, state.absentReported);
      if (
        session.remaining().length === 0 ||
        session.progress().length > 0 ||
        Number(time.monotonicNow()) >= deadline
      ) {
        yield waitingEvent(session, request);
        return;
      }
      await time
        .sleep(Math.min(250, Math.max(0, deadline - Number(time.monotonicNow()))), { signal })
        .catch(() => undefined);
    }
  } finally {
    controller.abort();
  }
}

async function observeCarriers(input: WaitReadInput, session: WaitSession, signal: AbortSignal): Promise<void> {
  const pending = session.admissions
    .filter((job) => job.disposition === 'admitted' && !job.detail?.exit)
    .map((job) => job.jobId);
  session.observeCoverage(pending, pending, 0);
  try {
    await raceWithSignal(Promise.resolve(input.observe?.(session, signal)), signal, () => undefined);
  } catch {
    if (!signal.aborted) session.observeCoverage(pending, pending, 0);
  }
}

function validateLegacyAdmission(session: WaitSession): void {
  session.requireLegacyReplaySupport();
  const missing = session.admissions.filter((job) => job.disposition === 'missing').map((job) => job.jobId);
  if (missing.length > 0)
    throw new WaitSessionError(
      'jobs_not_found',
      `Jobs not found: ${missing.join(', ')}. Remove those IDs to collect the remaining jobs.`,
    );
  const refused = session.admissions.find((job) => job.disposition !== 'admitted');
  if (refused)
    throw new WaitSessionError(
      refused.disposition === 'discovery-unknown' ? 'transient' : 'wait_epoch_unsupported',
      `Job ${refused.jobId}: ${refused.disposition}. Read coral-cli jobs detail ${refused.jobId} --full for its retained outcome.`,
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
      yield { type: 'notice', version: 'jobs.wait.v3', message, cursor: session.cursor(session.remaining()) };
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
        cursor: session.cursor(session.remaining()),
      };
  }
  if (job.progressLost && !state.progressLost.has(job.jobId)) {
    state.progressLost.add(job.jobId);
    if (request.supportsWaitV3 === true)
      yield {
        type: 'notice',
        version: 'jobs.wait.v3',
        message: `earlier progress for ${job.jobId} is no longer kept`,
        cursor: session.cursor(session.remaining()),
      };
  }
}

function terminalSeq(job: WaitAdmission): number {
  return job.detail?.events.find((event) => event.type === 'terminal')?.seq ?? job.detail?.status.lastSeq ?? 0;
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
        `The legacy cursor cannot represent the uncollected outcome for ${hidden.jobId}. Run coral-cli jobs detail ${hidden.jobId} --full.`,
      );
  }
  return terminals;
}

function* progressEvents(
  session: WaitSession,
  request: WaitStreamRequest,
  state: DeliveryState,
  terminals: WaitAdmission[],
): Generator<WaitStreamEvent> {
  const versionless = request.supportsWaitV3 !== true && request.supportsWaitV2 !== true;
  const nextTerminal = terminals.find((job) => !session.acknowledged(job.jobId));
  const unread = session
    .progress()
    .filter((line) => !versionless || !nextTerminal || line.seq <= terminalSeq(nextTerminal));
  for (let index = 0; index < unread.length; ) {
    const first = unread[index];
    const group =
      request.supportsWaitV3 === true
        ? [first]
        : unread.slice(index).filter((line) => line.epochKey === first.epochKey && line.seq === first.seq);
    const bytes = group.reduce((sum, line) => sum + Buffer.byteLength(line.text), 0);
    if (request.supportsWaitV3 !== true && (group.length > WAIT_PROGRESS_LINES || bytes > WAIT_PROGRESS_BYTES))
      throw new WaitSessionError(
        'wait_epoch_unsupported',
        `Progress for ${first.jobId} requires a V3 reader; run coral-cli jobs detail ${first.jobId} --full.`,
      );
    if (state.progressLines + group.length > WAIT_PROGRESS_LINES || state.progressBytes + bytes > WAIT_PROGRESS_BYTES)
      break;
    for (const line of group) session.consume(line);
    state.progressLines += group.length;
    state.progressBytes += bytes;
    index += group.length;
    const cursor = eventCursor(session, request);
    yield {
      type: 'progress',
      jobId: first.jobId,
      seq: first.seq,
      message: group.map((line) => line.text).join('\n'),
      timing: first.timing,
      ...(request.supportsWaitV3 === true
        ? { version: 'jobs.wait.v3', epochKey: first.epochKey }
        : request.supportsWaitV2 === true
          ? { version: 'jobs.wait.v2', epochKey: first.epochKey }
          : {}),
      ...(cursor?.version === undefined ? {} : { cursor }),
    };
  }
  if (versionless && nextTerminal && session.progress().some((line) => line.seq <= terminalSeq(nextTerminal)))
    throw new WaitSessionError(
      'wait_epoch_unsupported',
      `This progress backlog requires a V3 reader; run coral-cli jobs detail ${nextTerminal.jobId} --full.`,
    );
}

function terminalEvent(
  session: WaitSession,
  request: WaitStreamRequest,
  job: WaitAdmission,
  result: NonNullable<NonNullable<WaitAdmission['detail']>['exit']>,
): WaitStreamEvent {
  const availability = job.availability;
  const { content, outcome, durationMs } = result;
  const cursor = eventCursor(session, request);
  return {
    type: 'terminal',
    jobId: job.jobId,
    seq: terminalSeq(job),
    result: { content, outcome, durationMs },
    usage: result.diagnostics.usage,
    continuity: job.continuity ?? null,
    remainingJobIds: session.remaining(),
    ...(availability?.kind === 'available' ? { resultPath: availability.resultPath } : {}),
    ...(request.supportsWaitV3 === true
      ? {
          version: 'jobs.wait.v3',
          availability,
          epochKey: job.epochKey,
          cursor: session.cursor(session.remaining()),
          exitCode: session.exitCode(),
        }
      : request.supportsWaitV2 === true
        ? {
            version: 'jobs.wait.v2',
            epochKey: job.epochKey,
            cursor: cursor?.version === 'jobs.wait.v2' ? cursor : undefined,
          }
        : {}),
  };
}

function* terminalEvents(
  session: WaitSession,
  request: WaitStreamRequest,
  terminals: WaitAdmission[],
): Generator<WaitStreamEvent, boolean> {
  for (const job of terminals) {
    if (!job.detail?.exit) continue;
    const availability = job.availability;
    if (request.supportsWaitV3 !== true && availability?.kind !== 'available')
      throw new WaitSessionError(
        'wait_epoch_unsupported',
        `Job ${job.jobId} has a final outcome but its result artifact is ${availability?.kind ?? 'unavailable'}. Run coral-cli jobs detail ${job.jobId} --full.`,
      );
    if (!session.acknowledged(job.jobId)) {
      session.acknowledge(job);
      yield terminalEvent(session, request, job, job.detail.exit);
      return true;
    }
    if (session.artifactPending(job.jobId) && availability && availability.kind !== 'repair-pending') {
      if (request.supportsWaitV3 !== true)
        throw new WaitSessionError('wait_epoch_unsupported', `Run coral-cli jobs detail ${job.jobId} --full.`);
      session.settleArtifact(job.jobId);
      yield {
        type: 'artifact',
        version: 'jobs.wait.v3',
        jobId: job.jobId,
        availability,
        remainingJobIds: session.remaining(),
        cursor: session.cursor(session.remaining()),
        exitCode: session.exitCode(),
      };
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
      ...(request.supportsWaitV3 === true
        ? { version: 'jobs.wait.v3' as const, cursor: session.cursor(session.remaining()) }
        : {}),
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
