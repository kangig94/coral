import { sameEpoch } from '../../store/epoch/identity.js';
import type { WaitCursor, ProgressSource } from './contract.js';
import { waitEpochPosition, UNPOSITIONED_FLAG } from './cursor.js';
import { WaitSessionError, type WaitSession, type WaitAdmission, type WaitProgressLine } from './session.js';

export class LegacyWaitDelivery {
  private readonly delivered = new Map<string, number>();
  private readonly locations = new Map<string, string>();
  private readonly session: WaitSession;
  private readonly activeEpoch: string;
  constructor(session: WaitSession, activeEpoch: string) {
    this.session = session;
    this.activeEpoch = activeEpoch;
  }

  reconcile(): void {
    const cursor = this.session.input;
    for (const job of this.session.admissions) {
      if (!job.epochKey) continue;
      this.locations.set(job.jobId, job.epochKey);
      const position =
        cursor?.version === 'jobs.wait.v2'
          ? (waitEpochPosition(cursor.positions, job.epochKey) ?? 0)
          : cursor?.version === undefined && cursor && sameEpoch(job.epochKey, this.activeEpoch)
            ? cursor.afterSeq
            : 0;
      if (position > 0 && (this.session.entry(job.jobId).flags & UNPOSITIONED_FLAG) !== 0)
        throw new WaitSessionError(
          'wait_cursor_epoch_required',
          'Collection membership changed; rerun without its cursor.',
        );
      if (!this.delivered.has(job.epochKey)) this.delivered.set(job.epochKey, position);
    }
  }

  sources(sources: ReadonlyMap<string, ProgressSource>): ReadonlyMap<string, ProgressSource> {
    return new Map(
      [...sources].filter(
        ([epoch]) =>
          !this.session.admissions.some(
            (job) => sameEpoch(epoch, job.epochKey) && this.session.progressState(job.jobId) === 'unknown',
          ),
      ),
    );
  }
  held(job: WaitAdmission): boolean {
    return this.session.admissions.some(
      (member) => sameEpoch(member.epochKey, job.epochKey) && this.session.progressState(member.jobId) === 'unknown',
    );
  }
  consume(line: WaitProgressLine): void {
    if (line.last) this.delivered.set(line.epochKey, line.seq);
  }
  terminal(job: WaitAdmission): void {
    if (job.epochKey)
      this.delivered.set(job.epochKey, Math.max(this.delivered.get(job.epochKey) ?? 0, job.detail?.terminalSeq ?? 0));
  }
  cursor(v2: false): Extract<WaitCursor, { afterSeq: number }>;
  cursor(v2: true): Extract<WaitCursor, { version: 'jobs.wait.v2' }>;
  cursor(v2: boolean): Exclude<WaitCursor, { version: 'jobs.wait.v3' }> {
    const deliveredJobIds = this.session.admissions
      .filter((job) => this.session.acknowledged(job.jobId))
      .map((job) => job.jobId);
    if (!v2)
      return {
        afterSeq: this.delivered.get(this.activeEpoch) ?? 0,
        deliveredJobIds,
        admittedJobIds: this.session.admissions.filter((job) => job.disposition === 'admitted').map((job) => job.jobId),
      };
    return {
      version: 'jobs.wait.v2',
      positions: Object.fromEntries(this.delivered),
      locations: Object.fromEntries(this.locations),
      deliveredJobIds,
    };
  }
}
