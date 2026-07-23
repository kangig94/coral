import type { KbCorpusSnapshot } from '../kb/contract.js';
import type { KbCorpusProjectionReader } from '../kb/projection-input-contract.js';
import type { GeneratedCommunityFreshness } from '../kb/curate/community/generated-projection-store.js';
import { readCorpusState } from '../kb/state/corpus-state.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import type { TimePort } from '../infra/port-types.js';
import type { Database } from '../store/db.js';
import type {
  ConsumerHandle,
  ConsumerHandleStatus,
  ConsumerRegistration,
  CorpusLaneHint,
  CorpusStateReadPort,
  JournalConsumerReadPort,
} from '../store/consumer-contract.js';
import {
  DEFAULT_CORPUS_PROJECTION_READER,
  scheduleCorpusApply,
  scheduleForcedCorpusApply,
  scheduleJournalApply,
  type AuthorityApplyDeps,
} from './authority-apply.js';
import { waitFreshUntilImpl, rejectWaiters, rejectWaitersForApplyFailure, resolveWaiters } from './freshness-waiter.js';
import { ConsumerCursorRepository } from './persistence.js';
import {
  assertExistingRegistrationMatches,
  assertValidRegistration,
  finalizeStoppedConsumer,
  stopConsumer,
  unregisterConsumer,
  type FinalizeStoppedConsumerDeps,
  type StopConsumerDeps,
} from './registration.js';
import {
  consumerNotRegisteredError,
  consumerRegistrationKindMismatchError,
  createConsumerState,
  shouldNotifyCorpusConsumer,
  type Authority,
  type ConsumerDriverTimers,
  type ConsumerState,
  type ForcedCorpusFreshnessTarget,
} from './state.js';

export { FreshnessApplyFailure, FreshnessTimeout } from './freshness-waiter.js';
export type { Authority, ForcedCorpusFreshnessTarget } from './state.js';

export interface StuckConsumerStatus {
  readonly id: string;
  readonly elapsedSinceStopMs: number;
  readonly authority: 'journal' | 'corpus';
  readonly cursor?: number;
  readonly snapshotId?: string | null;
  readonly contentSeq?: number;
  readonly metadataSeq?: number;
}

export interface ConsumerDriverDrainOptions {
  readonly timeoutMs?: number;
}

export interface ConsumerDriverShutdownOptions {
  readonly drainTimeoutMs?: number;
}

export class ConsumerDrainTimeout extends Error {
  readonly stuckConsumers: readonly StuckConsumerStatus[];

  constructor(timeoutMs: number, stuckConsumers: readonly StuckConsumerStatus[]) {
    const rendered =
      stuckConsumers.length === 0
        ? 'none'
        : stuckConsumers
            .map((consumer) => `${consumer.id}:${consumer.authority}:${consumer.elapsedSinceStopMs}ms`)
            .join(', ');
    super(`ConsumerDriver drain timed out after ${timeoutMs}ms; stuck consumers: ${rendered}`);
    this.name = 'ConsumerDrainTimeout';
    this.stuckConsumers = stuckConsumers;
  }
}

export interface ConsumerDriverOptions {
  readonly db: Database;
  readonly now: () => Date;
  readonly time: Pick<TimePort, 'setTimeout' | 'clearTimeout'>;
  readonly corpusProjectionReader?: KbCorpusProjectionReader;
  readonly onTextProjectionApplyStart?: () => void;
  readonly onTextProjectionApplyEnd?: () => void;
  readonly onTextProjectionSync?: () => void;
}

export interface UnregisterStoppedConsumerOptions {
  readonly preserveCursor?: boolean;
}

export class ConsumerDriver {
  private readonly now: () => Date;
  private readonly timers: ConsumerDriverTimers;
  private readonly journalReader: JournalConsumerReadPort;
  private readonly corpusStateReader: CorpusStateReadPort;
  private readonly consumers = new Map<string, ConsumerState>();
  private readonly repository: ConsumerCursorRepository;
  private readonly applyDeps: AuthorityApplyDeps;
  private readonly stopDeps: StopConsumerDeps;
  private readonly finalizeDeps: FinalizeStoppedConsumerDeps;
  private forceGeneration = 0;

