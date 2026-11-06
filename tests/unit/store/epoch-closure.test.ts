import { createCommitWriterPreparation } from '#src/coordinator/succession/commit/writer-preparation.js';
import { TransientCommitFailure } from '#src/coordinator/succession/commit/failure.js';
import { observeRetirementDisposition } from '#src/coordinator/succession/retirement-disposition.js';
import type { CommitState, SuccessionCommitPorts } from '#src/coordinator/succession/commit/index.js';
import type { SuccessionAttempt } from '#src/coordinator/succession/attempt-child.js';
import type { SuccessionPreparation } from '#src/coordinator/succession/protocol.js';
import type { FailureDomainObservation } from '#src/infra/failure-domain.js';
import * as processContainment from '#src/infra/process-containment.js';
import { markDurableCliExecutionEntered, recordDurableCliExecution } from '#src/jobs/durable-cli-execution.js';
import {
  writeDurableCliProcessRuntimeMeta,
  writeDurableCliProvisionalProcessRuntimeMeta,
} from '#src/jobs/runtime-meta-store.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { bindCustodyIdentity, recordCustodyIntent, initializeCustodyLedger } from '#src/store/custody-ledger.js';
import { recordEpochCustodyCoverage } from '#src/store/epoch/index.js';
import { processIncarnationSchema } from '#src/infra/node-process.js';
import {
  RetiringCustodyCertificate,
  settleSupersededEpochClosures,
} from '#src/coordinator/services/recovery/epoch-closure.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import type * as MockedFsLockModule from '#src/infra/fs-lock.js';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { recordEpochClosure, observeEpochClosure } from '#src/store/epoch/index.js';
import { readOrCreateEpochKey } from '#src/store/epoch/index.js';
import {
  encodeResolvedStoreEpoch,
  epochDirectory,
  epochPath,
  resolvedStoreEpoch,
  storeEpochLockPath,
  sweepStoreEpochsPostReady,
} from '#src/store/epoch/index.js';
import { openTestStoreDatabase } from '#tests/helpers/store-db.js';

vi.mock('#src/infra/fs-lock.js', async (loadOriginal) => ({
  ...(await loadOriginal<typeof MockedFsLockModule>()),
  attemptExclusiveFileLockSync: vi.fn(() => ({ kind: 'acquired', lease: vi.fn() })),
}));

const roots: string[] = [];
const storeFormat = currentCoralStoreFormat();
const build = {
  version: storeFormat.productVersion,
  buildSetId: '123e4567-e89b-42d3-a456-426614174000',
  bundleHash: '0123456789abcdef',
  cliBundleHash: '0123456789abcdef',
  claudeAppserverBundleHash: '0123456789abcdef',
  durableWrapperBundleHash: '0123456789abcdef',
  flavor: 'prod' as const,
  storeFormatFingerprint: storeFormat.fingerprint,
};

function harness(): Runtime {
  const baseDir = mkdtempSync(join(tmpdir(), 'coral-epoch-closure-'));
  roots.push(baseDir);
  return createRealRuntime('prod', { baseDir });
}

