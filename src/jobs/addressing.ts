import { setTimeout as delay } from 'node:timers/promises';

import { canonicalWorkDirWireSchema, type CanonicalWorkDir } from '../runtime/canonical-work-dir.js';
import type { AbortDecision } from './contracts/abort-registry.js';
import { refreshHistoricalEpoch } from './historical-reader.js';
import { JobLocationIndex, type JobLocation } from './location-index.js';
import { jobInCallerScope, type JobScopeRelation, type ScopeCheckResult } from './scope.js';
import type { JobDetailResponse, JobProgressEvent } from './records.js';
import { isWaitCursorV2, type WaitCursor, type WaitStreamEvent, type WaitStreamRequest } from './wait.js';

export type WaitCursorError = Readonly<{
  code: 'wait_cursor_epoch_required' | 'wait_cursor_mismatch';
  message: string;
}>;
export type JobDetailLookup = JobDetailResponse | Readonly<{
  kind: 'unresolved';
  jobId: string;
  epochKey: string;
}> | null;

export interface ActiveJobAccess {
  epochKey(): string | null;
  detail(jobId: string): JobDetailResponse | null;
  abort(jobIds: string[]): AbortDecision;
  waitStream(request: WaitStreamRequest): AsyncGenerator<WaitStreamEvent>;
}

const HISTORICAL_POLL_MS = 250;

export class JobAddressing {
  constructor(
    private readonly locations: JobLocationIndex,
    private readonly active: ActiveJobAccess,
  ) {}

  private location(jobId: string): JobLocation | null {
    const existing = this.locations.read(jobId);
    if (existing !== null) return existing;
    const detail = this.active.detail(jobId);
    const epochKey = this.active.epochKey();
    if (detail === null || epochKey === null) return null;
    return this.locations.register(jobId, epochKey, {
      projectRoot: detail.status.projectRoot,
      workDir: detail.status.workDir,
      jobKind: detail.status.jobKind,
    });
  }

  scopeCheck(jobIds: string[], callerRoot: CanonicalWorkDir, relation: JobScopeRelation): ScopeCheckResult {
    const result: ScopeCheckResult = { valid: [], missing: [], mismatch: [] };
    for (const jobId of jobIds) {
      const location = this.location(jobId);
      if (location === null) {
        result.valid.push(jobId);
        result.missing.push(jobId);
      } else if (jobInCallerScope({
        jobKind: location.subject.jobKind,
        workDir: location.subject.workDir === null ? null : canonicalWorkDirWireSchema.parse(location.subject.workDir),
      }, callerRoot, relation)) {
        result.valid.push(jobId);
      } else {
        result.mismatch.push(jobId);
      }
    }
    return result;
  }

  detail(jobId: string): JobDetailLookup {
    const location = this.location(jobId);
    if (location === null) return null;
    const historical = location.epochKey !== this.active.epochKey();
    if (!historical) {
      const active = this.active.detail(jobId);
      if (active !== null) return active;
    } else {
      refreshHistoricalEpoch(this.locations, location.epochKey, [jobId]);
    }
    const latest = this.locations.read(jobId) ?? location;
    if (!historical && latest.disposition === 'unresolved') {
      return { kind: 'unresolved', jobId, epochKey: latest.epochKey };
    }
    return latest.detail ?? { kind: 'unresolved', jobId, epochKey: latest.epochKey };
  }

  abort(jobIds: string[]): AbortDecision {
    const activeEpochKey = this.active.epochKey();
    const activeIds = jobIds.filter((jobId) => this.location(jobId)?.epochKey === activeEpochKey);
    const historicalIds = jobIds.filter((jobId) => !activeIds.includes(jobId) && this.location(jobId) !== null);
    const active = activeIds.length > 0
      ? this.active.abort(activeIds)
      : { kind: 'answered' as const, result: { aborted: [], notFound: [] } };
    if (active.kind !== 'answered') return active;
    return {
      kind: 'answered',
      result: {
        ...active.result,
        notFound: [...active.result.notFound, ...jobIds.filter((jobId) => this.location(jobId) === null)],
        refused: [
          ...(active.result.refused ?? []),
          ...historicalIds.filter((jobId) => this.location(jobId)?.disposition === 'terminal').map((jobId) => ({
            jobId,
            reason: 'already_terminal',
            nextStep: 'The job has already reached a terminal outcome.',
          })),
        ],
        held: [
          ...(active.result.held ?? []),
          ...historicalIds.filter((jobId) => this.location(jobId)?.disposition !== 'terminal').map((jobId) => ({
            jobId,
            reason: 'historical_owner_unresolved',
            nextStep: 'Custody recovery will retry the retained epoch automatically.',
          })),
        ],
      },
    };
  }

