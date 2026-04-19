import type BetterSqlite3 from 'better-sqlite3';

import { CoralSetupError } from '../runtime/errors.js';
import type { KbCorpusSnapshot } from '../kb/api.js';
import { backendLog } from '../shared/backend-log.js';

export class FreshnessTimeout extends Error {
  constructor(consumerId: string, target: number, timeoutMs: number) {
    super(`waitFreshUntil timed out (consumer=${consumerId}, target=${target}, timeoutMs=${timeoutMs})`);
    this.name = 'FreshnessTimeout';
    Object.setPrototypeOf(this, FreshnessTimeout.prototype);
  }
}

export type Authority = 'journal' | 'corpus';
export type CorpusLane = 'content' | 'metadata';

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

export interface CorpusConsumerRegistration {
  readonly id: string;
  readonly authority: 'corpus';
  readonly lane: CorpusLane;
  apply(_ctx: { contentSeq: number; metadataSeq: number; db: BetterSqlite3.Database }): Promise<void>;
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
  pendingCorpusSnapshot: KbCorpusSnapshot | null;
  waiters: Set<Waiter>;
}

export interface ConsumerDriverOptions {
  readonly db: BetterSqlite3.Database;
  readonly now?: () => Date;
}

export class ConsumerDriver {
  private readonly db: BetterSqlite3.Database;
  private readonly now: () => Date;
  private readonly consumers = new Map<string, ConsumerState>();
  private readonly selectCursorMetadataStmt: BetterSqlite3.Statement<[string], { authority: string; lane: string | null }>;
  private readonly insertCursorRowStmt: BetterSqlite3.Statement<[string, Authority, CorpusLane | null, string]>;
  private readonly readCursorStmt: BetterSqlite3.Statement<[string], { cursor: number }>;
  private readonly advanceCursorStmt: BetterSqlite3.Statement<[number, CorpusLane | null, string, number]>;

  constructor(opts: ConsumerDriverOptions) {
    this.db = opts.db;
    this.now = opts.now ?? (() => new Date());
    this.selectCursorMetadataStmt = this.db.prepare<[string], { authority: string; lane: string | null }>(
      'SELECT authority, lane FROM equipment_cursors WHERE consumer_id = ?',
    );
    this.insertCursorRowStmt = this.db.prepare<[string, Authority, CorpusLane | null, string]>(
      'INSERT INTO equipment_cursors (consumer_id, authority, lane, cursor, equipped_at) VALUES (?, ?, ?, 0, ?)',
    );
    this.readCursorStmt = this.db.prepare<[string], { cursor: number }>(
      'SELECT cursor FROM equipment_cursors WHERE consumer_id = ?',
    );
    this.advanceCursorStmt = this.db.prepare<[number, CorpusLane | null, string, number]>(
      'UPDATE equipment_cursors SET cursor = ?, lane = ? WHERE consumer_id = ? AND cursor < ?',
    );
  }

