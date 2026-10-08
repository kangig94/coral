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
      listJobProjections: () => [...statuses].map(([jobId, status]) => ({ jobId, status })),
      loadJobProjectionDetail: (jobId: string) => ({
        status: statuses.get(jobId) ?? null,
        launch: { request: { coralEnv: { CORAL_OWNER: jobId === 'other' ? 'other-session' : 'session' } } },
      }),
    }),
    jobAddressing: { waitStream: stream, snapshot, scopeCheck: () => ({ valid: [], missing: [], mismatch: [] }) },
  } as unknown as Parameters<typeof createCoordinatorRpcPorts>[0]);
  const deps = {
    jobAttention: attention,
    waitCoordinator: {
      waitForOutcomes: stream,
      waitStreamOnce: async () => {
        expect(attention.isUnwaited('mine')).toBe(false);
        return {};
      },
      waitForJobTerminal: async () => {
        expect(attention.isUnwaited('mine')).toBe(false);
      },
    },
  } as unknown as JobWaitServiceDeps;
  return { attention, ports, service: new JobWaitService(deps), snapshot };
}

describe('job attention', () => {
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
    expect(attention.isUnwaited('mine')).toBe(false);
    await first.return(undefined);
    expect(attention.isUnwaited('mine')).toBe(false);
    await second.return(undefined);
    expect(attention.isUnwaited('mine')).toBe(true);
    await service.waitStreamOnce('mine');
    await service.waitForJobTerminal('mine');
    expect(attention.isUnwaited('mine')).toBe(true);
    ports.jobs.snapshot({ jobIds: ['mine'] });
    expect(snapshot).toHaveBeenCalled();
    expect(attention.isUnwaited('mine')).toBe(true);
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