  validateWait(request: WaitStreamRequest): WaitCursorError | null {
    const locations = request.jobIds.map((jobId) => this.location(jobId));
    const activeEpochKey = this.active.epochKey();
    const cursor = request.cursor;
    if (cursor === undefined) return null;
    if (!isWaitCursorV2(cursor)) {
      return locations.every((location) => location !== null && location.epochKey === activeEpochKey)
        ? null
        : {
            code: 'wait_cursor_epoch_required',
            message: 'The legacy wait cursor cannot identify historical epochs; retry without a cursor.',
          };
    }
    const requestedLocations = Object.fromEntries(locations.flatMap((location) =>
      location === null ? [] : [[location.jobId, location.epochKey]],
    ));
    const requestedEpochs = [...new Set(Object.values(requestedLocations))].sort();
    const cursorEpochs = Object.keys(cursor.positions).sort();
    if (
      Object.keys(requestedLocations).length !== Object.keys(cursor.locations).length ||
      Object.entries(requestedLocations).some(([jobId, key]) => cursor.locations[jobId] !== key) ||
      JSON.stringify(requestedEpochs) !== JSON.stringify(cursorEpochs)
    ) {
      return { code: 'wait_cursor_mismatch', message: 'The wait cursor belongs to a different job-location set.' };
    }
    return null;
  }

  private cursorFor(request: WaitStreamRequest, locations: readonly JobLocation[]): Extract<WaitCursor, { version: 'jobs.wait.v2' }> {
    const positions = Object.fromEntries([...new Set(locations.map((location) => location.epochKey))].map((key) => [key, 0]));
    if (request.cursor && isWaitCursorV2(request.cursor)) Object.assign(positions, request.cursor.positions);
    if (request.cursor && !isWaitCursorV2(request.cursor)) {
      const activeEpoch = this.active.epochKey();
      if (activeEpoch !== null) positions[activeEpoch] = request.cursor.afterSeq;
    }
    return {
      version: 'jobs.wait.v2',
      positions,
      locations: Object.fromEntries(locations.map((location) => [location.jobId, location.epochKey])),
      deliveredJobIds: request.cursor && isWaitCursorV2(request.cursor)
        ? [...(request.cursor.deliveredJobIds ?? [])] : [],
    };
  }

  private snapshotCursor(cursor: Extract<WaitCursor, { version: 'jobs.wait.v2' }>): Extract<WaitCursor, { version: 'jobs.wait.v2' }> {
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
    if (location.disposition !== 'terminal' || location.terminalSeq === undefined ||
      location.resultPath === undefined || !location.detail?.exit ||
      cursor.deliveredJobIds?.includes(location.jobId)) return null;
    cursor.positions[location.epochKey] = Math.max(cursor.positions[location.epochKey] ?? 0, location.terminalSeq);
    cursor.deliveredJobIds = [...(cursor.deliveredJobIds ?? []), location.jobId];
    const { content, outcome, durationMs } = location.detail.exit;
    return {
      type: 'terminal',
      version: 'jobs.wait.v2',
      jobId: location.jobId,
      seq: location.terminalSeq,
      epochKey: location.epochKey,
      cursor: this.snapshotCursor(cursor),
      remainingJobIds: requested.filter((jobId) => jobId !== location.jobId),
      resultPath: location.resultPath,
      result: { content, outcome, durationMs },
      usage: location.detail.exit.diagnostics.usage,
      continuity: null,
    };
  }

  private progressFromLocation(
    location: JobLocation,
    cursor: Extract<WaitCursor, { version: 'jobs.wait.v2' }>,
  ): JobProgressEvent | null {
    if (location.disposition === 'terminal') return null;
    const progress = location.detail?.events.find((event) =>
      event.type === 'progress' && event.seq > (cursor.positions[location.epochKey] ?? 0),
    );
    return progress?.type === 'progress' ? progress : null;
  }

