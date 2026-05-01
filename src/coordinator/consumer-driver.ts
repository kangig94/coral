import type { Database, Statement } from '../store/db.js';

import type { KbCorpusSnapshot } from '../kb/contract.js';
import type {
  CorpusConsumerRegistration,
  CorpusInterest,
  CorpusLaneHint,
  ConsumerApplyError,
  ConsumerHandle,
  ConsumerHandleStatus,
  ConsumerRegistration,
  ConsumerRegistrationKind,
  CorpusStateReadPort,
  JournalConsumerReadPort,
  JournalApplyRegistration,
  JournalConsumerRegistration,
} from '../store/consumer-contract.js';
import type { KbCorpusProjectionReader, KbProjectionInput } from '../kb/projection-input-contract.js';
import { documentedCoralSetupError, type CoralSetupError } from '../runtime/errors.js';
import type { TimerHandle, TimePort } from '../runtime/ports.js';
import { backendLog } from '../infra/backend-log.js';
import { isSnapshotFresherForInterest, normalizeCorpusCursor, readCorpusState } from '../kb/state/corpus-state.js';

// Consumer-related contract types live at their canonical home in
// `src/store/consumer-contract.ts`. Importers should reach there directly —
// no re-export shim from this file.

function isCorpusInterest(value: unknown): value is CorpusInterest {
  return value === 'content' || value === 'metadata' || value === 'both';
}

function isRegistrationKind(value: unknown): value is ConsumerRegistrationKind {
  return value === 'base' || value === 'expansion' || value === 'stateless';
}

function laneHintFromInterest(interest: CorpusInterest): CorpusLaneHint | null {
  return interest === 'both' ? null : interest;
}

function parseStoredCorpusInterest(row: {
  readonly corpus_interest: string | null;
  readonly lane: string | null;
}): CorpusInterest | null {
  const raw = row.corpus_interest ?? row.lane;
  return isCorpusInterest(raw) ? raw : null;
}

function shouldNotifyCorpusConsumer(interest: CorpusInterest, laneHint: CorpusLaneHint | undefined): boolean {
  return laneHint === undefined || interest === 'both' || interest === laneHint;
}

function isKbCorpusSnapshot(value: unknown): value is KbCorpusSnapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as KbCorpusSnapshot).snapshotId === 'string' &&
    typeof (value as KbCorpusSnapshot).contentSeq === 'number' &&
    typeof (value as KbCorpusSnapshot).metadataSeq === 'number' &&
    typeof (value as KbCorpusSnapshot).contentManifestHash === 'string' &&
    typeof (value as KbCorpusSnapshot).metadataManifestHash === 'string'
  );
}

export type ForcedCorpusFreshnessTarget = {
  readonly snapshot: KbCorpusSnapshot;
  readonly atLeastGeneration: number;
};

function isForcedCorpusFreshnessTarget(value: unknown): value is ForcedCorpusFreshnessTarget {
  return (
    typeof value === 'object' &&
    value !== null &&
    isKbCorpusSnapshot((value as ForcedCorpusFreshnessTarget).snapshot) &&
    typeof (value as ForcedCorpusFreshnessTarget).atLeastGeneration === 'number' &&
    Number.isInteger((value as ForcedCorpusFreshnessTarget).atLeastGeneration) &&
    (value as ForcedCorpusFreshnessTarget).atLeastGeneration >= 0
  );
}

function corpusSnapshotFromTarget(target: KbCorpusSnapshot | ForcedCorpusFreshnessTarget): KbCorpusSnapshot {
  return isForcedCorpusFreshnessTarget(target) ? target.snapshot : target;
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

function consumerNotRegisteredError(consumerId: string): CoralSetupError {
  return documentedCoralSetupError('consumer_not_registered', { id: consumerId });
}

function consumerAuthorityMismatchError(consumerId: string, expected: string, actual: string): CoralSetupError {
  return documentedCoralSetupError('consumer_authority_mismatch', {
    id: consumerId,
    expected,
    actual,
  });
}

function consumerInterestMismatchError(consumerId: string): CoralSetupError {
  return documentedCoralSetupError('consumer_interest_mismatch', { id: consumerId });
}

function consumerRegistrationKindMismatchError(
  consumerId: string,
  expected: ConsumerRegistrationKind | undefined,
  actual: ConsumerRegistrationKind,
): CoralSetupError {
  return documentedCoralSetupError('consumer_registration_kind_mismatch', {
    id: consumerId,
    expected,
    actual,
  });
}

function renderConsumerId(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return `${value}`;
  }
  return 'invalid';
}

