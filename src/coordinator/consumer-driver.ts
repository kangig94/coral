import type BetterSqlite3 from 'better-sqlite3';

import type {
  CorpusConsumerRegistration,
  CorpusInterest,
  CorpusLaneHint,
  KbCorpusSnapshot as CorpusSnapshot,
} from '../kb/contracts.js';
import { CoralSetupError } from '../runtime/errors.js';
import { backendLog } from '../shared/backend-log.js';
import { isSnapshotFresherForInterest, normalizeCorpusCursor } from '../store/corpus-state.js';

export type { CorpusConsumerRegistration, CorpusInterest, CorpusLaneHint };

export class FreshnessTimeout extends Error {
  constructor(consumerId: string, target: number, timeoutMs: number) {
    super(`waitFreshUntil timed out (consumer=${consumerId}, target=${target}, timeoutMs=${timeoutMs})`);
    this.name = 'FreshnessTimeout';
    Object.setPrototypeOf(this, FreshnessTimeout.prototype);
  }
}

export type Authority = 'journal' | 'corpus';
export type ConsumerRegistrationKind = 'base' | 'equipment';

export interface ConsumerApplyError {
  readonly message: string;
  readonly at: string;
  readonly cause?: unknown;
}

export type ConsumerHandleStatus =
  | {
      authority: 'journal';
      cursor: number;
      pending: boolean;
      lastApplyError: ConsumerApplyError | null;
    }
  | {
      authority: 'corpus';
      snapshotId: string | null;
      contentSeq: number;
      contentManifestHash: string | null;
      pending: boolean;
      lastApplyError: ConsumerApplyError | null;
    };

export interface ConsumerHandle {
  readonly id: string;
  readonly registrationKind: ConsumerRegistrationKind;
  stop(): Promise<void>;
  unregister(): Promise<void>;
  status(): ConsumerHandleStatus;
}

export interface JournalApplyContext {
  readonly fromSeq: number;
  readonly upToSeq: number;
  readonly db: BetterSqlite3.Database;
}

export interface JournalConsumerRegistration {
  readonly id: string;
  readonly authority: 'journal';
  readonly registrationKind?: ConsumerRegistrationKind;
  readonly onApplyFailure?: (err: ConsumerApplyError) => void;
  /**
   * Idempotent apply. Architecture §16 invariant #44:
   * - ConsumerDriver does NOT wrap apply() in a transaction.
   * - apply() owns its own write atomicity.
   * - Cursor advances only on clean return; crash between apply commit and cursor update
   *   is tolerated because the same range re-applies on next start (upsert semantics).
   */
  apply(ctx: JournalApplyContext): Promise<void>;
}

type ConsumerRegistration = JournalConsumerRegistration | CorpusConsumerRegistration;

interface Waiter {
  target: number;
  resolve: () => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
  settled: boolean;
}

interface ConsumerState {
  readonly reg: ConsumerRegistration;
  readonly handle: ConsumerHandle;
  readonly registrationKind: ConsumerRegistrationKind;
  inFlight: Promise<void> | null;
  pendingTarget: number | null;
  pendingCorpusSnapshot: CorpusSnapshot | null;
  waiters: Set<Waiter>;
  stopped: boolean;
  stopPromise: Promise<void> | null;
  unregistered: boolean;
  lastApplyError: ConsumerApplyError | null;
}