  register(reg: JournalConsumerRegistration | CorpusConsumerRegistration): void {
    if (reg.authority === 'corpus' && (reg.lane !== 'content' && reg.lane !== 'metadata')) {
      throw new CoralSetupError({
        code: 'consumer_lane_invalid',
        userMessage: `Corpus consumer '${reg.id}' must declare a valid lane`,
        remediation: "Register corpus consumers with lane 'content' or 'metadata'.",
        context: { consumerId: reg.id, authority: reg.authority, lane: reg.lane },
      });
    }
    if (reg.authority === 'journal' && 'lane' in reg) {
      throw new CoralSetupError({
        code: 'consumer_lane_invalid',
        userMessage: `Journal consumer '${reg.id}' must not declare a corpus lane`,
        remediation: 'Remove the lane field from journal consumers.',
        context: { consumerId: reg.id, authority: reg.authority, lane: (reg as { lane?: unknown }).lane },
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
  notify(authority: 'corpus', snapshot: KbCorpusSnapshot, lane: CorpusLane): void;
  notify(authority: Authority, versionOrSnapshot: number | KbCorpusSnapshot, lane?: CorpusLane): void {
    if (authority === 'journal') {
      for (const state of this.consumers.values()) {
        if (state.reg.authority !== 'journal') {
          continue;
        }
        this.scheduleApply(state, versionOrSnapshot as number, null);
      }
      return;
    }

    if (lane !== 'content' && lane !== 'metadata') {
      throw new CoralSetupError({
        code: 'consumer_lane_invalid',
        userMessage: 'Corpus notifications require an explicit lane',
        remediation: "Call notify('corpus', snapshot, lane) with lane 'content' or 'metadata'.",
        context: { authority, lane },
      });
    }

    const snapshot = versionOrSnapshot as KbCorpusSnapshot;
    for (const state of this.consumers.values()) {
      if (state.reg.authority !== 'corpus' || state.reg.lane !== lane) {
        continue;
      }

      const target = lane === 'content' ? snapshot.contentSeq : snapshot.metadataSeq;
      this.scheduleApply(state, target, snapshot);
    }
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

    const current = this.readCursor(consumerId);
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
    const requestedLane = reg.authority === 'corpus' ? reg.lane : null;
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
      if ((row.lane ?? null) !== requestedLane) {
        throw new CoralSetupError({
          code: 'consumer_lane_mismatch',
          userMessage: `Consumer '${reg.id}' registered with conflicting corpus lane`,
          remediation: 'Either delete the stored cursor row or reconcile the lane registration.',
          context: { consumerId: reg.id, existing: row.lane ?? null, requested: requestedLane },
        });
      }

      return;
    }

    this.insertCursorRowStmt.run(reg.id, reg.authority, requestedLane, this.now().toISOString());
  }

  private scheduleApply(state: ConsumerState, target: number, snapshot: KbCorpusSnapshot | null): void {
    if (target <= this.readCursor(state.reg.id)) {
      return;
    }

    if (state.inFlight) {
      if (
        state.pendingTarget === null ||
        target > state.pendingTarget ||
        (target === state.pendingTarget && snapshot !== null)
      ) {
        state.pendingTarget = target;
        state.pendingCorpusSnapshot = snapshot;
      }
      return;
    }

    state.inFlight = (async () => {
      const succeeded = await this.runApply(state, target, snapshot);
      state.inFlight = null;

      if (!succeeded) {
        state.pendingTarget = null;
        state.pendingCorpusSnapshot = null;
        return;
      }

      if (state.pendingTarget !== null) {
        const nextTarget = state.pendingTarget;
        const nextSnapshot = state.pendingCorpusSnapshot;
        state.pendingTarget = null;
        state.pendingCorpusSnapshot = null;
        this.scheduleApply(state, nextTarget, nextSnapshot);
      }
    })();
  }

  private async runApply(state: ConsumerState, target: number, snapshot: KbCorpusSnapshot | null): Promise<boolean> {
    try {
      if (state.reg.authority === 'journal') {
        const fromSeq = this.readCursor(state.reg.id);
        const upToSeq = Math.max(fromSeq, target);

        if (upToSeq <= fromSeq) {
          return true;
        }

        await state.reg.apply({ fromSeq, upToSeq, db: this.db });
        this.advanceCursor(state.reg, upToSeq);
        this.resolveWaiters(state, upToSeq);
        return true;
      }

      const corpusSnapshot = snapshot ?? { contentSeq: target, metadataSeq: target };
      const fromSeq = this.readCursor(state.reg.id);
      const upToSeq = Math.max(
        fromSeq,
        state.reg.lane === 'content' ? corpusSnapshot.contentSeq : corpusSnapshot.metadataSeq,
      );

      if (upToSeq <= fromSeq) {
        return true;
      }

      await state.reg.apply({ ...corpusSnapshot, db: this.db });
      this.advanceCursor(state.reg, upToSeq);
      this.resolveWaiters(state, upToSeq);
      return true;
    } catch (err) {
      backendLog.error(`ConsumerDriver apply failed (${state.reg.id})`, err);
      return false;
    }
  }

  private readCursor(consumerId: string): number {
    const row = this.readCursorStmt.get(consumerId);
    return row?.cursor ?? 0;
  }

  private advanceCursor(reg: JournalConsumerRegistration | CorpusConsumerRegistration, newCursor: number): void {
    this.ensureCursorRow(reg);
    this.advanceCursorStmt.run(newCursor, reg.authority === 'corpus' ? reg.lane : null, reg.id, newCursor);
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
