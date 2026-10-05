import type { WaitStreamEvent, WaitCursor } from '#src/jobs/wait/contract.js';
import type { JobLocationIndex } from '#src/jobs/location-index.js';
import type { readPendingProtections } from '#src/store/epoch/pending-protection.js';
import type * as Holders from '#src/store/epoch/holder.js';
import type * as Sweep from '#src/store/epoch/post-ready-sweep.js';
import { createRequire } from 'node:module';
import { sharedFixture } from './shared-fixtures.js';
type ReleasedWait = {
  parseWaitStreamEventValue(value: unknown): WaitStreamEvent;
  advanceWaitRenderCursor(cursor: WaitCursor, event: WaitStreamEvent): { cursor: WaitCursor };
  formatWaitTerminal(event: WaitStreamEvent, labels: null, embed: boolean): string;
  formatWaitWaiting(event: WaitStreamEvent, cursor: string, jobIds: string[]): string;
  serializeWaitCursor(cursor: WaitCursor): string;
  JobLocationIndex?: typeof JobLocationIndex;
  jobWaitSchema: { parse(request: unknown): unknown };
  readPendingProtections?: typeof readPendingProtections;
  pruneStoreEpochHolders?: typeof Holders.pruneStoreEpochHolders;
  sweepStoreEpochsPostReady?: typeof Sweep.sweepStoreEpochsPostReady;
};

/** Load the released decoder and formatter rather than approximating their contracts in a test double. */
export async function loadReleasedWait(
  tag: 'v0.10.15' | 'v0.10.16' | 'v0.10.17' | 'v0.10.18',
  _directories: string[],
): Promise<ReleasedWait> {
  return createRequire(import.meta.url)(sharedFixture(tag)) as ReleasedWait;
}
