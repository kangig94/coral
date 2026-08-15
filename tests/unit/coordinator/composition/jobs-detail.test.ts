import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as HttpHandlerMod from '#src/transport/http/handler.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';

const captured = vi.hoisted(() => ({
  detail: null as HttpHandlerPorts['jobs']['detail'] | null,
  list: null as HttpHandlerPorts['jobs']['list'] | null,
}));

vi.mock('#src/transport/http/handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HttpHandlerMod>();
  return {
    ...actual,
    createHttpHandler: (ports: HttpHandlerPorts) => {
      captured.detail = ports.jobs.detail;
      captured.list = ports.jobs.list;
      return actual.createHttpHandler(ports);
    },
  };
});

import { createCoordinatorCore } from '#src/coordinator/composition/index.js';
import type { CoordinatorStoreServices } from '#src/coordinator/composition/store-services-ref.js';
import { CoralStore } from '#src/read-model/coral-store.js';
import { JobStore } from '#src/jobs/store.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { discussRegistry } from '#src/discuss/event-registry.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { workflowPlanDeclaredEvent } from '#src/workflow/events.js';
import { composeReducers } from '#src/store/reducers.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { setStoreServicesForTest } from '#tools/testing/store-services.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';

const openDbs = new Set<Database>();

afterEach(() => {
  captured.detail = null;
  captured.list = null;
  for (const db of openDbs) db.close();
  openDbs.clear();
});

/** Composes the real coordinator core over an in-memory store so the composed ports run against a real `JobStore`. */
function composeCoordinatorPorts(): { db: Database; progressStore: JobStore } {
  const runtime = createRealRuntime('prod');
  const db = newRawDatabase(':memory:');
  openDbs.add(db);
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
  const progressStore = new JobStore('jobs-detail-test', runtime, createEventBodyCodec(), {
    db,
    reducers,
    providers: permissiveProviderLookupPort,
  });
  const core = createCoordinatorCore(
    {
      runtime,
      storeFormat: currentCoralStoreFormat(),
      pluginRoot: process.cwd(),
      backendNamespace: 'jobs-detail-test',
      bootSnapshot: {
        version: 'test-version',
        bundleHash: 'test-bundle',
        flavor: 'prod',
        instanceId: 'jobs-detail-instance',
        token: 'jobs-detail-token',
        bootToken: 'jobs-detail-boot-token',
        pid: process.pid,
        now: () => 1_000,
        log: () => undefined,
      },
      createServerFn: (handler) => createServer(handler),
      kbDaemonSupervisor: createMockKbDaemonSupervisor(),
      getConsumerStuck: () => [],
    },
    async () => [],
  );
  setStoreServicesForTest(
    core.storeServicesRef,
    { storeDb: db, progressStore, consumerDriver: null } satisfies CoordinatorStoreServices,
    { storeDbPath: ':memory:' },
  );
  return { db, progressStore };
}

