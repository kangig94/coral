import { describe, expect, it } from 'vitest';

import { mapWaitSubscriptionError } from '#src/cli/wait-stream-error.js';
import { BackendToolHttpError } from '#src/transport/http/errors.js';
import { TransientHttpError } from '#src/infra/http-errors.js';

function subscriptionError(code: string, detail?: unknown): Error {
  return new Error('wire message', { cause: { code, message: 'wire message', detail } });
}

describe('mapWaitSubscriptionError', () => {
  it('should map jobs_not_found to a 404 BackendToolHttpError preserving the body', () => {
    const mapped = mapWaitSubscriptionError(subscriptionError('jobs_not_found', { jobs: ['a'] }));

    expect(mapped).toBeInstanceOf(BackendToolHttpError);
    const error = mapped as BackendToolHttpError;
    expect(error.statusCode).toBe(404);
    expect(error.message).toBe('wire message');
    expect(error.body).toEqual({ code: 'jobs_not_found', message: 'wire message', detail: { jobs: ['a'] } });
  });

  it('should map scope_mismatch to 403', () => {
    const mapped = mapWaitSubscriptionError(subscriptionError('scope_mismatch'));
    expect((mapped as BackendToolHttpError).statusCode).toBe(403);
  });

  it('should map an unknown code to the 400 default', () => {
    const mapped = mapWaitSubscriptionError(subscriptionError('invalid_request'));
    expect((mapped as BackendToolHttpError).statusCode).toBe(400);
  });

  it('should promote backend_recovering to a transient 503', () => {
    const mapped = mapWaitSubscriptionError(subscriptionError('backend_recovering'));
    expect(mapped).toBeInstanceOf(TransientHttpError);
    expect((mapped as TransientHttpError).status).toBe(503);
  });

  it('should promote backend_shutting_down to a transient 503', () => {
    const mapped = mapWaitSubscriptionError(subscriptionError('backend_shutting_down'));
    expect(mapped).toBeInstanceOf(TransientHttpError);
    expect((mapped as TransientHttpError).status).toBe(503);
  });

  it('should pass through an Error without a structured cause unchanged', () => {
    const raw = new Error('boom');
    expect(mapWaitSubscriptionError(raw)).toBe(raw);
  });

  it('should pass through a BackendToolHttpError (cause-less) unchanged', () => {
    const cursorError = new BackendToolHttpError('Invalid Last-Event-ID cursor', 400, {
      code: 'invalid_request',
      message: 'Invalid Last-Event-ID cursor',
    });
    expect(mapWaitSubscriptionError(cursorError)).toBe(cursorError);
  });

  it('should pass through non-Error values unchanged', () => {
    expect(mapWaitSubscriptionError('plain string')).toBe('plain string');
  });
});
