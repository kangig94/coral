import type BetterSqlite3 from 'better-sqlite3';

import { CoralSetupError } from '../runtime/errors.js';

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
  readonly reg: JournalConsumerRegistration;
  inFlight: Promise<void> | null;
  pendingTarget: number | null;
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

  constructor(opts: ConsumerDriverOptions) {
    this.db = opts.db;
    this.now = opts.now ?? (() => new Date());
  }

  register(reg: JournalConsumerRegistration): void {
    if (reg.authority !== 'journal') {
      throw new CoralSetupError({
        code: 'consumer_authority_unsupported',
        userMessage: `Consumer authority '${reg.authority}' not supported in Phase 1`,
        remediation: 'Only journal consumers are supported in Phase 1; corpus arrives in Phase 3.',
        context: { consumerId: reg.id, authority: reg.authority },
      });
    }

    this.ensureCursorRow(reg.id, 'journal');

    if (this.consumers.has(reg.id)) {
      return;
    }

    this.consumers.set(reg.id, {
      reg,
      inFlight: null,
      pendingTarget: null,
      waiters: new Set(),
    });
  }

  registerJournal(reg: JournalConsumerRegistration): void {
    this.register(reg);
  }

  notify(authority: Authority, version: number): void {
    if (authority !== 'journal') {
      throw new CoralSetupError({
        code: 'consumer_authority_unsupported',
        userMessage: `notify('${authority}', ...) not supported in Phase 1`,
        remediation: 'Only journal notifies are supported in Phase 1; corpus arrives in Phase 3.',
        context: { authority, version },
      });
    }

    for (const state of this.consumers.values()) {
      this.scheduleApply(state, version);
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

  private ensureCursorRow(consumerId: string, authority: Authority): void {
    const row = this.db
      .prepare('SELECT authority FROM equipment_cursors WHERE consumer_id = ?')
      .get(consumerId) as { authority: string } | undefined;

    if (row) {
      if (row.authority !== authority) {
        throw new CoralSetupError({
          code: 'consumer_authority_mismatch',
          userMessage: `Consumer '${consumerId}' registered with conflicting authority`,
          remediation: 'Either delete the stored cursor row or reconcile the registration.',
          context: { consumerId, existing: row.authority, requested: authority },
        });
      }

      return;
    }

    this.db
      .prepare('INSERT INTO equipment_cursors (consumer_id, authority, cursor, equipped_at) VALUES (?, ?, 0, ?)')
      .run(consumerId, authority, this.now().toISOString());
  }

  private scheduleApply(state: ConsumerState, target: number): void {
    if (state.inFlight) {
      state.pendingTarget = state.pendingTarget === null ? target : Math.max(state.pendingTarget, target);
      return;
    }

    state.inFlight = (async () => {
      const succeeded = await this.runApply(state, target);
      state.inFlight = null;

      if (!succeeded) {
        state.pendingTarget = null;
        return;
      }

      if (state.pendingTarget !== null) {
        const nextTarget = state.pendingTarget;
        state.pendingTarget = null;
        this.scheduleApply(state, nextTarget);
      }
    })();
  }

  private async runApply(state: ConsumerState, target: number): Promise<boolean> {
    const fromSeq = this.readCursor(state.reg.id);
    const upToSeq = Math.max(fromSeq, target);

    if (upToSeq <= fromSeq) {
      return true;
    }

    try {
      await state.reg.apply({ fromSeq, upToSeq, db: this.db });
      this.advanceCursor(state.reg.id, upToSeq);
      this.resolveWaiters(state, upToSeq);
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('ConsumerDriver apply failed', { consumerId: state.reg.id, err });
      return false;
    }
  }

  private readCursor(consumerId: string): number {
    const row = this.db
      .prepare('SELECT cursor FROM equipment_cursors WHERE consumer_id = ?')
      .get(consumerId) as { cursor: number } | undefined;

    return row?.cursor ?? 0;
  }

  private advanceCursor(consumerId: string, newCursor: number): void {
    this.db
      .prepare('UPDATE equipment_cursors SET cursor = ? WHERE consumer_id = ? AND cursor < ?')
      .run(newCursor, consumerId, newCursor);
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
