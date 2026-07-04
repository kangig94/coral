import { errorMessage } from '../../../infra/error-format.js';
import { backendLog } from '../../../infra/backend-log.js';
import type { KbIndexMutationLane, KbIndexState, KbMutationEffects, KbRuntime } from '../../contract.js';
import type { KbIndex } from '../../entry-types.js';
import { writeFileAtomic } from '../file-atomic.js';
import { cloneKbIndex } from './records.js';
import type { ManifestAuthorityDelta } from '../manifest-types.js';

export interface CommitCorpusEntryLockedOptions {
  path: string;
  raw: string;
  manifestDeltas: readonly ManifestAuthorityDelta[];
  indexUpdate: (index: KbIndex) => void;
  lane: KbIndexMutationLane;
  reason: string;
}

/**
 * Clone the current index, apply the updater, and write it back.
 * If no index exists on disk, updater receives an empty index.
 * @precondition Caller already holds `rt.withMutationLock()`.
 */
export function commitIndexUpdate(
  rt: Pick<KbRuntime, 'readIndex' | 'writeIndex'>,
  updater: (index: KbIndex) => void,
): void {
  const nextIndex = cloneKbIndex(rt.readIndex());
  updater(nextIndex);
  rt.writeIndex(nextIndex);
}

/**
 * Commit a single corpus markdown file create/update while the caller holds
 * the KB mutation lock.
 */
export function commitCorpusEntryLocked(
  rt: Pick<KbRuntime, 'storagePort' | 'ids' | 'readIndex' | 'writeIndex' | 'recordMutationCommitted'>,
  mutation: Pick<KbMutationEffects, 'queueManifestAuthorityDelta'>,
  { path, raw, manifestDeltas, indexUpdate, lane, reason }: CommitCorpusEntryLockedOptions,
): KbIndexState {
  writeFileAtomic(rt, path, raw);
  mutation.queueManifestAuthorityDelta(manifestDeltas);
  commitIndexUpdate(rt, indexUpdate);
  return rt.recordMutationCommitted(lane, reason);
}

export function recordMetadataMutation(rt: Pick<KbRuntime, 'recordMutationCommitted'>, reason: string): KbIndexState {
  return rt.recordMutationCommitted('metadata', reason);
}

export function recordContentAndMetadataMutation(
  rt: Pick<KbRuntime, 'recordMutationCommitted'>,
  reason: string,
): KbIndexState {
  return rt.recordMutationCommitted('both', reason);
}

export function markTextIndexStale(invalidate: (reason: string) => KbIndexState, reason: string): void {
  try {
    invalidate(reason);
  } catch (error: unknown) {
    backendLog.warn(`markTextIndexStale: ${errorMessage(error)}`);
  }
}
