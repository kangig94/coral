// AC9 / Phase 6: KB pipeline checkpoint honor through the real `jobs.abort`
// path. Two concerns are tested here:
//
//   1) Positive: dispatch source-import or reindex, pause at a controllable
//      named checkpoint, fire abort through `AbortRegistry.abort`, release
//      the checkpoint, and assert the job's terminal outcome is
//      `aborted/user_abort` within bounded time.
//
//   2) Negative: trigger the mutation-lock deadline signal for KB work and
//      assert the terminal outcome is NOT `aborted/user_abort` — it must
//      record a failed/causeRef outcome instead.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KbReindexService } from '#src/coordinator/services/kb-reindex-service.js';
import { KbSourceImportService } from '#src/coordinator/services/kb-source-import-service.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { JobStore } from '#src/jobs/job-store.js';
import { AbortError } from '#src/runtime/abort.js';
import type { KbCorpusSnapshot, KbRuntime } from '#src/kb/contract.js';
import type { CurateHandle } from '#src/kb/curate/scheduler.js';
import type { KnowledgeBaseRuntime } from '#src/kb/subsystem.js';
import type { JobAbortRegistryPort } from '#src/jobs/contracts/abort-registry.js';
import type { TerminalOutcome } from '#src/jobs/outcome.js';
import type { StoragePort } from '#src/runtime/ports.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';

const tempRoots: string[] = [];
const openDbs: Array<{ close(): void }> = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of openDbs.splice(0)) {
    db.close();
  }
  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface ServiceWorld {
  kb: KbRuntime;
  kbSubsystem: KnowledgeBaseRuntime;
  abortRegistry: AbortRegistry;
  progressStore: JobStore;
  jobIds: () => string[];
  runtime: SimulationRuntime;
  markdownRoot: string;
  runtimeDir: string;
}

function makeWorld(): ServiceWorld {
  const root = mkdtempSync(join(tmpdir(), 'coral-ac9-'));
  tempRoots.push(root);
  const markdownRoot = join(root, 'kb');
  const runtimeDir = join(root, 'runtime');
  mkdirSync(markdownRoot, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });

  const storeDb = createKbTestDb(runtimeDir);
  openDbs.push(storeDb);
  const kb = createTestKbRuntime({ markdownRoot, runtimeDir, db: storeDb });

  // Curate scheduler is only consulted by KbSourceImportService — and only
  // its `scheduleDeferredCommit` method. A no-op handle is sufficient.
  const curateScheduler = {
    start: async () => {},
    stop: async () => {},
    scheduleDeferredCommit: () => {},
  } as unknown as CurateHandle;

  const kbSubsystem: KnowledgeBaseRuntime = { kb, curateScheduler };

  // JobStore + AbortRegistry composed against the same DB.
  const jobsDb = new Database(':memory:');
  openDbs.push(jobsDb);
  const nodeStorage: Pick<StoragePort, 'readFileSync' | 'readdirSync'> = {
    readFileSync: readFileSync as StoragePort['readFileSync'],
    readdirSync: readdirSync as StoragePort['readdirSync'],
  };
  applyStoreSchemas({ db: jobsDb, storage: nodeStorage });
  const runtime = new SimulationRuntime();
  const progressStore = new JobStore('test-ns', runtime, createDefaultUpcasterRegistry(), { db: jobsDb });
  const abortRegistry = new AbortRegistry(runtime.ids);

  // Capture launched job ids by spying on the public append method — keeps
  // the test off private JobStore state.
  const observedJobIds: string[] = [];
  vi.spyOn(progressStore, 'appendLaunchRequested').mockImplementation(function (
    this: JobStore,
    jobId: string,
    launch,
  ): void {
    observedJobIds.push(jobId);
    return JobStore.prototype.appendLaunchRequested.call(this, jobId, launch);
  });

  return {
    kb,
    kbSubsystem,
    abortRegistry,
    progressStore,
    runtime,
    markdownRoot,
    runtimeDir,
    jobIds: () => [...observedJobIds],
  };
}

