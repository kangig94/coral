import type { ProgressVisit } from './wait/contract.js';
import { epochIdentity, epochToken, sameEpoch } from '../store/epoch/identity.js';
import { isCodeDefect, sourceReadFailureDisposition, type SourceReadDisposition } from './source-read.js';
import { activeJournalReadFailure, WaitSession, type WaitAdmission, type WaitSnapshot } from './wait/session.js';
import { selectWaitSnapshot } from './wait/snapshot.js';
import { readWaitSession } from './wait/reader.js';
import { canonicalWorkDirWireSchema, type CanonicalWorkDir } from '../runtime/canonical-work-dir.js';
import type { AbortDecision } from './contracts/abort-registry.js';
import type { JobDetailLookup } from './contracts/addressing.js';
import { type HistoricalSourceRead, type HistoricalSourceReader } from './historical-reader.js';
import { LocationObservationDeferred, type JobLocationView, type JobLocation } from './location-index.js';
import { hasReadableTerminalDetail } from './terminal/identity.js';
import { jobInCallerScope, type JobScopeRelation, type ScopeCheckResult } from './scope.js';
import type { JobDetailResponse } from './records.js';
import { type ResultAvailability } from './terminal/export.js';
import {
  type WaitStreamEvent,
  type WaitStreamRequest,
  type WaitSnapshotRequest,
  type WaitCarrierCoverage,
} from './wait/contract.js';

export interface ActiveJobAccess {
  epochKey(): string | null;
  detail(jobId: string): JobDetailResponse | null;
  visitProgress?: ProgressVisit;
  readWaitAdmissions?(jobIds: readonly string[], epochKey: string, session?: object): WaitAdmission[];
  observeWaitCarriers?(jobIds: readonly string[], signal: AbortSignal): Promise<WaitCarrierCoverage>;
  readWaitAdmission?(jobId: string, epochKey: string, session?: object): WaitAdmission | null;
  abort(jobIds: string[]): AbortDecision;
}

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

type HistoricalDisposition = Readonly<{
  kind: 'admitted' | 'outcome-unrecoverable' | 'outcome-unreadable';
  location: JobLocation;
  sourceRead: SourceReadDisposition;
  message?: string;
}>;

const PRE_EPOCH_HISTORY_MESSAGE =
  'A job that ran before store epochs has no details this build can read; another id may never have been a job';

function epochHoldReason(reason: string, retryScheduled: boolean): string {
  if (/\s/.test(reason) && !reason.includes('/') && !reason.includes('Error:') && !/^[A-Z_]+:/.test(reason))
    return reason;
  return retryScheduled
    ? 'Epoch maintenance re-observes this source every 5 s and settles after 3 consecutive failures'
    : 'Epoch maintenance cannot read this source; it re-reads it at the next coordinator start';
}

function historicalDisposition(
  retained: JobLocation,
  closure: 'pending' | 'decided',
  read: HistoricalSourceRead,
  jobId: string,
  fullHistory = false,
): HistoricalDisposition {
  const sourceRead =
    read.kind === 'unreadable'
      ? read.disposition
      : (read.dispositions?.get(jobId) ?? (read.unreadableJobs?.has(jobId) ? 'settled-unreadable' : 'readable'));
  const observed = read.kind === 'read' ? read.locations.get(jobId) : null;
  const location =
    (!fullHistory || !observed) && hasReadableTerminalDetail(retained)
      ? retained
      : (observed ?? { ...retained, disposition: 'unresolved' as const, detail: { kind: 'absent' as const } });
  const message =
    read.kind === 'unreadable' && read.reason !== undefined
      ? epochHoldReason(read.reason, sourceRead === 'transient-unknown')
      : undefined;
  if (hasReadableTerminalDetail(location)) return { kind: 'admitted', location, sourceRead, message };
  if (sourceRead === 'settled-unreadable' || sourceRead === 'retired')
    return {
      kind: 'outcome-unreadable',
      location,
      sourceRead,
      message:
        sourceRead === 'retired'
          ? 'Source retired and retained copy unusable; no build can recover the outcome'
          : `Epoch ${epochToken(retained.epochKey).slice(0, 8)}: ${message ?? "this build cannot decode this job's journal; epoch maintenance re-reads it at the next coordinator start"}`,
    };
  if (closure === 'decided' && sourceRead === 'readable' && read.kind === 'read' && read.locations.has(jobId))
    return {
      kind: 'outcome-unrecoverable',
      location,
      sourceRead,
      message: 'No terminal was recorded before its store epoch closed, so no outcome will ever be recorded',
    };
  return { kind: 'admitted', location, sourceRead, message };
}

