import type { KbCorpusSnapshot } from '../kb/contract.js';
import type { KbCorpusProjectionReader, KbProjectionInput } from '../kb/projection-input-contract.js';
import { isSnapshotFresherForInterest } from '../kb/state/corpus-state.js';
import { backendLog } from '../infra/backend-log.js';
import type { Database } from '../store/db.js';
import type {
  ConsumerApplyError,
  CorpusConsumerRegistration,
  CorpusStateReadPort,
  JournalApplyRegistration,
  JournalConsumerReadPort,
} from '../store/consumer-contract.js';
import type { ConsumerCursorRepository } from './persistence.js';
import type { ConsumerState } from './state.js';
import { toConsumerApplyError } from './state.js';

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

export const DEFAULT_CORPUS_PROJECTION_READER = {
  resolveCurrentIndex: () => EMPTY_PROJECTION_INPUT.index,
  prepareCurrentProjectionInput: async () => EMPTY_PROJECTION_INPUT,
} satisfies KbCorpusProjectionReader;

export interface AuthorityApplyDeps {
  readonly db: Database;
  readonly now: () => Date;
  readonly repository: ConsumerCursorRepository;
  readonly journalReader: JournalConsumerReadPort;
  readonly corpusStateReader: CorpusStateReadPort;
  readonly corpusProjectionReader: KbCorpusProjectionReader;
  readonly onTextProjectionApplyStart?: () => void;
  readonly onTextProjectionApplyEnd?: () => void;
  readonly onTextProjectionSync?: () => void;
  readonly resolveWaiters: (state: ConsumerState, newCursor: number | KbCorpusSnapshot) => void;
  readonly rejectWaiters: (state: ConsumerState, applyError: ConsumerApplyError) => void;
}

export function scheduleJournalApply(state: ConsumerState, target: number, deps: AuthorityApplyDeps): void {
  if (state.stopped || state.kind !== 'journal') {
    return;
  }
  if (target <= deps.repository.readJournalCursor(state.reg.id)) {
    return;
  }

  if (state.reg.kind === 'cursor') {
    deps.repository.advanceJournalCursor(state.reg, target);
    state.lastApplyError = null;
    deps.resolveWaiters(state, target);
    return;
  }

  const reg = state.reg;

  if (state.inFlight) {
    if (state.pendingTarget === null || target > state.pendingTarget) {
      state.pendingTarget = target;
    }
    return;
  }

  state.inFlight = (async () => {
    const succeeded = await runJournalApply(state, reg, target, deps);
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
      scheduleJournalApply(state, nextTarget, deps);
    }
  })();
}

export function scheduleCorpusApply(state: ConsumerState, snapshot: KbCorpusSnapshot, deps: AuthorityApplyDeps): void {
  if (state.stopped || state.kind !== 'corpus') {
    return;
  }
  if (
    !isSnapshotFresherForInterest(snapshot, deps.repository.readCorpusCursor(state.reg.id), state.reg.corpusInterest)
  ) {
    return;
  }

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
    await runCorpusApply(state, reg, snapshot, deps);
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
      scheduleForcedCorpusApply(state, next.snapshot, next.generation, deps);
      return;
    }

    if (state.pendingCorpusSnapshot !== null) {
      const nextSnapshot = state.pendingCorpusSnapshot;
      state.pendingCorpusSnapshot = null;
      scheduleCorpusApply(state, nextSnapshot, deps);
    }
  })();
}

export function scheduleForcedCorpusApply(
  state: ConsumerState,
  snapshot: KbCorpusSnapshot,
  generation: number,
  deps: AuthorityApplyDeps,
): void {
  if (state.stopped || state.kind !== 'corpus') {
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
    await runCorpusApply(state, reg, snapshot, deps, { forceGeneration: generation });
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
      scheduleForcedCorpusApply(state, next.snapshot, next.generation, deps);
      return;
    }

    if (state.pendingCorpusSnapshot !== null) {
      const nextSnapshot = state.pendingCorpusSnapshot;
      state.pendingCorpusSnapshot = null;
      scheduleCorpusApply(state, nextSnapshot, deps);
    }
  })();
}

