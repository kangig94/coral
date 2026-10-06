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

/** A position reached by scanning fault-only pages; it applies only once every line selected before it was consumed. */
export type WaitSilentAdvance = Readonly<{ jobId: string; seq: number; after?: WaitProgressLine }>;
export type WaitSelection = {
  lines: WaitProgressLine[];
  exhaustedJobIds: string[];
  advances: WaitSilentAdvance[];
};

const TAIL_PAGE_ROWS = 32;

export class WaitSession {
  admissions: WaitAdmission[] = [];
  readonly notices: string[] = [];
  private readonly members = new Map<string, Member>();
  private readonly coverage = new Map<string, { kind: 'live' | 'absent' | 'unknown'; frontier: number }>();

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
    const open = (index: number): T => {
      const epoch = order[index];
      if (epoch === undefined) return read(sources);
      const result = visit(epoch, (source) => {
        sources.set(epoch, this.attributed(epoch, source));
        return open(index + 1);
      });
      if (result.kind === 'read') return result.value;
      this.unreadableSource(epoch, result.disposition, result.reason);
      return open(index + 1);
    };
    return open(0);
  }

  private attributed(epoch: string, source: ProgressSource): ProgressSource {
    const guard = <P>(jobId: string, read: () => P): P => {
      try {
        return read();
      } catch (error) {
        if (error instanceof WaitSessionError || isCodeDefect(error)) throw error;
        throw new ProgressSourceFault(epoch, jobId, error);
      }
    };
    return {
      after: (jobId, afterSeq, rows) => guard(jobId, () => source.after(jobId, afterSeq, rows)),
      before: (jobId, beforeSeq, rows) => guard(jobId, () => source.before(jobId, beforeSeq, rows)),
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

  position(sources: ReadonlyMap<string, ProgressSource>, count: number | null, budget: number, maxBytes: number): void {
    let pending = this.admissions.filter(
      (job): job is WaitAdmission & { epochKey: string } =>
        this.readable(job, sources) && (this.member(job.jobId).entry.flags & UNPOSITIONED_FLAG) !== 0,
    );
    if (pending.length === 0) return;
    if (count === null) {
      for (const job of pending) {
        const member = this.member(job.jobId);
        member.entry = { ...member.entry, flags: member.entry.flags & ~UNPOSITIONED_FLAG };
      }
      return;
    }
    type Tail = {
      lines: WaitProgressLine[];
      sizes: number[];
      bytes: number;
      before: number | null;
      reachedStart: boolean;
      frontier: number;
    };
    const tails = new Map<string, Tail>();
    const tailFor = (jobId: string): Tail => {
      const tail = tails.get(jobId);
      assert(tail);
      return tail;
    };
    // Loading stops once the loaded tail alone exceeds the byte budget: no level can then select past it.
    const load = (job: WaitAdmission & { epochKey: string }, size: number): void => {
      const source = sources.get(job.epochKey) as ProgressSource;
      const tail = tails.get(job.jobId) ?? {
        lines: [],
        sizes: [],
        bytes: 0,
        before: null,
        reachedStart: false,
        frontier: 0,
      };
      tails.set(job.jobId, tail);
      while (tail.lines.length < size && !tail.reachedStart && tail.bytes <= maxBytes) {
        const page = source.before(job.jobId, tail.before, Math.min(size - tail.lines.length, TAIL_PAGE_ROWS));
        tail.frontier = page.frontier;
        tail.reachedStart = page.reachedStart;
        tail.before = page.through;
        const lines = page.rows.flatMap((row) => this.lines(job, row));
        const sizes = lines.map((line) => Buffer.byteLength(shortenWaitLine(line.text)));
        tail.lines = [...lines, ...tail.lines];
        tail.sizes = [...sizes, ...tail.sizes];
        tail.bytes += sizes.reduce((sum, size) => sum + size, 0);
      }
    };
    const loadAll = (size: number): void => {
      for (const job of [...pending]) {
        if (!pending.includes(job)) continue;
        try {
          load(job, size);
        } catch (error) {
          if (!(error instanceof ProgressSourceFault)) throw error;
          const affected = this.fault(error);
          pending = pending.filter((member) => !affected.includes(member.jobId));
        }
      }
    };
    let level = Math.min(count, Math.floor(budget / pending.length));
    for (;;) {
      loadAll(Math.max(1, level));
      if (pending.length === 0) return;
      const short = pending.filter(
        (job) => tailFor(job.jobId).reachedStart && tailFor(job.jobId).lines.length <= level,
      );
      const longCount = pending.length - short.length;
      const used = short.reduce((sum, job) => sum + tailFor(job.jobId).lines.length, 0);
      const next = longCount === 0 ? level : Math.min(count, Math.floor((budget - used) / longCount));
      if (next <= level) break;
      level = next;
    }
    const suffixes = pending.map((job) => {
      const { sizes } = tailFor(job.jobId);
      const suffix = [0];
      for (let index = sizes.length - 1; index >= 0; index--) suffix.push(suffix[suffix.length - 1] + sizes[index]);
      return suffix;
    });
    const bytes = (k: number): number =>
      suffixes.reduce((sum, suffix) => sum + suffix[Math.min(k, suffix.length - 1)], 0);
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
      const selected = level === 0 ? [] : tail.lines.slice(-level);
      const first = selected[0];
      const member = this.member(job.jobId);
      member.entry = {
        ...member.entry,
        flags: member.entry.flags & ~UNPOSITIONED_FLAG,
        seq: first ? first.seq - Number(first.offset === 0) : tail.frontier,
        lineOffset: first?.offset ?? 0,
      };
      if (!tail.reachedStart || tail.lines.length > selected.length) omitted.push(job.jobId);
    }
    if (omitted.length)
      this.notice(`Earlier progress for ${omitted.join(', ')} was not shown; showing the most recent lines.`);
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
  select(sources: ReadonlyMap<string, ProgressSource>, budget: number, maxBytes: number): WaitSelection {
    const selected: WaitProgressLine[] = [];
    const exhaustedJobIds: string[] = [];
    const advances = new Map<string, WaitSilentAdvance>();
    const jobs = this.admissions.filter((job): job is WaitAdmission & { epochKey: string } =>
      this.readable(job, sources),
    );
    const rows = Math.min(500, Math.ceil(budget / Math.max(1, jobs.length)) + 1);
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
        if (!(error instanceof ProgressSourceFault)) throw error;
        head.next = { done: true, value: undefined };
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
      while (!chosen.next.done && chosen.next.value.seq === row && selected.length < budget) {
        const line = chosen.next.value;
        const size = Buffer.byteLength(shortenWaitLine(line.text));
        if (bytes + size > maxBytes) return { lines: selected, exhaustedJobIds, advances: [...advances.values()] };
        selected.push(line);
        bytes += size;
        pull(chosen);
      }
    }
    return { lines: selected, exhaustedJobIds, advances: [...advances.values()] };
  }

  private *selectJob(
    job: WaitAdmission,
    source: ProgressSource,
    rows: number,
    exhaustedJobIds: string[],
    advances: Map<string, WaitSilentAdvance>,
    remaining: () => number,
  ): Generator<WaitProgressLine> {
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
      rows = Math.max(1, Math.min(500, remaining() + 1));
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