export class JobAddressing {
  private readonly activeEpochs = new WeakMap<object, string>();
  private readonly locations: JobLocationView;
  private readonly readHistorical: HistoricalSourceReader;
  private readonly observeResultAvailability: (jobId: string) => ResultAvailability;
  private readonly hintRepair?: (jobId: string) => void;
  private readonly active: ActiveJobAccess;
  private readonly preEpochHistoryExists: PreEpochHistoryProbe;
  private readonly historicalClosure: HistoricalClosureProbe;

  constructor(
    locations: JobLocationView,
    active: ActiveJobAccess,
    preEpochHistoryExists: PreEpochHistoryProbe,
    historicalClosure: HistoricalClosureProbe,
    readHistorical: HistoricalSourceReader = (epochKey, jobIds, session, fullHistory) =>
      locations.readHistorical?.(epochKey, jobIds, session, fullHistory) ?? {
        kind: 'unreadable',
        disposition: 'transient-unknown',
        reason: 'Source observation is unavailable; retry when its owner becomes reachable',
      },
    observeResultAvailability: (jobId: string) => ResultAvailability,
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

  unknownJobDisposition(
    observations = this.locations.unknownLocationHolds(),
  ): 'pre-epoch-history' | 'not-found' | 'discovery-unknown' | 'discovery-unreadable' {
    const holds = observations.filter((hold) => !sameEpoch(hold.epochKey, this.active.epochKey() ?? ':memory:'));
    if (holds.some((hold) => hold.retryScheduled)) return 'discovery-unknown';
    if (holds.length > 0) return 'discovery-unreadable';
    return this.preEpochHistoryExists() ? 'pre-epoch-history' : 'not-found';
  }

  unknownJobCaveat(observations = this.locations.unknownLocationHolds()): string {
    return observations
      .filter((hold) => !sameEpoch(hold.epochKey, this.active.epochKey() ?? ':memory:'))
      .map((hold) => {
        const reason = epochHoldReason(hold.reason, hold.retryScheduled);
        return `${hold.retryScheduled ? 'Retry scheduled for epoch' : 'Unreadable epoch'} ${hold.epochKey === undefined ? hold.directory.slice(0, 8) : epochToken(hold.epochKey).slice(0, 8)}: ${reason}.`;
      })
      .join(' ');
  }

  private historicalLocation(location: JobLocation, fullHistory = false): HistoricalDisposition {
    const retained = this.locations.read(location.jobId) ?? location;
    return historicalDisposition(
      retained,
      this.historicalClosure(retained.epochKey),
      this.readHistorical(retained.epochKey, [retained.jobId], undefined, fullHistory),
      retained.jobId,
      fullHistory,
    );
  }

  /**
   * A wait poll resolves unknown IDs through its own session-cached hold reads, so it skips the uncached hold scan. A
   * location record that cannot be read is no evidence against the active journal, which still answers for its jobs.
   */
  private location(jobId: string, activeEpochKey?: string, scanHolds = true): JobLocation | null {
    let existing: JobLocation | null = null;
    let unreadable: { error: unknown } | undefined;
    try {
      existing = this.locations.read(jobId);
    } catch (error) {
      if (isCodeDefect(error)) throw error;
      unreadable = { error };
    }
    if (existing !== null) return existing;
    const detail = this.active.detail(jobId);
    const epochKey = activeEpochKey ?? this.active.epochKey() ?? ':memory:';
    if (detail === null) {
      if (unreadable) throw unreadable.error;
      if (!scanHolds) return null;
      for (const hold of this.locations.unknownLocationHolds()) {
        if (!hold.epochKey || sameEpoch(hold.epochKey, epochKey)) continue;
        const read = this.readHistorical(hold.epochKey, [jobId]);
        const found = read.kind === 'read' ? read.locations.get(jobId) : null;
        if (found) return found;
      }
      return null;
    }
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
    const historical = !sameEpoch(location.epochKey, this.active.epochKey() ?? ':memory:');
    if (!historical) {
      const active = this.active.detail(jobId);
      if (active !== null)
        return {
          ...active,
          epochKey: location.epochKey,
          ...(active.exit === null ? {} : { availability: this.availability(jobId) }),
        };
    }
    const observed = historical
      ? this.historicalLocation(location, true)
      : { location, kind: 'admitted' as const, message: undefined };
    if (observed.kind !== 'admitted')
      return { kind: observed.kind, jobId, epochKey: location.epochKey, message: observed.message };
    const latest = observed.location;
    if (!historical && latest.disposition === 'unresolved') {
      return { kind: 'unresolved', jobId, epochKey: latest.epochKey };
    }
    if (latest.detail.kind === 'recorded')
      return {
        ...latest.detail.value,
        epochKey: latest.epochKey,
        ...(latest.detail.value.exit === null ? {} : { availability: this.availability(jobId) }),
      };
    return latest.detail.kind === 'unreadable'
      ? { kind: 'detail-unreadable', jobId, epochKey: latest.epochKey }
      : { kind: 'unresolved', jobId, epochKey: latest.epochKey };
  }

  abort(jobIds: string[]): AbortDecision {
    const activeEpochKey = this.active.epochKey() ?? ':memory:';
    const activeIds = jobIds.filter((jobId) => sameEpoch(this.location(jobId)?.epochKey, activeEpochKey));
    const historicalIds = jobIds.filter((jobId) => !activeIds.includes(jobId) && this.location(jobId) !== null);
    const unknownIds = jobIds.filter((jobId) => this.location(jobId) === null);
    const unknownDisposition = this.unknownJobDisposition();
    const preEpochHistory = unknownIds.length > 0 && unknownDisposition === 'pre-epoch-history';
    const active =
      activeIds.length > 0
        ? this.active.abort(activeIds)
        : { kind: 'answered' as const, result: { aborted: [], notFound: [] } };
    if (active.kind !== 'answered') return active;
    const historical = new Map<string, HistoricalDisposition>();
    for (const jobId of historicalIds) {
      const location = this.location(jobId);
      if (location !== null) historical.set(jobId, this.historicalLocation(location));
    }
    const historicalTerminal = [...historical]
      .filter(([, classified]) => hasReadableTerminalDetail(classified.location))
      .map(([jobId]) => jobId);
    const unrecoverable = historicalIds.filter((jobId) => historical.get(jobId)?.kind === 'outcome-unrecoverable');
    const unreadable = historicalIds.filter((jobId) => historical.get(jobId)?.kind === 'outcome-unreadable');
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
      ...(unknownDisposition === 'discovery-unreadable'
        ? unknownIds.map((jobId) => ({
            jobId,
            reason: 'job_outcome_unreadable',
            nextStep: this.unknownJobCaveat(),
          }))
        : []),
      ...unreadable.map((jobId) => ({
        jobId,
        reason: 'job_outcome_unreadable',
        nextStep: "Coral cannot read this job's outcome and nothing here will change that; nothing to stop.",
      })),
      ...unrecoverable.map((jobId) => ({
        jobId,
        reason: 'historical_outcome_unrecoverable',
        nextStep:
          'No Coral coordinator controls this job any more and none will record its outcome, so Coral has nothing to stop. Do not retry.',
      })),
    ];
    const held = [
      ...(active.result.held ?? []),
      ...(unknownDisposition === 'discovery-unknown'
        ? unknownIds.map((jobId) => ({
            jobId,
            reason: 'historical_owner_unresolved',
            nextStep: this.unknownJobCaveat(),
          }))
        : []),
      ...historicalIds
        .filter(
          (jobId) =>
            !historicalTerminal.includes(jobId) && !unrecoverable.includes(jobId) && !unreadable.includes(jobId),
        )
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

        notFound: [
          ...active.result.notFound,
          ...(unknownDisposition === 'not-found' ? unknownIds : []),
          ...historicalTerminal,
        ],
        ...(refused.length === 0 ? {} : { refused }),
        ...(held.length === 0 ? {} : { held }),
      },
    };
  }

  private availability(jobId: string): ResultAvailability {
    const availability = this.observeResultAvailability(jobId);
    if (availability.kind === 'pending') this.hintRepair?.(jobId);
    return availability;
  }

  private waitEpoch(request: object): string {
    const pinned = this.activeEpochs.get(request);
    const epoch = this.active.epochKey() ?? pinned ?? ':memory:';
    this.activeEpochs.set(request, epoch);
    return epoch;
  }

  private readonly liveJobs = new WeakMap<object, Set<string>>();
  private readonly readOffsets = new WeakMap<object, number>();
  admitWait(request: WaitStreamRequest, budgeted = this.liveJobs.has(request)): WaitAdmission[] {
    const observe = (): WaitAdmission[] => this.readAdmissions(request, budgeted);
    const admissions =
      budgeted && this.locations.observePoll
        ? this.locations.observePoll(observe, this.liveJobs.get(request))
        : observe();
    const live = this.liveJobs.get(request) ?? new Set<string>();
    for (const job of admissions) {
      if (job.disposition !== 'admitted') continue;
      if (job.detail?.exit) live.delete(job.jobId);
      else live.add(job.jobId);
    }
    this.liveJobs.set(request, live);
    return admissions;
  }

  private readAdmissions(request: WaitStreamRequest, budgeted: boolean): WaitAdmission[] {
    const activeEpochKey = this.waitEpoch(request);
    const failures = new Map<string, WaitAdmission>();
    const offset = budgeted ? (this.readOffsets.get(request) ?? 0) : 0;
    if (budgeted) this.readOffsets.set(request, (offset + 32) % Math.max(1, request.jobIds.length));
    const ordered = [...request.jobIds.slice(offset), ...request.jobIds.slice(0, offset)];
    const locations = new Map(
      ordered.map((jobId) => {
        try {
          return [jobId, this.location(jobId, activeEpochKey, false)] as const;
        } catch (error) {
          if (isCodeDefect(error)) throw error;
          const sourceRead = sourceReadFailureDisposition(error);
          failures.set(jobId, {
            jobId,
            observationDeferred: error instanceof LocationObservationDeferred,
            disposition: sourceRead === 'settled-unreadable' ? 'unreadable' : 'unknown',
            message:
              error instanceof LocationObservationDeferred
                ? 'Location observation was deferred; this wait reads it on the next bounded poll'
                : sourceRead === 'settled-unreadable'
                  ? 'Job location cannot be decoded by this build; location recovery re-reads it at the next coordinator start'
                  : 'Job location cannot be observed; this wait retries after 250 ms, 1 s and 5 s, then ends this read attempt',
          });
          return [jobId, null] as const;
        }
      }),
    );
    const epochMembers = new Map<string, { epochKey: string; jobIds: string[] }>();
    for (const [jobId, location] of locations) {
      if (!location) continue;
      const identity = epochIdentity(location.epochKey);
      const members = epochMembers.get(identity) ?? { epochKey: location.epochKey, jobIds: [] };
      members.jobIds.push(jobId);
      epochMembers.set(identity, members);
    }
    const unknownIds = [...locations]
      .filter(([jobId, location]) => !location && !failures.has(jobId))
      .map(([id]) => id);
    const holds = unknownIds.length ? this.locations.unknownLocationHolds() : [];
    for (const hold of holds) {
      if (!hold.retryScheduled || hold.epochKey === undefined || sameEpoch(hold.epochKey, activeEpochKey)) continue;
      const identity = epochIdentity(hold.epochKey);
      const members = epochMembers.get(identity) ?? { epochKey: hold.epochKey, jobIds: [] };
      for (const jobId of unknownIds) if (!members.jobIds.includes(jobId)) members.jobIds.push(jobId);
      epochMembers.set(identity, members);
    }
    const historicalEpochs = [...epochMembers.values()].filter(({ epochKey }) => !sameEpoch(epochKey, activeEpochKey));
    const closures = new Map(
      historicalEpochs.map(({ epochKey }) => [epochIdentity(epochKey), this.historicalClosure(epochKey)]),
    );
    const historical = new Map(
      historicalEpochs.map(({ epochKey, jobIds }) => [
        epochIdentity(epochKey),
        this.readHistorical(epochKey, jobIds, request),
      ]),
    );
    for (const jobId of unknownIds) {
      for (const source of historical.values()) {
        const found = source.kind === 'read' ? source.locations.get(jobId) : null;
        if (found) {
          locations.set(jobId, found);
          break;
        }
      }
    }
    const activeAdmissions = new Map(
      (
        this.active.readWaitAdmissions?.(
          epochMembers.get(epochIdentity(activeEpochKey))?.jobIds ?? [],
          activeEpochKey,
          request,
        ) ?? []
      ).map((job) => [job.jobId, job]),
    );
    return request.jobIds.map((jobId): WaitAdmission => {
      const failure = failures.get(jobId);
      if (failure) return failure;
      const location = locations.get(jobId) ?? null;
      if (location === null) {
        const unresolvedHolds = holds.filter((hold) => {
          if (!hold.retryScheduled || hold.epochKey === undefined) return true;
          const source = historical.get(epochIdentity(hold.epochKey));
          return source?.kind !== 'read' || !source.absentJobs?.has(jobId);
        });
        const unknown = this.unknownJobDisposition(unresolvedHolds);
        const message = this.unknownJobCaveat(unresolvedHolds) || undefined;
        if (unknown === 'not-found') return { jobId, disposition: 'missing', message };
        if (unknown === 'discovery-unknown') return { jobId, disposition: 'unknown', message };
        return {
          jobId,
          disposition: 'unreadable',
          message: unknown === 'pre-epoch-history' ? PRE_EPOCH_HISTORY_MESSAGE : message,
        };
      }
      if (
        request.projectRoot !== undefined &&
        !jobInCallerScope(
          {
            jobKind: location.subject.jobKind,
            workDir:
              location.subject.workDir === null ? null : canonicalWorkDirWireSchema.parse(location.subject.workDir),
          },
          canonicalWorkDirWireSchema.parse(request.projectRoot),
          'contains',
        )
      )
        return {
          jobId,
          disposition: 'scope-mismatch',
          message: 'Change cwd to the job work directory; coral-cli jobs --all includes terminal jobs.',
        };
      if (sameEpoch(location.epochKey, activeEpochKey)) {
        try {
          return this.activeAdmission(jobId, location.epochKey, activeAdmissions.get(jobId), request);
        } catch (error) {
          return activeJournalReadFailure(jobId, location.epochKey, error);
        }
      }
      return historicalAdmission(
        jobId,
        location,
        closures.get(epochIdentity(location.epochKey)),
        historical.get(epochIdentity(location.epochKey)),
        (id) => this.availability(id),
      );
    });
  }

  private activeAdmission(
    jobId: string,
    epochKey: string,
    read: WaitAdmission | undefined,
    request: WaitStreamRequest,
  ): WaitAdmission {
    const admission = read ?? this.active.readWaitAdmission?.(jobId, epochKey, request);
    const detail = admission?.detail ?? this.active.detail(jobId);
    if (admission && admission.disposition !== 'admitted') return admission;
    if (!detail && !admission?.queued)
      return {
        jobId,
        disposition: 'unknown',
        epochKey,
        message: 'The job is not yet readable in the active journal; this wait reads it again on its next poll',
      };
    return {
      ...admission,
      jobId,
      disposition: 'admitted',
      epochKey,
      ...(detail === null || detail === undefined ? {} : { detail: waitDetail(detail) }),
      ...(detail?.exit ? { availability: admission?.availability ?? this.availability(jobId) } : {}),
    };
  }

  /** Progress is read from the active epoch only; a job admitted from another epoch delivers its terminal alone. */
  readonly visitProgress: ProgressVisit = (epoch, read) =>
    sameEpoch(epoch, this.active.epochKey() ?? ':memory:')
      ? (this.active.visitProgress?.(epoch, read) ?? { kind: 'unreadable', disposition: 'transient-unknown' })
      : { kind: 'unreadable', disposition: 'transient-unknown' };

  snapshot(request: WaitSnapshotRequest): WaitSnapshot {
    const session = new WaitSession(request.jobIds, request.cursor, this.waitEpoch(request));
    session.reconcile(this.admitWait(request, false));
    return selectWaitSnapshot(session, request.lines ?? 20, this.visitProgress);
  }

  async *waitStream(request: WaitStreamRequest): AsyncGenerator<WaitStreamEvent> {
    const activeEpochKey = this.waitEpoch(request);
    let firstRead = true;
    yield* readWaitSession({
      request,
      activeEpochKey,
      time: this.locations.time,
      visit: this.visitProgress,
      read: () => {
        const admissions = firstRead && request.admissions ? request.admissions : this.admitWait(request, !firstRead);
        firstRead = false;
        return admissions;
      },
      observe: async (session, signal) => {
        const activeIds = session.admissions
          .filter(
            (job) => job.disposition === 'admitted' && sameEpoch(job.epochKey, activeEpochKey) && !job.detail?.exit,
          )
          .map((job) => job.jobId);
        if (activeIds.length === 0 || !this.active.observeWaitCarriers) return;
        const coverage = await this.active.observeWaitCarriers(activeIds, signal);
        if (signal.aborted) return;
        session.observeCoverage(activeIds, coverage.unknownJobIds, coverage.frontier);
        for (const event of coverage.interrupted) session.observeAbsent(event.jobId, event.observedMaxJournalSeq);
      },
    });
  }
}

