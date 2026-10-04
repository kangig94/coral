import { decodeWaitCursor } from './wait-cursor.js';
import { raceObserved } from '../infra/promise-signal.js';
import { canonicalWorkDirWireSchema, type CanonicalWorkDir } from '../runtime/canonical-work-dir.js';
import type { AbortDecision } from './contracts/abort-registry.js';
import type { JobDetailLookup, WaitCursorError } from './contracts/addressing.js';
import { readHistoricalSource, type HistoricalSourceReader } from './historical-reader.js';
import { hasReadableTerminalDetail, type JobLocationView, type JobLocation } from './location-index.js';
import { jobInCallerScope, type JobScopeRelation, type ScopeCheckResult } from './scope.js';
import type { JobDetailResponse, JobProgressEvent } from './records.js';
import { type ResultAvailability } from './terminal/export.js';
import { type WaitCursor, type WaitStreamEvent, type WaitStreamRequest } from './wait.js';

export interface ActiveJobAccess {
  epochKey(): string | null;
  detail(jobId: string): JobDetailResponse | null;
  abort(jobIds: string[]): AbortDecision;
  waitStream(request: WaitStreamRequest): AsyncGenerator<WaitStreamEvent>;
}

const HISTORICAL_POLL_MS = 250;

/**
 * A store predating epoch layout may only be observed for existence; its jobs must never be indexed, opened, or
 * read.
 */
export type PreEpochHistoryProbe = () => boolean;

/**
 * A missing historical source cannot decide closure; a conclusive read must establish the job outcome before
 * finalization.
 */
export type HistoricalClosureProbe = (epochKey: string) => 'pending' | 'decided';

export class JobAddressing {
  private readonly locations: JobLocationView;
  private readonly readHistorical: HistoricalSourceReader;
  private readonly observeResultAvailability?: (jobId: string) => ResultAvailability;
  private readonly hintRepair?: (jobId: string) => void;
  private readonly active: ActiveJobAccess;
  private readonly preEpochHistoryExists: PreEpochHistoryProbe;
  private readonly historicalClosure: HistoricalClosureProbe;

  constructor(
    locations: JobLocationView,
    active: ActiveJobAccess,
    preEpochHistoryExists: PreEpochHistoryProbe,
    historicalClosure: HistoricalClosureProbe,
    readHistorical: HistoricalSourceReader = (epochKey, jobIds) => readHistoricalSource(locations, epochKey, jobIds),
    observeResultAvailability?: (jobId: string) => ResultAvailability,
    hintRepair?: (jobId: string) => void,
  ) {
    this.locations = locations;
    this.active = active;
    this.preEpochHistoryExists = preEpochHistoryExists;
    this.historicalClosure = historicalClosure;
    this.readHistorical = readHistorical;
    this.observeResultAvailability = observeResultAvailability;
    this.hintRepair = hintRepair;
  }

  unknownJobDisposition(): 'pre-epoch-history' | 'not-found' | 'discovery-unknown' {
    if (this.locations.unknownLocationHolds().some((hold) => hold.retryScheduled)) return 'discovery-unknown';
    return this.preEpochHistoryExists() ? 'pre-epoch-history' : 'not-found';
  }

  unknownJobCaveat(): string {
    return this.locations
      .unknownLocationHolds()
      .map((hold) => `Unreadable epoch ${hold.epochKey}: ${hold.reason}.`)
      .join(' ');
  }

  private historicalLocation(location: JobLocation): { location: JobLocation; outcomeUnrecoverable: boolean } {
    const retained = this.locations.read(location.jobId) ?? location;
    if (hasReadableTerminalDetail(retained)) return { location: retained, outcomeUnrecoverable: false };
    const closure = this.historicalClosure(retained.epochKey);
    const read = this.readHistorical(retained.epochKey, [retained.jobId]);
    if (read.kind === 'unreadable')
      return {
        location: { ...retained, disposition: 'unresolved', detail: { kind: 'absent' } },
        outcomeUnrecoverable: false,
      };
    const observed = read.locations.get(retained.jobId);
    if (observed && hasReadableTerminalDetail(observed)) return { location: observed, outcomeUnrecoverable: false };
    return {
      location: observed ?? { ...retained, disposition: 'unresolved', detail: { kind: 'absent' } },
      outcomeUnrecoverable: closure === 'decided',
    };
  }

