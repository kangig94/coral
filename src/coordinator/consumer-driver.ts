import type BetterSqlite3 from 'better-sqlite3';

import type {
  CorpusConsumerRegistration,
  CorpusInterest,
  CorpusLaneHint,
  KbCorpusSnapshot as CorpusSnapshot,
} from '../kb/api.js';
import { CoralSetupError } from '../runtime/errors.js';
import { backendLog } from '../shared/backend-log.js';

export type { CorpusConsumerRegistration, CorpusInterest, CorpusLaneHint };

export class FreshnessTimeout extends Error {
  constructor(consumerId: string, target: number, timeoutMs: number) {
    super(`waitFreshUntil timed out (consumer=${consumerId}, target=${target}, timeoutMs=${timeoutMs})`);
    this.name = 'FreshnessTimeout';
    Object.setPrototypeOf(this, FreshnessTimeout.prototype);
  }
}

export type Authority = 'journal' | 'corpus';

export interface JournalApplyContext {
  readonly fromSeq: number;
  readonly upToSeq: number;
  readonly db: BetterSqlite3.Database;
}

export interface JournalConsumerRegistration {
  readonly id: string;
  readonly authority: 'journal';
  /**
   * Idempotent apply. Architecture §16 invariant #44:
   * - ConsumerDriver does NOT wrap apply() in a transaction.
   * - apply() owns its own write atomicity.
   * - Cursor advances only on clean return; crash between apply commit and cursor update
   *   is tolerated because the same range re-applies on next start (upsert semantics).
   */
  apply(ctx: JournalApplyContext): Promise<void>;
}

interface Waiter {
  target: number;
  resolve: () => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
  settled: boolean;
}

interface ConsumerState {
  readonly reg: JournalConsumerRegistration | CorpusConsumerRegistration;
  inFlight: Promise<void> | null;
  pendingTarget: number | null;
  pendingCorpusSnapshot: CorpusSnapshot | null;
  waiters: Set<Waiter>;
}

interface StoredCursorMetadataRow {
  authority: string;
  lane: string | null;
  corpus_interest: string | null;
}

interface JournalCursorRow {
  cursor: number | null;
}

interface CorpusCursorRow {
  snapshot_id: string | null;
  content_seq: number | null;
  metadata_seq: number | null;
  content_manifest_hash: string | null;
  metadata_manifest_hash: string | null;
}

export interface ConsumerDriverOptions {
  readonly db: BetterSqlite3.Database;
  readonly now?: () => Date;
}

const EMPTY_CORPUS_CURSOR: CorpusSnapshot = {
  snapshotId: '',
  contentSeq: 0,
  metadataSeq: 0,
  contentManifestHash: '',
  metadataManifestHash: '',
};

function isCorpusInterest(value: unknown): value is CorpusInterest {
  return value === 'content' || value === 'metadata' || value === 'both';
}

function laneHintFromInterest(interest: CorpusInterest): CorpusLaneHint | null {
  return interest === 'both' ? null : interest;
}

function parseStoredCorpusInterest(row: StoredCursorMetadataRow): CorpusInterest | null {
  const raw = row.corpus_interest ?? row.lane;
  return isCorpusInterest(raw) ? raw : null;
}

function normalizeCorpusCursor(row: CorpusCursorRow | undefined): CorpusSnapshot {
  if (row === undefined) {
    return { ...EMPTY_CORPUS_CURSOR };
  }

  return {
    snapshotId: row.snapshot_id ?? '',
    contentSeq: row.content_seq ?? 0,
    metadataSeq: row.metadata_seq ?? 0,
    contentManifestHash: row.content_manifest_hash ?? '',
    metadataManifestHash: row.metadata_manifest_hash ?? '',
  };
}

function shouldNotifyCorpusConsumer(
  interest: CorpusInterest,
  laneHint: CorpusLaneHint | undefined,
): boolean {
  return laneHint === undefined || interest === 'both' || interest === laneHint;
}

