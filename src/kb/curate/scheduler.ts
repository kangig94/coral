import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { nowIsoString } from '../../infra/time.js';
import type { TimerHandle } from '../../infra/port-types.js';
import type { KbRuntime } from '../contract.js';
import { buildEntityConsolidationDelta, buildMetadataTargets } from './classification/assignments.js';
import { runCommunitySubphase } from './community/index.js';
import { createGitSyncController } from './git-sync.js';
import { commitMetadataTargets } from './metadata-commit.js';
import { clearCurateClaimRetryState, clearCurateClaimRetryStateLocked, recordCurateFailure } from './operations.js';
import { runPrincipleDiscovery } from './principles.js';
import { claimCurateRun, hasPendingEntriesBeyondCursor, runClassificationBatches } from './runner.js';
import {
  drainTouchJournalBatch,
  markTouchJournalWikiApplied,
  resolveTouchJournalWorkState,
  truncateTouchJournal,
  type TouchJournalWorkItem,
  type TouchJournalWorkState,
} from './touch-journal.js';
import {
  INVARIANT,
  isClaimStale,
  readCurateState,
  resolveCurateTimings,
  writeCurateState,
  type CurateCursor,
  type CurateState,
} from './state/index.js';
import { initializeCurateStateIfNeeded } from './state/bootstrap.js';
import type { GitSyncRuntimePicks } from './pipeline-types.js';
import type { CurateAssistantPort } from './assistant.js';

import type { CurateUsageBudgetPort } from './usage-budget.js';
import { curateDb } from './db-access.js';
import { bubbleUpWikiKnowledge } from '../ops/wiki/mutation.js';
import { runPendingKbMigrations } from '../migrations/index.js';