  private outcomeUnrecoverableLocation(location: JobLocation): boolean {
    return (
      location.epochKey !== (this.active.epochKey() ?? ':memory:') &&
      this.historicalLocation(location).outcomeUnrecoverable
    );
  }

  outcomeUnrecoverable(jobIds: readonly string[]): string[] {
    return jobIds.filter((jobId) => {
      const location = this.location(jobId);
      return location !== null && this.outcomeUnrecoverableLocation(location);
    });
  }

  private location(jobId: string): JobLocation | null {
    const existing = this.locations.read(jobId);
    if (existing !== null) return existing;
    const detail = this.active.detail(jobId);
    const epochKey = this.active.epochKey() ?? ':memory:';
    if (detail === null) return null;
    return {
      version: 'v1',
      jobId,
      epochKey,
      subject: {
        projectRoot: detail.status.projectRoot,
        workDir: detail.status.workDir,
        jobKind: detail.status.jobKind,
      },
      disposition: 'active-owner',
      detail: { kind: 'recorded', value: detail },
    };
  }

  scopeCheck(jobIds: string[], callerRoot: CanonicalWorkDir, relation: JobScopeRelation): ScopeCheckResult {
    const result: ScopeCheckResult = { valid: [], missing: [], mismatch: [] };
    for (const jobId of jobIds) {
      const location = this.location(jobId);
      if (location === null) {
        result.valid.push(jobId);
        result.missing.push(jobId);
      } else if (
        jobInCallerScope(
          {
            jobKind: location.subject.jobKind,
            workDir:
              location.subject.workDir === null ? null : canonicalWorkDirWireSchema.parse(location.subject.workDir),
          },
          callerRoot,
          relation,
        )
      ) {
        result.valid.push(jobId);
      } else {
        result.mismatch.push(jobId);
      }
    }
    return result;
  }

  detail(jobId: string): JobDetailLookup {
    const location = this.location(jobId);
    if (location === null) return this.preEpochHistoryExists() ? { kind: 'pre-epoch-history', jobId } : null;
    const historical = location.epochKey !== (this.active.epochKey() ?? ':memory:');
    if (!historical) {
      const active = this.active.detail(jobId);
      if (active !== null) return { ...active, epochKey: location.epochKey };
    }
    const observed = historical ? this.historicalLocation(location) : { location, outcomeUnrecoverable: false };
    if (observed.outcomeUnrecoverable) return { kind: 'outcome-unrecoverable', jobId, epochKey: location.epochKey };
    const latest = observed.location;
    if (!historical && latest.disposition === 'unresolved') {
      return { kind: 'unresolved', jobId, epochKey: latest.epochKey };
    }
    if (latest.detail.kind === 'recorded') return { ...latest.detail.value, epochKey: latest.epochKey };
    return latest.detail.kind === 'unreadable'
      ? { kind: 'detail-unreadable', jobId, epochKey: latest.epochKey }
      : { kind: 'unresolved', jobId, epochKey: latest.epochKey };
  }

  abort(jobIds: string[]): AbortDecision {
    const activeEpochKey = this.active.epochKey() ?? ':memory:';
    const activeIds = jobIds.filter((jobId) => this.location(jobId)?.epochKey === activeEpochKey);
    const historicalIds = jobIds.filter((jobId) => !activeIds.includes(jobId) && this.location(jobId) !== null);
    const unknownIds = jobIds.filter((jobId) => this.location(jobId) === null);
    const preEpochHistory = unknownIds.length > 0 && this.unknownJobDisposition() === 'pre-epoch-history';
    const active =
      activeIds.length > 0
        ? this.active.abort(activeIds)
        : { kind: 'answered' as const, result: { aborted: [], notFound: [] } };
    if (active.kind !== 'answered') return active;
    const unrecoverableAfterRefresh = this.outcomeUnrecoverable(historicalIds);
    const historicalTerminal = historicalIds.filter((jobId) => this.location(jobId)?.disposition === 'terminal');
    const unrecoverable = unrecoverableAfterRefresh.filter((jobId) => !historicalTerminal.includes(jobId));
    const refused = [
      ...(active.result.refused ?? []),
      ...(preEpochHistory
        ? unknownIds.map((jobId) => ({
            jobId,
            reason: 'job_pre_epoch_history',
            nextStep:
              'A job that ran before store epochs has no details this build can read; another id may never have been a job. Do not retry.',
          }))
        : []),
      ...unrecoverable.map((jobId) => ({
        jobId,
        reason: 'historical_outcome_unrecoverable',
        nextStep:
          'No Coral coordinator controls this job any more and none will record its outcome, so Coral has nothing to stop. Do not retry.',
      })),
    ];
    const held = [
      ...(active.result.held ?? []),
      ...historicalIds
        .filter((jobId) => !historicalTerminal.includes(jobId) && !unrecoverable.includes(jobId))
        .map((jobId) => ({
          jobId,
          reason: 'historical_owner_unresolved',
          nextStep:
            "Its retained store epoch's closure is decided automatically; once it is, an abort answers finally.",
        })),
    ];
    return {
      kind: 'answered',
      result: {
        ...active.result,

        notFound: [...active.result.notFound, ...(!preEpochHistory ? unknownIds : []), ...historicalTerminal],
        ...(refused.length === 0 ? {} : { refused }),
        ...(held.length === 0 ? {} : { held }),
      },
    };
  }