export class FreshnessTimeout extends Error {
  constructor(consumerId: string, target: number | KbCorpusSnapshot | ForcedCorpusFreshnessTarget, timeoutMs: number) {
    const snapshot = typeof target !== 'number' ? corpusSnapshotFromTarget(target) : null;
    const renderedTarget =
      typeof target === 'number'
        ? String(target)
        : `${snapshot?.snapshotId}:${snapshot?.contentSeq}/${snapshot?.metadataSeq}${
            isForcedCorpusFreshnessTarget(target) ? `#${target.atLeastGeneration}` : ''
          }`;
    super(`waitFreshUntil timed out (consumer=${consumerId}, target=${renderedTarget}, timeoutMs=${timeoutMs})`);
    this.name = 'FreshnessTimeout';
    Object.setPrototypeOf(this, FreshnessTimeout.prototype);
  }
}

export type Authority = 'journal' | 'corpus';

type ConsumerDriverTimers = Pick<TimePort, 'setTimeout' | 'clearTimeout'>;

const EMPTY_PROJECTION_INPUT: KbProjectionInput = {
  index: {
    entries: {},
    principles: {},
    entityMeta: {},
    relationships: [],
  },
  records: [],
  communityFresh: false,
};

interface Waiter {
  target: number | KbCorpusSnapshot | ForcedCorpusFreshnessTarget;
  resolve: () => void;
  reject: (err: Error) => void;
  timeoutHandle: TimerHandle;
  settled: boolean;
}

interface ConsumerState {
  readonly reg: ConsumerRegistration;
  readonly handle: ConsumerHandle;
  readonly registrationKind: ConsumerRegistrationKind;
  inFlight: Promise<void> | null;
  pendingTarget: number | null;
  pendingCorpusSnapshot: KbCorpusSnapshot | null;
  pendingForcedCorpusApply: { snapshot: KbCorpusSnapshot; generation: number } | null;
  waiters: Set<Waiter>;
  stopped: boolean;
  stopPromise: Promise<void> | null;
  stopRequestedAt: number | null;
  activeController: AbortController | null;
  unregistered: boolean;
  lastApplyError: ConsumerApplyError | null;
  lastAppliedForceGeneration: number;
}

export interface StuckConsumerStatus {
  readonly id: string;
  readonly elapsedSinceStopMs: number;
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
  readonly db: Database;
  readonly now: () => Date;
  readonly time: ConsumerDriverTimers;
  readonly corpusProjectionReader?: KbCorpusProjectionReader;
  readonly onTextProjectionSync?: () => void;
}

export interface UnregisterStoppedConsumerOptions {
  readonly preserveCursor?: boolean;
}

export class ConsumerDriver {
  private readonly db: Database;
  private readonly now: () => Date;
  private readonly timers: ConsumerDriverTimers;
  private readonly corpusProjectionReader: KbCorpusProjectionReader;
  private readonly onTextProjectionSync?: () => void;
  private readonly journalReader: JournalConsumerReadPort;
  private readonly corpusStateReader: CorpusStateReadPort;
  private readonly consumers = new Map<string, ConsumerState>();
  private forceGeneration = 0;
  private readonly selectCursorMetadataStmt: Statement<[string], CursorMetadataRow>;
  private readonly insertJournalCursorRowStmt: Statement<
    [string, Authority, string, ConsumerRegistrationKind]
  >;
  private readonly insertCorpusCursorRowStmt: Statement<
    [string, Authority, CorpusLaneHint | null, CorpusInterest, string, ConsumerRegistrationKind]
  >;
  private readonly updateRegistrationKindStmt: Statement<[ConsumerRegistrationKind, string]>;
  private readonly deleteCursorRowStmt: Statement<[string]>;
  private readonly readJournalCursorStmt: Statement<[string], JournalCursorRow>;
  private readonly readCorpusCursorStmt: Statement<[string], CorpusCursorRow>;
  private readonly advanceJournalCursorStmt: Statement<[number, string, number]>;
  private readonly advanceContentCursorStmt: Statement<
    [string, number, number, string, string, string, number, number, string]
  >;
  private readonly advanceMetadataCursorStmt: Statement<
    [string, number, number, string, string, string, number, number, string]
  >;
  private readonly advanceBothCursorStmt: Statement<
    [string, number, number, string, string, string, number, number, string]
  >;

  constructor(opts: ConsumerDriverOptions) {
    this.db = opts.db;
    this.now = opts.now;
    this.timers = opts.time;
    this.corpusProjectionReader =
      opts.corpusProjectionReader ??
      ({
        resolveCurrentIndex: () => EMPTY_PROJECTION_INPUT.index,
        prepareCurrentProjectionInput: async () => EMPTY_PROJECTION_INPUT,
      } satisfies KbCorpusProjectionReader);
    this.onTextProjectionSync = opts.onTextProjectionSync;
    this.journalReader = {
      readCursor: (consumerId) => this.readJournalCursor(consumerId),
    };
    this.corpusStateReader = {
      readConsumerCursor: (consumerId) => this.readCorpusCursor(consumerId),
      readCurrentSnapshot: () => readCorpusState(this.db),
    };
    this.selectCursorMetadataStmt = this.db.prepare<[string], CursorMetadataRow>(
      'SELECT authority, lane, corpus_interest, registration_kind FROM consumer_cursors WHERE consumer_id = ?',
    );
    this.insertJournalCursorRowStmt = this.db.prepare<[string, Authority, string, ConsumerRegistrationKind]>(
      `
        INSERT INTO consumer_cursors (
          consumer_id,
          authority,
          cursor,
          registered_at,
          registration_kind
        ) VALUES (?, ?, 0, ?, ?)
      `,
    );
    this.insertCorpusCursorRowStmt = this.db.prepare<
      [string, Authority, CorpusLaneHint | null, CorpusInterest, string, ConsumerRegistrationKind]
    >(
      `
        INSERT INTO consumer_cursors (
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
          registered_at,
          registration_kind
        ) VALUES (?, ?, ?, ?, NULL, '', 0, 0, '', '', ?, ?)
      `,
    );
    this.updateRegistrationKindStmt = this.db.prepare<[ConsumerRegistrationKind, string]>(
      'UPDATE consumer_cursors SET registration_kind = ? WHERE consumer_id = ?',
    );
    this.deleteCursorRowStmt = this.db.prepare<[string]>('DELETE FROM consumer_cursors WHERE consumer_id = ?');
    this.readJournalCursorStmt = this.db.prepare<[string], JournalCursorRow>(
      'SELECT cursor FROM consumer_cursors WHERE consumer_id = ?',
    );
    this.readCorpusCursorStmt = this.db.prepare<[string], CorpusCursorRow>(
      `
        SELECT snapshot_id, content_seq, metadata_seq, content_manifest_hash, metadata_manifest_hash
          FROM consumer_cursors
         WHERE consumer_id = ?
      `,
    );
    this.advanceJournalCursorStmt = this.db.prepare<[number, string, number]>(
      'UPDATE consumer_cursors SET cursor = ? WHERE consumer_id = ? AND cursor < ?',
    );
    this.advanceContentCursorStmt = this.db.prepare<
      [string, number, number, string, string, string, number, number, string]
    >(
      `
        UPDATE consumer_cursors
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
        UPDATE consumer_cursors
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
        UPDATE consumer_cursors
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
      } else if (existing.registrationKind !== 'stateless') {
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
      pendingForcedCorpusApply: null,
      waiters: new Set(),
      stopped: false,
      stopPromise: null,
      stopRequestedAt: null,
      activeController: null,
      unregistered: false,
      lastApplyError: null,
      lastAppliedForceGeneration: 0,
    };

    this.consumers.set(reg.id, state);
    return handle;
  }

  getJournalReader(): JournalConsumerReadPort {
    return this.journalReader;
  }

  getCorpusStateReader(): CorpusStateReadPort {
    return this.corpusStateReader;
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

  forceCorpusApply(
    snapshot: KbCorpusSnapshot,
    options: { readonly reason: 'projection-artifact-lag'; readonly consumers: readonly string[] },
  ): { readonly generation: number; readonly consumers: readonly string[] } {
    void options.reason;
    this.forceGeneration += 1;
    const generation = this.forceGeneration;
    const requested = [...new Set(options.consumers)];
    const consumers: string[] = [];

    for (const consumerId of requested) {
      const state = this.consumers.get(consumerId);
      if (state === undefined || state.reg.authority !== 'corpus') {
        continue;
      }
      consumers.push(consumerId);
      this.scheduleForcedCorpusApply(state, snapshot, generation);
    }

    return { generation, consumers };
  }

  waitFreshUntil(authority: 'journal', target: number, consumerId: string, timeoutMs?: number): Promise<void>;
  waitFreshUntil(authority: 'corpus', target: KbCorpusSnapshot, consumerId: string, timeoutMs?: number): Promise<void>;
  waitFreshUntil(
    authority: 'corpus',
    target: ForcedCorpusFreshnessTarget,
    consumerId: string,
    timeoutMs?: number,
  ): Promise<void>;
  waitFreshUntil(
    authority: Authority,
    target: number | KbCorpusSnapshot | ForcedCorpusFreshnessTarget,
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
    if (state.reg.kind === 'stateless') {
      throw documentedCoralSetupError('consumer_wait_fresh_invalid_target', { id: consumerId });
    }
    if (state.reg.authority !== authority) {
      throw consumerAuthorityMismatchError(consumerId, authority, state.reg.authority);
    }
    if (state.stopped) {
      throw documentedCoralSetupError('consumer_wait_unsupported', { id: consumerId });
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
      if (!isKbCorpusSnapshot(target) && !isForcedCorpusFreshnessTarget(target)) {
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
        timeoutHandle: this.timers.setTimeout(() => {
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

  /**
   * Reports apply-bearing consumers (journal-apply or corpus) whose stop has
   * been requested but whose `inFlight` hasn't settled yet. Used by /health
   * `subsystems.kb.consumerStuck` so operators can apply their own grace
   * policy.  Stateless and cursor-only consumers never appear here — they
   * have no in-flight work after stop.
   */
  stuckConsumers(): StuckConsumerStatus[] {
    const now = this.now().getTime();
    const stuck: StuckConsumerStatus[] = [];
    for (const state of this.consumers.values()) {
      if (state.stopRequestedAt === null || state.inFlight === null) {
        continue;
      }
      stuck.push({ id: state.reg.id, elapsedSinceStopMs: Math.max(0, now - state.stopRequestedAt) });
    }
    return stuck;
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
    const regLike = reg as { id?: unknown; authority?: unknown; kind?: unknown };
    if (regLike.kind === 'stateless') {
      if (reg.registrationKind !== undefined && !isRegistrationKind(reg.registrationKind)) {
        throw documentedCoralSetupError('consumer_registration_kind_invalid', { id: reg.id });
      }
      return;
    }
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
    if (state.reg.kind !== reg.kind) {
      throw consumerRegistrationKindMismatchError(reg.id, reg.registrationKind, state.registrationKind);
    }

    if (reg.kind === 'stateless') {
      if (reg.registrationKind !== undefined && state.registrationKind !== reg.registrationKind) {
        throw consumerRegistrationKindMismatchError(reg.id, reg.registrationKind, state.registrationKind);
      }
      return;
    }

    // Past this point: `reg.kind ∈ {'cursor','apply'}` and `state.reg.kind`
    // matches (kind-mismatch threw above). TS doesn't track equality between
    // the two independent discriminants, so cast `state.reg` to the same
    // non-stateless union as `reg` for the authority/corpusInterest reads
    // below.
    const stateReg = state.reg as JournalConsumerRegistration | CorpusConsumerRegistration;

    if (stateReg.authority !== reg.authority) {
      throw consumerAuthorityMismatchError(reg.id, reg.authority, stateReg.authority);
    }

    if (
      stateReg.authority === 'corpus' &&
      reg.authority === 'corpus' &&
      stateReg.corpusInterest !== reg.corpusInterest
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
    if (reg.kind === 'stateless') {
      const row = preloadedRow ?? this.selectCursorMetadataStmt.get(reg.id);
      if (row !== undefined) {
        // Stateless re-registration after a prior cursor-bearing registration:
        // wipe the cursor row, since stateless owns no cursor.
        this.deleteCursorRowStmt.run(reg.id);
      }
      return 'stateless';
    }

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
    if (reg.kind === 'stateless' || registrationKind === 'stateless') {
      return;
    }
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

    if (state.reg.kind === 'cursor') {
      // Cursor-only consumers (base journal projections) advance the persisted
      // cursor directly. Spec §3.3 commit-time reducer is the authoritative
      // writer; the driver here only maintains the cursor row that
      // `waitFreshUntil` reads.
      this.advanceJournalCursor(state.reg, target);
      state.lastApplyError = null;
      this.resolveWaiters(state, target);
      return;
    }

    // Past this point `state.reg` is `JournalApplyRegistration` —
    // authority='journal' && kind='apply'. Capture once so the in-flight
    // closure has a typed reference without re-narrowing.
    const reg = state.reg;

    if (state.inFlight) {
      if (state.pendingTarget === null || target > state.pendingTarget) {
        state.pendingTarget = target;
      }
      return;
    }

    state.inFlight = (async () => {
      const succeeded = await this.runJournalApply(state, reg, target);
      state.inFlight = null;
      state.activeController = null;

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

    // Past the authority filter `state.reg` is `CorpusConsumerRegistration`
    // (kind='apply' is the only corpus shape). Capture once for the in-flight
    // closure so it doesn't re-narrow.
    const reg = state.reg;

    if (state.inFlight) {
      if (
        state.pendingCorpusSnapshot === null ||
        isSnapshotFresherForInterest(snapshot, state.pendingCorpusSnapshot, reg.corpusInterest)
      ) {
        state.pendingCorpusSnapshot = { ...snapshot };
      }
      return;
    }

    state.inFlight = (async () => {
      // Both success and failure paths retry against any snapshot parked
      // while N was in-flight. Clearing pendingCorpusSnapshot on apply
      // failure would silently drop a newer notify and leave the consumer
      // stale at the pre-failure cursor until the next mutation arrives.
      // If no snapshot was parked, the consumer waits for the next notify.
      await this.runCorpusApply(state, reg, snapshot);
      state.inFlight = null;
      state.activeController = null;

      if (state.stopped) {
        state.pendingCorpusSnapshot = null;
        state.pendingForcedCorpusApply = null;
        return;
      }

      if (state.pendingForcedCorpusApply !== null) {
        const next = state.pendingForcedCorpusApply;
        state.pendingForcedCorpusApply = null;
        this.scheduleForcedCorpusApply(state, next.snapshot, next.generation);
        return;
      }

      if (state.pendingCorpusSnapshot !== null) {
        const nextSnapshot = state.pendingCorpusSnapshot;
        state.pendingCorpusSnapshot = null;
        this.scheduleCorpusApply(state, nextSnapshot);
      }
    })();
  }

  private scheduleForcedCorpusApply(state: ConsumerState, snapshot: KbCorpusSnapshot, generation: number): void {
    if (state.stopped || state.reg.authority !== 'corpus') {
      return;
    }

    const reg = state.reg;

    if (state.inFlight) {
      if (state.pendingForcedCorpusApply === null || generation > state.pendingForcedCorpusApply.generation) {
        state.pendingForcedCorpusApply = { snapshot: { ...snapshot }, generation };
      }
      return;
    }

    state.inFlight = (async () => {
      await this.runCorpusApply(state, reg, snapshot, { forceGeneration: generation });
      state.inFlight = null;
      state.activeController = null;

      if (state.stopped) {
        state.pendingCorpusSnapshot = null;
        state.pendingForcedCorpusApply = null;
        return;
      }

      if (state.pendingForcedCorpusApply !== null) {
        const next = state.pendingForcedCorpusApply;
        state.pendingForcedCorpusApply = null;
        this.scheduleForcedCorpusApply(state, next.snapshot, next.generation);
        return;
      }

      if (state.pendingCorpusSnapshot !== null) {
        const nextSnapshot = state.pendingCorpusSnapshot;
        state.pendingCorpusSnapshot = null;
        this.scheduleCorpusApply(state, nextSnapshot);
      }
    })();
  }

  private async runJournalApply(state: ConsumerState, reg: JournalApplyRegistration, target: number): Promise<boolean> {
    try {
      const fromSeq = this.readJournalCursor(reg.id);
      const upToSeq = Math.max(fromSeq, target);

      if (upToSeq <= fromSeq) {
        return true;
      }

      const controller = new AbortController();
      state.activeController = controller;
      await reg.apply({ fromSeq, upToSeq, db: this.db, signal: controller.signal });
      this.advanceJournalCursor(reg, upToSeq);
      state.lastApplyError = null;
      this.resolveWaiters(state, upToSeq);
      return true;
    } catch (err) {
      const applyError = toConsumerApplyError(err, this.now().toISOString());
      state.lastApplyError = applyError;
      this.invokeApplyFailureCallback(state, applyError);
      backendLog.error(`ConsumerDriver apply failed (${reg.id})`, err);
      return false;
    }
  }

  private async runCorpusApply(
    state: ConsumerState,
    reg: CorpusConsumerRegistration,
    snapshot: KbCorpusSnapshot,
    options: { readonly forceGeneration?: number } = {},
  ): Promise<boolean> {
    try {
      const current = this.readCorpusCursor(reg.id);
      if (
        options.forceGeneration === undefined &&
        !isSnapshotFresherForInterest(snapshot, current, reg.corpusInterest)
      ) {
        return true;
      }

      const controller = new AbortController();
      state.activeController = controller;
      const projectionInput = await this.prepareCorpusProjectionInput(controller.signal);
      await reg.apply({
        snapshot,
        journalReader: this.journalReader,
        corpusStateReader: this.corpusStateReader,
        projectionInput,
        signal: controller.signal,
      });
      if (reg.projectionSync === 'text-index') {
        this.onTextProjectionSync?.();
      }
      this.advanceCorpusCursor(reg, snapshot);
      if (options.forceGeneration !== undefined) {
        state.lastAppliedForceGeneration = Math.max(state.lastAppliedForceGeneration, options.forceGeneration);
      }
      state.lastApplyError = null;
      this.resolveWaiters(state, snapshot);
      return true;
    } catch (err) {
      const applyError = toConsumerApplyError(err, this.now().toISOString());
      state.lastApplyError = applyError;
      this.invokeApplyFailureCallback(state, applyError);
      backendLog.error(`ConsumerDriver apply failed (${reg.id})`, err);
      return false;
    }
  }

  private async prepareCorpusProjectionInput(signal: AbortSignal): Promise<KbProjectionInput> {
    return this.corpusProjectionReader.prepareCurrentProjectionInput({ signal });
  }

  private invokeApplyFailureCallback(state: ConsumerState, applyError: ConsumerApplyError): void {
    if (state.reg.kind === 'stateless') {
      return;
    }
    const onApplyFailure = state.reg.onApplyFailure;
    if (onApplyFailure === undefined) {
      return;
    }

    try {
      onApplyFailure(applyError);
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
    state.stopRequestedAt = this.now().getTime();

    if (state.reg.kind === 'stateless') {
      const onStop = state.reg.onStop;
      state.stopPromise = (async () => {
        if (onStop !== undefined) {
          await onStop();
        }
        this.rejectWaiters(state, waiterError);
      })();
      return state.stopPromise;
    }

    if (state.reg.kind === 'cursor') {
      // Cursor-only consumers carry no inflight work and no abort controller.
      state.pendingTarget = null;
      state.pendingCorpusSnapshot = null;
      state.pendingForcedCorpusApply = null;
      this.rejectWaiters(state, waiterError);
      state.stopPromise = Promise.resolve();
      return state.stopPromise;
    }

    state.activeController?.abort('shutdown');
    state.stopPromise = (async () => {
      await state.inFlight;
      state.pendingTarget = null;
      state.pendingCorpusSnapshot = null;
      state.pendingForcedCorpusApply = null;
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
    if (state.registrationKind === 'expansion' && options.preserveCursor !== true) {
      this.deleteCursorRowStmt.run(state.reg.id);
    }

    state.unregistered = true;
  }

  private statusFor(state: ConsumerState): ConsumerHandleStatus {
    if (state.reg.kind === 'stateless') {
      return { kind: 'stateless', pending: false };
    }
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
    return (
      state.inFlight !== null ||
      state.pendingTarget !== null ||
      state.pendingCorpusSnapshot !== null ||
      state.pendingForcedCorpusApply !== null
    );
  }

  private rejectWaiters(state: ConsumerState, err: Error): void {
    for (const waiter of [...state.waiters]) {
      if (waiter.settled) {
        continue;
      }

      waiter.settled = true;
      this.timers.clearTimeout(waiter.timeoutHandle);
      state.waiters.delete(waiter);
      waiter.reject(err);
    }
  }

  private corpusTargetReached(
    state: ConsumerState,
    target: KbCorpusSnapshot | ForcedCorpusFreshnessTarget,
    current: KbCorpusSnapshot,
  ): boolean {
    if (state.reg.authority !== 'corpus') {
      return false;
    }

    const snapshot = corpusSnapshotFromTarget(target);
    if (isSnapshotFresherForInterest(snapshot, current, state.reg.corpusInterest)) {
      return false;
    }
    return !isForcedCorpusFreshnessTarget(target) || state.lastAppliedForceGeneration >= target.atLeastGeneration;
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
      this.timers.clearTimeout(waiter.timeoutHandle);
      waiter.resolve();
    }
  }
}
