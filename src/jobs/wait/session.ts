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
  | 'scope-mismatch';

export type WaitAdmission = {
  jobId: string;
  disposition: WaitDisposition;
  message?: string;
  epochKey?: string;
  detail?: JobDetailResponse;
  availability?: ResultAvailability;
  continuity?: ContinuitySnapshot | null;
  progressLost?: boolean;
  progressUnknown?: boolean;
  queued?: Extract<WaitStreamEvent, { type: 'queued' }>;
};

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
  private readonly unreadByJob = new Map<string, number>();
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
    this.validateEpochTokens(admissions);
    this.admissions = admissions;
    for (const admission of admissions) {
      this.admissionById.set(admission.jobId, admission);
      this.reconcileMember(admission);
      const events = admission.detail?.events;
      const shape = `${admission.epochKey}:${events?.length}:${events?.at(-1)?.seq}:${admission.progressUnknown}`;
      if (this.historyShape.get(admission.jobId) !== shape) {
        this.historyShape.set(admission.jobId, shape);
        this.progressLines = undefined;
      }
    }
  }

  private validateEpochTokens(admissions: WaitAdmission[]): void {
    const tokens = new Map<string, string>();
    for (const admission of admissions) {
      if (!admission.epochKey) continue;
      const token = waitEpochToken(admission.epochKey);
      const previous = tokens.get(token);
      if (previous !== undefined && previous !== admission.epochKey)
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
        legacy.locations[jobId] !== epochKey)
    )
      throw new WaitSessionError('wait_cursor_mismatch', `Job ${jobId} changed epoch identity`);
    const unchanged =
      inputEpoch !== undefined ||
      (legacy?.version === 'jobs.wait.v2' && legacy.locations[jobId] === epochKey) ||
      (legacy?.version === undefined &&
        legacy !== undefined &&
        epochKey === this.activeEpochKey &&
        (this.internal ||
          legacy.afterSeq === 0 ||
          (legacy.admittedJobIds ?? legacy.deliveredJobIds)?.includes(jobId) === true));
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
          epochKey === this.activeEpochKey));
    if (affected && !this.internal) {
      this.progressLines = undefined;
      this.epochs.set(epochKey, { token, watermark: 0, lineOffset: 0 });
      const notice = `Collection membership changed for ${jobId}; earlier progress in this epoch may replay.`;
      if (!this.notices.includes(notice)) this.notices.push(notice);
    }
  }

  private reconcileMember(admission: WaitAdmission): void {
    const { jobId, epochKey, disposition } = admission;
    if (disposition !== 'admitted' || epochKey === undefined) {
      if (!this.members.has(jobId)) this.members.set(jobId, { acknowledged: false, artifactPending: false });
      return;
    }
    const previous = this.members.get(jobId);
    if (previous?.epochKey === epochKey) return;
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

  private indexProgress(): WaitProgressLine[] {
    if (this.progressLines !== undefined) return this.progressLines;
    const result: WaitProgressLine[] = [];
    this.unreadByJob.clear();
    for (const [epochKey, position] of this.epochs) {
      const lines: WaitProgressLine[] = [];
      for (const job of this.admissions) {
        if (job.disposition !== 'admitted' || job.epochKey !== epochKey) continue;
        const events = job.detail?.events ?? [];
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
        for (let index = low; index < events.length; index++) {
          const event = events[index];
          if (event.type !== 'progress') continue;
          const parts = splitWaitProgress(event.message);
          const first = event.seq === position.watermark ? position.lineOffset : 0;
          for (let offset = first; offset < parts.length; offset++) {
            lines.push({
              jobId: event.jobId,
              epochKey,
              seq: event.seq,
              offset,
              last: offset === parts.length - 1,
              text: shortenWaitLine(parts[offset]),
              timing: event.timing,
            });
            this.unreadByJob.set(job.jobId, (this.unreadByJob.get(job.jobId) ?? 0) + 1);
          }
        }
      }
      lines.sort((a, b) => a.seq - b.seq || a.offset - b.offset);
      if (!this.admissions.some((job) => job.epochKey === epochKey && job.progressUnknown))
        for (const line of lines) result.push(line);
    }
    this.progressLines = result;
    this.progressHead = 0;
    return result;
  }

  progress(): WaitProgressLine[] {
    return this.indexProgress().slice(this.progressHead);
  }

  hasProgress(): boolean {
    return this.progressHead < this.indexProgress().length;
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
      this.unreadByJob.set(line.jobId, (this.unreadByJob.get(line.jobId) ?? 1) - 1);
    } else this.progressLines = undefined;
  }
  requireLegacyReplaySupport(): void {
    if (this.notices.length > 0)
      throw new WaitSessionError(
        'wait_cursor_epoch_required',
        'Collection membership changed; rerun the wait without its cursor to collect earlier progress.',
      );
  }

  skipEarlierProgress(): void {
    this.progressLines = [];
    this.progressHead = 0;
    const blockedEpochs = new Set(this.admissions.filter((job) => job.progressUnknown).map((job) => job.epochKey));
    for (const job of this.admissions) if (!blockedEpochs.has(job.epochKey)) this.unreadByJob.delete(job.jobId);
    for (const admission of this.admissions) {
      if (!admission.epochKey || admission.disposition !== 'admitted') continue;
      if (blockedEpochs.has(admission.epochKey)) continue;
      const position = this.epochs.get(admission.epochKey);
      if (!position) continue;
      for (const event of admission.detail?.events ?? []) position.watermark = Math.max(position.watermark, event.seq);
      position.lineOffset = 0;
    }
  }
  remaining(): string[] {
    this.indexProgress();
    return this.admissions
      .filter(
        (job) =>
          job.disposition === 'discovery-unknown' ||
          (job.disposition === 'admitted' &&
            (!job.detail?.exit ||
              !this.acknowledged(job.jobId) ||
              this.artifactPending(job.jobId) ||
              job.progressUnknown === true ||
              (this.unreadByJob.get(job.jobId) ?? 0) > 0)),
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
    const keys: string[] = [];
    const jobs: WaitCursorV3['jobs'] = [];
    for (const jobId of jobIds) {
      const admission = this.admissionById.get(jobId);
      if (!admission || (admission.disposition !== 'admitted' && admission.disposition !== 'discovery-unknown'))
        continue;
      const member = this.members.get(jobId);
      if (admission.disposition === 'discovery-unknown') {
        jobs.push({ hash: waitJobHash(jobId), epoch: UNRESOLVED_EPOCH, flags: 0 });
        continue;
      }
      if (!member?.epochKey) continue;
      const epochKey = member.epochKey;
      const position = this.epochs.get(epochKey);
      if (!position) continue;
      if (!keys.includes(epochKey)) {
        keys.push(epochKey);
        epochs.push({ ...position });
      }
      jobs.push({
        hash: waitJobHash(jobId),
        epoch: keys.indexOf(epochKey),
        flags: (member.acknowledged ? ACKNOWLEDGED_FLAG : 0) | (member.artifactPending ? ARTIFACT_PENDING_FLAG : 0),
      });
    }
    return { version: 'jobs.wait.v3', epochs, jobs };
  }
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
        this.admissions.flatMap((job) =>
          job.disposition === 'admitted' && job.epochKey ? [[job.jobId, job.epochKey]] : [],
        ),
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
  let text = '';
  for (const char of line) {
    if (Buffer.byteLength(text) + Buffer.byteLength(char) > 4000) break;
    text += char;
  }
  return `${text}[line shortened: ${bytes - Buffer.byteLength(text)} bytes omitted]`;
}