interface StoredCursorMetadataRow {
  authority: string;
  lane: string | null;
  corpus_interest: string | null;
  registration_kind: string | null;
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

export interface UnregisterStoppedConsumerOptions {
  readonly preserveCursor?: boolean;
}

function isCorpusInterest(value: unknown): value is CorpusInterest {
  return value === 'content' || value === 'metadata' || value === 'both';
}

function isRegistrationKind(value: unknown): value is ConsumerRegistrationKind {
  return value === 'base' || value === 'equipment';
}

function laneHintFromInterest(interest: CorpusInterest): CorpusLaneHint | null {
  return interest === 'both' ? null : interest;
}

function parseStoredCorpusInterest(row: StoredCursorMetadataRow): CorpusInterest | null {
  const raw = row.corpus_interest ?? row.lane;
  return isCorpusInterest(raw) ? raw : null;
}

function shouldNotifyCorpusConsumer(
  interest: CorpusInterest,
  laneHint: CorpusLaneHint | undefined,
): boolean {
  return laneHint === undefined || interest === 'both' || interest === laneHint;
}

function toConsumerApplyError(err: unknown, at: string): ConsumerApplyError {
  if (err instanceof Error && err.message.trim().length > 0) {
    return { message: err.message, at, cause: err };
  }
  if (typeof err === 'string' && err.trim().length > 0) {
    return { message: err, at, cause: err };
  }
  return { message: 'Consumer apply failed', at, cause: err };
}

export class ConsumerDriver {
  private readonly db: BetterSqlite3.Database;
  private readonly now: () => Date;
  private readonly consumers = new Map<string, ConsumerState>();
  private readonly selectCursorMetadataStmt: BetterSqlite3.Statement<[string], StoredCursorMetadataRow>;
  private readonly insertJournalCursorRowStmt: BetterSqlite3.Statement<
    [string, Authority, string, ConsumerRegistrationKind]
  >;
  private readonly insertCorpusCursorRowStmt: BetterSqlite3.Statement<
    [string, Authority, CorpusLaneHint | null, CorpusInterest, string, ConsumerRegistrationKind]
  >;
  private readonly updateRegistrationKindStmt: BetterSqlite3.Statement<[ConsumerRegistrationKind, string]>;
  private readonly deleteCursorRowStmt: BetterSqlite3.Statement<[string]>;
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
      'SELECT authority, lane, corpus_interest, registration_kind FROM equipment_cursors WHERE consumer_id = ?',
    );
    this.insertJournalCursorRowStmt = this.db.prepare<[string, Authority, string, ConsumerRegistrationKind]>(
      `
        INSERT INTO equipment_cursors (
          consumer_id,
          authority,
          cursor,
          equipped_at,
          registration_kind
        ) VALUES (?, ?, 0, ?, ?)
      `,
    );
    this.insertCorpusCursorRowStmt = this.db.prepare<
      [string, Authority, CorpusLaneHint | null, CorpusInterest, string, ConsumerRegistrationKind]
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
          equipped_at,
          registration_kind
        ) VALUES (?, ?, ?, ?, NULL, '', 0, 0, '', '', ?, ?)
      `,
    );
    this.updateRegistrationKindStmt = this.db.prepare<[ConsumerRegistrationKind, string]>(
      'UPDATE equipment_cursors SET registration_kind = ? WHERE consumer_id = ?',
    );
    this.deleteCursorRowStmt = this.db.prepare<[string]>('DELETE FROM equipment_cursors WHERE consumer_id = ?');
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

  register(reg: ConsumerRegistration): ConsumerHandle {
    this.assertValidRegistration(reg);

    const existing = this.consumers.get(reg.id);
    if (existing) {
      this.assertExistingRegistrationMatches(existing, reg);
      const row = this.selectCursorMetadataStmt.get(reg.id);
      if (row) {
        const storedKind = this.ensureCursorRow(reg, false);
        if (storedKind !== existing.registrationKind) {
          throw new CoralSetupError({
            code: 'consumer_registration_kind_mismatch',
            userMessage: `Consumer '${reg.id}' registered with conflicting registration kind`,
            remediation: 'Either delete the stored cursor row or reconcile the registrationKind.',
            context: { consumerId: reg.id, existing: storedKind, requested: existing.registrationKind },
          });
        }
      } else {
        this.insertCursorRow(reg, existing.registrationKind);
      }
      return existing.handle;
    }

    const registrationKind = this.ensureCursorRow(reg);
    // eslint-disable-next-line prefer-const -- state is assigned below after handle construction due to mutual reference
    let state!: ConsumerState;
    const handle: ConsumerHandle = {
      id: reg.id,
      registrationKind,
      stop: () => this.stopConsumer(state, new Error(`Consumer '${reg.id}' stopped`)),
      unregister: () => this.unregisterConsumer(state),
      status: () => this.statusFor(state),
    };

    state = {
      reg,
      handle,
      registrationKind,
      inFlight: null,
      pendingTarget: null,
      pendingCorpusSnapshot: null,
      waiters: new Set(),
      stopped: false,
      stopPromise: null,
      unregistered: false,
      lastApplyError: null,
    };

    this.consumers.set(reg.id, state);
    return handle;
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
    const states = [...this.consumers.values()];
    await Promise.all(states.map((state) => this.stopConsumer(state, new Error('ConsumerDriver shutting down'))));
    this.consumers.clear();
  }

  unregisterStoppedConsumer(consumerId: string, options: UnregisterStoppedConsumerOptions = {}): void {
    const state = this.consumers.get(consumerId);
    if (!state) {
      throw new CoralSetupError({
        code: 'consumer_not_registered',
        userMessage: `Consumer '${consumerId}' is not registered`,
        remediation: 'Call driver.register(reg) before unregisterStoppedConsumer.',
        context: { consumerId },
      });
    }

    if (state.stopPromise === null) {
      throw new CoralSetupError({
        code: 'consumer_unregister_requires_stop',
        userMessage: `Consumer '${state.reg.id}' must be stopped before unregister()`,
        remediation: 'Call handle.stop() and await it before removing the stopped consumer.',
        context: { consumerId },
      });
    }

    this.finalizeStoppedConsumer(state, options);
  }

  __debugWaiterCount(consumerId: string): number {
    return this.consumers.get(consumerId)?.waiters.size ?? 0;
  }

  private assertValidRegistration(reg: ConsumerRegistration): void {
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
    if (reg.registrationKind !== undefined && !isRegistrationKind(reg.registrationKind)) {
      throw new CoralSetupError({
        code: 'consumer_registration_kind_invalid',
        userMessage: `Consumer '${reg.id}' must declare registrationKind 'base' or 'equipment'`,
        remediation: "Set registrationKind to 'base' or 'equipment', or omit it for the default base behavior.",
        context: { consumerId: reg.id, registrationKind: reg.registrationKind },
      });
    }
  }

  private assertExistingRegistrationMatches(state: ConsumerState, reg: ConsumerRegistration): void {
    if (state.reg.authority !== reg.authority) {
      throw new CoralSetupError({
        code: 'consumer_authority_mismatch',
        userMessage: `Consumer '${reg.id}' registered with conflicting authority`,
        remediation: 'Either delete the stored cursor row or reconcile the registration.',
        context: { consumerId: reg.id, existing: state.reg.authority, requested: reg.authority },
      });
    }

    if (state.reg.authority === 'corpus' && reg.authority === 'corpus' && state.reg.corpusInterest !== reg.corpusInterest) {
      throw new CoralSetupError({
        code: 'consumer_interest_mismatch',
        userMessage: `Consumer '${reg.id}' registered with conflicting corpus interest`,
        remediation: 'Either delete the stored cursor row or reconcile the corpusInterest registration.',
        context: { consumerId: reg.id, existing: state.reg.corpusInterest, requested: reg.corpusInterest },
      });
    }

    if (reg.registrationKind !== undefined && state.registrationKind !== reg.registrationKind) {
      throw new CoralSetupError({
        code: 'consumer_registration_kind_mismatch',
        userMessage: `Consumer '${reg.id}' registered with conflicting registration kind`,
        remediation: 'Either stop and unregister the active consumer or reconcile the registrationKind.',
        context: { consumerId: reg.id, existing: state.registrationKind, requested: reg.registrationKind },
      });
    }
  }

  private ensureCursorRow(reg: ConsumerRegistration, allowRegistrationKindUpdate = true): ConsumerRegistrationKind {
    const row = this.selectCursorMetadataStmt.get(reg.id);
    const requestedKind = reg.registrationKind;

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

      const storedKind = this.parseStoredRegistrationKind(reg.id, row.registration_kind);
      if (requestedKind !== undefined && storedKind !== requestedKind) {
        if (!allowRegistrationKindUpdate) {
          throw new CoralSetupError({
            code: 'consumer_registration_kind_mismatch',
            userMessage: `Consumer '${reg.id}' registered with conflicting registration kind`,
            remediation: 'Either delete the stored cursor row or reconcile the registrationKind.',
            context: { consumerId: reg.id, existing: storedKind, requested: requestedKind },
          });
        }
        this.updateRegistrationKindStmt.run(requestedKind, reg.id);
        return requestedKind;
      }

      return storedKind;
    }

    const registrationKind = requestedKind ?? 'base';
    this.insertCursorRow(reg, registrationKind);
    return registrationKind;
  }

  private insertCursorRow(reg: ConsumerRegistration, registrationKind: ConsumerRegistrationKind): void {
    const nowIso = this.now().toISOString();
    if (reg.authority === 'journal') {
      this.insertJournalCursorRowStmt.run(reg.id, reg.authority, nowIso, registrationKind);
      return;
    }

    this.insertCorpusCursorRowStmt.run(
      reg.id,
      reg.authority,
      laneHintFromInterest(reg.corpusInterest),
      reg.corpusInterest,
      nowIso,
      registrationKind,
    );
  }

  private parseStoredRegistrationKind(
    consumerId: string,
    registrationKind: string | null | undefined,
  ): ConsumerRegistrationKind {
    const value = registrationKind ?? 'base';
    if (isRegistrationKind(value)) {
      return value;
    }

    throw new CoralSetupError({
      code: 'consumer_registration_kind_invalid',
      userMessage: `Consumer '${consumerId}' has an invalid stored registration kind`,
      remediation: "Update the stored cursor row so registration_kind is 'base' or 'equipment'.",
      context: { consumerId, registrationKind: value },
    });
  }

  private scheduleJournalApply(state: ConsumerState, target: number): void {
    if (state.stopped || state.reg.authority !== 'journal') {
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

      if (state.stopped) {
        state.pendingTarget = null;
        return;
      }

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
    if (state.stopped || state.reg.authority !== 'corpus') {
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

      if (state.stopped) {
        state.pendingCorpusSnapshot = null;
        return;
      }

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
      state.lastApplyError = null;
      this.resolveWaiters(state, upToSeq);
      return true;
    } catch (err) {
      const applyError = toConsumerApplyError(err, this.now().toISOString());
      state.lastApplyError = applyError;
      this.invokeApplyFailureCallback(state, applyError);
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
      state.lastApplyError = null;
      return true;
    } catch (err) {
      const applyError = toConsumerApplyError(err, this.now().toISOString());
      state.lastApplyError = applyError;
      this.invokeApplyFailureCallback(state, applyError);
      backendLog.error(`ConsumerDriver apply failed (${state.reg.id})`, err);
      return false;
    }
  }

  private invokeApplyFailureCallback(state: ConsumerState, applyError: ConsumerApplyError): void {
    if (state.reg.onApplyFailure === undefined) {
      return;
    }

    try {
      state.reg.onApplyFailure(applyError);
    } catch (callbackErr) {
      backendLog.error(`ConsumerDriver onApplyFailure failed (${state.reg.id})`, callbackErr);
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

  private async stopConsumer(state: ConsumerState, waiterError: Error): Promise<void> {
    if (state.stopPromise !== null) {
      return state.stopPromise;
    }

    state.stopped = true;
    state.stopPromise = (async () => {
      await state.inFlight;
      state.pendingTarget = null;
      state.pendingCorpusSnapshot = null;
      this.rejectWaiters(state, waiterError);
    })();

    return state.stopPromise;
  }

  private async unregisterConsumer(state: ConsumerState): Promise<void> {
    if (state.unregistered) {
      return;
    }
    if (state.stopPromise === null) {
      throw new CoralSetupError({
        code: 'consumer_unregister_requires_stop',
        userMessage: `Consumer '${state.reg.id}' must be stopped before unregister()`,
        remediation: 'Call handle.stop() and await it before handle.unregister().',
        context: { consumerId: state.reg.id },
      });
    }

    await state.stopPromise;
    this.finalizeStoppedConsumer(state);
  }

  private finalizeStoppedConsumer(
    state: ConsumerState,
    options: UnregisterStoppedConsumerOptions = {},
  ): void {
    if (state.unregistered) {
      return;
    }

    if (this.consumers.get(state.reg.id) === state) {
      this.consumers.delete(state.reg.id);
    }
    if (state.registrationKind === 'equipment' && options.preserveCursor !== true) {
      this.deleteCursorRowStmt.run(state.reg.id);
    }

    state.unregistered = true;
  }

  private statusFor(state: ConsumerState): ConsumerHandleStatus {
    if (state.reg.authority === 'journal') {
      return {
        authority: 'journal',
        cursor: this.readJournalCursor(state.reg.id),
        pending: this.isPending(state),
        lastApplyError: state.lastApplyError,
      };
    }

    const cursor = this.readCorpusCursor(state.reg.id);
    return {
      authority: 'corpus',
      snapshotId: cursor.snapshotId === '' ? null : cursor.snapshotId,
      contentSeq: cursor.contentSeq,
      contentManifestHash: cursor.contentManifestHash === '' ? null : cursor.contentManifestHash,
      pending: this.isPending(state),
      lastApplyError: state.lastApplyError,
    };
  }

  private isPending(state: ConsumerState): boolean {
    return state.inFlight !== null || state.pendingTarget !== null || state.pendingCorpusSnapshot !== null;
  }

  private rejectWaiters(state: ConsumerState, err: Error): void {
    for (const waiter of [...state.waiters]) {
      if (waiter.settled) {
        continue;
      }

      waiter.settled = true;
      clearTimeout(waiter.timeoutHandle);
      state.waiters.delete(waiter);
      waiter.reject(err);
    }
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