describe('coordinator jobs.detail composition', () => {
  it('labels workflow children across coordinator and direct store read routes', () => {
    const { db, progressStore } = composeCoordinatorPorts();

    const workflowJobId = '22222222-2222-4222-8222-222222222222';
    const childJobId = '11111111-1111-4111-8111-111111111111';
    const workflowSlotId = `${workflowJobId}:0:0`;
    const plan = {
      slots: [
        {
          slotId: workflowSlotId,
          dependencies: [],
          provider: 'codex',
          instruction: 'critic',
          agent: 'critic',
        },
      ],
    };
    progressStore.commit((commit) => {
      commit.append(workflowPlanDeclaredEvent(workflowJobId, plan, TEST_PROVIDER_SCOPE));
      return undefined;
    });
    progressStore.appendLaunchRequested(workflowJobId, {
      jobId: workflowJobId,
      owner: { kind: 'workflow', id: workflowJobId },
      sessionId: null,
      provider: null,
      projectRoot: '/workspace',
      backendNamespace: 'jobs-detail-test',
      jobKind: 'workflow',
      pool: 'default',
      enqueueSequence: 1,
      request: { prompt: 'critic', cwd: '/workspace', bypassPermissions: false, coralEnv: {} },
      createdAt: '2026-08-15T00:00:00.000Z',
    });
    progressStore.appendRuntimeStarted(workflowJobId, {
      transport: 'workflow',
      startTime: '2026-08-15T00:00:00.000Z',
    });
    seedTestSessionProjection(db, {
      sessionId: 'child-session',
      provider: 'codex',
      projectRoot: '/workspace',
      backendNamespace: 'jobs-detail-test',
      activeJobId: childJobId,
    });
    progressStore.appendLaunchRequested(childJobId, {
      jobId: childJobId,
      owner: { kind: 'workflow', id: workflowJobId },
      sessionId: 'child-session',
      provider: 'codex',
      providerAction: 'exec',
      projectRoot: '/workspace',
      backendNamespace: 'jobs-detail-test',
      jobKind: 'provider',
      parentWorkflowJobId: workflowJobId,
      workflowSlotId,
      workflowSlotGeneration: 0,
      pool: 'default',
      enqueueSequence: 2,
      request: { prompt: 'critic', cwd: '/workspace', bypassPermissions: false, coralEnv: {} },
      createdAt: '2026-08-15T00:00:00.000Z',
    });

    if (captured.detail === null) throw new Error('jobs.detail port was not composed');
    if (captured.list === null) throw new Error('jobs.list port was not composed');
    const detail = captured.detail(workflowJobId);
    const childDetail = captured.detail(childJobId);
    const listedChild = captured.list({ all: true }).find(({ jobId }) => jobId === childJobId);
    const directListedChild = new CoralStore(db, progressStore).jobs
      .list({ all: true })
      .find(({ jobId }) => jobId === childJobId);

    expect(detail?.workflowChildren).toEqual([
      expect.objectContaining({
        jobId: childJobId,
        status: expect.objectContaining({ workflowSlotId, workflowLabel: 'critic' }),
      }),
    ]);
    expect(childDetail?.status).toMatchObject({ workflowSlotId, workflowLabel: 'critic' });
    expect(listedChild?.status).toMatchObject({ workflowSlotId, workflowLabel: 'critic' });
    expect(directListedChild?.status).toMatchObject({ workflowSlotId, workflowLabel: 'critic' });
  });
});

describe('coordinator jobs.list composition', () => {
  /**
   * KB jobs run against the shared corpus rather than one project, so `coral jobs` renders them in their own
   * section no matter which directory it runs from. The project filter has to let them through for that
   * section to ever appear.
   */
  it('keeps shared KB jobs visible under a project filter that excludes ordinary jobs', () => {
    const { db, progressStore } = composeCoordinatorPorts();
    const kbJobId = '44444444-4444-4444-8444-444444444444';
    const providerJobId = '55555555-5555-4555-8555-555555555555';

    progressStore.appendLaunchRequested(kbJobId, {
      jobId: kbJobId,
      owner: { kind: 'system-task', id: `kb.source_import:${kbJobId}` },
      sessionId: null,
      provider: null,
      projectRoot: '/workspace',
      backendNamespace: 'jobs-detail-test',
      jobKind: 'kb',
      pool: 'default',
      enqueueSequence: 1,
      operation: 'kb.source_import',
      request: { filePath: '/workspace/source.md', slug: 'alpha-source', readiness: 'base-search' },
      createdAt: '2026-08-15T00:00:00.000Z',
    });
    seedTestSessionProjection(db, {
      sessionId: 'other-project-session',
      provider: 'codex',
      projectRoot: '/workspace',
      backendNamespace: 'jobs-detail-test',
      activeJobId: providerJobId,
    });
    progressStore.appendLaunchRequested(providerJobId, {
      jobId: providerJobId,
      owner: { kind: 'provider-session', id: 'other-project-session' },
      sessionId: 'other-project-session',
      provider: 'codex',
      providerAction: 'exec',
      projectRoot: '/workspace',
      backendNamespace: 'jobs-detail-test',
      jobKind: 'provider',
      pool: 'default',
      enqueueSequence: 2,
      request: { prompt: 'hello', cwd: '/workspace', bypassPermissions: false, coralEnv: {} },
      createdAt: '2026-08-15T00:00:00.000Z',
    });

    if (captured.list === null) throw new Error('jobs.list port was not composed');
    const jobIds = captured.list({ projectRoot: '/elsewhere' }).map(({ jobId }) => jobId);

    expect(jobIds).toEqual([kbJobId]);
  });
});
