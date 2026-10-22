import type { RecoveryObservation } from '../../recovery/phase-observation.js';
import { observeDatabaseReads } from '../../recovery/read-observation.js';
import { join } from 'node:path';

import type { Database } from '../../store/db.js';
import type { AppendedEvent, PostCommitObserver } from '../../store/append.js';

import { repairRetainedExecution } from '../retained-current.js';
import { writeResultArtifact, type DecodedResultArtifact } from './artifact.js';
import { type StoreReadContext } from '../../store/body-codec.js';

import type { EventsRow } from '../../store/schema.js';
import { extractCauseRef, renderCauseRefFallback, type CauseRef } from '../../causality/cause-ref.js';
import type { CoralEvent } from '../../store/envelope.js';
import { isRecord } from '../../infra/json.js';
import { jobExecutionEndedBodySchema, jobExecutionOutcomeAcceptedBodySchema } from './result.js';
import { describeTerminalOutcome } from '../outcome.js';
import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { setImmediate } from 'node:timers/promises';
import type { Runtime } from '../../runtime/ports.js';
import type { JobTerminal } from '../records.js';
import type { JobLocation } from '../location-index.js';
import { hasReadableTerminalDetail, retainedTerminal, sameTerminal, validatedTerminal } from './identity.js';
import { sourceReadFailureDisposition } from '../source-read.js';
import { readAcceptedTerminal } from './source.js';
import {
  jobRetentionCutoff,
  resolveJobRetentionMs,
  terminalEligibility,
  type TerminalEligibility,
} from '../export-retention.js';
import type { RetentionRunBudget } from '../../store/retention-outcome.js';

