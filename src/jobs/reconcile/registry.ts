import type { JobLaunch, JobRuntime } from '../records.js';
import type { AbortResult } from '../contracts/abort-registry.js';

type RecoveryAbortAcceptedDisposition = Readonly<{ kind: 'accepted'; settlement?: undefined }>;
type RecoveryAbortRefusedDisposition = Readonly<{
  kind: 'refused';
  reason: string;
  nextStep?: string;
  settlement?: undefined;
}>;
type RecoveryAbortAbandonedDisposition = Readonly<{
  kind: 'abandoned';
  reason: string;
  nextStep: string;
  settlement?: undefined;
}>;
type RecoveryAbortSettledHoldDisposition = Readonly<{
  kind: 'held';
  reason: string;
  nextStep: string;
  settlement?: undefined;
}>;
type RecoveryAbortFinalizationPendingDisposition = Readonly<{
  kind: 'finalization-pending';
  reason: string;
  nextStep: string;
  settlement?: undefined;
}>;
type RecoveryAbortSettledDisposition =
  | RecoveryAbortAcceptedDisposition
  | RecoveryAbortRefusedDisposition
  | RecoveryAbortAbandonedDisposition
  | RecoveryAbortSettledHoldDisposition
  | RecoveryAbortFinalizationPendingDisposition;
type RecoveryAbortPendingDisposition = Readonly<{
  kind: 'held';
  reason: string;
  nextStep: string;
  settlement: Promise<RecoveryAbortSettledDisposition>;
}>;

export type RecoveryAbortDisposition = RecoveryAbortSettledDisposition | RecoveryAbortPendingDisposition;

export type ActiveRecoveryAbortDisposition =
  | RecoveryAbortRefusedDisposition
  | RecoveryAbortSettledHoldDisposition
  | RecoveryAbortFinalizationPendingDisposition
  | RecoveryAbortPendingDisposition;

export interface RecoveryEntry {
  launchRecord: JobLaunch;
  runtimeRecord?: JobRuntime;
}

export class RecoveryRegistry {
  private readonly entries = new Map<string, RecoveryEntry>();
  private readonly abortHandlers = new Map<string, () => RecoveryAbortDisposition>();
  private readonly abortDispositions = new Map<string, ActiveRecoveryAbortDisposition>();
  private readonly cancelledJobIds: Set<string>;

  constructor(cancelledJobIds: Set<string> = new Set()) {
    this.cancelledJobIds = cancelledJobIds;
  }

  register(
    jobId: string,
    launchRecord: JobLaunch,
    runtimeRecord?: JobRuntime,
    abortHandler?: () => RecoveryAbortDisposition,
  ): void {
    this.entries.set(jobId, { launchRecord, runtimeRecord });
    this.abortDispositions.delete(jobId);

    if (abortHandler) {
      this.abortHandlers.set(jobId, abortHandler);
      return;
    }
    this.abortHandlers.delete(jobId);
  }

  has(jobId: string): boolean {
    return this.entries.has(jobId);
  }

  get(jobId: string): RecoveryEntry | undefined {
    return this.entries.get(jobId);
  }

  setAbortHandler(jobId: string, abortHandler: () => RecoveryAbortDisposition): boolean {
    if (!this.entries.has(jobId)) return false;
    this.abortHandlers.set(jobId, abortHandler);
    this.abortDispositions.delete(jobId);
    return true;
  }

  getAbortDisposition(jobId: string): ActiveRecoveryAbortDisposition | undefined {
    return this.abortDispositions.get(jobId);
  }

