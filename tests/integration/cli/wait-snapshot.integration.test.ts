import { WAIT_CURSOR_REPLAY_NOTICE } from '#src/jobs/wait/cursor.js';
import { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';
import { registerSessionCommands } from '#src/cli/commands/session.js';
import { createBuiltInProviderRegistry } from '#src/providers/bootstrap.js';
import * as dispatch from '#src/cli/dispatch.js';
import * as ensure from '#src/transport/ipc/ensure.js';
import { IpcLifecycleRefusal } from '#src/transport/ipc/client.js';
import { WaitInvocation, installWaitInvocation } from '#src/cli/wait-invocation.js';
import { WaitSession } from '#src/jobs/wait/session.js';
import { selectWaitSnapshot, prefixCursor } from '#tests/helpers/wait-progress.js';
import { admitted, savedCursor } from '#tests/helpers/wait-session.js';

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

it('commits only a complete validated snapshot, preserves --now, and cannot acknowledge a malformed response', async () => {
  const a = admitted('a', [[1, Array.from({ length: 501 }, (_, i) => `${i}`).join('\n')]]);
  const session = new WaitSession(['a'], prefixCursor([a]));
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
  invocation = new WaitInvocation('snapshot', ['node', 'coral-cli', 'wait', 'jobs', 'a', '--now']);
  installWaitInvocation(invocation);
  const save = vi.spyOn(invocation, 'saveContinuation');
  await program().parseAsync([
    'node',
    'coral-cli',
    'wait',
    'jobs',
    'a',
    '--now',
    '--cursor',
    Buffer.from(JSON.stringify({ afterSeq: 0 })).toString('base64url'),
  ]);
  expect(save).toHaveBeenCalledOnce();
  expect(output).toContain(' --now --cursor ');
  expect(process.exitCode).toBe(75);
  save.mockClear();
  client.snapshotJobsWait.mockResolvedValue({ ...snapshot, jobs: [{ jobId: 'a' }] });
  let errorOutput = '';
  vi.spyOn(process.stderr, 'write').mockImplementation(((text: string) => {
    errorOutput += text;
    return true;
  }) as never);
  await program().parseAsync(['node', 'coral-cli', 'wait', 'jobs', 'a', '--now']);
  expect(save).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(75);
  expect(errorOutput).toContain('transient');
  expect(errorOutput).toContain('invalid snapshot');
  expect(errorOutput).toContain('No collection cursor advanced');
  expect(errorOutput).toContain('Run coral-cli wait jobs a --now');
});

it('answers an older coordinator without the snapshot method with the restart refusal', async () => {
  const request = vi.fn().mockRejectedValue(new Error('Method not found'));
  vi.spyOn(ensure, 'ensure').mockResolvedValue({ request } as never);
  const p = program();
  const wait = p.commands.find((command) => command.name() === 'wait')!.commands[0];
  await expect(
    dispatch.makeClient(process.cwd(), wait).snapshotJobsWait({ jobIds: ['a'], projectRoot: process.cwd() }),
  ).rejects.toMatchObject({
    code: 'wait_build_mismatch',
    exitCode: 1,
    remediation: expect.stringContaining('Restart the session'),
  });
});

it.each(['refusal', 'disconnect', 'output failure'])(
  'a snapshot %s preserves the last delivered collection cursor',
  async (failure) => {
    const session = new WaitSession(['a']);
    session.reconcile([admitted('a')]);
    const response = selectWaitSnapshot(session);
    vi.spyOn(dispatch, 'makeClient').mockReturnValue({
      snapshotJobsWait:
        failure === 'output failure'
          ? async () => response
          : async () => {
              throw new Error(failure, { cause: { code: 'wait_snapshot_too_large', message: failure } });
            },
    } as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(((text: string, callback?: (error?: Error) => void) => {
      callback?.(new Error('write failed'));
      return false;
    }) as never);
    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((text: string) => {
      stderr += text;
      return true;
    }) as never);
    invocation = new WaitInvocation('snapshot', ['node', 'coral-cli', 'wait', 'jobs', 'a', '--now']);
    installWaitInvocation(invocation);
    const save = vi.spyOn(invocation, 'saveContinuation');
    await program().parseAsync(['node', 'coral-cli', 'wait', 'jobs', 'a', '--now']);
    expect(save).not.toHaveBeenCalled();
    if (failure === 'output failure') {
      expect(process.exitCode).toBe(75);
      expect(stderr).toContain('transient');
      expect(stderr).toContain(`Run ${invocation.originalCommand}`);
    }
  },
);

it.each(['shape', 'membership'])(
  'invalid snapshot %s prints the unchanged original command as transient remediation',
  async (failure) => {
    const session = new WaitSession(['a']);
    session.reconcile([admitted('a')]);
    const snapshot = selectWaitSnapshot(session);
    const response = failure === 'shape' ? { ...snapshot, cursor: {} } : { ...snapshot, jobs: [] };
    vi.spyOn(dispatch, 'makeClient').mockReturnValue({ snapshotJobsWait: async () => response } as never);
    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((text: string) => {
      stderr += text;
      return true;
    }) as never);
    const argv = ['node', 'coral-cli', 'wait', 'jobs', '--lines', '5', 'a', '--now'];
    invocation = new WaitInvocation('snapshot', argv);
    installWaitInvocation(invocation);
    const save = vi.spyOn(invocation, 'saveContinuation');
    await program().parseAsync(argv);
    expect(process.exitCode).toBe(75);
    expect(stderr).toContain('transient');
    expect(stderr).toContain('No collection cursor advanced');
    expect(stderr).toContain(`Run ${invocation.originalCommand}`);
    expect(save).not.toHaveBeenCalled();
  },
);

