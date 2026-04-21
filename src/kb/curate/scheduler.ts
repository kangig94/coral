import { backendLog } from '../../shared/backend-log.js';
import { errorMessage, nowIsoString } from '../../shared/utils.js';
import type { KbRuntime } from '../contracts.js';
import {
  buildEntityConsolidationDelta,
  buildMetadataTargets,
} from './classification.js';
import { runCommunitySubphase } from './community.js';
import { createGitSyncController } from './git-sync.js';
import { commitMetadataTargets } from './metadata-commit.js';
import {
  clearCurateRetryState,
  clearCurateRetryStateLocked,
  recordCurateFailure,
} from './operations.js';
import { runPrincipleDiscovery } from './principles.js';
import {
  claimCurateRun,
  hasPendingEntriesBeyondCursor,
  runClassificationBatches,
} from './runner.js';
import {
  isClaimStale,
  migrateCurateStateIfNeeded,
  readCurateState,
  writeCurateState,
  type CurateCursor,
  type CurateState,
} from './state.js';
import type { CurateHandle, GitSyncRuntimePicks, SpawnCliFn } from './types.js';
import { createRealRuntime } from '../../runtime/real.js';

export type {
  ClassificationAssignment,
  ClassificationNewEntity,
  ClassificationRelationship,
  CurateClaim,
  CurateClaimedEntry,
  CurateHandle,
  DiscoveryProposal,
  MetadataTarget,
  SpawnCliFn,
} from './types.js';
export {
  buildClassificationPrompt,
  buildMetadataTargets,
  chunkEntriesByPromptBudget,
  estimateClassificationBatchTokens,
  parseClassificationResponse,
  validateAssignments,
  type ClassificationBatchShape,
} from './classification.js';
export {
  buildDiscoveryPrompt,
  parseDiscoveryResponse,
  serializePrincipleDocument,
  validateDiscoveryProposals,
  type DiscoveryBatch,
  type DiscoveryPromptResult,
} from './discovery.js';

import { isUsageBudgetExhausted } from './usage-budget.js';

const CURATE_SCHEDULE_DEBOUNCE_MS = 60 * 1000;
const COMMUNITY_BATCH_BACKOFF_TICK_CAP = 64;

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

