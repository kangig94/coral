import { progressVisitFromDetails } from '#tests/helpers/wait-progress.js';
import { sharedFixture } from '#tests/helpers/shared-fixtures.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync } from 'node:fs';
import { Command } from 'commander';
import { registerSessionCommands } from '#src/cli/commands/session.js';
import { createBuiltInProviderRegistry } from '#src/providers/bootstrap.js';
import * as dispatch from '#src/cli/dispatch.js';
import { createConnection } from 'node:net';
import { createServer, request } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIpcServer, closeIpcServer } from '#src/transport/ipc/server.js';
import { createIpcClient } from '#src/transport/ipc/client.js';
import { createHttpHandler } from '#src/transport/http/handler.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { seedHistoricalEpoch, historicalSourceReader } from '#src/jobs/historical-reader.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';
import { initTestJob } from '#tests/helpers/session.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { deriveLaunchReadiness } from '#src/jobs/launch-readiness.js';
import { parseWaitSnapshot } from '#src/jobs/wait/snapshot.js';
import { serializeWaitCursor } from '#src/jobs/wait/cursor.js';
import { formatWaitSnapshot } from '#src/cli/format/wait.js';
import { formatJobDetail, renderJobsOperatorCommand } from '#src/cli/format/jobs.js';
import { WaitSession } from '#src/jobs/wait/session.js';
import { createRealTimePort } from '#src/infra/time.js';
import type { WaitSnapshot } from '#src/jobs/wait/session.js';
import type { JobDetailResponse } from '#src/jobs/records.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import { admitted, savedCursor } from '#tests/helpers/wait-session.js';
import { parseWaitStreamEventValue } from '#src/jobs/wait/stream-event.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

function ports(addressing?: JobAddressing): HttpHandlerPorts {
  const noop = () => {};
  return {
    identity: {
      pluginRoot: '/tmp',
      token: 'http-token',
      bootToken: 'boot-token',
      namespace: 'fixture',
      instanceId: 'fixture',
      log: noop,
      now: Date.now,
    },
    admin: {
      isLifecycleRunning: () => true,
      isDrainRequested: () => false,
      isLaunchFenceActive: () => false,
      beginRequest: noop,
      endRequest: noop,
    },
    events: { addResponse: noop, removeResponse: noop },
    health: {
      read: () => ({
        status: 'ok',
        version: '0.10.17',
        bundleHash: 'fixture',
        flavor: 'prod',
        namespace: 'fixture',
        instanceId: 'fixture',
        pid: process.pid,
      }),
    },
    coralEnvSnapshot: {},
    systemProviderScope: {},
    jobs: addressing
      ? {
          scopeCheck: addressing.scopeCheck.bind(addressing),
          validateWait: addressing.validateWait.bind(addressing),
          admitWait: addressing.admitWait.bind(addressing),
          snapshot: addressing.snapshot.bind(addressing),
          waitStream: addressing.waitStream.bind(addressing),
          detail: addressing.detail.bind(addressing),
          unknownJobDisposition: addressing.unknownJobDisposition.bind(addressing),
          waitHandoverSignal: () => new AbortController().signal,
        }
      : { waitHandoverSignal: () => new AbortController().signal },
  } as never;
}

