import type BetterSqlite3 from 'better-sqlite3';

import type { CorpusConsumerRegistration, CorpusInterest, CorpusLaneHint, KbCorpusSnapshot } from '../kb/contracts.js';
import type { ConsumerApplyError, ConsumerRegistrationKind } from '../store/consumer-contract.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import { backendLog } from '../infra/backend-log.js';
import { nowDate } from '../infra/time.js';
import { isSnapshotFresherForInterest, normalizeCorpusCursor } from '../kb/state/corpus-state.js';
import {
  consumerAuthorityMismatchError,
  consumerInterestMismatchError,
  consumerNotRegisteredError,
  consumerRegistrationKindMismatchError,
  isCorpusInterest,
  isKbCorpusSnapshot,
  isRegistrationKind,
  laneHintFromInterest,
  parseStoredCorpusInterest,
  renderConsumerId,
  shouldNotifyCorpusConsumer,
  toConsumerApplyError,
} from './consumer-driver/support.js';

export type { CorpusConsumerRegistration, CorpusInterest, CorpusLaneHint } from '../kb/contracts.js';
export type { ConsumerApplyError, ConsumerRegistrationKind } from '../store/consumer-contract.js';

export class FreshnessTimeout extends Error {
  constructor(consumerId: string, target: number | KbCorpusSnapshot, timeoutMs: number) {
    const renderedTarget =
      typeof target === 'number' ? String(target) : `${target.snapshotId}:${target.contentSeq}/${target.metadataSeq}`;
    super(`waitFreshUntil timed out (consumer=${consumerId}, target=${renderedTarget}, timeoutMs=${timeoutMs})`);
    this.name = 'FreshnessTimeout';
    Object.setPrototypeOf(this, FreshnessTimeout.prototype);
  }
}

export type Authority = 'journal' | 'corpus';

export type ConsumerHandleStatus =
  | {
      authority: 'journal';
      cursor: number;
      pending: boolean;
      lastApplyError: ConsumerApplyError | null;
    }
  | {
      authority: 'corpus';
      corpusInterest: CorpusInterest;
      snapshotId: string | null;
      contentSeq: number;
      metadataSeq: number;
      contentManifestHash: string | null;
      metadataManifestHash: string | null;
      pending: boolean;
      lastApplyError: ConsumerApplyError | null;
    };

export interface ConsumerHandle {
  readonly id: string;
  readonly registrationKind: ConsumerRegistrationKind;
  readonly lastApplyError: ConsumerApplyError | null;
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
  target: number | KbCorpusSnapshot;
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
  pendingCorpusSnapshot: KbCorpusSnapshot | null;
  waiters: Set<Waiter>;
  stopped: boolean;
  stopPromise: Promise<void> | null;
  unregistered: boolean;
  lastApplyError: ConsumerApplyError | null;
}

