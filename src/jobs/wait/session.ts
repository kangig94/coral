import assert from 'node:assert/strict';
import { epochIdentity, sameEpoch } from '../../store/epoch/identity.js';
import { isCodeDefect, sourceReadFailureDisposition, type SourceReadDisposition } from '../source-read.js';
import type { JobDetailResponse, JobTerminal } from '../records.js';
import type { JobProgressTiming } from '../event-bodies.js';
import type { ContinuitySnapshot } from '../../sessions/continuity.js';
import type { ResultAvailability } from '../terminal/export.js';
import {
  WAIT_PROGRESS_BYTES,
  WAIT_PROGRESS_LINES,
  type ProgressSource,
  type ProgressVisit,
  type WaitCursor,
  type WaitProgressRow,
  type WaitStreamEvent,
} from './contract.js';
import { decodeWaitCursor, encodeWaitCursor } from './cursor.js';

/** `unknown` is retryable and stays in the continuation; `unreadable` is permanent and carries its reason. */
export type WaitDisposition = 'admitted' | 'missing' | 'scope-mismatch' | 'unknown' | 'unreadable';

export type WaitAdmission = {
  jobId: string;
  disposition: WaitDisposition;
  message?: string;
  epochKey?: string;
  /** Admitted from a store epoch other than the active one: its terminal is delivered and its progress is not read. */
  historical?: boolean;
  detail?: Omit<JobDetailResponse, 'events'> & { terminalSeq?: number };
  availability?: ResultAvailability;
  continuity?: ContinuitySnapshot | null;
  observationDeferred?: boolean;
  queued?: Extract<WaitStreamEvent, { type: 'queued' }>;
};

/** An active-journal read that failed is uncertainty about that one job: decode failures settle it, others retry. */
export function activeJournalReadFailure(jobId: string, epochKey: string, error: unknown): WaitAdmission {
  if (isCodeDefect(error)) throw error;
  return sourceReadFailureDisposition(error) === 'settled-unreadable'
    ? {
        jobId,
        disposition: 'unreadable',
        epochKey,
        message: "This build cannot decode this job's records in the active journal; no later read changes that",
      }
    : {
        jobId,
        disposition: 'unknown',
        epochKey,
        message: 'The active journal cannot be read right now; this wait reads it again on its next poll',
      };
}

/** One progress row as it is delivered, with the lines and bytes it spends from the budget. */
export type WaitSelectedRow = Readonly<{
  jobId: string;
  seq: number;
  message: string;
  lines: number;
  bytes: number;
  timing: JobProgressTiming;
}>;
export type WaitSelection = Readonly<{
  rows: readonly WaitSelectedRow[];
  /** The last row each read job consumed, faults included, and whether its read reached the job's newest row. */
  reached: ReadonlyMap<string, Readonly<{ seq: number; exhausted: boolean }>>;
  /** The budget stopped the selection before every readable row was taken. */
  full: boolean;
}>;
export type WaitBudget = Readonly<{ lines: number; bytes: number }>;
export type WaitTerminalSummary = {
  seq: number;
  outcomeKind: JobTerminal['outcome']['kind'];
  exitCode: number;
  durationMs: number;
  contentPreview: string;
  contentOmitted: boolean;
  diagnosticPreview: string;
  diagnosticOmitted: boolean;
};
export type WaitSnapshotJob = {
  jobId: string;
  disposition: WaitDisposition;
  message?: string;
  phase?: string;
  progress: string[];
  terminal?: WaitTerminalSummary;
  availability?: ResultAvailability;
};
export type WaitSnapshot = {
  jobs: WaitSnapshotJob[];
  notices: string[];
  cursor: WaitCursor | null;
  remainingJobIds: string[];
  exitCode: number;
};

export class WaitSessionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function waitTerminalExitCode(result: JobTerminal): number {
  switch (result.outcome.kind) {
    case 'completed':
      return 0;
    case 'provider_exit':
      return Number.isInteger(result.outcome.code) && result.outcome.code >= 0 && result.outcome.code <= 255
        ? result.outcome.code
        : 1;
    default:
      return 1;
  }
}

type ProgressState = 'exhausted' | 'unread' | 'unknown' | 'lost' | 'refused';
/**
 * `seq` is the position the job is consumed through: each of its rows at or below it was delivered or skipped by a
 * first-read tail. A job no cursor positioned has none yet, so its first readable visit reads its newest rows.
 */
