import { jobProgressRetentionExpired } from '../progress-retention.js';
import { observeResolvedStoreEpoch } from '../../store/epoch/index.js';
import { epochIdentity } from '../../store/epoch/identity.js';
import { sourceReadFailureDisposition, sourceReadStamp } from '../source-read.js';
import { dirname, join } from 'node:path';

import type { Database } from '../../store/db.js';
import type { AppendedEvent, PostCommitObserver } from '../../store/append.js';

import type { StoragePort } from '../../infra/port-types.js';
import { type StoreReadContext } from '../../store/body-codec.js';

import type { EventsRow } from '../../store/schema.js';
import { extractCauseRef, renderCauseRefFallback, type CauseRef } from '../../causality/cause-ref.js';
import type { CoralEvent } from '../../store/envelope.js';
import { isRecord } from '../../infra/json.js';
import { jobTerminalRecordedBodySchema } from './result.js';
import { describeTerminalOutcome } from '../outcome.js';
import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { setImmediate } from 'node:timers/promises';
import type { Runtime } from '../../runtime/ports.js';
import type { JobTerminal } from '../records.js';
import type { JobLocation } from '../location-index.js';
import { hasObservedTerminalDetail, hasReadableTerminalDetail, sameTerminal } from './identity.js';
import { readAcceptedTerminal } from './source.js';
import { terminalEligibility, type TerminalEligibility } from '../export-retention.js';
import { trustedJobRetentionCutoff, resolveJobRetentionMs } from '../retention-clock.js';
import type { RetentionRunBudget } from '../../store/retention-outcome.js';

function unavailableForEligibility(eligibility: TerminalEligibility, retentionDays: number): ResultAvailability | null {
  if (eligibility.kind === 'expired')
    return {
      kind: 'retained-away',
      retentionDays,
    };
  if (eligibility.sourceReadFailed && !eligibility.sourceReadTransient)
    return { kind: 'failed', cause: 'terminal-unusable', retryScheduled: false, ageUncertain: true };
  if (eligibility.sourceContradictory) return { kind: 'failed', cause: 'terminal-unusable', retryScheduled: false };
  if (eligibility.age === 'unknown' && !eligibility.ageDeferred && !eligibility.sourceReadTransient)
    return { kind: 'failed', cause: 'terminal-age-unknown', retryScheduled: false, ageUncertain: true };
  if (!eligibility.sourceReadable && !eligibility.sourceReadFailed)
    return {
      kind: 'failed',
      cause: 'source-epoch-retired',
      retryScheduled: false,
      ageUncertain: eligibility.age === 'regression',
    };
  if (
    eligibility.age === 'regression' &&
    !eligibility.ageDeferred &&
    !eligibility.regressionAuthorized &&
    !eligibility.sourceReadFailed
  )
    return { kind: 'failed', cause: 'terminal-clock-regression', retryScheduled: false, ageUncertain: true };
  if (!eligibility.cutoffTrusted) return { kind: 'failed', cause: 'cutoff-untrusted', retryScheduled: true };
  return null;
}

export function resultPathFor(jobsRoot: string, jobId: string): string {
  return join(jobsRoot, jobId, 'result.md');
}

function describeKnownEvent(event: CoralEvent): string {
  const body = event.body;
  if (event.type === 'workflow.completed' && isRecord(body) && typeof body.outcome === 'string') {
    return `Workflow ${body.outcome}.`;
  }

  if (
    event.type === 'workflow.lifecycle_fault' &&
    isRecord(body) &&
    typeof body.kind === 'string' &&
    typeof body.message === 'string'
  ) {
    return `Workflow lifecycle fault (${body.kind}): ${body.message}.`;
  }

  if (event.type === 'job.terminal.recorded') {
    const parsed = jobTerminalRecordedBodySchema.safeParse(body);
    if (parsed.success) {
      return describeTerminalOutcome(parsed.data.terminal.outcome, {
        describeCauseRef: renderCauseRefFallback,
      });
    }
  }

  return event.type;
}

