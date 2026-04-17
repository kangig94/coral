import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackendToolHttpError } from '../http-client.js';
import { streamWait, throwBackendCommunicationError } from '../backend-helpers.js';
import { BackendUnreachableError } from '../../shared/utils.js';

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('client backend helpers', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
    fetchMock.mockResolvedValueOnce(jsonResponse(errorBody, 400, 'Bad Request'));

    const iterator = streamWait(['job-1'], 30, {
      host: '127.0.0.1',
      port: 4100,
      token: 'backend-token',
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