type Member = { seq: number | undefined; progress: ProgressState; delivered: boolean; awaitingArtifact: boolean };

/** A first read that cannot give each job this many bytes waits for a fresh budget instead of shortening to nothing. */
const MIN_SHARE_BYTES = 128;
const MAX_PAGE_ROWS = 500;
const MARKER_ROOM = 96;

export class WaitSession {
  admissions: WaitAdmission[] = [];
  readonly notices: string[] = [];
  private readonly members = new Map<string, Member>();
  private readonly coverage = new Map<string, { kind: 'live' | 'absent' | 'unknown'; frontier: number }>();

  readonly jobIds: readonly string[];
  readonly input?: WaitCursor;
  private readonly internal: boolean;
  private readonly activeEpochKey: string;
  /** The request's watermark: every requested active-epoch row at or below it was delivered by an earlier read. */
  private readonly base: number | undefined;
  constructor(jobIds: readonly string[], input: WaitCursor | undefined, activeEpochKey: string, internal = false) {
    this.jobIds = jobIds;
    this.input = input;
    this.internal = internal;
    this.activeEpochKey = activeEpochKey;
    const decoded = input === undefined ? undefined : decodeWaitCursor(input);
    assert(decoded?.kind !== 'rejected', 'a wait cursor is decoded where it enters the coordinator');
    this.base = decoded?.watermark;
  }

  reconcile(admissions: WaitAdmission[]): void {
    const previous = new Map(this.admissions.map((job) => [job.jobId, job]));
    this.admissions = admissions.map((observed) =>
      observed.observationDeferred ? (previous.get(observed.jobId) ?? observed) : observed,
    );
    for (const job of this.admissions) {
      let member = this.members.get(job.jobId);
      if (!member) {
        member = { seq: this.base, progress: 'unknown', delivered: false, awaitingArtifact: false };
        this.members.set(job.jobId, member);
      }
      if (job.disposition !== 'admitted') {
        member.progress = job.disposition === 'unknown' ? 'unknown' : 'refused';
        continue;
      }
      if (job.historical) {
        member.progress = 'exhausted';
        this.notice(`Progress from a previous store epoch is not shown for ${job.jobId}.`);
      } else member.progress = 'unread';
      if (!job.detail?.exit && !this.coverage.has(job.jobId))
        this.coverage.set(job.jobId, { kind: 'unknown', frontier: 0 });
    }
  }

  private member(jobId: string): Member {
    const member = this.members.get(jobId);
    assert(member);
    return member;
  }

  private notice(message: string): void {
    if (!this.notices.includes(message)) this.notices.push(message);
  }

  private readable(job: WaitAdmission): job is WaitAdmission & { epochKey: string } {
    return (
      job.disposition === 'admitted' &&
      !job.historical &&
      job.epochKey !== undefined &&
      this.member(job.jobId).progress === 'unread'
    );
  }

  /** Each source is opened and classified once; selection then runs outside every source's error scope. */
  withProgress<T>(visit: ProgressVisit, read: (sources: ReadonlyMap<string, ProgressSource>) => T): T {
    const epochs = new Map<string, string>();
    for (const job of this.admissions) if (this.readable(job)) epochs.set(epochIdentity(job.epochKey), job.epochKey);
    const order = [...epochs];
    const sources = new Map<string, ProgressSource>();
    const open = (index: number): T => {
      const next = order[index];
      if (next === undefined) return read(sources);
      const [identity, epochKey] = next;
      const result = visit(epochKey, (source) => {
        sources.set(identity, source);
        return open(index + 1);
      });
      if (result.kind === 'read') return result.value;
      for (const job of this.admissions)
        if (this.readable(job) && epochIdentity(job.epochKey) === identity)
          this.markUnreadable(job.jobId, result.disposition, result.reason);
      return open(index + 1);
    };
    return open(0);
  }

  private markUnreadable(
    jobId: string,
    disposition: Exclude<SourceReadDisposition, 'readable'>,
    reason: string | undefined,
  ): void {
    const member = this.member(jobId);
    member.progress = disposition === 'transient-unknown' ? 'unknown' : 'lost';
    if (disposition === 'retired') this.notice(`Earlier progress for ${jobId} is no longer kept: source retired.`);
    else
      this.notice(
        `Earlier progress for ${jobId} ${member.progress === 'unknown' ? 'is held' : 'cannot be read by this build'}${reason ? `: ${reason}` : '.'}`,
      );
  }

