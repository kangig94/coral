import { sameEpoch } from '../../store/epoch/identity.js';
import type { JobDetailResponse, JobProgressEvent, JobTerminal } from '../records.js';
import type { ContinuitySnapshot } from '../../sessions/continuity.js';
import type { ResultAvailability } from '../terminal/export.js';
import type { WaitCursor, WaitCursorV3, WaitStreamEvent } from './contract.js';
import { ACKNOWLEDGED_FLAG, ARTIFACT_PENDING_FLAG, UNRESOLVED_EPOCH, waitEpochToken, waitJobHash } from './cursor.js';

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
  detail?: JobDetailResponse;
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
};
export type WaitTerminalSummary = {
  seq: number;
  outcomeKind: JobTerminal['outcome']['kind'];
  exitCode: number;
  durationMs: number;
  contentPreview: string;
  contentOmittedBytes: number;
  diagnosticPreview: string;
  diagnosticOmittedBytes: number;
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

/** Consumption is a prefix of an epoch, restricted to the cursor's recorded members. */
export class WaitSession {
  admissions: WaitAdmission[] = [];
  readonly notices: string[] = [];
  private readonly epochs = new Map<string, { token: string; watermark: number; lineOffset: number }>();
  private readonly members = new Map<string, { epochKey?: string; acknowledged: boolean; artifactPending: boolean }>();
  private progressLines: WaitProgressLine[] | undefined;
  private progressHead = 0;
  private progressComplete = false;
  private readonly admissionById = new Map<string, WaitAdmission>();
  private readonly historyShape = new Map<string, string>();
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
      throw new WaitSessionError(
        'wait_cursor_mismatch',
        'Each job ID must appear only once; remove duplicate or conflicting job IDs.',
      );
  }

  reconcile(admissions: WaitAdmission[]): void {
    const epochKeys = [...this.epochs.keys()];
    admissions = admissions.map((job) => {
      if (job.epochKey) {
        const canonical = epochKeys.find((key) => sameEpoch(key, job.epochKey));
        if (canonical) job = { ...job, epochKey: canonical };
        else epochKeys.push(job.epochKey);
      }
      const previous = this.admissionById.get(job.jobId);
      if (job.observationDeferred && previous) return previous;
      if (job.disposition !== 'discovery-unknown' || job.epochKey) return job;
      const saved =
        this.input?.version === 'jobs.wait.v3'
          ? this.input.jobs.find((entry) => entry.hash === waitJobHash(job.jobId))
          : undefined;
      const token =
        this.input?.version === 'jobs.wait.v3' && saved && saved.epoch !== UNRESOLVED_EPOCH
          ? this.input.epochs[saved.epoch]?.token
          : undefined;
      const epochKey =
        this.members.get(job.jobId)?.epochKey ??
        (this.input?.version === 'jobs.wait.v2' ? this.input.locations[job.jobId] : undefined) ??
        admissions.find((member) => member.epochKey && sameEpoch(waitEpochToken(member.epochKey), token))?.epochKey ??
        [...this.epochs].find(([, position]) => position.token === token)?.[0];
      return epochKey ? { ...job, epochKey } : job;
    });
    this.validateEpochTokens(admissions);
    this.admissions = admissions;
    for (const admission of admissions) {
      this.admissionById.set(admission.jobId, admission);
      this.reconcileMember(admission);
      const events = admission.detail?.events;
      const shape = `${admission.epochKey}:${events?.length}:${events?.at(-1)?.seq}:${sourceReadDisposition(admission)}`;
      if (this.historyShape.get(admission.jobId) !== shape) {
        this.historyShape.set(admission.jobId, shape);
        this.progressLines = undefined;
      }
    }
    for (const job of admissions) {
      if (!this.progressHeld(job)) continue;
      const { jobId, epochKey, message } = job;
      const notice = `Earlier progress for ${jobId} is held: epoch ${epochKey ? waitEpochToken(epochKey) : 'unknown'} cannot be read right now${message ? ` (${message})` : ''}. Epoch maintenance probes it every 5 s and settles after 3 failed probes; bounded waits retry after 250 ms, 1 s and 5 s, then exit 75 with a continuation. Snapshots return immediately with a continuation.`;
      if (!this.notices.includes(notice)) this.notices.push(notice);
    }
  }

  progressHeld(job: WaitAdmission): boolean {
    return (
      job.epochKey !== undefined &&
      this.admissions.some(
        (member) =>
          sameEpoch(member.epochKey, job.epochKey) &&
          (member.disposition === 'discovery-unknown' || sourceReadDisposition(member) === 'transient-unknown'),
      )
    );
  }

  allRemainingProgressUnknown(): boolean {
    const remaining = this.remaining();
    return (
      remaining.length > 0 &&
      remaining.every((id) => {
        const job = this.admissionById.get(id);
        return job?.disposition === 'discovery-unknown' || (job !== undefined && this.progressHeld(job));
      })
    );
  }

  private validateEpochTokens(admissions: WaitAdmission[]): void {
    const tokens = new Map<string, string>();
    for (const admission of admissions) {
      if (!admission.epochKey) continue;
      const token = waitEpochToken(admission.epochKey);
      const previous = tokens.get(token);
      if (previous !== undefined && !sameEpoch(previous, admission.epochKey))
        throw new WaitSessionError('wait_cursor_mismatch', 'Ambiguous epoch token');
      tokens.set(token, admission.epochKey);
    }
  }

  private inputMembership(jobId: string, epochKey: string) {
    const token = waitEpochToken(epochKey);
    const inputJob =
      this.input?.version === 'jobs.wait.v3'
        ? this.input.jobs.find((job) => job.hash === waitJobHash(jobId))
        : undefined;
    const inputEpoch =
      this.internal && this.input?.version === 'jobs.wait.v3'
        ? this.input.epochs.find((epoch) => epoch.token === token)
        : this.input?.version === 'jobs.wait.v3' && inputJob && inputJob.epoch !== UNRESOLVED_EPOCH
          ? this.input.epochs[inputJob.epoch]
          : undefined;
    const legacy = this.input?.version !== 'jobs.wait.v3' ? this.input : undefined;
    if (
      (inputEpoch && inputEpoch.token !== token) ||
      (legacy?.version === 'jobs.wait.v2' &&
        legacy.locations[jobId] !== undefined &&
        !sameEpoch(legacy.locations[jobId], epochKey))
    )
      throw new WaitSessionError('wait_cursor_mismatch', `Job ${jobId} changed epoch identity`);
    const unchanged =
      inputEpoch !== undefined ||
      (legacy?.version === 'jobs.wait.v2' && sameEpoch(legacy.locations[jobId], epochKey)) ||
      (legacy?.version === undefined &&
        legacy !== undefined &&
        sameEpoch(epochKey, this.activeEpochKey) &&
        (this.internal ||
          legacy.afterSeq === 0 ||
          legacy.admittedJobIds === undefined ||
          legacy.admittedJobIds?.includes(jobId) === true));
    const inputPosition =
      inputEpoch ??
      (legacy?.version === 'jobs.wait.v2' && legacy.positions[epochKey] !== undefined
        ? { watermark: legacy.positions[epochKey], lineOffset: 0 }
        : legacy?.version === undefined && legacy !== undefined
          ? { watermark: legacy.afterSeq, lineOffset: 0 }
          : undefined);
    return { token, inputJob, legacy, unchanged, inputPosition };
  }

  private reconcileEpoch(jobId: string, epochKey: string, input: ReturnType<WaitSession['inputMembership']>): void {
    const { token, legacy, unchanged, inputPosition } = input;
    if (!this.epochs.has(epochKey))
      this.epochs.set(epochKey, {
        token,
        watermark: unchanged || this.internal ? (inputPosition?.watermark ?? 0) : 0,
        lineOffset: unchanged || this.internal ? (inputPosition?.lineOffset ?? 0) : 0,
      });
    const affected =
      !unchanged &&
      ((this.epochs.get(epochKey)?.watermark ?? 0) > 0 ||
        (this.input?.version === 'jobs.wait.v3' && this.input.epochs.some((epoch) => epoch.token === token)) ||
        (legacy?.version === 'jobs.wait.v2' && legacy.positions[epochKey] !== undefined) ||
        (legacy?.version === undefined &&
          legacy !== undefined &&
          legacy.afterSeq > 0 &&
          sameEpoch(epochKey, this.activeEpochKey)));
    if (affected && !this.internal) {
      this.progressLines = undefined;
      this.epochs.set(epochKey, { token, watermark: 0, lineOffset: 0 });
      const notice = `Collection membership changed for ${jobId}; earlier progress in this epoch may replay.`;
      if (!this.notices.includes(notice)) this.notices.push(notice);
    }
  }

  private reconcileMember(admission: WaitAdmission): void {
    const { jobId, epochKey, disposition } = admission;
    if ((disposition !== 'admitted' && disposition !== 'discovery-unknown') || epochKey === undefined) {
      if (!this.members.has(jobId)) this.members.set(jobId, { acknowledged: false, artifactPending: false });
      return;
    }
    const previous = this.members.get(jobId);
    if (sameEpoch(previous?.epochKey, epochKey)) return;
    const input = this.inputMembership(jobId, epochKey);
    this.reconcileEpoch(jobId, epochKey, input);
    const { inputJob, legacy } = input;
    this.members.set(jobId, {
      epochKey,
      acknowledged:
        (previous?.epochKey === undefined ? undefined : previous.acknowledged) ??
        (inputJob !== undefined
          ? (inputJob.flags & ACKNOWLEDGED_FLAG) !== 0
          : (legacy?.deliveredJobIds?.includes(jobId) ?? false)),
      artifactPending:
        (previous?.epochKey === undefined ? undefined : previous.artifactPending) ??
        (inputJob !== undefined
          ? (inputJob.flags & ARTIFACT_PENDING_FLAG) !== 0
          : legacy?.deliveredJobIds?.includes(jobId) === true && admission.availability?.kind === 'repair-pending'),
    });
    if (!admission.detail?.exit) this.coverage.set(jobId, { kind: 'unknown', frontier: 0 });
  }

  observeCoverage(jobIds: readonly string[], unknownJobIds: readonly string[], frontier: number): void {
    for (const jobId of jobIds)
      this.coverage.set(jobId, { kind: unknownJobIds.includes(jobId) ? 'unknown' : 'live', frontier });
  }

  carrierCoverage(): ReadonlyMap<string, { kind: 'live' | 'absent' | 'unknown'; frontier: number }> {
    return this.coverage;
  }
  observeAbsent(jobId: string, frontier: number): void {
    this.coverage.set(jobId, { kind: 'absent', frontier });
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
  acknowledged(jobId: string): boolean {
    return this.members.get(jobId)?.acknowledged === true;
  }
  artifactPending(jobId: string): boolean {
    return this.members.get(jobId)?.artifactPending === true;
  }

  acknowledge(admission: WaitAdmission): void {
    const member = this.members.get(admission.jobId);
    if (!member) return;
    member.acknowledged = true;
    member.artifactPending = !this.internal && admission.availability?.kind === 'repair-pending';
  }
  settleArtifact(jobId: string): void {
    const member = this.members.get(jobId);
    if (member) member.artifactPending = false;
  }

  private firstUnread(job: WaitAdmission): number {
    const events = job.detail?.events ?? [];
    const position = this.epochs.get(job.epochKey ?? '');
    if (!position) return events.length;
    let low = 0;
    let high = events.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (
        events[middle].seq < position.watermark ||
        (events[middle].seq === position.watermark && position.lineOffset === 0)
      )
        low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private jobHasProgress(job: WaitAdmission): boolean {
    if (job.disposition !== 'admitted' || !job.epochKey || this.progressHeld(job)) return false;
    const events = job.detail?.events ?? [];
    for (let i = this.firstUnread(job); i < events.length; i++) {
      const event = events[i];
      if (event.type === 'progress') return true;
    }
    return false;
  }

  private *jobProgress(job: WaitAdmission, tail?: number): Generator<WaitProgressLine> {
    if (job.disposition !== 'admitted' || !job.epochKey || this.progressHeld(job)) return;
    const events = job.detail?.events ?? [];
    const position = this.epochs.get(job.epochKey);
    if (!position) return;
    const first = this.firstUnread(job);
    let count = 0;
    for (
      let index = tail === undefined ? first : events.length - 1;
      index >= first && index < events.length;
      index += tail === undefined ? 1 : -1
    ) {
      const event = events[index];
      if (event.type !== 'progress') continue;
      const parts = splitWaitProgress(event.message);
      const start = event.seq === position.watermark ? position.lineOffset : 0;
      for (
        let offset = tail === undefined ? start : parts.length - 1;
        offset >= start && offset < parts.length;
        offset += tail === undefined ? 1 : -1
      ) {
        yield {
          jobId: job.jobId,
          epochKey: job.epochKey,
          seq: event.seq,
          offset,
          last: offset === parts.length - 1,
          text: parts[offset],
          timing: event.timing,
        };
        if (tail !== undefined && ++count === tail) return;
      }
    }
  }

  progress(limit = Infinity): WaitProgressLine[] {
    if (
      this.progressLines !== undefined &&
      (this.progressComplete || this.progressLines.length - this.progressHead >= limit)
    )
      return this.progressLines.slice(this.progressHead, this.progressHead + limit);
    const result: WaitProgressLine[] = [];
    for (const epochKey of this.epochs.keys()) {
      const iterators = this.admissions
        .filter((job) => sameEpoch(job.epochKey, epochKey))
        .map((job) => this.jobProgress(job));
      const heads = iterators.map((iterator) => iterator.next());
      while (result.length < limit) {
        let selected = -1;
        let selectedLine: WaitProgressLine | undefined;
        for (let i = 0; i < heads.length; i++) {
          const head = heads[i];
          if (!head.done && (!selectedLine || head.value.seq < selectedLine.seq)) {
            selected = i;
            selectedLine = head.value;
          }
        }
        if (!selectedLine) break;
        result.push(selectedLine);
        heads[selected] = iterators[selected].next();
      }
      if (result.length === limit) break;
    }
    this.progressComplete = result.length < limit;
    this.progressLines = result;
    this.progressHead = 0;
    return result;
  }

  tailProgress(count: number): WaitProgressLine[] {
    if (count === 0) return [];
    return this.admissions
      .flatMap((job) => [...this.jobProgress(job, count)].reverse())
      .sort((a, b) => a.epochKey.localeCompare(b.epochKey) || a.seq - b.seq || a.offset - b.offset);
  }

  hasProgressBefore(lines: readonly WaitProgressLine[]): boolean {
    return this.admissions.some((job) => {
      const first = this.jobProgress(job).next();
      if (first.done) return false;
      const selected = lines.find((line) => line.jobId === job.jobId);
      return (
        !selected ||
        first.value.seq < selected.seq ||
        (first.value.seq === selected.seq && first.value.offset < selected.offset)
      );
    });
  }

  selectTailProgress(count: number, maxLines: number, maxBytes: number): WaitProgressLine[] {
    const available = this.tailProgress(Math.min(count, maxLines));
    const totals = new Map<string, number>();
    for (const line of available) totals.set(line.jobId, (totals.get(line.jobId) ?? 0) + 1);
    const select = (limit: number): WaitProgressLine[] => {
      const seen = new Map<string, number>();
      return available.filter((line) => {
        const ordinal = (seen.get(line.jobId) ?? 0) + 1;
        seen.set(line.jobId, ordinal);
        return ordinal > (totals.get(line.jobId) ?? 0) - limit;
      });
    };
    let low = 0;
    let high = Math.min(count, maxLines);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = select(middle);
      if (
        candidate.length <= maxLines &&
        candidate.reduce((sum, line) => sum + Buffer.byteLength(shortenWaitLine(line.text)), 0) <= maxBytes
      )
        low = middle;
      else high = middle - 1;
    }
    return select(low);
  }

  private tailDelivery = false;
  startAtTail(count: number, maxLines: number, maxBytes: number): void {
    const tail = this.selectTailProgress(count, maxLines, maxBytes);
    if (this.hasProgressBefore(tail)) this.notices.push('Earlier progress outside the selected tail was not shown.');
    this.progressLines = tail;
    this.progressHead = 0;
    this.progressComplete = true;
    this.tailDelivery = true;
    if (tail.length === 0) this.skipEarlierProgress();
    else this.skipProgressBefore(tail);
  }

  hasProgress(): boolean {
    return this.admissions.some((job) => this.jobHasProgress(job));
  }
  restoreProgress(cursor: WaitCursorV3): void {
    this.progressLines = undefined;
    for (const position of this.epochs.values()) {
      const saved = cursor.epochs.find((epoch) => epoch.token === position.token);
      if (saved) {
        position.watermark = saved.watermark;
        position.lineOffset = saved.lineOffset;
      }
    }
  }
  consume(line: WaitProgressLine): void {
    const position = this.epochs.get(line.epochKey);
    if (!position) return;
    position.watermark = line.seq;
    position.lineOffset = line.last ? 0 : line.offset + 1;
    if (this.progressLines?.[this.progressHead] === line) {
      this.progressHead++;
      if (this.tailDelivery && this.progressHead === this.progressLines.length) {
        this.tailDelivery = false;
        this.skipEarlierProgress();
      }
    } else this.progressLines = undefined;
  }
  requireLegacyReplaySupport(): void {
    if (this.notices.some((notice) => notice.startsWith('Collection membership changed')))
      throw new WaitSessionError(
        'wait_cursor_epoch_required',
        'Collection membership changed; rerun the wait without its cursor to collect earlier progress.',
      );
  }

  skipProgressBefore(lines: readonly WaitProgressLine[]): void {
    for (const [epochKey, position] of this.epochs) {
      const first = lines.find((line) => line.epochKey === epochKey);
      if (!first) continue;
      position.watermark = Math.max(0, first.seq - (first.offset === 0 ? 1 : 0));
      position.lineOffset = first.offset;
    }
  }

  skipEarlierProgress(): void {
    this.progressLines = [];
    this.progressHead = 0;
    const blockedEpochs = new Set(this.admissions.filter((job) => this.progressHeld(job)).map((job) => job.epochKey));
    for (const admission of this.admissions) {
      if (!admission.epochKey || admission.disposition !== 'admitted') continue;
      if (blockedEpochs.has(admission.epochKey)) continue;
      const position = this.epochs.get(admission.epochKey);
      if (!position) continue;
      position.watermark = Math.max(position.watermark, admission.detail?.events.at(-1)?.seq ?? 0);
      position.lineOffset = 0;
    }
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
              this.progressHeld(job) ||
              this.jobHasProgress(job))),
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
    return this.remaining().length > 0 || this.unknownCarriers().length > 0 ? 75 : 0;
  }
  cursor(jobIds: readonly string[] = this.jobIds): WaitCursorV3 {
    const epochs: WaitCursorV3['epochs'] = [];
    const jobs: WaitCursorV3['jobs'] = [];
    for (const jobId of jobIds) {
      const admission = this.admissionById.get(jobId);
      if (!admission || (admission.disposition !== 'admitted' && admission.disposition !== 'discovery-unknown'))
        continue;
      const member = this.members.get(jobId);
      if (admission.disposition === 'discovery-unknown' && !member?.epochKey) {
        const inputJob =
          this.input?.version === 'jobs.wait.v3'
            ? this.input.jobs.find((job) => job.hash === waitJobHash(jobId))
            : undefined;
        const saved =
          this.input?.version === 'jobs.wait.v3' && inputJob && inputJob.epoch !== UNRESOLVED_EPOCH
            ? this.input.epochs[inputJob.epoch]
            : undefined;
        if (saved && inputJob) {
          let ordinal = epochs.findIndex((epoch) => epoch.token === saved.token);
          if (ordinal === -1) {
            ordinal = epochs.length;
            epochs.push({ ...([...this.epochs.values()].find((position) => position.token === saved.token) ?? saved) });
          }
          jobs.push({ hash: inputJob.hash, epoch: ordinal, flags: inputJob.flags });
        } else jobs.push({ hash: waitJobHash(jobId), epoch: UNRESOLVED_EPOCH, flags: 0 });
        continue;
      }
      if (!member?.epochKey) continue;
      const epochKey = member.epochKey;
      const position = this.epochs.get(epochKey);
      if (!position) continue;
      if (!epochs.some((epoch) => epoch.token === position.token)) {
        epochs.push({ ...position });
      }
      jobs.push({
        hash: waitJobHash(jobId),
        epoch: epochs.findIndex((epoch) => epoch.token === position.token),
        flags: (member.acknowledged ? ACKNOWLEDGED_FLAG : 0) | (member.artifactPending ? ARTIFACT_PENDING_FLAG : 0),
      });
    }
    return { version: 'jobs.wait.v3', epochs, jobs };
  }
  legacyCursor(v2: false): Extract<WaitCursor, { afterSeq: number }>;
  legacyCursor(v2: true): Extract<WaitCursor, { version: 'jobs.wait.v2' }>;
  legacyCursor(v2: boolean): Exclude<WaitCursor, WaitCursorV3> {
    const deliveredJobIds = this.admissions.filter((job) => this.acknowledged(job.jobId)).map((job) => job.jobId);
    if (!v2)
      return {
        afterSeq: this.epochs.get(this.activeEpochKey ?? '')?.watermark ?? 0,
        deliveredJobIds,
        admittedJobIds: this.admissions.filter((job) => job.disposition === 'admitted').map((job) => job.jobId),
      };
    return {
      version: 'jobs.wait.v2',
      positions: Object.fromEntries([...this.epochs].map(([key, value]) => [key, value.watermark])),
      locations: Object.fromEntries(
        this.admissions.flatMap((job) => {
          const epochKey = this.members.get(job.jobId)?.epochKey;
          return (job.disposition === 'admitted' || job.disposition === 'discovery-unknown') && epochKey !== undefined
            ? [[job.jobId, epochKey]]
            : [];
        }),
      ),
      deliveredJobIds,
    };
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