function isSnapshotFresherForInterest(
  next: CorpusSnapshot,
  current: CorpusSnapshot,
  interest: CorpusInterest,
): boolean {
  if (interest === 'content') {
    return (
      next.contentSeq > current.contentSeq ||
      (next.contentSeq === current.contentSeq && next.contentManifestHash !== current.contentManifestHash)
    );
  }

  if (interest === 'metadata') {
    return (
      next.metadataSeq > current.metadataSeq ||
      (next.metadataSeq === current.metadataSeq && next.metadataManifestHash !== current.metadataManifestHash)
    );
  }

  return (
    next.contentSeq > current.contentSeq ||
    next.metadataSeq > current.metadataSeq ||
    (next.contentSeq === current.contentSeq &&
      next.metadataSeq === current.metadataSeq &&
      next.snapshotId !== current.snapshotId)
  );
}

export class ConsumerDriver {
  private readonly db: BetterSqlite3.Database;
  private readonly now: () => Date;
  private readonly consumers = new Map<string, ConsumerState>();
  private readonly selectCursorMetadataStmt: BetterSqlite3.Statement<[string], StoredCursorMetadataRow>;
  private readonly insertJournalCursorRowStmt: BetterSqlite3.Statement<[string, Authority, string]>;
  private readonly insertCorpusCursorRowStmt: BetterSqlite3.Statement<
    [string, Authority, CorpusLaneHint | null, CorpusInterest, string]
  >;
  private readonly readJournalCursorStmt: BetterSqlite3.Statement<[string], JournalCursorRow>;
  private readonly readCorpusCursorStmt: BetterSqlite3.Statement<[string], CorpusCursorRow>;
  private readonly advanceJournalCursorStmt: BetterSqlite3.Statement<[number, string, number]>;
  private readonly advanceContentCursorStmt: BetterSqlite3.Statement<
    [string, number, number, string, string, string, number, number, string]
  >;
  private readonly advanceMetadataCursorStmt: BetterSqlite3.Statement<
    [string, number, number, string, string, string, number, number, string]
  >;
  private readonly advanceBothCursorStmt: BetterSqlite3.Statement<
    [string, number, number, string, string, string, number, number, string]
  >;

  constructor(opts: ConsumerDriverOptions) {
    this.db = opts.db;
    this.now = opts.now ?? (() => new Date());
    this.selectCursorMetadataStmt = this.db.prepare<[string], StoredCursorMetadataRow>(
      'SELECT authority, lane, corpus_interest FROM equipment_cursors WHERE consumer_id = ?',
    );
    this.insertJournalCursorRowStmt = this.db.prepare<[string, Authority, string]>(
      'INSERT INTO equipment_cursors (consumer_id, authority, cursor, equipped_at) VALUES (?, ?, 0, ?)',
    );
    this.insertCorpusCursorRowStmt = this.db.prepare<
      [string, Authority, CorpusLaneHint | null, CorpusInterest, string]
    >(
      `
        INSERT INTO equipment_cursors (
          consumer_id,
          authority,
          lane,
          corpus_interest,
          cursor,
          snapshot_id,
          content_seq,
          metadata_seq,
          content_manifest_hash,
          metadata_manifest_hash,
          equipped_at
        ) VALUES (?, ?, ?, ?, NULL, '', 0, 0, '', '', ?)
      `,
    );
    this.readJournalCursorStmt = this.db.prepare<[string], JournalCursorRow>(
      'SELECT cursor FROM equipment_cursors WHERE consumer_id = ?',
    );
    this.readCorpusCursorStmt = this.db.prepare<[string], CorpusCursorRow>(
      `
        SELECT snapshot_id, content_seq, metadata_seq, content_manifest_hash, metadata_manifest_hash
          FROM equipment_cursors
         WHERE consumer_id = ?
      `,
    );
    this.advanceJournalCursorStmt = this.db.prepare<[number, string, number]>(
      'UPDATE equipment_cursors SET cursor = ? WHERE consumer_id = ? AND cursor < ?',
    );
    this.advanceContentCursorStmt = this.db.prepare<
      [string, number, number, string, string, string, number, number, string]
    >(
      `
        UPDATE equipment_cursors
           SET snapshot_id = ?,
               content_seq = ?,
               metadata_seq = ?,
               content_manifest_hash = ?,
               metadata_manifest_hash = ?
         WHERE consumer_id = ?
           AND (content_seq < ? OR (content_seq = ? AND content_manifest_hash != ?))
      `,
    );
    this.advanceMetadataCursorStmt = this.db.prepare<
      [string, number, number, string, string, string, number, number, string]
    >(
      `
        UPDATE equipment_cursors
           SET snapshot_id = ?,
               content_seq = ?,
               metadata_seq = ?,
               content_manifest_hash = ?,
               metadata_manifest_hash = ?
         WHERE consumer_id = ?
           AND (metadata_seq < ? OR (metadata_seq = ? AND metadata_manifest_hash != ?))
      `,
    );
    this.advanceBothCursorStmt = this.db.prepare<
      [string, number, number, string, string, string, number, number, string]
    >(
      `
        UPDATE equipment_cursors
           SET snapshot_id = ?,
               content_seq = ?,
               metadata_seq = ?,
               content_manifest_hash = ?,
               metadata_manifest_hash = ?
         WHERE consumer_id = ?
           AND (content_seq < ? OR metadata_seq < ? OR snapshot_id != ?)
      `,
    );
  }