  constructor(opts: ConsumerDriverOptions) {
    this.now = opts.now;
    this.timers = opts.time;
    this.repository = new ConsumerCursorRepository(opts.db, this.now);
    this.journalReader = {
      readCursor: (consumerId) => this.repository.readJournalCursor(consumerId),
    };
    this.corpusStateReader = {
      readConsumerCursor: (consumerId) => this.repository.readCorpusCursor(consumerId),
      readCurrentSnapshot: () => readCorpusState(opts.db),
    };
    this.stopDeps = {
      now: this.now,
      rejectWaiters: (state, err) => rejectWaiters(state, err, this.timers),
    };
    this.finalizeDeps = {
      consumers: this.consumers,
      repository: this.repository,
    };
    this.applyDeps = {
      db: opts.db,
      now: this.now,
      repository: this.repository,
      journalReader: this.journalReader,
      corpusStateReader: this.corpusStateReader,
      corpusProjectionReader: opts.corpusProjectionReader ?? DEFAULT_CORPUS_PROJECTION_READER,
      onTextProjectionApplyStart: opts.onTextProjectionApplyStart,
      onTextProjectionApplyEnd: opts.onTextProjectionApplyEnd,
      onTextProjectionSync: opts.onTextProjectionSync,
      resolveWaiters: (state, newCursor) => resolveWaiters(state, newCursor, this.timers),
      rejectWaiters: (state, applyError): void => rejectWaitersForApplyFailure(state, applyError, this.timers),
    };
  }

