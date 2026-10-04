import { afterEach, expect, it, vi } from 'vitest';

import { serializeWaitCursor } from '#src/jobs/wait/cursor.js';
import { WaitInvocation } from '#src/cli/wait-invocation.js';
import { WaitSession } from '#src/jobs/wait/session.js';
import { admitted } from '#tests/helpers/wait-session.js';
import { followJobs } from '#src/cli/follow.js';
import { buildErrorEnvelope } from '#src/cli/errors.js';
import { IpcRequestTimeout } from '#src/transport/ipc/client.js';

afterEach(() => vi.restoreAllMocks());

it.each([undefined, serializeWaitCursor({ afterSeq: 42 })])(
  'preserves wait continuation after initial IPC exhaustion, cursor=%s',
  async (cursor) => {
    const emitError = vi.fn();
    const connect = vi.fn().mockRejectedValue(new IpcRequestTimeout('acknowledgement deadline exceeded'));
    const abortJobs = vi.fn();
    const code = await followJobs({
      start: { kind: 'jobs', jobIds: ['remaining-job'], serializedCursor: cursor },
      reconnectPolicy: 'bounded',
      projectRoot: '/project',
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      abortJobs,
      connect,
      backoffScheduler: async () => {},
      emitError,
    });
    expect(code).toBe(75);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(abortJobs).not.toHaveBeenCalled();
    const error = buildErrorEnvelope(emitError.mock.calls[0][0]);
    expect(error.envelope.code).toBe('transient');
    expect(error.envelope.remediation).toContain('coral-cli wait jobs remaining-job');
    if (cursor !== undefined) expect(error.envelope.remediation).toContain(`--cursor ${cursor}`);
  },
);

it('keeps authentication refusal distinct from timeout exhaustion', async () => {
  const emitError = vi.fn();
  const connect = vi.fn().mockRejectedValue(new Error('refused', { cause: { code: 'unauthorized' } }));
  await followJobs({
    start: { kind: 'jobs', jobIds: ['remaining-job'] },
    reconnectPolicy: 'bounded',
    projectRoot: '/project',
    render: { isTTY: false, columns: 80, embed: false, verbose: false },
    abortJobs: vi.fn(),
    connect,
    emitError,
  });
  expect(connect).toHaveBeenCalledOnce();
  expect(buildErrorEnvelope(emitError.mock.calls[0][0]).envelope.code).not.toBe('transient');
});

it('saves an exact continuation after a refused sibling disposition is delivered', async () => {
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string, callback?: () => void) => {
    callback?.();
    return true;
  }) as typeof process.stdout.write);
  const session = new WaitSession(['known', 'ghost']);
  session.reconcile([admitted('known', [], false), { jobId: 'ghost', disposition: 'missing' }]);
  const invocation = new WaitInvocation('bounded', ['node', 'coral-cli', 'wait', 'jobs', 'known', 'ghost']);
  const saved = vi.spyOn(invocation, 'saveContinuation');
  try {
    await followJobs({
      start: { kind: 'jobs', jobIds: ['known', 'ghost'] },
      reconnectPolicy: 'bounded',
      projectRoot: '/project',
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      invocation,
      emitError: vi.fn(),
      connect: async () => ({
        kind: 'subscription',
        subscription: {
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'disposition',
              version: 'jobs.wait.v3',
              jobId: 'ghost',
              disposition: 'missing',
              cursor: session.cursor(session.remaining()),
            };
            throw new Error('disconnected after the complete disposition');
          },
          close: async () => {},
        },
      }),
    });
    expect(saved).toHaveBeenCalled();
    expect(saved.mock.calls[0][0]).toContain('coral-cli wait jobs known --cursor jobs.wait.v3:');
    expect(saved.mock.calls[0][0]).not.toContain('ghost');
  } finally {
    invocation.dispose(true);
  }
});
