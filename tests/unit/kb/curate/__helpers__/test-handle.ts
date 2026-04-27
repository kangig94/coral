import type { KbRuntime } from '#src/kb/contract.js';
import type { KbIndex } from '#src/kb/entry-types.js';
import { runCommunitySubphase } from '#src/kb/curate/community/index.js';
import { commitMetadataTargets } from '#src/kb/curate/metadata-commit.js';
import { clearCurateRetryState, recordCurateFailure } from '#src/kb/curate/operations.js';
import {
  addPendingDiscovery,
  recordDiscoveryAttempt,
  removePendingDiscovery,
  runPrincipleDiscovery,
} from '#src/kb/curate/principles.js';
import { claimCurateRun, runClassificationBatches } from '#src/kb/curate/runner.js';
import { calculateCommunityBatchBackoffTicks } from '#src/kb/curate/scheduler.js';
import { type CurateCursor, type PendingDiscovery } from '#src/kb/curate/state/index.js';
import { initializeCurateStateIfNeeded } from '#src/kb/curate/state/bootstrap.js';
import type { ClassificationAssignment, CurateClaim, MetadataTarget, SpawnCliFn } from '#src/kb/curate/pipeline-types.js';

export type CurateTestHandle = {
  claimCurateRun(today: string): Promise<CurateClaim | null>;
  runClassificationBatches(claim: CurateClaim, index: KbIndex): Promise<ClassificationAssignment[]>;
  commitMetadataTargets(targets: MetadataTarget[]): Promise<void>;
  runPrincipleDiscovery(processedThrough: CurateCursor): Promise<void>;
  recordCurateFailure(through: CurateCursor | null, error: unknown): Promise<void>;
  clearCurateRetryState(): Promise<void>;
  recordDiscoveryAttempt(highSeq: number, nextOffset: number): Promise<void>;
  addPendingDiscovery(entry: PendingDiscovery): Promise<void>;
  removePendingDiscovery(entry: PendingDiscovery): Promise<void>;
  runCommunitySubphase(): Promise<boolean>;
  calculateCommunityBatchBackoffTicks(failureCount: number): number;
  initializeCurateStateIfNeeded(): Promise<void>;
};

export function createCurateTestHandle({
  kb,
  spawnCli,
  schedule = () => {},
  shouldStop = () => false,
}: {
  kb: KbRuntime;
  spawnCli: SpawnCliFn;
  schedule?: () => void;
  shouldStop?: () => boolean;
}): CurateTestHandle {
  return {
    claimCurateRun(today) {
      return claimCurateRun(kb, today);
    },
    runClassificationBatches(claim, index) {
      return runClassificationBatches(kb, spawnCli, claim, index);
    },
    commitMetadataTargets(targets) {
      return commitMetadataTargets(kb, targets);
    },
    runPrincipleDiscovery(processedThrough) {
      return runPrincipleDiscovery(kb, spawnCli, processedThrough, { schedule });
    },
    recordCurateFailure(through, error) {
      return recordCurateFailure(kb, through, error);
    },
    clearCurateRetryState() {
      return clearCurateRetryState(kb);
    },
    recordDiscoveryAttempt(highSeq, nextOffset) {
      return recordDiscoveryAttempt(kb, highSeq, nextOffset);
    },
    addPendingDiscovery(entry) {
      return addPendingDiscovery(kb, entry);
    },
    removePendingDiscovery(entry) {
      return removePendingDiscovery(kb, entry);
    },
    runCommunitySubphase() {
      return runCommunitySubphase(kb, spawnCli, { shouldStop });
    },
    calculateCommunityBatchBackoffTicks,
    async initializeCurateStateIfNeeded() {
      await initializeCurateStateIfNeeded(kb);
    },
  };
}