describe('actual wait carriage', () => {
  it.each(['jobs.wait', 'jobs.wait.snapshot'] as const)(
    'rejects duplicate IDs before %s executes over IPC and HTTP',
    async (method) => {
      const f = createTerminalExportFixture();
      cleanup.push(f.close);
      const p = ports();
      p.jobs.scopeCheck = vi.fn(() => ({ valid: ['a'], missing: [], mismatch: [] }));
      p.jobs.admitWait = vi.fn();
      p.jobs.snapshot = vi.fn();
      p.jobs.waitStream = vi.fn();
      const listener = createIpcServer(p);
      cleanup.push(() => closeIpcServer(listener));
      const socketPath = join(f.root, 'duplicates.sock');
      await new Promise<void>((resolve) => listener.server.listen(socketPath, resolve));
      const client = createIpcClient(socketPath, undefined, { kind: 'boot', token: 'boot-token' });
      const input = {
        jobIds: ['a', 'a'],
        projectRoot: f.root,
        ...(method === 'jobs.wait' ? { cursor: { jobs: [] } } : {}),
      };
      const response = method === 'jobs.wait' ? client.subscribe(method, input) : client.request(method, input);
      await expect(response).rejects.toMatchObject({
        data: {
          issues: expect.arrayContaining([
            expect.objectContaining({
              path: ['jobIds'],
              message: 'Each job ID must appear only once; remove duplicate job IDs.',
            }),
          ]),
        },
      });
      const handler = createHttpHandler(p);
      const server = createServer((req, res) => void handler(req, res));
      cleanup.push(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      );
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const http = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(
          {
            hostname: '127.0.0.1',
            port: (server.address() as { port: number }).port,
            path: method === 'jobs.wait' ? '/jobs/wait' : '/jobs/wait/snapshot',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Coral-Backend-Token': 'http-token' },
          },
          (res) => {
            let body = '';
            res.on('data', (chunk: Buffer) => {
              body += chunk.toString();
            });
            res.on('end', () => resolve({ status: res.statusCode!, body }));
          },
        );
        req.on('error', reject);
        req.end(JSON.stringify(input));
      });
      expect(http.status).toBe(400);
      expect(http.body).toContain('Each job ID must appear only once');
      expect(p.jobs.admitWait).not.toHaveBeenCalled();
      expect(p.jobs.snapshot).not.toHaveBeenCalled();
      expect(p.jobs.waitStream).not.toHaveBeenCalled();
    },
  );

  it('delivers two bounded retained outcomes in one complete unary IPC envelope and full detail keeps diagnostics and trailing text', async () => {
    const f = createTerminalExportFixture('provider', true);
    cleanup.push(f.close);
    const ids = Array.from({ length: 2 }, (_, i) => (i === 0 ? f.jobId : `large-${i}`));
    const content = '🙂\\\"\n'.repeat(6000) + '\nUNIQUE_BEYOND_10000\nTAIL_CONTENT\n';
    const warning = 'complete diagnostic '.repeat(8000) + 'DIAGNOSTIC_TAIL';
    for (const [i, jobId] of ids.entries()) {
      if (i > 0)
        initTestJob(f.store, {
          jobId,
          sessionId: `session-${i}`,
          provider: 'claude',
          projectRoot: f.root,
          backendNamespace: 'fixture',
        });
      const seq = commitJobTerminal(
        f.store,
        jobId,
        i === 0 ? 'session-1' : `session-${i}`,
        { content, outcome: { kind: 'provider_exit', code: 0, note: 'large note '.repeat(500) }, durationMs: 9 },
        { diagnostics: { warnings: [warning] } },
      );
      const d = f.store.loadJobProjectionDetail(jobId);
      f.index.recordTerminal(
        jobId,
        { status: d.status!, exit: d.exit, events: f.store.readJobEvents(jobId), readiness: deriveLaunchReadiness(d) },
        f.index.resultPathFor(jobId),
        seq,
        f.db,
      );
    }
    f.advance(15 * 86400000);
    seedHistoricalEpoch(
      f.runtime,
      f.index,
      f.epoch,
      f.epochKey,
      currentCoralStoreFormat().fingerprint,
      f.runtime.paths.coral.exports.jobsRoot,
      f.runtime.storage,
    );
    f.removeSource();
    const addressing = new JobAddressing(
      f.index.readOnlyView(),
      {
        visitProgress: progressVisitFromDetails(() => null),
        epochKey: () => 'other',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'decided',
      historicalSourceReader(f.index),
      (id) => f.store.getResultExportOwner().observeResultAvailability(id),
    );
    const listenerPorts = ports(addressing);
    const listener = createIpcServer(listenerPorts);
    cleanup.push(() => closeIpcServer(listener));
    const socketPath = join(f.root, 'snapshot.sock');
    await new Promise<void>((resolve) => listener.server.listen(socketPath, resolve));
    const client = createIpcClient(socketPath, undefined, { kind: 'boot', token: 'boot-token' });
    expect(await client.health()).not.toHaveProperty('jobsWaitExtensions');
    const stream = await client.subscribe('jobs.wait', { jobIds: [ids[0]], projectRoot: f.root, cursor: { jobs: [] } });
    try {
      for await (const event of stream) {
        const decoded = parseWaitStreamEventValue(event);
        if (decoded?.type === 'terminal') {
          expect(decoded.availability?.kind).toBe('retained-away');
          break;
        }
      }
    } finally {
      await stream.close();
    }
    const response = client.request<WaitSnapshot>('jobs.wait.snapshot', { jobIds: ids, projectRoot: f.root });
    await expect(response).resolves.not.toHaveProperty('version');
    const snapshot = parseWaitSnapshot(await response);
    expect(snapshot.jobs).toHaveLength(2);
    expect(
      snapshot.jobs.every((job) => job.terminal && job.terminal.contentOmitted && job.terminal.diagnosticOmitted),
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify({ kind: 'response', id: 1, result: snapshot }))).toBeLessThan(
      2 * 1024 * 1024,
    );
    const printed = formatWaitSnapshot(snapshot);
    expect(printed).not.toContain('Result path:');
    expect(printed).toContain('no longer kept: past the 14-day retention window');
    const command = renderJobsOperatorCommand({ kind: 'jobs-detail-full', jobId: ids[0] });
    expect(printed).toContain(command);
    const resumed = parseWaitSnapshot(
      await client.request('jobs.wait.snapshot', {
        jobIds: ids,
        projectRoot: f.root,
        cursor: new WaitSession([]).cursor(),
      }),
    );
    expect(resumed.jobs).toHaveLength(2);
    const acknowledged = new WaitSession(ids);
    acknowledged.reconcile(addressing.admitWait({ jobIds: ids, projectRoot: f.root }));
    for (const job of acknowledged.admissions) acknowledged.acknowledge(job);
    const collected = parseWaitSnapshot(
      await client.request('jobs.wait.snapshot', {
        jobIds: ids,
        projectRoot: f.root,
        cursor: acknowledged.cursor(),
      }),
    );
    expect(collected.jobs.every((job) => job.alreadyCollected && !job.terminal)).toBe(true);
    const detail = await client.request<JobDetailResponse>('jobs.detail', { jobId: ids[0], projectRoot: f.root });
    const full = formatJobDetail(detail, undefined, [], true);
    expect(detail.exit!.content).toBe(content);
    vi.spyOn(dispatch, 'makeClient').mockReturnValue({
      snapshotJobsWait: (fields: Record<string, unknown>) =>
        client.request('jobs.wait.snapshot', { ...fields, projectRoot: f.root }),
      detailJob: (jobId: string) => client.request('jobs.detail', { jobId, projectRoot: f.root }),
    } as never);
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string, callback?: () => void) => {
      output += chunk;
      callback?.();
      return true;
    }) as never);
    const program = new Command();
    registerSessionCommands(program, createBuiltInProviderRegistry());
    await program.parseAsync(['node', 'coral-cli', 'wait', 'jobs', ...ids, '--now']);
    expect(output).toContain('Content preview:');
    expect(output).toContain(command);
    output = '';
    await program.parseAsync(['node', ...command.split(' ')]);
    expect(output).toContain('UNIQUE_BEYOND_10000\nTAIL_CONTENT\n');
    expect(output).toContain(warning);
    expect(output).toContain('no longer kept');
    expect(full).toContain('UNIQUE_BEYOND_10000\nTAIL_CONTENT\n');
    expect(full).toContain(warning);
    expect(full).toContain('provider exited 0');
    vi.restoreAllMocks();
    const original = addressing.snapshot({ jobIds: ids, projectRoot: f.root });
    const raw = createConnection(socketPath);
    await new Promise<void>((resolve) => raw.once('connect', resolve));
    raw.write(
      JSON.stringify({
        kind: 'request',
        id: 'disconnect',
        method: 'jobs.wait.snapshot',
        auth: { kind: 'boot', token: 'boot-token' },
        params: { jobIds: ids, projectRoot: f.root },
      }) + '\n',
    );
    raw.destroy();
    expect(addressing.snapshot({ jobIds: ids, projectRoot: f.root }).jobs[0].terminal).toEqual(
      original.jobs[0].terminal,
    );
  }, 30000);

  it.each([64, 128])(
    'real authenticated HTTP accepts %i-epoch cursors and reassembles complete SSE frames without 431',
    async (count) => {
      const jobs = Array.from({ length: count }, (_, i) => admitted(`j${i}`, [], false, `/tmp/epoch-${i}`));
      const session = new WaitSession(jobs.map((job) => job.jobId));
      session.reconcile(jobs);
      const cursor = {
        ...session.cursor(),
        jobs: session
          .cursor()
          .jobs.map((entry) => ({ ...entry, flags: 0, seq: Number.MAX_SAFE_INTEGER, lineOffset: 0xffffffff })),
      };
      const p = ports();
      p.jobs.scopeCheck = () => ({ valid: jobs.map((job) => job.jobId), missing: [], mismatch: [] });
      p.jobs.admitWait = () => jobs;
      p.jobs.validateWait = () => null;
      p.jobs.waitStream = async function* () {
        yield {
          type: 'waiting',
          waitingJobIds: jobs.map((job) => job.jobId),
          cursor,
          exitCode: 75,
        };
      };
      const handler = createHttpHandler(p);
      const server = createServer((req, res) => void handler(req, res));
      cleanup.push(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      );
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/jobs/wait',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Coral-Backend-Token': 'http-token',
              'Last-Event-ID': serializeWaitCursor(cursor),
            },
          },
          (res) => {
            let body = '';
            res.on('data', (chunk: Buffer) => {
              body += chunk.toString();
            });
            res.on('end', () => resolve({ status: res.statusCode!, body }));
          },
        );
        req.on('error', reject);
        req.end(JSON.stringify({ jobIds: jobs.map((job) => job.jobId), projectRoot: '/tmp' }));
      });
      expect(response.status).toBe(200);
      expect(response.body.endsWith('\n\n')).toBe(true);
      const data = response.body
        .split('\n')
        .find((line) => line.startsWith('data: '))!
        .slice(6);
      expect(JSON.parse(data).cursor).toEqual(cursor);
    },
  );
  it.each(['drains', 'expires'])('wait SSE backpressure %s through a bounded, resumable carriage', async (mode) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let blockedReady!: () => void;
    const blockedPromise = new Promise<void>((resolve) => {
      blockedReady = resolve;
    });
    const p = ports();
    const job = admitted('a', [], false);
    const session = new WaitSession(['a']);
    session.reconcile([job]);
    p.jobs.scopeCheck = () => ({ valid: ['a'], missing: [], mismatch: [] });
    p.jobs.admitWait = () => [job];
    p.jobs.validateWait = () => null;
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    p.jobs.waitStream = async function* () {
      clock = mode === 'drains' ? 950 : 1000;
      yield { type: 'waiting', waitingJobIds: ['a'], cursor: session.cursor(), exitCode: 75 };
    };
    const handler = createHttpHandler(p);
    let closeResponse!: () => void;
    const responseClosed = new Promise<void>((resolve) => {
      closeResponse = resolve;
    });
    const server = createServer((req, res) => {
      const write = res.write.bind(res);
      let blocked = false;
      res.write = ((data: string) => {
        if (!blocked && data.includes('event: waiting')) {
          blocked = true;
          blockedReady();
          if (mode === 'drains')
            setTimeout(() => {
              write(data);
              res.emit('drain');
            }, 25);
          return false;
        }
        return write(data);
      }) as typeof res.write;
      res.once('close', () => {
        closeResponse();
      });
      void handler(req, res);
    });
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const started = Date.now();
    const response = new Promise<string>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: (server.address() as { port: number }).port,
          path: '/jobs/wait',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Coral-Backend-Token': 'http-token' },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk: Buffer) => {
            text += chunk.toString();
          });
          res.on('end', () => resolve(text));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ jobIds: ['a'], projectRoot: '/tmp', timeoutSeconds: 1 }));
    });
    await blockedPromise;
    await vi.advanceTimersByTimeAsync(25);
    await expect(response).resolves.toEqual(expect.any(String));
    const body = await response;
    await responseClosed;
    expect(body.endsWith('\n\n')).toBe(true);
    if (mode === 'drains') {
      expect(Date.now() - started).toBeGreaterThanOrEqual(20);
      expect(body).toContain('event: waiting');
      expect(body).toContain(serializeWaitCursor(session.cursor()));
    } else {
      expect(Date.now() - started).toBeLessThan(1500);
      expect(body).toContain('event: error');
      expect(body).toContain('last completely received cursor');
      expect(body).not.toContain('id: ');
    }
    vi.useRealTimers();
  });

  it('validates snapshot admission, artifact and continuation contracts', async () => {
    const a = admitted('a');
    a.availability = { kind: 'repair-pending', ageUncertain: false };
    const admissions = [
      a,
      { jobId: 'ghost', disposition: 'missing' as const },
      { jobId: 'u', disposition: 'discovery-unknown' as const },
    ];
    const addressing = new JobAddressing(
      { time: createRealTimePort() } as never,
      { epochKey: () => 'epoch-E' } as never,
      () => false,
      () => 'pending',
      undefined,
      () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
    );
    vi.spyOn(addressing, 'admitWait').mockReturnValue(admissions);
    const complete = ports(addressing);
    const snapshot = parseWaitSnapshot(complete.jobs.snapshot({ jobIds: ['a', 'ghost', 'u'], projectRoot: '/tmp' }));
    expect(snapshot.jobs[0].availability?.kind).toBe('repair-pending');
    expect(snapshot.remainingJobIds).toEqual(['a', 'u']);
    expect(snapshot.exitCode).toBe(1);
    for await (const event of complete.jobs.waitStream({
      jobIds: ['a', 'ghost', 'u'],
      projectRoot: '/tmp',
      drainProgress: false,
    }))
      expect(parseWaitStreamEventValue(event)).toEqual(event);
  });
  it('collects a cross-process maintenance export after an acknowledged snapshot without replaying its outcome', async () => {
    const f = createTerminalExportFixture('provider', true);
    cleanup.push(f.close);
    f.complete();
    const hints = new Set<string>();
    const addressing = new JobAddressing(
      f.index.readOnlyView(),
      {
        visitProgress: progressVisitFromDetails(
          (id) =>
            ({
              ...f.store.loadJobProjectionDetail(id),
              events: f.store.readJobEvents(id),
              readiness: 'ready',
            }) as JobDetailResponse,
        ),
        epochKey: () => f.epochKey,
        detail: (id) =>
          ({
            ...f.store.loadJobProjectionDetail(id),
            events: f.store.readJobEvents(id),
            readiness: 'ready',
          }) as JobDetailResponse,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'pending',
      historicalSourceReader(f.index),
      (id) => f.store.getResultExportOwner().observeResultAvailability(id),
      (id) => hints.add(id),
    );
    const snapshot = addressing.snapshot({ jobIds: [f.jobId], projectRoot: f.root });
    expect(snapshot.jobs[0].availability?.kind).toBe('repair-pending');
    expect(snapshot.cursor.jobs[0].flags).toBe(3);
    expect(hints.has(f.jobId)).toBe(true);
    const outfile = sharedFixture('maintenance');
    const childHome = join(f.root, 'maintenance-home');
    mkdirSync(childHome);
    const published = execFileSync(process.execPath, [outfile, f.root, f.epoch.path, f.jobId], {
      env: { PATH: process.env.PATH, HOME: childHome, LANG: 'C.UTF-8', TMPDIR: f.root, CORAL_TEST_TIER: 'integration' },
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(JSON.parse(published)).toBe(f.resultPath);
    const events = [];
    for await (const event of addressing.waitStream({
      jobIds: [f.jobId],
      cursor: snapshot.cursor,
    }))
      events.push(event);
    expect(events).toEqual([
      { type: 'cursor', cursor: snapshot.cursor },
      expect.objectContaining({
        type: 'artifact',
        availability: { kind: 'available', resultPath: f.resultPath },
        remainingJobIds: [],
        exitCode: 0,
      }),
    ]);
  });
});

import { WaitSessionError } from '#src/jobs/wait/session.js';
it('HTTP sends a typed mid-stream error and canonicalizes the admission scope', async () => {
  const f = createTerminalExportFixture();
  cleanup.push(() => f.close());
  const alias = join(f.root, 'alias');
  symlinkSync(f.root, alias);
  const p = ports();
  const session = new WaitSession(['a']);
  session.reconcile([admitted('a', [], false)]);
  p.jobs.admitWait = vi.fn(() => session.admissions);
  p.jobs.validateWait = () => null;
  p.jobs.waitStream = async function* () {
    yield { type: 'waiting', waitingJobIds: ['a'], cursor: session.cursor(), exitCode: 75 };
    throw new WaitSessionError('wait_cursor_mismatch', 'Run coral-cli jobs detail a --full.');
  };
  const handler = createHttpHandler(p);
  const server = createServer((req, res) => void handler(req, res));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const body = await new Promise<string>((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: (server.address() as { port: number }).port,
        path: '/jobs/wait',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Coral-Backend-Token': 'http-token' },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk: Buffer) => {
          text += chunk.toString();
        });
        res.on('end', () => resolve(text));
        res.on('aborted', () => resolve(text));
        res.on('error', () => resolve(text));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ jobIds: ['a'], projectRoot: alias }));
  });
  expect(body).toContain('event: error');
  expect(body).toContain('wait_cursor_mismatch');
  expect(p.jobs.admitWait).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: f.root }));
});

