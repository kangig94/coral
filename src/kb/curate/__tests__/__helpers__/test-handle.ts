import type { KbRuntime } from '../../../contracts.js';
import type { KbIndex } from '../../../entry-types.js';
import { runCommunitySubphase } from '../../community.js';
import { commitMetadataTargets } from '../../metadata-commit.js';
import { clearCurateRetryState, recordCurateFailure } from '../../operations.js';
import {
  addPendingDiscovery,
  recordDiscoveryAttempt,
  removePendingDiscovery,
  runPrincipleDiscovery,
} from '../../principles.js';
import { claimCurateRun, runClassificationBatches } from '../../runner.js';
import { calculateCommunityBatchBackoffTicks } from '../../scheduler.js';
import { migrateCurateStateIfNeeded, type CurateCursor, type PendingDiscovery } from '../../state.js';
import type { ClassificationAssignment, CurateClaim, MetadataTarget, SpawnCliFn } from '../../types.js';

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
  migrateCurateStateIfNeeded(): Promise<void>;
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
    async migrateCurateStateIfNeeded() {
      await migrateCurateStateIfNeeded(kb);
    },
  };
}
