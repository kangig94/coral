import { afterEach, describe, expect, it, vi } from 'vitest';

import { recordProviderTerminal } from '#src/coordinator/services/terminal-materializer.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { LaunchOrchestrator } from '#src/jobs/shell/launch.js';
import type { AppServerProxyRoute } from '#src/jobs/contracts/app-server-proxy-route.js';
import { readDurableCliContainmentStatus } from '#src/jobs/runtime-meta-store.js';
import { JobStore } from '#src/jobs/store.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { composeReducers } from '#src/store/reducers.js';
import type { BoundProvider, BoundProviderStandaloneExecutionRuntime } from '#src/providers/bound-provider-contract.js';
import type { ProviderRequest } from '#src/providers/contract.js';
import type { ProviderDurableSpawner } from '#src/providers/cli-runner.js';
import { SessionManager } from '#src/sessions/shell.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

const JOB_ID = '00000000-0000-4000-8000-000000000001';
const databases: Array<ReturnType<typeof newRawDatabase>> = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});

function fixture(options: { route?: AppServerProxyRoute; durableSpawner?: ProviderDurableSpawner } = {}) {
  const runtime = new SimulationRuntime();
  const db = newRawDatabase(':memory:');
  databases.push(db);
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  const store = new JobStore('test', runtime, createEventBodyCodec(), {
    db,
    providers: permissiveProviderLookupPort,
    reducers: composeReducers(jobsRegistry, sessionsRegistry),
  });
  const sessions = new SessionManager('/project', runtime, undefined, undefined, db, permissiveProviderLookupPort);
  const session = sessions.prepare({
    binding: TEST_CODEX_BINDING,
    name: 'test',
    cwd: '/project',
    projectRoot: '/project',
    backendNamespace: 'test',
  });
  const admission = new LaunchCoordinator({ runtime });
  const registry = new AbortRegistry(runtime.ids);
  const completed = createDeferred<void>();
  const release = admission.releaseLaunch.bind(admission);
  admission.releaseLaunch = (permit) => {
    const result = release(permit);
    completed.resolve();
    return result;
  };
  const execute = vi.fn(async function* () {});
  const provider = {
    name: 'codex',
    envelope: TEST_CODEX_BINDING,
    appServer: {},
    compareIdentity: () => ({ ok: true }),
    decodeContinuity: () => ({ ok: true, value: undefined }),
    readiness: async () => ({ ok: true }),
    prepareExecution: () => ({ kind: 'app-server', hostSpec: {}, execute }),
  } as unknown as BoundProvider;
  const orchestrator = new LaunchOrchestrator({
    runtime,
    progressStore: store,
    sessionManager: sessions,
    abortRegistry: registry,
    launchAdmission: admission,
    providerOperationBinding: admission,
    durableSpawner: options.durableSpawner ?? admission,
    providerRegistry: {} as never,
    backendNamespace: 'test',
    bundleHash: 'test',
    coordinatorCommit: (cb) => store.commit(cb),
    settlementRefusalRecorder: { record: () => true },
    appServerProxyRoute: options.route,
    terminalMaterializer: { recordProviderTerminal },
  });
  return {
    runtime,
    db,
    store,
    sessions,
    session,
    admission,
    registry,
    provider,
    orchestrator,
    execute,
    completed: completed.promise,
    launch: () =>
      orchestrator.launchInitialProviderJob(
        provider,
        session,
        {
          action: 'exec',
          sessionId: session.sessionId,
          prompt: 'run',
          cwd: '/project',
          coralEnv: {},
          bypassPermissions: false,
        } as ProviderRequest,
        {
          requestedJobId: JOB_ID,
          owner: { kind: 'provider-session', id: session.sessionId },
          mintProtectedEnv: () => ({ env: {}, childAuthorization: {} as never }),
        },
      ),
  };
}

