import type { FailureDomainRoot } from '#src/infra/failure-domain.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import {
  recordDurableCliExecution,
  markDurableCliExecutionEntered,
  readDurableCliExecutionReceipt,
} from '#src/jobs/durable-cli-execution.js';

const io = vi.hoisted(() => ({
  spawn: vi.fn(),
  create: vi.fn(),
  order: [] as string[],
  root: { kind: 'placed', root: '/inherited' } as FailureDomainRoot,
}));
vi.mock('node:child_process', async (original) => ({ ...(await original<object>()), spawn: io.spawn }));
vi.mock('#src/infra/failure-domain.js', async (original) => ({
  ...(await original<object>()),
  inheritedFailureDomainRoot: () => io.root,
  createFailureDomain: io.create,
}));
vi.mock('#src/infra/node-process.js', async (original) => ({
  ...(await original<object>()),
  probeProcessIncarnation: () => wrapperIncarnation,
}));
import { createRealRuntime } from '#src/runtime/real.js';
const wrapperIncarnation = testIncarnation(42);
const dirs: string[] = [];
afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { force: true, recursive: true });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it.each([
  'entered',
  'refused-entry',
  'unknown-root',
  'mkdir-then-refused',
  'planned-write-failed',
  'entered-write-failed',
] as const)('keeps startup available with %s evidence', async (mode) => {
  const failReceipt = mode === 'planned-write-failed';
  io.root = mode === 'unknown-root' ? { kind: 'unknown', reason: 'EACCES' } : { kind: 'placed', root: '/inherited' };
  const created = mode !== 'unknown-root' && mode !== 'mkdir-then-refused';
  const reportedEntry = mode === 'entered' || mode === 'entered-write-failed';
  const jobDir = mkdtempSync(join(tmpdir(), 'coral-job-placement-'));
  dirs.push(jobDir);
  const db = newRawDatabase(':memory:');
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  if (failReceipt)
    db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON meta BEGIN SELECT RAISE(ABORT, 'receipt write failed'); END");
  if (mode === 'entered-write-failed')
    db.exec("CREATE TRIGGER fail_entered BEFORE UPDATE ON meta BEGIN SELECT RAISE(ABORT, 'entered write failed'); END");
  vi.stubEnv('CORAL_FAILURE_DOMAIN_ROOT', '/ambient');
  vi.stubEnv('CORAL_FAILURE_DOMAIN', '/ambient/coordinator');
  io.order.length = 0;
  io.create.mockImplementation(() => {
    io.order.push('create');
    return created ? { kind: 'created', path: '/inherited/job-test-1' } : { kind: 'refused', errno: 'EACCES' };
  });
  let publication: unknown;
  io.spawn.mockImplementation((_command, _args, options: { env: NodeJS.ProcessEnv }) => {
    expect(options.env.CORAL_FAILURE_DOMAIN_ROOT).toBeUndefined();
    expect(options.env.CORAL_FAILURE_DOMAIN).toBeUndefined();
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      stdin: null,
      stdout,
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
      unref: () => {},
      send: (message: unknown, callback: (error: Error | null) => void) => {
        publication = message;
        io.order.push('release');
        callback(null);
        if (reportedEntry) child.emit('message', { kind: 'durable-payload-entered' });
        stdout.write(
          JSON.stringify({
            type: 'runtime',
            runtimeRecord: {
              transport: 'durable-cli',
              pid: 42,
              stdoutPath: `${jobDir}/stdout`,
              stderrPath: `${jobDir}/stderr`,
              startTime: 'now',
            },
            leaderIncarnation: wrapperIncarnation,
            childRoot: { pid: 43, incarnation: testIncarnation(1) },
          }) + '\n',
        );
      },
    });
    return child;
  });
  try {
    const runtime = createRealRuntime('prod', { baseDir: jobDir });
    const launch = await runtime.process.durable.launch({
      provider: 'test',
      command: 'fake-cli',
      args: [],
      jobDir,
      failureDomainName: 'job-test-1',
      onWrapperEntered: () => {
        io.order.push('entered');
        markDurableCliExecutionEntered(db, { jobId: 'test', execution: 1, pid: 42, incarnation: wrapperIncarnation });
      },
      onWrapperIdentified: ({ pid, leaderIncarnation }) => {
        io.order.push('receipt');
        try {
          recordDurableCliExecution(db, { jobId: 'test', execution: 1, pid, incarnation: leaderIncarnation });
          return true;
        } catch {
          return false;
        }
      },
    });
    expect(launch.disposition).toBe('launched');
    expect(io.order).toEqual(
      failReceipt ? ['receipt', 'release'] : ['receipt', 'create', 'release', ...(reportedEntry ? ['entered'] : [])],
    );
    expect(
      readDurableCliExecutionReceipt(db, 'test', { pid: 42, incarnation: wrapperIncarnation })?.phase ?? null,
    ).toBe(failReceipt ? null : mode === 'entered' ? 'entered' : 'planned');
    expect(io.create).toHaveBeenCalledTimes(failReceipt ? 0 : 1);
    expect(publication).toEqual({
      kind: 'runtime-start-published',
      failureDomain: failReceipt || !created ? null : { root: '/inherited', path: '/inherited/job-test-1' },
    });
  } finally {
    db.close();
  }
});