  /** A failed page read is evidence about that job alone: decode failures settle its progress, others hold it. */
  private readRows<T>(jobId: string, read: () => T): T | null {
    try {
      return read();
    } catch (error) {
      if (error instanceof WaitSessionError || isCodeDefect(error)) throw error;
      const disposition = sourceReadFailureDisposition(error);
      this.markUnreadable(
        jobId,
        disposition,
        disposition === 'transient-unknown'
          ? 'source cannot be read right now; this read is retried on the next poll'
          : 'a progress row cannot be decoded by this build',
      );
      return null;
    }
  }

  /**
   * A job's first readable visit reads its newest rows, `tail` lines at most, within its share of the budget; with no
   * `tail` it reads from its origin instead. Every later read takes the rows after its seq, oldest first across jobs,
   * and the budget cuts only between rows. A budget nothing has been spent from always admits one row, shortened.
   * Each read job is then consumed through the journal frontier when nothing of it below that frontier is left, and
   * otherwise through the last row the cut leaves behind it.
   */
  select(sources: ReadonlyMap<string, ProgressSource>, budget: WaitBudget, tail: number | null): WaitSelection {
    const readable = this.admissions.filter(
      (job): job is WaitAdmission & { epochKey: string } =>
        this.readable(job) && sources.has(epochIdentity(job.epochKey)),
    );
    const source = (job: WaitAdmission & { epochKey: string }): ProgressSource =>
      sources.get(epochIdentity(job.epochKey)) as ProgressSource;
    // Read after the job's rows within one visit, so a job whose page ran out has no unread row at or below it.
    const frontier = (job: WaitAdmission & { epochKey: string }): number | null =>
      this.readRows(job.jobId, () => source(job).frontier());
    const rows: WaitSelectedRow[] = [];
    const reached = new Map<string, { seq: number; exhausted: boolean }>();
    const fresh = budget.lines === WAIT_PROGRESS_LINES && budget.bytes === WAIT_PROGRESS_BYTES;
    let lines = budget.lines;
    let bytes = budget.bytes;
    let full = false;
    const spend = (row: WaitSelectedRow): void => {
      rows.push(row);
      lines -= row.lines;
      bytes -= row.bytes;
    };

    const unpositioned = tail === null ? [] : readable.filter((job) => this.member(job.jobId).seq === undefined);
    if (unpositioned.length > 0) {
      const lineShare = Math.floor(budget.lines / readable.length);
      const byteShare = Math.floor(budget.bytes / readable.length);
      const target = Math.min(tail ?? lineShare, lineShare);
      if (target < 1 || byteShare < MIN_SHARE_BYTES) full = true;
      else {
        const omitted: string[] = [];
        for (const job of unpositioned) {
          const newest = this.readRows(job.jobId, () => source(job).newest(job.jobId, target + 1));
          const through = newest === null ? null : frontier(job);
          if (newest === null || through === null) continue;
          const candidates = newest.slice(-target);
          const room = { lines: target, bytes: byteShare };
          const chosen: WaitSelectedRow[] = [];
          let index = candidates.length - 1;
          for (; index >= 0; index--) {
            const selected = this.fit(job.jobId, candidates[index], room, chosen.length === 0);
            if (selected === undefined) continue;
            if (selected === null) break;
            chosen.unshift(selected);
            room.lines -= selected.lines;
            room.bytes -= selected.bytes;
          }
          chosen.forEach(spend);
          if (index >= 0 || newest.length > target) omitted.push(job.jobId);
          reached.set(job.jobId, { seq: through, exhausted: true });
        }
        if (omitted.length > 0)
          this.notice(`Earlier progress for ${omitted.join(', ')} was not shown; showing the most recent lines.`);
      }
    }

    const later = readable.filter(
      (job) => !reached.has(job.jobId) && (tail === null || this.member(job.jobId).seq !== undefined),
    );
    if (later.length > 0 && lines <= 0) full = true;
    else if (later.length > 0) {
      const pageRows = Math.max(1, Math.min(MAX_PAGE_ROWS, Math.ceil(lines / later.length)));
      const order = new Map(later.map((job, index) => [job.jobId, index]));
      const pages = later
        .flatMap((job) => {
          const page = this.readRows(job.jobId, () =>
            source(job).after(job.jobId, this.member(job.jobId).seq ?? 0, pageRows),
          );
          return page === null ? [] : [{ job, page }];
        })
        .flatMap(({ job, page }) => {
          const through = frontier(job);
          return through === null ? [] : [{ jobId: job.jobId, page, through }];
        });
      const queue = pages
        .flatMap(({ jobId, page }) => page.map((row) => ({ jobId, row })))
        .sort((a, b) => a.row.seq - b.row.seq || (order.get(a.jobId) ?? 0) - (order.get(b.jobId) ?? 0));
      const walked = new Map<string, number>();
      // Rows are walked in seq order, so a job the cut stops inside has no unwalked row at or below the last walked one.
      let cut = 0;
      for (const { jobId, row } of queue) {
        const selected = this.fit(jobId, row, { lines, bytes }, fresh && rows.length === 0);
        if (selected === null) {
          full = true;
          break;
        }
        if (selected !== undefined) spend(selected);
        walked.set(jobId, (walked.get(jobId) ?? 0) + 1);
        cut = row.seq;
      }
      for (const { jobId, page, through } of pages) {
        const exhausted = page.length < pageRows && (walked.get(jobId) ?? 0) === page.length;
        const seq = exhausted
          ? through
          : (walked.get(jobId) ?? 0) === page.length
            ? (page.at(-1)?.seq ?? 0)
            : Math.max(this.member(jobId).seq ?? 0, cut);
        reached.set(jobId, { seq, exhausted });
      }
    }
    return { rows, reached, full };
  }

