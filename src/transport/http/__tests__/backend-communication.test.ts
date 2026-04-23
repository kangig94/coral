import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackendToolHttpError } from '../client-errors.js';
import { throwBackendCommunicationError } from '../backend-communication.js';
import { streamWait } from '../wait-stream.js';
import { BackendUnreachableError } from '../../../infra/http-errors.js';

const mockState = vi.hoisted(() => ({
  createIpcClient: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock('../../ipc/client.js', () => ({
  createIpcClient: mockState.createIpcClient,
}));

describe('transport/http backend communication', () => {
  beforeEach(() => {
    mockState.createIpcClient.mockReset();
    mockState.subscribe.mockReset();
    mockState.createIpcClient.mockReturnValue({
      socketPath: '/tmp/coordinator.sock',
      request: vi.fn(),
      subscribe: mockState.subscribe,
      health: vi.fn(),
      shutdown: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws BackendToolHttpError from streamWait and preserves the backend envelope body', async () => {
    const errorBody = {
      code: 'invalid_request',
      message: 'timeoutSeconds: Number must be less than or equal to 1200',
      detail: {
        issues: [{ code: 'too_big', path: ['timeoutSeconds'], message: 'Number must be less than or equal to 1200' }],
      },
    };
    mockState.subscribe.mockRejectedValueOnce(new Error('Subscription open failed for jobs.wait', { cause: errorBody }));

    const iterator = streamWait(['job-1'], 30, {
      host: '127.0.0.1',
      port: 4100,
      token: 'backend-token',
      socketPath: '/tmp/coordinator.sock',
    });

    let caught: unknown;
    try {
      await iterator.next();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BackendToolHttpError);
    expect((caught as BackendToolHttpError).statusCode).toBe(400);
    expect((caught as BackendToolHttpError).message).toBe(errorBody.message);
    expect((caught as BackendToolHttpError).body).toEqual(errorBody);
  });

  it.each(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'])(
    'wraps fetch failures with cause.code=%s in BackendUnreachableError',
    (code) => {
      const original = new TypeError('fetch failed', { cause: { code } });

      let caught: unknown;
      try {
        throwBackendCommunicationError(original);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(BackendUnreachableError);
      expect((caught as BackendUnreachableError).message).toBe('fetch failed');
    },
  );
});