describe('LaunchOrchestrator', () => {
  it('terminalizes and releases a committed launch when synchronous setup fails', () => {
    const f = fixture();
    vi.spyOn(f.runtime.storage, 'mkdirSync').mockImplementationOnce(() => {
      throw new Error('setup failed');
    });
    expect(() => f.launch()).toThrow('setup failed');
    expect(f.store.readStatus(JOB_ID)).toMatchObject({ phase: 'error', result: { outcome: { kind: 'job_fault' } } });
    expect(f.sessions.get('codex', f.session.sessionId)?.activeJobId).toBeUndefined();
    expect(f.admission.reservationFor(JOB_ID)).toBeNull();
    expect(f.registry.has(JOB_ID)).toBe(false);
  });

  it('rolls back the session claim and job when the launch commit fails', () => {
    const f = fixture();
    f.db.exec(`CREATE TRIGGER reject_launch BEFORE INSERT ON events
      WHEN NEW.type = 'job.launch.requested' BEGIN SELECT RAISE(ABORT, 'launch unavailable'); END`);
    expect(() => f.launch()).toThrow('launch unavailable');
    expect(f.store.readStatus(JOB_ID)).toBeNull();
    expect(f.sessions.get('codex', f.session.sessionId)).toBeNull();
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 0 });
    expect(f.admission.reservationFor(JOB_ID)).toBeNull();
    expect(f.registry.has(JOB_ID)).toBe(false);
  });

  it('does not write a second terminal for terminalized proxy placement', async () => {
    const f = fixture({
      route: {
        activate: async () => {
          commitJobTerminal(f.store, JOB_ID, f.session.sessionId, {
            content: 'done',
            durationMs: 0,
            outcome: { kind: 'completed' },
          });
          return { kind: 'terminalized' };
        },
      } as AppServerProxyRoute,
    });
    f.launch();
    await f.completed;
    expect(f.store.readJobEvents(JOB_ID).filter((event) => event.type === 'terminal')).toHaveLength(1);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.sessions.get('codex', f.session.sessionId)?.activeJobId).toBeUndefined();
  });

  it('preserves durable abandonment when its progress diagnostic fails', async () => {
    const published = createDeferred<void>();
    const durableSpawner: ProviderDurableSpawner = {
      spawnDurableJob: async (options) => {
        const disposition = options.onDurableProcessIdentity!(
          {
            pid: 42,
            incarnation: testIncarnation('wrapper'),
            processGroupId: 42,
            childRoot: { pid: 43, incarnation: testIncarnation('child') },
          },
          { kind: 'operator-abandoned', processAbsenceProven: false },
        );
        expect(disposition).toEqual({ kind: 'published' });
        published.resolve();
        return new Promise(() => {});
      },
    };
    const f = fixture({ durableSpawner });
    Object.assign(f.provider, {
      appServer: undefined,
      prepareExecution: () => ({
        kind: 'standalone',
        prepareCliRequest: (request: unknown) => request,
        execute: async function* (providerRuntime: BoundProviderStandaloneExecutionRuntime) {
          await providerRuntime.runCli({ command: 'fixture', args: [] });
        },
      }),
    });
    vi.spyOn(f.store, 'appendProgress').mockImplementation(() => {
      throw new Error('diagnostic unavailable');
    });
    f.launch();
    await published.promise;
    expect(readDurableCliContainmentStatus(f.db, JOB_ID)).toMatchObject({
      kind: 'valid',
      status: { disposition: { kind: 'operator-abandoned', processAbsenceProven: false } },
    });
  });

  it('avoids local execution when the proxy already owns the operation', async () => {
    const placed = createDeferred<void>();
    const f = fixture({
      route: {
        activate: async () => {
          placed.resolve();
          return { kind: 'remote-executing', operationId: 'operation-1' };
        },
      } as AppServerProxyRoute,
    });
    f.launch();
    await placed.promise;
    await f.orchestrator.quiesceAppServerJobsForHandoff();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.store.readJobEvents(JOB_ID).filter((event) => event.type === 'terminal')).toEqual([]);
    expect(f.sessions.get('codex', f.session.sessionId)?.activeJobId).toBe(JOB_ID);
  });
});