  /** A fault row is skipped (undefined); a row the room cannot hold is refused (null) unless it is forced in, shortened. */
  private fit(
    jobId: string,
    row: WaitProgressRow,
    room: WaitBudget,
    force: boolean,
  ): WaitSelectedRow | null | undefined {
    if (row.message === undefined || row.timing === undefined) return undefined;
    let shown = splitWaitProgress(row.message).map((line) => shortenWaitLine(line));
    let size = byteLength(shown);
    if (shown.length > room.lines || size > room.bytes) {
      if (!force) return null;
      if (!this.internal) {
        shown = fitWaitEvent(shown, room.lines, room.bytes);
        size = byteLength(shown);
      }
    }
    return {
      jobId,
      seq: row.seq,
      message: this.internal ? row.message : shown.join('\n'),
      lines: shown.length,
      bytes: size,
      timing: row.timing,
    };
  }

  /** Applies a selection once every row it selected was delivered: each read job moves to the last row it consumed. */
  commit(selection: WaitSelection): void {
    for (const [jobId, reached] of selection.reached) {
      const member = this.member(jobId);
      member.seq = Math.max(member.seq ?? 0, reached.seq);
      if (member.progress === 'unread' && reached.exhausted) member.progress = 'exhausted';
    }
  }

  hasProgress(): boolean {
    return this.admissions.some(
      (job) => job.disposition === 'admitted' && this.member(job.jobId).progress === 'unread',
    );
  }
  progressState(jobId: string): ProgressState {
    return this.members.get(jobId)?.progress ?? 'unknown';
  }
  private terminalSeq(job: WaitAdmission): number {
    return job.detail?.terminalSeq ?? job.detail?.status.lastSeq ?? 0;
  }
  /** A terminal follows every progress row of its job that can still be read, so nothing it reads follows the outcome. */
  terminalDeliverable(job: WaitAdmission): boolean {
    const progress = this.progressState(job.jobId);
    return (
      job.disposition === 'admitted' && Boolean(job.detail?.exit) && progress !== 'unread' && progress !== 'unknown'
    );
  }
  /**
   * How printing a deliverable terminal now would count. Only a terminal above the request's watermark, or one from a
   * historical epoch, is new and ends the read; any other is a repeat that ends nothing, and once printed it ends the
   * read only if it was printed with a pending artifact that has since settled.
   */
  terminalDelivery(job: WaitAdmission): 'final' | 'repeat' | null {
    const member = this.member(job.jobId);
    if (member.delivered) return member.awaitingArtifact && !this.artifactPending(job) ? 'final' : null;
    return job.historical === true || this.base === undefined || this.terminalSeq(job) > this.base ? 'final' : 'repeat';
  }
  deliverTerminal(job: WaitAdmission): void {
    const member = this.member(job.jobId);
    member.awaitingArtifact = this.terminalDelivery(job) === 'repeat' && this.artifactPending(job);
    member.delivered = true;
  }
  /** A delivered job stays in the continuation while its artifact is still pending. */
  artifactPending(job: WaitAdmission): boolean {
    return !this.internal && !job.historical && job.availability?.kind === 'pending';
  }
  unknown(jobId: string): boolean {
    return this.progressState(jobId) === 'unknown';
  }
  remaining(): string[] {
    return this.admissions
      .filter(
        (job) =>
          job.disposition === 'unknown' ||
          (job.disposition === 'admitted' &&
            (!job.detail?.exit || !this.member(job.jobId).delivered || this.artifactPending(job))),
      )
      .map((job) => job.jobId);
  }
  exitCode(): number {
    for (const job of this.admissions)
      if (job.disposition === 'admitted' && job.detail?.exit && this.member(job.jobId).delivered) {
        const code = waitTerminalExitCode(job.detail.exit);
        if (code !== 0) return code;
      }
    if (this.admissions.some((job) => job.disposition !== 'admitted' && job.disposition !== 'unknown')) return 1;
    return this.remaining().length || this.unknownCarriers().length ? 75 : 0;
  }
  /** A job read from another epoch, or refused, never holds the active epoch's watermark back. */
  private holdsWatermark(job: WaitAdmission): boolean {
    if (job.disposition === 'admitted') return !job.historical;
    return (
      job.disposition === 'unknown' && (job.epochKey === undefined || sameEpoch(job.epochKey, this.activeEpochKey))
    );
  }
  /**
   * The minimum over the requested active-epoch jobs of how far each was consumed, a terminal not yet printed by this
   * read counting as an undelivered row. A job this read never positioned does not hold it back; every other job has
   * no undelivered row at or below it, so a resume repeats their rows at worst and loses none.
   */
  cursor(): WaitCursor | null {
    let watermark = Infinity;
    for (const job of this.admissions) {
      if (!this.holdsWatermark(job)) continue;
      const member = this.member(job.jobId);
      let consumed = member.progress === 'lost' ? Infinity : member.seq;
      if (consumed === undefined) continue;
      if (job.detail?.exit && !member.delivered) consumed = Math.min(consumed, this.terminalSeq(job) - 1);
      watermark = Math.min(watermark, consumed);
    }
    const seq = Number.isFinite(watermark) ? Math.max(0, watermark) : this.base;
    return seq === undefined ? null : encodeWaitCursor(seq);
  }
  observeCoverage(jobIds: readonly string[], unknownJobIds: readonly string[], frontier: number): void {
    for (const id of jobIds) this.coverage.set(id, { kind: unknownJobIds.includes(id) ? 'unknown' : 'live', frontier });
  }
  observeAbsent(jobId: string, frontier: number): void {
    this.coverage.set(jobId, { kind: 'absent', frontier });
  }
  carrierCoverage(): ReadonlyMap<string, { kind: 'live' | 'absent' | 'unknown'; frontier: number }> {
    return this.coverage;
  }
  unknownCarriers(): string[] {
    return this.admissions
      .filter(
        (job) =>
          job.disposition === 'admitted' &&
          !job.detail?.exit &&
          this.coverage.get(job.jobId)?.kind !== 'live' &&
          this.coverage.get(job.jobId)?.kind !== 'absent',
      )
      .map((job) => job.jobId)
      .sort();
  }
}

