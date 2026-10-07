import assert from 'node:assert/strict';
import { tryAcquireExclusiveFileLockSync } from '#src/infra/fs-lock.js';
import { openReadOnlyStoreDatabase } from '#src/store/read-port.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  settleStoreEpoch,
  retirementMintDisposition,
  discardCurrentStoreEpoch,
  encodeResolvedStoreEpoch,
  resolveProtectedEpoch,
  storeEpochLockPath,
} from '#src/store/epoch/index.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { CoralStore } from '#src/read-model/coral-store.js';
import { createDefaultStoreReadContext } from '#src/read-model/read-context.js';
import { createCauseRefRenderer } from '#src/causality/render.js';
import { defaultEventDescribers } from '#src/read-model/event-describers.js';
import { openCliCauseRefRenderer } from '#src/cli/cause-renderer.js';
import { emitWaitEvent } from '#src/cli/follow.js';
import { renderCauseRefFallback } from '#src/causality/cause-ref.js';
import { formatWaitTerminal } from '#src/cli/format/wait.js';
const runtime = createRealRuntime('prod');
const storeFormat = currentCoralStoreFormat();
const options = {
  storeFormat,
  build: {
    version: storeFormat.productVersion,
    buildSetId: '123e4567-e89b-42d3-a456-426614174000',
    bundleHash: '0123456789abcdef',
    cliBundleHash: '0123456789abcdef',
    claudeAppserverBundleHash: '0123456789abcdef',
    durableWrapperBundleHash: '0123456789abcdef',
    flavor: 'prod',
    storeFormatFingerprint: storeFormat.fingerprint,
  },
  authorizeMint: ({ incumbent, incumbentEpochKey, observedEpochCount }) =>
    retirementMintDisposition(
      incumbent === null ? (observedEpochCount === 0 ? 'initial' : 'unopenable') : 'retired',
      incumbentEpochKey,
    ),
};
const old = settleStoreEpoch(runtime, options);
const ref = { stream: { kind: 'job', id: 'historical-failed-job' }, seq: 1 };
old.db
  .prepare(
    `INSERT INTO events (seq,ts,type,stream_kind,stream_id,namespace,project,correlation_id,causation_seq,refs,body) VALUES (1,?, 'job.progress.emitted', 'job', ?, NULL,NULL,NULL,NULL,NULL,?)`,
  )
  .run(
    new Date().toISOString(),
    ref.stream.id,
    Buffer.from(
      JSON.stringify({
        kind: 'domain',
        stage: 'provider_operation_failed',
        message: 'Unique retained failure explanation',
        detail: { code: 'activation_indeterminate' },
      }),
    ),
  );
const correct = createCauseRefRenderer(defaultEventDescribers).describe(
  ref,
  new CoralStore(old.db, createDefaultStoreReadContext()),
);
const before = openCliCauseRefRenderer(process.cwd()).render(ref);
console.log('before epoch switch:', before);
assert.equal(before, correct);
const oldKey = encodeResolvedStoreEpoch(runtime, old.store);
old.db.close();
const next = discardCurrentStoreEpoch(runtime, options);
next.db.close();
const protectedEpoch = resolveProtectedEpoch(runtime, old.store.storeRoot, JSON.parse(oldKey).lineageKey);
assert.ok(protectedEpoch, 'Original epoch must still be retained');
const retainedDb = openReadOnlyStoreDatabase(runtime, {
  storeFormat,
  resolved: { path: protectedEpoch.path, epoch: protectedEpoch, epochCandidate: null },
});
const stillRetained = createCauseRefRenderer(defaultEventDescribers).describe(
  ref,
  new CoralStore(retainedDb, createDefaultStoreReadContext()),
);
retainedDb.close();
assert.equal(stillRetained, correct, 'Protected epoch must still decode the same explanation');
console.log('verified cause still decodes from:', protectedEpoch.path);
const after = openCliCauseRefRenderer(process.cwd()).render(ref, { kind: 'failed', causeRef: ref }, oldKey);
console.log('old epoch:', oldKey);
console.log('current epoch:', encodeResolvedStoreEpoch(runtime, next.store));
console.log('retained cause:', correct);
console.log('CLI after epoch switch:', after);
console.log(
  formatWaitTerminal(
    {
      type: 'terminal',
      jobId: ref.stream.id,
      sessionId: null,
      seq: 2,
      ts: new Date().toISOString(),
      epochKey: oldKey,
      result: { output: '', outcome: { kind: 'failed', causeRef: ref } },
      resultPath: '/tmp/result.md',
      availability: { kind: 'available', resultPath: '/tmp/result.md' },
      remainingJobIds: [],
      cursor: null,
      exitCode: 1,
    },
    null,
    false,
    { describeCauseRef: () => after },
  ),
);
assert.equal(after, correct, 'CLI must render a historical cause from its retained epoch');

const renderer = openCliCauseRefRenderer(process.cwd());
assert.notEqual(renderer.render(ref), correct, 'Current epoch has no historical cause');
assert.equal(renderer.render(ref, undefined, 'invalid-address'), renderCauseRefFallback(ref));
const forged = JSON.parse(oldKey);
forged.lineageKey = 'wrong-lineage:' + forged.epoch;
assert.equal(renderer.render(ref, undefined, JSON.stringify(forged)), renderCauseRefFallback(ref));
const event = {
  type: 'terminal',
  jobId: ref.stream.id,
  epochKey: oldKey,
  seq: 2,
  result: { content: '', durationMs: 0, outcome: { kind: 'failed', causeRef: ref } },
  resultPath: '/tmp/result.md',
  availability: { kind: 'available', resultPath: '/tmp/result.md' },
  remainingJobIds: [],
  cursor: null,
  exitCode: 1,
};
let output = '';
const write = process.stdout.write;
process.stdout.write = (chunk) => {
  output += chunk;
  return true;
};
try {
  emitWaitEvent(event, null, null, [], { isTTY: false, columns: 100, embed: false }, renderer.render);
} finally {
  process.stdout.write = write;
  renderer.close();
}
assert.ok(output.includes(correct), 'Wait rendering must forward the terminal epoch');
console.log('Historical wait render and invalid-lineage controls passed');

const lease = tryAcquireExclusiveFileLockSync(storeEpochLockPath(protectedEpoch.storeRoot, protectedEpoch.epoch));
assert.ok(lease, 'Cause rendering must release the retained epoch read lease');
lease();
