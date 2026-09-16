import { createRealRuntime } from '#src/runtime/real.js';
import { resolvedStoreEpoch, sweepStoreEpochsPostReady } from '#src/store/epoch.js';

const baseDir = process.argv[2];
const epoch = process.argv[3];
if (baseDir === undefined || epoch === undefined) {
  throw new Error('Expected a base directory and open epoch.');
}

const runtime = createRealRuntime('prod', { baseDir });
const result = await sweepStoreEpochsPostReady(runtime, resolvedStoreEpoch(runtime.paths.coral.store.dbDir, epoch));
process.stdout.write(result);