export function createCurateScheduler({
  kb,
  spawnCli,
  processPort,
  storagePort,
  envPort,
  scheduleDebounceMs = CURATE_SCHEDULE_DEBOUNCE_MS,
}: {
  kb: KbRuntime;
  spawnCli: SpawnCliFn;
  processPort?: GitSyncRuntimePicks['processPort'];
  storagePort?: GitSyncRuntimePicks['storagePort'];
  envPort?: GitSyncRuntimePicks['envPort'];
  scheduleDebounceMs?: number;
}): CurateHandle {
  let runtimeStarted = false;
  let stopped = false;
  let queuedRun = false;
  let activeRun: Promise<void> | null = null;
  let activeRunController: AbortController | null = null;
  let retryWakeTimer: NodeJS.Timeout | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  let pendingCommunitySkipTicks = 0;

  const ports = ((): GitSyncRuntimePicks => {
    if (processPort && storagePort && envPort) {
      return { processPort, storagePort, envPort };
    }
    const fallback = createRealRuntime();
    return {
      processPort: processPort ?? fallback.process,
      storagePort: storagePort ?? fallback.storage,
      envPort: envPort ?? fallback.env,
    };
  })();
  const gitSync = createGitSyncController({
    kb,
    spawnCli,
    ...ports,
  });

  function clearRetryWake(): void {
    if (retryWakeTimer !== null) {
      clearTimeout(retryWakeTimer);
      retryWakeTimer = null;
    }
  }

  async function incrementCommunityBatchFailures(): Promise<number> {
    let nextFailures = 0;

    await kb.withMutationLock(() => {
      const state = readCurateState(kb);
      nextFailures = state.consecutiveCommunityBatchFailures + 1;
      writeCurateState(kb, {
        ...state,
        consecutiveCommunityBatchFailures: nextFailures,
      });
    });

    return nextFailures;
  }

  async function runCommunityBatch(signal: AbortSignal): Promise<boolean> {
    if (stopped || signal.aborted) {
      return false;
    }

    if (pendingCommunitySkipTicks > 0) {
      pendingCommunitySkipTicks -= 1;
      schedule();
      return false;
    }

    try {
      const wroteCommunityFiles = await runCommunitySubphase(kb, spawnCli, {
        signal,
        shouldStop: () => stopped,
        onFreshnessMismatch: schedule,
      });
      if (readCurateState(kb).consecutiveCommunityBatchFailures === 0) {
        pendingCommunitySkipTicks = 0;
      }
      return wroteCommunityFiles;
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

    const state = knownState ?? readCurateState(kb);
    if (state.retryNotBefore === null) {
      return;
    }

    const delayMs = Date.parse(state.retryNotBefore) - Date.now();
    if (Number.isNaN(delayMs) || delayMs <= 0) {
      schedule();
      return;
    }

    retryWakeTimer = setTimeout(() => {
      retryWakeTimer = null;
      schedule();
    }, delayMs);
  }

  async function runScheduledCurate(signal: AbortSignal): Promise<CurateCursor | null> {
    await kb.runInboundSync(() => gitSync.gitSync(signal));
    let lastCompletedThrough: CurateCursor | null = null;

    while (!stopped && !signal.aborted) {
      const claim = await claimCurateRun(kb, nowIsoString().slice(0, 10));
      if (claim === null) {
        break;
      }

      try {
        const claimIndex = kb.readIndexOrEmpty();
        const validatedAssignments = await runClassificationBatches(kb, spawnCli, claim, claimIndex, signal);
        const metadataTargets = buildMetadataTargets(validatedAssignments, claimIndex, claim.entries);
        await commitMetadataTargets(kb, metadataTargets, {
          graphDelta: buildEntityConsolidationDelta(validatedAssignments),
        });
        gitSync.gitAutoCommit(`curate: classify ${claim.entries.length} entries (tags + principles)`);
        await clearCurateRetryState(kb);
        lastCompletedThrough = claim.through;
      } catch (error: unknown) {
        throw new CurateRunError(claim.through, error);
      }
    }

    if (lastCompletedThrough === null) {
      await kb.withMutationLock(() => {
        const state = readCurateState(kb);
        if (state.activeClaim !== null && !isClaimStale(state, nowIsoString())) {
          return;
        }
        clearCurateRetryStateLocked(kb, state);
      });
      return null;
    }

    const processedThrough = readCurateState(kb).processedThrough;
    if (!stopped && !signal.aborted && processedThrough !== null) {
      try {
        await runPrincipleDiscovery(kb, spawnCli, processedThrough, { signal, schedule });
        gitSync.gitAutoCommit('curate: discover principles');
      } catch (error: unknown) {
        throw new CurateRunError(lastCompletedThrough, error);
      }
    }

    if (!stopped && !signal.aborted) {
      if (await runCommunityBatch(signal)) {
        gitSync.gitAutoCommit('curate: detect communities');
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
    if (isUsageBudgetExhausted()) {
      return;
    }
    const runController = new AbortController();
    activeRunController = runController;
    activeRun = (async () => {
      let lastCompletedThrough: CurateCursor | null = null;

      try {
        lastCompletedThrough = await runScheduledCurate(runController.signal);
        if (!stopped && !runController.signal.aborted && lastCompletedThrough === null) {
          if (await runCommunityBatch(runController.signal)) {
            gitSync.gitAutoCommit('curate: detect communities');
            await gitSync.gitPush();
          }
        }
      } catch (error: unknown) {
        if (stopped && runController.signal.aborted) {
          try {
            await clearCurateRetryState(kb);
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
    await kb.ensureIndex();
    await migrateCurateStateIfNeeded(kb);
    const state = readCurateState(kb);
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
      clearTimeout(debounceTimer);
    }
    if (scheduleDebounceMs <= 0) {
      setTimeout(launchQueuedRun, 0);
      return;
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      launchQueuedRun();
    }, scheduleDebounceMs);
  }

  async function stop(): Promise<void> {
    stopped = true;
    queuedRun = false;
    clearRetryWake();
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
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
