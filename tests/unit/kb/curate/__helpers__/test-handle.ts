import type { KbRuntime } from '#src/kb/contract.js';
import { commitMetadataTargets } from '#src/kb/curate/metadata-commit.js';
import {
  cursorTimestampFromStorageSeq,
  noteCursor,
  sourceCursor,
  type CurateCursor,
} from '#src/kb/curate/state/index.js';
import type { MetadataTarget, NoteMetadataTarget } from '#src/kb/curate/pipeline-types.js';

type TestNoteMetadataTarget = Omit<NoteMetadataTarget, 'cursor'> & {
  cursor?: CurateCursor;
};

type TestSourceMetadataTarget = Omit<Extract<MetadataTarget, { kind: 'source' }>, 'cursor'> & {
  cursor?: CurateCursor;
};

type TestMetadataTarget = TestNoteMetadataTarget | TestSourceMetadataTarget;

export type CurateTestHandle = {
  commitMetadataTargets(targets: TestMetadataTarget[]): Promise<void>;
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

export function createCurateTestHandle({ kb }: { kb: KbRuntime }): CurateTestHandle {
  return {
    commitMetadataTargets(targets) {
      return commitMetadataTargets(kb, targets.map(normalizeTestMetadataTarget));
    },
  };
}
