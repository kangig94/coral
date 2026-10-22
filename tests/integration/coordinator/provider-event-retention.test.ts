import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCoordinatorServer } from '#src/coordinator/index.js';
import * as composition from '#src/coordinator/composition/index.js';
import * as coordinatorLifecycle from '#src/coordinator/lifecycle.js';
import type { CoordinatorCoreOptions, CoordinatorCoreResult } from '#src/coordinator/composition/types.js';
import * as resultExports from '#src/jobs/terminal/export.js';
import type { JobLocationIndex } from '#src/jobs/location-index.js';
import type { ProviderEventHandler } from '#src/provider-proxy/control-client.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { JobConversation } from '#src/jobs/conversation/entry.js';
import * as lifecycle from '#src/jobs/conversation/lifecycle-reactor.js';
import { readProjectionJobConversation } from '#src/jobs/conversation/projections.js';
import { sessionRetentionWorkKey } from '#src/jobs/conversation/retention-work.js';
import { ConversationManager } from '#src/jobs/conversation/shell.js';
import type { AppendedEvent } from '#src/store/append.js';
import type { Database } from '#src/store/db.js';
import * as rebindableStore from '#src/store/rebindable-database.js';
import { insertProviderOperation } from '#src/store/provider-operation-journal.js';
import { TEST_CODEX_BINDING, withTestBindingLocation } from '#tests/helpers/provider-credentials.js';
import { openTestStoreDatabase } from '#tests/helpers/store-db.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';

const roots: string[] = [];
const coordinators: ReturnType<typeof createCoordinatorServer>[] = [];
const readers: Database[] = [];

afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) {
    await coordinator.shutdown('test-teardown');
    await coordinator.waitForShutdown();
  }
  for (const reader of readers.splice(0)) reader.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type CommitStage = 'commit' | 'export' | 'location' | 'lifecycle' | 'announcement';
