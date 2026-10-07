import { progressVisitFromDetails } from '#tests/helpers/wait-progress.js';
import { Command } from 'commander';
import { registerSessionCommands } from '#src/cli/commands/session.js';
import { createBuiltInProviderRegistry } from '#src/providers/bootstrap.js';
import * as dispatch from '#src/cli/dispatch.js';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIpcServer, closeIpcServer } from '#src/transport/ipc/server.js';
import { createIpcClient } from '#src/transport/ipc/client.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { seedHistoricalEpoch, historicalSourceReader } from '#src/jobs/historical-reader.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';
import { initTestJob } from '#tests/helpers/session.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { deriveLaunchReadiness } from '#src/jobs/launch-readiness.js';
import { parseWaitSnapshot } from '#src/jobs/wait/snapshot.js';
import { formatWaitSnapshot } from '#src/cli/format/wait.js';
import { renderJobsOperatorCommand } from '#src/cli/format/jobs.js';
import type { WaitSnapshot } from '#src/jobs/wait/session.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import { parseWaitStreamEventValue } from '#src/jobs/wait/stream-event.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

function ports(addressing: JobAddressing): HttpHandlerPorts {
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
    jobs: {
      scopeCheck: addressing.scopeCheck.bind(addressing),
      admitWait: addressing.admitWait.bind(addressing),
      snapshot: addressing.snapshot.bind(addressing),
      waitStream: addressing.waitStream.bind(addressing),
      detail: addressing.detail.bind(addressing),
      unknownJobDisposition: addressing.unknownJobDisposition.bind(addressing),
      waitHandoverSignal: () => new AbortController().signal,
    },
  } as never;
}

describe('actual wait carriage', () => {
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
    const stream = await client.subscribe('jobs.wait', { jobIds: [ids[0]], projectRoot: f.root, cursor: null });
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
  }, 30000);
});