  register(reg: JournalConsumerRegistration | CorpusConsumerRegistration): void {
    if ('lane' in reg && (reg as { lane?: unknown }).lane !== undefined) {
      throw new CoralSetupError({
        code: 'consumer_lane_invalid',
        userMessage: `Consumer '${reg.id}' must not declare a corpus lane`,
        remediation: "Use corpusInterest on the registration; lane is only an internal routing hint on notify().",
        context: { consumerId: reg.id, authority: reg.authority, lane: (reg as { lane?: unknown }).lane },
      });
    }
    if (reg.authority === 'corpus' && !isCorpusInterest(reg.corpusInterest)) {
      throw new CoralSetupError({
        code: 'consumer_interest_invalid',
        userMessage: `Corpus consumer '${reg.id}' must declare a valid corpus interest`,
        remediation: "Register corpus consumers with corpusInterest 'content', 'metadata', or 'both'.",
        context: { consumerId: reg.id, authority: reg.authority, corpusInterest: reg.corpusInterest },
      });
    }
    if (reg.authority === 'journal' && 'corpusInterest' in reg) {
      throw new CoralSetupError({
        code: 'consumer_interest_invalid',
        userMessage: `Journal consumer '${reg.id}' must not declare a corpus interest`,
        remediation: 'Remove the corpusInterest field from journal consumers.',
        context: {
          consumerId: reg.id,
          authority: reg.authority,
          corpusInterest: (reg as { corpusInterest?: unknown }).corpusInterest,
        },
      });
    }

    this.ensureCursorRow(reg);

    if (this.consumers.has(reg.id)) {
      return;
    }

    this.consumers.set(reg.id, {
      reg,
      inFlight: null,
      pendingTarget: null,
      pendingCorpusSnapshot: null,
      waiters: new Set(),
    });
  }

  notify(authority: 'journal', version: number): void;
  notify(authority: 'corpus', snapshot: CorpusSnapshot, laneHint?: CorpusLaneHint): void;
  notify(authority: Authority, versionOrSnapshot: number | CorpusSnapshot, laneHint?: CorpusLaneHint): void {
    if (authority === 'journal') {
      for (const state of this.consumers.values()) {
        if (state.reg.authority !== 'journal') {
          continue;
        }
        this.scheduleJournalApply(state, versionOrSnapshot as number);
      }
      return;
    }

    if (laneHint !== undefined && laneHint !== 'content' && laneHint !== 'metadata') {
      throw new CoralSetupError({
        code: 'consumer_lane_invalid',
        userMessage: 'Corpus notifications require a valid routing hint when lane is provided',
        remediation: "Call notify('corpus', snapshot, laneHint) with laneHint 'content' or 'metadata', or omit it.",
        context: { authority, laneHint },
      });
    }

    const snapshot = versionOrSnapshot as CorpusSnapshot;
    for (const state of this.consumers.values()) {
      if (state.reg.authority !== 'corpus') {
        continue;
      }
      if (!shouldNotifyCorpusConsumer(state.reg.corpusInterest, laneHint)) {
        continue;
      }
      this.scheduleCorpusApply(state, snapshot);
    }
  }

  notifyCorpus(snapshot: CorpusSnapshot, laneHint?: CorpusLaneHint): void {
    this.notify('corpus', snapshot, laneHint);
  }