it('an oversized IPC snapshot returns each unchanged subset command as a temporary refusal', async () => {
  const f = createTerminalExportFixture();
  cleanup.push(() => f.close());
  const p = ports();
  p.jobs.scopeCheck = () => ({ valid: ['a', 'b'], missing: [], mismatch: [] });
  p.jobs.snapshot = () => ({ padding: 'x'.repeat(2 * 1024 * 1024) }) as never;
  const listener = createIpcServer(p);
  cleanup.push(() => closeIpcServer(listener));
  const socketPath = join(f.root, 'oversized.sock');
  await new Promise<void>((resolve) => listener.server.listen(socketPath, resolve));
  const client = createIpcClient(socketPath, undefined, { kind: 'boot', token: 'boot-token' });
  const cursor = savedCursor({ a: 42 });
  await expect(
    client.request('jobs.wait.snapshot', { jobIds: ['a', 'b'], cursor, projectRoot: f.root }),
  ).rejects.toMatchObject({
    data: {
      code: 'wait_snapshot_too_large',
      message: expect.stringContaining(
        `coral-cli wait jobs 'a' --now --cursor ${serializeWaitCursor(cursor)}; coral-cli wait jobs 'b' --now --cursor ${serializeWaitCursor(cursor)}`,
      ),
    },
  });
});

it('refuses a released CLI wait request over IPC with the restart guidance', async () => {
  const f = createTerminalExportFixture();
  cleanup.push(() => f.close());
  const p = ports();
  p.jobs.scopeCheck = () => ({ valid: ['a'], missing: [], mismatch: [] });
  p.jobs.admitWait = vi.fn();
  const listener = createIpcServer(p);
  cleanup.push(() => closeIpcServer(listener));
  const socketPath = join(f.root, 'released.sock');
  await new Promise<void>((resolve) => listener.server.listen(socketPath, resolve));
  const client = createIpcClient(socketPath, undefined, { kind: 'boot', token: 'boot-token' });
  await expect(
    client.subscribe('jobs.wait', {
      jobIds: ['a'],
      projectRoot: f.root,
      timeoutSeconds: 1,
      supportsInterrupted: true,
      cursor: { afterSeq: 7 },
    }),
  ).rejects.toMatchObject({
    data: { code: 'wait_build_mismatch', message: expect.stringContaining('Restart the session') },
  });
  expect(p.jobs.admitWait).not.toHaveBeenCalled();
});
