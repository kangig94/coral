import { describe, expect, it, vi } from 'vitest';
import { JobAttention } from '#src/coordinator/services/job-attention.js';
import { JobWaitService } from '#src/coordinator/services/job-wait.js';
import { createCoordinatorRpcPorts } from '#src/coordinator/composition/rpc-ports.js';
import { canonicalizeWorkDir } from '#src/runtime/canonical-work-dir.js';
import { executeCatalogRequest } from '#src/transport/dispatch.js';
import { rpcCatalog } from '#src/transport/rpc/catalog.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import type { JobStatus } from '#src/jobs/records.js';
import type { WaitStreamEvent } from '#src/jobs/wait/contract.js';
import type { JobWaitServiceDeps } from '#src/coordinator/services/job-wait.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { formatJobsList } from '#src/cli/format/jobs.js';
import { readWaitSession } from '#src/jobs/wait/reader.js';
import type { WaitAdmission } from '#src/jobs/wait/session.js';
import { admitted, TEST_EPOCH } from '#tests/helpers/wait-session.js';
import { testProgressVisit } from '#tests/helpers/wait-progress.js';
import { VirtualTime, flushMicrotasks } from '#tools/simulation/core/virtual-time.js';

const projectRoot = canonicalizeWorkDir(process.cwd(), process.cwd());
const event = { jobId: 'mine', type: 'pending' } as unknown as WaitStreamEvent;
async function* stream() {
  yield event;
}