function describeCauseRefChain(
  db: Database,
  ctx: StoreReadContext,
  ref: CauseRef,
  visited: Set<string>,
): string | null {
  const key = `${ref.stream.kind}:${ref.stream.id}:${ref.seq}`;
  if (visited.has(key)) {
    return null;
  }
  visited.add(key);

  const row = db.prepare<[number], EventsRow>('SELECT * FROM events WHERE seq = ?').get(ref.seq);
  if (!row || row.stream_kind !== ref.stream.kind || row.stream_id !== ref.stream.id) {
    return null;
  }

  const body: unknown = JSON.parse(Buffer.from(row.body).toString('utf8'));
  const event = { type: row.type, body } as CoralEvent;
  const localDescription = describeKnownEvent(event);
  const nextRef = extractCauseRef(body);
  if (!nextRef) {
    return localDescription;
  }

  const nextDescription = describeCauseRefChain(db, ctx, nextRef, visited);
  return nextDescription === null ? null : `${localDescription} Caused by: ${nextDescription}`;
}

function describeResolvedCauseRef(db: Database, ctx: StoreReadContext, ref: CauseRef): string {
  try {
    return describeCauseRefChain(db, ctx, ref, new Set()) ?? renderCauseRefFallback(ref);
  } catch {
    return renderCauseRefFallback(ref);
  }
}

function workflowIdentityMarkdown(db: Database, jobId: string): string {
  const launch = db
    .prepare<
      [string],
      EventsRow
    >("SELECT * FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.launch.requested' ORDER BY seq LIMIT 1")
    .get(jobId);
  if (!launch) return '';
  const refs: unknown = launch.refs ? JSON.parse(launch.refs) : null;
  const body: unknown = JSON.parse(Buffer.from(launch.body).toString('utf8'));
  if (!isRecord(refs) || typeof refs.parentJobId !== 'string' || !isRecord(body)) return '';
  const lines = [
    `> Parent workflow: ${refs.parentJobId}`,
    `> Workflow slot: ${refs.workflowSlotId}`,
    `> Workflow generation: ${body.workflowSlotGeneration}`,
  ];
  if (typeof body.replacesWorkflowJobId === 'string')
    lines.push(`> Replaces workflow job: ${body.replacesWorkflowJobId}`);
  return `${lines.join('\n')}\n\n`;
}

export type WorkflowReportPort = (
  input: Readonly<{
    db: Database;
    epochKey: string;
    jobId: string;
    accepted: EventsRow;
    terminal: JobTerminal;
  }>,
) => string | null;

export type ResultAvailability =
  | Readonly<{ kind: 'available'; resultPath: string }>
  | Readonly<{ kind: 'retained-away'; retentionDays: number }>
  | Readonly<{ kind: 'repair-pending'; ageUncertain: boolean }>
  | Readonly<{
      kind: 'failed';
      cause:
        | 'repair-failed'
        | 'workflow-facts-unavailable'
        | 'source-epoch-retired'
        | 'terminal-age-unknown'
        | 'terminal-clock-regression'
        | 'cutoff-untrusted'
        | 'terminal-unusable';
      retryScheduled: boolean;
      ageUncertain?: boolean;
      unverifiedResultPath?: string;
    }>;

/** Bounded by evicting its oldest member: an overflow forgets one job, never relabels every other job. */
class RepairSet extends Set<string> {
  private readonly limit: number;
  constructor(limit = 1024) {
    super();
    this.limit = limit;
  }
  override add(jobId: string): this {
    if (!this.has(jobId) && this.size >= this.limit) {
      const oldest = this.values().next().value;
      if (oldest !== undefined) this.delete(oldest);
    }
    return super.add(jobId);
  }
}

const repairFailures = new WeakMap<object, Set<string>>();

export function resultRepairFailuresFor(ownerScope: object): Set<string> {
  let failures = repairFailures.get(ownerScope);
  if (!failures) {
    failures = new RepairSet();
    repairFailures.set(ownerScope, failures);
  }
  return failures;
}

const repairQueues = new WeakMap<object, { hints: Set<string>; listener: (() => void) | null }>();

