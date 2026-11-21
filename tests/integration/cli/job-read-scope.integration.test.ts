import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { formatJobDetail } from '#src/cli/format/jobs.js';
import { formatWaitSnapshot, formatWaitTerminal } from '#src/cli/format/wait.js';
import { createCoordinatorRpcPorts } from '#src/coordinator/composition/rpc-ports.js';
import { JobAttention } from '#src/coordinator/services/job-attention.js';
import { readProjectionJobAddress } from '#src/jobs/projection-row.js';
import { CHILD_PRINCIPAL_CAPABILITIES } from '#src/coordinator/child-principal-registry.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import type { JobDetailResponse } from '#src/jobs/records.js';
import { parseWaitSnapshot } from '#src/jobs/wait/snapshot.js';
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
  const jobDir = join(temp, 'job');
  mkdirSync(callerDir);
  mkdirSync(jobDir);
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
    const send = (mode: 'steer' | 'continue') =>
      request('jobs.send', {
        jobId,
        input: 'must not be delivered',
        clientMessageId: '33333333-3333-4333-8333-000000000011',
        target: { mode, execution: 1, requestedSeq, sourceEpoch: epochKey },
      });

    const reading = await request('jobs.detail', detail);
    expect(reading).toMatchObject({ kind: 'unary', body: { status: { workDir: jobDir } } });
    if (reading.kind !== 'unary') throw new Error('Expected detail response');
    expect(formatJobDetail(reading.body as JobDetailResponse)).toContain(`Work dir: ${jobDir}`);
    for (const projectRoot of [callerDir, jobDir]) {
      const live = await request('jobs.wait', { ...stream, projectRoot });
      if (live.kind !== 'subscription') throw new Error(JSON.stringify(live));
      const events = live.notifications[Symbol.asyncIterator]();
      try {
        expect((await events.next()).value).toMatchObject({ type: 'admission' });
        if (projectRoot === callerDir)
          expect((await events.next()).value).toMatchObject({
            type: 'notice',
            message: `Job ${jobId} · Work dir: "${jobDir}"`,
          });
        const mine = await request('jobs.list', { projectRoot: jobDir, owner: 'owning-session', unwaited: true });
        expect(mine).toMatchObject({
          body: { jobs: projectRoot === callerDir ? [{ jobId }] : [] },
        });
      } finally {
        await events.return?.();
      }
    }
    expect(await send('steer')).toMatchObject({ kind: 'unary', body: { state: 'refused', code: 'scope_mismatch' } });
    for (const method of ['jobs.abort', 'jobs.release']) {
      expect(await request(method, { jobs: [jobId] })).toMatchObject({ body: { code: 'scope_mismatch' } });
    }
    expect(abort).not.toHaveBeenCalled();
    f.finish(jobId);
    await f.drive(service.waitForJobTerminal(jobId, 10_000));
    expect(f.store.loadJobDetailResponse(jobId)?.exit?.outcome).toMatchObject({ kind: 'completed' });
    const terminalSeq = f.store.readJobLastSeq(jobId);
    expect(await send('continue')).toMatchObject({ kind: 'unary', body: { state: 'refused', code: 'scope_mismatch' } });

    vi.spyOn(exportOwner, 'observeResultAvailability').mockReturnValue({ kind: 'pending' });
    hintResultRepair.mockClear();
    expect(await request('jobs.detail', detail)).toMatchObject({ body: { availability: { kind: 'pending' } } });
    expect(hintResultRepair).not.toHaveBeenCalled();
    const terminal = (await f.drive(readStream(operator))).find((event) => event.type === 'terminal');
    expect(terminal).toMatchObject({
      jobId,
      outsideCwdWorkDir: jobDir,
      result: { outcome: { kind: 'completed' } },
      availability: { kind: 'pending' },
      exitCode: 75,
    });
    if (terminal === undefined) throw new Error('Expected terminal response');
    expect(formatWaitTerminal(terminal, terminal.cursor ?? null, false)).toContain(`Work dir: "${jobDir}"`);
    const result = await request('jobs.wait.snapshot', snapshot);
    if (result.kind !== 'unary') throw new Error('Expected snapshot response');
    expect(formatWaitSnapshot(parseWaitSnapshot(result.body))).toContain(`Work dir: "${jobDir}"`);

    expect(hintResultRepair).not.toHaveBeenCalled();
    expect(f.store.readJobLastSeq(jobId)).toBe(terminalSeq);
    expect(locations.read(jobId)).toBeNull();
    expect(await request('jobs.detail', { ...detail, projectRoot: jobDir })).toMatchObject({
      body: { availability: { kind: 'pending' } },
    });
    expect(hintResultRepair).toHaveBeenCalledWith(jobId, 1);
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
