import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import type { AppServerProxyRouteRequest } from '#src/jobs/contracts/app-server-proxy-route.js';
import type { WaitStreamEvent, WaitStreamRequest } from '#src/jobs/wait.js';
import type { DurableProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import { createAppServerProxyRoute } from '#src/coordinator/services/provider-proxy-launch-route.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import { executePipeline } from '#src/workflow/executor.js';
import type { WorkflowExecutionPort } from '#src/workflow/execution-contract.js';
import { parseExpression } from '#src/workflow/parser.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';

const TEST_WORKSPACE = mkdtempSync(join(tmpdir(), 'coral-provider-proxy-launch-route-'));

afterAll(() => rmSync(TEST_WORKSPACE, { recursive: true, force: true }));

const request: AppServerProxyRouteRequest = {
  jobId: randomUUID(),
  operationId: randomUUID(),
  jobLaunchEventSeq: 41,
  sessionId: randomUUID(),
  sessionVersion: 3,
  hostSpec: {
    provider: 'codex',
    command: 'codex',
    args: ['app-server'],
    cwd: fixtureCanonicalWorkDir(TEST_WORKSPACE),
    leaseMode: 'job-exclusive',
  },
  provider: 'codex',
  binding: { provider: 'codex', kind: 'account', binding: { account: 'acct-1' } },
  request: {
    action: 'exec',
    sessionId: 'session-1',
    prompt: 'do the thing',
    cwd: fixtureCanonicalWorkDir(TEST_WORKSPACE),
    bypassPermissions: false,
    coralEnv: {},
  },
  persistedContinuity: null,
  baseEnv: { PATH: '/usr/bin' },
  protectedEnv: {},
  platform: 'linux',
  childAuthorization: {
    principalWire: {
      subject: 'agent',
      binding: { kind: 'project', root: fixtureCanonicalWorkDir(TEST_WORKSPACE) },
      attenuatedCaps: ['liveness', 'jobs:read'],
    },
    namespace: 'tests',
    expiresAtMs: 60_000,
  },
};

function authority(): DurableProviderProxyOperationAuthority {
  const proxyInstanceId = randomUUID();
  const buildSetId = randomUUID();
  return {
    proxyInstanceId,
    faulted: new Promise<never>(() => {}),
    onFault: () => () => undefined,
    onIncident: () => () => undefined,
    setIdentity: {
      buildSetId,
      hostFingerprint: 'a'.repeat(64),
      guardianInstanceId: randomUUID(),
      guardianPid: 100,
      guardianProcessStartedAtSeconds: 1,
      guardianControlEndpoint: '/tmp/guardian.sock',
      proxyInstanceId,
      proxyPid: 200,
      reaperInstanceId: randomUUID(),
      reaperPid: 300,
      reaperProcessStartedAtSeconds: 2,
      reaperControlEndpoint: '/tmp/reaper.sock',
      containmentKind: 'detached-group',
      proxyProcessStartedAtSeconds: 3,
      proxyProcessGroupId: 200,
      canonicalEndpoint: '/tmp/proxy.sock',
    },
    registerSuccessionOperation: async () => undefined,
    stopAndReap: async () => ({ disappearanceReceipt: 'gone' }),
    stopHeartbeats: () => undefined,
    initiateControlClose: async () => undefined,
    prepareOperation: vi.fn(),
    inspectOperation: vi.fn(),
    authorizeOperation: vi.fn(),
    activatePreparedOperation: vi.fn(),
    attachOperation: vi.fn(),
    cancelOperation: vi.fn(),
    settleOperation: vi.fn(),
    buildOperationControl: vi.fn(),
  };
}

async function* completed(jobId: string): AsyncGenerator<WaitStreamEvent> {
  yield {
    type: 'terminal',
    jobId,
    seq: 1,
    remainingJobIds: [],
    resultPath: `/tmp/coral-exports/jobs/${jobId}/result.md`,
    result: { content: 'done', outcome: { kind: 'completed' }, durationMs: 1 },
  };
}

describe('createAppServerProxyRoute', () => {
  it('authorizes local placement before creating an operation when no live set exists', async () => {
    const begin = vi.fn();
    const route = createAppServerProxyRoute({
      hostManager: { routeAppServerOperation: () => null },
      reconciler: { begin },
      now: () => 10,
    });

    await expect(route.activate(request, new AbortController().signal)).resolves.toMatchObject({
      kind: 'local-authorized',
    });
    expect(begin).not.toHaveBeenCalled();
  });

  it('passes an already-aborted launch into the write-ahead publication boundary', async () => {
    const set = authority();
    const routeAppServerOperation = vi.fn(() => set);
    const begin = vi.fn(async () => ({ kind: 'terminalized' as const }));
    const route = createAppServerProxyRoute({
      hostManager: { routeAppServerOperation },
      reconciler: { begin },
      now: () => 10,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(route.activate(request, controller.signal)).resolves.toEqual({ kind: 'terminalized' });
    expect(routeAppServerOperation).toHaveBeenCalledOnce();
    expect(begin).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
  });

  it('hands the reconciler a source-complete row and its exact journaled attempt', async () => {
    const set = authority();
    const begin = vi.fn(async () => ({ kind: 'remote-executing' as const }));
    const route = createAppServerProxyRoute({
      hostManager: { routeAppServerOperation: () => set },
      reconciler: { begin },
      now: () => 10,
    });
    await expect(route.activate(request, new AbortController().signal)).resolves.toEqual({
      kind: 'remote-executing',
    });
    expect(begin).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: set,
        record: expect.objectContaining({
          phase: 'prepare-pending',
          prepareAttemptNumber: 1,
          prepareSource: {
            jobLaunchEventSeq: request.jobLaunchEventSeq,
            sessionId: request.sessionId,
            sessionVersion: request.sessionVersion,
            platform: request.platform,
            childAuthorization: request.childAuthorization,
          },
          revision: 0,
          operation: expect.objectContaining({
            jobId: request.jobId,
            operationId: request.operationId,
            proxyInstanceId: set.proxyInstanceId,
            buildSetId: set.setIdentity.buildSetId,
          }),
        }),
        attempt: expect.objectContaining({
          request: expect.objectContaining({
            prepareAttemptNumber: 1,
            operation: expect.objectContaining({ jobId: request.jobId, operationId: request.operationId }),
            prepared: expect.objectContaining({ version: 1, provider: request.provider }),
          }),
        }),
      }),
    );
  });

  it('routes a workflow slot through a live proxy with a canonical job identity', async () => {
    const set = authority();
    const begin = vi.fn(async () => ({ kind: 'remote-executing' as const }));
    const route = createAppServerProxyRoute({
      hostManager: { routeAppServerOperation: () => set },
      reconciler: { begin },
      now: () => 10,
    });
    const workflowJobId = randomUUID();
    const atomJobId = randomUUID();
    let workflowSlotId: string | undefined;
    const executionSvc: WorkflowExecutionPort = {
      coralDispatch: vi.fn(async (_provider, _coralName, input) => {
        const jobId = String(input.jobId);
        workflowSlotId = input.workflowSlotId;
        await route.activate({ ...request, jobId }, new AbortController().signal);
        return {
          kind: 'provider-session' as const,
          status: 'running' as const,
          jobId,
          sessionId: request.sessionId,
        };
      }),
      resume: vi.fn(),
      recordContinuationLease: vi.fn(),
      clearContinuationLease: vi.fn(),
      abort: vi.fn(() => ({ aborted: [], notFound: [] })),
      awaitLaunch: vi.fn(async () => 'ready' as const),
      waitStream: vi.fn((waitRequest: WaitStreamRequest) => completed(waitRequest.jobIds[0])),
      waitForJobTerminal: vi.fn(),
    };
    const ctx: InvocationContext = {
      projectRoot: fixtureCanonicalWorkDir(TEST_WORKSPACE),
      pluginRoot: TEST_WORKSPACE,
      coralEnv: {},
      principal: testProjectPrincipal(TEST_WORKSPACE),
    };

    await expect(
      executePipeline(parseExpression('architect'), 'seed', 'codex', executionSvc, ctx, {
        workflowJobId,
        ids: { uuid: () => atomJobId },
        time: { now: () => 10 },
      }),
    ).resolves.toMatchObject({ finalOutput: 'done' });

    expect(workflowSlotId).toBe(`${workflowJobId}:0:0`);
    expect(begin).toHaveBeenCalledWith(
      expect.objectContaining({
        record: expect.objectContaining({
          operation: expect.objectContaining({ jobId: atomJobId }),
        }),
      }),
    );
  });

  it('reports which operation identity a live proxy rejected and why', async () => {
    const route = createAppServerProxyRoute({
      hostManager: { routeAppServerOperation: () => authority() },
      reconciler: { begin: vi.fn() },
      now: () => 10,
    });
    const workflowSlotId = `${randomUUID()}:0:0`;

    try {
      await route.activate({ ...request, jobId: workflowSlotId }, new AbortController().signal);
      throw new Error('Expected proxy identity validation to reject the workflow slot id.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        `Provider proxy launch rejected operation identity for job '${workflowSlotId}'.`,
      );
      expect((error as Error).message).toContain('jobId');
      expect((error as Error).message).toContain('queued workflow child created before the job-id upgrade');

      const cause = (error as Error & { cause?: unknown }).cause as
        | { issues?: Array<{ path: PropertyKey[] }> }
        | undefined;
      expect(cause?.issues).toEqual(expect.any(Array));
      expect(cause?.issues?.some((issue) => issue.path.length === 1 && issue.path[0] === 'jobId')).toBe(true);
    }
  });

  it('fails closed when a selected set lacks durable replay operations', async () => {
    const set = authority();
    const { prepareOperation: _prepare, ...legacy } = set;
    const begin = vi.fn();
    const route = createAppServerProxyRoute({
      hostManager: { routeAppServerOperation: () => legacy },
      reconciler: { begin },
      now: () => 10,
    });

    await expect(route.activate(request, new AbortController().signal)).rejects.toThrow(/durable operation replay/u);
    expect(begin).not.toHaveBeenCalled();
  });
});
