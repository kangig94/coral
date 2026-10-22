import { afterEach, describe, expect, it } from 'vitest';

import { createCoordinatorRpcPorts } from '#src/coordinator/composition/rpc-ports.js';
import { JobAttention } from '#src/coordinator/services/job-attention.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { loadRetainedCurrentJob } from '#src/jobs/retained-current.js';
import { executeCatalogRequest } from '#src/transport/dispatch.js';
import { rpcCatalog } from '#src/transport/rpc/catalog.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { jobReadSurfaceFixture } from '#tests/helpers/job-read-surface.js';

const fixtures: ReturnType<typeof jobReadSurfaceFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
function fixture(second: Parameters<typeof jobReadSurfaceFixture>[0] = 'ended') {
  const f = jobReadSurfaceFixture(second);
  fixtures.push(f);
  const index = new JobLocationIndex(f.runtime, f.runtime.paths.coral.generation.dataRoot);
  const addressing = new JobAddressing(
    index.readOnlyView(),
    {
      epochKey: () => ':memory:',
      detail: (jobId) => f.store.loadJobDetailResponse(jobId),
      abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
    },
    () => false,
    () => 'decided',
    undefined,
    () => ({ kind: 'pending' }),
  );
  const rpc = createCoordinatorRpcPorts({
    services: { jobAttention: new JobAttention() },
    getProgressStore: () => f.store,
    jobAddressing: addressing,
  } as unknown as Parameters<typeof createCoordinatorRpcPorts>[0]);
  const execute = async (method: 'jobs.list' | 'jobs.detail', fields: object) => {
    const spec = rpcCatalog.find((entry) => entry.name === method);
    if (spec === undefined) throw new Error(`Missing method ${method}`);
    const request = spec.requestSchema.parse({ ...fields, projectRoot: f.projectRoot });
    const ports = {
      ...rpc,
      identity: { pluginRoot: '/plugin' },
      coralEnvSnapshot: {},
      admin: { isLaunchFenceActive: () => false },
    } as unknown as HttpHandlerPorts;
    return executeCatalogRequest(spec, request, ports, testProjectPrincipal(f.projectRoot));
  };
  return { ...f, index, rpc, execute };
}

describe('jobs read RPCs across executions', () => {
  it('lists one job with its latest ended execution and exposes every result in detail', async () => {
    const f = fixture();
    const listed = f.rpc.jobs.list({ all: true });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      jobId: f.jobId,
      execution: 2,
      resultPath: f.store.resultPathFor(f.jobId, 2),
      status: { execution: 2, phase: 'error', result: { content: 'result #2' } },
    });
    await expect(f.execute('jobs.list', { all: true })).resolves.toMatchObject({
      kind: 'unary',
      body: { jobs: listed },
    });
    const detail = f.rpc.jobs.detail(f.jobId);
    if (detail === null || 'kind' in detail) throw new Error('Expected job detail');
    expect(detail.epochKey).toBe(':memory:');
    expect(detail.requestedSeq).toBe(detail.executions?.[1].requestedSeq);
    expect(detail.executions).toHaveLength(2);
    expect(
      detail.executions?.map((entry) => ({
        execution: entry.execution,
        resultPath: entry.resultPath,
        content: entry.exit?.content,
        namespace: entry.status.backendNamespace,
      })),
    ).toEqual([
      { execution: 1, resultPath: f.store.resultPathFor(f.jobId, 1), content: 'result #1', namespace: 'tests' },
      { execution: 2, resultPath: f.store.resultPathFor(f.jobId, 2), content: 'result #2', namespace: 'second-build' },
    ]);
    for (const entry of detail.executions ?? []) {
      expect(entry.events.filter((event) => event.type === 'terminal')).toHaveLength(1);
      expect(entry.events.every((event) => event.seq >= entry.requestedSeq)).toBe(true);
    }
    await expect(f.execute('jobs.detail', { jobId: f.jobId })).resolves.toMatchObject({
      kind: 'unary',
      body: detail,
    });
  });

  it.each(['queued', 'finishing'] as const)(
    'lists and details the %s second execution without inheriting its predecessor end',
    async (state) => {
      const f = fixture(state);
      const rows = f.rpc.jobs.list({ owner: 'caller', unwaited: true });
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toMatchObject({ execution: 2, finishing: state === 'finishing' });
      expect(rows[0].status.result).toBeUndefined();
      const result = await f.execute('jobs.detail', { jobId: f.jobId });
      expect(result).toMatchObject({
        kind: 'unary',
        body: {
          exit: null,
          status: { execution: 2, finishing: state === 'finishing' },
          executions: [
            { execution: 1, exit: { content: 'result #1' } },
            { execution: 2, exit: null, resultPath: f.store.resultPathFor(f.jobId, 2) },
          ],
        },
      });
    },
  );

  it('returns every retained execution when its source is unavailable', () => {
    const f = fixture();
    const location = loadRetainedCurrentJob(f.h.db, 'retained:1', f.jobId, f.runtime.paths.coral.exports.jobsRoot)!;
    if (location.detail.kind !== 'recorded') throw new Error('Expected retained detail');
    f.index.register(f.jobId, location.epochKey, location.subject);
    f.index.recordExecutionDetails(f.jobId, location.executions!, location.detail.value);
    const addressing = new JobAddressing(
      f.index.readOnlyView(),
      {
        epochKey: () => ':memory:',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'decided',
      () => ({ kind: 'unreadable', disposition: 'retired' }),
      () => ({ kind: 'pending' }),
    );
    const detail = addressing.detail(f.jobId);
    if (detail === null || 'kind' in detail) throw new Error('Expected retained job detail');
    expect(detail.executions?.map((entry) => entry.exit?.content)).toEqual(['result #1', 'result #2']);
    expect(detail.resultPath).toBe(f.store.resultPathFor(f.jobId, 2));
    expect(detail.requestedSeq).toBe(detail.executions?.[1].requestedSeq);
  });
});