  waitFreshUntil(target: number, consumerId: string, timeoutMs = 30000): Promise<void> {
    const state = this.consumers.get(consumerId);
    if (!state) {
      throw new CoralSetupError({
        code: 'consumer_not_registered',
        userMessage: `Consumer '${consumerId}' is not registered`,
        remediation: 'Call driver.register(reg) before waitFreshUntil.',
        context: { consumerId },
      });
    }
    if (state.reg.authority !== 'journal') {
      throw new CoralSetupError({
        code: 'consumer_wait_unsupported',
        userMessage: `Consumer '${consumerId}' uses snapshot freshness and cannot wait on a numeric cursor`,
        remediation: 'Use waitFreshUntil only with journal consumers.',
        context: { consumerId, authority: state.reg.authority },
      });
    }

    const current = this.readJournalCursor(consumerId);
    if (current >= target) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        target,
        resolve,
        reject,
        timeoutHandle: setTimeout(() => {
          if (waiter.settled) {
            return;
          }

          waiter.settled = true;
          state.waiters.delete(waiter);
          waiter.reject(new FreshnessTimeout(consumerId, target, timeoutMs));
        }, timeoutMs),
        settled: false,
      };

      state.waiters.add(waiter);
    });
  }

  async drainAll(): Promise<void> {
    while (true) {
      const pending = [...this.consumers.values()]
        .map((state) => state.inFlight)
        .filter((promise): promise is Promise<void> => promise !== null);

      if (pending.length === 0) {
        return;
      }

      await Promise.allSettled(pending);
    }
  }

  async shutdown(): Promise<void> {
    await this.drainAll();

    for (const state of this.consumers.values()) {
      for (const waiter of [...state.waiters]) {
        if (waiter.settled) {
          continue;
        }

        waiter.settled = true;
        clearTimeout(waiter.timeoutHandle);
        state.waiters.delete(waiter);
        waiter.reject(new Error('ConsumerDriver shutting down'));
      }
    }

    this.consumers.clear();
  }

  __debugWaiterCount(consumerId: string): number {
    return this.consumers.get(consumerId)?.waiters.size ?? 0;
  }

  private ensureCursorRow(reg: JournalConsumerRegistration | CorpusConsumerRegistration): void {
    const row = this.selectCursorMetadataStmt.get(reg.id);

    if (row) {
      if (row.authority !== reg.authority) {
        throw new CoralSetupError({
          code: 'consumer_authority_mismatch',
          userMessage: `Consumer '${reg.id}' registered with conflicting authority`,
          remediation: 'Either delete the stored cursor row or reconcile the registration.',
          context: { consumerId: reg.id, existing: row.authority, requested: reg.authority },
        });
      }
      if (reg.authority === 'corpus') {
        const storedInterest = parseStoredCorpusInterest(row);
        if (storedInterest !== reg.corpusInterest) {
          throw new CoralSetupError({
            code: 'consumer_interest_mismatch',
            userMessage: `Consumer '${reg.id}' registered with conflicting corpus interest`,
            remediation: 'Either delete the stored cursor row or reconcile the corpusInterest registration.',
            context: { consumerId: reg.id, existing: storedInterest, requested: reg.corpusInterest },
          });
        }
      }

      return;
    }

    if (reg.authority === 'journal') {
      this.insertJournalCursorRowStmt.run(reg.id, reg.authority, this.now().toISOString());
      return;
    }

    this.insertCorpusCursorRowStmt.run(
      reg.id,
      reg.authority,
      laneHintFromInterest(reg.corpusInterest),
      reg.corpusInterest,
      this.now().toISOString(),
    );
  }

  private scheduleJournalApply(state: ConsumerState, target: number): void {
    if (state.reg.authority !== 'journal') {
      return;
    }
    if (target <= this.readJournalCursor(state.reg.id)) {
      return;
    }

    if (state.inFlight) {
      if (state.pendingTarget === null || target > state.pendingTarget) {
        state.pendingTarget = target;
      }
      return;
    }

    state.inFlight = (async () => {
      const succeeded = await this.runJournalApply(state, target);
      state.inFlight = null;

      if (!succeeded) {
        state.pendingTarget = null;
        return;
      }

      if (state.pendingTarget !== null) {
        const nextTarget = state.pendingTarget;
        state.pendingTarget = null;
        this.scheduleJournalApply(state, nextTarget);
      }
    })();
  }

  private scheduleCorpusApply(state: ConsumerState, snapshot: CorpusSnapshot): void {
    if (state.reg.authority !== 'corpus') {
      return;
    }
    if (!isSnapshotFresherForInterest(snapshot, this.readCorpusCursor(state.reg.id), state.reg.corpusInterest)) {
      return;
    }

    if (state.inFlight) {
      if (
        state.pendingCorpusSnapshot === null ||
        isSnapshotFresherForInterest(snapshot, state.pendingCorpusSnapshot, state.reg.corpusInterest)
      ) {
        state.pendingCorpusSnapshot = { ...snapshot };
      }
      return;
    }

    state.inFlight = (async () => {
      const succeeded = await this.runCorpusApply(state, snapshot);
      state.inFlight = null;

      if (!succeeded) {
        state.pendingCorpusSnapshot = null;
        return;
      }

      if (state.pendingCorpusSnapshot !== null) {
        const nextSnapshot = state.pendingCorpusSnapshot;
        state.pendingCorpusSnapshot = null;
        this.scheduleCorpusApply(state, nextSnapshot);
      }
    })();
  }

  private async runJournalApply(state: ConsumerState, target: number): Promise<boolean> {
    try {
      if (state.reg.authority !== 'journal') {
        return true;
      }

      const fromSeq = this.readJournalCursor(state.reg.id);
      const upToSeq = Math.max(fromSeq, target);

      if (upToSeq <= fromSeq) {
        return true;
      }

      await state.reg.apply({ fromSeq, upToSeq, db: this.db });
      this.advanceJournalCursor(state.reg, upToSeq);
      this.resolveWaiters(state, upToSeq);
      return true;
    } catch (err) {
      backendLog.error(`ConsumerDriver apply failed (${state.reg.id})`, err);
      return false;
    }
  }

  private async runCorpusApply(state: ConsumerState, snapshot: CorpusSnapshot): Promise<boolean> {
    try {
      if (state.reg.authority !== 'corpus') {
        return true;
      }

      const current = this.readCorpusCursor(state.reg.id);
      if (!isSnapshotFresherForInterest(snapshot, current, state.reg.corpusInterest)) {
        return true;
      }

      await state.reg.apply({ snapshot, db: this.db });
      this.advanceCorpusCursor(state.reg, snapshot);
      return true;
    } catch (err) {
      backendLog.error(`ConsumerDriver apply failed (${state.reg.id})`, err);
      return false;
    }
  }

  private readJournalCursor(consumerId: string): number {
    const row = this.readJournalCursorStmt.get(consumerId);
    return row?.cursor ?? 0;
  }

  private readCorpusCursor(consumerId: string): CorpusSnapshot {
    return normalizeCorpusCursor(this.readCorpusCursorStmt.get(consumerId));
  }

  private advanceJournalCursor(reg: JournalConsumerRegistration, newCursor: number): void {
    this.ensureCursorRow(reg);
    this.advanceJournalCursorStmt.run(newCursor, reg.id, newCursor);
  }

  private advanceCorpusCursor(reg: CorpusConsumerRegistration, snapshot: CorpusSnapshot): void {
    this.ensureCursorRow(reg);

    if (reg.corpusInterest === 'content') {
      this.advanceContentCursorStmt.run(
        snapshot.snapshotId,
        snapshot.contentSeq,
        snapshot.metadataSeq,
        snapshot.contentManifestHash,
        snapshot.metadataManifestHash,
        reg.id,
        snapshot.contentSeq,
        snapshot.contentSeq,
        snapshot.contentManifestHash,
      );
      return;
    }

    if (reg.corpusInterest === 'metadata') {
      this.advanceMetadataCursorStmt.run(
        snapshot.snapshotId,
        snapshot.contentSeq,
        snapshot.metadataSeq,
        snapshot.contentManifestHash,
        snapshot.metadataManifestHash,
        reg.id,
        snapshot.metadataSeq,
        snapshot.metadataSeq,
        snapshot.metadataManifestHash,
      );
      return;
    }

    this.advanceBothCursorStmt.run(
      snapshot.snapshotId,
      snapshot.contentSeq,
      snapshot.metadataSeq,
      snapshot.contentManifestHash,
      snapshot.metadataManifestHash,
      reg.id,
      snapshot.contentSeq,
      snapshot.metadataSeq,
      snapshot.snapshotId,
    );
  }

  private resolveWaiters(state: ConsumerState, newCursor: number): void {
    for (const waiter of [...state.waiters]) {
      if (!waiter.settled && waiter.target <= newCursor) {
        waiter.settled = true;
        state.waiters.delete(waiter);
        clearTimeout(waiter.timeoutHandle);
        waiter.resolve();
      }
    }
  }
}
