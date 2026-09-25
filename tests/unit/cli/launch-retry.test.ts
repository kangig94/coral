import { afterEach, describe, expect, it, vi } from 'vitest';
import { retrySuccessionPausedLaunch } from '#src/cli/launch-retry.js';
import { IpcRpcError } from '#src/transport/ipc/client.js';

function paused(): IpcRpcError {
  return new IpcRpcError({
    code: -32000,
    message: 'Launch admission is paused during succession.',
    data: { code: 'succession_admission_paused' },
  });
}

describe('succession launch retry', () => {
  afterEach(() => vi.useRealTimers());

  it('should retry only the typed pause refusal and stay within its budget', async () => {
    vi.useFakeTimers();
    const issue = vi.fn().mockRejectedValueOnce(paused()).mockRejectedValueOnce(paused()).mockResolvedValue('accepted');
    const result = retrySuccessionPausedLaunch(issue, 250);
    await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toBe('accepted');
    expect(issue).toHaveBeenCalledTimes(3);
    expect(issue.mock.calls[2]?.[0]).toBeLessThanOrEqual(50);
  });

  it('should return the typed refusal when the retry budget is exhausted', async () => {
    vi.useFakeTimers();
    const issue = vi.fn().mockImplementation(async () => {
      throw paused();
    });
    const result = retrySuccessionPausedLaunch(issue, 150);
    const rejected = expect(result).rejects.toMatchObject({ code: 'succession_admission_paused' });
    await vi.advanceTimersByTimeAsync(150);
    await rejected;
    expect(issue).toHaveBeenCalledTimes(2);
  });

  it('should not retry an unrelated launch refusal', async () => {
    const error = new IpcRpcError({ code: -32000, message: 'busy', data: { code: 'busy' } });
    const issue = vi.fn().mockRejectedValue(error);
    await expect(retrySuccessionPausedLaunch(issue, 1_000)).rejects.toBe(error);
    expect(issue).toHaveBeenCalledTimes(1);
  });
});
