import type { TimePort } from '../infra/port-types.js';
import type { WaitAdmission } from './wait-session.js';
import { WaitSession, WaitSessionError } from './wait-session.js';
import { WAIT_PROGRESS_BYTES, WAIT_PROGRESS_LINES } from './wait-snapshot.js';
import { waitCursorForJobs, type WaitStreamEvent, type WaitStreamRequest } from './wait.js';

/** Unknown coverage cannot authorize finalization, even when the observer outlives the read. */
export async function* readWaitSession(input: {
  request: WaitStreamRequest;
  time: TimePort;
  activeEpochKey: string;
  read: () => WaitAdmission[];
  observe?: (session: WaitSession, signal: AbortSignal) => void;
}): AsyncGenerator<WaitStreamEvent> {
  const { request, time, activeEpochKey, read } = input;
  const session = new WaitSession(request.jobIds, request.cursor, activeEpochKey);
  const deadline = Number(time.monotonicNow()) + (request.timeoutSeconds ?? 600) * 1000;
  const controller = new AbortController();
  const signal = request.abortSignal ? AbortSignal.any([controller.signal, request.abortSignal]) : controller.signal;
  let progressLines = 0;
  let progressBytes = 0;
  const dispositions = new Map<string, string>();
  const queuedReported = new Set<string>();
  const notices = new Set<string>();
  const absentReported = new Set<string>();
  const progressLost = new Set<string>();
  let observing = false;
  const eventCursor = () =>
    request.supportsWaitV3
      ? session.cursor(session.remaining())
      : request.supportsWaitV2
        ? waitCursorForJobs(session.legacyCursor(true), session.remaining())
        : undefined;
  const waiting = (): WaitStreamEvent => {
    const remaining = session.remaining();
    const unknown = session.unknownCarriers();
    const cursor = request.supportsWaitV3
      ? session.cursor(remaining)
      : request.supportsWaitV2
        ? session.legacyCursor(true)
        : undefined;
    return {
      type: 'waiting',
      waitingJobIds: remaining,
      ...(request.supportsWaitV3 ? { version: 'jobs.wait.v3', exitCode: session.exitCode() } : {}),
      ...(cursor?.version === undefined ? {} : { cursor }),
      ...(unknown.length === 0 ? {} : { carrierUnknownJobIds: unknown }),
    };
  };
  try {
    while (!signal.aborted) {
      session.reconcile(read());
      for (const job of session.admissions) {
        if (job.disposition !== 'admitted' && dispositions.get(job.jobId) !== job.disposition) {
          dispositions.set(job.jobId, job.disposition);
          if (request.supportsWaitV3)
            yield {
              type: 'disposition',
              version: 'jobs.wait.v3',
              jobId: job.jobId,
              disposition: job.disposition,
              message: job.message,
              cursor: session.cursor(session.remaining()),
            };
          else if (job.disposition !== 'missing')
            throw new WaitSessionError(
              job.disposition === 'discovery-unknown' ? 'transient' : 'wait_epoch_unsupported',
              `Job ${job.jobId}: ${job.disposition}. Read coral-cli jobs detail ${job.jobId} --full for its retained outcome.`,
            );
        }
        if (job.progressLost && !progressLost.has(job.jobId)) {
          progressLost.add(job.jobId);
          if (request.supportsWaitV3)
            yield {
              type: 'notice',
              version: 'jobs.wait.v3',
              message: `earlier progress for ${job.jobId} is no longer kept`,
              cursor: session.cursor(session.remaining()),
            };
        }
      }
      for (const message of session.notices)
        if (!notices.has(message)) {
          notices.add(message);
          if (request.supportsWaitV3)
            yield { type: 'notice', version: 'jobs.wait.v3', message, cursor: session.cursor(session.remaining()) };
        }
      for (const job of session.admissions) {
        if (job.disposition === 'admitted' && job.queued && !queuedReported.has(job.jobId)) {
          queuedReported.add(job.jobId);
          yield job.queued;
        }
      }
      const terminals = session.admissions.filter((job) => job.disposition === 'admitted' && job.detail?.exit);
      const terminalSeq = (job: WaitAdmission) =>
        job.detail?.events.find((event) => event.type === 'terminal')?.seq ?? job.detail?.status.lastSeq ?? 0;
      const versionless = !request.supportsWaitV3 && !request.supportsWaitV2;
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
      const nextTerminal = terminals.find((job) => !session.acknowledged(job.jobId));
      const unread = session
        .progress()
        .filter((line) => !versionless || !nextTerminal || line.seq <= terminalSeq(nextTerminal));
      for (let index = 0; index < unread.length; ) {
        const first = unread[index];
        const group = request.supportsWaitV3
          ? [first]
          : unread.slice(index).filter((line) => line.epochKey === first.epochKey && line.seq === first.seq);
        const bytes = group.reduce((sum, line) => sum + Buffer.byteLength(line.text), 0);
        if (!request.supportsWaitV3 && (group.length > WAIT_PROGRESS_LINES || bytes > WAIT_PROGRESS_BYTES))
          throw new WaitSessionError(
            'wait_epoch_unsupported',
            `Progress for ${first.jobId} requires a V3 reader; run coral-cli jobs detail ${first.jobId} --full.`,
          );
        if (progressLines + group.length > WAIT_PROGRESS_LINES || progressBytes + bytes > WAIT_PROGRESS_BYTES) break;
        for (const line of group) session.consume(line);
        progressLines += group.length;
        progressBytes += bytes;
        index += group.length;
        const cursor = eventCursor();
        yield {
          type: 'progress',
          jobId: first.jobId,
          seq: first.seq,
          message: group.map((line) => line.text).join('\n'),
          timing: first.timing,
          ...(request.supportsWaitV3
            ? { version: 'jobs.wait.v3', epochKey: first.epochKey }
            : request.supportsWaitV2
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
      for (const job of terminals) {
        if (!job.detail?.exit) continue;
        const availability = job.availability;
        if (!request.supportsWaitV3 && availability?.kind !== 'available')
          throw new WaitSessionError(
            'wait_epoch_unsupported',
            `Job ${job.jobId} has a final outcome but its result artifact is ${availability?.kind ?? 'unavailable'}. Run coral-cli jobs detail ${job.jobId} --full.`,
          );
        if (!session.acknowledged(job.jobId)) {
          session.acknowledge(job);
          const { content, outcome, durationMs } = job.detail.exit;
          const cursor = eventCursor();
          yield {
            type: 'terminal',
            jobId: job.jobId,
            seq: job.detail.events.find((event) => event.type === 'terminal')?.seq ?? job.detail.status.lastSeq ?? 0,
            result: { content, outcome, durationMs },
            usage: job.detail.exit.diagnostics.usage,
            continuity: job.continuity ?? null,
            remainingJobIds: session.remaining(),
            ...(availability?.kind === 'available' ? { resultPath: availability.resultPath } : {}),
            ...(request.supportsWaitV3
              ? {
                  version: 'jobs.wait.v3',
                  availability,
                  epochKey: job.epochKey,
                  cursor: session.cursor(session.remaining()),
                  exitCode: session.exitCode(),
                }
              : request.supportsWaitV2
                ? {
                    version: 'jobs.wait.v2',
                    epochKey: job.epochKey,
                    cursor: cursor?.version === 'jobs.wait.v2' ? cursor : undefined,
                  }
                : {}),
          };
          return;
        }
        if (session.artifactPending(job.jobId) && availability && availability.kind !== 'repair-pending') {
          if (!request.supportsWaitV3)
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
          return;
        }
      }
      for (const [jobId, coverage] of session.carrierCoverage()) {
        if (coverage.kind !== 'absent' || absentReported.has(jobId)) continue;
        const job = session.admissions.find((job) => job.jobId === jobId);
        if (!job?.detail || job.detail.exit) continue;
        absentReported.add(jobId);
        yield {
          type: 'interrupted',
          ...(request.supportsWaitV3
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
      if (
        session.remaining().length === 0 ||
        session.progress().length > 0 ||
        Number(time.monotonicNow()) >= deadline
      ) {
        yield waiting();
        return;
      }
      if (!observing) {
        observing = true;
        try {
          input.observe?.(session, signal);
        } catch {
          const pending = session.admissions.filter((job) => !job.detail?.exit).map((job) => job.jobId);
          session.observeCoverage(pending, pending, 0);
        }
      }
      await time
        .sleep(Math.min(250, Math.max(0, deadline - Number(time.monotonicNow()))), { signal })
        .catch(() => undefined);
    }
  } finally {
    controller.abort();
  }
}
