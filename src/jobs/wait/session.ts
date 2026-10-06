import assert from 'node:assert/strict';
import type { WaitProgressRow } from './progress-page.js';
import { sameEpoch, epochIdentity } from '../../store/epoch/identity.js';
import { isCodeDefect, sourceReadFailureDisposition } from '../source-read.js';
import type { JobDetailResponse, JobProgressEvent, JobTerminal } from '../records.js';
import type { ContinuitySnapshot } from '../../sessions/continuity.js';
import type { ResultAvailability } from '../terminal/export.js';
import type { WaitCursor, WaitCursorEntry, WaitStreamEvent, ProgressSource, ProgressVisit } from './contract.js';
import {
  ACKNOWLEDGED_FLAG,
  ARTIFACT_PENDING_FLAG,
  TAIL_SCAN_FLAG,
  UNPOSITIONED_FLAG,
  waitCursorEntry,
  waitEpochToken,
  waitJobHash,
} from './cursor.js';

export type WaitDisposition =
  | 'admitted'
  | 'missing'
  | 'discovery-unknown'
  | 'pre-epoch-history'
  | 'outcome-unrecoverable'
  | 'outcome-unreadable'
  | 'discovery-unreadable'
  | 'scope-mismatch';

/** Source reads settle per job; only a retryable observation holds an epoch prefix.
 * readable: observed success; transient-unknown: busy/lock contention or retryScheduled hold;
 * settled-unreadable: decode/parse, unsupported fingerprint or an owner-settled hold;
 * retired: observed source retirement.
 */
export type SourceReadDisposition = 'readable' | 'transient-unknown' | 'settled-unreadable' | 'retired';

export function sourceReadDisposition(job: WaitAdmission): SourceReadDisposition {
  return job.sourceRead ?? 'readable';
}

type WaitAdmissionDetail = {
  jobId: string;
  message?: string;
  epochKey?: string;
  detail?: Omit<JobDetailResponse, 'events'> & { terminalSeq?: number };
  availability?: ResultAvailability;
  continuity?: ContinuitySnapshot | null;
  sourceRead?: SourceReadDisposition;
  observationDeferred?: boolean;
  progressLost?: boolean;
  progressUnknown?: boolean;
  queued?: Extract<WaitStreamEvent, { type: 'queued' }>;
};

export type WaitAdmission = WaitAdmissionDetail &
  (
    | { disposition: 'admitted'; sourceRead: SourceReadDisposition }
    | { disposition: Exclude<WaitDisposition, 'admitted'> }
  );

/** An active-journal read that failed is uncertainty about that one job: decode failures settle it, others retry. */
export function activeJournalReadFailure(jobId: string, epochKey: string, error: unknown): WaitAdmission {
  if (isCodeDefect(error)) throw error;
  return sourceReadFailureDisposition(error) === 'settled-unreadable'
    ? {
        jobId,
        disposition: 'outcome-unreadable',
        epochKey,
        sourceRead: 'settled-unreadable',
        message: "This build cannot decode this job's records in the active journal; no later read changes that",
      }
    : {
        jobId,
        disposition: 'admitted',
        epochKey,
        sourceRead: 'transient-unknown',
        message: 'The active journal cannot be read right now; this wait reads it again on its next poll',
      };
}

