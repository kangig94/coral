import assert from 'node:assert/strict';
import type { WaitProgressRow } from './progress-page.js';
import { sameEpoch, epochIdentity } from '../../store/epoch/identity.js';
import type { JobDetailResponse, JobProgressEvent, JobTerminal } from '../records.js';
import type { ContinuitySnapshot } from '../../sessions/continuity.js';
import type { ResultAvailability } from '../terminal/export.js';
import type {
  WaitCursor,
  WaitCursorV3,
  WaitCursorEntry,
  WaitStreamEvent,
  ProgressSource,
  ProgressVisit,
} from './contract.js';
import {
  ACKNOWLEDGED_FLAG,
  ARTIFACT_PENDING_FLAG,
  UNPOSITIONED_FLAG,
  legacyWaitEntries,
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
  version: 'jobs.wait.v3';
  jobs: WaitSnapshotJob[];
  notices: string[];
  cursor: WaitCursorV3;
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

type ProgressState = 'exhausted' | 'unread' | 'unknown' | 'lost';
type Member = { entry: WaitCursorEntry; progress: ProgressState };

export class WaitSession {
  admissions: WaitAdmission[] = [];
  readonly notices: string[] = [];
  private readonly members = new Map<string, Member>();
  private readonly coverage = new Map<string, { kind: 'live' | 'absent' | 'unknown'; frontier: number }>();

  readonly jobIds: readonly string[];
  readonly input?: WaitCursor;
  private readonly activeEpochKey?: string;
  private readonly internal: boolean;
  constructor(jobIds: readonly string[], input?: WaitCursor, activeEpochKey?: string, internal = false) {
    this.jobIds = jobIds;
    this.input = input;
    this.activeEpochKey = activeEpochKey;
    this.internal = internal;
    if (new Set(jobIds.map(waitJobHash)).size !== jobIds.length)
      throw new WaitSessionError('wait_cursor_mismatch', 'Each job ID must appear only once.');
  }

  reconcile(admissions: WaitAdmission[]): void {
    const previous = new Map(this.admissions.map((job) => [job.jobId, job]));
    const addresses = new Map<string, string>();
    this.admissions = admissions.map((job) => {
      if (job.observationDeferred) return previous.get(job.jobId) ?? job;
      if (!job.epochKey) return job;
      const identity = epochIdentity(job.epochKey);
      const epochKey = addresses.get(identity) ?? job.epochKey;
      addresses.set(identity, epochKey);
      return { ...job, epochKey };
    });
    if (this.input?.version === 'jobs.wait.v2')
      for (const job of this.admissions) {
        const address = this.input.locations[job.jobId];
        if (address && job.epochKey && !sameEpoch(address, job.epochKey))
          throw new WaitSessionError('wait_cursor_mismatch', `Job ${job.jobId} changed epoch identity`);
      }
    const entries = legacyWaitEntries(this.input, this.admissions, this.activeEpochKey);
    for (const job of this.admissions) {
      let member = this.members.get(job.jobId);
      if (!member) {
        const entry = entries.find((entry) => entry.hash === waitJobHash(job.jobId));
        assert(entry);
        member = { entry, progress: 'unknown' };
        this.members.set(job.jobId, member);
      }
      if (job.sourceRead === 'transient-unknown' || job.disposition === 'discovery-unknown') {
        member.progress = 'unknown';
        if (job.epochKey || member.entry.epoch)
          this.notice(
            `Earlier progress for ${job.jobId} is held: source cannot be read right now; epoch maintenance observes every 5 s and settles after 3 failed probes${job.message ? ` (${job.message})` : ''}. Bounded waits retry after 250 ms, 1 s and 5 s, then exit 75 with a continuation. Snapshots return immediately with a continuation.`,
          );
        continue;
      }
      if (job.epochKey) {
        const epoch = waitEpochToken(job.epochKey);
        if (member.entry.epoch !== null && member.entry.epoch !== epoch)
          throw new WaitSessionError('wait_cursor_mismatch', `Job ${job.jobId} changed epoch identity`);
        member.entry = { ...member.entry, epoch };
      }
      member.progress = job.sourceRead === 'retired' || job.sourceRead === 'settled-unreadable' ? 'lost' : 'unread';
      if (job.sourceRead === 'retired' && !job.progressLost)
        this.notice(
          `Earlier progress for ${job.jobId} cannot be read: source retired. Its retained outcome remains available.`,
        );
      if (job.disposition === 'admitted' && !job.detail?.exit && !this.coverage.has(job.jobId))
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

  withProgress<T>(visit: ProgressVisit, read: (sources: ReadonlyMap<string, ProgressSource>) => T): T {
    const epochs = [
      ...new Set(
        this.admissions.flatMap((job) =>
          job.disposition === 'admitted' && job.epochKey && sourceReadDisposition(job) === 'readable'
            ? [job.epochKey]
            : [],
        ),
      ),
    ];
    const sources = new Map<string, ProgressSource>();
    const next = (index: number): T => {
      const epoch = epochs[index];
      if (epoch === undefined) return read(sources);
      const result = visit(epoch, (source) => {
        sources.set(epoch, source);
        return next(index + 1);
      });
      if (result.kind === 'read') return result.value;
      for (const job of this.admissions.filter((job) => sameEpoch(job.epochKey, epoch))) {
        const member = this.member(job.jobId);
        member.progress = result.disposition === 'transient-unknown' ? 'unknown' : 'lost';
        this.notice(
          `Earlier progress for ${job.jobId} ${member.progress === 'unknown' ? 'is held' : 'cannot be read by this build'}${result.reason ? `: ${result.reason}` : '.'}`,
        );
      }
      return next(index + 1);
    };
    return next(0);
  }

  position(sources: ReadonlyMap<string, ProgressSource>, count: number | null, budget: number, maxBytes: number): void {
    const pending = this.admissions.filter(
      (job) =>
        job.disposition === 'admitted' &&
        job.epochKey &&
        sources.has(job.epochKey) &&
        this.member(job.jobId).progress === 'unread' &&
        (this.member(job.jobId).entry.flags & UNPOSITIONED_FLAG) !== 0,
    );
    if (pending.length === 0) return;
    if (count === null) {
      for (const job of pending) {
        const member = this.member(job.jobId);
        member.entry = { ...member.entry, flags: member.entry.flags & ~UNPOSITIONED_FLAG };
      }
      return;
    }
    const tails = new Map<
      string,
      { lines: WaitProgressLine[]; before: number | null; reachedStart: boolean; frontier: number }
    >();
    const tailFor = (jobId: string) => {
      const tail = tails.get(jobId);
      assert(tail);
      return tail;
    };
    const load = (job: WaitAdmission, size: number) => {
      const source = sources.get(job.epochKey as string) as ProgressSource;
      const tail = tails.get(job.jobId) ?? { lines: [], before: null, reachedStart: false, frontier: 0 };
      while (tail.lines.length < size && !tail.reachedStart) {
        const page = source.before(job.jobId, tail.before, size - tail.lines.length);
        tail.frontier = page.frontier;
        tail.reachedStart = page.reachedStart;
        tail.before = page.through;
        tail.lines = [...page.rows.flatMap((row) => this.lines(job, row)), ...tail.lines];
      }
      tails.set(job.jobId, tail);
      return tail;
    };
    let level = Math.min(count, Math.floor(budget / pending.length));
    for (;;) {
      for (const job of pending) load(job, Math.max(1, level));
      const short = pending.filter(
        (job) => tailFor(job.jobId).reachedStart && tailFor(job.jobId).lines.length <= level,
      );
      const longCount = pending.length - short.length;
      const used = short.reduce((sum, job) => sum + tailFor(job.jobId).lines.length, 0);
      const next = longCount === 0 ? level : Math.min(count, Math.floor((budget - used) / longCount));
      if (next <= level) break;
      level = next;
    }
    const bytes = (k: number) =>
      pending.reduce(
        (sum, job) =>
          sum +
          tailFor(job.jobId)
            .lines.slice(-k || Infinity)
            .reduce((total, line) => total + Buffer.byteLength(shortenWaitLine(line.text)), 0),
        0,
      );
    while (level > 0 && bytes(level) > maxBytes) level--;
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

  select(
    sources: ReadonlyMap<string, ProgressSource>,
    budget: number,
    maxBytes: number,
  ): { lines: WaitProgressLine[]; exhaustedJobIds: string[] } {
    const selected: WaitProgressLine[] = [];
    const exhaustedJobIds: string[] = [];
    let bytes = 0;
    const epochOrder = [
      ...new Set(this.admissions.map((job) => job.epochKey).filter((key): key is string => key !== undefined)),
    ];
    for (const epoch of epochOrder) {
      const jobs = this.admissions.filter(
        (job) =>
          job.disposition === 'admitted' &&
          sameEpoch(job.epochKey, epoch) &&
          this.member(job.jobId).progress === 'unread' &&
          sources.has(job.epochKey as string),
      );
      const iterators = jobs.map((job) =>
        this.selectJob(
          job,
          sources.get(job.epochKey as string) as ProgressSource,
          Math.min(500, Math.ceil(budget / Math.max(1, jobs.length)) + 1),
          exhaustedJobIds,
          () => budget - selected.length,
        ),
      );
      const heads = iterators.map((iterator) => iterator.next());
      while (selected.length < budget) {
        let chosen = -1;
        for (let i = 0; i < heads.length; i++) {
          const head = heads[i];
          if (head.done) continue;
          const prior = chosen < 0 ? undefined : heads[chosen].value;
          if (
            !prior ||
            head.value.seq < prior.seq ||
            (head.value.seq === prior.seq && head.value.offset < prior.offset)
          )
            chosen = i;
        }
        if (chosen < 0) break;
        const head = heads[chosen];
        if (head.done) break;
        const line = head.value;
        const size = Buffer.byteLength(shortenWaitLine(line.text));
        if (bytes + size > maxBytes) return { lines: selected, exhaustedJobIds };
        selected.push(line);
        bytes += size;
        heads[chosen] = iterators[chosen].next();
      }
      if (selected.length === budget) break;
    }
    return { lines: selected, exhaustedJobIds };
  }

  private *selectJob(
    job: WaitAdmission,
    source: ProgressSource,
    rows: number,
    exhaustedJobIds: string[],
    remaining: () => number,
  ): Generator<WaitProgressLine> {
    const member = this.member(job.jobId);
    let entry = member.entry;
    for (;;) {
      const page = source.after(job.jobId, Math.max(0, entry.seq - Number(entry.lineOffset > 0)), rows);
      if (page.rows.length === 0) {
        if (page.exhausted) {
          exhaustedJobIds.push(job.jobId);
          return;
        }
        entry = { ...entry, seq: page.through, lineOffset: 0 };
        continue;
      }
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
        yield* lines;
      }
      if (page.exhausted) return;
      entry = { ...entry, seq: page.through, lineOffset: 0 };
      rows = Math.max(1, Math.min(500, remaining() + 1));
    }
  }

  preview(): WaitSession {
    const copy = new WaitSession(this.jobIds, this.input, this.activeEpochKey, this.internal);
    copy.admissions = this.admissions;
    copy.notices.push(...this.notices);
    for (const [id, member] of this.members) copy.members.set(id, { ...member });
    for (const [id, coverage] of this.coverage) copy.coverage.set(id, coverage);
    return copy;
  }

  observeEmpty(jobIds: readonly string[]): void {
    for (const jobId of jobIds) this.member(jobId).progress = 'exhausted';
  }

  consume(line: WaitProgressLine): void {
    const member = this.member(line.jobId);
    member.entry = { ...line.entryAfter, flags: member.entry.flags };
    member.progress = line.progressAfter;
  }
  hasProgress(): boolean {
    return [...this.members.values()].some((member) => member.progress === 'unread');
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
  cursor(jobIds: readonly string[] = this.jobIds): WaitCursorV3 {
    return {
      version: 'jobs.wait.v3',
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
