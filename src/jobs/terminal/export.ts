import { dirname, join } from 'node:path';

import type { Database } from '../../store/db.js';
import type { AppendedEvent, PostCommitObserver } from '../../store/append.js';

import type { StoragePort } from '../../infra/port-types.js';
import { type StoreReadContext } from '../../store/body-codec.js';
import { getEvent } from '../../store/event-queries.js';
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
import { hasReadableTerminalDetail, type JobLocation } from '../location-index.js';
import { sameTerminal } from './identity.js';
import { readAcceptedTerminal } from './source.js';
import { terminalEligibility, type TerminalEligibility } from '../export-retention.js';
import { resolveJobRetentionMs } from '../retention-clock.js';
import type { RetentionRunBudget } from '../../store/retention-outcome.js';

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

  const event = getEvent(db, ref.stream, ref.seq, ctx);
  if (!event) {
    return null;
  }

  const localDescription = describeKnownEvent(event);
  const nextRef = extractCauseRef(event.body);
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
    }>;

export class TerminalResultExportOwner {
  private readonly failures: Set<string>;
  private readonly hints = new Set<string>();
  private hintListener: (() => void) | null = null;

  private readonly input: Readonly<{
    runtime: Pick<Runtime, 'storage' | 'paths' | 'time' | 'env'>;
    jobsRoot: string;
    location(jobId: string): JobLocation | null;
    withSource<T>(jobId: string, read: (db: Database, ctx: StoreReadContext) => T): T | null;
    workflowReport?: WorkflowReportPort;
    failures?: Set<string>;
    prepareTerminal?(jobId: string): void;
  }>;

  constructor(input: TerminalResultExportOwner['input']) {
    this.input = input;
    this.failures = input.failures ?? new Set<string>();
  }

  private eligibility(jobId: string): TerminalEligibility {
    return terminalEligibility(this.input.runtime, this.input.location(jobId), (read) =>
      this.input.withSource(jobId, (db) => read(db)),
    );
  }

  private available(jobId: string): boolean {
    const location = this.input.location(jobId);
    if (!location || !hasReadableTerminalDetail(location) || location.resultPath === undefined) return false;
    try {
      const file = this.input.runtime.storage.lstatSync(location.resultPath, { bigint: true });
      return file.isFile() && file.size > 0n;
    } catch {
      return false;
    }
  }