export class TerminalResultExportOwner {
  private readonly failures: Set<string>;
  private readonly uncaptured = new RepairSet();
  private publicationLocation: JobLocation | null | undefined;
  private publicationTerminal: { accepted: EventsRow; terminal: JobTerminal } | undefined;
  private sourceSession: { db: Database; ctx: StoreReadContext } | undefined;
  private readonly repairQueue: { hints: Set<string>; listener: (() => void) | null };
  private readonly hints: Set<string>;
  private ownsRepairSchedule = false;
  private repairScan: Iterator<string> | undefined;
  private repairHintNext = true;

  private readonly input: Readonly<{
    runtime: Pick<Runtime, 'storage' | 'paths' | 'time' | 'env'>;
    jobsRoot: string;
    location(jobId: string): JobLocation | null;
    withSource<T>(
      jobId: string,
      read: (db: Database, ctx: StoreReadContext) => T,
      location?: JobLocation | null,
    ): T | null;
    publicationLocation?(jobId: string): JobLocation | null;
    publicationUnchanged?(jobId: string, location: JobLocation): boolean;
    workflowReport?: WorkflowReportPort;
    failures?: Set<string>;
    repairScope?: object;
    repairQueueLimit?: number;
    prepareTerminal?(jobId: string, db: Database): void;
    hydrationRetry?(jobId: string): boolean | undefined;
  }>;

  constructor(input: TerminalResultExportOwner['input']) {
    this.input = input;
    this.failures = input.failures ?? new RepairSet(input.repairQueueLimit);
    const scope = input.repairScope ?? this;
    this.repairQueue = repairQueues.get(scope) ?? { hints: new RepairSet(input.repairQueueLimit), listener: null };
    repairQueues.set(scope, this.repairQueue);
    this.hints = this.repairQueue.hints;
    for (const jobId of this.failures) this.hints.add(jobId);
  }

  private withSource<T>(jobId: string, read: (db: Database, ctx: StoreReadContext) => T): T | null {
    return this.sourceSession
      ? read(this.sourceSession.db, this.sourceSession.ctx)
      : this.input.withSource(jobId, read);
  }

  private eligibility(jobId: string, observeSource = true, readOnly = false): TerminalEligibility {
    return terminalEligibility(
      this.input.runtime,
      this.publicationLocation ?? this.input.location(jobId),
      (read) => this.withSource(jobId, (db) => read(db)),
      observeSource,
      this.publicationTerminal,
      readOnly,
    );
  }

  private readableFile(path: string): boolean {
    try {
      const file = this.input.runtime.storage.lstatSync(path, { bigint: true });
      return file.isFile() && file.size > 0n;
    } catch {
      return false;
    }
  }

  private available(jobId: string): boolean {
    const location = this.input.location(jobId);
    if (!location || !hasObservedTerminalDetail(location) || location.resultPath === undefined) return false;
    return this.readableFile(location.resultPath);
  }

  private readonly observedWorkflowReports = new WeakMap<object, Map<string, boolean>>();

  /** A terminal's workflow facts precede it in its own stream, so unrelated appends cannot change its readability. */
  private workflowReadable(jobId: string, session?: object): boolean {
    const location = this.input.location(jobId);
    const identity =
      session && location?.terminalSeq !== undefined && location.storedIdentity !== undefined
        ? JSON.stringify([epochIdentity(location.epochKey), jobId, location.terminalSeq, location.storedIdentity])
        : undefined;
    const observed = session ? this.observedWorkflowReports.get(session) : undefined;
    const cached = identity === undefined ? undefined : observed?.get(identity);
    if (cached !== undefined) return cached;
    const readable = this.render(jobId) !== null;
    if (session && identity !== undefined)
      this.observedWorkflowReports.set(session, (observed ?? new Map<string, boolean>()).set(identity, readable));
    return readable;
  }

  private prepareTerminal(jobId: string, db: Database, location = this.input.location(jobId)): void {
    if (location && hasReadableTerminalDetail(location) && location.terminalAge !== undefined) return;
    this.input.prepareTerminal?.(jobId, db);
  }

