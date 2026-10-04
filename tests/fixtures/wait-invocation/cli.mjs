import { runCli } from '#src/cli/run.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { getWaitInvocation } from '#src/cli/wait-invocation.js';
import { IpcRequestTimeout } from '#src/transport/ipc/client.js';
import { dirname } from 'node:path';

const scenario = process.env.WAIT_PROBE_SCENARIO;
const delegated = process.env.CORAL_CLI_HANDOFF_DELEGATED === '1';
const never = new Promise(() => {});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (delegated && scenario === 'late-child-output') {
  process.on('message', (message) => {
    if (message?.type === 'wait-cancel') setTimeout(() => process.stdout.write('late child output\n'), 50);
  });
}
const cursor = { version: 'jobs.wait.v2', locations: { a: 'epoch' }, positions: { epoch: 42 }, deliveredJobIds: [] };
const timing = { origin: 'runtime', originAt: '2026-10-04T00:00:00Z', emittedAt: '2026-10-04T00:00:00Z', elapsedMs: 0 };

globalThis.waitProbe = {
  async routing() {
    if (scenario === 'routing') return never;
    if (!delegated && scenario === 'late-delegation') await pause(250);
    const runtime = createRealRuntime('prod', { baseDir: process.env.HOME });
    return {
      runtime,
      time: runtime.time,
      routing:
        !delegated &&
        [
          'delegation',
          'delegated-delivery',
          'late-child-output',
          'late-delegation',
          'ignores-cancel',
          'old-target',
          'old-hanging-target',
          'delegated-sync',
          'delegated-sync-delivery',
        ].includes(scenario)
          ? { kind: 'handoff', source: 'active-selection', target: {} }
          : { kind: 'continue-current', basis: { kind: 'incumbent-absent' } },
    };
  },
  execution: {
    manifest: { version: '0.10.18', buildSetId: 'probe', bundleHash: 'probe', flavor: 'prod' },
    bundleDir: dirname(process.env.WAIT_PROBE_TARGET),
    assertExecutable() {},
  },
  async publication(transition) {
    const phase = transition.kind === 'routing-selected' ? 'selection' : 'terminal';
    if (scenario === phase || (delegated && scenario === 'delegation')) return never;
    if ((scenario === 'sync' || (delegated && scenario === 'delegated-sync')) && phase === 'selection') {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 850);
    }
    return { kind: 'committed', sequence: 1 };
  },
  async ensure() {
    process.stderr.write(`HANDLER_BUDGET:${getWaitInvocation()?.remainingMs()}\n`);
    if (scenario === 'bootstrap') return never;
    if (delegated && scenario === 'ignores-cancel') {
      for (const handler of process.listeners('message')) process.off('message', handler);
      process.on('SIGTERM', () => {});
      return never;
    }
    return {
      jobsWaitExtensions: ['supportsWaitV2', 'supportsHandover', 'supportsInterrupted', ...(process.env.WAIT_PROBE_MODE === 'snapshot' ? ['supportsWaitV3'] : [])],
      async subscribe(method, params) {
        if (scenario === 'opening') return never;
        if (scenario === 'backoff') throw new IpcRequestTimeout('probe retry');
        return {
          async close() {
            if (scenario === 'close') return never;
          },
          async *[Symbol.asyncIterator]() {
            if (
              [
                'delivery',
                'delegated-delivery',
                'late-child-output',
                'late-delegation',
                'close',
                'sync-delivery',
                'delegated-sync-delivery',
              ].includes(scenario)
            ) {
              yield {
                type: 'progress',
                jobId: 'a',
                seq: 42,
                message: 'confirmed delivery',
                timing,
                version: 'jobs.wait.v2',
                epochKey: 'epoch',
                cursor,
              };
            }
            if (scenario === 'sync-delivery' || (delegated && scenario === 'delegated-sync-delivery')) {
              await pause(20);
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 850);
            }
            if (scenario === 'close') {
              yield { type: 'waiting', waitingJobIds: ['a'], cursor, carrierUnknownJobIds: ['a'] };
              return;
            }
            await never;
          },
        };
      },
      async request(method) {
        if (method === 'jobs.wait.snapshot') return never;
        process.stderr.write('ABORT CALLED\n');
        throw new Error('ABORT MUST NOT RUN');
      },
    };
  },
};

if (process.argv[2] !== '--print-wait-invocation-contract') setInterval(() => {}, 10_000);
await runCli();