type EventIdentity = Pick<AppendedEvent, 'seq' | 'stream' | 'type'>;

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'coral-provider-retention-'));
  roots.push(home);
  const pluginRoot = join(home, 'plugin');
  mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
  writeFileSync(
    join(pluginRoot, 'bridge', 'manifest.json'),
    JSON.stringify({ bundleHash: '0123456789abcdef', flavor: 'prod' }),
  );
  vi.stubEnv('HOME', home);
  const codexHome = join(home, '.codex');
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { account_id: 'test-account' } }));
  const binding = withTestBindingLocation(TEST_CODEX_BINDING, codexHome);
  const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
  const createLifecycle = coordinatorLifecycle.createLifecycle;
  vi.spyOn(coordinatorLifecycle, 'createLifecycle').mockImplementation((deps, recover) =>
    createLifecycle({ ...deps, startProviderOperationReconciler: undefined }, recover),
  );
  const captured: {
    core?: CoordinatorCoreResult;
    options?: CoordinatorCoreOptions;
    reactor?: lifecycle.LifecycleReactor;
  } = {};
  const rebindDatabase = rebindableStore.createRebindableStoreDatabase;
  vi.spyOn(rebindableStore, 'createRebindableStoreDatabase').mockImplementation((db) => {
    const database = rebindDatabase(db);
    return {
      ...database,
      db: new Proxy(database.db, {
        get(target, property) {
          if (property !== 'exec') return Reflect.get(target, property);
          return (sql: string) => {
            const result = target.exec(sql);
            recordCommit(sql);
            return result;
          };
        },
      }),
    };
  });
  const createCore = composition.createCoordinatorCore;
  vi.spyOn(composition, 'createCoordinatorCore').mockImplementation((options, recover) => {
    captured.options = options;
    captured.core = createCore(options, recover);
    return captured.core;
  });
  const createReactor = lifecycle.createLifecycleReactor;
  vi.spyOn(lifecycle, 'createLifecycleReactor').mockImplementation((options) => {
    captured.reactor = createReactor(options);
    const observe = captured.reactor.observe;
    vi.spyOn(captured.reactor, 'observe').mockImplementation((appended) => {
      record('lifecycle', appended);
      observe(appended);
    });
    return captured.reactor;
  });
  const createExportObserver = resultExports.observeTerminalResultExports;
  vi.spyOn(resultExports, 'observeTerminalResultExports').mockImplementation((...args) => {
    const observe = createExportObserver(...args);
    return (appended) => {
      observe(appended);
      record('export', appended);
    };
  });
  let trace:
    | {
        jobId: string;
        type: string;
        afterSeq: number;
        stages: { stage: CommitStage; events: EventIdentity[] }[];
        events: readonly AppendedEvent[];
        locationAtAnnouncement?: ReturnType<JobLocationIndex['read']>;
      }
    | undefined;
  function identities(appended: readonly AppendedEvent[]): EventIdentity[] {
    return appended.map(({ seq, stream, type }) => ({ seq, stream, type }));
  }
  function record(stage: CommitStage, appended: readonly AppendedEvent[]) {
    const current = trace;
    if (
      current === undefined ||
      !appended.some(
        (event) => event.stream.kind === 'job' && event.stream.id === current.jobId && event.type === current.type,
      )
    )
      return;
    current.events = appended;
    expect(db.isTransaction).toBe(false);
    for (const event of appended) {
      expect(
        reader
          .prepare<
            [number],
            { stream_kind: string; stream_id: string; type: string }
          >('SELECT stream_kind, stream_id, type FROM events WHERE seq = ?')
          .get(event.seq),
      ).toEqual({ stream_kind: event.stream.kind, stream_id: event.stream.id, type: event.type });
    }
    current.stages.push({ stage, events: identities(appended) });
  }
  const coordinator = createCoordinatorServer({
    runtime,
    pluginRoot,
    onFatalShutdownError: vi.fn(),
    kbDaemonSupervisor: createMockKbDaemonSupervisor(),
    writeBackendInfoFn: () => true,
    removeBackendInfoIfOwnerFn: () => {},
    createServerFn: (handler) => createServer(handler),
    listenFn: async () => ({ port: 0, host: '127.0.0.1' }),
    closeServerFn: async () => {},
  });
  coordinators.push(coordinator);
  await coordinator.start();
  const { core, options, reactor } = captured;
  if (core === undefined || options === undefined || reactor === undefined) throw new Error('Missing composition.');
  expect(reactor.isRetentionAdmitted()).toBe(true);
  await reactor.waitForIdle();
  const { storeDb: db, progressStore } = core.storeServicesRef.get();
  const locations = options.jobLocationIndex;
  const buildHandler = options.buildProviderEventHandler;
  if (locations === undefined || buildHandler === undefined) throw new Error('Missing provider event wiring.');
  const handler = buildHandler();
  const epoch = core.openedStoreEpoch();
  if (epoch === null) throw new Error('Missing serving epoch.');
  const reader = openTestStoreDatabase({
    path: epoch.path,
    storage: runtime.storage,
    storeFormat: options.storeFormat,
    readonly: true,
  });
  readers.push(reader);
  function recordCommit(sql: string) {
    const current = trace;
    if (sql !== 'COMMIT' || current === undefined) return;
    const rows = reader
      .prepare<
        [number],
        { seq: number; stream_kind: EventIdentity['stream']['kind']; stream_id: string; type: string }
      >('SELECT seq, stream_kind, stream_id, type FROM events WHERE seq > ? ORDER BY seq')
      .all(current.afterSeq);
    if (
      !rows.some((row) => row.stream_kind === 'job' && row.stream_id === current.jobId && row.type === current.type) ||
      current.stages.some(({ stage }) => stage === 'commit')
    )
      return;
    expect(db.isTransaction).toBe(false);
    current.stages.push({
      stage: 'commit',
      events: rows.map(({ seq, stream_kind, stream_id, type }) => ({
        seq,
        stream: { kind: stream_kind, id: stream_id },
        type,
      })),
    });
  }
  const recordObserved = locations.recordObserved.bind(locations);
  const recordLocation = vi.spyOn(locations, 'recordObserved').mockImplementation((jobId, detail, observation) => {
    recordObserved(jobId, detail, observation);
    const current = trace;
    if (
      current !== undefined &&
      jobId === current.jobId &&
      current.events.some((event) => detail.events.some(({ seq }) => seq === event.seq))
    ) {
      record('location', current.events);
    }
  });
  const announce = progressStore.announceCommitted.bind(progressStore);
  vi.spyOn(progressStore, 'announceCommitted').mockImplementation((appended) => {
    record('announcement', appended);
    if (trace !== undefined && trace.stages.at(-1)?.stage === 'announcement') {
      trace.locationAtAnnouncement = locations.read(trace.jobId);
    }
    announce(appended);
  });
  const publishResult = vi.spyOn(progressStore, 'publishTerminalResult');
  const namespace = core.identity.namespace;
  const sessions = ConversationManager.forProduction(
    home,
    runtime,
    (cb) => progressStore.commit(cb),
    () => {},
    { db },
  );
  function seedOperation(retention: JobConversation['retention'] = 'retain') {
    const session = sessions.open({
      binding,
      name: 'provider event retention',
      cwd: home,
      projectRoot: home,
      backendNamespace: namespace,
      retention,
    });
    const operation = {
      jobId: randomUUID(),
      operationId: randomUUID(),
      proxyInstanceId: randomUUID(),
      buildSetId: randomUUID(),
    };
    sessions.claimForJobSync(session.sessionId, operation.jobId);
    progressStore.initJob({
      jobId: operation.jobId,
      sessionId: session.sessionId,
      provider: 'codex',
      projectRoot: home,
      backendNamespace: namespace,
      initialPhase: 'running',
    });
    insertProviderOperation(db, providerOperationRecord('executing', { operation }));
    return { operation, sessionId: session.sessionId };
  }
  return {
    coordinator,
    db,
    reader,
    reactor,
    progressStore,
    publishResult,
    recordLocation,
    seedOperation,
    handler,
    runtime,
    locations,
    traceCommit: (jobId: string, type: string) => {
      const afterSeq =
        reader.prepare<[], { seq: number }>('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get()?.seq ?? 0;
      trace = { jobId, type, afterSeq, stages: [], events: [] };
      return trace;
    },
  };
}