  private render(jobId: string): string | null {
    const location = this.publicationLocation ?? this.input.location(jobId);
    if (!location || !hasReadableTerminalDetail(location)) return null;
    return this.withSource(jobId, (db, ctx) => {
      const accepted = this.publicationTerminal?.accepted ?? readAcceptedTerminal(db, jobId);
      if (!accepted || accepted.seq !== location.terminalSeq) return null;
      const body = this.publicationTerminal
        ? { terminal: this.publicationTerminal.terminal }
        : jobTerminalRecordedBodySchema.parse(JSON.parse(Buffer.from(accepted.body).toString('utf8')));
      if (
        location.detail.kind !== 'recorded' ||
        !location.detail.value.exit ||
        !sameTerminal(body.terminal, location.detail.value.exit)
      )
        return null;
      if (location.subject.jobKind === 'workflow') {
        return (
          this.input.workflowReport?.({ db, epochKey: location.epochKey, jobId, accepted, terminal: body.terminal }) ??
          null
        );
      }
      const identity = workflowIdentityMarkdown(db, jobId);
      const content = body.terminal.content.trimEnd();
      return `${identity}${content || describeTerminalOutcome(body.terminal.outcome, { describeCauseRef: (ref) => describeResolvedCauseRef(db, ctx, ref) })}\n`;
    });
  }

  private readonly progressRetention = new WeakMap<object, Map<string, boolean>>();

  /** Availability observation never synchronizes or repairs storage; one request decides each terminal once. */
  progressRetentionExpired(jobId: string, session?: object): boolean | undefined {
    const cutoff = trustedJobRetentionCutoff(this.input.runtime);
    if (cutoff === null) return undefined;
    const location = this.input.location(jobId);
    const identity =
      session && location?.terminalSeq !== undefined
        ? JSON.stringify([epochIdentity(location.epochKey), jobId, location.terminalSeq])
        : undefined;
    const decided = session ? this.progressRetention.get(session) : undefined;
    const cached = identity === undefined ? undefined : decided?.get(identity);
    if (cached !== undefined) return cached;
    let expired: boolean | undefined;
    try {
      expired =
        this.withSource(jobId, (db) => {
          const terminal = readAcceptedTerminal(db, jobId);
          return terminal ? jobProgressRetentionExpired(db, terminal, cutoff) : undefined;
        }) ?? undefined;
    } catch {
      return undefined;
    }
    if (session && identity !== undefined && expired !== undefined) {
      const next = decided ?? new Map<string, boolean>();
      next.set(identity, expired);
      this.progressRetention.set(session, next);
    }
    return expired;
  }

  private readonly observedEligibility = new Map<
    string,
    { stamp: string; identity: string | undefined; eligibility: TerminalEligibility }
  >();

  private observeEligibility(jobId: string): TerminalEligibility {
    const location = this.input.location(jobId);
    const epoch = location ? observeResolvedStoreEpoch(this.input.runtime, location.epochKey) : undefined;
    const stamp = epoch ? sourceReadStamp(this.input.runtime.storage, epoch.path) : null;
    const previous = this.observedEligibility.get(jobId);
    if (
      stamp !== null &&
      previous?.stamp === stamp &&
      location?.storedIdentity !== undefined &&
      previous.identity === location.storedIdentity &&
      (!previous.eligibility.ageDeferred || trustedJobRetentionCutoff(this.input.runtime) === null)
    ) {
      const current = this.eligibility(jobId, false, true);
      if (current.kind === 'expired') return current;
      const cutoff = trustedJobRetentionCutoff(this.input.runtime);
      const age = previous.eligibility.age;
      const kind =
        cutoff === null
          ? 'unknown'
          : typeof age === 'number'
            ? age < cutoff
              ? 'expired'
              : 'inside'
            : previous.eligibility.kind;
      return {
        ...previous.eligibility,
        kind,
        cutoffTrusted: cutoff !== null,
        publicationAuthorized:
          cutoff !== null &&
          previous.eligibility.sourceReadable &&
          (kind === 'inside' || previous.eligibility.regressionAuthorized === true),
      };
    }
    const eligibility = this.eligibility(jobId, true, true);
    if (location && stamp !== null && !eligibility.sourceReadFailed) {
      this.observedEligibility.delete(jobId);
      this.observedEligibility.set(jobId, { stamp, identity: location.storedIdentity, eligibility });
      const oldest = this.observedEligibility.keys().next().value;
      if (this.observedEligibility.size > 128 && oldest !== undefined) this.observedEligibility.delete(oldest);
    }
    return eligibility;
  }