function fixture() {
  const attention = new JobAttention();
  const statuses = new Map<string, JobStatus>();
  for (const [jobId, phase] of [
    ['mine', 'running'],
    ['other', 'running'],
    ['done', 'completed'],
  ] as const) {
    statuses.set(jobId, {
      jobId,
      execution: 1,
      phase,
      owner: { kind: 'provider-session', id: 'same-execution-owner' },
      sessionId: 'provider-session',
      provider: 'claude',
      projectRoot,
      workDir: projectRoot,
      backendNamespace: 'test',
      jobKind: 'provider',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  }
  const snapshot = vi.fn(() => ({}));
  const ports = createCoordinatorRpcPorts({
    services: { jobAttention: attention },
    getProgressStore: () => ({
      readStatus: (jobId: string) => statuses.get(jobId) ?? null,
      listJobProjections: () => [...statuses].map(([jobId, status]) => ({ jobId, status })),
      loadJobProjectionDetail: (jobId: string) => ({
        status: statuses.get(jobId) ?? null,
        launch: { request: { coralEnv: { CORAL_OWNER: jobId === 'other' ? 'other-session' : 'session' } } },
      }),
    }),
    jobAddressing: {
      admitWait: (request: { jobIds: string[] }) =>
        request.jobIds.map((jobId) => ({ jobId, disposition: 'admitted', detail: { status: statuses.get(jobId) } })),
      waitStream: stream,
      snapshot,
      scopeCheck: () => ({ valid: [], missing: [], mismatch: [] }),
    },
  } as unknown as Parameters<typeof createCoordinatorRpcPorts>[0]);
  const deps = {
    loadJobProjectionDetail: (jobId: string) => ({
      status: statuses.get(jobId) ?? null,
      launch: null,
      runtime: null,
      exit: null,
    }),
    jobAttention: attention,
    waitCoordinator: {
      admitWait: (request: { jobIds: string[] }) =>
        request.jobIds.map((jobId) => ({ jobId, disposition: 'admitted', detail: { status: statuses.get(jobId) } })),
      waitForOutcomes: stream,
      waitStreamOnce: async () => {
        expect(attention.isUnwaited('mine', 1)).toBe(false);
        return {};
      },
      waitForJobTerminal: async () => {
        expect(attention.isUnwaited('mine', 1)).toBe(false);
      },
    },
  } as unknown as JobWaitServiceDeps;
  return { attention, ports, service: new JobWaitService(deps), snapshot, statuses };
}

describe('job attention', () => {
  it.each(['return', 'abort', 'failure'] as const)(
    'tracks an initially unknown execution admitted during polling until stream %s',
    async (close) => {
      const { attention, ports, statuses } = fixture();
      statuses.get('mine')!.execution = 2;
      const time = new VirtualTime();
      const controller = new AbortController();
      const selected = admitted('mine', [], false);
      selected.detail.status.execution = 2;
      selected.selection = { jobId: 'mine', epochKey: TEST_EPOCH, requestedSeq: 10, awaitingArtifact: false };
      let observation: WaitAdmission = { jobId: 'mine', disposition: 'unknown', epochKey: TEST_EPOCH };
      const read = () => [observation];
      const wait = attention.waitStream({ jobIds: ['mine'], abortSignal: controller.signal }, read, (request) =>
        readWaitSession({ request, activeEpochKey: TEST_EPOCH, time, read, visit: testProgressVisit }),
      );
      expect((await wait.next()).value).toMatchObject({ type: 'disposition', disposition: 'unknown' });
      expect(attention.isUnwaited('mine', 2)).toBe(true);
      observation = selected;
      const next = wait.next();
      await flushMicrotasks(20);
      time.tick(250);
      expect((await next).value).toMatchObject({ type: 'admission' });
      expect(ports.jobs.list({ owner: 'session', unwaited: true })).toEqual([]);
      expect(attention.isUnwaited('mine', 1)).toBe(true);

      const concurrent = attention.beginWait([{ jobId: 'mine', execution: 2 }]);
      if (close === 'return') await wait.return(undefined);
      else if (close === 'failure')
        await expect(wait.throw(new Error('stream failed'))).rejects.toThrow('stream failed');
      else {
        controller.abort();
        let next = await wait.next();
        while (!next.done) next = await wait.next();
      }
      expect(attention.isUnwaited('mine', 2)).toBe(false);
      concurrent();
      expect(attention.isUnwaited('mine', 2)).toBe(true);
    },
  );

  it('session job guard: filters by launch owner and excludes attached and released jobs', async () => {
    const { ports } = fixture();
    expect(ports.jobs.list({ owner: 'session', all: true }).map((j) => j.jobId)).toEqual(['mine']);
    const wait = ports.jobs.waitStream({ jobIds: ['mine'], drainProgress: false });
    expect(ports.jobs.list({ owner: 'session', unwaited: true })).toHaveLength(1);
    await wait.next();
    expect(ports.jobs.list({ owner: 'session', unwaited: true })).toEqual([]);
    await wait.return(undefined);
    expect(ports.jobs.list({ owner: 'session', unwaited: true })).toHaveLength(1);
    expect(ports.jobs.release(['mine', 'done', 'unknown'])).toEqual({
      released: ['mine'],
      terminal: ['done'],
      unknown: ['unknown'],
    });
    expect(ports.jobs.list({ owner: 'session', unwaited: true })).toEqual([]);
    expect(formatJobsList({ jobs: ports.jobs.list({ owner: 'session' }) })[0]?.phase).toBe('running (released)');
    expect(fixture().ports.jobs.list({ owner: 'session', unwaited: true })).toHaveLength(1);
  });

  it('session job guard: counts concurrent internal waits until the last one closes; snapshots do not count', async () => {
    const { attention, ports, service, snapshot } = fixture();
    const first = service.waitStream({ jobIds: ['mine'] });
    const second = service.waitStream({ jobIds: ['mine'] });
    await first.next();
    await second.next();
    expect(attention.isUnwaited('mine', 1)).toBe(false);
    await first.return(undefined);
    expect(attention.isUnwaited('mine', 1)).toBe(false);
    await second.return(undefined);
    expect(attention.isUnwaited('mine', 1)).toBe(true);
    await service.waitStreamOnce('mine');
    await service.waitForJobTerminal('mine');
    expect(attention.isUnwaited('mine', 1)).toBe(true);
    ports.jobs.snapshot({ jobIds: ['mine'] });
    expect(snapshot).toHaveBeenCalled();
    expect(attention.isUnwaited('mine', 1)).toBe(true);
  });

  it('session job guard: routes release through authorized dispatch and rejects foreign project jobs', async () => {
    const { ports } = fixture();
    const spec = rpcCatalog.find((candidate) => candidate.name === 'jobs.release')!;
    const context = {
      identity: { pluginRoot: '/plugin' },
      coralEnvSnapshot: {},
      admin: { isLaunchFenceActive: () => false },
      ...ports,
    } as unknown as HttpHandlerPorts;
    const request = spec.requestSchema.parse({ jobs: ['mine'], projectRoot });
    expect(await executeCatalogRequest(spec, request, context, testProjectPrincipal(projectRoot))).toMatchObject({
      kind: 'unary',
      body: { released: ['mine'], unknown: [], terminal: [] },
    });
    expect(() => spec.requestSchema.parse({ ...request, owner: 'unrecognized-field' })).toThrow();
    ports.jobs.scopeCheck = () => ({ valid: [], missing: [], mismatch: ['mine'] });
    expect(await executeCatalogRequest(spec, request, context, testProjectPrincipal(projectRoot))).toMatchObject({
      kind: 'unary',
      body: { code: 'scope_mismatch' },
    });
  });
});
