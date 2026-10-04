import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { JobStore } from '../../../src/jobs/store.js';
import type { Database } from '../../../src/store/db.js';
import { observeResolvedStoreEpoch } from '../../../src/store/epoch/observation.js';
import { join } from 'node:path';
import { createRealRuntime } from '../../../src/runtime/real.js';
import { JobLocationIndex } from '../../../src/jobs/location-index.js';
import { renderWorkflowReport } from '../../../src/workflow/result-report.js';
import { withTerminalSource } from '../../../src/jobs/terminal/source.js';

const [root, epochKey, pause, origin, kbBundle] = process.argv.slice(2);
const real = createRealRuntime('prod', { baseDir: root });
const now = () => Number(readFileSync(join(root, 'clock'), 'utf8'));
const runtime = {
  ...real,
  paths: {
    ...real.paths,
    coral: { ...real.paths.coral, generation: { ...real.paths.coral.generation, dataRoot: root } },
  },
  time: { ...real.time, now, monotonicNow: () => BigInt(now()) },
};
const index = new JobLocationIndex(runtime, root, renderWorkflowReport);
const publish = runtime.storage.writeAtomicDurableSync;
const pauseHere = () => {
  process.send?.({ kind: 'paused', origin });
  const barrier = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(join(root, 'resume'))) Atomics.wait(barrier, 0, 0, 10);
};
runtime.storage.writeAtomicDurableSync = (path, data, options) => {
  if (path !== index.resultPathFor('job-1')) return publish(path, data, options);
  if (pause === 'pre-stage') pauseHere();
  return publish(path, data, {
    ...options,
    beforeRename: () => {
      return options?.beforeRename?.() ?? true;
    },
  });
};
(globalThis as { phaseCStage?: (path: string) => void }).phaseCStage = (path) => {
  if (pause === 'staged' && path === index.resultPathFor('job-1')) pauseHere();
};
withTerminalSource(runtime, epochKey, (db) => {
  let owner;
  if (origin === 'kb') {
    const { createKbDaemonProgressStore } = createRequire(import.meta.url)(kbBundle) as {
      createKbDaemonProgressStore(input: {
        options: Record<string, never>;
        runtime: typeof runtime;
        guardedRuntime: typeof runtime;
        activeDb: Database;
        resolvedStore: ReturnType<typeof observeResolvedStoreEpoch>;
        backendNamespace: string;
      }): JobStore;
    };
    const store = createKbDaemonProgressStore({
      options: {},
      runtime,
      guardedRuntime: runtime,
      activeDb: db,
      resolvedStore: observeResolvedStoreEpoch(runtime, epochKey),
      backendNamespace: 'fixture',
    });
    owner = store.getResultExportOwner();
  } else {
    owner = index.resultExportOwnerForSource(db, epochKey, runtime.paths.coral.exports.jobsRoot);
  }
  owner.ensureResultMarkdownArtifact('job-1');
  process.send?.({ kind: 'done', availability: owner.observeResultAvailability('job-1').kind });
});
process.disconnect?.();