  observeResultAvailability(jobId: string, session?: object): ResultAvailability {
    const location = this.input.location(jobId);
    if (!location || location.disposition !== 'terminal') {
      if (this.uncaptured.has(jobId) && this.input.hydrationRetry?.(jobId) !== true)
        return { kind: 'failed', cause: 'repair-failed', retryScheduled: false };
      const path = location?.resultPath ?? resultPathFor(this.input.jobsRoot, jobId);
      const unverifiedResultPath = this.readableFile(path) ? path : undefined;
      try {
        const terminal = this.withSource(jobId, (db) => readAcceptedTerminal(db, jobId) !== null);
        if (terminal === null)
          return { kind: 'failed', cause: 'terminal-unusable', retryScheduled: false, unverifiedResultPath };
        if (terminal)
          return this.failures.has(jobId)
            ? { kind: 'failed', cause: 'repair-failed', retryScheduled: true, unverifiedResultPath }
            : { kind: 'repair-pending', ageUncertain: true };
      } catch (error) {
        const retry = this.input.hydrationRetry?.(jobId);
        if (retry !== false && sourceReadFailureDisposition(error) === 'transient-unknown')
          return this.failures.has(jobId)
            ? { kind: 'failed', cause: 'repair-failed', retryScheduled: true, unverifiedResultPath }
            : { kind: 'repair-pending', ageUncertain: true };
      }
      const retry = this.input.hydrationRetry?.(jobId);
      if (retry === false)
        return { kind: 'failed', cause: 'terminal-unusable', retryScheduled: false, unverifiedResultPath };
      if (this.failures.has(jobId))
        return { kind: 'failed', cause: 'repair-failed', retryScheduled: true, unverifiedResultPath };
      if (retry === true) return { kind: 'repair-pending', ageUncertain: true };
      return { kind: 'failed', cause: 'terminal-unusable', retryScheduled: false, unverifiedResultPath };
    }
    if (!hasObservedTerminalDetail(location))
      return { kind: 'failed', cause: 'terminal-unusable', retryScheduled: false };
    if (this.available(jobId))
      return { kind: 'available', resultPath: location.resultPath ?? resultPathFor(this.input.jobsRoot, jobId) };
    const eligibility = this.observeEligibility(jobId);
    if (eligibility.sourceReadFailed && this.input.hydrationRetry?.(jobId) === false)
      return { kind: 'failed', cause: 'terminal-unusable', retryScheduled: false, ageUncertain: true };
    const unavailable = unavailableForEligibility(
      eligibility,
      resolveJobRetentionMs(this.input.runtime.env.get('CORAL_JOBS_RETENTION_DAYS')) / 86_400_000,
    );
    if (unavailable) return unavailable;
    if (this.failures.has(jobId)) return { kind: 'failed', cause: 'repair-failed', retryScheduled: true };
    try {
      if (location.subject.jobKind === 'workflow' && !this.workflowReadable(jobId, session))
        return { kind: 'failed', cause: 'workflow-facts-unavailable', retryScheduled: false };
    } catch {
      return { kind: 'repair-pending', ageUncertain: true };
    }
    return {
      kind: 'repair-pending',
      ageUncertain: eligibility.age === 'regression' || eligibility.sourceReadFailed === true,
    };
  }

  /** Callers supply identity; all publication bytes come from the accepted source terminal. */
  publishTerminalResult(jobId: string, _newlyAppendedSeq?: number): string {
    return this.publish(jobId, false);
  }

  ensureResultMarkdownArtifact(jobId: string): string {
    return this.publish(jobId, true);
  }

