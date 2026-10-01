import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRealRuntime } from '#src/runtime/real.js';
import { JobStore } from '#src/jobs/store.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { discussRegistry } from '#src/discuss/event-registry.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { allocateTestSession } from '#tests/helpers/session.js';
import { SessionManager } from '#src/sessions/shell.js';
import { openStoreDatabase } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { joinSuccessionWriterGeneration } from '#src/store/succession-writer-generation.js';
import { LaunchOrchestrator } from '#src/jobs/shell/launch.js';
import * as transport from '#src/coordinator/live/durable-transport.js';
const { awaitDurableLaunchResult } = transport as unknown as {
  awaitDurableLaunchResult: (
    params: unknown,
    state: unknown,
    durable: unknown,
    settle: unknown,
    hold: unknown,
    cleanup: unknown,
  ) => Promise<{ code: number | null }>;
};
import type { SpawnDurableJobOptions } from '#src/coordinator/live/durable-transport.js';
import type { DurableProcessExit } from '#src/runtime/durable-runtime.js';

import { readAppendedLines } from '#src/infra/file-tail.js';
import * as adoption from '#src/coordinator/services/recovery/running-adoption.js';
const { pollAdoptedRuntime, createRecoveredProgress } = adoption as unknown as {
  pollAdoptedRuntime: (settlement: unknown, record: unknown, progress: unknown) => Promise<unknown>;
  createRecoveredProgress: (settlement: unknown, record: unknown) => unknown;
};
import * as lifecycle from '#src/coordinator/services/recovery/lifecycle.js';
const { observeDurableRecoveryContainmentFor } = lifecycle as unknown as {
  observeDurableRecoveryContainmentFor: (
    store: unknown,
    runtime: unknown,
    id: string,
    record: unknown,
  ) => { observation: { kind: string } };
};
import { writeDurableCliProcessRuntimeMeta } from '#src/jobs/runtime-meta-store.js';
import { RecoveryService } from '#src/coordinator/services/recovery/service.js';

const keepalive = setInterval(() => {}, 1000);
const root = mkdtempSync(process.argv[2] + '/home-');
const runtime = createRealRuntime('dev', { baseDir: root });
const storeRoot = join(root, 'data');
const epochDir = join(storeRoot, 'epoch-1');
mkdirSync(epochDir, { recursive: true });
const writer = joinSuccessionWriterGeneration(runtime, { storeRoot, epoch: '1' });
const db = openStoreDatabase({
  path: join(epochDir, 'store.db'),
  storage: runtime.storage,
  storeFormat: currentCoralStoreFormat(),
  writerEntitlement: writer,
});
const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
const store = new JobStore('ns', runtime, createEventBodyCodec(), {
  db,
  eventBus: new TypedEventBus(),
  providers: permissiveProviderLookupPort,
  reducers,
});
const project = join(root, 'project');
mkdirSync(project);
const manager = SessionManager.forProduction(
  project,
  runtime,
  (cb) => store.commit(cb),
  () => {},
  { db },
);
const jobId = randomUUID();
const session = allocateTestSession(manager, 'codex', 'agent', undefined, project, project, 'ns');
manager.claimForJobSync(session.sessionId, jobId);
store.initJob({ jobId, sessionId: session.sessionId, provider: 'codex', projectRoot: project, backendNamespace: 'ns' });
const stdoutPath = join(root, 'stdout.jsonl');
const stderrPath = join(root, 'stderr.log');
writeFileSync(stdoutPath, '');
writeFileSync(stderrPath, '');
const runtimeRecord = {
  transport: 'durable-cli' as const,
  pid: 424242,
  stdoutPath,
  stderrPath,
  startTime: new Date().toISOString(),
  tailWatermark: 0,
};
store.appendRuntimeStarted(jobId, runtimeRecord);

try {
  if (process.argv[3] === 'recovery') await probeRecovery();
  else await probeDurable();
} finally {
  db.close();
  clearInterval(keepalive);
}

