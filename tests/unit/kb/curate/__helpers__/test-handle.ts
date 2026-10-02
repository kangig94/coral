import type { KbRuntime } from '#src/kb/contract.js';
import { runCommunitySubphase } from '#src/kb/curate/community/index.js';
import { commitMetadataTargets } from '#src/kb/curate/metadata-commit.js';
import { runPrincipleDiscovery } from '#src/kb/curate/principles.js';
import {
  cursorTimestampFromStorageSeq,
  noteCursor,
  sourceCursor,
  type CurateCursor,
} from '#src/kb/curate/state/index.js';
import { initializeCurateStateIfNeeded } from '#src/kb/curate/state/bootstrap.js';
import type { MetadataTarget, NoteMetadataTarget } from '#src/kb/curate/pipeline-types.js';
import type { CurateAssistantPort } from '#src/kb/curate/assistant.js';

type TestNoteMetadataTarget = Omit<NoteMetadataTarget, 'cursor'> & {
  cursor?: CurateCursor;
};

type TestSourceMetadataTarget = Omit<Extract<MetadataTarget, { kind: 'source' }>, 'cursor'> & {
  cursor?: CurateCursor;
};

type TestMetadataTarget = TestNoteMetadataTarget | TestSourceMetadataTarget;

export type CurateTestHandle = {
  commitMetadataTargets(targets: TestMetadataTarget[]): Promise<void>;
  runPrincipleDiscovery(processedThrough: CurateCursor): Promise<void>;
  runCommunitySubphase(): Promise<boolean>;
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
    commitMetadataTargets(targets) {
      return commitMetadataTargets(kb, targets.map(normalizeTestMetadataTarget));
    },
    runPrincipleDiscovery(processedThrough) {
      return runPrincipleDiscovery(kb, curateAssistant, processedThrough, { schedule });
    },
    runCommunitySubphase() {
      return runCommunitySubphase(kb, { shouldStop });
    },
    async initializeCurateStateIfNeeded() {
      await initializeCurateStateIfNeeded(kb);
    },
  };
}