  private render(jobId: string): string | null {
    const location = this.input.location(jobId);
    if (!location || !hasReadableTerminalDetail(location)) return null;
    return this.input.withSource(jobId, (db, ctx) => {
      const accepted = readAcceptedTerminal(db, jobId);
      if (!accepted || accepted.seq !== location.terminalSeq) return null;
      const body = jobTerminalRecordedBodySchema.parse(JSON.parse(Buffer.from(accepted.body).toString('utf8')));
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

  /** Availability observation never synchronizes or repairs storage. */
  progressRetentionExpired(jobId: string): boolean {
    return this.eligibility(jobId).kind === 'expired';
  }

  observeResultAvailability(jobId: string): ResultAvailability {
    const location = this.input.location(jobId);
    if (!location || !hasReadableTerminalDetail(location))
      return { kind: 'failed', cause: 'terminal-unusable', retryScheduled: false };
    if (this.available(jobId))
      return { kind: 'available', resultPath: location.resultPath ?? resultPathFor(this.input.jobsRoot, jobId) };
    const eligibility = this.eligibility(jobId);
    if (!eligibility.cutoffTrusted) return { kind: 'failed', cause: 'cutoff-untrusted', retryScheduled: true };
    if (eligibility.kind === 'expired')
      return {
        kind: 'retained-away',
        retentionDays: resolveJobRetentionMs(this.input.runtime.env.get('CORAL_JOBS_RETENTION_DAYS')) / 86_400_000,
      };
    if (eligibility.age === 'unknown')
      return { kind: 'failed', cause: 'terminal-age-unknown', retryScheduled: false, ageUncertain: true };
    if (!eligibility.sourceReadable)
      return {
        kind: 'failed',
        cause: 'source-epoch-retired',
        retryScheduled: false,
        ageUncertain: eligibility.age === 'regression',
      };
    if (!eligibility.publicationAuthorized)
      return { kind: 'failed', cause: 'terminal-clock-regression', retryScheduled: false, ageUncertain: true };
    try {
      if (this.render(jobId) === null)
        return { kind: 'failed', cause: 'workflow-facts-unavailable', retryScheduled: false };
    } catch {
      return { kind: 'failed', cause: 'workflow-facts-unavailable', retryScheduled: false };
    }
    if (this.failures.has(jobId))
      return {
        kind: 'failed',
        cause: 'repair-failed',
        retryScheduled: true,
        ageUncertain: eligibility.age === 'regression',
      };
    return { kind: 'repair-pending', ageUncertain: eligibility.age === 'regression' };
  }

  /** Callers supply identity; all publication bytes come from the accepted source terminal. */
  publishTerminalResult(jobId: string): string {
    return this.publish(jobId, false);
  }

  ensureResultMarkdownArtifact(jobId: string): string {
    return this.publish(jobId, true);
  }

  private publish(jobId: string, repair: boolean): string {
    this.input.prepareTerminal?.(jobId);
    const targetPath = this.input.location(jobId)?.resultPath ?? resultPathFor(this.input.jobsRoot, jobId);
    if (this.available(jobId)) return targetPath;
    const availability = this.observeResultAvailability(jobId);
    if (
      availability.kind !== 'repair-pending' &&
      !(availability.kind === 'failed' && availability.retryScheduled && availability.cause === 'repair-failed')
    )
      return targetPath;
    try {
      this.input.withSource(jobId, () => {
        const markdown = this.render(jobId);
        if (!markdown || !this.eligibility(jobId).publicationAuthorized || (repair && this.available(jobId))) return;
        writeResultArtifact(this.input.runtime.storage, targetPath, markdown, () => {
          return (
            this.eligibility(jobId).publicationAuthorized &&
            this.render(jobId) === markdown &&
            !(repair && this.available(jobId))
          );
        });
      });
      this.failures.delete(jobId);
    } catch (error) {
      this.failures.add(jobId);
      throw error;
    }
    return targetPath;
  }

  hintRepair(jobId: string): void {
    if (this.hints.has(jobId)) return;
    this.hints.add(jobId);
    this.hintListener?.();
  }

  onRepairHint(listener: (() => void) | null): void {
    this.hintListener = listener;
  }

  async repairPass(jobIds: readonly string[], budget: RetentionRunBudget): Promise<void> {
    const ids = new Set([...this.hints, ...jobIds]);
    for (const jobId of ids) {
      if (!budget.canContinue()) break;
      this.hints.delete(jobId);
      const state = this.observeResultAvailability(jobId);
      if (state.kind !== 'repair-pending' && !(state.kind === 'failed' && state.retryScheduled)) continue;
      try {
        if (budget.canMutate?.() !== false) this.ensureResultMarkdownArtifact(jobId);
      } catch (error) {
        budget.record({ kind: 'failed', subject: jobId, reason: errorMessage(error) });
      }
      await setImmediate();
    }
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
  if (!storage.writeAtomicDurableSync(targetPath, markdown, { encoding: 'utf-8', beforeRename })) {
    if (!beforeRename()) return;
    throw new Error(`Failed to write result artifact: ${targetPath}`);
  }
  if (!storage.syncDirectoryDurableSync(jobsRoot) || !storage.syncDirectoryDurableSync(dirname(jobsRoot)))
    throw new Error(`Failed to sync result artifact: ${targetPath}`);
}

export function observeTerminalResultExports(
  ensureResultArtifact: (jobId: string) => string,
  recordTerminal?: (jobId: string, seq: number) => void,
): PostCommitObserver {
  return (appended: readonly AppendedEvent[]): void => {
    for (const event of appended) {
      if (event.stream.kind !== 'job' || event.type !== 'job.terminal.recorded') {
        continue;
      }
      try {
        recordTerminal?.(event.stream.id, event.seq);
        ensureResultArtifact(event.stream.id);
      } catch (error: unknown) {
        backendLog.warn(`Writing terminal export failed for ${event.stream.id}: ${errorMessage(error)}`);
      }
    }
  };
}