export async function runJournalApply(
  state: ConsumerState,
  reg: JournalApplyRegistration,
  target: number,
  deps: AuthorityApplyDeps,
): Promise<boolean> {
  try {
    const fromSeq = deps.repository.readJournalCursor(reg.id);
    const upToSeq = Math.max(fromSeq, target);

    if (upToSeq <= fromSeq) {
      return true;
    }

    const controller = new AbortController();
    if (state.kind === 'journal') {
      state.activeController = controller;
    }
    await reg.apply({ fromSeq, upToSeq, db: deps.db, signal: controller.signal });
    deps.repository.advanceJournalCursor(reg, upToSeq);
    if (state.kind === 'journal') {
      state.lastApplyError = null;
    }
    deps.resolveWaiters(state, upToSeq);
    return true;
  } catch (err) {
    const applyError = toConsumerApplyError(err, deps.now().toISOString());
    if (state.kind === 'journal') {
      state.lastApplyError = applyError;
    }
    invokeApplyFailureCallback(state, applyError);
    deps.rejectWaiters(state, applyError);
    backendLog.error(`ConsumerDriver apply failed (${reg.id})`, err);
    return false;
  }
}

export async function runCorpusApply(
  state: ConsumerState,
  reg: CorpusConsumerRegistration,
  snapshot: KbCorpusSnapshot,
  deps: AuthorityApplyDeps,
  options: { readonly forceGeneration?: number } = {},
): Promise<boolean> {
  try {
    const current = deps.repository.readCorpusCursor(reg.id);
    if (options.forceGeneration === undefined && !isSnapshotFresherForInterest(snapshot, current, reg.corpusInterest)) {
      return true;
    }

    const trackTextProjection = reg.projectionSync === 'text-index';
    if (trackTextProjection) {
      deps.onTextProjectionApplyStart?.();
    }
    try {
      const controller = new AbortController();
      if (state.kind === 'corpus') {
        state.activeController = controller;
      }
      const projectionInput = await prepareCorpusProjectionInput(controller.signal, deps);
      const applyResult = await reg.apply({
        snapshot,
        journalReader: deps.journalReader,
        corpusStateReader: deps.corpusStateReader,
        projectionInput,
        signal: controller.signal,
      });
      if (applyResult !== undefined && 'advance' in applyResult && applyResult.advance === false) {
        if (state.kind === 'corpus') {
          state.lastApplyError = null;
        }
        return true;
      }
      const appliedSnapshot =
        applyResult !== undefined && 'advanceTo' in applyResult ? applyResult.advanceTo : snapshot;
      if (reg.projectionSync === 'text-index') {
        deps.onTextProjectionSync?.();
      }
      deps.repository.advanceCorpusCursor(reg, appliedSnapshot);
      if (state.kind === 'corpus' && options.forceGeneration !== undefined) {
        state.lastAppliedForceGeneration = Math.max(state.lastAppliedForceGeneration, options.forceGeneration);
      }
      if (state.kind === 'corpus') {
        state.lastApplyError = null;
      }
      deps.resolveWaiters(state, appliedSnapshot);
      return true;
    } finally {
      if (trackTextProjection) {
        deps.onTextProjectionApplyEnd?.();
      }
    }
  } catch (err) {
    const applyError = toConsumerApplyError(err, deps.now().toISOString());
    if (state.kind === 'corpus') {
      state.lastApplyError = applyError;
    }
    invokeApplyFailureCallback(state, applyError);
    deps.rejectWaiters(state, applyError);
    backendLog.error(`ConsumerDriver apply failed (${reg.id})`, err);
    return false;
  }
}

export async function prepareCorpusProjectionInput(
  signal: AbortSignal,
  deps: AuthorityApplyDeps,
): Promise<KbProjectionInput> {
  return deps.corpusProjectionReader.prepareCurrentProjectionInput({ signal, ensureFreshness: false });
}

export function invokeApplyFailureCallback(state: ConsumerState, applyError: ConsumerApplyError): void {
  if (state.kind === 'stateless') {
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