function waitDetail(
  detail: NonNullable<WaitAdmission['detail']> | JobDetailResponse,
): NonNullable<WaitAdmission['detail']> {
  return {
    status: detail.status,
    exit: detail.exit,
    readiness: detail.readiness,
    terminalSeq:
      'events' in detail
        ? (detail.events.find((event) => event.type === 'terminal')?.seq ?? detail.status.lastSeq)
        : detail.terminalSeq,
  };
}

function historicalAdmission(
  jobId: string,
  location: JobLocation,
  closure: ReturnType<HistoricalClosureProbe> | undefined,
  source: HistoricalSourceRead | undefined,
  availability: (jobId: string) => ResultAvailability,
): WaitAdmission {
  if (!source) throw new Error(`Missing historical read for epoch ${location.epochKey}`);
  const classified = historicalDisposition(location, closure ?? 'pending', source, jobId);
  const { message } = classified;
  const accepted = classified.location;
  if (classified.kind !== 'admitted') return { jobId, disposition: 'unreadable', epochKey: location.epochKey, message };
  if (!hasReadableTerminalDetail(accepted))
    return classified.sourceRead === 'transient-unknown'
      ? {
          jobId,
          disposition: 'unknown',
          epochKey: location.epochKey,
          message:
            message ??
            'Its store epoch cannot be read right now; epoch maintenance re-reads it every 5 s and settles after 3 failed probes',
        }
      : {
          jobId,
          disposition: 'admitted',
          epochKey: location.epochKey,
          historical: true,
          ...(accepted.detail.kind === 'recorded' ? { detail: waitDetail(accepted.detail.value) } : {}),
        };
  const detail = accepted.detail.kind === 'recorded' ? accepted.detail.value : undefined;
  return {
    jobId,
    disposition: 'admitted',
    epochKey: location.epochKey,
    historical: true,
    ...(detail ? { detail: waitDetail(detail) } : {}),
    availability: availability(jobId),
  };
}
