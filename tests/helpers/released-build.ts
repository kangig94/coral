import type { requestedIntent } from '#src/coordinator/succession/intent-transitions.js';
import type { readUpgradeIntent, compareAndSwapUpgradeIntent } from '#src/infra/upgrade-intent.js';
import type { JobLocationIndex } from '#src/jobs/location-index.js';
import type { readPendingProtections } from '#src/store/epoch/pending-protection.js';
import type * as Holders from '#src/store/epoch/holder.js';
import type * as Sweep from '#src/store/epoch/post-ready-sweep.js';
import { createRequire } from 'node:module';
import { sharedFixture } from './shared-fixtures.js';
type ReleasedBuild = {
  requestedIntent?: typeof requestedIntent;
  readUpgradeIntent?: typeof readUpgradeIntent;
  compareAndSwapUpgradeIntent?: typeof compareAndSwapUpgradeIntent;
  JobLocationIndex?: typeof JobLocationIndex;
  readPendingProtections?: typeof readPendingProtections;
  pruneStoreEpochHolders?: typeof Holders.pruneStoreEpochHolders;
  sweepStoreEpochsPostReady?: typeof Sweep.sweepStoreEpochsPostReady;
};

/** Load a released build's durable-record readers rather than approximating their contracts in a test double. */
export async function loadReleasedBuild(
  tag: 'v0.10.15' | 'v0.10.16' | 'v0.10.17' | 'v0.10.18' | 'v0.10.25',
  _directories: string[],
): Promise<ReleasedBuild> {
  return createRequire(import.meta.url)(sharedFixture(tag)) as ReleasedBuild;
}