  async *waitStream(request: WaitStreamRequest): AsyncGenerator<WaitStreamEvent> {
    const error = this.validateWait(request);
    if (error !== null) throw new Error(`${error.code}: ${error.message}`);
    const locations = request.jobIds.map((jobId) => this.location(jobId)).filter((location): location is JobLocation => location !== null);
    const activeEpochKey = this.active.epochKey();
    if (
      locations.length === request.jobIds.length &&
      locations.every((location) => location.epochKey === activeEpochKey) &&
      request.supportsWaitV2 !== true &&
      (request.cursor === undefined || !isWaitCursorV2(request.cursor))
    ) {
      yield* this.active.waitStream(request);
      return;
    }

    const cursor = this.cursorFor(request, locations);
    const activeIds = locations.filter((location) => location.epochKey === activeEpochKey).map((location) => location.jobId);
    const deadline = Date.now() + (request.timeoutSeconds ?? 600) * 1000;
    const activeController = new AbortController();
    const onAbort = () => activeController.abort();
    request.abortSignal?.addEventListener('abort', onAbort, { once: true });
    const activeIterator = activeIds.length === 0 ? null : this.active.waitStream({
      ...request,
      jobIds: activeIds,
      cursor: { afterSeq: cursor.positions[activeEpochKey ?? ''] ?? 0 },
      abortSignal: activeController.signal,
    })[Symbol.asyncIterator]();
    let pendingActive = activeIterator?.next() ?? null;
    const historicalGroups = new Map<string, string[]>();
    for (const location of locations) {
      if (location.epochKey === activeEpochKey) continue;
      const ids = historicalGroups.get(location.epochKey) ?? [];
      ids.push(location.jobId);
      historicalGroups.set(location.epochKey, ids);
    }
    try {
      while (!request.abortSignal?.aborted && Date.now() < deadline) {
        for (const [epochKey, jobIds] of historicalGroups) {
          refreshHistoricalEpoch(this.locations, epochKey, jobIds);
        }
        for (const jobId of request.jobIds) {
          const location = locations.find((candidate) => candidate.jobId === jobId);
          if (location === undefined) continue;
          const latest = this.locations.read(jobId);
          if (latest === null) continue;
          const terminal = this.terminalFromLocation(latest, request.jobIds, cursor);
          if (terminal !== null) {
            yield terminal;
            return;
          }
        }

        const pendingProgress = new Map<string, JobProgressEvent>();
        for (const jobId of request.jobIds) {
          const location = locations.find((candidate) => candidate.jobId === jobId);
          if (location === undefined || location.epochKey === activeEpochKey) continue;
          const latest = this.locations.read(jobId);
          if (latest === null) continue;
          const progress = this.progressFromLocation(latest, cursor);
          if (progress === null) continue;
          const previous = pendingProgress.get(location.epochKey);
          if (previous === undefined || progress.seq < previous.seq) pendingProgress.set(location.epochKey, progress);
        }
        for (const [epochKey, progress] of pendingProgress) {
          cursor.positions[epochKey] = progress.seq;
          yield {
            type: 'progress', version: 'jobs.wait.v2',
            jobId: progress.jobId, seq: progress.seq, epochKey,
            message: progress.message, timing: progress.timing,
            cursor: this.snapshotCursor(cursor),
          };
        }

        if (pendingActive === null) {
          await delay(Math.min(HISTORICAL_POLL_MS, Math.max(0, deadline - Date.now())), undefined, {
            signal: request.abortSignal,
          }).catch(() => undefined);
          continue;
        }
        const next = await Promise.race([
          pendingActive,
          delay(Math.min(HISTORICAL_POLL_MS, Math.max(0, deadline - Date.now())), null, {
            signal: request.abortSignal,
          }),
        ]);
        if (next === null) continue;
        if (next.done) {
          pendingActive = null;
          continue;
        }
        pendingActive = activeIterator?.next() ?? null;
        const event = next.value;
        if (event.type === 'waiting') continue;
        if (event.type === 'progress' || event.type === 'terminal') {
          if (activeEpochKey === null || event.seq <= (cursor.positions[activeEpochKey] ?? 0) ||
            (event.type === 'terminal' && cursor.deliveredJobIds?.includes(event.jobId))) continue;
          cursor.positions[activeEpochKey] = event.seq;
          if (event.type === 'terminal') cursor.deliveredJobIds = [...(cursor.deliveredJobIds ?? []), event.jobId];
          yield {
            ...event,
            version: 'jobs.wait.v2',
            epochKey: activeEpochKey,
            cursor: this.snapshotCursor(cursor),
            ...(event.type === 'terminal'
              ? { remainingJobIds: request.jobIds.filter((jobId) => jobId !== event.jobId) }
              : {}),
          };
          if (event.type === 'terminal') return;
        } else {
          yield { ...event, cursor: this.snapshotCursor(cursor) };
        }
      }
      yield {
        type: 'waiting',
        waitingJobIds: [...request.jobIds],
        cursor: this.snapshotCursor(cursor),
      };
    } finally {
      request.abortSignal?.removeEventListener('abort', onAbort);
      activeController.abort();
      await activeIterator?.return?.();
    }
  }
}
