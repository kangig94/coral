import { WAIT_CURSOR_REPLAY_NOTICE } from '#src/jobs/wait/cursor.js';
import { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';
import { registerSessionCommands } from '#src/cli/commands/session.js';
import { createBuiltInProviderRegistry } from '#src/providers/bootstrap.js';
import * as dispatch from '#src/cli/dispatch.js';
import * as ensure from '#src/transport/ipc/ensure.js';
import { IpcRpcError } from '#src/transport/ipc/client.js';
import { WAIT_BUILD_MISMATCH } from '#src/transport/rpc/jobs.js';
import type { WaitStreamEvent } from '#src/jobs/wait/contract.js';
import { WaitInvocation, installWaitInvocation } from '#src/cli/wait-invocation.js';
import { selectWaitSnapshot } from '#tests/helpers/wait-progress.js';
import { admitted, savedCursor, testSession } from '#tests/helpers/wait-session.js';

let invocation: WaitInvocation | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  invocation?.dispose(true);
  invocation = undefined;
  installWaitInvocation(undefined);
  process.exitCode = 0;
});
function program() {
  const p = new Command();
  registerSessionCommands(p, createBuiltInProviderRegistry());
  return p;
}

function subscribeEvents(...events: (WaitStreamEvent | { type: 'handover' })[]) {
  return {
    close: async () => {},
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}

function terminal(jobId: string, code: number, remainingJobIds: string[] = []): WaitStreamEvent {
  return {
    type: 'terminal',
    jobId,
    seq: 7,
    remainingJobIds,
    result: {
      content: '',
      outcome: code === 0 ? { kind: 'completed' } : { kind: 'provider_exit', code },
      durationMs: 1,
    },
    availability: { kind: 'failed', reason: 'missing' },
    cursor: '7',
    exitCode: code,
  };
}

it.each([42, 1])(
  'preserves a collected --all exit of %s after interrupting and executing the printed continuation',
  async (code) => {
    const collected =
      code === 42
        ? subscribeEvents(terminal('a', 42, ['b']))
        : subscribeEvents(
            { type: 'disposition', jobId: 'a', disposition: 'missing' },
            { type: 'waiting', waitingJobIds: ['b'], cursor: '7', exitCode: 1, endedBy: 'deadline' },
          );
    const subscribeJobsWait = vi
      .fn()
      .mockResolvedValueOnce(collected)
      .mockImplementationOnce(() => {
        process.listeners('SIGTERM').at(-1)!('SIGTERM');
        return new Promise<never>(() => {});
      })
      .mockResolvedValueOnce(subscribeEvents(terminal('b', 0)));
    vi.spyOn(dispatch, 'makeClient').mockReturnValue({ subscribeJobsWait } as never);
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string, cb?: () => void) => {
      output += chunk;
      cb?.();
      return true;
    }) as typeof process.stdout.write);
    const argv = ['node', 'coral-cli', 'jobs', 'wait', 'a', 'b', '--all'];
    invocation = new WaitInvocation('stream', argv);
    installWaitInvocation(invocation);
    await program().parseAsync(argv);
    expect(process.exitCode).toBe(75);
    expect(subscribeJobsWait).toHaveBeenCalledTimes(2);
    const continuation = /Run coral-cli (jobs wait b --all .*--cursor 7) to continue waiting\./.exec(output)?.[1];
    expect(continuation).toContain(`--all-outcome ${code === 42 ? '42:0' : 'refused'}`);
    invocation.dispose(true);
    installWaitInvocation(undefined);
    await program().parseAsync(continuation!.split(' '), { from: 'user' });
    expect(output).toContain('Job b completed');
    expect(process.exitCode).toBe(code);
  },
);

it('returns a prior refusal when a later subscription in the same --all invocation succeeds', async () => {
  const subscribeJobsWait = vi
    .fn()
    .mockResolvedValueOnce(
      subscribeEvents(
        { type: 'disposition', jobId: 'a', disposition: 'missing' },
        { type: 'waiting', waitingJobIds: ['b'], cursor: '7', exitCode: 1, endedBy: 'deadline' },
      ),
    )
    .mockResolvedValueOnce(subscribeEvents(terminal('b', 0)));
  vi.spyOn(dispatch, 'makeClient').mockReturnValue({ subscribeJobsWait } as never);
  vi.spyOn(process.stdout, 'write').mockImplementation(((_chunk: unknown, cb?: () => void) => {
    cb?.();
    return true;
  }) as typeof process.stdout.write);
  await program().parseAsync(['jobs', 'wait', 'a', 'b', '--all'], { from: 'user' });
  expect(subscribeJobsWait).toHaveBeenCalledTimes(2);
  expect(process.exitCode).toBe(1);
});