it('uses the successor retry path for snapshot reads while preserving their request cursor', async () => {
  const cursor = savedCursor({ a: 42 });
  const refusal = new IpcLifecycleRefusal('/tmp/isolated-snapshot.sock', 'jobs.wait.snapshot');
  const request = vi.fn().mockRejectedValue(refusal);
  const successorRequest = vi.fn().mockResolvedValue('snapshot');
  const incumbent = { request };
  const successor = { request: successorRequest };
  vi.spyOn(ensure, 'ensure').mockResolvedValue(incumbent as never);
  vi.spyOn(ensure, 'issueWithSuccessorAfterLifecycleRefusal').mockImplementation(async (_method, _root, issue) => {
    await expect(issue(incumbent as never)).rejects.toBe(refusal);
    return issue(successor as never) as never;
  });
  const p = program();
  const wait = p.commands.find((command) => command.name() === 'wait')!.commands[0];
  expect(await dispatch.makeClient(process.cwd(), wait).snapshotJobsWait({ jobIds: ['a'], cursor })).toBe('snapshot');
  expect(request).toHaveBeenCalledExactlyOnceWith(
    'jobs.wait.snapshot',
    expect.objectContaining({ cursor }),
    expect.anything(),
  );
  expect(successorRequest).toHaveBeenCalledExactlyOnceWith(
    'jobs.wait.snapshot',
    expect.objectContaining({ cursor }),
    expect.anything(),
  );
});

it('describes a reset snapshot cursor as a latest progress tail', async () => {
  const session = new WaitSession(['a']);
  session.reconcile([
    admitted(
      'a',
      Array.from({ length: 30 }, (_, i) => [i + 1, `line-${i}`]),
      false,
    ),
  ]);
  vi.spyOn(dispatch, 'makeClient').mockReturnValue({
    snapshotJobsWait: async () => selectWaitSnapshot(session),
  } as never);
  let output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string, callback?: (error?: Error) => void) => {
    output += text;
    callback?.();
    return true;
  }) as never);
  await program().parseAsync(['node', 'coral-cli', 'wait', 'jobs', 'a', '--now', '--cursor', 'malformed']);
  expect(output).toContain('This snapshot shows the latest progress tail');
  expect(output).toContain(WAIT_CURSOR_REPLAY_NOTICE);
  expect(output).toContain('current progress tail');
  expect(output).toContain('line-29');
});
