import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BackendHandle } from '../backend-lifecycle.js';
import { BackendClient, BackendToolHttpError, type CallerContext } from '../http-client.js';

const backendHandle: BackendHandle = {
  port: 4100,
  host: '127.0.0.1',
  token: 'backend-token',
  instanceId: 'backend-instance',
};

const defaultContext: CallerContext = {
  projectRoot: '/tmp/project',
  pluginRoot: '/tmp/plugin',
  coralEnv: {},
};

describe('client http-client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('preserves structured JSON error bodies from /tool failures', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });
    const errorBody = { error: 'scope_mismatch', jobs: ['job-1'] };

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(errorBody), {
      status: 403,
      statusText: 'Forbidden',
      headers: { 'Content-Type': 'application/json' },
    }));

    let caught: unknown;
    try {
      await client.abortJobs(['job-1']);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BackendToolHttpError);
    expect((caught as BackendToolHttpError).message).toBe('Backend request failed: 403 Forbidden');
    expect((caught as BackendToolHttpError).statusCode).toBe(403);
    expect((caught as BackendToolHttpError).body).toEqual(errorBody);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4100/tool', expect.objectContaining({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': 'backend-token',
      },
      body: JSON.stringify({
        name: 'abort',
        args: { jobs: ['job-1'] },
        context: defaultContext,
      }),
    }));
  });
});