  validateWait(request: WaitStreamRequest): WaitCursorError | null {
    if (request.cursor !== undefined) {
      const decoded = decodeWaitCursor(request.cursor);
      if (decoded.kind === 'rejected') return decoded.error;
    }
    const locations = request.jobIds.map((jobId) => this.location(jobId));
    const activeEpochKey = this.active.epochKey() ?? ':memory:';
    const cursor = request.cursor;
    if (cursor !== undefined && cursor.version === undefined) {
      return locations.every((location) => location !== null && location.epochKey === activeEpochKey)
        ? null
        : {
            code: 'wait_cursor_epoch_required',
            message: 'The legacy wait cursor cannot identify historical epochs; retry without a cursor.',
          };
    }
    if (
      request.supportsWaitV2 !== true &&
      cursor === undefined &&
      locations.some(
        (location) =>
          location !== null &&
          location.epochKey !== activeEpochKey &&
          (location.disposition !== 'terminal' ||
            location.terminalSeq === undefined ||
            location.resultPath === undefined ||
            location.detail.kind !== 'recorded' ||
            location.detail.value.exit === null),
      )
    ) {
      return {
        code: 'wait_epoch_unsupported',
        message:
          'This Coral CLI cannot wait on a job kept in a superseded store epoch. Read its outcome with jobs detail instead.',
      };
    }
    if (cursor === undefined) return null;
    const requestedLocations = Object.fromEntries(
      locations.flatMap((location) => (location === null ? [] : [[location.jobId, location.epochKey]])),
    );
    const requestedEpochs = [...new Set(Object.values(requestedLocations))].sort();
    const cursorEpochs = Object.keys(cursor.positions).sort();
    if (
      Object.keys(requestedLocations).length !== Object.keys(cursor.locations).length ||
      Object.entries(requestedLocations).some(([jobId, key]) => cursor.locations[jobId] !== key) ||
      JSON.stringify(requestedEpochs) !== JSON.stringify(cursorEpochs)
    ) {
      return {
        code: 'wait_cursor_mismatch',
        message: 'The wait cursor belongs to a different job-location set; start a fresh wait without the cursor.',
      };
    }
    return null;
  }

  private cursorFor(
    request: WaitStreamRequest,
    locations: readonly JobLocation[],
  ): Extract<WaitCursor, { version: 'jobs.wait.v2' }> {
    const positions = Object.fromEntries(
      [...new Set(locations.map((location) => location.epochKey))].map((key) => [key, 0]),
    );
    if (request.cursor && request.cursor.version === 'jobs.wait.v2') Object.assign(positions, request.cursor.positions);
    if (request.cursor && request.cursor.version === undefined) {
      const activeEpoch = this.active.epochKey() ?? ':memory:';
      if (activeEpoch !== null) positions[activeEpoch] = request.cursor.afterSeq;
    }
    return {
      version: 'jobs.wait.v2',
      positions,
      locations: Object.fromEntries(locations.map((location) => [location.jobId, location.epochKey])),
      deliveredJobIds: [...(request.cursor?.deliveredJobIds ?? [])],
    };
  }

  private snapshotCursor(
    cursor: Extract<WaitCursor, { version: 'jobs.wait.v2' }>,
  ): Extract<WaitCursor, { version: 'jobs.wait.v2' }> {
    return {
      ...cursor,
      positions: { ...cursor.positions },
      locations: { ...cursor.locations },
      deliveredJobIds: [...(cursor.deliveredJobIds ?? [])],
    };
  }

