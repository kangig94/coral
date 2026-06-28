import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HTTP_BODY_READ_TIMEOUT_MS,
  HTTP_MAX_CONCURRENT_BODY_READS,
  readJsonBody,
} from '#src/transport/http/handler.js';

function requestStream(): IncomingMessage & PassThrough {
  return new PassThrough() as IncomingMessage & PassThrough;
}

describe('HTTP body reader', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects bodies above the configured byte limit', async () => {
    const req = requestStream();
    const promise = readJsonBody(req, { maxBytes: 4 });
    const rejection = expect(promise).rejects.toMatchObject({
      statusCode: 413,
      body: { code: 'request_body_too_large' },
      closeConnection: true,
    });

    req.write('{"too');

    await rejection;
    expect(req.destroyed).toBe(false);
  });

  it('times out slow request bodies', async () => {
    vi.useFakeTimers();
    const req = requestStream();
    const promise = readJsonBody(req, { timeoutMs: 10 });
    const rejection = expect(promise).rejects.toMatchObject({
      statusCode: 408,
      body: { code: 'request_body_timeout' },
      closeConnection: true,
    });

    await vi.advanceTimersByTimeAsync(10);

    await rejection;
    expect(req.destroyed).toBe(false);
  });

  it('caps concurrent body readers', async () => {
    const held = Array.from({ length: HTTP_MAX_CONCURRENT_BODY_READS }, () => requestStream());
    const pending = held.map((req) => readJsonBody(req, { timeoutMs: HTTP_BODY_READ_TIMEOUT_MS }));
    const overflow = requestStream();

    await expect(readJsonBody(overflow)).rejects.toMatchObject({
      statusCode: 503,
      body: { code: 'too_many_request_bodies' },
      closeConnection: true,
    });
    expect(overflow.destroyed).toBe(false);

    held.forEach((req) => {
      req.end('{}');
    });
    await expect(Promise.all(pending)).resolves.toEqual(
      Array.from({ length: HTTP_MAX_CONCURRENT_BODY_READS }, () => ({})),
    );
  });
});