export type CurateHandle = {
  start(): Promise<void>;
  schedule(): void;
  scheduleDeferredCommit(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
};

const CURATE_SCHEDULE_DEBOUNCE_MS = 60 * 1000;
const COMMUNITY_BATCH_BACKOFF_TICK_CAP = 64;

export async function runTouchDrainSubphase(kb: KbRuntime): Promise<boolean> {
  const batch = drainTouchJournalBatch(kb.runtimeDir, kb.readIndexOrEmpty(), { storage: kb.storagePort });

  for (const work of batch.pending) {
    const state = resolveTouchJournalWorkState(kb.readIndexOrEmpty(), work);
    if (state === 'applied' || state === 'obsolete') {
      markTouchJournalWikiApplied(kb.runtimeDir, batch, work, { storage: kb.storagePort });
      continue;
    }
    assertTouchJournalWorkPending(work, state);

    await bubbleUpWikiKnowledge(kb, work.slug, work.targets);

    const afterState = resolveTouchJournalWorkState(kb.readIndexOrEmpty(), work);
    if (afterState !== 'applied' && afterState !== 'obsolete') {
      throw new Error(`touch-journal: ${work.slug} did not reach expected Knowledge order after drain`);
    }
    markTouchJournalWikiApplied(kb.runtimeDir, batch, work, { storage: kb.storagePort });
  }

  truncateTouchJournal(kb.runtimeDir, { storage: kb.storagePort });
  return batch.workItems.length > 0;
}

function assertTouchJournalWorkPending(work: TouchJournalWorkItem, state: TouchJournalWorkState): void {
  if (state !== 'pending') {
    throw new Error(
      `touch-journal: ${work.slug} Knowledge order changed while a touch batch was pending; refusing to replay non-idempotent swaps`,
    );
  }
}

class CurateRunError extends Error {
  readonly through: CurateCursor | null;
  readonly cause: unknown;

  constructor(through: CurateCursor | null, cause: unknown) {
    super(errorMessage(cause));
    this.name = 'CurateRunError';
    this.through = through;
    this.cause = cause;
  }
}

type PermanentlyDisabledLanes = {
  claim: boolean;
  communityBatch: boolean;
};

function permanentlyDisabledLanes(state: CurateState): PermanentlyDisabledLanes {
  return {
    claim: state.consecutiveClaimFailures >= INVARIANT.MAX_CONSECUTIVE_FAILURES,
    communityBatch: state.consecutiveCommunityBatchFailures >= INVARIANT.MAX_CONSECUTIVE_FAILURES,
  };
}

function warnClaimLanePermanentlyDisabled(): void {
  backendLog.warn(
    `kb_curate: claim lane permanently disabled after ${INVARIANT.MAX_CONSECUTIVE_FAILURES} consecutive failures; run 'clearCurateRetryState' after fixing the underlying issue to re-enable scheduling`,
  );
}

function warnCommunityBatchLanePermanentlyDisabled(): void {
  backendLog.warn(
    `kb_curate: community batch lane permanently disabled after ${INVARIANT.MAX_CONSECUTIVE_FAILURES} consecutive failures; fix the underlying issue and let the next successful run reset the counter`,
  );
}

function warnPermanentlyDisabledLanes(lanes: PermanentlyDisabledLanes): void {
  if (lanes.claim) {
    warnClaimLanePermanentlyDisabled();
  }
  if (lanes.communityBatch) {
    warnCommunityBatchLanePermanentlyDisabled();
  }
}

/**
 * Runs the community-summary agent after topology materialization. The runtime
 * host may wrap this as an observable `kb.community_summary` job, or call the
 * agent directly. Returns whether the agent wrote summaries (so the scheduler
 * knows to commit). When omitted (e.g. tests that exercise topology only), the
 * summary pass is skipped.
 *
 * `runSignal` is the scheduler's run abort signal: the implementation composes
 * it with the job's own (`coral-cli abort`) signal so a scheduler stop cancels
 * the in-flight agent turn rather than blocking `stop()` on it.
 */
export type RunCommunitySummaryJob = (runSignal: AbortSignal) => Promise<boolean>;

export function createCurateScheduler({
  kb,
  curateAssistant,
  processPort,
  storagePort,
  envPort,
  usageBudget,
  runCommunitySummaryJob,
  scheduleDebounceMs = CURATE_SCHEDULE_DEBOUNCE_MS,
}: {
  kb: KbRuntime;
  curateAssistant: CurateAssistantPort;
  processPort: GitSyncRuntimePicks['processPort'];
  storagePort: GitSyncRuntimePicks['storagePort'];
  envPort: GitSyncRuntimePicks['envPort'];
  usageBudget: CurateUsageBudgetPort;
  runCommunitySummaryJob?: RunCommunitySummaryJob;
  scheduleDebounceMs?: number;
}): CurateHandle {
  let runtimeStarted = false;
  let stopped = false;
  let queuedRun = false;
  let activeRun: Promise<void> | null = null;
  let activeRunController: AbortController | null = null;
  let retryWakeTimer: TimerHandle | null = null;
  let debounceTimer: TimerHandle | null = null;
  let pendingCommunitySkipTicks = 0;

  const gitSync = createGitSyncController({
    kb,
    curateAssistant,
    processPort,
    storagePort,
    envPort,
  });

  function clearRetryWake(): void {
    if (retryWakeTimer !== null) {
      kb.time.clearTimeout(retryWakeTimer);
      retryWakeTimer = null;
    }
  }

  async function incrementCommunityBatchFailures(): Promise<number> {
    let nextFailures = 0;

    await kb.withMutationLock(() => {
      const state = readCurateState(curateDb(kb));
      nextFailures = state.consecutiveCommunityBatchFailures + 1;
      // Stamp on the healthy → disabled transition; preserve any earlier stamp
      // so operators see the original trip time across subsequent retries.
      const tripped = nextFailures >= INVARIANT.MAX_CONSECUTIVE_FAILURES && state.communityBatchLaneDisabledAt === null;
      writeCurateState(curateDb(kb), {
        ...state,
        consecutiveCommunityBatchFailures: nextFailures,
        communityBatchLaneDisabledAt: tripped ? nowIsoString(kb.time) : state.communityBatchLaneDisabledAt,
      });
    });

    return nextFailures;
  }

  async function runCommunityBatch(
    signal: AbortSignal,
    options: { disabledLaneAlreadyWarned?: boolean } = {},
  ): Promise<boolean> {
    if (stopped || signal.aborted) {
      return false;
    }

    if (permanentlyDisabledLanes(readCurateState(curateDb(kb))).communityBatch) {
      if (!options.disabledLaneAlreadyWarned) {
        warnCommunityBatchLanePermanentlyDisabled();
      }
      return false;
    }

    if (pendingCommunitySkipTicks > 0) {
      pendingCommunitySkipTicks -= 1;
      schedule();
      return false;
    }

    try {
      const wroteCommunityFiles = await runCommunitySubphase(kb, {
        signal,
        shouldStop: () => stopped,
        onFreshnessMismatch: schedule,
      });
      // Topology is materialized; now fill stale summaries via the recorded
      // agent (one turn, no-op when the work-list is already empty).
      let wroteSummaries = false;
      if (runCommunitySummaryJob !== undefined && !stopped && !signal.aborted) {
        wroteSummaries = await runCommunitySummaryJob(signal);
      }
      if (readCurateState(curateDb(kb)).consecutiveCommunityBatchFailures === 0) {
        pendingCommunitySkipTicks = 0;
      }
      return wroteCommunityFiles || wroteSummaries;
    } catch (error: unknown) {
      if (stopped || signal.aborted) {
        return false;
      }

      backendLog.error('kb_curate: community batch failed', error);
      const communityBatchFailures = await incrementCommunityBatchFailures();
      pendingCommunitySkipTicks = calculateCommunityBatchBackoffTicks(communityBatchFailures);
      schedule();
      return false;
    }
  }

  function armRetryWake(knownState?: CurateState): void {
    clearRetryWake();

    if (stopped || !runtimeStarted) {
      return;
    }

    const state = knownState ?? readCurateState(curateDb(kb));
    if (state.retryNotBefore === null) {
      return;
    }

    const delayMs = Date.parse(state.retryNotBefore) - kb.time.now();
    if (Number.isNaN(delayMs) || delayMs <= 0) {
      schedule();
      return;
    }

    retryWakeTimer = kb.time.setTimeout(() => {
      retryWakeTimer = null;
      schedule();
    }, delayMs);
  }

  async function runScheduledCurate(signal: AbortSignal): Promise<CurateCursor | null> {
    await kb.runInboundSync(() => gitSync.gitSync(signal), { structuredDiff: true, signal });
    let lastCompletedThrough: CurateCursor | null = null;

    while (!stopped && !signal.aborted) {
      const claim = await claimCurateRun(kb, nowIsoString(kb.time).slice(0, 10));
      if (claim === null) {
        break;
      }

      try {
        const claimIndex = kb.readIndexOrEmpty();
        const validatedAssignments = await runClassificationBatches(kb, curateAssistant, claim, claimIndex, signal);
        const metadataTargets = buildMetadataTargets(validatedAssignments, claimIndex, claim.entries);
        await commitMetadataTargets(kb, metadataTargets, {
          graphDelta: buildEntityConsolidationDelta(validatedAssignments),
        });
        gitSync.gitAutoCommit(`curate: classify ${claim.entries.length} entries (tags + principles)`);
        await clearCurateClaimRetryState(kb);
        lastCompletedThrough = claim.through;
      } catch (error: unknown) {
        throw new CurateRunError(claim.through, error);
      }
    }

    if (lastCompletedThrough === null) {
      await kb.withMutationLock(() => {
        const state = readCurateState(curateDb(kb));
        if (
          state.activeClaim !== null &&
          !isClaimStale(state, nowIsoString(kb.time), resolveCurateTimings(kb.envPort).claimStaleMs)
        ) {
          return;
        }
        clearCurateClaimRetryStateLocked(kb, state);
      });
      return null;
    }

    const processedThrough = readCurateState(curateDb(kb)).processedThrough;
    if (!stopped && !signal.aborted && processedThrough !== null) {
      try {
        await runPrincipleDiscovery(kb, curateAssistant, processedThrough, { signal, schedule });
        gitSync.gitAutoCommit('curate: discover principles');
      } catch (error: unknown) {
        throw new CurateRunError(lastCompletedThrough, error);
      }
    }

    if (!stopped && !signal.aborted) {
      if (await runCommunityBatch(signal)) {
        gitSync.gitAutoCommit('curate: update communities');
      }
    }

    if (!stopped && !signal.aborted) {
      if (await runTouchDrainSubphase(kb)) {
        gitSync.gitAutoCommit('curate: drain wiki touches');
      }
    }

    if (!stopped && !signal.aborted) {
      await gitSync.gitPush();
    }
    return lastCompletedThrough;
  }

  function launchQueuedRun(): void {
    if (stopped || !runtimeStarted || activeRun !== null || !queuedRun) {
      return;
    }

    queuedRun = false;
    const disabledLanes = permanentlyDisabledLanes(readCurateState(curateDb(kb)));
    // Keep capped lanes operator-visible even when budget exhaustion prevents work.
    warnPermanentlyDisabledLanes(disabledLanes);
    const runController = new AbortController();
    activeRunController = runController;
    activeRun = (async () => {
      let lastCompletedThrough: CurateCursor | null = null;

      try {
        try {
          if (await usageBudget.isExhausted(runController.signal)) return;
        } catch (error: unknown) {
          if (!runController.signal.aborted) {
            backendLog.error('kb_curate: usage budget check failed; provider work remains disabled', error);
          }
          return;
        }
        lastCompletedThrough = disabledLanes.claim ? null : await runScheduledCurate(runController.signal);
        if (!stopped && !runController.signal.aborted && lastCompletedThrough === null) {
          if (
            await runCommunityBatch(runController.signal, {
              disabledLaneAlreadyWarned: disabledLanes.communityBatch,
            })
          ) {
            gitSync.gitAutoCommit('curate: update communities');
          }
          if (await runTouchDrainSubphase(kb)) {
            gitSync.gitAutoCommit('curate: drain wiki touches');
          }
          await gitSync.gitPush();
        }
      } catch (error: unknown) {
        if (stopped && runController.signal.aborted) {
          try {
            await clearCurateClaimRetryState(kb);
          } catch (stateError: unknown) {
            backendLog.error('kb_curate: failed to clear stop state', stateError);
          }
          return;
        }
        const runError = error instanceof CurateRunError ? error : new CurateRunError(null, error);
        backendLog.error('kb_curate: run failed', runError.cause);
        try {
          await recordCurateFailure(kb, runError.through, runError.cause);
        } catch (stateError: unknown) {
          backendLog.error('kb_curate: failed to persist retry state', stateError);
        }
      } finally {
        activeRun = null;
        if (activeRunController === runController) {
          activeRunController = null;
        }
        try {
          if (!stopped) {
            armRetryWake();
          }
        } catch (error: unknown) {
          backendLog.error('kb_curate', error);
        }
        if (!stopped && lastCompletedThrough !== null) {
          try {
            if (await hasPendingEntriesBeyondCursor(kb, lastCompletedThrough)) {
              schedule();
            }
          } catch (error: unknown) {
            backendLog.error('kb_curate', error);
          }
        }
      }
    })();
  }

  async function start(): Promise<void> {
    if (runtimeStarted) {
      return;
    }

    gitSync.ensureKbGitignore();
    gitSync.ensureKbMergeDrivers();
    await runPendingKbMigrations(kb);
    // Curate classifies entries against the current Corpus, so it needs the
    // blocking variant — running against a stale snapshot would mis-route work.
    await kb.ensureCorpusFreshness({ wait: true });
    await initializeCurateStateIfNeeded(kb);
    const state = readCurateState(curateDb(kb));
    pendingCommunitySkipTicks =
      state.consecutiveCommunityBatchFailures > 0
        ? calculateCommunityBatchBackoffTicks(state.consecutiveCommunityBatchFailures)
        : 0;
    runtimeStarted = true;
    armRetryWake(state);
    schedule();
  }

  function schedule(): void {
    if (stopped) {
      return;
    }
    queuedRun = true;
    if (!runtimeStarted) {
      return;
    }

    clearRetryWake();
    if (debounceTimer !== null) {
      kb.time.clearTimeout(debounceTimer);
    }
    if (scheduleDebounceMs <= 0) {
      kb.time.setTimeout(launchQueuedRun, 0);
      return;
    }

    debounceTimer = kb.time.setTimeout(() => {
      debounceTimer = null;
      launchQueuedRun();
    }, scheduleDebounceMs);
  }

  async function stop(): Promise<void> {
    stopped = true;
    queuedRun = false;
    clearRetryWake();
    if (debounceTimer !== null) {
      kb.time.clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    gitSync.cancelDeferredCommit();

    const run = activeRun;
    const runController = activeRunController;
    if (runController !== null) {
      runController.abort();
    }
    if (run !== null) {
      try {
        await run;
      } catch (error: unknown) {
        if (!(stopped && runController?.signal.aborted)) {
          throw error;
        }
      }
    }
  }

  return {
    start,
    schedule,
    stop,
    scheduleDeferredCommit() {
      gitSync.scheduleDeferredCommit();
    },
    isRunning() {
      return queuedRun || activeRun !== null || retryWakeTimer !== null || debounceTimer !== null;
    },
  };
}

export function calculateCommunityBatchBackoffTicks(failureCount: number): number {
  return Math.min(2 ** Math.max(failureCount, 0), COMMUNITY_BATCH_BACKOFF_TICK_CAP);
}
