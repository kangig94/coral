import { errorMessage } from '../../infra/error-format.js';
import { backendLog } from '../../infra/backend-log.js';
import type { KbIndexState, KbRuntime } from '../contracts.js';
import type { KbIndex } from '../entry-types.js';
import { cloneKbIndex } from './index-records.js';

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

export function recordContentMutation(rt: Pick<KbRuntime, 'recordMutationCommitted'>, reason: string): KbIndexState {
  return rt.recordMutationCommitted('content', reason);
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
