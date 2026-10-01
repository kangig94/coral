import { afterEach, expect, it, vi } from 'vitest';

import { observeProcessLiveness, probeProcessIncarnation } from '#src/infra/node-process.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { stopRecordedProcesses } from '#tests/support/stop-recorded-processes.js';

vi.mock('#src/infra/node-process.js', () => ({
  observeProcessLiveness: vi.fn(),
  probeProcessIncarnation: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it.each(['alive', 'unknown'] as const)(
  'rejects teardown when incarnation is null and liveness is %s',
  async (liveness) => {
    vi.mocked(probeProcessIncarnation).mockReturnValue(null);
    vi.mocked(observeProcessLiveness).mockReturnValue(liveness);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    await expect(stopRecordedProcesses([{ pid: 123, incarnation: testIncarnation(1) }], 'SIGKILL', 0)).rejects.toThrow(
      'Fixture process departure unproven after 0ms: 123',
    );
    expect(kill).not.toHaveBeenCalled();
  },
);

it('accepts a positively different incarnation without signalling the new process', async () => {
  vi.mocked(probeProcessIncarnation).mockReturnValue(testIncarnation(2));
  vi.mocked(observeProcessLiveness).mockReturnValue('alive');
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  await stopRecordedProcesses([{ pid: 123, incarnation: testIncarnation(1) }]);
  expect(kill).not.toHaveBeenCalled();
});

it('accepts proven absence even when no incarnation was recorded', async () => {
  vi.mocked(probeProcessIncarnation).mockReturnValue(null);
  vi.mocked(observeProcessLiveness).mockReturnValue('absent');
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  await stopRecordedProcesses([{ pid: 123, incarnation: null }]);
  expect(kill).not.toHaveBeenCalled();
});

it('retries a failed guarded signal and waits for proven departure', async () => {
  vi.mocked(probeProcessIncarnation).mockReturnValue(testIncarnation(1));
  vi.mocked(observeProcessLiveness).mockReturnValueOnce('alive').mockReturnValueOnce('alive').mockReturnValue('absent');
  const kill = vi
    .spyOn(process, 'kill')
    .mockImplementationOnce(() => {
      throw Object.assign(new Error('Signal unavailable'), { code: 'EIO' });
    })
    .mockReturnValue(true);
  await stopRecordedProcesses([{ pid: 123, incarnation: testIncarnation(1) }]);
  expect(kill).toHaveBeenCalledTimes(2);
  expect(kill).toHaveBeenCalledWith(123, 'SIGKILL');
});