  register(reg: ConsumerRegistration): ConsumerHandle {
    assertValidRegistration(reg);

    const existing = this.consumers.get(reg.id);
    if (existing) {
      assertExistingRegistrationMatches(existing, reg);
      const storedKind = this.repository.ensureCursorRow(reg, false, existing.registrationKind);
      if (storedKind !== existing.registrationKind) {
        throw consumerRegistrationKindMismatchError(reg.id, existing.registrationKind, storedKind);
      }
      return existing.handle;
    }

    const registrationKind = this.repository.ensureCursorRow(reg);
    const stateRef: { current: ConsumerState | null } = { current: null };
    const readState = (): ConsumerState => {
      if (stateRef.current === null) {
        throw new Error(`Consumer '${reg.id}' state was read before initialization`);
      }
      return stateRef.current;
    };
    const handle: ConsumerHandle = {
      id: reg.id,
      registrationKind,
      get lastApplyError() {
        return readState().lastApplyError;
      },
      stop: () => stopConsumer(readState(), new Error(`Consumer '${reg.id}' stopped`), this.stopDeps),
      unregister: () => unregisterConsumer(readState(), this.finalizeDeps),
      status: () => this.statusFor(readState()),
    };

    const state = createConsumerState(reg, registrationKind, handle);
    stateRef.current = state;
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
        scheduleJournalApply(state, versionOrSnapshot as number, this.applyDeps);
      }
      return;
    }

    if (laneHint !== undefined && laneHint !== 'content' && laneHint !== 'metadata') {
      throw documentedCoralSetupError('consumer_lane_invalid', { id: 'notify(corpus)' });
    }

    const snapshot = versionOrSnapshot as KbCorpusSnapshot;
    for (const state of this.consumers.values()) {
      if (state.kind !== 'corpus' || !shouldNotifyCorpusConsumer(state.reg.corpusInterest, laneHint)) {
        continue;
      }
      scheduleCorpusApply(state, snapshot, this.applyDeps);
    }
  }

  notifyCorpus(snapshot: KbCorpusSnapshot, laneHint?: CorpusLaneHint): void {
    this.notify('corpus', snapshot, laneHint);
  }

  forceCorpusApply(
    snapshot: KbCorpusSnapshot,
    options: {
      readonly reason: 'projection-artifact-lag';
      readonly consumers: readonly string[];
      readonly generatedCommunityFreshness?: GeneratedCommunityFreshness;
    },
  ): { readonly generation: number; readonly consumers: readonly string[] } {
    void options.reason;
    this.forceGeneration += 1;
    const generation = this.forceGeneration;
    const consumers: string[] = [];
    const seen = new Set<string>();

    for (const consumerId of options.consumers) {
      if (seen.has(consumerId)) {
        continue;
      }
      seen.add(consumerId);

      const state = this.consumers.get(consumerId);
      if (state?.kind !== 'corpus') {
        continue;
      }
      consumers.push(consumerId);
      scheduleForcedCorpusApply(state, snapshot, generation, this.applyDeps, options.generatedCommunityFreshness);
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
    return waitFreshUntilImpl(authority, target, consumerId, timeoutMs, {
      consumers: this.consumers,
      repository: this.repository,
      timers: this.timers,
    });
  }

  async drainAll(options: ConsumerDriverDrainOptions = {}): Promise<void> {
    const startedAt = this.now().getTime();
    while (true) {
      const pending: Promise<void>[] = [];
      for (const state of this.consumers.values()) {
        if (state.kind !== 'stateless' && state.inFlight !== null) {
          pending.push(state.inFlight);
        }
      }

      if (pending.length === 0) {
        return;
      }

      const timeoutMs = options.timeoutMs;
      if (timeoutMs === undefined) {
        await Promise.allSettled(pending);
        continue;
      }

      const remainingMs = Math.max(0, startedAt + timeoutMs - this.now().getTime());
      if (remainingMs === 0 || !(await this.waitForDrainBatch(pending, remainingMs))) {
        throw new ConsumerDrainTimeout(timeoutMs, this.stuckConsumers());
      }
    }
  }

  async shutdown(options: ConsumerDriverShutdownOptions = {}): Promise<void> {
    const states = [...this.consumers.values()];
    const stopPromises = states.map((state) =>
      stopConsumer(state, new Error('ConsumerDriver shutting down'), this.stopDeps),
    );
    try {
      if (options.drainTimeoutMs !== undefined) {
        await this.drainAll({ timeoutMs: options.drainTimeoutMs });
      }
      await Promise.all(stopPromises);
    } catch (error: unknown) {
      void Promise.allSettled(stopPromises);
      throw error;
    }
    this.consumers.clear();
  }

  stuckConsumers(): StuckConsumerStatus[] {
    const now = this.now().getTime();
    const stuck: StuckConsumerStatus[] = [];
    for (const state of this.consumers.values()) {
      if (state.kind === 'stateless' || state.stopRequestedAt === null || state.inFlight === null) {
        continue;
      }
      const elapsedSinceStopMs = Math.max(0, now - state.stopRequestedAt);
      if (state.kind === 'journal') {
        stuck.push({
          id: state.reg.id,
          authority: 'journal',
          cursor: this.repository.readJournalCursor(state.reg.id),
          elapsedSinceStopMs,
        });
        continue;
      }
      const cursor = this.repository.readCorpusCursor(state.reg.id);
      stuck.push({
        id: state.reg.id,
        authority: 'corpus',
        snapshotId: cursor.snapshotId === '' ? null : cursor.snapshotId,
        contentSeq: cursor.contentSeq,
        metadataSeq: cursor.metadataSeq,
        elapsedSinceStopMs,
      });
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
    finalizeStoppedConsumer(state, options, this.finalizeDeps);
  }

  private statusFor(state: ConsumerState): ConsumerHandleStatus {
    if (state.kind === 'stateless') {
      return { kind: 'stateless', pending: false };
    }
    if (state.kind === 'journal') {
      return {
        authority: 'journal',
        cursor: this.repository.readJournalCursor(state.reg.id),
        pending: this.isPending(state),
        lastApplyError: state.lastApplyError,
      };
    }

    const cursor = this.repository.readCorpusCursor(state.reg.id);
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
    if (state.kind === 'stateless') {
      return false;
    }
    if (state.kind === 'journal') {
      return state.inFlight !== null || state.pendingTarget !== null;
    }
    return state.inFlight !== null || state.pendingCorpusSnapshot !== null || state.pendingForcedCorpusApply !== null;
  }

  private async waitForDrainBatch(pending: readonly Promise<void>[], timeoutMs: number): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const timeoutHandle = this.timers.setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(false);
      }, timeoutMs);

      void Promise.allSettled(pending).then(() => {
        if (settled) {
          return;
        }
        settled = true;
        this.timers.clearTimeout(timeoutHandle);
        resolve(true);
      });
    });
  }
}
