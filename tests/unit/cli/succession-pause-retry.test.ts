import { afterEach, describe, expect, it, vi } from 'vitest';
import { retrySuccessionPausedRequest } from '#src/cli/succession-pause-retry.js';
import { IpcRpcError } from '#src/transport/ipc/client.js';

function paused(): IpcRpcError {
  return new IpcRpcError({
    code: -32000,
    message: 'Succession commit is temporarily pausing cancellation.',
    data: { code: 'succession_admission_paused' },
  });
}

describe('succession pause retry', () => {
  afterEach(() => vi.useRealTimers());

  it('retries a paused cancellation within its request budget', async () => {
    vi.useFakeTimers();
    const answer = { aborted: ['job-1'], notFound: [] };
    const issue = vi.fn().mockRejectedValueOnce(paused()).mockRejectedValueOnce(paused()).mockResolvedValue(answer);
    const result = retrySuccessionPausedRequest(issue, 250);
    await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toBe(answer);
    expect(issue).toHaveBeenCalledTimes(3);
    expect(issue.mock.calls[2]?.[0]).toBeLessThanOrEqual(50);
  });

  it('should return the typed refusal when the retry budget is exhausted', async () => {
    vi.useFakeTimers();
    const issue = vi.fn().mockImplementation(async () => {
      throw paused();
    });
    const result = retrySuccessionPausedRequest(issue, 150);
    const rejected = expect(result).rejects.toMatchObject({ code: 'succession_admission_paused' });
    await vi.advanceTimersByTimeAsync(150);
    await rejected;
    expect(issue).toHaveBeenCalledTimes(2);
  });

  it('does not retry an unrelated refusal', async () => {
    const error = new IpcRpcError({ code: -32000, message: 'busy', data: { code: 'busy' } });
    const issue = vi.fn().mockRejectedValue(error);
    await expect(retrySuccessionPausedRequest(issue, 1_000)).rejects.toBe(error);
    expect(issue).toHaveBeenCalledTimes(1);
  });
});