  private terminalFromLocation(
    location: JobLocation,
    requested: readonly string[],
    cursor: Extract<WaitCursor, { version: 'jobs.wait.v2' }>,
  ): Extract<WaitStreamEvent, { type: 'terminal' }> | null {
    if (
      !hasReadableTerminalDetail(location) ||
      location.terminalSeq === undefined ||
      location.resultPath === undefined ||
      location.detail.kind !== 'recorded' ||
      location.detail.value.exit === null ||
      cursor.deliveredJobIds?.includes(location.jobId)
    )
      return null;
    const availability = this.observeResultAvailability?.(location.jobId);
    if (availability?.kind === 'repair-pending') this.hintRepair?.(location.jobId);
    const exit = location.detail.value.exit;
    cursor.positions[location.epochKey] = Math.max(cursor.positions[location.epochKey] ?? 0, location.terminalSeq);
    cursor.deliveredJobIds = [...(cursor.deliveredJobIds ?? []), location.jobId];
    const { content, outcome, durationMs } = exit;
    return {
      type: 'terminal',
      version: 'jobs.wait.v2',
      jobId: location.jobId,
      seq: location.terminalSeq,
      epochKey: location.epochKey,
      cursor: this.snapshotCursor(cursor),
      remainingJobIds: requested.filter((jobId) => !cursor.deliveredJobIds?.includes(jobId)),
      resultPath: location.resultPath,
      result: { content, outcome, durationMs },
      usage: exit.diagnostics.usage,
      continuity: null,
    };
  }

  private progressFromLocation(
    location: JobLocation,
    cursor: Extract<WaitCursor, { version: 'jobs.wait.v2' }>,
  ): JobProgressEvent | null {
    if (location.disposition === 'terminal' || location.detail.kind !== 'recorded') return null;
    const progress = location.detail.value.events.find(
      (event) => event.type === 'progress' && event.seq > (cursor.positions[location.epochKey] ?? 0),
    );
    return progress?.type === 'progress' ? progress : null;
  }

  private firstHistoricalTerminal(
    request: WaitStreamRequest,
    locations: readonly JobLocation[],
    activeEpochKey: string | null,
    cursor: Extract<WaitCursor, { version: 'jobs.wait.v2' }>,
  ): WaitStreamEvent | null {
    for (const jobId of request.jobIds) {
      const location = locations.find((candidate) => candidate.jobId === jobId);
      if (location === undefined || location.epochKey === activeEpochKey) continue;
      const latest = location;
      const terminal = this.terminalFromLocation(latest, request.jobIds, cursor);
      if (terminal !== null) {
        if (request.supportsWaitV2 === true) return terminal;
        else {
          const { version, epochKey, cursor: eventCursor, ...legacy } = terminal;
          return legacy;
        }
      }
    }

    return null;
  }

  private *historicalProgressEvents(
    request: WaitStreamRequest,
    locations: readonly JobLocation[],
    activeEpochKey: string | null,
    cursor: Extract<WaitCursor, { version: 'jobs.wait.v2' }>,
  ): Generator<WaitStreamEvent> {
    const pendingProgress = new Map<string, JobProgressEvent>();
    for (const jobId of request.jobIds) {
      const location = locations.find((candidate) => candidate.jobId === jobId);
      if (location === undefined || location.epochKey === activeEpochKey) continue;
      const latest = location;
      const progress = this.progressFromLocation(latest, cursor);
      if (progress === null) continue;
      const previous = pendingProgress.get(location.epochKey);
      if (previous === undefined || progress.seq < previous.seq) pendingProgress.set(location.epochKey, progress);
    }
    for (const [epochKey, progress] of pendingProgress) {
      cursor.positions[epochKey] = progress.seq;
      yield {
        type: 'progress',
        version: 'jobs.wait.v2',
        jobId: progress.jobId,
        seq: progress.seq,
        epochKey,
        message: progress.message,
        timing: progress.timing,
        cursor: this.snapshotCursor(cursor),
      };
    }
  }