  private publish(jobId: string, repair: boolean): string {
    const location = this.input.publicationLocation?.(jobId) ?? this.input.location(jobId);
    const targetPath = location?.resultPath ?? resultPathFor(this.input.jobsRoot, jobId);
    if (repair && location && hasReadableTerminalDetail(location) && this.eligibility(jobId, false).kind === 'expired')
      return targetPath;
    if (location && hasReadableTerminalDetail(location) && this.readableFile(targetPath)) {
      this.failures.delete(jobId);
      return targetPath;
    }
    try {
      return (
        this.input.withSource(
          jobId,
          (db, ctx) => {
            this.sourceSession = { db, ctx };
            try {
              return this.publishInSource(jobId, repair, db, location);
            } finally {
              this.sourceSession = undefined;
              this.publicationLocation = undefined;
              this.publicationTerminal = undefined;
            }
          },
          location,
        ) ?? targetPath
      );
    } catch (error) {
      this.failures.add(jobId);
      if (repair && this.ownsRepairSchedule) this.hints.add(jobId);
      else this.hintRepair(jobId);
      throw error;
    }
  }

  private publishInSource(jobId: string, repair: boolean, db: Database, snapshot: JobLocation | null): string {
    try {
      this.prepareTerminal(jobId, db, snapshot);
    } catch (error) {
      this.failures.add(jobId);
      if (repair && this.ownsRepairSchedule) this.hints.add(jobId);
      else this.hintRepair(jobId);
      throw error;
    }
    const location = snapshot?.terminalAge !== undefined ? snapshot : this.input.location(jobId);
    this.publicationLocation = location;
    const targetPath = location?.resultPath ?? resultPathFor(this.input.jobsRoot, jobId);
    if (this.readableFile(targetPath)) {
      this.failures.delete(jobId);
      return targetPath;
    }
    const accepted = readAcceptedTerminal(db, jobId);
    if (!accepted) return targetPath;
    if (!location || !hasReadableTerminalDetail(location)) {
      this.uncaptured.add(jobId);
      return targetPath;
    }
    const body = jobTerminalRecordedBodySchema.parse(JSON.parse(Buffer.from(accepted.body).toString('utf8')));
    this.publicationTerminal = { accepted, terminal: body.terminal };
    const eligibility = this.eligibility(jobId);
    if (!eligibility.publicationAuthorized) {
      if (!eligibility.cutoffTrusted || eligibility.sourceReadTransient) this.hintRepair(jobId);
      return targetPath;
    }
    const markdown = this.render(jobId);
    if (!markdown) return targetPath;
    const authorized = (): boolean => {
      const cutoff = trustedJobRetentionCutoff(this.input.runtime);
      if (cutoff === null || (typeof eligibility.age === 'number' && eligibility.age < cutoff)) return false;
      const current = this.input.publicationUnchanged
        ? this.input.publicationUnchanged(jobId, location)
          ? location
          : null
        : this.input.location(jobId);
      if (
        !current ||
        current.disposition !== 'terminal' ||
        current.terminalSeq !== accepted.seq ||
        (isRecord(current.terminalAge) ? current.terminalAge.kind : undefined) !==
          (isRecord(location.terminalAge) ? location.terminalAge.kind : undefined)
      )
        return false;
      const row = db
        .prepare<
          [string],
          { seq: number; ts: string }
        >("SELECT seq, ts FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.terminal.recorded' ORDER BY seq DESC LIMIT 1")
        .get(jobId);
      return row?.seq === accepted.seq && row.ts === accepted.ts;
    };
    writeResultArtifact(this.input.runtime.storage, targetPath, markdown, authorized);
    if (this.readableFile(targetPath)) this.failures.delete(jobId);
    else if (repair && this.ownsRepairSchedule) this.hints.add(jobId);
    else this.hintRepair(jobId);
    return targetPath;
  }

  hintRepair(jobId: string): void {
    if (this.uncaptured.has(jobId) && this.input.hydrationRetry?.(jobId) !== true) return;
    if (this.hints.has(jobId)) return;
    this.hints.add(jobId);
    this.repairQueue.listener?.();
  }