  abort(jobIds: string[]): AbortResult {
    const aborted: string[] = [];
    const notFound: string[] = [];
    const refused: NonNullable<AbortResult['refused']> = [];
    const held: NonNullable<AbortResult['held']> = [];
    const abandoned: NonNullable<AbortResult['abandoned']> = [];
    for (const jobId of jobIds) {
      const entry = this.entries.get(jobId);
      if (!entry) {
        notFound.push(jobId);
        continue;
      }
      const abortHandler = this.abortHandlers.get(jobId);
      if (!abortHandler && entry.runtimeRecord !== undefined) {
        notFound.push(jobId);
        continue;
      }
      const disposition = this.abortDispositions.get(jobId) ?? abortHandler?.() ?? { kind: 'accepted' as const };
      if (disposition.kind === 'refused') {
        refused.push({
          jobId,
          reason: disposition.reason,
          nextStep:
            disposition.nextStep ??
            `Run coral-cli jobs detail ${jobId}; restore signal authorization or wait until the recorded ` +
              'containment is observed absent, then retry the abort.',
        });
        continue;
      }
      if (disposition.kind === 'abandoned') {
        this.remove(jobId);
        abandoned.push({ jobId, reason: disposition.reason, nextStep: disposition.nextStep });
        continue;
      }
      if (disposition.kind === 'finalization-pending') {
        this.abortDispositions.set(jobId, disposition);
        held.push({ jobId, reason: disposition.reason, nextStep: disposition.nextStep });
        continue;
      }
      if (disposition.kind === 'held') {
        const settlement = disposition.settlement;
        const activeDisposition: ActiveRecoveryAbortDisposition = {
          kind: 'held',
          reason: disposition.reason,
          nextStep: disposition.nextStep,
          ...(settlement === undefined ? {} : { settlement }),
        };
        this.abortDispositions.set(jobId, activeDisposition);
        if (settlement !== undefined) this.trackAbortSettlement(jobId, settlement);
        held.push({ jobId, reason: disposition.reason, nextStep: disposition.nextStep });
        continue;
      }
      this.cancelledJobIds.add(jobId);
      this.remove(jobId);
      aborted.push(jobId);
    }
    return {
      aborted,
      notFound,
      ...(refused.length === 0 ? {} : { refused }),
      ...(held.length === 0 ? {} : { held }),
      ...(abandoned.length === 0 ? {} : { abandoned }),
    };
  }

  private trackAbortSettlement(jobId: string, settlement: Promise<RecoveryAbortSettledDisposition>): void {
    void settlement.then(
      (disposition) => {
        if (this.abortDispositions.get(jobId)?.settlement !== settlement) return;
        if (disposition.kind === 'accepted') {
          this.cancelledJobIds.add(jobId);
          this.remove(jobId);
          return;
        }
        if (disposition.kind === 'abandoned') {
          this.remove(jobId);
          return;
        }
        this.abortDispositions.set(jobId, disposition);
      },
      (error: unknown) => {
        if (this.abortDispositions.get(jobId)?.settlement !== settlement) return;
        this.abortDispositions.set(jobId, {
          kind: 'refused',
          reason: error instanceof Error ? error.message : String(error),
          nextStep: `Run coral-cli jobs detail ${jobId}, repair the abort owner, then retry the abort.`,
        });
      },
    );
  }

  markCancelled(jobId: string): void {
    this.cancelledJobIds.add(jobId);
  }

  clearCancelled(jobId: string): void {
    this.cancelledJobIds.delete(jobId);
  }

  remove(jobId: string): void {
    this.entries.delete(jobId);
    this.abortHandlers.delete(jobId);
    this.abortDispositions.delete(jobId);
  }

  [Symbol.iterator](): IterableIterator<[string, RecoveryEntry]> {
    return this.entries.entries();
  }

  get size(): number {
    return this.entries.size;
  }

  entriesByProject(): Map<string, RecoveryEntry[]> {
    const byProject = new Map<string, RecoveryEntry[]>();
    for (const [, entry] of this.entries) {
      const key = entry.launchRecord.projectRoot;
      const existing = byProject.get(key);
      if (existing) {
        existing.push(entry);
      } else {
        byProject.set(key, [entry]);
      }
    }
    return byProject;
  }
}