async function awaitJobId(world: ServiceWorld, timeoutMs = 1000): Promise<string> {
  const startedAt = Date.now();
  for (;;) {
    const ids = world.jobIds();
    if (ids.length > 0) return ids[ids.length - 1];
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('jobId never appeared within timeout');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function awaitTerminalOutcome(
  store: JobStore,
  jobId: string,
  timeoutMs = 4000,
): Promise<TerminalOutcome> {
  const startedAt = Date.now();
  for (;;) {
    const status = store.readStatus(jobId);
    if (status?.result !== undefined) {
      return status.result.outcome;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`No terminal recorded for ${jobId} within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('KB pipeline checkpoint honor (AC9) — reindex', () => {
  let world: ServiceWorld;

  beforeEach(() => {
    world = makeWorld();
  });

  it('user_abort during readiness wait records terminal aborted/user_abort', async () => {
    const readinessGate = createDeferred<void>();

    const reindexService = new KbReindexService({
      runtime: world.runtime,
      progressStore: world.progressStore,
      backendNamespace: 'test-ns',
      bundleHash: 'bundle-a',
      abortRegistry: world.abortRegistry as unknown as JobAbortRegistryPort,
      waitForReadiness: async ({ signal }) => {
        // Hold execution at the named `readiness` checkpoint while the test
        // fires abort through the real registry path.
        await readinessGate.promise;
        // Re-throw an AbortError post-release if the signal aborted while we
        // waited — the service's catch arm maps `reason === 'user_abort'`
        // to the `aborted/user_abort` terminal record.
        if (signal?.aborted === true) {
          throw new AbortError({ stage: 'readiness', reason: signal.reason });
        }
      },
    });

    const runPromise = reindexService.run({ projectRoot: world.markdownRoot }, world.kbSubsystem);

    const jobId = await awaitJobId(world);

    // Real jobs.abort path: AbortRegistry.abort → callback → controller.abort('user_abort').
    expect(world.abortRegistry.abort([jobId])).toEqual({ aborted: [jobId], notFound: [] });
    readinessGate.resolve();
    await runPromise;

    const outcome = await awaitTerminalOutcome(world.progressStore, jobId);
    expect(outcome).toEqual({ kind: 'aborted', reason: 'user_abort' });
  });

  it('mutation-lock deadline NEVER records aborted/user_abort — falls through to failed', async () => {
    // Negative test. Force `kb.withMutationLock` to throw an AbortError whose
    // reason is the deadline shape `{ kind: 'mutation_deadline', timeoutMs }`.
    // The service's catch arm filters on `reason === 'user_abort'` only, so
    // the deadline-shaped error must record a failed terminal.
    const reindexService = new KbReindexService({
      runtime: world.runtime,
      progressStore: world.progressStore,
      backendNamespace: 'test-ns',
      bundleHash: 'bundle-a',
      abortRegistry: world.abortRegistry as unknown as JobAbortRegistryPort,
      waitForReadiness: async () => {},
    });

    const fakeKb = withDeadlineThrowingMutationLock(world.kb);
    const fakeSubsystem: KnowledgeBaseRuntime = {
      kb: fakeKb,
      curateScheduler: world.kbSubsystem.curateScheduler,
    };

    const result = await reindexService.run({ projectRoot: world.markdownRoot }, fakeSubsystem);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.code).toBe('kb_reindex_failed');
    }

    const jobId = await awaitJobId(world);
    const outcome = await awaitTerminalOutcome(world.progressStore, jobId);
    expect(outcome.kind).toBe('failed');
    expect(outcome).not.toMatchObject({ kind: 'aborted' });
  });
});

describe('KB pipeline checkpoint honor (AC9) — source-import', () => {
  let world: ServiceWorld;

  beforeEach(() => {
    world = makeWorld();
  });

  it('user_abort during readiness wait records terminal aborted/user_abort', async () => {
    // Stage a real markdown file so prepare + persist succeed; pause at the
    // readiness checkpoint to fire abort.
    const stagedFile = join(world.runtimeDir, 'incoming.md');
    writeFileSync(stagedFile, '# Incoming Source\n\nBody.\n', 'utf-8');

    const readinessGate = createDeferred<void>();

    const importService = new KbSourceImportService({
      runtime: world.runtime,
      progressStore: world.progressStore,
      backendNamespace: 'test-ns',
      bundleHash: 'bundle-a',
      abortRegistry: world.abortRegistry as unknown as JobAbortRegistryPort,
      waitForReadiness: async ({ signal }) => {
        await readinessGate.promise;
        if (signal?.aborted === true) {
          throw new AbortError({ stage: 'readiness', reason: signal.reason });
        }
      },
    });

    // Async mode so the promise can finish via the abort path.
    const started = await importService.start(
      { filePath: stagedFile, readiness: 'base-search', async: true },
      { projectRoot: world.markdownRoot },
      world.kbSubsystem,
    );
    expect(started.ok).toBe(true);
    if (started.ok === false) throw new Error('expected start ok');

    const jobId = await awaitJobId(world);

    // Wait until prepare + persist complete and the service enters the
    // readiness checkpoint (the abort registry stays populated until
    // finalize runs after the catch arm).
    expect(world.abortRegistry.has(jobId)).toBe(true);
    expect(world.abortRegistry.abort([jobId])).toEqual({ aborted: [jobId], notFound: [] });
    readinessGate.resolve();

    const outcome = await awaitTerminalOutcome(world.progressStore, jobId);
    expect(outcome).toEqual({ kind: 'aborted', reason: 'user_abort' });
  });
});

/**
 * Wraps a real KbRuntime so `withMutationLock` fails with a deadline-shaped
 * AbortError, mimicking the cooperative deadline propagation. Other methods
 * delegate to the real kb so KbReindexService's other touches keep working.
 */
function withDeadlineThrowingMutationLock(real: KbRuntime): KbRuntime {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'withMutationLock') {
        return async () => {
          throw new AbortError({
            stage: 'mutation',
            reason: { kind: 'mutation_deadline', timeoutMs: 1 },
          });
        };
      }
      if (prop === 'getCorpusStateSnapshot') {
        return (): KbCorpusSnapshot => ({
          snapshotId: 'snap',
          contentSeq: 0,
          metadataSeq: 0,
          contentManifestHash: 'h',
          metadataManifestHash: 'h',
        });
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
