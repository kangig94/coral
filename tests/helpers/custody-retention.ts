import { reconcileFinishedCustody } from '#src/coordinator/services/recovery/custody-reconciliation.js';
import { createAsyncRecordedProcessObserver, processIncarnationSchema } from '#src/infra/node-process.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import {
  bindCustodyIdentity,
  pruneCustodyLedger,
  readCustodyLedger,
  recordCustodyIntent,
} from '#src/store/custody-ledger.js';
import { type createRetentionFixture } from '#tests/helpers/storage-retention.js';
import { vi } from 'vitest';

export function createCustodyRetentionFixture(f: ReturnType<typeof createRetentionFixture>) {
  const runDir = f.runtime.paths.coral.coordinator.runDir;
  const index = new JobLocationIndex(f.runtime, f.runtime.paths.coral.generation.dataRoot);
  let monotonic = 0n;
  f.runtime.time.monotonicNow = () => monotonic;
  f.runtime.time.sleep = async (ms) => {
    monotonic += BigInt(ms);
  };
  f.runtime.process.observeLiveness = () => 'absent';
  f.runtime.process.readProcessIncarnation = () => null;
  f.runtime.process.observeRecordedProcessAsync = createAsyncRecordedProcessObserver({
    observeLiveness: (pid) => f.runtime.process.observeLiveness(pid),
    readIncarnation: async (pid) => f.runtime.process.readProcessIncarnation(pid, process.platform),
  });
  f.runtime.process.observeProcessIdentities = async (owners) =>
    owners.map((owner) => {
      if (f.runtime.process.observeLiveness(owner.pid) === 'absent') return { owner, evidence: { kind: 'pid-absent' } };
      const incarnation = f.runtime.process.readProcessIncarnation(owner.pid, process.platform);
      return incarnation === null
        ? { owner, evidence: { kind: 'unobservable', cause: 'incarnation-unavailable' } }
        : { owner, evidence: { kind: 'incarnation', incarnation } };
    });
  f.runtime.process.kill = vi.fn(() => false);
  const bound = (owner = 'provider-host') => {
    const intent = recordCustodyIntent(f.runtime, runDir, {
      effect: 'process-spawn',
      epoch: 'epoch-1',
      owner,
      operationId: 'operation',
      capsule: null,
      nowMs: 100,
      bindWithinMs: 1000,
    });
    bindCustodyIdentity(f.runtime, runDir, intent, {
      process: { pid: 4321, incarnation: processIncarnationSchema.parse('linux:boot:123'), processGroupId: 4321 },
      capsule: null,
      observedAtMs: 200,
    });
    const entry = readCustodyLedger(f.runtime, runDir).find(
      (entry) => entry.kind !== 'unreadable' && entry.intent.id === intent.id,
    )!;
    if (entry.kind !== 'bound') throw new Error('fixture must be bound');
    return entry;
  };
  const reconcile = () =>
    reconcileFinishedCustody({
      runtime: f.runtime,
      runDir,
      index,
      afterId: '',
      budget: f.budget,
      signal: new AbortController().signal,
      mutate: (operation) => operation(),
    });
  const prune = (cutoff: number) =>
    pruneCustodyLedger({
      runtime: f.runtime,
      runDir,
      cutoff,
      afterId: '',
      budget: f.budget,
      mutate: (operation) => operation(),
    });
  return { ...f, runDir, index, bound, reconcile, prune };
}
