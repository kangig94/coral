import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchWithTransientRetry } from '#src/infra/http-retry.js';

const TRANSIENT_STATUSES = [408, 425, 429, 500, 502, 503, 504] as const;

function httpResponse(status: number, statusText = ''): Response {
  return { ok: status >= 200 && status < 300, status, statusText } as Response;
}

describe('infra http-retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should return the first ok response without retrying', async () => {
    const success = httpResponse(200, 'OK');
    const fetchMock = vi.fn().mockResolvedValue(success);
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWithTransientRetry('http://upstream.test/resource')).resolves.toBe(success);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should forward the request init to fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(httpResponse(200, 'OK'));
    vi.stubGlobal('fetch', fetchMock);
    const init: RequestInit = { method: 'POST', body: 'payload' };

    await fetchWithTransientRetry('http://upstream.test/resource', init);

    expect(fetchMock).toHaveBeenCalledWith('http://upstream.test/resource', init);
  });

  it.each([404, 401, 403, 410, 501])('should return a %i response without retrying', async (status) => {
    const failure = httpResponse(status);
    const fetchMock = vi.fn().mockResolvedValue(failure);
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWithTransientRetry('http://upstream.test/resource')).resolves.toBe(failure);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(TRANSIENT_STATUSES)('should retry a %i response and return the eventual success', async (status) => {
    const success = httpResponse(200, 'OK');
    const fetchMock = vi.fn().mockResolvedValueOnce(httpResponse(status)).mockResolvedValueOnce(success);
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithTransientRetry('http://upstream.test/resource');
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe(success);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should retry a network error and return the eventual success', async () => {
    const success = httpResponse(200, 'OK');
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('socket hang up')).mockResolvedValueOnce(success);
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithTransientRetry('http://upstream.test/resource');
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe(success);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should throw the last HTTP error after exhausting the retry limit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(httpResponse(503, 'Service Unavailable'));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithTransientRetry('http://upstream.test/resource');
    const settled = expect(promise).rejects.toThrow('503 Service Unavailable');
    await vi.runAllTimersAsync();

    await settled;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('should propagate the last network error after exhausting the retry limit', async () => {
    const lastError = new Error('connection refused');
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockRejectedValueOnce(lastError);
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithTransientRetry('http://upstream.test/resource');
    const settled = expect(promise).rejects.toBe(lastError);
    await vi.runAllTimersAsync();

    await settled;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('should wrap non-Error rejection values in an Error', async () => {
    const fetchMock = vi.fn().mockRejectedValue('boom');
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithTransientRetry('http://upstream.test/resource');
    const settled = expect(promise).rejects.toThrow(/^boom$/);
    await vi.runAllTimersAsync();

    await settled;
  });

  it('should back off exponentially: 1s before the second attempt, 2s before the third', async () => {
    const fetchMock = vi.fn().mockResolvedValue(httpResponse(503, 'Service Unavailable'));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithTransientRetry('http://upstream.test/resource');
    const settled = expect(promise).rejects.toThrow('503 Service Unavailable');

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await settled;
  });
});