  onRepairHint(listener: (() => void) | null): void {
    this.ownsRepairSchedule = listener !== null;
    this.repairQueue.listener = listener;
  }

  async repairPass(jobIds: Iterable<string>, budget: RetentionRunBudget, hintedOnly = false): Promise<void> {
    const hints = [...this.hints];
    let hintIndex = 0;
    const attempted = new Set<string>();
    if (!hintedOnly) this.repairScan ??= jobIds[Symbol.iterator]();
    while (budget.canContinue()) {
      const hint = hints[hintIndex];
      let jobId: string;
      if (hint !== undefined && (hintedOnly || this.repairHintNext || this.repairScan === undefined)) {
        jobId = hint;
        hintIndex++;
        this.hints.delete(jobId);
        this.repairHintNext = false;
      } else {
        if (hintedOnly) return;
        const next = this.repairScan?.next();
        if (!next || next.done) {
          this.repairScan = undefined;
          this.repairHintNext = true;
          if (hintIndex === hints.length) return;
          continue;
        }
        jobId = next.value;
        this.repairHintNext = true;
      }
      if (attempted.has(jobId)) continue;
      attempted.add(jobId);
      await this.repairCandidate(jobId, budget);
    }
    budget.record({ kind: 'kept', subject: 'result-repair', reason: 'scan-pending' });
  }

  private async repairCandidate(jobId: string, budget: RetentionRunBudget): Promise<void> {
    try {
      const state = this.observeResultAvailability(jobId);
      if (state.kind !== 'repair-pending' && !(state.kind === 'failed' && state.retryScheduled)) return;
      if (budget.canMutate?.() !== false) this.ensureResultMarkdownArtifact(jobId);
      const after = this.observeResultAvailability(jobId);
      if (after.kind === 'repair-pending') budget.record({ kind: 'kept', subject: jobId, reason: 'repair-pending' });
      else if (after.kind === 'failed' && after.retryScheduled)
        budget.record({ kind: 'failed', subject: jobId, reason: after.cause });
    } catch (error) {
      budget.record({ kind: 'failed', subject: jobId, reason: errorMessage(error) });
    }
    await setImmediate();
  }
}

function writeResultArtifact(
  storage: Pick<StoragePort, 'mkdirSync' | 'writeAtomicDurableSync' | 'syncDirectoryDurableSync'>,
  targetPath: string,
  markdown: string,
  beforeRename: () => boolean,
): void {
  if (!markdown || !beforeRename()) return;
  const jobsRoot = dirname(dirname(targetPath));
  storage.mkdirSync(dirname(targetPath), { recursive: true });
  let refused = false;
  const decideRename = (): boolean => {
    refused = !beforeRename();
    return !refused;
  };
  if (!storage.writeAtomicDurableSync(targetPath, markdown, { encoding: 'utf-8', beforeRename: decideRename })) {
    if (refused) return;
    throw new Error(`Failed to write result artifact: ${targetPath}`);
  }
  if (!storage.syncDirectoryDurableSync(jobsRoot) || !storage.syncDirectoryDurableSync(dirname(jobsRoot)))
    throw new Error(`Failed to sync result artifact: ${targetPath}`);
}

export function observeTerminalResultExports(
  ensureResultArtifact: (jobId: string, newlyAppendedSeq: number) => string,
  recordTerminal?: (jobId: string, seq: number) => void,
): PostCommitObserver {
  return (appended: readonly AppendedEvent[]): void => {
    for (const event of appended) {
      if (event.stream.kind !== 'job' || event.type !== 'job.terminal.recorded') {
        continue;
      }
      try {
        recordTerminal?.(event.stream.id, event.seq);
      } catch (error: unknown) {
        backendLog.warn(`Recording terminal location failed for ${event.stream.id}: ${errorMessage(error)}`);
      }
      try {
        ensureResultArtifact(event.stream.id, event.seq);
      } catch (error: unknown) {
        backendLog.warn(`Writing terminal export failed for ${event.stream.id}: ${errorMessage(error)}`);
      }
    }
  };
}