function terminalRequest(operation: Parameters<ProviderEventHandler>[0]['operation']) {
  return {
    operation,
    providerSeq: 1,
    event: {
      kind: 'terminal' as const,
      terminal: { content: 'done', durationMs: 5, outcome: { kind: 'completed' as const } },
      diagnostics: {},
    },
  };
}

describe('provider events through coordinator composition', () => {
  it('exports, notifies lifecycle and announces a committed terminal once, settling retention despite unrelated quarantine', async () => {
    const f = await fixture();
    const unrelated = f.seedOperation('discard_provider_artifacts_on_terminal');
    const quarantine = new RecoveryQuarantineStore(f.db, f.runtime.time);
    const subject = {
      key: sessionRetentionWorkKey(unrelated.sessionId, unrelated.operation.jobId),
      revision: { kind: 'until-cleared' as const },
    };
    expect(
      quarantine.upsert({
        boundary: 'session-retention-work',
        subject,
        state: 'active',
        stage: 'settle',
        errorMessage: 'unrelated subject is quarantined',
        detail: 'retry retains this subject',
      }),
    ).toBe(true);
    const quarantined = quarantine.read('session-retention-work', subject.key);
    await f.handler(terminalRequest(unrelated.operation));
    await f.reactor.waitForIdle();

    const tested = f.seedOperation('discard_provider_artifacts_on_terminal');
    await f.reactor.waitForIdle();
    const trace = f.traceCommit(tested.operation.jobId, 'job.terminal.recorded');
    const request = terminalRequest(tested.operation);
    expect(await f.handler(request)).toEqual({ kind: 'ack', committedThroughProviderSeq: 1 });
    await f.reactor.waitForIdle();
    expect(trace.stages.map(({ stage }) => stage)).toEqual(['commit', 'export', 'lifecycle', 'announcement']);
    const events = trace.events.map(({ seq, stream, type }) => ({ seq, stream, type }));
    expect(events).toEqual([
      { seq: expect.any(Number), stream: { kind: 'job', id: tested.operation.jobId }, type: 'job.terminal.recorded' },
    ]);
    expect(trace.stages[0]?.events).toEqual([
      ...events,
      { seq: expect.any(Number), stream: { kind: 'session', id: tested.sessionId }, type: 'session.claim.released' },
    ]);
    for (const stage of trace.stages.slice(1)) expect(stage.events).toEqual(events);
    expect(f.publishResult.mock.calls.filter(([jobId]) => jobId === tested.operation.jobId)).toHaveLength(1);
    expect(readProjectionJobConversation(f.db, tested.sessionId)?.activeJobId).toBeUndefined();
    expect(
      f.reader
        .prepare<
          [string],
          { type: string }
        >("SELECT type FROM events WHERE stream_kind = 'session' AND stream_id = ? AND type = 'session.retention.discard.completed'")
        .all(tested.sessionId),
    ).toHaveLength(1);
    expect(quarantine.read('session-retention-work', subject.key)).toEqual(quarantined);
    expect(
      f.reader
        .prepare<
          [string],
          { type: string }
        >("SELECT type FROM events WHERE stream_kind = 'session' AND stream_id = ? AND type = 'session.retention.discard.completed'")
        .all(unrelated.sessionId),
    ).toHaveLength(0);
    expect(await f.handler(request)).toEqual({ kind: 'ack', committedThroughProviderSeq: 1 });
    expect(trace.stages.map(({ stage }) => stage)).toEqual(['commit', 'export', 'lifecycle', 'announcement']);
    expect(f.publishResult.mock.calls.filter(([jobId]) => jobId === tested.operation.jobId)).toHaveLength(1);
  });

  it('records provider progress location once between export and lifecycle, visible at announcement', async () => {
    const f = await fixture();
    const tested = f.seedOperation();
    await f.reactor.waitForIdle();
    const registeredLocation = f.locations.read(tested.operation.jobId);
    expect(registeredLocation).not.toBeNull();
    const trace = f.traceCommit(tested.operation.jobId, 'job.progress.emitted');
    expect(
      await f.handler({
        operation: tested.operation,
        providerSeq: 1,
        event: { kind: 'progress', message: 'provider progress' },
      }),
    ).toEqual({ kind: 'ack', committedThroughProviderSeq: 1 });
    expect(trace.stages.map(({ stage }) => stage)).toEqual([
      'commit',
      'export',
      'location',
      'lifecycle',
      'announcement',
    ]);
    expect(trace.events).toHaveLength(1);
    const events = trace.events.map(({ seq, stream, type }) => ({ seq, stream, type }));
    for (const stage of trace.stages) expect(stage.events).toEqual(events);
    expect(f.recordLocation.mock.calls.filter(([jobId]) => jobId === tested.operation.jobId)).toHaveLength(1);
    expect(trace.locationAtAnnouncement).toMatchObject({
      jobId: tested.operation.jobId,
      epochKey: registeredLocation?.epochKey,
      subject: registeredLocation?.subject,
      disposition: 'active-owner',
      detail: {
        kind: 'recorded',
        value: { events: [{ type: 'progress', seq: trace.events[0]?.seq, message: 'provider progress' }] },
      },
    });
  });
});