it.each([false, true])('checks the serving coordinator wait contract, handover=%s', async (handover) => {
  const legacySubscribe = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    if ('waitRpcVersion' in params)
      throw new IpcRpcError({ code: -32000, message: WAIT_BUILD_MISMATCH.message, data: WAIT_BUILD_MISMATCH });
    return subscribeEvents(terminal('a', 0));
  });
  const ensureCoordinator = vi.spyOn(ensure, 'ensure');
  if (handover) {
    const subscribe = vi.fn().mockResolvedValue(subscribeEvents({ type: 'cursor', cursor: '5' }, { type: 'handover' }));
    ensureCoordinator.mockResolvedValueOnce({ subscribe } as never);
  }
  ensureCoordinator.mockResolvedValue({ subscribe: legacySubscribe } as never);
  let output = '';
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    output += chunk;
    return true;
  }) as typeof process.stderr.write);
  const argv = ['node', 'coral-cli', 'jobs', 'wait', 'a'];
  invocation = new WaitInvocation('stream', argv);
  installWaitInvocation(invocation);
  await program().parseAsync(argv);
  expect(legacySubscribe).toHaveBeenCalledOnce();
  expect(legacySubscribe.mock.calls[0]).toMatchObject([
    'jobs.wait',
    { waitRpcVersion: 2, ...(handover ? { cursor: '5' } : {}) },
    expect.any(Object),
  ]);
  expect(output).toContain('wait_build_mismatch');
  expect(output).toMatch(/restart the session/i);
  expect(process.exitCode).toBe(1);
});

it('commits only a complete validated snapshot, preserves --snapshot, and cannot acknowledge a malformed response', async () => {
  const a = admitted('a', [[1, Array.from({ length: 501 }, (_, i) => `${i}`).join('\n')]], false);
  const session = testSession(['a'], savedCursor(0));
  session.reconcile([a]);
  const snapshot = selectWaitSnapshot(session, 501);
  const client = { snapshotJobsWait: vi.fn().mockResolvedValue(snapshot) };
  vi.spyOn(dispatch, 'makeClient').mockReturnValue(client as never);
  let output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string, callback?: (error?: Error) => void) => {
    output += text;
    callback?.();
    return true;
  }) as never);
  invocation = new WaitInvocation('snapshot', ['node', 'coral-cli', 'jobs', 'wait', 'a', '--snapshot']);
  installWaitInvocation(invocation);
  await program().parseAsync([
    'node',
    'coral-cli',
    'jobs',
    'wait',
    'a',
    '--snapshot',
    '--cursor',
    Buffer.from(JSON.stringify({ afterSeq: 0 })).toString('base64url'),
  ]);
  expect(output).toContain(WAIT_CURSOR_REPLAY_NOTICE);
  expect(output).toContain(' --snapshot --cursor ');
  expect(process.exitCode).toBe(75);
  client.snapshotJobsWait.mockResolvedValue({ ...snapshot, jobs: [{ jobId: 'a' }] });
  let errorOutput = '';
  vi.spyOn(process.stderr, 'write').mockImplementation(((text: string) => {
    errorOutput += text;
    return true;
  }) as never);
  await program().parseAsync(['node', 'coral-cli', 'jobs', 'wait', 'a', '--snapshot']);
  expect(process.exitCode).toBe(75);
  expect(errorOutput).toContain('transient');
  expect(errorOutput).toContain('invalid snapshot');
  expect(errorOutput).toContain('No collection cursor advanced');
  expect(errorOutput).toContain('Run coral-cli jobs wait a --snapshot');
});

it('answers an older coordinator without the snapshot method with the restart refusal', async () => {
  const request = vi.fn().mockRejectedValue(new Error('Method not found'));
  vi.spyOn(ensure, 'ensure').mockResolvedValue({ request } as never);
  const p = program();
  const wait = p.commands
    .find((command) => command.name() === 'jobs')!
    .commands.find((command) => command.name() === 'wait')!;
  await expect(
    dispatch.makeClient(process.cwd(), wait).snapshotJobsWait({ jobIds: ['a'], projectRoot: process.cwd() }),
  ).rejects.toMatchObject({
    code: 'wait_build_mismatch',
    exitCode: 1,
    remediation: expect.stringContaining('Restart the session'),
  });
});

it('requires the snapshot contract marker at the coordinator request boundary', async () => {
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    if ('waitRpcVersion' in params) throw new IpcRpcError({ code: -32602, message: 'Invalid params' });
    return selectWaitSnapshot(testSession(['a']));
  });
  vi.spyOn(ensure, 'ensure').mockResolvedValue({ request } as never);
  let output = '';
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    output += chunk;
    return true;
  }) as typeof process.stderr.write);
  await program().parseAsync(['jobs', 'wait', 'a', '--snapshot'], { from: 'user' });
  expect(request).toHaveBeenCalledExactlyOnceWith(
    'jobs.wait.snapshot',
    expect.objectContaining({ jobIds: ['a'], waitRpcVersion: 2 }),
    expect.any(Object),
  );
  expect(output).toContain('wait_build_mismatch');
  expect(output).toMatch(/restart the session/i);
  expect(process.exitCode).toBe(1);
});