  async *waitStream(request: WaitStreamRequest): AsyncGenerator<WaitStreamEvent> {
    const error = this.validateWait(request);
    if (error !== null) throw new Error(`${error.code}: ${error.message}`);
    const locations = request.jobIds
      .map((jobId) => this.location(jobId))
      .filter((location): location is JobLocation => location !== null);
    const knownIds = new Set(locations.map((location) => location.jobId));
    const discoveryUnknown = this.unknownJobDisposition() === 'discovery-unknown';
    const admittedIds = request.jobIds.filter((jobId) => knownIds.has(jobId) || discoveryUnknown);
    request = { ...request, jobIds: admittedIds };
    const activeEpochKey = this.active.epochKey() ?? ':memory:';

    if (
      locations.length === admittedIds.length &&
      locations.every((location) => location.epochKey === activeEpochKey) &&
      request.supportsWaitV2 !== true &&
      (request.cursor === undefined || request.cursor.version === undefined)
    ) {
      yield* this.active.waitStream(request);
      return;
    }

    const cursor = this.cursorFor(request, locations);
    const activeIds = locations
      .filter((location) => location.epochKey === activeEpochKey)
      .map((location) => location.jobId);
    const time = this.locations.time;
    const deadline = Number(time.monotonicNow()) + (request.timeoutSeconds ?? 600) * 1000;
    const activeController = new AbortController();
    const onAbort = () => activeController.abort();
    request.abortSignal?.addEventListener('abort', onAbort, { once: true });
    const activeIterator =
      activeIds.length === 0
        ? null
        : this.active
            .waitStream({
              ...request,
              jobIds: activeIds,
              cursor: { afterSeq: cursor.positions[activeEpochKey ?? ''] ?? 0 },
              abortSignal: activeController.signal,
            })
            [Symbol.asyncIterator]();
    let pendingActive = activeIterator?.next() ?? null;
    let carrierUnknownJobIds: readonly string[] = [];
    try {
      while (!request.abortSignal?.aborted && Number(time.monotonicNow()) < deadline) {
        const observedLocations = locations.map((location) =>
          location.epochKey === activeEpochKey ? location : this.historicalLocation(location).location,
        );
        const historicalTerminal = this.firstHistoricalTerminal(request, observedLocations, activeEpochKey, cursor);
        if (historicalTerminal !== null) {
          yield historicalTerminal;
          return;
        }
        yield* this.historicalProgressEvents(request, observedLocations, activeEpochKey, cursor);

        if (pendingActive === null) {
          await time
            .sleep(Math.min(HISTORICAL_POLL_MS, Math.max(0, deadline - Number(time.monotonicNow()))), {
              signal: request.abortSignal,
            })
            .catch(() => undefined);
          continue;
        }
        const next = await raceObserved([
          pendingActive,
          time
            .sleep(Math.min(HISTORICAL_POLL_MS, Math.max(0, deadline - Number(time.monotonicNow()))), {
              signal: request.abortSignal,
            })
            .then(() => null),
        ]);
        if (next === null) continue;
        if (next.done) {
          pendingActive = null;
          continue;
        }
        pendingActive = activeIterator?.next() ?? null;
        const event = next.value;
        if (event.type === 'waiting') {
          carrierUnknownJobIds = event.carrierUnknownJobIds ?? [];
          continue;
        }
        if (event.type === 'progress' || event.type === 'terminal') {
          if (
            activeEpochKey === null ||
            event.seq <= (cursor.positions[activeEpochKey] ?? 0) ||
            (event.type === 'terminal' && cursor.deliveredJobIds?.includes(event.jobId))
          )
            continue;
          cursor.positions[activeEpochKey] = event.seq;
          if (event.type === 'terminal') cursor.deliveredJobIds = [...(cursor.deliveredJobIds ?? []), event.jobId];
          yield {
            ...event,
            version: 'jobs.wait.v2',
            epochKey: activeEpochKey,
            cursor: this.snapshotCursor(cursor),
            ...(event.type === 'terminal'
              ? { remainingJobIds: request.jobIds.filter((jobId) => !cursor.deliveredJobIds?.includes(jobId)) }
              : {}),
          };
          if (event.type === 'terminal') return;
        } else {
          yield request.supportsWaitV2 === true ? { ...event, cursor: this.snapshotCursor(cursor) } : event;
        }
      }
      yield {
        type: 'waiting',
        waitingJobIds:
          request.supportsWaitV2 === true
            ? request.jobIds.filter((jobId) => !cursor.deliveredJobIds?.includes(jobId))
            : [...request.jobIds],
        ...(request.supportsWaitV2 === true ? { cursor: this.snapshotCursor(cursor) } : {}),
        ...(carrierUnknownJobIds.length === 0 ? {} : { carrierUnknownJobIds: [...carrierUnknownJobIds] }),
      };
    } finally {
      request.abortSignal?.removeEventListener('abort', onAbort);
      activeController.abort();
      await activeIterator?.return?.(undefined);
    }
  }
}
