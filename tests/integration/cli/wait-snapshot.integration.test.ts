import { WAIT_CURSOR_REPLAY_NOTICE } from '#src/jobs/wait/cursor.js';
import { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';
import { registerSessionCommands } from '#src/cli/commands/session.js';
import { createBuiltInProviderRegistry } from '#src/providers/bootstrap.js';
import * as dispatch from '#src/cli/dispatch.js';
import * as ensure from '#src/transport/ipc/ensure.js';
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

it('commits only a complete validated snapshot, preserves --now, and cannot acknowledge a malformed response', async () => {
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
  invocation = new WaitInvocation('snapshot', ['node', 'coral-cli', 'wait', 'jobs', 'a', '--now']);
  installWaitInvocation(invocation);
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
  expect(output).toContain(WAIT_CURSOR_REPLAY_NOTICE);
  expect(output).toContain(' --now --cursor ');
  expect(process.exitCode).toBe(75);
  client.snapshotJobsWait.mockResolvedValue({ ...snapshot, jobs: [{ jobId: 'a' }] });
  let errorOutput = '';
  vi.spyOn(process.stderr, 'write').mockImplementation(((text: string) => {
    errorOutput += text;
    return true;
  }) as never);
  await program().parseAsync(['node', 'coral-cli', 'wait', 'jobs', 'a', '--now']);
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