async function probeRecovery(): Promise<void> {
  const fakeIncarnation = 'mock-process-incarnation';
  writeDurableCliProcessRuntimeMeta(db, {
    jobId,
    pid: runtimeRecord.pid,
    incarnation: fakeIncarnation,
    processGroupId: runtimeRecord.pid,
    childRoot: { pid: 424243, incarnation: fakeIncarnation },
  } as never);
  runtime.process.readProcessIncarnation = () => fakeIncarnation as never;
  runtime.process.observeLiveness = () => 'alive';
  assert.equal(observeDurableRecoveryContainmentFor(store, runtime, jobId, runtimeRecord).observation.kind, 'alive');
  const state = {
    recoveryRegistry: null,
    cancelledRecoveryJobIds: new Set(),
    adoptedRunningPids: new Map(),
    unansweredAdoptionProbes: new Map(),
    recoveryPollIntervals: new Map(),
    adoptedRunningJobCleanups: new Map(),
    teardownRequested: false,
  };
  const service = new RecoveryService({
    runtime,
    backendNamespace: 'ns',
    progressStore: store,
    launchRecovery: { restoreActiveLaunch: () => ({ jobId, provider: 'codex', pool: 'default' }) },
  } as never);
  const settlement = {
    deps: {
      state,
      runtime,
      progressStore: store,
      observeDurableRecoveryContainment: (id: string, record: unknown) =>
        observeDurableRecoveryContainmentFor(store, runtime, id, record),
    },
    recovery: {
      jobId,
      runtimeRecord,
      authority: {
        launchRecord: { jobId, sessionId: session.sessionId, provider: 'codex', pool: 'default' },
        boundProvider: {
          name: 'codex',
          recovery: {
            extractProgress: ({ stdoutPath, fromOffset }: { stdoutPath: string; fromOffset: number }) => {
              const batch = readAppendedLines(stdoutPath, fromOffset, runtime.storage);
              return { messages: batch.lines, newOffset: batch.newOffset };
            },
          },
        },
      },
    },
    service,
    context: { signal: new AbortController().signal },
    controls: { clearProcessLocalCleanup: () => {}, report: (s: string) => process.stdout.write(s) },
  };
  const progress = createRecoveredProgress(settlement as never, runtimeRecord);
  await pollAdoptedRuntime(settlement as never, runtimeRecord, progress);
  assert.equal(state.recoveryPollIntervals.size, 1);
  // Normal polling of the same real store is a positive control. No process is signaled or spawned.
  const parked = process.argv.includes('--park');
  if (parked) {
    writer.park();
    writeFileSync(stdoutPath, 'recovered progress during park\n');
    console.log('Writer parked after production recovery timer was installed');
  }
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(state.recoveryPollIntervals.size, 1);
  assert.equal(state.adoptedRunningPids.has(jobId), true);
  if (parked && !process.argv.includes('--commit')) {
    writer.unpark();
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(state.adoptedRunningPids.has(jobId), true);
    const projection = store.readRuntimeProjection(jobId);
    assert.equal(
      projection?.transport === 'durable-cli' ? projection.tailWatermark : null,
      Buffer.byteLength('recovered progress during park\n'),
    );
  }
  for (const timer of state.recoveryPollIntervals.values()) runtime.time.clearInterval(timer as never);
  console.log('Normal recovery poll survived');
}

async function probeDurable(): Promise<void> {
  let capturedOptions!: SpawnDurableJobOptions;
  const removed: string[] = [];
  const launcher = new LaunchOrchestrator({
    runtime,
    backendNamespace: 'ns',
    progressStore: store,
    sessionManager: manager,
    abortRegistry: { remove: (id: string) => removed.push(id) },
    durableSpawner: {
      spawnDurableJob: (options: SpawnDurableJobOptions) => {
        capturedOptions = options;
        return Promise.resolve({ stdout: '', stderr: '', code: 0, aborted: false });
      },
    },
  } as never);
  // Use the production placement runner to obtain the real runtime-publication callback.
  const signal = new AbortController().signal;
  const runner = (
    launcher as unknown as {
      createStandalonePlacementRunner: (params: unknown) => (request: unknown) => Promise<unknown>;
    }
  ).createStandalonePlacementRunner({
    provider: { name: 'codex' },
    jobId,
    signal,
    permit: { jobId, provider: 'codex', pool: 'default' },
  });
  await runner({ command: 'mock-provider', args: [] });
  let providerExited = false;
  let resolveProviderExit!: (value: DurableProcessExit) => void;
  const providerExit = new Promise<DurableProcessExit>((resolve) => {
    resolveProviderExit = resolve;
  });
  void providerExit.then(() => {
    providerExited = true;
  });
  runtime.process.durable.waitForExit = () => providerExit;
  const delivered: string[] = [];
  capturedOptions.onEvent = (line: string) => delivered.push(line);
  const tail = awaitDurableLaunchResult(
    { runtime, options: capturedOptions } as never,
    { abortedBySignal: false, containmentAbandoned: false, containmentAbsence: new Promise(() => {}) } as never,
    { runtimeRecord, stdoutPath, stderrPath, pid: runtimeRecord.pid } as never,
    async () => ({ kind: 'observed-absent' }),
    () => {},
    async () => ({ kind: 'observed-absent' }),
  );
  if (process.argv.includes('--control')) {
    setTimeout(() => {
      writeFileSync(stdoutPath, 'provider progress during commit window\n');
    }, 10);
    setTimeout(() => {
      resolveProviderExit({ exitCode: 0, signal: null, endTime: new Date().toISOString() });
    }, 650);
    const result = await tail;
    assert.equal(result.code, 0);
    assert.deepEqual(delivered, ['provider progress during commit window']);
    assert.equal(
      store.readJobEvents(jobId).some((event) => event.type === 'terminal'),
      false,
    );
    console.log('Normal durable tail survived and delivered provider output');
  } else {
    setTimeout(() => {
      writer.park();
      writeFileSync(stdoutPath, 'provider progress during commit window\n');
    }, 10);
    let tailSettled = false;
    tail.then(
      () => {
        tailSettled = true;
      },
      () => {
        tailSettled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(tailSettled, false);
    assert.equal(providerExited, false);
    assert.equal(delivered.length, 0);
    assert.equal(removed.length, 0);
    if (!process.argv.includes('--commit')) {
      writer.unpark();
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.deepEqual(delivered, ['provider progress during commit window']);
      assert.equal(
        store.readJobEvents(jobId).some((event) => event.type === 'terminal'),
        false,
      );
      const projection = store.readRuntimeProjection(jobId);
      assert.equal(
        projection?.transport === 'durable-cli' ? projection.tailWatermark : null,
        Buffer.byteLength('provider progress during commit window\n'),
      );
      resolveProviderExit({ exitCode: 7, signal: null, endTime: new Date().toISOString() });
      assert.equal((await tail).code, 7);
      assert.equal(delivered.length, 1);
    } else {
      resolveProviderExit({ exitCode: 0, signal: null, endTime: new Date().toISOString() });
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.equal(tailSettled, false);
      assert.equal(delivered.length, 0);
    }
    console.log('Parked durable tail retained ownership and output');
  }
}
