import { afterEach, expect, it, vi } from 'vitest';

import { savedCursor } from '#tests/helpers/wait-session.js';
import { followJobs } from '#src/cli/follow.js';
import { buildErrorEnvelope } from '#src/cli/errors.js';
import { IpcRequestTimeout } from '#src/transport/ipc/client.js';

afterEach(() => vi.restoreAllMocks());

it.each([undefined, savedCursor(42)])(
  'preserves wait continuation after initial IPC exhaustion, cursor=%s',
  async (cursor) => {
    const emitError = vi.fn();
    const connect = vi.fn().mockRejectedValue(new IpcRequestTimeout('acknowledgement deadline exceeded'));
    const code = await followJobs({
      start: { kind: 'jobs', jobIds: ['remaining-job'], serializedCursor: cursor },
      reconnectPolicy: 'bounded',
      projectRoot: '/project',
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      connect,
      backoffScheduler: async () => {},
      emitError,
    });
    expect(code).toBe(75);
    expect(connect).toHaveBeenCalledTimes(3);
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
    connect,
    emitError,
  });
  expect(connect).toHaveBeenCalledOnce();
  expect(buildErrorEnvelope(emitError.mock.calls[0][0]).envelope.code).not.toBe('transient');
});