export type WaitProgressLine = {
  jobId: string;
  epochKey: string;
  seq: number;
  offset: number;
  last: boolean;
  text: string;
  timing: JobProgressEvent['timing'];
  entryAfter: WaitCursorEntry;
  progressAfter: 'exhausted' | 'unread';
};
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
  epochToken?: string;
  phase?: string;
  alreadyCollected?: boolean;
  progress: string[];
  terminal?: WaitTerminalSummary;
  availability?: ResultAvailability;
  artifactFollowUp?: boolean;
};
export type WaitSnapshot = {
  jobs: WaitSnapshotJob[];
  notices: string[];
  cursor: WaitCursor;
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
type Member = { entry: WaitCursorEntry; progress: ProgressState };

/** A page read failed for one job of one epoch; only that source's members may be marked for it. */
class ProgressSourceFault extends Error {
  readonly epoch: string;
  readonly jobId: string;
  readonly disposition: 'transient-unknown' | 'settled-unreadable';
  constructor(epoch: string, jobId: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.epoch = epoch;
    this.jobId = jobId;
    this.disposition = sourceReadFailureDisposition(cause);
  }
}

/** A poll spent its raw-row allowance; the read it refused resumes on the next poll. */
class ProgressRowsExhausted extends Error {}

/** A position reached by scanning fault-only pages; it applies only once every line selected before it was consumed. */
export type WaitSilentAdvance = Readonly<{ jobId: string; seq: number; after?: WaitProgressLine }>;
export type WaitSelection = {
  lines: WaitProgressLine[];
  exhaustedJobIds: string[];
  advances: WaitSilentAdvance[];
  /** The line or byte budget left no room for another line. */
  full: boolean;
  /** The poll's raw-row allowance ran out before every readable job was served; the rest resumes next poll. */
  cut: boolean;
};

const TAIL_PAGE_ROWS = 32;
/** A forward read starts with a page this size and doubles it, so a poll a few large rows fill discards few rows. */
const FIRST_PAGE_ROWS = 32;
/** Raw progress rows one poll may read, lookahead rows included, shared by positioning and selection. */
const WAIT_PROGRESS_ROWS = 500;

/** A backward scan for one job's tail; it outlives a cut poll so the next poll continues it instead of restarting. */
type TailScan = {
  /** Lines this session loaded, oldest first. */
  lines: WaitProgressLine[];
  sizes: number[];
  bytes: number;
  /** Lines an earlier request found at or above `before`; this session holds their count but not their positions. */
  prior: number;
  /** The lowest raw seq scanned; null before the first page. */
  before: number | null;
  reachedStart: boolean;
  /**
   * The highest seq up to which this session read every row of the job above its lines: the source frontier for a
   * scan it began, or just below the boundary of a scan resumed from a cursor. Null before a begun scan's first page.
   */
  covered: number | null;
};

/**
 * Lines a tail scan read from a job's new position through `through`: every row of the job up to there was read, so
 * selection serves them without reading those rows again. `exhausted` holds only when `through` is the source frontier
 * this poll observed, so no row of the job lies above it.
 */
type WaitPositionedTail = Readonly<{ lines: readonly WaitProgressLine[]; through: number; exhausted: boolean }>;
export type WaitPositioned = ReadonlyMap<string, WaitPositionedTail>;

/** Lines a tail read adds within `rows` raw rows, when each page of up to TAIL_PAGE_ROWS rows also reads a lookahead. */
function tailLinesWithin(rows: number): number {
  return rows <= 1 ? 0 : rows - Math.ceil(rows / (TAIL_PAGE_ROWS + 1));
}

export class WaitSession {
  admissions: WaitAdmission[] = [];
  readonly notices: string[] = [];
  private readonly members = new Map<string, Member>();
  private readonly coverage = new Map<string, { kind: 'live' | 'absent' | 'unknown'; frontier: number }>();
  private readonly tails = new Map<string, TailScan>();
  /** The raw-row allowance of the poll in progress, which positioning sizes its tails against. */
  private allowance = { remaining: WAIT_PROGRESS_ROWS };

  readonly jobIds: readonly string[];
  readonly input?: WaitCursor;
  private readonly internal: boolean;
  constructor(jobIds: readonly string[], input?: WaitCursor, internal = false) {
    this.jobIds = jobIds;
    this.input = input;
    this.internal = internal;
    if (new Set(jobIds.map(waitJobHash)).size !== jobIds.length)
      throw new WaitSessionError('wait_cursor_mismatch', 'Each job ID must appear only once.');
  }

  reconcile(admissions: WaitAdmission[]): void {
    const previous = new Map(this.admissions.map((job) => [job.jobId, job]));
    const addresses = new Map<string, string>();
    this.admissions = admissions.map((observed) => {
      const job = observed.observationDeferred ? (previous.get(observed.jobId) ?? observed) : observed;
      if (!job.epochKey) return job;
      const identity = epochIdentity(job.epochKey);
      const epochKey = addresses.get(identity) ?? job.epochKey;
      addresses.set(identity, epochKey);
      return epochKey === job.epochKey ? job : { ...job, epochKey };
    });
    for (const job of this.admissions) {
      let member = this.members.get(job.jobId);
      if (!member) {
        member = { entry: waitCursorEntry(this.input, job), progress: 'unknown' };
        this.members.set(job.jobId, member);
      }
      // A known location fixes the entry's epoch before any hold, so an acknowledgement never lands on a null epoch.
      if (job.epochKey) {
        const epoch = waitEpochToken(job.epochKey);
        if (member.entry.epoch !== null && member.entry.epoch !== epoch)
          throw new WaitSessionError('wait_cursor_mismatch', `Job ${job.jobId} changed epoch identity`);
        if (member.entry.epoch === null) member.entry = { ...member.entry, epoch };
      }
      if (job.disposition !== 'admitted' && job.disposition !== 'discovery-unknown') {
        member.progress = 'refused';
        continue;
      }
      if (job.sourceRead === 'transient-unknown' || job.disposition === 'discovery-unknown') {
        member.progress = 'unknown';
        if (job.epochKey || member.entry.epoch)
          this.notice(
            `Earlier progress for ${job.jobId} is held: source cannot be read right now; epoch maintenance observes every 5 s and settles after 3 failed probes${job.message ? ` (${job.message})` : ''}. Bounded waits retry after 250 ms, 1 s and 5 s, then exit 75 with a continuation. Snapshots return immediately with a continuation.`,
          );
        continue;
      }
      member.progress = job.sourceRead === 'retired' || job.sourceRead === 'settled-unreadable' ? 'lost' : 'unread';
      if (job.sourceRead === 'retired' && !job.progressLost) this.notice(retiredNotice(job.jobId));
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

  private readable(
    job: WaitAdmission,
    sources: ReadonlyMap<string, ProgressSource>,
  ): job is WaitAdmission & {
    epochKey: string;
  } {
    return (
      job.disposition === 'admitted' &&
      job.epochKey !== undefined &&
      sources.has(job.epochKey) &&
      this.member(job.jobId).progress === 'unread'
    );
  }

  /** Each source is opened and classified once; position and selection then run outside every source's error scope. */
  withProgress<T>(visit: ProgressVisit, read: (sources: ReadonlyMap<string, ProgressSource>) => T): T {
    const epochs = new Map<string, string>();
    for (const job of this.admissions)
      if (job.disposition === 'admitted' && job.epochKey && sourceReadDisposition(job) === 'readable')
        epochs.set(epochIdentity(job.epochKey), job.epochKey);
    const order = [...epochs.values()];
    const sources = new Map<string, ProgressSource>();
    const allowance = { remaining: WAIT_PROGRESS_ROWS };
    this.allowance = allowance;
    const open = (index: number): T => {
      const epoch = order[index];
      if (epoch === undefined) return read(sources);
      const result = visit(epoch, (source) => {
        sources.set(epoch, this.attributed(epoch, source, allowance));
        return open(index + 1);
      });
      if (result.kind === 'read') return result.value;
      this.unreadableSource(epoch, result.disposition, result.reason);
      return open(index + 1);
    };
    return open(0);
  }

  /** Every raw row a poll reads, lookahead included, is charged to its one allowance before the read can exceed it. */
  private attributed(epoch: string, source: ProgressSource, allowance: { remaining: number }): ProgressSource {
    const guard = <P>(jobId: string, read: () => P): P => {
      try {
        return read();
      } catch (error) {
        if (error instanceof WaitSessionError || isCodeDefect(error)) throw error;
        throw new ProgressSourceFault(epoch, jobId, error);
      }
    };
    const affordable = (rows: number): number => {
      if (allowance.remaining < 2) throw new ProgressRowsExhausted();
      return Math.min(rows, allowance.remaining - 1);
    };
    const charge = <P extends { rawRows: number }>(page: P): P => {
      allowance.remaining -= page.rawRows;
      return page;
    };
    return {
      after: (jobId, afterSeq, rows) => {
        const limit = affordable(rows);
        return charge(guard(jobId, () => source.after(jobId, afterSeq, limit)));
      },
      before: (jobId, beforeSeq, rows) => {
        const limit = affordable(rows);
        return charge(guard(jobId, () => source.before(jobId, beforeSeq, limit)));
      },
    };
  }

  private unreadableSource(
    epoch: string,
    disposition: Exclude<SourceReadDisposition, 'readable'>,
    reason: string | undefined,
  ): void {
    for (const job of this.admissions.filter((job) => job.disposition === 'admitted' && sameEpoch(job.epochKey, epoch)))
      this.markUnreadable(job.jobId, disposition, reason);
  }

  private markUnreadable(
    jobId: string,
    disposition: Exclude<SourceReadDisposition, 'readable'>,
    reason: string | undefined,
  ): void {
    const member = this.member(jobId);
    member.progress = disposition === 'transient-unknown' ? 'unknown' : 'lost';
    if (disposition === 'retired') this.notice(retiredNotice(jobId));
    else
      this.notice(
        `Earlier progress for ${jobId} ${member.progress === 'unknown' ? 'is held' : 'cannot be read by this build'}${reason ? `: ${reason}` : '.'}`,
      );
  }

  /** A transient page failure holds its epoch's members; a decode failure settles only the job whose row failed. */
  private fault(fault: ProgressSourceFault): readonly string[] {
    const affected =
      fault.disposition === 'transient-unknown'
        ? this.admissions
            .filter((job) => job.disposition === 'admitted' && sameEpoch(job.epochKey, fault.epoch))
            .map((job) => job.jobId)
        : [fault.jobId];
    const reason =
      fault.disposition === 'transient-unknown'
        ? 'source cannot be read right now; this read is retried on the next poll'
        : 'a progress row cannot be decoded by this build';
    for (const jobId of affected) this.markUnreadable(jobId, fault.disposition, reason);
    return affected;
  }

  /**
   * A tail scan cut short by the row allowance keeps its job unpositioned and resumes from its boundary next poll;
   * positioning never lands on a partial scan, which could skip older lines that belong in the tail.
   */
  position(
    sources: ReadonlyMap<string, ProgressSource>,
    count: number | null,
    budget: number,
    maxBytes: number,
  ): WaitPositioned {
    const positioned = new Map<string, WaitPositionedTail>();
    let pending = this.admissions.filter(
      (job): job is WaitAdmission & { epochKey: string } =>
        this.readable(job, sources) && (this.member(job.jobId).entry.flags & UNPOSITIONED_FLAG) !== 0,
    );
    for (const jobId of this.tails.keys()) if (!pending.some((job) => job.jobId === jobId)) this.tails.delete(jobId);
    if (pending.length === 0) return positioned;
    if (count === null) {
      for (const job of pending) {
        const member = this.member(job.jobId);
        member.entry = {
          ...member.entry,
          flags: member.entry.flags & ~(UNPOSITIONED_FLAG | TAIL_SCAN_FLAG),
          seq: 0,
          lineOffset: 0,
        };
        this.tails.delete(job.jobId);
      }
      return positioned;
    }
    const tailFor = (jobId: string): TailScan => {
      const tail = this.tails.get(jobId);
      assert(tail);
      return tail;
    };
    const found = (tail: TailScan): number => tail.prior + tail.lines.length;
    /** The source frontier each scan observed in this poll's transaction. */
    const frontiers = new Map<string, number>();
    // Loading stops once the loaded tail alone exceeds the byte budget: no level can then select past it.
    const load = (job: WaitAdmission & { epochKey: string }, size: number): void => {
      const source = sources.get(job.epochKey) as ProgressSource;
      const { entry } = this.member(job.jobId);
      const resumed = (entry.flags & TAIL_SCAN_FLAG) !== 0;
      let tail = this.tails.get(job.jobId);
      if (tail === undefined) {
        tail = {
          lines: [],
          sizes: [],
          bytes: 0,
          prior: resumed ? entry.lineOffset : 0,
          before: resumed ? entry.seq : null,
          reachedStart: false,
          covered: resumed ? entry.seq - 1 : null,
        };
        this.tails.set(job.jobId, tail);
      }
      while (found(tail) < size && !tail.reachedStart && tail.bytes <= maxBytes) {
        const page = source.before(job.jobId, tail.before, Math.min(size - found(tail), TAIL_PAGE_ROWS));
        if (tail.before === null) tail.covered = page.frontier;
        frontiers.set(job.jobId, page.frontier);
        tail.reachedStart = page.reachedStart;
        if (page.rawRows > 0) tail.before = page.through;
        const lines = page.rows.flatMap((row) => this.lines(job, row));
        const sizes = lines.map((line) => Buffer.byteLength(shortenWaitLine(line.text)));
        tail.lines = [...lines, ...tail.lines];
        tail.sizes = [...sizes, ...tail.sizes];
        tail.bytes += sizes.reduce((sum, size) => sum + size, 0);
      }
    };
    const loadedTo = (job: WaitAdmission, size: number): boolean => {
      const tail = this.tails.get(job.jobId);
      return tail !== undefined && (found(tail) >= size || tail.reachedStart || tail.bytes > maxBytes);
    };
    /** Whether the row allowance cut the load short; a source fault drops only its own jobs. */
    const loadAll = (size: number): boolean => {
      for (const job of [...pending]) {
        if (!pending.includes(job)) continue;
        try {
          load(job, size);
        } catch (error) {
          if (error instanceof ProgressRowsExhausted) return true;
          if (!(error instanceof ProgressSourceFault)) throw error;
          const affected = this.fault(error);
          pending = pending.filter((member) => !affected.includes(member.jobId));
          for (const jobId of affected) this.tails.delete(jobId);
        }
      }
      return false;
    };
    // A level's rows are its lines plus one lookahead row per tail page, all drawn from the poll's one allowance.
    let level = Math.min(
      count,
      Math.floor(budget / pending.length),
      tailLinesWithin(Math.floor(this.allowance.remaining / pending.length)),
    );
    for (;;) {
      if (loadAll(Math.max(1, level))) {
        // Only scans the allowance cut short wait for the next poll; every finished tail is positioned at this level.
        const cut = pending.filter((job) => !loadedTo(job, Math.max(1, level)));
        this.holdTailScans(cut);
        pending = pending.filter((job) => !cut.includes(job));
        break;
      }
      if (pending.length === 0) return positioned;
      const short = pending.filter((job) => tailFor(job.jobId).reachedStart && found(tailFor(job.jobId)) <= level);
      const longCount = pending.length - short.length;
      const used = short.reduce((sum, job) => sum + found(tailFor(job.jobId)), 0);
      const next =
        longCount === 0
          ? level
          : Math.min(
              count,
              Math.floor((budget - used) / longCount),
              level + tailLinesWithin(Math.floor(this.allowance.remaining / longCount)),
            );
      if (next <= level) break;
      level = next;
    }
    if (pending.length === 0) return positioned;
    // Lines an earlier request found have no size here; selection still enforces the byte budget on delivery.
    const suffixes = pending.map((job) => {
      const { sizes, prior } = tailFor(job.jobId);
      const suffix = [0];
      for (let index = sizes.length - 1; index >= 0; index--) suffix.push(suffix[suffix.length - 1] + sizes[index]);
      return { suffix, prior };
    });
    const bytes = (k: number): number =>
      suffixes.reduce((sum, { suffix, prior }) => sum + suffix[Math.min(Math.max(0, k - prior), suffix.length - 1)], 0);
    let fits = 0;
    let over = level + 1;
    while (over - fits > 1) {
      const middle = Math.floor((fits + over) / 2);
      if (bytes(middle) <= maxBytes) fits = middle;
      else over = middle;
    }
    level = fits;
    const omitted: string[] = [];
    for (const job of pending) {
      const tail = tailFor(job.jobId);
      const shown = Math.min(level, found(tail));
      const first = shown > tail.prior ? tail.lines[tail.lines.length - (shown - tail.prior)] : undefined;
      const boundary = (tail.before ?? 1) - 1;
      const member = this.member(job.jobId);
      member.entry = {
        ...member.entry,
        flags: member.entry.flags & ~(UNPOSITIONED_FLAG | TAIL_SCAN_FLAG),
        // A line an earlier request found cannot be located again, so the tail then starts where this session's
        // reading began, below which every line is older than the shown window.
        seq: first ? first.seq - Number(first.offset === 0) : (tail.covered ?? boundary),
        lineOffset: first?.offset ?? 0,
      };
      if (first && tail.covered !== null)
        positioned.set(job.jobId, {
          lines: tail.lines.slice(-(shown - tail.prior)),
          through: tail.covered,
          exhausted: frontiers.get(job.jobId) === tail.covered,
        });
      this.tails.delete(job.jobId);
      if (!tail.reachedStart || found(tail) > shown) omitted.push(job.jobId);
    }
    if (omitted.length)
      this.notice(`Earlier progress for ${omitted.join(', ')} was not shown; showing the most recent lines.`);
    return positioned;
  }

  /** A cut scan is recorded on its entry, so a cursor taken at this cut resumes the scan instead of restarting it. */
  private holdTailScans(pending: readonly WaitAdmission[]): void {
    for (const job of pending) {
      const tail = this.tails.get(job.jobId);
      if (tail?.before === null || tail?.before === undefined) continue;
      const member = this.member(job.jobId);
      member.entry = {
        ...member.entry,
        flags: member.entry.flags | UNPOSITIONED_FLAG | TAIL_SCAN_FLAG,
        seq: tail.before,
        lineOffset: tail.prior + tail.lines.length,
      };
    }
  }

  private lines(job: WaitAdmission, row: WaitProgressRow): WaitProgressLine[] {
    const parts = splitWaitProgress(row.message);
    const entry = this.member(job.jobId).entry;
    return parts.map((text, offset) => ({
      jobId: job.jobId,
      epochKey: job.epochKey as string,
      seq: row.seq,
      offset,
      last: offset === parts.length - 1,
      text,
      timing: row.timing,
      entryAfter: { ...entry, seq: row.seq, lineOffset: offset === parts.length - 1 ? 0 : offset + 1 },
      progressAfter: 'unread' as const,
    }));
  }

  /** Epochs take turns one row at a time, so no epoch's backlog can starve another's within one budget. */
  select(
    sources: ReadonlyMap<string, ProgressSource>,
    budget: number,
    maxBytes: number,
    positioned: WaitPositioned = new Map(),
  ): WaitSelection {
    const selected: WaitProgressLine[] = [];
    const exhaustedJobIds: string[] = [];
    const advances = new Map<string, WaitSilentAdvance>();
    const readable = this.admissions.filter((job): job is WaitAdmission & { epochKey: string } =>
      this.readable(job, sources),
    );
    const jobs = readable.filter((job) => (this.member(job.jobId).entry.flags & UNPOSITIONED_FLAG) === 0);
    let cut = jobs.length < readable.length;
    // Each job's first page, lookahead included, fits the poll's allowance, so no job waits on another's backlog.
    const perJob = Math.max(1, jobs.length);
    const rows = Math.max(
      1,
      Math.min(FIRST_PAGE_ROWS, Math.ceil(budget / perJob) + 1, Math.floor(WAIT_PROGRESS_ROWS / perJob) - 1),
    );
    type Head = { jobId: string; iterator: Generator<WaitProgressLine>; next: IteratorResult<WaitProgressLine> };
    const epochs = new Map<string, Head[]>();
    const drop = (jobIds: readonly string[]): void => {
      for (const [identity, heads] of epochs) {
        const kept = heads.filter((head) => !jobIds.includes(head.jobId));
        if (kept.length) epochs.set(identity, kept);
        else epochs.delete(identity);
      }
      for (const jobId of jobIds) advances.delete(jobId);
      for (let index = selected.length - 1; index >= 0; index--)
        if (jobIds.includes(selected[index].jobId)) selected.splice(index, 1);
    };
    const alive = (head: Head): boolean => [...epochs.values()].some((heads) => heads.includes(head));
    const pull = (head: Head): void => {
      try {
        head.next = head.iterator.next();
      } catch (error) {
        head.next = { done: true, value: undefined };
        if (error instanceof ProgressRowsExhausted) {
          cut = true;
          return;
        }
        if (!(error instanceof ProgressSourceFault)) throw error;
        drop(this.fault(error));
      }
    };
    for (const job of jobs) {
      const identity = epochIdentity(job.epochKey);
      const head: Head = {
        jobId: job.jobId,
        iterator: this.selectJob(
          job,
          sources.get(job.epochKey) as ProgressSource,
          rows,
          exhaustedJobIds,
          advances,
          () => Math.max(0, budget - selected.length),
          positioned.get(job.jobId),
        ),
        next: { done: true, value: undefined },
      };
      epochs.set(identity, [...(epochs.get(identity) ?? []), head]);
    }
    for (const heads of [...epochs.values()]) for (const head of heads) if (alive(head)) pull(head);
    let bytes = 0;
    let turn = 0;
    while (selected.length < budget && epochs.size > 0) {
      const identities = [...epochs.keys()];
      const identity = identities[turn++ % identities.length];
      let chosen: Head | undefined;
      for (const head of epochs.get(identity) ?? []) {
        if (head.next.done) continue;
        const prior = chosen?.next.value as WaitProgressLine | undefined;
        if (
          !prior ||
          head.next.value.seq < prior.seq ||
          (head.next.value.seq === prior.seq && head.next.value.offset < prior.offset)
        )
          chosen = head;
      }
      if (!chosen) {
        epochs.delete(identity);
        continue;
      }
      const row = (chosen.next as IteratorYieldResult<WaitProgressLine>).value.seq;
      const rowStart = selected.length;
      while (!chosen.next.done && chosen.next.value.seq === row) {
        const line = chosen.next.value;
        const size = Buffer.byteLength(shortenWaitLine(line.text));
        // An internal reader's consumer acts on whole messages, so a row it has begun is never split.
        const begun = this.internal && selected.length > rowStart;
        if (!begun && selected.length >= budget) break;
        if (!begun && bytes + size > maxBytes)
          return { lines: selected, exhaustedJobIds, advances: [...advances.values()], full: true, cut };
        selected.push(line);
        bytes += size;
        pull(chosen);
      }
    }
    return {
      lines: selected,
      exhaustedJobIds,
      advances: [...advances.values()],
      full: selected.length >= budget,
      cut,
    };
  }

  private *selectJob(
    job: WaitAdmission,
    source: ProgressSource,
    rows: number,
    exhaustedJobIds: string[],
    advances: Map<string, WaitSilentAdvance>,
    remaining: () => number,
    positioned?: WaitPositionedTail,
  ): Generator<WaitProgressLine> {
    if (positioned) {
      const last = positioned.lines.length - 1;
      for (let index = 0; index < last; index++) yield positioned.lines[index];
      const line = positioned.lines[last];
      yield {
        ...line,
        entryAfter: { ...line.entryAfter, seq: positioned.through, lineOffset: 0 },
        progressAfter: positioned.exhausted ? 'exhausted' : 'unread',
      };
      return;
    }
    const member = this.member(job.jobId);
    let entry = member.entry;
    let previous: WaitProgressLine | undefined;
    for (;;) {
      const page = source.after(job.jobId, Math.max(0, entry.seq - Number(entry.lineOffset > 0)), rows);
      let yielded = false;
      for (let index = 0; index < page.rows.length; index++) {
        const lines = this.lines(job, page.rows[index]).filter(
          (line) =>
            line.seq > entry.seq || (line.seq === entry.seq && entry.lineOffset > 0 && line.offset >= entry.lineOffset),
        );
        const last = lines.at(-1);
        if (last && index === page.rows.length - 1) {
          last.entryAfter = { ...last.entryAfter, seq: page.through, lineOffset: 0 };
          last.progressAfter = page.exhausted ? 'exhausted' : 'unread';
        }
        for (const line of lines) {
          if (!yielded) advances.delete(job.jobId);
          yielded = true;
          previous = line;
          yield line;
        }
      }
      if (!yielded && page.through > entry.seq && (page.faultRows > 0 || page.rows.length > 0))
        advances.set(job.jobId, { jobId: job.jobId, seq: page.through, ...(previous ? { after: previous } : {}) });
      if (page.exhausted) {
        if (!yielded) exhaustedJobIds.push(job.jobId);
        return;
      }
      entry = { ...entry, seq: page.through, lineOffset: 0 };
      rows = Math.max(1, Math.min(500, remaining() + 1, rows * 2));
    }
  }

  /** Fault-only pages move a job only behind lines already consumed, and never emit a message. */
  advanceSilently(advances: readonly WaitSilentAdvance[]): void {
    for (const advance of advances) {
      const member = this.member(advance.jobId);
      const consumed =
        advance.after === undefined ||
        (member.entry.seq === advance.after.entryAfter.seq &&
          member.entry.lineOffset === advance.after.entryAfter.lineOffset);
      if (consumed && member.entry.seq < advance.seq)
        member.entry = { ...member.entry, seq: advance.seq, lineOffset: 0 };
    }
  }

  preview(): WaitSession {
    const copy = new WaitSession(this.jobIds, this.input, this.internal);
    copy.admissions = this.admissions;
    copy.notices.push(...this.notices);
    for (const [id, member] of this.members) copy.members.set(id, { ...member });
    for (const [id, coverage] of this.coverage) copy.coverage.set(id, coverage);
    return copy;
  }

  observeEmpty(jobIds: readonly string[]): void {
    for (const jobId of jobIds) {
      const member = this.member(jobId);
      if (member.progress === 'unread') member.progress = 'exhausted';
    }
  }

  consume(line: WaitProgressLine): void {
    const member = this.member(line.jobId);
    member.entry = { ...line.entryAfter, flags: member.entry.flags };
    member.progress = line.progressAfter;
  }
  hasProgress(): boolean {
    return this.admissions.some(
      (job) => job.disposition === 'admitted' && this.member(job.jobId).progress === 'unread',
    );
  }
  progressState(jobId: string): ProgressState {
    return this.members.get(jobId)?.progress ?? 'unknown';
  }
  positioning(jobId: string): boolean {
    return (this.member(jobId).entry.flags & UNPOSITIONED_FLAG) !== 0;
  }
  entry(jobId: string): WaitCursorEntry {
    return this.member(jobId).entry;
  }
  acknowledged(jobId: string): boolean {
    return (this.member(jobId).entry.flags & ACKNOWLEDGED_FLAG) !== 0;
  }
  artifactPending(jobId: string): boolean {
    return (this.member(jobId).entry.flags & ARTIFACT_PENDING_FLAG) !== 0;
  }
  acknowledge(job: WaitAdmission): void {
    const member = this.member(job.jobId);
    member.entry = {
      ...member.entry,
      flags:
        member.entry.flags |
        ACKNOWLEDGED_FLAG |
        (!this.internal && job.availability?.kind === 'repair-pending' ? ARTIFACT_PENDING_FLAG : 0),
    };
  }
  settleArtifact(jobId: string): void {
    const member = this.member(jobId);
    member.entry = { ...member.entry, flags: member.entry.flags & ~ARTIFACT_PENDING_FLAG };
  }
  remaining(): string[] {
    return this.admissions
      .filter(
        (job) =>
          job.disposition === 'discovery-unknown' ||
          (job.disposition === 'admitted' &&
            (!job.detail?.exit ||
              !this.acknowledged(job.jobId) ||
              this.artifactPending(job.jobId) ||
              this.progressState(job.jobId) === 'unread' ||
              this.progressState(job.jobId) === 'unknown')),
      )
      .map((job) => job.jobId);
  }
  exitCode(): number {
    for (const job of this.admissions)
      if (job.detail?.exit && this.acknowledged(job.jobId)) {
        const code = waitTerminalExitCode(job.detail.exit);
        if (code !== 0) return code;
      }
    if (this.admissions.some((job) => job.disposition !== 'admitted' && job.disposition !== 'discovery-unknown'))
      return 1;
    return this.remaining().length || this.unknownCarriers().length ? 75 : 0;
  }
  cursor(jobIds: readonly string[] = this.jobIds): WaitCursor {
    return {
      jobs: jobIds.flatMap((id) => {
        const job = this.admissions.find((job) => job.jobId === id);
        return job && (job.disposition === 'admitted' || job.disposition === 'discovery-unknown')
          ? [this.member(id).entry]
          : [];
      }),
    };
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

function retiredNotice(jobId: string): string {
  return `Earlier progress for ${jobId} is no longer kept: source retired. Its retained outcome remains available.`;
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
