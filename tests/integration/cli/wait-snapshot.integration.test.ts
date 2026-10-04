import { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';
import { registerSessionCommands } from '#src/cli/commands/session.js';
import { createBuiltInProviderRegistry } from '#src/providers/bootstrap.js';
import * as dispatch from '#src/cli/dispatch.js';
import * as ensure from '#src/transport/ipc/ensure.js';
import { WaitInvocation, installWaitInvocation } from '#src/cli/wait-invocation.js';
import { WaitSession } from '#src/jobs/wait/session.js';
import { selectWaitSnapshot } from '#src/jobs/wait/snapshot.js';
import { admitted } from '#tests/helpers/wait-session.js';

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

it('refuses --now locally on an older coordinator without opening a subscription or sending snapshot', async () => {
  const request = vi.fn();
  const subscribe = vi.fn();
  vi.spyOn(ensure, 'ensure').mockResolvedValue({ jobsWaitExtensions: ['supportsWaitV2'], request, subscribe } as never);
  const p = program();
  const wait = p.commands.find((command) => command.name() === 'wait')!.commands[0];
  await expect(
    dispatch.makeClient(process.cwd(), wait).snapshotJobsWait({ jobIds: ['a'], projectRoot: process.cwd() }),
  ).rejects.toThrow('this coordinator predates --now; run coral-cli wait jobs a');
  expect(request).not.toHaveBeenCalled();
  expect(subscribe).not.toHaveBeenCalled();
});

it('commits only a complete validated snapshot, preserves --now, and cannot acknowledge a malformed response', async () => {
  const a = admitted('a', [[1, Array.from({ length: 501 }, (_, i) => `${i}`).join('\n')]]);
  const session = new WaitSession(['a']);
  session.reconcile([a]);
  const snapshot = selectWaitSnapshot(session);
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

it('maps an unknown snapshot method to the older-coordinator refusal', async () => {
  const request = vi.fn().mockRejectedValue(new Error('Method not found'));
  vi.spyOn(ensure, 'ensure').mockResolvedValue({ jobsWaitExtensions: ['supportsWaitV3'], request } as never);
  const p = program();
  const wait = p.commands.find((command) => command.name() === 'wait')!.commands[0];
  await expect(
    dispatch.makeClient(process.cwd(), wait).snapshotJobsWait({ jobIds: ['a'], projectRoot: process.cwd() }),
  ).rejects.toThrow('this coordinator predates --now; run coral-cli wait jobs a');
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
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    invocation = new WaitInvocation('snapshot', ['node', 'coral-cli', 'wait', 'jobs', 'a', '--now']);
    installWaitInvocation(invocation);
    const save = vi.spyOn(invocation, 'saveContinuation');
    await program().parseAsync(['node', 'coral-cli', 'wait', 'jobs', 'a', '--now']);
    expect(save).not.toHaveBeenCalled();
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