function byteLength(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
}

export function splitWaitProgress(message: string): string[] {
  const lines = message.split('\n');
  if (message.endsWith('\n')) lines.pop();
  return lines.length === 0 ? [''] : lines;
}

export function shortenWaitLine(line: string): string {
  const bytes = Buffer.byteLength(line);
  if (bytes <= 4096) return line;
  const buffer = Buffer.from(line);
  let end = 4000;
  while ((buffer[end] & 0xc0) === 0x80) end--;
  return `${buffer.subarray(0, end).toString('utf8')}[line shortened: ${bytes - end} bytes omitted]`;
}

/** A row larger than the budget keeps its leading lines; the last line it keeps says how many bytes were cut. */
function fitWaitEvent(lines: readonly string[], maxLines: number, maxBytes: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const [index, line] of lines.entries()) {
    const size = Buffer.byteLength(line);
    if (kept.length < maxLines - 1 && used + size + MARKER_ROOM <= maxBytes) {
      kept.push(line);
      used += size;
      continue;
    }
    const omitted = byteLength(lines.slice(index));
    const buffer = Buffer.from(line);
    let end = Math.max(0, Math.min(size, 4000, maxBytes - used - MARKER_ROOM));
    while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
    kept.push(`${buffer.subarray(0, end).toString('utf8')}[line shortened: ${omitted - end} bytes omitted]`);
    break;
  }
  return kept;
}