interface CursorMetadataRow {
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

export class ConsumerDriver {
  private readonly db: BetterSqlite3.Database;
  private readonly now: () => Date;
  private readonly consumers = new Map<string, ConsumerState>();
  private readonly selectCursorMetadataStmt: BetterSqlite3.Statement<[string], CursorMetadataRow>;
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
    this.now = opts.now ?? (() => nowDate());
    this.selectCursorMetadataStmt = this.db.prepare<[string], CursorMetadataRow>(
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
        const storedKind = this.ensureCursorRow(reg, false, row);
        if (storedKind !== existing.registrationKind) {
          throw consumerRegistrationKindMismatchError(reg.id, existing.registrationKind, storedKind);
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
      get lastApplyError() {
        return state.lastApplyError;
      },
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
  notify(authority: 'corpus', snapshot: KbCorpusSnapshot, laneHint?: CorpusLaneHint): void;
  notify(authority: Authority, versionOrSnapshot: number | KbCorpusSnapshot, laneHint?: CorpusLaneHint): void {
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
      throw documentedCoralSetupError('consumer_lane_invalid', { id: 'notify(corpus)' });
    }

    const snapshot = versionOrSnapshot as KbCorpusSnapshot;
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

  notifyCorpus(snapshot: KbCorpusSnapshot, laneHint?: CorpusLaneHint): void {
    this.notify('corpus', snapshot, laneHint);
  }

  waitFreshUntil(authority: 'journal', target: number, consumerId: string, timeoutMs?: number): Promise<void>;
  waitFreshUntil(authority: 'corpus', target: KbCorpusSnapshot, consumerId: string, timeoutMs?: number): Promise<void>;
  waitFreshUntil(
    authority: Authority,
    target: number | KbCorpusSnapshot,
    consumerId: string,
    timeoutMs = 30000,
  ): Promise<void> {
    if (consumerId.length === 0) {
      throw documentedCoralSetupError('consumer_not_registered', { id: renderConsumerId(consumerId) });
    }

    const state = this.consumers.get(consumerId);
    if (!state) {
      throw consumerNotRegisteredError(consumerId);
    }
    if (state.reg.authority !== authority) {
      throw consumerAuthorityMismatchError(consumerId, authority, state.reg.authority);
    }

    if (authority === 'journal') {
      if (typeof target !== 'number') {
        throw documentedCoralSetupError('consumer_wait_unsupported', { id: consumerId });
      }
      const current = this.readJournalCursor(consumerId);
      if (current >= target) {
        return Promise.resolve();
      }
    } else {
      if (!isKbCorpusSnapshot(target)) {
        throw documentedCoralSetupError('consumer_wait_unsupported', { id: consumerId });
      }
      const current = this.readCorpusCursor(consumerId);
      if (this.corpusTargetReached(state, target, current)) {
        return Promise.resolve();
      }
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
      throw consumerNotRegisteredError(consumerId);
    }

    if (state.stopPromise === null) {
      throw documentedCoralSetupError('consumer_unregister_requires_stop', { id: consumerId });
    }

    this.finalizeStoppedConsumer(state, options);
  }

  private assertValidRegistration(reg: ConsumerRegistration): void {
    const regLike = reg as { id?: unknown; authority?: unknown };
    if (regLike.authority !== 'journal' && regLike.authority !== 'corpus') {
      throw consumerAuthorityMismatchError(
        renderConsumerId(regLike.id),
        'journal|corpus',
        renderConsumerId(regLike.authority),
      );
    }
    if ('lane' in reg && (reg as { lane?: unknown }).lane !== undefined) {
      throw documentedCoralSetupError('consumer_lane_invalid', { id: reg.id });
    }
    if (reg.authority === 'corpus' && !isCorpusInterest(reg.corpusInterest)) {
      throw documentedCoralSetupError('consumer_interest_invalid', { id: reg.id });
    }
    if (reg.authority === 'journal' && 'corpusInterest' in reg) {
      throw documentedCoralSetupError('consumer_interest_invalid', { id: reg.id });
    }
    if (reg.registrationKind !== undefined && !isRegistrationKind(reg.registrationKind)) {
      throw documentedCoralSetupError('consumer_registration_kind_invalid', { id: reg.id });
    }
  }

  private assertExistingRegistrationMatches(state: ConsumerState, reg: ConsumerRegistration): void {
    if (state.reg.authority !== reg.authority) {
      throw consumerAuthorityMismatchError(reg.id, reg.authority, state.reg.authority);
    }

    if (
      state.reg.authority === 'corpus' &&
      reg.authority === 'corpus' &&
      state.reg.corpusInterest !== reg.corpusInterest
    ) {
      throw consumerInterestMismatchError(reg.id);
    }

    if (reg.registrationKind !== undefined && state.registrationKind !== reg.registrationKind) {
      throw consumerRegistrationKindMismatchError(reg.id, reg.registrationKind, state.registrationKind);
    }
  }

  private ensureCursorRow(
    reg: ConsumerRegistration,
    allowRegistrationKindUpdate = true,
    preloadedRow?: CursorMetadataRow,
  ): ConsumerRegistrationKind {
    const row = preloadedRow ?? this.selectCursorMetadataStmt.get(reg.id);
    const requestedKind = reg.registrationKind;

    if (row) {
      if (row.authority !== reg.authority) {
        throw consumerAuthorityMismatchError(reg.id, reg.authority, row.authority);
      }
      if (reg.authority === 'corpus') {
        const storedInterest = parseStoredCorpusInterest(row);
        if (storedInterest !== reg.corpusInterest) {
          throw consumerInterestMismatchError(reg.id);
        }
      }

      const storedKind = this.parseStoredRegistrationKind(reg.id, row.registration_kind);
      if (requestedKind !== undefined && storedKind !== requestedKind) {
        if (!allowRegistrationKindUpdate) {
          throw consumerRegistrationKindMismatchError(reg.id, requestedKind, storedKind);
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

    throw documentedCoralSetupError('consumer_registration_kind_invalid', { id: consumerId });
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

  private scheduleCorpusApply(state: ConsumerState, snapshot: KbCorpusSnapshot): void {
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

  private async runCorpusApply(state: ConsumerState, snapshot: KbCorpusSnapshot): Promise<boolean> {
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
      this.resolveWaiters(state, snapshot);
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

  private readCorpusCursor(consumerId: string): KbCorpusSnapshot {
    return normalizeCorpusCursor(this.readCorpusCursorStmt.get(consumerId));
  }

  private advanceJournalCursor(reg: JournalConsumerRegistration, newCursor: number): void {
    this.ensureCursorRow(reg);
    this.advanceJournalCursorStmt.run(newCursor, reg.id, newCursor);
  }

  private advanceCorpusCursor(reg: CorpusConsumerRegistration, snapshot: KbCorpusSnapshot): void {
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
      throw documentedCoralSetupError('consumer_unregister_requires_stop', { id: state.reg.id });
    }

    await state.stopPromise;
    this.finalizeStoppedConsumer(state);
  }

  private finalizeStoppedConsumer(state: ConsumerState, options: UnregisterStoppedConsumerOptions = {}): void {
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
      corpusInterest: state.reg.corpusInterest,
      snapshotId: cursor.snapshotId === '' ? null : cursor.snapshotId,
      contentSeq: cursor.contentSeq,
      metadataSeq: cursor.metadataSeq,
      contentManifestHash: cursor.contentManifestHash === '' ? null : cursor.contentManifestHash,
      metadataManifestHash: cursor.metadataManifestHash === '' ? null : cursor.metadataManifestHash,
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

  private corpusTargetReached(state: ConsumerState, target: KbCorpusSnapshot, current: KbCorpusSnapshot): boolean {
    if (state.reg.authority !== 'corpus') {
      return false;
    }

    return !isSnapshotFresherForInterest(target, current, state.reg.corpusInterest);
  }

  private resolveWaiters(state: ConsumerState, newCursor: number | KbCorpusSnapshot): void {
    for (const waiter of [...state.waiters]) {
      if (waiter.settled) {
        continue;
      }
      const reached =
        state.reg.authority === 'journal' && typeof waiter.target === 'number' && typeof newCursor === 'number'
          ? waiter.target <= newCursor
          : state.reg.authority === 'corpus' && typeof waiter.target !== 'number' && typeof newCursor !== 'number'
            ? this.corpusTargetReached(state, waiter.target, newCursor)
            : false;
      if (!reached) {
        continue;
      }

      waiter.settled = true;
      state.waiters.delete(waiter);
      clearTimeout(waiter.timeoutHandle);
      waiter.resolve();
    }
  }
}