function publish(runtime: Runtime, epoch: string, publishedAt = '2026-09-25T00:00:00.000Z'): void {
  const root = runtime.paths.coral.store.dbDir;
  const directory = epochDirectory(root, epoch);
  mkdirSync(directory, { recursive: true });
  writeFileSync(storeEpochLockPath(root, epoch), '');
  openTestStoreDatabase({ path: epochPath(root, epoch), storage: runtime.storage, storeFormat }).close();
  writeFileSync(
    join(directory, 'epoch.json'),
    JSON.stringify({
      supersedes: null,
      classification: { kind: 'absent' },
      build,
      publishedAt,
    }),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('epoch closure reclamation', () => {
  it('retains an uncertified epoch even after historical results are released', async () => {
    const runtime = harness();
    const root = runtime.paths.coral.store.dbDir;
    for (const epoch of ['1', '2', '3']) publish(runtime, epoch);

    await sweepStoreEpochsPostReady(runtime, resolvedStoreEpoch(root, '3'), { resultsReleased: async () => true });

    expect(existsSync(epochDirectory(root, '1'))).toBe(true);
    expect(existsSync(epochDirectory(root, '3'))).toBe(true);
  });

  it('reclaims a certified closed epoch with released historical results', async () => {
    const runtime = harness();
    const root = runtime.paths.coral.store.dbDir;
    for (const epoch of ['1', '2', '3']) publish(runtime, epoch);
    const old = resolvedStoreEpoch(root, '1');
    const key = readOrCreateEpochKey(runtime, old);
    const jobKey = encodeResolvedStoreEpoch(runtime, old);
    const stateRoot = runtime.paths.coral.generation.dataRoot;
    recordEpochClosure(runtime, stateRoot, {
      version: 'v1',
      epochKey: key,
      disposition: 'closed',
      dataOutcome: 'retained',
      executionDischarge: 'certified',
      obligations: [],
      reason: 'all obligations settled',
      observedAtMs: 1,
    });

    await sweepStoreEpochsPostReady(runtime, resolvedStoreEpoch(root, '3'), {
      resultsReleased: async (epochKey) => epochKey === jobKey,
    });

    expect(existsSync(epochDirectory(root, '1'))).toBe(false);
    expect(existsSync(epochDirectory(root, '3'))).toBe(true);
    expect(existsSync(join(stateRoot, 'epoch-closure.v1'))).toBe(true);
  });
});

it('retains an unsafe closure timestamp as unreadable', () => {
  const runtime = harness();
  const stateRoot = runtime.paths.coral.generation.dataRoot;
  const evidence = {
    version: 'v1' as const,
    epochKey: 'lineage:1',
    disposition: 'closed' as const,
    dataOutcome: 'retained' as const,
    executionDischarge: 'certified' as const,
    obligations: [],
    reason: 'settled',
    observedAtMs: 1,
  };
  recordEpochClosure(runtime, stateRoot, evidence);
  const path = join(stateRoot, 'epoch-closure.v1', `${runtime.ids.sha256(evidence.epochKey)}.json`);
  writeFileSync(path, JSON.stringify({ ...evidence, observedAtMs: Number.MAX_SAFE_INTEGER + 1 }));
  expect(observeEpochClosure(runtime, stateRoot, evidence.epochKey).kind).toBe('unreadable');
});

it('keeps an unchanged closure record instead of rewriting it for a newer observation', () => {
  const runtime = harness();
  const stateRoot = runtime.paths.coral.generation.dataRoot;
  const evidence = {
    version: 'v1' as const,
    epochKey: 'lineage:1',
    disposition: 'unrecoverable-retained' as const,
    dataOutcome: 'unknown' as const,
    executionDischarge: 'undecidable' as const,
    obligations: [],
    reason: 'awaits custody',
    observedAtMs: 1,
  };
  recordEpochClosure(runtime, stateRoot, evidence);
  const sync = vi.spyOn(runtime.storage, 'syncDirectoryDurableSync');

  const rename = vi.spyOn(runtime.storage, 'renameSync');
  recordEpochClosure(runtime, stateRoot, { ...evidence, observedAtMs: 2 });
  expect(rename).not.toHaveBeenCalled();
  expect(sync).not.toHaveBeenCalled();

  const restarted: Runtime = { ...runtime, storage: new Proxy(runtime.storage, {}) };
  recordEpochClosure(restarted, stateRoot, { ...evidence, observedAtMs: 3 });
  recordEpochClosure(restarted, stateRoot, { ...evidence, observedAtMs: 4 });
  expect(rename).not.toHaveBeenCalled();
  expect(sync).toHaveBeenCalledOnce();
  expect(observeEpochClosure(runtime, stateRoot, evidence.epochKey)).toMatchObject({
    kind: 'recorded',
    evidence: { observedAtMs: 1 },
  });

  recordEpochClosure(runtime, stateRoot, { ...evidence, reason: 'still awaits custody', observedAtMs: 5 });
  expect(observeEpochClosure(runtime, stateRoot, evidence.epochKey)).toMatchObject({
    kind: 'recorded',
    evidence: { reason: 'still awaits custody', observedAtMs: 5 },
  });
});

it('excludes an active full JSON key from lineage closure candidates', async () => {
  const runtime = harness();
  for (const epoch of ['1', '2', '3']) publish(runtime, epoch);
  const old = resolvedStoreEpoch(runtime.paths.coral.store.dbDir, '1');
  const lineage = readOrCreateEpochKey(runtime, old);
  const full = encodeResolvedStoreEpoch(runtime, old);
  const index = new JobLocationIndex(
    runtime,
    runtime.paths.coral.generation.dataRoot,
    undefined,
    currentCoralStoreFormat().fingerprint,
  );
  expect(await settleSupersededEpochClosures(runtime, index, undefined, lineage, full)).toEqual([]);
});

it.each(['populated', 'unknown', 'missing'] as const)(
  'requires the correct proxy host leaf before certifying a retiring epoch (%s)',
  async (population) => {
    const runtime = harness();
    for (const epoch of ['1', '2']) publish(runtime, epoch);
    const root = runtime.paths.coral.store.dbDir;
    const old = resolvedStoreEpoch(root, '1');
    const key = readOrCreateEpochKey(runtime, old);
    const full = encodeResolvedStoreEpoch(runtime, old);
    const runDir = runtime.paths.coral.coordinator.runDir;
    const ledger = initializeCustodyLedger(runtime, runDir);
    recordEpochCustodyCoverage(runtime, epochDirectory(root, '1'), ledger);
    const instance = 'f4f88595-b227-4b3a-ae75-9a222b7d4317';
    const bind = (owner: string, operationId: string, pid: number, pgid: number, nowMs: number) => {
      const intent = recordCustodyIntent(runtime, runDir, {
        effect: 'process-spawn',
        epoch: epochDirectory(root, '1'),
        epochKey: key,
        owner,
        operationId,
        capsule: null,
        nowMs,
        bindWithinMs: 1000,
      });
      bindCustodyIdentity(runtime, runDir, intent, {
        process: { pid, incarnation: processIncarnationSchema.parse(`linux:boot:${pid}`), processGroupId: pgid },
        capsule: null,
        observedAtMs: nowMs + 1,
      });
      return intent;
    };
    bind('provider-proxy-set', `${instance}:proxy`, 9876, 9876, 50);
    const host = bind('provider-host', 'codex:1', 4321, 9876, 100);
    runtime.process.observeLiveness = () => 'absent';
    runtime.process.readProcessIncarnation = () => null;
    Object.defineProperty(runtime.process, 'failureDomainRoot', { value: { kind: 'placed', root: '/test' } });
    const name = `set-${instance}/containment/host-${host.processToken}`;
    const lookup = vi.spyOn(runtime.process, 'failureDomainContainment').mockImplementation((address) => ({
      observe: () =>
        address === name
          ? population === 'unknown'
            ? { kind: 'unknown', reason: 'EACCES' }
            : { kind: population }
          : { kind: 'missing' },
      kill: () => {
        throw new Error('host custody certification must not signal');
      },
    }));
    const index = new JobLocationIndex(
      runtime,
      runtime.paths.coral.generation.dataRoot,
      undefined,
      storeFormat.fingerprint,
    );
    const certificate = await RetiringCustodyCertificate.certify(runtime, index, full, new AbortController().signal);
    expect(certificate === null).toBe(population !== 'missing');
    expect(lookup).toHaveBeenCalledWith(name);
    expect(lookup).not.toHaveBeenCalledWith(`host-${host.processToken}`);
  },
);

it('checks each recorded durable execution when current and provisional metadata coexist', async () => {
  const runtime = harness();
  for (const epoch of ['1', '2']) publish(runtime, epoch);
  const root = runtime.paths.coral.store.dbDir;
  const old = resolvedStoreEpoch(root, '1');
  const key = readOrCreateEpochKey(runtime, old);
  initializeCustodyLedger(runtime, runtime.paths.coral.coordinator.runDir);
  const jobId = '00000000-0000-4000-8000-000000000001';
  const previous = { pid: 100, incarnation: testIncarnation(1), processGroupId: 100 };
  const provisional = { pid: 101, incarnation: testIncarnation(2), processGroupId: 101 };
  const db = openTestStoreDatabase({ path: epochPath(root, '1'), storage: runtime.storage, storeFormat });
  try {
    writeDurableCliProcessRuntimeMeta(db, {
      jobId,
      ...previous,
      childRoot: { pid: 102, incarnation: testIncarnation(3) },
    });
    writeDurableCliProvisionalProcessRuntimeMeta(db, { jobId, ...provisional });
    recordDurableCliExecution(db, { jobId, execution: 1, pid: previous.pid, incarnation: previous.incarnation });
    recordDurableCliExecution(db, { jobId, execution: 2, pid: provisional.pid, incarnation: provisional.incarnation });
  } finally {
    db.close();
  }
  runtime.process.observeLiveness = () => 'absent';
  runtime.process.readProcessIncarnation = () => null;
  Object.defineProperty(runtime.process, 'failureDomainRoot', { value: { kind: 'placed', root: '/test' } });
  const lookup = vi.spyOn(runtime.process, 'failureDomainContainment').mockImplementation((name) => ({
    observe: () => ({ kind: name === `job-${jobId}-2` ? 'populated' : 'absent' }),
    kill: () => {
      throw new Error('pre-coverage observation must not signal');
    },
  }));
  const index = new JobLocationIndex(
    runtime,
    runtime.paths.coral.generation.dataRoot,
    undefined,
    storeFormat.fingerprint,
  );
  const evidence = await settleSupersededEpochClosures(runtime, index, undefined, key);
  expect(evidence).toHaveLength(1);
  expect(evidence[0]?.executionDischarge).toBe('undecidable');
  expect(lookup).toHaveBeenCalledWith(`job-${jobId}-1`);
  expect(lookup).toHaveBeenCalledWith(`job-${jobId}-2`);
});

it.each(['unknown', 'missing', 'populated'] as const)(
  'refuses epoch certification when an existing host leaf becomes %s across the decision await',
  async (after) => {
    const runtime = harness();
    for (const epoch of ['1', '2']) publish(runtime, epoch);
    const root = runtime.paths.coral.store.dbDir;
    const old = resolvedStoreEpoch(root, '1');
    const key = readOrCreateEpochKey(runtime, old);
    const full = encodeResolvedStoreEpoch(runtime, old);
    const runDir = runtime.paths.coral.coordinator.runDir;
    const ledger = initializeCustodyLedger(runtime, runDir);
    recordEpochCustodyCoverage(runtime, epochDirectory(root, '1'), ledger);
    const intent = recordCustodyIntent(runtime, runDir, {
      effect: 'process-spawn',
      epoch: epochDirectory(root, '1'),
      epochKey: key,
      owner: 'provider-host',
      operationId: 'codex:1',
      capsule: null,
      nowMs: 100,
      bindWithinMs: 1000,
    });
    bindCustodyIdentity(runtime, runDir, intent, {
      process: { pid: 4321, incarnation: processIncarnationSchema.parse('linux:boot:4321'), processGroupId: 4321 },
      capsule: null,
      observedAtMs: 101,
    });
    Object.defineProperty(runtime.process, 'failureDomainRoot', { value: { kind: 'placed', root: '/test' } });
    let changed = false;
    vi.spyOn(runtime.process, 'failureDomainContainment').mockReturnValue({
      observe: () =>
        !changed ? { kind: 'absent' } : after === 'unknown' ? { kind: 'unknown', reason: 'EACCES' } : { kind: after },
      kill: () => {
        throw new Error('host certificate must not signal');
      },
    });
    runtime.process.readProcessIncarnation = () => null;
    runtime.process.observeLiveness = () => {
      queueMicrotask(() => {
        changed = true;
      });
      return 'absent';
    };
    const index = new JobLocationIndex(
      runtime,
      runtime.paths.coral.generation.dataRoot,
      undefined,
      storeFormat.fingerprint,
    );
    expect(await RetiringCustodyCertificate.certify(runtime, index, full, new AbortController().signal)).toBeNull();
    expect(changed).toBe(true);
  },
);

it('retains the existing-leaf requirement when confirming an already-issued epoch certificate', async () => {
  const runtime = harness();
  for (const epoch of ['1', '2']) publish(runtime, epoch);
  const root = runtime.paths.coral.store.dbDir;
  const old = resolvedStoreEpoch(root, '1');
  const key = readOrCreateEpochKey(runtime, old);
  const full = encodeResolvedStoreEpoch(runtime, old);
  const runDir = runtime.paths.coral.coordinator.runDir;
  const ledger = initializeCustodyLedger(runtime, runDir);
  recordEpochCustodyCoverage(runtime, epochDirectory(root, '1'), ledger);
  const intent = recordCustodyIntent(runtime, runDir, {
    effect: 'process-spawn',
    epoch: epochDirectory(root, '1'),
    epochKey: key,
    owner: 'provider-host',
    operationId: 'codex:1',
    capsule: null,
    nowMs: 100,
    bindWithinMs: 1000,
  });
  bindCustodyIdentity(runtime, runDir, intent, {
    process: { pid: 4321, incarnation: processIncarnationSchema.parse('linux:boot:4321'), processGroupId: 4321 },
    capsule: null,
    observedAtMs: 101,
  });
  Object.defineProperty(runtime.process, 'failureDomainRoot', { value: { kind: 'placed', root: '/test' } });
  let missing = false;
  vi.spyOn(runtime.process, 'failureDomainContainment').mockImplementation(() => ({
    observe: () => ({ kind: missing ? 'missing' : 'absent' }),
    kill: () => {
      throw new Error('host certificate must not signal');
    },
  }));
  runtime.process.readProcessIncarnation = () => null;
  runtime.process.observeLiveness = () => 'absent';
  const index = new JobLocationIndex(
    runtime,
    runtime.paths.coral.generation.dataRoot,
    undefined,
    storeFormat.fingerprint,
  );
  const certificate = await RetiringCustodyCertificate.certify(runtime, index, full, new AbortController().signal);
  expect(certificate).not.toBeNull();
  missing = true;
  expect(await certificate!.confirm(runtime, index, new AbortController().signal)).toBe(false);
});

it('refreshes earlier durable leaves after probing later pre-coverage records', async () => {
  const runtime = harness();
  for (const epoch of ['1', '2']) publish(runtime, epoch);
  const root = runtime.paths.coral.store.dbDir;
  const old = resolvedStoreEpoch(root, '1');
  const key = readOrCreateEpochKey(runtime, old);
  initializeCustodyLedger(runtime, runtime.paths.coral.coordinator.runDir);
  const jobId = '00000000-0000-4000-8000-000000000001';
  const previous = { pid: 100, incarnation: testIncarnation(1), processGroupId: 100 };
  const provisional = { pid: 101, incarnation: testIncarnation(2), processGroupId: 101 };
  const db = openTestStoreDatabase({ path: epochPath(root, '1'), storage: runtime.storage, storeFormat });
  try {
    writeDurableCliProcessRuntimeMeta(db, {
      jobId,
      ...previous,
      childRoot: { pid: 102, incarnation: testIncarnation(3) },
    });
    writeDurableCliProvisionalProcessRuntimeMeta(db, { jobId, ...provisional });
    recordDurableCliExecution(db, { jobId, execution: 1, pid: previous.pid, incarnation: previous.incarnation });
    recordDurableCliExecution(db, { jobId, execution: 2, pid: provisional.pid, incarnation: provisional.incarnation });
  } finally {
    db.close();
  }
  runtime.process.observeLiveness = () => 'absent';
  runtime.process.readProcessIncarnation = () => null;
  Object.defineProperty(runtime.process, 'failureDomainRoot', { value: { kind: 'placed', root: '/test' } });
  let firstName: string | undefined;
  let changed = false;
  vi.spyOn(runtime.process, 'failureDomainContainment').mockImplementation((name) => {
    if (firstName === undefined) firstName = name;
    else if (name !== firstName) changed = true;
    return {
      observe: () => (changed && name === firstName ? { kind: 'unknown', reason: 'EACCES' } : { kind: 'absent' }),
      kill: () => {
        throw new Error('pre-coverage observation must not signal');
      },
    };
  });
  const index = new JobLocationIndex(
    runtime,
    runtime.paths.coral.generation.dataRoot,
    undefined,
    storeFormat.fingerprint,
  );
  const evidence = await settleSupersededEpochClosures(runtime, index, undefined, key);
  expect(changed).toBe(true);
  expect(evidence[0]?.executionDischarge).toBe('undecidable');
});

it('retains a job leaf first observed by the nested reaper when it disappears before certification', async () => {
  const runtime = harness();
  for (const epoch of ['1', '2']) publish(runtime, epoch);
  const root = runtime.paths.coral.store.dbDir;
  const old = resolvedStoreEpoch(root, '1');
  const key = readOrCreateEpochKey(runtime, old);
  const full = encodeResolvedStoreEpoch(runtime, old);
  const runDir = runtime.paths.coral.coordinator.runDir;
  const ledger = initializeCustodyLedger(runtime, runDir);
  recordEpochCustodyCoverage(runtime, epochDirectory(root, '1'), ledger);
  const jobId = '00000000-0000-4000-8000-000000000001';
  const identity = { pid: 4321, incarnation: testIncarnation('nested-leaf'), processGroupId: 4321 };
  const intent = recordCustodyIntent(runtime, runDir, {
    effect: 'process-spawn',
    epoch: epochDirectory(root, '1'),
    epochKey: key,
    owner: 'durable-cli',
    operationId: jobId,
    capsule: null,
    nowMs: 100,
    bindWithinMs: 1000,
  });
  bindCustodyIdentity(runtime, runDir, intent, {
    process: identity,
    capsule: null,
    observedAtMs: 101,
  });
  const db = openTestStoreDatabase({ path: epochPath(root, '1'), storage: runtime.storage, storeFormat });
  recordDurableCliExecution(db, { jobId, execution: 1, pid: identity.pid, incarnation: identity.incarnation });
  db.close();
  Object.defineProperty(runtime.process, 'failureDomainRoot', { value: { kind: 'placed', root: '/test' } });
  let population: 'missing' | 'absent' = 'missing';
  const observe = vi.fn(() => ({ kind: population }));
  vi.spyOn(runtime.process, 'failureDomainContainment').mockReturnValue({
    observe,
    kill: () => {
      throw new Error('empty leaf certification must not signal');
    },
  });
  runtime.process.observeLiveness = () => 'absent';
  runtime.process.readProcessIncarnation = () => null;
  runtime.process.observeRecordedProcessAsync = async () => 'absent';
  const reap = processContainment.reapRecordedContainment;
  vi.spyOn(processContainment, 'reapRecordedContainment').mockImplementation(async (...args) => {
    population = 'absent';
    const outcome = await reap(...args);
    expect(outcome.kind).toBe('containment-absent');
    population = 'missing';
    return outcome;
  });
  const index = new JobLocationIndex(
    runtime,
    runtime.paths.coral.generation.dataRoot,
    undefined,
    storeFormat.fingerprint,
  );
  vi.spyOn(index, 'read').mockReturnValue({
    version: 'v1',
    jobId,
    epochKey: full,
    subject: { projectRoot: '/project', workDir: null, jobKind: 'provider' },
    disposition: 'terminal',
    detail: { kind: 'absent' },
  });
  expect(await RetiringCustodyCertificate.certify(runtime, index, full, new AbortController().signal)).toBeNull();
  expect(processContainment.reapRecordedContainment).toHaveBeenCalledOnce();
  expect(observe.mock.results.some((result) => result.type === 'return' && result.value.kind === 'absent')).toBe(true);
});

it('certifies entered job-leaf absence after closing its receipt database despite an unattributable surviving group', async () => {
  const runtime = harness();
  for (const epoch of ['1', '2']) publish(runtime, epoch);
  const root = runtime.paths.coral.store.dbDir;
  const old = resolvedStoreEpoch(root, '1');
  const key = readOrCreateEpochKey(runtime, old);
  const full = encodeResolvedStoreEpoch(runtime, old);
  const runDir = runtime.paths.coral.coordinator.runDir;
  const ledger = initializeCustodyLedger(runtime, runDir);
  recordEpochCustodyCoverage(runtime, epochDirectory(root, '1'), ledger);
  const jobId = '00000000-0000-4000-8000-000000000001';
  const identity = { pid: 4321, incarnation: testIncarnation('nested-leaf'), processGroupId: 4321 };
  const intent = recordCustodyIntent(runtime, runDir, {
    effect: 'process-spawn',
    epoch: epochDirectory(root, '1'),
    epochKey: key,
    owner: 'durable-cli',
    operationId: jobId,
    capsule: null,
    nowMs: 100,
    bindWithinMs: 1000,
  });
  bindCustodyIdentity(runtime, runDir, intent, {
    process: identity,
    capsule: null,
    observedAtMs: 101,
  });
  const db = openTestStoreDatabase({ path: epochPath(root, '1'), storage: runtime.storage, storeFormat });
  recordDurableCliExecution(db, { jobId, execution: 1, pid: identity.pid, incarnation: identity.incarnation });
  markDurableCliExecutionEntered(db, { jobId, execution: 1, ...identity });
  db.close();
  Object.defineProperty(runtime.process, 'failureDomainRoot', { value: { kind: 'placed', root: '/test' } });
  const kill = vi.fn(() => ({ kind: 'refused' as const, errno: 'EPERM' }));
  vi.spyOn(runtime.process, 'failureDomainContainment').mockReturnValue({
    observe: () => ({ kind: 'absent' }),
    kill,
  });
  runtime.process.observeLiveness = (pid) => (pid < 0 ? 'alive' : 'absent');
  runtime.process.readProcessIncarnation = () => null;
  runtime.process.observeRecordedProcessAsync = async () => 'absent';
  const index = new JobLocationIndex(
    runtime,
    runtime.paths.coral.generation.dataRoot,
    undefined,
    storeFormat.fingerprint,
  );
  vi.spyOn(index, 'read').mockReturnValue({
    version: 'v1',
    jobId,
    epochKey: full,
    subject: { projectRoot: '/project', workDir: null, jobKind: 'provider' },
    disposition: 'terminal',
    detail: { kind: 'absent' },
  });
  const certificate = await RetiringCustodyCertificate.certify(runtime, index, full, new AbortController().signal);
  expect(certificate).not.toBeNull();
  expect(await certificate!.confirm(runtime, index, new AbortController().signal)).toBe(true);
  expect(kill).not.toHaveBeenCalled();
});

it.each(['populated', 'missing', 'unknown', 'absent'] as const)(
  'refreshes custody leaf evidence immediately before retirement authorization (%s)',
  async (after) => {
    const runtime = harness();
    for (const epoch of ['1', '2']) publish(runtime, epoch);
    const root = runtime.paths.coral.store.dbDir;
    const old = resolvedStoreEpoch(root, '1');
    const key = readOrCreateEpochKey(runtime, old);
    const full = encodeResolvedStoreEpoch(runtime, old);
    const runDir = runtime.paths.coral.coordinator.runDir;
    const ledger = initializeCustodyLedger(runtime, runDir);
    recordEpochCustodyCoverage(runtime, epochDirectory(root, '1'), ledger);
    const intent = recordCustodyIntent(runtime, runDir, {
      effect: 'process-spawn',
      epoch: epochDirectory(root, '1'),
      epochKey: key,
      owner: 'provider-host',
      operationId: 'codex:1',
      capsule: null,
      nowMs: 100,
      bindWithinMs: 1000,
    });
    bindCustodyIdentity(runtime, runDir, intent, {
      process: { pid: 4321, incarnation: testIncarnation('retirement'), processGroupId: 4321 },
      capsule: null,
      observedAtMs: 101,
    });
    Object.defineProperty(runtime.process, 'failureDomainRoot', { value: { kind: 'placed', root: '/test' } });
    let population: FailureDomainObservation = { kind: 'absent' };
    vi.spyOn(runtime.process, 'failureDomainContainment').mockReturnValue({
      observe: () => population,
      kill: () => {
        throw new Error('retirement observation must not signal');
      },
    });
    runtime.process.observeLiveness = () => 'absent';
    runtime.process.readProcessIncarnation = () => null;
    const index = new JobLocationIndex(
      runtime,
      runtime.paths.coral.generation.dataRoot,
      undefined,
      storeFormat.fingerprint,
    );
    const custody = await RetiringCustodyCertificate.certify(runtime, index, full, new AbortController().signal);
    if (custody === null) throw new Error('Expected initially empty host leaf to certify custody');
    const confirmCustody = vi.fn((certificate: RetiringCustodyCertificate, signal: AbortSignal) =>
      certificate.confirm(runtime, index, signal),
    );
    const interpose = vi.fn<SuccessionCommitPorts['interposition']['at']>(async (boundary) => {
      if (boundary === 'retirement-authorization')
        population = after === 'unknown' ? { kind: 'unknown', reason: 'EACCES' } : { kind: after };
    });
    const writer = createCommitWriterPreparation(
      {
        runtime,
        incumbent: { storeFormatFingerprint: 'sha256:old' },
        retiringEpoch: {
          certificate: () => ({ revision: 1, jobIds: [] }),
          resultsReleased: async () => true,
          confirmCustody,
        },
        interposition: { at: interpose },
      } as unknown as SuccessionCommitPorts,
      { attemptAbort: new AbortController() } as CommitState,
    );
    const attemptId = '00000000-0000-4000-8000-000000000002';
    const authorization = writer.authorizeRetirement(
      { attemptId } as SuccessionAttempt,
      { epochKey: full } as SuccessionPreparation,
      custody,
      'sha256:new',
      Number(runtime.time.monotonicNow()) + 2_000,
      () => ({ kind: 'protected' }),
    );
    if (after === 'absent') {
      await authorization;
      expect(observeRetirementDisposition(runtime, attemptId).kind).toBe('recorded');
    } else {
      const failure = await authorization.then(
        () => null,
        (error: unknown) => error,
      );
      expect(observeRetirementDisposition(runtime, attemptId).kind).toBe('absent');
      expect(failure).toBeInstanceOf(TransientCommitFailure);
    }
    expect(confirmCustody).toHaveResolvedWith(true);
    expect(interpose).toHaveBeenCalledWith('retirement-authorization', { recovery: false });
  },
);
