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
import {
  cursorTimestampFromStorageSeq,
  noteCursor,
  sourceCursor,
  type CurateCursor,
  type PendingDiscovery,
} from '#src/kb/curate/state/index.js';
import { initializeCurateStateIfNeeded } from '#src/kb/curate/state/bootstrap.js';
import type {
  ClassificationAssignment,
  CurateClaim,
  MetadataTarget,
  NoteMetadataTarget,
} from '#src/kb/curate/pipeline-types.js';
import type { CurateAssistantPort } from '#src/kb/curate/assistant.js';

type TestNoteMetadataTarget = Omit<NoteMetadataTarget, 'cursor'> & {
  cursor?: CurateCursor;
};

type TestSourceMetadataTarget = Omit<Extract<MetadataTarget, { kind: 'source' }>, 'cursor'> & {
  cursor?: CurateCursor;
};

type TestMetadataTarget = TestNoteMetadataTarget | TestSourceMetadataTarget;

export type CurateTestHandle = {
  claimCurateRun(today: string): Promise<CurateClaim | null>;
  runClassificationBatches(claim: CurateClaim, index: KbIndex): Promise<ClassificationAssignment[]>;
  commitMetadataTargets(targets: TestMetadataTarget[]): Promise<void>;
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

function normalizeTestMetadataTarget(target: TestMetadataTarget): MetadataTarget {
  if (target.cursor !== undefined) {
    return target as MetadataTarget;
  }
  if (target.entrySeq === undefined) {
    throw new Error('Test metadata target without a cursor must include entrySeq.');
  }

  const timestamp = cursorTimestampFromStorageSeq(target.entrySeq);
  if (target.kind === 'note') {
    return {
      ...target,
      cursor: noteCursor(target.slug, timestamp),
    };
  }

  return {
    ...target,
    cursor: sourceCursor(target.slug, timestamp),
  };
}

export function createCurateTestHandle({
  kb,
  curateAssistant,
  schedule = () => {},
  shouldStop = () => false,
}: {
  kb: KbRuntime;
  curateAssistant: CurateAssistantPort;
  schedule?: () => void;
  shouldStop?: () => boolean;
}): CurateTestHandle {
  return {
    claimCurateRun(today) {
      return claimCurateRun(kb, today);
    },
    runClassificationBatches(claim, index) {
      return runClassificationBatches(kb, curateAssistant, claim, index);
    },
    commitMetadataTargets(targets) {
      return commitMetadataTargets(kb, targets.map(normalizeTestMetadataTarget));
    },
    runPrincipleDiscovery(processedThrough) {
      return runPrincipleDiscovery(kb, curateAssistant, processedThrough, { schedule });
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
      return runCommunitySubphase(kb, curateAssistant, { shouldStop });
    },
    calculateCommunityBatchBackoffTicks,
    async initializeCurateStateIfNeeded() {
      await initializeCurateStateIfNeeded(kb);
    },
  };
}
