import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { followJobs } from '#src/cli/follow.js';
import * as readStore from '#src/cli/read-store.js';
import { formatJobDetail } from '#src/cli/format/jobs.js';
import { createCoordinatorRpcPorts } from '#src/coordinator/composition/rpc-ports.js';
import { JobAttention } from '#src/coordinator/services/job-attention.js';
import { readProjectionJobAddress } from '#src/jobs/projection-row.js';
import { CHILD_PRINCIPAL_CAPABILITIES } from '#src/coordinator/child-principal-registry.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import type { JobDetailResponse } from '#src/jobs/records.js';
import { parseWaitStreamEventValue } from '#src/jobs/wait/stream-event.js';
import { canonicalizeWorkDir } from '#src/runtime/canonical-work-dir.js';
import { attenuate } from '#src/security/attenuate.js';
import type { Principal } from '#src/security/principal.js';
import { executeCatalogRequest } from '#src/transport/dispatch.js';
import { rpcCatalog } from '#src/transport/rpc/catalog.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import { testPrincipal, testProjectPrincipal } from '#tests/helpers/principal.js';
import { conversationIdentityFixture } from '#tests/integration/jobs/conversation-identity-fixture.js';

it('allows operator job reads from another cwd, while keeping bound reads and all mutations scoped', async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'coral-job-read-scope-')));
  const callerDir = join(temp, 'caller');
  const jobDir = join(temp, 'repo');
  const subDir = join(jobDir, 'sub');
  mkdirSync(callerDir);
  mkdirSync(subDir, { recursive: true });
  const hintResultRepair = vi.fn();
  const f = conversationIdentityFixture({ stall: true, hintResultRepair });
  try {
    f.runtime.storage.mkdirSync(jobDir, { recursive: true });
    const jobCtx = {
      ...f.ctx,
      projectRoot: canonicalizeWorkDir(jobDir, jobDir),
      principal: testProjectPrincipal(jobDir),
      coralEnv: { ...f.ctx.coralEnv, CORAL_OWNER: 'owning-session' },
    };
    const service = f.serviceForContext(jobCtx);
    const initial = await f.drive(
      service.start('codex', { prompt: 'retained outcome', cwd: jobCtx.projectRoot }, jobCtx),
    );
    if (initial.status !== 'running' && initial.status !== 'queued') throw new Error(initial.message);
    const { jobId, epochKey, requestedSeq } = initial;
    const locations = new JobLocationIndex(f.runtime, f.runtime.paths.coral.generation.dataRoot);
    const readWaitAdmissions = vi.fn(service.readWaitAdmissions.bind(service));
    const abort = vi.fn(() => ({ kind: 'answered' as const, result: { aborted: [], notFound: [] } }));
    const exportOwner = f.store.getResultExportOwner();
    const addressing = new JobAddressing(
      locations,
      {
        epochKey: () => epochKey,
        detail: (id) => f.store.loadJobDetailResponse(id),
        address: (id) => readProjectionJobAddress(f.store.getDb(), id),
        readWaitAdmissions,
        visitProgress: (_epoch, read) => f.store.visitProgress(read),
        abort,
      },
      () => false,
      () => 'decided',
      undefined,
      (id, execution) => exportOwner.observeResultAvailability(id, undefined, execution),
      hintResultRepair,
    );
    const rpcPorts = createCoordinatorRpcPorts({
      jobAddressing: addressing,
      services: { getExecutionService: () => service, jobAttention: new JobAttention() },
      getProgressStore: () => f.store,
      time: f.runtime.time,
      waitHandoverSignal: () => new AbortController().signal,
    } as unknown as Parameters<typeof createCoordinatorRpcPorts>[0]);
    const ports = {
      ...rpcPorts,
      identity: { pluginRoot: '/plugin', bootToken: 'boot-token', now: () => 0, log: vi.fn() },
      coralEnvSnapshot: {},
      admin: { isLifecycleRunning: () => true, isDrainRequested: () => false, isLaunchFenceActive: () => false },
    } as unknown as HttpHandlerPorts;
    const operator = testPrincipal();
    const boundOperator = testProjectPrincipal(callerDir);
    const child = attenuate(boundOperator, CHILD_PRINCIPAL_CAPABILITIES);
    const specFor = (method: string) => rpcCatalog.find((entry) => entry.name === method)!;
    const request = (method: string, params: object, principal: Principal = operator) => {
      const spec = specFor(method);
      return executeCatalogRequest(
        spec,
        spec.requestSchema.parse({ projectRoot: callerDir, ...params }),
        ports,
        principal,
      );
    };
    const detail = { jobId };
    const snapshot = { jobIds: [jobId], waitRpcVersion: 2 };
    const stream = { ...snapshot, cursor: null, timeoutSeconds: 1 };
    async function readStream(principal: Principal, params: object = stream) {
      const result = await request('jobs.wait', params, principal);
      if (result.kind !== 'subscription') throw new Error(JSON.stringify(result));
      const events = [];
      for await (const row of result.notifications) {
        const event = parseWaitStreamEventValue(row);
        if (event === null) throw new Error('Unexpected wait event');
        events.push(event);
      }
      return events;
    }
    const send = (mode: 'steer' | 'continue', principal = operator) =>
      request(
        'jobs.send',
        {
          jobId,
          input: 'must not be delivered',
          clientMessageId: '33333333-3333-4333-8333-000000000011',
          target: { mode, execution: 1, requestedSeq, sourceEpoch: epochKey },
        },
        principal,
      );

    const reading = await request('jobs.detail', detail);
    expect(reading).toMatchObject({ kind: 'unary', body: { status: { workDir: jobDir } } });
    if (reading.kind !== 'unary') throw new Error('Expected detail response');
    expect(formatJobDetail(reading.body as JobDetailResponse)).toContain(`Work dir: ${jobDir}`);
    for (const projectRoot of [subDir, callerDir, jobDir]) {
      const live = await request('jobs.wait', { ...stream, projectRoot });
      if (live.kind !== 'subscription') throw new Error(JSON.stringify(live));
      const events = live.notifications[Symbol.asyncIterator]();
      try {
        expect((await events.next()).value).toMatchObject({ type: 'admission' });
        const spec = specFor('jobs.list');
        const mine = await executeCatalogRequest(
          spec,
          spec.requestSchema.parse({ owner: 'owning-session', unwaited: true }),
          ports,
          operator,
        );
        expect(mine).toMatchObject({
          body: { jobs: [] },
        });
      } finally {
        await events.return?.();
      }
    }
    for (const [principal, disclosed] of [
      [operator, true],
      [boundOperator, false],
    ] as const) {
      expect(await send('steer', principal)).toMatchObject({
        body: {
          state: 'refused',
          code: 'scope_mismatch',
          reason: disclosed ? expect.stringContaining(JSON.stringify(jobDir)) : 'The job belongs to another project.',
        },
      });
    }
    for (const method of ['jobs.abort', 'jobs.release']) {
      expect(await request(method, { jobs: [jobId] })).toMatchObject({
        body: { code: 'scope_mismatch', detail: { workDirs: [{ jobId, workDir: jobDir }] } },
      });
      const bound = await request(method, { jobs: [jobId] }, boundOperator);
      expect(bound).toMatchObject({ body: { code: 'scope_mismatch', detail: { jobs: [jobId] } } });
      expect(JSON.stringify(bound)).not.toContain(jobDir);
    }
    expect(abort).not.toHaveBeenCalled();
    f.finish(jobId);
    await f.drive(service.waitForJobTerminal(jobId, 10_000));
    expect(f.store.loadJobDetailResponse(jobId)?.exit?.outcome).toMatchObject({ kind: 'completed' });
    const terminalSeq = f.store.readJobLastSeq(jobId);
    for (const [principal, disclosed] of [
      [operator, true],
      [boundOperator, false],
    ] as const) {
      expect(await send('continue', principal)).toMatchObject({
        body: {
          state: 'refused',
          code: 'scope_mismatch',
          reason: disclosed ? expect.stringContaining(JSON.stringify(jobDir)) : 'The job belongs to another project.',
        },
      });
    }

    vi.spyOn(exportOwner, 'observeResultAvailability').mockReturnValue({ kind: 'pending' });
    const readPendingDetail = await request('jobs.detail', { ...detail, projectRoot: jobDir });
    expect(readPendingDetail).toMatchObject({ body: { availability: { kind: 'pending' } } });
    for (const projectRoot of [callerDir, jobDir]) {
      hintResultRepair.mockClear();
      expect(await request('jobs.detail', { ...detail, projectRoot })).toEqual(readPendingDetail);
      expect(hintResultRepair).toHaveBeenCalledWith(jobId, 1);

      hintResultRepair.mockClear();
      const terminal = (await f.drive(readStream(operator, { ...stream, projectRoot }))).find(
        (event) => event.type === 'terminal',
      );
      expect(terminal).toMatchObject({
        jobId,
        result: { outcome: { kind: 'completed' } },
        availability: { kind: 'pending' },
        exitCode: 75,
      });
      expect(hintResultRepair).toHaveBeenCalledWith(jobId, 1);

      hintResultRepair.mockClear();
      const result = await request('jobs.wait.snapshot', { ...snapshot, projectRoot });
      expect(result).toMatchObject({
        body: {
          jobs: [
            {
              jobId,
              disposition: 'admitted',
              terminal: { outcomeKind: 'completed' },
              availability: { kind: 'pending' },
            },
          ],
        },
      });
      expect(hintResultRepair).toHaveBeenCalledWith(jobId, 1);
    }
    expect(f.store.readJobLastSeq(jobId)).toBe(terminalSeq);
    expect(locations.read(jobId)).toBeNull();

    const forgedSelection = {
      cursor: String(requestedSeq),
      executionSelections: [
        { jobId, epochKey, requestedSeq, deliveredEndSeq: requestedSeq + 999, awaitingArtifact: false },
      ],
    };
    readWaitAdmissions.mockClear();
    for (const principal of [child, boundOperator]) {
      expect(await request('jobs.detail', detail, principal)).toMatchObject({ body: { code: 'scope_mismatch' } });
      for (const selection of [{}, forgedSelection]) {
        const dispositions = (await f.drive(readStream(principal, { ...stream, ...selection }))).filter(
          (event) => event.type === 'disposition',
        );
        expect(dispositions).toMatchObject([{ jobId, disposition: 'scope-mismatch' }]);
        expect(await request('jobs.wait.snapshot', { ...snapshot, ...selection }, principal)).toMatchObject({
          body: {
            jobs: [{ jobId, disposition: 'scope-mismatch', message: dispositions[0].message }],
            executionSelections: [],
          },
        });
      }
    }
    expect(readWaitAdmissions.mock.calls.flatMap(([ids]) => ids)).not.toContain(jobId);
    const localDetail = vi.fn();
    const store = vi.spyOn(readStore, 'openReadCoralStore').mockReturnValue({
      store: { jobs: { detail: localDetail } },
      close: vi.fn(),
    } as unknown as ReturnType<typeof readStore.openReadCoralStore>);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk, callback) => {
      if (typeof callback === 'function') callback();
      return Boolean(chunk);
    }) as typeof process.stdout.write);
    try {
      const code = await f.drive(
        followJobs({
          jobIds: [jobId],
          projectRoot: callerDir,
          render: { isTTY: false, columns: 80, embed: false, verbose: false },
          emitError: (error) => {
            throw error;
          },
          connect: async () => {
            const result = await request('jobs.wait', stream, child);
            if (result.kind !== 'subscription') throw new Error(JSON.stringify(result));
            return {
              [Symbol.asyncIterator]: () => result.notifications[Symbol.asyncIterator](),
              close: async () => {},
            };
          },
        }),
      );
      expect(code).toBe(1);
      expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('scope-mismatch');
      expect(localDetail).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      store.mockRestore();
    }

    const forged = { projectRoot: callerDir, outsideCwdJobRead: true };
    for (const [method, params] of [
      ['jobs.detail', detail],
      ['jobs.wait.snapshot', snapshot],
    ] as const) {
      expect(specFor(method).requestSchema.safeParse({ ...params, ...forged }).success).toBe(false);
      const result = await executeCatalogRequest(specFor(method), { ...params, ...forged }, ports, child);
      if (result.kind !== 'unary') throw new Error('Forged read was dispatched as a stream');
      expect(result.body).not.toHaveProperty('status');
      expect(JSON.stringify(result.body)).not.toContain(jobDir);
    }
    expect(await request('jobs.wait', { ...stream, ...forged }, child)).toMatchObject({
      kind: 'unary',
      body: { code: 'wait_build_mismatch' },
    });
  } finally {
    await f.dispose();
    rmSync(temp, { recursive: true, force: true });
  }
});