export function resultPathFor(jobsRoot: string, jobId: string, execution: number): string {
  return join(jobsRoot, jobId, 'executions', String(execution), 'result.md');
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

  if (event.type === 'job.execution.outcome.accepted') {
    const parsed = jobExecutionOutcomeAcceptedBodySchema.safeParse(body);
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
  const opened = db.prepare<[string], EventsRow>(
    "SELECT * FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.opened' ORDER BY seq LIMIT 1",
  ).get(jobId);
  if (!opened) return '';
  const refs: unknown = opened.refs ? JSON.parse(opened.refs) : null;
  if (!isRecord(refs) || typeof refs.parentJobId !== 'string') return '';
  return `> Parent workflow: ${refs.parentJobId}\n> Workflow slot: ${refs.workflowSlotId}\n\n`;
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

/** `pending` is every state a write owner will still retry; `failed` is one nothing will retry. */
export type ResultAvailability =
  | Readonly<{ kind: 'available'; resultPath: string }>
  | Readonly<{ kind: 'retained-away'; retentionDays: number }>
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'failed'; reason: string }>;

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
  private readonly unrenderable = new RepairSet();
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
    location(jobId: string, observation?: RecoveryObservation): JobLocation | null;
    withSource<T>(
      jobId: string,
      read: (db: Database, ctx: StoreReadContext) => T,
      location?: JobLocation | null,
    ): T | null;
    workflowReport?: WorkflowReportPort;
    failures?: Set<string>;
    repairScope?: object;
    repairQueueLimit?: number;
    prepareTerminal?(jobId: string, db: Database): void;
    hydrationRetry?(jobId: string): boolean | undefined;
    readTerminalInput?(db: Database, jobId: string, execution?: number): DecodedResultArtifact | null | undefined;
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

  private withSource<T>(
    jobId: string,
    read: (db: Database, ctx: StoreReadContext) => T,
    observation?: RecoveryObservation,
  ): T | null {
    return this.sourceSession
      ? read(this.sourceSession.db, this.sourceSession.ctx)
      : this.input.withSource(jobId, (db, ctx) =>
          read(observation === undefined ? db : observeDatabaseReads(db, observation, 'result-repair'), ctx),
        );
  }

  private readTerminal(jobId: string, db: Database, execution?: number): DecodedResultArtifact | null {
    const retained = this.input.readTerminalInput?.(db, jobId, execution);
    if (retained !== undefined) return retained;
    const accepted = readAcceptedTerminal(db, jobId, execution);
    if (accepted === null) return null;
    const end = jobExecutionEndedBodySchema.parse(JSON.parse(Buffer.from(accepted.body).toString('utf8')));
    const outcome = db.prepare<[number], EventsRow>('SELECT * FROM events WHERE seq = ?').get(end.causeRef.seq);
    if (outcome === undefined || outcome.type !== 'job.execution.outcome.accepted' || outcome.stream_id !== jobId || outcome.stream_kind !== 'job')
      throw new Error('Execution result has no accepted outcome.');
    const body = jobExecutionOutcomeAcceptedBodySchema.parse(JSON.parse(Buffer.from(outcome.body).toString('utf8')));
    if (body.execution !== end.execution) throw new Error('Execution result cites another execution.');
    return { accepted, terminal: body.terminal, markdown: null, age: 'unknown' };
  }

  private location(jobId: string, execution?: number, observation?: RecoveryObservation): JobLocation | null {
    const location = this.input.location(jobId, observation);
    if (location === null || location.executions === undefined) return execution === undefined ? location : null;
    const selected = execution ?? location.latestExecution;
    const entry = location.executions.find(entry => entry.execution === selected);
    if (entry === undefined || location.detail.kind === 'unreadable' ||
      validatedTerminal(entry.detail, jobId, location.epochKey, entry.seq, entry) === null) return null;
    return { ...location, disposition: 'terminal', terminalSeq: entry.seq, resultPath: entry.resultPath,
      latestExecution: entry.execution, detail: { kind: 'recorded', value: entry.detail } };
  }

  private workKey(jobId: string, execution?: number): string { return execution === undefined ? jobId : `${jobId}:${execution}`; }

  private eligibility(
    jobId: string,
    location = this.input.location(jobId),
    observation?: RecoveryObservation,
  ): TerminalEligibility {
    if (this.input.readTerminalInput !== undefined) {
      let observed: DecodedResultArtifact | null | undefined;
      try {
        observed = this.withSource(jobId, (db) => this.input.readTerminalInput?.(db, jobId, location?.latestExecution), observation);
      } catch (error) {
        return {
          source: sourceReadFailureDisposition(error) === 'transient-unknown' ? 'transient' : 'unusable',
          age: 'unknown',
        };
      }
      if (observed !== undefined) {
        if (observed === null) return { source: 'absent', age: 'unknown' };
        const terminal = location === null ? null : retainedTerminal(location);
        if (terminal === null || terminal.seq !== observed.accepted.seq || terminal.ts !== observed.accepted.ts)
          return { source: 'unusable', age: 'unknown' };
        return {
          source: 'readable',
          age:
            typeof observed.age !== 'number'
              ? 'unknown'
              : observed.age < jobRetentionCutoff(this.input.runtime)
                ? 'expired'
                : 'inside',
        };
      }
    }
    return terminalEligibility(
      this.input.runtime,
      location,
      (read) => this.withSource(jobId, (db) => read(db), observation),
      this.publicationTerminal?.accepted,
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

  /** Reads, in one source session, the accepted terminal only when it agrees with the terminal its location retains. */
  private withAgreedTerminal<T>(
    jobId: string,
    location: JobLocation,
    read: (db: Database, ctx: StoreReadContext, accepted: EventsRow, terminal: JobTerminal) => T,
  ): T | null {
    if (!hasReadableTerminalDetail(location)) return null;
    return this.withSource(jobId, (db, ctx) => {
      const source = this.publicationTerminal ?? this.readTerminal(jobId, db, location.latestExecution);
      if (source === null || source.accepted.seq !== location.terminalSeq) return null;
      const accepted = source.accepted;
      const body = { terminal: source.terminal };
      if (
        location.detail.kind !== 'recorded' ||
        !location.detail.value.exit ||
        !sameTerminal(body.terminal, location.detail.value.exit)
      )
        return null;
      return read(db, ctx, accepted, body.terminal);
    });
  }

  private render(jobId: string, location: JobLocation): string | null {
    return this.withAgreedTerminal(jobId, location, (db, ctx, accepted, terminal) => {
      const supplied = this.input.readTerminalInput?.(db, jobId, location.latestExecution);
      if (supplied !== undefined) return supplied?.markdown ?? null;
      if (location.subject.jobKind === 'workflow')
        return this.input.workflowReport?.({ db, epochKey: location.epochKey, jobId, accepted, terminal }) ?? null;
      const identity = workflowIdentityMarkdown(db, jobId);
      const content = terminal.content.trimEnd();
      return `${identity}${content || describeTerminalOutcome(terminal.outcome, { describeCauseRef: (ref) => describeResolvedCauseRef(db, ctx, ref) })}\n`;
    });
  }

  /** Availability is observed, never repaired: it checks the file and the job's own source, and writes nothing. */
  observeResultAvailability(jobId: string, observation?: RecoveryObservation, execution?: number): ResultAvailability {
    const location = this.location(jobId, execution, observation);
    if (!location || !hasReadableTerminalDetail(location))
      return this.uncaptured.has(jobId) && this.input.hydrationRetry?.(jobId) !== true
        ? {
            kind: 'failed',
            reason:
              'the terminal could not be recorded in its job location; location recovery records it again at the next coordinator start',
          }
        : { kind: 'pending' };
    const resultPath = location.resultPath ?? resultPathFor(this.input.jobsRoot, jobId, location?.latestExecution ?? 1);
    if (this.readableFile(resultPath)) return { kind: 'available', resultPath };
    const retentionDays = resolveJobRetentionMs(this.input.runtime.env.get('CORAL_JOBS_RETENTION_DAYS')) / 86_400_000;
    const eligibility = this.eligibility(jobId, location, observation);
    switch (eligibility.source) {
      case 'transient':
        return { kind: 'pending' };
      case 'unusable':
        return { kind: 'failed', reason: 'the retained terminal does not match its source journal' };
      case 'absent':
        // A retired source leaves the retained terminal's own timestamp, which may choose this label but never deletes.
        return Date.parse(retainedTerminal(location)?.ts ?? '') < jobRetentionCutoff(this.input.runtime)
          ? { kind: 'retained-away', retentionDays }
          : { kind: 'failed', reason: 'the source journal is no longer retained' };
      case 'readable':
        if (eligibility.age === 'expired') return { kind: 'retained-away', retentionDays };
        return this.unrenderable.has(jobId)
          ? { kind: 'failed', reason: 'the source facts needed to write the result file are unavailable' }
          : { kind: 'pending' };
    }
  }

  /** Callers supply identity; all publication bytes come from the accepted source terminal. */
  publishTerminalResult(jobId: string, execution?: number): string {
    return this.publish(jobId, false, undefined, execution);
  }

  ensureResultMarkdownArtifact(jobId: string, observation?: RecoveryObservation, execution?: number): string {
    return this.publish(jobId, true, observation, execution);
  }

  private publish(jobId: string, repair: boolean, observation?: RecoveryObservation, execution?: number): string {
    const location = this.location(jobId, execution, observation);
    const stored = this.input.location(jobId, observation);
    const entry = location === null ? undefined : stored?.executions?.find(entry => entry.execution === (execution ?? stored.latestExecution));
    const workKey = this.workKey(jobId, execution ?? stored?.latestExecution);
    if (entry !== undefined) {
      if (this.readableFile(entry.resultPath)) { this.failures.delete(workKey); return entry.resultPath; }
      try {
        const age = this.withSource(jobId, db => this.readTerminal(jobId, db, entry.execution)?.age);
        repairRetainedExecution(this.input.runtime, entry, () => {
          const current = this.input.location(jobId);
          return current?.epochKey === stored?.epochKey && current?.executions?.some(
            known => known.execution === entry.execution && known.seq === entry.seq,
          ) === true;
        }, age ?? undefined);
        if (this.readableFile(entry.resultPath)) this.failures.delete(workKey);
        return entry.resultPath;
      } catch (error) {
        this.failures.add(workKey);
        this.hintRepair(jobId, entry.execution);
        throw error;
      }
    }
    const targetPath = location?.resultPath ?? resultPathFor(this.input.jobsRoot, jobId, execution ?? stored?.latestExecution ?? 1);
    if (location && hasReadableTerminalDetail(location) && this.readableFile(targetPath)) {
      this.failures.delete(jobId);
      return targetPath;
    }
    try {
      return (
        this.input.withSource(
          jobId,
          (db, ctx) => {
            const observedDb = observation === undefined ? db : observeDatabaseReads(db, observation, 'result-repair');
            this.sourceSession = { db: observedDb, ctx };
            try {
              return this.publishInSource(jobId, repair, observedDb, location, execution);
            } finally {
              this.sourceSession = undefined;
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

  private publishInSource(jobId: string, repair: boolean, db: Database, retained: JobLocation | null, execution?: number): string {
    const recorded = retained !== null && hasReadableTerminalDetail(retained);
    if (!recorded) this.input.prepareTerminal?.(jobId, db);
    const location = recorded ? retained : this.location(jobId, execution);
    const targetPath = location?.resultPath ?? resultPathFor(this.input.jobsRoot, jobId, execution ?? this.input.location(jobId)?.latestExecution ?? 1);
    if (this.readableFile(targetPath)) {
      this.failures.delete(jobId);
      return targetPath;
    }
    const source = this.readTerminal(jobId, db, location?.latestExecution ?? execution);
    if (source === null) return targetPath;
    const accepted = source.accepted;
    if (!location || !hasReadableTerminalDetail(location)) {
      this.uncaptured.add(jobId);
      return targetPath;
    }
    this.publicationTerminal = { accepted, terminal: source.terminal };
    // An expired terminal is retained away: no write owner recreates its file.
    const eligibility = this.eligibility(jobId, location);
    if (eligibility.source !== 'readable' || eligibility.age === 'expired') {
      if (eligibility.source === 'transient') this.hintRepair(jobId);
      return targetPath;
    }
    const markdown = this.render(jobId, location);
    if (!markdown) {
      this.unrenderable.add(jobId);
      return targetPath;
    }
    const authorized = (): boolean => {
      const current = this.eligibility(jobId, location);
      return current.source === 'readable' && current.age !== 'expired';
    };
    writeResultArtifact(this.input.runtime.storage, targetPath, markdown, authorized, this.input.jobsRoot);
    if (this.readableFile(targetPath)) {
      this.failures.delete(jobId);
      this.unrenderable.delete(jobId);
    } else if (repair && this.ownsRepairSchedule) this.hints.add(jobId);
    else this.hintRepair(jobId);
    return targetPath;
  }

  hintRepair(jobId: string, execution?: number): void {
    jobId = this.workKey(jobId, execution);
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
      const separator = jobId.lastIndexOf(':');
      const ordinal = Number(jobId.slice(separator + 1));
      if (separator >= 0 && Number.isSafeInteger(ordinal) && ordinal > 0) {
        await this.repairCandidate(jobId.slice(0, separator), budget, ordinal);
      } else {
        const entries = this.input.location(jobId)?.executions;
        if (entries === undefined) await this.repairCandidate(jobId, budget);
        else for (const entry of entries) {
          if (!budget.canContinue()) { this.hintRepair(jobId, entry.execution); continue; }
          await this.repairCandidate(jobId, budget, entry.execution);
        }
      }
    }
    budget.record({ kind: 'kept', subject: 'result-repair', reason: 'scan-pending' });
  }

  private async repairCandidate(jobId: string, budget: RetentionRunBudget, execution?: number): Promise<void> {
    budget.observation?.record('result-repair', { subjects: 1 });
    try {
      if (this.observeResultAvailability(jobId, budget.observation, execution).kind !== 'pending') return;
      if (budget.canMutate?.() !== false) this.ensureResultMarkdownArtifact(jobId, budget.observation, execution);
      // A job with no recorded terminal has no artifact to keep on the repair backlog.
      if (
        this.input.location(jobId)?.disposition === 'terminal' &&
        this.observeResultAvailability(jobId, budget.observation, execution).kind === 'pending'
      )
        budget.record({ kind: 'kept', subject: jobId, reason: 'repair-pending' });
    } catch (error) {
      budget.record({ kind: 'failed', subject: jobId, reason: errorMessage(error) });
    }
    await setImmediate();
  }
}

export function observeTerminalResultExports(
  ensureResultArtifact: (jobId: string, execution: number) => string,
  recordTerminal?: (jobId: string, seq: number, execution: number) => void,
): PostCommitObserver {
  return (appended: readonly AppendedEvent[]): void => {
    for (const event of appended) {
      if (event.stream.kind !== 'job' || event.type !== 'job.execution.ended') {
        continue;
      }
      const { execution } = jobExecutionEndedBodySchema.parse(event.body);
      try {
        recordTerminal?.(event.stream.id, event.seq, execution);
      } catch (error: unknown) {
        backendLog.warn(`Recording terminal location failed for ${event.stream.id}: ${errorMessage(error)}`);
      }
      try {
        ensureResultArtifact(event.stream.id, execution);
      } catch (error: unknown) {
        backendLog.warn(`Writing terminal export failed for ${event.stream.id}: ${errorMessage(error)}`);
      }
    }
  };
}
